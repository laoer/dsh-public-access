import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parsePublicUrl } from './public-url.js';
import { MIN_PASSWORD_LENGTH, resetCredentials } from './credentials.js';
import { ensureWildcardBindSupport, lanHosts, normalizeBindHost, supportsTlsConfig } from './webserver-schema.js';
export const name = 'web-startup';
export const inject = ['cmdlineArgs'];
export const WEB_STARTUP_SERVICE = 'webStartup';
function configureOutput(program) {
    program.exitOverride().configureOutput({
        writeOut: (text) => process.stdout.write(text),
        writeErr: (text) => process.stderr.write(text)
    });
    for (const child of program.commands)
        configureOutput(child);
}
function isCommanderError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    return (typeof candidate.code === 'string' &&
        candidate.code.startsWith('commander.') &&
        typeof candidate.exitCode === 'number');
}
/**
 * Prompt for a password with echo suppressed on a POSIX TTY.
 * @param question prompt text.
 * @returns the entered line.
 */
function promptHiddenPassword(question) {
    process.stdout.write(question);
    let muted = false;
    try {
        execSync('stty -echo', { stdio: 'ignore' });
        muted = true;
    }
    catch {
        process.stdout.write('(input is not a terminal; the password will be echoed)\n');
    }
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on('line', (line) => {
            if (muted) {
                try {
                    execSync('stty echo', { stdio: 'ignore' });
                }
                catch {
                    // stdin vanished; nothing to restore
                }
                process.stdout.write('\n');
            }
            rl.close();
            resolve(line);
        });
    });
}
/**
 * Prompt twice and require both entries to match.
 * @returns the new password.
 */
async function promptNewPassword() {
    const first = await promptHiddenPassword('New password: ');
    const second = await promptHiddenPassword('Repeat new password: ');
    if (first !== second)
        throw new Error('the two passwords do not match');
    return first;
}
/**
 * Recover from a forgotten password, or rename the administrator.
 *
 * Every successful call rotates the session signing secret, so all previously
 * issued cookies — including one an attacker may hold — die at once.
 * @param options `--password` / `--username` values.
 * @returns a human-readable confirmation.
 */
export async function runAuthReset(options) {
    let password = options.password;
    if (password === undefined && options.username === undefined) {
        password = await promptNewPassword();
    }
    if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const result = resetCredentials({
        ...(options.username !== undefined ? { username: options.username } : {}),
        ...(password !== undefined ? { password } : {})
    });
    const parts = [];
    if (result.usernameChanged)
        parts.push(`username is now "${result.username}"`);
    if (result.passwordChanged)
        parts.push('password updated');
    return `${parts.join(', ') || 'no change'}; every existing session has been signed out`;
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
  dsh --profile web auth-reset               reset the administrator password (signs out every session)
  dsh --profile web auth-reset --username alice   rename the administrator
`);
}
export function apply(ctx) {
    const program = webCommand();
    configureOutput(program);
    program.action(() => {
        const options = program.opts();
        if (options.port !== undefined && !/^\d+$/.test(options.port)) {
            program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
        }
        let host;
        if (options.host !== undefined) {
            try {
                host = normalizeBindHost(options.host);
            }
            catch (error) {
                program.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // dsh 0.2.1 rejects wildcard binds in the webserver config schema, and
        // IPv6 / concrete literals are only accepted through the widened member.
        // The stock CLI rejects them too; our replacement exists precisely to opt
        // in, so widen the boot-path schema before providing the value the
        // `webserver` row validates.
        if (host !== undefined && host !== '127.0.0.1' && !ensureWildcardBindSupport(ctx.baseUrl)) {
            program.error(`error: --host ${host} needs the webserver host schema widened, which is not available on this dsh build; upgrade dsh, or bind 127.0.0.1 / use a reverse proxy`);
        }
        let tls;
        if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
            tls = { certFile: options.tlsCert, keyFile: options.tlsKey };
        }
        else if (options.tlsCert !== undefined || options.tlsKey !== undefined) {
            program.error('error: --tls-cert and --tls-key must be supplied together');
        }
        let publicUrl;
        if (options.publicUrl !== undefined) {
            try {
                parsePublicUrl(options.publicUrl, '--public-url');
                publicUrl = options.publicUrl;
            }
            catch (error) {
                program.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // TLS and --public-url shipped in the same upstream line. On an older
        // harness the rows would ignore the provided values, which is a security
        // surprise for TLS, so fail loudly instead.
        if ((tls !== undefined || publicUrl !== undefined) && !supportsTlsConfig(ctx.baseUrl)) {
            program.error('error: --public-url and --tls-cert/--tls-key require dsh >= 0.2.1; upgrade dsh');
        }
        // Upstream 0.2.1 deleted its own LAN trust derivation. The connection row
        // reads exactly this list, so derive the authorities the wildcard socket
        // actually serves (explicit --trusted-host values keep argument order).
        const trustedHosts = [...(options.trustedHost ?? []), ...lanHosts(host)];
        ctx.provide(WEB_STARTUP_SERVICE, {
            openBrowser: options.open,
            ...(host !== undefined ? { host } : {}),
            ...(options.port !== undefined ? { port: Number(options.port) } : {}),
            ...(publicUrl !== undefined ? { publicUrl } : {}),
            ...(tls !== undefined ? { tls } : {}),
            trustedHosts
        });
    });
    // `dsh --profile web auth-reset` — the documented recovery path for a
    // forgotten password, and the only way to change the administrator name.
    program
        .command('auth-reset')
        .description('reset the administrator password and/or username; signs out every session')
        .option('--password <password>', 'new password (omit for a hidden interactive prompt)')
        .option('--username <username>', 'new username (omit to keep the current one)')
        .action(async (options) => {
        const exit = ctx.get('appExit');
        try {
            const message = await runAuthReset(options);
            process.stdout.write(`${message}\n`);
            exit?.(0);
        }
        catch (error) {
            process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
            exit?.(1);
        }
    });
    const args = ctx.get('cmdlineArgs');
    const exit = ctx.get('appExit');
    if (args === undefined || exit === undefined)
        throw new Error('@timgong/dsh-public-access: missing cmdlineArgs/appExit services');
    try {
        program.parse(args.get(), { from: 'user' });
    }
    catch (error) {
        if (!isCommanderError(error))
            throw error;
        exit(error.exitCode);
    }
}
