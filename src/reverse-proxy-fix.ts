import type { Context } from '@deepseek-ai/cordis'
import { validateSession, createSession, validateLogin, getLoginPage } from './auth.js'

export const name = 'reverse-proxy-fix'
export const inject = ['webServer', 'connection']

function rewriteApiRequestHeaders(req: any) {
  req.headers.host = '127.0.0.1:3080'
  req.headers.origin = 'http://127.0.0.1:3080'
  req.headers.referer = 'http://127.0.0.1:3080/'
}

export function apply(ctx: Context) {
  console.log('[reverse-proxy-fix] Enabling reverse proxy support...')

  const server = (ctx.webServer as any).server
  if (server) {
    const origListeners = server.listeners('request').slice()
    server.removeAllListeners('request')

    server.on('request', (req: any, res: any) => {
      const url = req.url || ''

      // === Auth: login page and endpoint (no auth required) ===
      if (url === '/_auth/login') {
        if (req.method === 'POST') {
          // Parse form body
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString()
            const params = new URLSearchParams(body)
            const username = params.get('username') || ''
            const password = params.get('password') || ''

            if (validateLogin(username, password)) {
              const sessionId = createSession()
              res.writeHead(302, {
                'Set-Cookie': `dsh_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
                'Location': '/'
              })
              res.end()
            } else {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end(getLoginPage('用户名或密码错误'))
            }
          })
          return
        }
        // GET - show login page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getLoginPage())
        return
      }

      if (url === '/_auth/logout') {
        res.writeHead(302, {
          'Set-Cookie': 'dsh_session=; Path=/; HttpOnly; Max-Age=0',
          'Location': '/_auth/login'
        })
        res.end()
        return
      }

      // === Auth: check session for all other requests ===
      if (!validateSession(req.headers.cookie)) {
        res.writeHead(302, { 'Location': '/_auth/login' })
        res.end()
        return
      }

      // === API requests: spoof Host header to localhost ===
      if (url.startsWith('/api/')) {
        rewriteApiRequestHeaders(req)
        for (const listener of origListeners) {
          listener.call(server, req, res)
        }
      } else {
        for (const listener of origListeners) {
          listener.call(server, req, res)
        }
      }
    })
    console.log('[reverse-proxy-fix] HTTP interceptor + auth installed')
  }

  // Patch connection.isLoopback for frontend settings access
  const conn = ctx.get('connection') as any
  if (conn) {
    Object.defineProperty(conn, 'isLoopback', {
      get: () => true,
      configurable: true
    })
  }

  // Frontend isLoopback patch
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script',
      placement: 'head',
      text: `
        var _patchInterval = setInterval(function() {
          try {
            var ctx = globalThis.__DSH_CONTEXT__ || globalThis.__cordis_context__;
            if (ctx && ctx.get) {
              var conn = ctx.get('connection');
              if (conn && !conn.isLoopback) {
                Object.defineProperty(conn, 'isLoopback', {
                  get: function() { return true; },
                  configurable: true
                });
                clearInterval(_patchInterval);
              }
            }
          } catch(e) {}
        }, 100);
        setTimeout(function() { clearInterval(_patchInterval); }, 10000);
      `
    })
  })

  // crypto polyfill
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script',
      placement: 'head',
      text: `
        if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
          var cryptoShim = {
            randomUUID: function() {
              return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                var r = Math.random() * 16 | 0;
                var v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
              });
            },
            getRandomValues: function(arr) {
              for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
              return arr;
            }
          };
          if (typeof crypto === 'undefined') window.crypto = cryptoShim;
          else {
            if (typeof crypto.randomUUID !== 'function') crypto.randomUUID = cryptoShim.randomUUID;
            if (typeof crypto.getRandomValues !== 'function') crypto.getRandomValues = cryptoShim.getRandomValues;
          }
        }
      `
    })
  })
}
