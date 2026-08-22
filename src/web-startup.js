import { Command } from 'commander'

export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const WEB_STARTUP_SERVICE = 'webStartup'

function configureOutput(program) {
  program.exitOverride().configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text)
  })
  for (const child of program.commands) configureOutput(child)
}

function isCommanderError(error) {
  if (typeof error !== 'object' || error === null) return false
  return typeof error.code === 'string' && error.code.startsWith('commander.') && typeof error.exitCode === 'number'
}

function rewriteApiRequestHeaders(req) {
  const originalHost = req.headers.host
  const originalOrigin = req.headers.origin
  req.headers.host = '127.0.0.1:3080'
  req.headers.origin = 'http://127.0.0.1:3080'
  return () => {
    req.headers.host = originalHost
    if (originalOrigin === undefined) delete req.headers.origin
    else req.headers.origin = originalOrigin
  }
}

function installBrowserPolyfills(ctx) {
  const server = ctx.webServer?.server
  if (server) {
    const marker = Symbol.for('dsh-public-access:api-rewrite')
    if (!(server[marker])) {
      server[marker] = true
      server.prependListener('request', (req) => {
        if (req.url?.startsWith('/api/')) {
          rewriteApiRequestHeaders(req)
        }
      })
    }
  }

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

function webCommand() {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
`)
}

export function apply(ctx) {
  const program = webCommand()
  configureOutput(program)
  program.action(() => {
    const options = program.opts()
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: Number(options.port) } : {}),
      trustedHosts: options.trustedHost ?? []
    })
  })
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) throw new Error('dsh-public-access: missing cmdlineArgs/appExit services')
  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
  }

  ctx.inject(['webServer'], installBrowserPolyfills)
}
