import { Command } from 'commander'
import { parsePublicUrl } from './public-url.js'
import {
  ensureWildcardBindSupport,
  lanHosts,
  normalizeBindHost,
  supportsTlsConfig
} from './webserver-schema.js'

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

function webCommand() {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind address: 127.0.0.1, 0.0.0.0, ::, or a concrete IPv4/IPv6 literal of a local interface')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--public-url <url>', 'advertise this HTTP(S) root in the printed, opened, runtime-context, and DSH_WEB_URL forms; grants no trust')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--tls-cert <file>', 'PEM server certificate chain; requires --tls-key')
    .option('--tls-key <file>', 'unencrypted PEM private key; requires --tls-cert')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0           bind all IPv4 interfaces (public access via @timgong/dsh-public-access)
  dsh --profile web --host ::                bind all interfaces over IPv6 (dual-stack where supported)
  dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping HTTPS proxy entry
  dsh --profile web --tls-cert ./server-chain.pem --tls-key ./server-key.pem
                                             serve HTTPS with an existing certificate and key
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

    let host
    if (options.host !== undefined) {
      try {
        host = normalizeBindHost(options.host)
      } catch (error) {
        program.error(`error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // dsh 0.2.1 rejects wildcard binds in the webserver config schema. The
    // stock CLI rejects them too; our replacement exists precisely to opt in
    // to a wildcard bind, so widen the boot-path schema before providing the
    // value the `webserver` row validates.
    const wildcard = host === '0.0.0.0' || host === '::'
    if (wildcard && !ensureWildcardBindSupport(ctx.baseUrl)) {
      program.error(
        `error: --host ${host} needs the webserver host schema widened, which is not available on this dsh build; upgrade dsh, or bind one concrete local IP / use a reverse proxy`
      )
    }

    let tls
    if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
      tls = { certFile: options.tlsCert, keyFile: options.tlsKey }
    } else if (options.tlsCert !== undefined || options.tlsKey !== undefined) {
      program.error('error: --tls-cert and --tls-key must be supplied together')
    }

    let publicUrl
    if (options.publicUrl !== undefined) {
      try {
        parsePublicUrl(options.publicUrl, '--public-url')
        publicUrl = options.publicUrl
      } catch (error) {
        program.error(`error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // TLS and --public-url shipped in the same upstream line. On an older
    // harness the rows would ignore the provided values, which is a security
    // surprise for TLS, so fail loudly instead.
    if ((tls !== undefined || publicUrl !== undefined) && !supportsTlsConfig(ctx.baseUrl)) {
      program.error('error: --public-url and --tls-cert/--tls-key require dsh >= 0.2.1; upgrade dsh')
    }

    // Upstream 0.2.1 deleted its own LAN trust derivation. The connection row
    // reads exactly this list, so derive the authorities the wildcard socket
    // actually serves (explicit --trusted-host values keep argument order).
    const trustedHosts = [...(options.trustedHost ?? []), ...lanHosts(host)]

    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...(host !== undefined ? { host } : {}),
      ...(options.port !== undefined ? { port: Number(options.port) } : {}),
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      ...(tls !== undefined ? { tls } : {}),
      trustedHosts
    })
  })

  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) throw new Error('@timgong/dsh-public-access: missing cmdlineArgs/appExit services')
  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
  }
}
