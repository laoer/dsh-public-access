import type { Context } from '@deepseek-ai/cordis'

export const name = 'reverse-proxy-fix'
export const inject = ['webServer', 'connection']

export function apply(ctx: Context) {
  console.log('[reverse-proxy-fix] Enabling reverse proxy support...')

  // === HTTP-level interception ===
  // Spoof Host header to localhost for all /api requests.
  // Bypasses server-side: isTrustedApiRequest loopback-only check for privileged methods.
  const server = (ctx.webServer as any).server
  if (server) {
    const origListeners = server.listeners('request').slice()
    server.removeAllListeners('request')

    server.on('request', (req: any, res: any) => {
      if (req.url?.startsWith('/api/')) {
        const fakeHeaders = new Proxy(req.headers, {
          get(target: any, prop: string) {
            if (prop === 'host') return '127.0.0.1:3080'
            return target[prop]
          }
        })
        const fakeReq = new Proxy(req, {
          get(target: any, prop: string) {
            if (prop === 'headers') return fakeHeaders
            return target[prop]
          }
        })
        for (const listener of origListeners) {
          listener.call(server, fakeReq, res)
        }
      } else {
        for (const listener of origListeners) {
          listener.call(server, req, res)
        }
      }
    })
    console.log('[reverse-proxy-fix] HTTP interceptor installed')
  }

  // === Frontend isLoopback patch ===
  // Inject script that patches connection.isLoopback to true after Cordis initializes.
  // This enables settings document editing and other loopback-only features.
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script',
      placement: 'head',
      text: `
        // Wait for Cordis context to be available, then patch isLoopback
        var _patchInterval = setInterval(function() {
          try {
            // Try to access the Cordis context through globalThis
            var ctx = globalThis.__DSH_CONTEXT__ || globalThis.__cordis_context__;
            if (ctx && ctx.get) {
              var conn = ctx.get('connection');
              if (conn && !conn.isLoopback) {
                Object.defineProperty(conn, 'isLoopback', {
                  get: function() { return true; },
                  configurable: true
                });
                console.log('[reverse-proxy-fix] Patched frontend connection.isLoopback = true');
                clearInterval(_patchInterval);
              }
            }
          } catch(e) {}
        }, 100);
        // Stop trying after 10 seconds
        setTimeout(function() { clearInterval(_patchInterval); }, 10000);
      `
    })
  })

  // === crypto.randomUUID polyfill ===
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
          if (typeof crypto === 'undefined') {
            window.crypto = cryptoShim;
          } else {
            if (typeof crypto.randomUUID !== 'function') crypto.randomUUID = cryptoShim.randomUUID;
            if (typeof crypto.getRandomValues !== 'function') crypto.getRandomValues = cryptoShim.getRandomValues;
          }
        }
      `
    })
  })
}
