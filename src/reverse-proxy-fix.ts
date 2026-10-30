import {
  getLoginPage,
  getSessionPolicy,
  inspectSession,
  issueSession,
  renewSession,
  validateLogin,
  validateSession
} from './auth.js'
import type { SessionInfo, SessionPolicy } from './auth.js'
import {
  LANGUAGE_COOKIE,
  configuredLocale,
  loginMessages,
  parseLocale,
  resolveLocale
} from './login-i18n.js'
import type { Locale } from './login-i18n.js'
import {
  MIN_PASSWORD_LENGTH,
  changePassword,
  ensureCredentials,
  getUsername
} from './credentials.js'
import { loginRateLimiter } from './rate-limit.js'

export const name = 'reverse-proxy-fix'
export const inject = ['webServer', 'connection', 'webStartup']

// Relative redirect targets. They are relative on purpose so the same
// handlers work at the root and behind a prefix-stripping proxy:
// - after login, `../` goes from /_auth/login to / (or /ui/_auth/login to /ui/)
// - after logout, `login` goes from /_auth/logout to /_auth/login (sibling)
// - the index redirect goes from / to /_auth/login (or /ui/ to /ui/_auth/login)
export const LOGIN_SUCCESS_LOCATION = '../'
export const LOGOUT_LOCATION = 'login'
export const INDEX_LOGIN_LOCATION = './_auth/login'

// Cookie attributes shared by every dsh_session cookie we issue or clear.
const SESSION_COOKIE = 'dsh_session'
const MAX_LOGIN_BODY_BYTES = 64 * 1024
/** Maximum accepted body on the password-change endpoint. */
const MAX_PASSWORD_BODY_BYTES = 16 * 1024

// Renewal endpoint used by the browser heartbeat. The route is registered
// beside /_auth/login, so it is reachable without a session (it validates the
// cookie itself) and works the same at the root and behind a prefix proxy.
const RENEW_PATH = '/_auth/renew'
/** Password change for the signed-in administrator. */
export const PASSWORD_PATH = '/_auth/password'
// A custom request header is the CSRF guard: a cross-site form, image, or
// link cannot set it, and same-origin fetch does not need a preflight for it.
const RENEW_HEADER = 'x-dsh-renew'

interface ConnectionLike {
  admit?: (req: any) => { peer?: unknown; rejection?: number }
  browserPeer?: unknown
  isTrusted?: (req: any) => boolean
  authorizeIndex: (req: any, res: any) => boolean
  requestRejection: (req: any) => number | undefined
}

interface AuthOptions {
  validateSession?: (cookieHeader: string | undefined) => boolean
  inspectSession?: (cookieHeader: string | undefined) => SessionInfo | undefined
  /** Plugin context; without it the index-load renewal is skipped. */
  ctx?: any
}

/**
 * Whether the plugin session is the *only* accepted credential.
 *
 * Off by default: the printed launch-token URL keeps working as an alternate
 * entry, which is what a single-user install expects. With it on,
 * `?token=` bootstrap and the native 30-day browser cookie are both refused,
 * leaving the revocable plugin session as the sole way in. Documented as
 * `DSH_AUTH_REQUIRE_SESSION`.
 */
