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

// Renewal endpoint used by the browser heartbeat. The route is registered
// beside /_auth/login, so it is reachable without a session (it validates the
// cookie itself) and works the same at the root and behind a prefix proxy.
const RENEW_PATH = '/_auth/renew'
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
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return false
  }
  return true
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
 */
function sendLoginPage(ctx: any, req: any, res: any, error?: string): void {
  const { locale, explicit } = requestLocale(req)
  const headers: Record<string, string | string[]> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  }
  if (explicit) headers['Set-Cookie'] = languageCookie(locale, isSecureRequest(ctx, req))
  res.writeHead(200, headers)
  res.end(getLoginPage(locale, error))
}

/**
 * Serve `/_auth/login`. GET (and anything else) shows the page; POST validates
 * the body, mints a session cookie, and redirects to the relative root.
 */
function handleLoginRoute(ctx: any, req: any, res: any): void {
  if (req.method !== 'POST') {
    sendLoginPage(ctx, req, res)
    return
  }

  const chunks: Buffer[] = []
  let total = 0
  let aborted = false
  req.on('data', (chunk: Buffer) => {
    if (aborted) return
    total += chunk.length
    if (total > MAX_LOGIN_BODY_BYTES) {
      aborted = true
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('payload too large')
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (aborted) return
    const params = new URLSearchParams(Buffer.concat(chunks).toString())
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
      const { locale } = requestLocale(req)
      sendLoginPage(ctx, req, res, loginMessages(locale).wrongCredentials)
    }
  })
}

/**
 * Clear the plugin session and any upstream native browser-auth cookies the
 * request carries, so "logout" cannot leave a 30-day dsh cookie behind.
 */
function handleLogoutRoute(ctx: any, req: any, res: any): void {
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
      return origAdmit(req)
    }
  } else {
    // 0.1.x compatibility: `/api` was gated by requestRejection there.
    conn.requestRejection = (req: any) => {
      if (validate(req.headers.cookie)) return undefined
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
    if (url.searchParams.has('token')) return origAuthorizeIndex(req, res)
    if (origRequestRejection(req) === undefined) return true
    res.writeHead(302, { 'Cache-Control': 'no-store', 'Location': INDEX_LOGIN_LOCATION })
    res.end()
    return false
  }

  return { origAuthorizeIndex, origRequestRejection }
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

export function apply(ctx: any): void {
  console.log('[reverse-proxy-fix] Adapting to dsh 0.2.1 browser auth...')

  const webServer = ctx.webServer
  // Resolve the sliding-renewal policy once so a malformed override fails at
  // startup instead of weakening the session silently per request.
  const policy = getSessionPolicy()
  // Same fail-fast treatment for a mistyped DSH_AUTH_LANG.
  configuredLocale()

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

  // ── Drive the connection auth gate with the plugin session ───────────────
  // dsh 0.2.1 admits API requests and upgrades through connection.admit, and
  // index requests through connection.authorizeIndex. We layer the plugin
  // session on top: a valid session is admitted as the owner browser peer,
  // and otherwise the native token / cookie flow runs unchanged.
  const conn = ctx.get('connection')
  installConnectionAuth(conn, { ctx })

  // ── Browser-side polyfills + renewal heartbeat, injected into the index ──
  ctx.on('webserver/index-inject', (table: any[]) => {
    table.push(...indexInjections(policy))
  })

  const hours = Number((policy.idle / 3600000).toFixed(2))
  const days = policy.absolute === 0 ? 'unlimited' : `${Number((policy.absolute / 86400000).toFixed(2))}d`
  const renewMinutes = Number((policy.renew / 60000).toFixed(2))
  console.log(
    `[reverse-proxy-fix] Plugin session auth + polyfills installed (idle ${hours}h, max ${days}, renew ${renewMinutes}m)`
  )
}
