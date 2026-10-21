import { validateSession, createSession, validateLogin, getLoginPage, escapeHtml } from './auth.js'

export const name = 'reverse-proxy-fix'
export const inject = ['webServer', 'connection', 'webStartup']

// Cookie attributes shared by every dsh_session cookie we issue or clear.
const SESSION_COOKIE = 'dsh_session'
const SESSION_MAX_AGE = 24 * 60 * 60 // 24 hours, in seconds
const MAX_LOGIN_BODY_BYTES = 64 * 1024

/**
 * Whether the request reached this process over TLS, directly or through an
 * advertised HTTPS proxy. Only the listener's own protocol and the configured
 * public URL decide; forwarded headers are client-controlled.
 * @param ctx plugin context carrying webServer/webStartup.
 * @param _req incoming request (reserved for future checks).
 * @returns true when the browser-facing origin is HTTPS.
 */
function isSecureRequest(ctx, _req) {
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
 * @param name cookie name.
 * @param value cookie value.
 * @param maxAge lifetime in seconds; 0 clears it.
 * @param secure whether to include the Secure attribute.
 * @returns the Set-Cookie header value.
 */
function sessionCookie(name, value, maxAge, secure) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

/**
 * Send the login page.
 * @param res response owning the body.
 * @param error optional message shown above the form.
 */
function sendLoginPage(res, error) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(getLoginPage(error))
}

/**
 * Serve `/_auth/login`. GET (and anything else) shows the page; POST validates
 * the body, mints a session cookie, and redirects to the relative root.
 */
function handleLoginRoute(ctx, req, res) {
  if (req.method !== 'POST') {
    sendLoginPage(res)
    return
  }

  const chunks = []
  let total = 0
  let aborted = false
  req.on('data', (chunk) => {
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

    const conn = ctx.get('connection')
    let trusted = true
    try {
      trusted = typeof conn?.isTrusted !== 'function' || conn.isTrusted(req)
    } catch {
      trusted = false
    }
    if (!trusted) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(
        getLoginPage(
          `当前 Host（${escapeHtml(req.headers.host ?? 'unknown')}）未被信任，请为该地址添加 --trusted-host 后重试`
        )
      )
      return
    }

    if (validateLogin(username, password)) {
      const sessionId = createSession()
      res.writeHead(302, {
        'Set-Cookie': sessionCookie(
          SESSION_COOKIE,
          sessionId,
          SESSION_MAX_AGE,
          isSecureRequest(ctx, req)
        ),
        'Cache-Control': 'no-store',
        'Location': './'
      })
      res.end()
    } else {
      sendLoginPage(res, '用户名或密码错误')
    }
  })
}

/**
 * Clear the plugin session and any upstream native browser-auth cookies the
 * request carries, so "logout" cannot leave a 30-day dsh cookie behind.
 */
function handleLogoutRoute(ctx, req, res) {
  const secure = isSecureRequest(ctx, req)
  const cookies = [sessionCookie(SESSION_COOKIE, '', 0, secure)]
  const header = req.headers.cookie
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
  res.writeHead(302, { 'Set-Cookie': cookies, 'Cache-Control': 'no-store', 'Location': './_auth/login' })
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
export function installConnectionAuth(conn, options = {}) {
  if (!conn || typeof conn.authorizeIndex !== 'function' || typeof conn.requestRejection !== 'function') {
    throw new Error('reverse-proxy-fix: ctx.connection auth gate not found; dsh version mismatch')
  }
  const validate = options.validateSession ?? validateSession
  const origAuthorizeIndex = conn.authorizeIndex.bind(conn)
  const origRequestRejection = conn.requestRejection.bind(conn)

  if (typeof conn.admit === 'function') {
    if (!conn.browserPeer) {
      throw new Error('reverse-proxy-fix: connection.browserPeer not found; dsh version mismatch')
    }
    const origAdmit = conn.admit.bind(conn)
    conn.admit = (req) => {
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
    conn.requestRejection = (req) => {
      if (validate(req.headers.cookie)) return undefined
      return origRequestRejection(req)
    }
  }

  conn.authorizeIndex = (req, res) => {
    if (validate(req.headers.cookie)) return true
    let url
    try {
      url = new URL(req.url ?? '/', 'http://dsh.invalid')
    } catch {
      url = new URL('/', 'http://dsh.invalid')
    }
    if (url.searchParams.has('token')) return origAuthorizeIndex(req, res)
    if (origRequestRejection(req) === undefined) return true
    res.writeHead(302, { 'Cache-Control': 'no-store', 'Location': './_auth/login' })
    res.end()
    return false
  }

  return { origAuthorizeIndex, origRequestRejection }
}

/** Index injections shared by every deployment. */
function indexInjections() {
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
    }
  ]
}

export function apply(ctx) {
  console.log('[reverse-proxy-fix] Adapting to dsh 0.2.1 browser auth...')

  const webServer = ctx.webServer

  // ── Public login / logout routes (no session required) ───────────────────
  // Registered as ordinary webserver routes so they sit ahead of the SPA
  // fallback and never pass through the connection auth gate.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/_auth/login',
    handler: (req, res) => handleLoginRoute(ctx, req, res)
  }), 'reverse-proxy-fix: /_auth/login route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/_auth/logout',
    handler: (req, res) => handleLogoutRoute(ctx, req, res)
  }), 'reverse-proxy-fix: /_auth/logout route')

  // ── Drive the connection auth gate with the plugin session ───────────────
  // dsh 0.2.1 admits API requests and upgrades through connection.admit, and
  // index requests through connection.authorizeIndex. We layer the plugin
  // session on top: a valid session is admitted as the owner browser peer,
  // and otherwise the native token / cookie flow runs unchanged.
  const conn = ctx.get('connection')
  installConnectionAuth(conn)

  // ── Browser-side polyfills, injected into the index ───────────────────────
  ctx.on('webserver/index-inject', (table) => {
    table.push(...indexInjections())
  })

  console.log('[reverse-proxy-fix] Plugin session auth + polyfills installed')
}