export function requirePluginSession(): boolean {
  const raw = process.env.DSH_AUTH_REQUIRE_SESSION
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Whether third-party webserver routes should be put behind the plugin
 * session too.
 *
 * Opt-in (`DSH_AUTH_PROTECT_ROUTES=1`): wrapping `webServer.register` reaches
 * into the harness's private route tables, which is exactly the kind of
 * coupling this plugin otherwise avoids. Off by default, with a startup
 * diagnostic that names the routes left outside the gate.
 */
export function protectOtherRoutes(): boolean {
  const raw = process.env.DSH_AUTH_PROTECT_ROUTES
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Whether the request reached this process over TLS, directly or through an
 * advertised HTTPS proxy. Only the listener's own protocol and the configured
 * public URL decide; forwarded headers are client-controlled.
 */
function isSecureRequest(ctx: any, _req: any): boolean {
  const startup = ctx.get('webStartup')
  if (startup?.tls !== undefined) return true
  if (typeof startup?.publicUrl === 'string' && startup.publicUrl.startsWith('https:')) return true
  try {
    return ctx.webServer.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Build one Set-Cookie value.
 */
function sessionCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

/** Seconds until `expiresAt`, for the cookie's Max-Age. */
function cookieMaxAge(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/** Only the injected heartbeat may renew; require its header and a same-site fetch. */
function renewalAllowed(req: any): boolean {
  if (req.headers?.[RENEW_HEADER] !== '1') return false
  return sameSiteFetch(req)
}

/**
 * Whether this is a same-site (or non-browser) request.
 *
 * `Sec-Fetch-Site` is set by browsers and cannot be forged from a cross-site
 * page, so it is a reliable guard for state-changing GETs. A missing header
 * (curl, old browser) is treated as same-site: the alternative is breaking
 * non-browser clients for no security gain, since forged headers are checked
 * against the session cookie anyway.
 */
function sameSiteFetch(req: any): boolean {
  const site = req.headers?.['sec-fetch-site']
  if (typeof site !== 'string') return true
  return site === 'same-origin' || site === 'same-site' || site === 'none'
}

/**
 * Serve `/_auth/renew`: slide a still-valid session forward.
 *
 * Rotate-only design: an invalid or missing session is never given a cookie,
 * a session renewed within the step is answered `204` without a Set-Cookie,
 * and the absolute cap is enforced inside `renewSession`, so this endpoint
 * cannot extend a session past its lifetime.
 */
function handleRenewRoute(ctx: any, req: any, res: any): void {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Cache-Control': 'no-store', Allow: 'POST' })
    res.end()
    return
  }
  if (!renewalAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('forbidden')
    return
  }

  const info = inspectSession(req.headers.cookie)
  if (info === undefined) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('unauthorized')
    return
  }

  const renewed = renewSession(info)
  const headers: Record<string, string | string[]> = { 'Cache-Control': 'no-store' }
  if (renewed !== undefined) {
    headers['Set-Cookie'] = sessionCookie(
      SESSION_COOKIE,
      renewed.value,
      cookieMaxAge(renewed.expiresAt),
      isSecureRequest(ctx, req)
    )
  }
  res.writeHead(204, headers)
  res.end()
}

/**
 * Renew opportunistically on an index load, where a response object exists.
 * The header is set before the framework writes its own, so it survives;
 * a renewal that is throttled or capped simply leaves the cookie alone.
 */
function renewOnIndex(ctx: any, req: any, res: any, info: SessionInfo): void {
  if (ctx === undefined || typeof res?.setHeader !== 'function') return
  const renewed = renewSession(info)
  if (renewed === undefined) return
  try {
    res.setHeader(
      'Set-Cookie',
      sessionCookie(
        SESSION_COOKIE,
        renewed.value,
        cookieMaxAge(renewed.expiresAt),
        isSecureRequest(ctx, req)
      )
    )
  } catch {
    // Headers already sent: the browser keeps its current cookie, and the
    // heartbeat or the next index load renews instead.
  }
}

/**
 * Resolve the login-page locale for this request.
 *
 * `explicit` says whether `?lang=` picked it, which is the only case worth
 * persisting: an auto-detected locale must keep following the browser, and a
 * deployment default must stay overridable by the visitor.
 */
function requestLocale(req: any): { locale: Locale; explicit: boolean } {
  let lang: string | undefined
  try {
    lang = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('lang') ?? undefined
  } catch {
    lang = undefined
  }
  const locale = resolveLocale({
    lang,
    cookieHeader: req.headers.cookie,
    acceptLanguage: req.headers['accept-language']
  })
  return { locale, explicit: parseLocale(lang) !== undefined }
}

/** Remember an explicit language pick for a year. */
function languageCookie(locale: Locale, secure: boolean): string {
  return `${LANGUAGE_COOKIE}=${locale}; Path=/; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`
}

/**
 * Send the login page in the request's locale, remembering an explicit pick.
 * @param status HTTP status (429 for a throttled attempt).
 * @param error optional, already-localized error banner.
 */
function sendLoginPage(ctx: any, req: any, res: any, status = 200, error?: string): void {
  const { locale, explicit } = requestLocale(req)
  const headers: Record<string, string | string[]> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  }
  if (explicit) headers['Set-Cookie'] = languageCookie(locale, isSecureRequest(ctx, req))
  res.writeHead(status, headers)
  res.end(getLoginPage(locale, error))
}

/**
 * Read a bounded request body.
 * @returns the raw body, or `undefined` when the caller exceeded the cap.
 */
function readBody(req: any, res: any, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    const finish = (value: Buffer | undefined) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      total += chunk.length
      if (total > limit) {
        finish(undefined)
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('payload too large')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks)))
    req.on('error', () => finish(undefined))
  })
}

/** Send a JSON response, optionally with Set-Cookie headers. */
function sendJson(res: any, status: number, body: unknown, cookies?: string[]): void {
  const headers: Record<string, string | string[]> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }
  if (cookies !== undefined && cookies.length > 0) headers['Set-Cookie'] = cookies
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

/**
 * Serve `/_auth/login`. GET (and anything else) shows the page; POST validates
 * the body, mints a session cookie, and redirects to the relative root.
 *
 * Failed attempts feed {@link loginRateLimiter}: five misses from one address
 * lock it for 30 seconds, and a global wave slows every non-loopback caller
 * down exponentially. A successful attempt clears that address.
 */
function handleLoginRoute(ctx: any, req: any, res: any): void {
  if (req.method !== 'POST') {
    sendLoginPage(ctx, req, res)
    return
  }

  const verdict = loginRateLimiter.check(req)
  if (!verdict.allowed) {
    const { locale } = requestLocale(req)
    res.setHeader?.('Retry-After', String(verdict.retryAfterSeconds))
    res.setHeader?.('Cache-Control', 'no-store')
    sendLoginPage(
      ctx,
      req,
      res,
      429,
      loginMessages(locale).lockedOut(verdict.retryAfterSeconds)
    )
    return
  }

  void readBody(req, res, MAX_LOGIN_BODY_BYTES).then((body) => {
    if (body === undefined) return
    const params = new URLSearchParams(body.toString())
    const username = params.get('username') || ''
    const password = params.get('password') || ''

    const conn = ctx.get('connection') as ConnectionLike | undefined
    let trusted = true
    try {
      trusted = typeof conn?.isTrusted !== 'function' || conn.isTrusted(req)
    } catch {
      trusted = false
    }
    if (!trusted) {
      const { locale } = requestLocale(req)
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(
        getLoginPage(locale, loginMessages(locale).untrustedHost(req.headers.host ?? 'unknown'))
      )
      return
    }

    if (validateLogin(username, password)) {
      loginRateLimiter.recordSuccess(req)
      const session = issueSession()
      res.writeHead(302, {
        'Set-Cookie': sessionCookie(
          SESSION_COOKIE,
          session.value,
          cookieMaxAge(session.expiresAt),
          isSecureRequest(ctx, req)
        ),
        'Cache-Control': 'no-store',
        // From /_auth/login (or /ui/_auth/login) `../` resolves to `/`
        // (or `/ui/`); `./` would resolve to the /_auth/ directory.
        'Location': LOGIN_SUCCESS_LOCATION
      })
      res.end()
    } else {
      loginRateLimiter.recordFailure(req)
      const { locale } = requestLocale(req)
      sendLoginPage(ctx, req, res, 200, loginMessages(locale).wrongCredentials)
    }
  })
}

/**
 * Serve `/_auth/password`: change the signed-in administrator's password.
 *
 * Only POST, only JSON, only with a live session. A successful change rotates
 * the session secret server-side, so every other browser is signed out at
 * once; the caller gets a fresh cookie so it stays signed in.
 */
function handlePasswordRoute(ctx: any, req: any, res: any): void {
  const { locale } = requestLocale(req)
  const messages = loginMessages(locale)
  if (req.method === 'GET') {
    // The settings panel reads identity, the deployment locale, and its copy
    // from here, so the panel needs no duplicated translations.
    if (!validateSession(req.headers.cookie)) {
      sendJson(res, 401, { ok: false, code: 'session-required', error: messages.sessionRequired })
      return
    }
    sendJson(res, 200, {
      ok: true,
      username: getUsername(),
      locale,
      messages: messages.panel
    })
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Cache-Control': 'no-store', Allow: 'POST' })
    res.end()
    return
  }
  if (!validateSession(req.headers.cookie)) {
    sendJson(res, 401, { ok: false, code: 'session-required', error: messages.sessionRequired })
    return
  }
  // Same-site JSON only: a cross-site form cannot send this content type, so
  // the endpoint needs no separate CSRF token.
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().includes('application/json')) {
    sendJson(res, 415, { ok: false, code: 'json-required', error: messages.requestRejected })
    return
  }
  if (!sameSiteFetch(req)) {
    sendJson(res, 403, { ok: false, code: 'cross-site', error: messages.requestRejected })
    return
  }

  const verdict = loginRateLimiter.check(req)
  if (!verdict.allowed) {
    res.setHeader?.('Retry-After', String(verdict.retryAfterSeconds))
    sendJson(res, 429, {
      ok: false,
      code: 'rate-limited',
      retryAfter: verdict.retryAfterSeconds,
      error: messages.lockedOut(verdict.retryAfterSeconds)
    })
    return
  }

  void readBody(req, res, MAX_PASSWORD_BODY_BYTES).then((body) => {
    if (body === undefined) return
    let payload: { oldPassword?: unknown; newPassword?: unknown }
    try {
      payload = JSON.parse(body.toString()) as { oldPassword?: unknown; newPassword?: unknown }
    } catch {
      sendJson(res, 400, { ok: false, code: 'invalid-json', error: messages.requestRejected })
      return
    }
    const oldPassword = typeof payload.oldPassword === 'string' ? payload.oldPassword : ''
    const newPassword = typeof payload.newPassword === 'string' ? payload.newPassword : ''
    if (oldPassword === '' || newPassword === '') {
      sendJson(res, 400, { ok: false, code: 'missing-field', error: messages.passwordRequired })
      return
    }
    if (newPassword.trim().length < MIN_PASSWORD_LENGTH) {
      sendJson(res, 400, {
        ok: false,
        code: 'too-short',
        error: messages.passwordTooShort(MIN_PASSWORD_LENGTH)
      })
      return
    }

    const result = changePassword(oldPassword, newPassword)
    if (!result.ok) {
      if (result.reason === 'wrong-password') loginRateLimiter.recordFailure(req)
      sendJson(res, 401, {
        ok: false,
        code: result.reason,
        error: result.reason === 'too-short'
          ? messages.passwordTooShort(MIN_PASSWORD_LENGTH)
          : messages.wrongPassword
      })
      return
    }
    loginRateLimiter.recordSuccess(req)
    // The store rotated its secret, so the caller's old cookie is dead too:
    // hand it a fresh one and keep it signed in.
    const session = issueSession()
    sendJson(
      res,
      200,
      { ok: true, username: result.username },
      [
        sessionCookie(
          SESSION_COOKIE,
          session.value,
          cookieMaxAge(session.expiresAt),
          isSecureRequest(ctx, req)
        )
      ]
    )
  })
}

/**
 * Clear the plugin session and any upstream native browser-auth cookies the
 * request carries, so "logout" cannot leave a 30-day dsh cookie behind.
 *
 * POST is the documented method. GET still works when the request is same-site
 * (an old bookmark, or a link rendered by the SPA), but a cross-site GET — the
 * only way another page could force a logout — is refused.
 */
function handleLogoutRoute(ctx: any, req: any, res: any): void {
  if (req.method !== 'POST' && !(req.method === 'GET' && sameSiteFetch(req))) {
    res.writeHead(405, { 'Cache-Control': 'no-store', Allow: 'POST' })
    res.end()
    return
  }
  const secure = isSecureRequest(ctx, req)
  const cookies = [sessionCookie(SESSION_COOKIE, '', 0, secure)]
  const header = req.headers.cookie as string | undefined
  if (header) {
    const seen = new Set([SESSION_COOKIE])
    for (const segment of header.split(';')) {
      const at = segment.indexOf('=')
      if (at === -1) continue
      const name = segment.slice(0, at).trim()
      if (!name.startsWith('dsh-auth-') || seen.has(name)) continue
      seen.add(name)
      cookies.push(sessionCookie(name, '', 0, secure))
    }
  }
  // From /_auth/logout (or /ui/_auth/logout) `login` resolves to the
  // sibling /_auth/login (or /ui/_auth/login); `./_auth/login` would
  // duplicate the /_auth/ segment.
  res.writeHead(302, {
    'Set-Cookie': cookies,
    'Cache-Control': 'no-store',
    'Location': LOGOUT_LOCATION
  })
  res.end()
}

/**
 * Layer the plugin session onto the connection auth gate.
 *
 * dsh 0.2.1 routes `/api` and API WebSocket upgrades through
 * `connection.admit`, and index requests through `connection.authorizeIndex`.
 * A valid plugin session is admitted as the process owner peer; everything
 * else falls through to the native launch-token / signed-cookie gate.
 *
 * The Host/Origin fence still applies: an authenticated request whose Host is
 * not trusted is rejected exactly as before. On older versions without
 * `admit`, the legacy `requestRejection` gate is patched instead.
 *
 * With `DSH_AUTH_REQUIRE_SESSION` on, the fall-through disappears: no native
 * cookie or launch token is accepted, and the plugin session is the only way
 * through the gate.
 * @param conn the connection service instance.
 * @param options optional `validateSession` override (tests).
 * @returns the original bound auth methods, for tests and diagnostics.
 */
export function installConnectionAuth(conn: ConnectionLike, options: AuthOptions = {}): {
  origAuthorizeIndex: (req: any, res: any) => boolean
  origRequestRejection: (req: any) => number | undefined
} {
  if (!conn || typeof conn.authorizeIndex !== 'function' || typeof conn.requestRejection !== 'function') {
    throw new Error('reverse-proxy-fix: ctx.connection auth gate not found; dsh version mismatch')
  }
  const validate = options.validateSession ?? validateSession
  const inspect = options.inspectSession ?? inspectSession
  const sessionOnly = requirePluginSession()
  const origAuthorizeIndex = conn.authorizeIndex.bind(conn)
  const origRequestRejection = conn.requestRejection.bind(conn)

  if (typeof conn.admit === 'function') {
    if (!conn.browserPeer) {
      throw new Error('reverse-proxy-fix: connection.browserPeer not found; dsh version mismatch')
    }
    const origAdmit = conn.admit.bind(conn)
    conn.admit = (req: any) => {
      let trusted = true
      try {
        trusted = typeof conn.isTrusted !== 'function' || conn.isTrusted(req)
      } catch {
        trusted = false
      }
      if (trusted && validate(req.headers.cookie)) return { peer: conn.browserPeer }
      if (sessionOnly) return { rejection: 401 }
      return origAdmit(req)
    }
  } else {
    // 0.1.x compatibility: `/api` was gated by requestRejection there.
    conn.requestRejection = (req: any) => {
      if (validate(req.headers.cookie)) return undefined
      if (sessionOnly) return 401
      return origRequestRejection(req)
    }
  }

  conn.authorizeIndex = (req: any, res: any) => {
    if (validate(req.headers.cookie)) {
      // A page load is the one place the gate has a response object, so it is
      // also a free renewal point for browsers that never run the heartbeat
      // (JS disabled, or an index rendered by another deployment).
      const info = inspect(req.headers.cookie)
      if (info !== undefined) renewOnIndex(options.ctx, req, res, info)
      return true
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://dsh.invalid')
    } catch {
      url = new URL('/', 'http://dsh.invalid')
    }
    if (sessionOnly) {
      res.writeHead(302, { 'Cache-Control': 'no-store', 'Location': INDEX_LOGIN_LOCATION })
      res.end()
      return false
    }
    if (url.searchParams.has('token')) return origAuthorizeIndex(req, res)
    if (origRequestRejection(req) === undefined) return true
    res.writeHead(302, { 'Cache-Control': 'no-store', 'Location': INDEX_LOGIN_LOCATION })
    res.end()
    return false
  }

  return { origAuthorizeIndex, origRequestRejection }
}

/**
 * Put later-registered webserver routes behind the plugin session.
 *
 * Opt-in, because it reaches into the harness's route tables. Two pieces:
 * routes registered after activation are wrapped on the way in, and routes
 * that already exist (another plugin may have won the activation race) are
 * wrapped in place. Only exact/prefix/upgrade routes are touched — the
 * fallback seat serves the SPA shell and its static assets, and the shell is
 * already gated by `authorizeIndex`.
 * @param ctx the plugin context (for `webServer`).
 * @param isPublicRoute paths that must stay reachable without a session.
 * @returns a cleanup function that restores the original registration methods.
 */
function guardOtherRoutes(ctx: any, isPublicRoute: (path: string) => boolean): () => void {
  const webserver = ctx.webServer
  const wrap = (route: any): any => {
    if (route === null || typeof route !== 'object') return route
    if (typeof route.path === 'string' && isPublicRoute(route.path)) return route
    if (typeof route.handler !== 'function') return route
    const handler = route.handler
    route.handler = function guarded(req: any, res: any) {
      if (validateSession(req.headers.cookie)) return handler(req, res)
      const isNavigation =
        (req.method === 'GET' || req.method === 'HEAD') &&
        String(req.headers.accept ?? '').includes('text/html')
      if (isNavigation) {
        res.writeHead(302, { 'Cache-Control': 'no-store', Location: '/_auth/login' })
        res.end()
        return undefined
      }
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return undefined
    }
    return route
  }

  const wrapUpgrade = (route: any): any => {
    if (route === null || typeof route !== 'object') return route
    if (typeof route.path === 'string' && isPublicRoute(route.path)) return route
    if (typeof route.handler !== 'function') return route
    const handler = route.handler
    route.handler = (req: any, socket: any, head: any) => {
      if (!validateSession(req.headers.cookie)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return undefined
      }
      return handler(req, socket, head)
    }
    return route
  }

  const tables = webserver as unknown as {
    exact?: Map<string, any>
    prefixes?: Map<string, any>
    upgrades?: Map<string, any>
  }
  for (const route of tables.exact?.values() ?? []) wrap(route)
  for (const route of tables.prefixes?.values() ?? []) wrap(route)
  for (const route of tables.upgrades?.values() ?? []) wrapUpgrade(route)

  const origRegister = webserver.register.bind(webserver)
  const origRegisterUpgrade = webserver.registerUpgrade?.bind(webserver)
  webserver.register = (route: any) => origRegister(wrap(route))
  if (origRegisterUpgrade !== undefined) {
    webserver.registerUpgrade = (route: any) => origRegisterUpgrade(wrapUpgrade(route))
  }
  return () => {
    webserver.register = origRegister
    if (origRegisterUpgrade !== undefined) webserver.registerUpgrade = origRegisterUpgrade
  }
}

/**
 * Report the routes the plugin session does not cover.
 *
 * dsh's own admission gate covers `/api`, upgrades and the index; a route
 * another plugin registers on the webserver directly is outside it. Listing
 * them at startup turns "only install plugins you trust" from a README
 * sentence into something an operator can actually check.
 * @param ctx the plugin context.
 * @param isPublicRoute paths the plugin itself owns.
 * @returns the uncovered paths (also logged).
 */
function reportUncoveredRoutes(ctx: any, isPublicRoute: (path: string) => boolean): string[] {
  const tables = (ctx.webServer ?? {}) as unknown as {
    exact?: Map<string, { path?: unknown }>
    prefixes?: Map<string, { path?: unknown }>
  }
  const uncovered: string[] = []
  for (const route of tables.exact?.values() ?? []) {
    if (typeof route.path === 'string' && !isPublicRoute(route.path)) uncovered.push(route.path)
  }
  for (const route of tables.prefixes?.values() ?? []) {
    if (typeof route.path === 'string' && !isPublicRoute(route.path)) uncovered.push(`${route.path}*`)
  }
  if (uncovered.length > 0) {
    console.warn(
      `[reverse-proxy-fix] ${uncovered.length} webserver route(s) are outside the plugin session gate: ${uncovered.join(', ')}`
    )
    console.warn(
      '[reverse-proxy-fix] set DSH_AUTH_PROTECT_ROUTES=1 to guard them, or only install plugins you trust'
    )
  }
  return uncovered
}

/**
 * Browser-side heartbeat: renews the session while the user is actually
 * working, so a long-lived SPA tab keeps the cookie sliding instead of
 * expiring mid-session.
 *
 * `new URL('_auth/renew', location.href)` mirrors the relative-URL strategy of
 * the login form: `/` resolves to `/_auth/renew`, `/ui/` to `/ui/_auth/renew`,
 * which a prefix-stripping proxy maps back to the route.
 */
function renewalScript(policy: SessionPolicy): string {
  // Never tighter than a minute: the server throttles anyway, and a tiny
  // interval would just add requests.
  const step = Math.max(60 * 1000, Math.round(policy.renew))
  return `;(function(){var step=${step};var lastInput=Date.now(),lastRenew=0;function mark(){lastInput=Date.now();}['pointerdown','keydown','touchstart'].forEach(function(t){addEventListener(t,mark,{passive:true,capture:true});});function renew(){if(document.visibilityState==='hidden')return;if(lastInput<=lastRenew)return;lastRenew=Date.now();try{fetch(new URL('_auth/renew',location.href),{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'x-dsh-renew':'1'}}).catch(function(){});}catch(e){}}setInterval(renew,step);})();`
}

/** Index injections shared by every deployment. */
function indexInjections(policy: SessionPolicy): Array<{ kind: string; placement: string; text: string }> {
  return [
    {
      kind: 'script',
      placement: 'head',
      // dsh computes connection.isLoopback from globalThis.__DSH_TRANSPORT__
      // (ownsHost) or the page hostname. ownsHost is an unused hook that dsh
      // never populates, so a public-IP deployment reads as non-loopback and
      // loses host-side settings persistence plus file-open. Set ownsHost so
      // authenticated public access behaves like loopback.
      text: `globalThis.__DSH_TRANSPORT__=Object.assign({},globalThis.__DSH_TRANSPORT__,{ownsHost:true});`
    },
    {
      kind: 'script',
      placement: 'head',
      // Web Crypto's randomUUID is absent on plain-HTTP origins. Several RPC
      // paths mint request ids with it, so every API call fails without this
      // shim. Prefer getRandomValues when present; keep a Math.random fallback
      // for the rare engine that has no Web Crypto at all.
      text: `;(function(){var c=typeof crypto!=='undefined'?crypto:undefined;if(!c){try{c=globalThis.crypto={};}catch(e){return;}}if(typeof c.randomUUID==='function')return;c.randomUUID=function(){var b;if(typeof c.getRandomValues==='function'){b=c.getRandomValues(new Uint8Array(16));}else{b=new Uint8Array(16);for(var i=0;i<16;i++)b[i]=Math.floor(Math.random()*256);}b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h='';for(var i=0;i<16;i++){if(i===4||i===6||i===8||i===10)h+='-';var x=b[i].toString(16);h+=x.length<2?'0'+x:x;}return h;};})();`
    },
    {
      kind: 'script',
      placement: 'body',
      // Sliding renewal: only fires while the tab is visible AND the user has
      // touched it since the previous tick, so an open-but-unattended tab
      // still idles out. The server decides whether a renewal is due.
      text: renewalScript(policy)
    }
  ]
}

/** Paths the plugin itself owns; they must stay reachable without a session. */
function pluginPath(path: string): boolean {
  return (
    path === '/_auth/login' ||
    path === '/_auth/logout' ||
    path === RENEW_PATH ||
    path === PASSWORD_PATH ||
    // Upstream's DeepSeek-account OAuth callback arrives as a cross-site
    // navigation and must not be swallowed by a login wall.
    path === '/oauth/callback'
  )
}

/** Print the one-time first-run password so the operator cannot miss it. */
function announceBootstrap(result: ReturnType<typeof ensureCredentials>): void {
  if (result.status === 'generated') {
    const bar = '='.repeat(72)
    console.log(`\n${bar}`)
    console.log('[reverse-proxy-fix] No DSH_AUTH_PASS configured: generated an administrator password.')
    console.log(`[reverse-proxy-fix]   username: ${result.username}`)
    console.log(`[reverse-proxy-fix]   password: ${result.generatedPassword}`)
    console.log(`[reverse-proxy-fix]   also saved in: ${result.initialPasswordFile}`)
    console.log('[reverse-proxy-fix] Change it under Settings -> Auth, or run:')
    console.log('[reverse-proxy-fix]   dsh --profile web auth-reset')
    console.log(`${bar}\n`)
    return
  }
  if (result.status === 'seeded') {
    console.warn(
      '[reverse-proxy-fix] Imported the administrator account from DSH_AUTH_USER/DSH_AUTH_PASS into the credential file.'
    )
    console.warn(
      '[reverse-proxy-fix] Remove those variables and rotate the password under Settings -> Auth (environment variables are readable by other local users).'
    )
    return
  }
  if (result.envIgnored) {
    console.warn(
      '[reverse-proxy-fix] DSH_AUTH_PASS is set but ignored: the stored credential file wins. Use Settings -> Auth or `dsh --profile web auth-reset` to change the password.'
    )
  }
}

export function apply(ctx: any): void {
  console.log('[reverse-proxy-fix] Adapting to dsh 0.2.1 browser auth...')

  const webServer = ctx.webServer
  // Resolve the sliding-renewal policy once so a malformed override fails at
  // startup instead of weakening the session silently per request.
  const policy = getSessionPolicy()
  // Same fail-fast treatment for a mistyped DSH_AUTH_LANG.
  configuredLocale()
  // First activation creates the credential file (random password when the
  // environment carries none) and normalizes its permissions.
  const bootstrap = ensureCredentials()
  announceBootstrap(bootstrap)

  // ── Public login / logout / renew routes (no session required) ───────────
  // Registered as ordinary webserver routes so they sit ahead of the SPA
  // fallback and never pass through the connection auth gate.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/_auth/login',
    handler: (req: any, res: any) => handleLoginRoute(ctx, req, res)
  }), 'reverse-proxy-fix: /_auth/login route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/_auth/logout',
    handler: (req: any, res: any) => handleLogoutRoute(ctx, req, res)
  }), 'reverse-proxy-fix: /_auth/logout route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RENEW_PATH,
    handler: (req: any, res: any) => handleRenewRoute(ctx, req, res)
  }), 'reverse-proxy-fix: /_auth/renew route')

  // Session-authenticated password change for the settings panel.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: PASSWORD_PATH,
    handler: (req: any, res: any) => handlePasswordRoute(ctx, req, res)
  }), 'reverse-proxy-fix: /_auth/password route')

  // ── Drive the connection auth gate with the plugin session ───────────────
  // dsh 0.2.1 admits API requests and upgrades through connection.admit, and
  // index requests through connection.authorizeIndex. We layer the plugin
  // session on top: a valid session is admitted as the owner browser peer,
  // and otherwise the native token / cookie flow runs unchanged.
  const conn = ctx.get('connection')
  installConnectionAuth(conn, { ctx })

  // ── Third-party routes: guarded only when asked, always reported ─────────
  if (protectOtherRoutes()) {
    ctx.effect(
      () => guardOtherRoutes(ctx, pluginPath),
      'reverse-proxy-fix: guard third-party routes'
    )
  } else {
    // Other plugins activate around us, so report on the next tick.
    setImmediate(() => {
      try {
        reportUncoveredRoutes(ctx, pluginPath)
      } catch {
        // Diagnostics must never take the web server down.
      }
    })
  }

  // ── Browser-side polyfills + renewal heartbeat, injected into the index ──
  ctx.on('webserver/index-inject', (table: any[]) => {
    table.push(...indexInjections(policy))
  })

  const hours = Number((policy.idle / 3600000).toFixed(2))
  const days = policy.absolute === 0 ? 'unlimited' : `${Number((policy.absolute / 86400000).toFixed(2))}d`
  const renewMinutes = Number((policy.renew / 60000).toFixed(2))
  console.log(
    `[reverse-proxy-fix] Plugin session auth + polyfills installed (user ${getUsername()}, idle ${hours}h, max ${days}, renew ${renewMinutes}m, session-only ${requirePluginSession() ? 'on' : 'off'})`
  )
}
