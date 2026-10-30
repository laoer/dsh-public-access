# dsh-public-access (`@timgong/dsh-public-access`)

[简体中文](README.md) | [English](README.en.md)

Public / LAN access plugin for DeepSeek Harness — `0.0.0.0` binding, `--public-url` / TLS, nginx, and username/password login.

> **Package**: `@timgong/dsh-public-access` (forked from JNan-QQ/dsh-public-access).
>
> **Compatibility**: 2.2.0-beta targets **dsh 0.2.1-rc.2** (`>=0.2.1-rc.2 <0.3.0`). Stay on plugin 1.3.0 for dsh 0.1.x.

## 📖 Overview

`@timgong/dsh-public-access` is a DeepSeek Harness plugin that exposes a local development instance to the public internet or a LAN while keeping a real login gate in front of it. It addresses four problems:

- **Network binding**: dsh 0.2.1 rejects wildcard addresses both in the CLI and in the `webserver` config schema; the plugin widens `WebServer.Config.host` in place on the boot path so `0.0.0.0` / `::` work again.
- **Authentication**: username/password login layered on top of dsh's native launch token / signed cookie, with sliding-renewal sessions (24h idle, 7d maximum).
- **Auth wiring**: in 0.2.1 `/api` goes through `connection.admit` instead of `requestRejection`; the plugin feeds the session into `admit` and `authorizeIndex`.
- **Frontend compatibility**: injects `__DSH_TRANSPORT__.ownsHost` and a `crypto.randomUUID` polyfill so settings persistence and RPC keep working on a non-loopback, plain-HTTP origin.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🌐 **Wildcard binding** | Custom `web-startup` + in-place widening of the boot-path `webserver` `host` schema, lifting the dsh 0.2.1 ban on `0.0.0.0` / `::` |
| 🔐 **Login** | Username/password login on top of dsh 0.2.1's native browser auth; `dsh_session` slides on activity: 24h idle, 7d maximum (both configurable) |
| 🌐 **Bilingual login** | The login page speaks Chinese and English: resolved from the URL parameter, cookie, `DSH_AUTH_LANG`, then `Accept-Language`, with an in-page switcher |
| 🛡️ **Trust fence** | Keeps dsh's Host/Origin fence; `--trusted-host` declares public IPs/domains, LAN addresses are derived automatically |
| 🖥️ **Frontend compatibility** | Injects `__DSH_TRANSPORT__.ownsHost` so public access gets loopback-level `isLoopback` behavior |
| 🔒 **crypto polyfill** | Fills in `crypto.randomUUID` on plain-HTTP public origins, preferring `getRandomValues` |
| 🚀 **Auto-detection** | `start.sh` detects the public IP and configures trusted-host / public-url; LAN addresses are derived from the NICs by `web-startup` |
| 🧹 **Revocable logout** | Logout clears `dsh_session` and every `dsh-auth-*` native cookie carried by the request |

## ⬆️ Upgrading to 2.2.0-beta (pre-release)

> **Pre-release**: `2.2.0-beta` is a test build for sliding sessions, v2 tokens, and the bilingual login page; the stable `2.2.0` follows once it settles. Install it by explicit version (`@2.2.0-beta`) — pre-releases are never picked up by `@latest`.

### What changed in 2.2.0-beta

- **Sliding sessions**: `dsh_session` is no longer a fixed 24 hours from login. It expires after 24h of inactivity, renews at most every 5 minutes while you work, and never lives longer than 7 days. All three windows are configurable through `DSH_AUTH_IDLE_HOURS` / `DSH_AUTH_MAX_DAYS` / `DSH_AUTH_RENEW_MINUTES`.
- **New `POST /_auth/renew`**: called by a heartbeat script injected into the index (only while the tab is visible and the user has interacted). It refreshes an existing session only — an unauthenticated request never receives a cookie.
- **Token format v2**: `dsh_session` is now `issuedAt.expiresAt.signature`. Legacy 2-part tokens still validate and are upgraded on the next renewal, so **no one is logged out by the upgrade**.
- **Build pipeline**: `src/*.ts` is now the only source; `src/*.js` is produced by `npm run build` (in-place tsc). Publishing verifies that the committed artifacts match the sources.
- **Bilingual login page**: the page and its error messages speak Chinese and English. The browser's `Accept-Language` decides by default, a switcher at the bottom of the page remembers the choice in a cookie, and `DSH_AUTH_LANG` sets a deployment-wide default.
- No breaking configuration changes: without the new environment variables you get the defaults in the table below (24h / 7d / 5min).

### From 2.1.x

```bash
dsh plugin --profile web add @timgong/dsh-public-access@2.2.0-beta
sudo systemctl restart dsh   # or restart your dsh --profile web process
```

Startup logs the effective session policy, for example `(idle 24h, max 7d, renew 5m)`. Browsers that are already logged in stay logged in.

### From 1.3.0 / 2.0.0

The upstream auth entry points and behavior both changed between 0.1.x and 0.2.1, which made 2.0.0 a breaking release; 2.1.1 also renamed the package from `dsh-public-access` to **`@timgong/dsh-public-access`**, so the old package must be removed first:

1. Upgrade dsh to `0.2.1-rc.2`.
2. Remove the old package: `dsh plugin --profile web remove dsh-public-access`.
3. Install the new one: `dsh plugin --profile web add @timgong/dsh-public-access@2.2.0-beta` (use `github:laoer/dsh-public-access` or a local path if it is not published to npm).
4. Restart `dsh --profile web`.
5. Check that the startup log has no `webserver: ... wildcard ...` error, and that `/` redirects to `/_auth/login`.
6. Already-issued `dsh_session` cookies remain valid, so a re-login is usually unnecessary.

If you are still on dsh 0.1.x, stay on plugin 1.3.0 and do not upgrade to 2.x.

## 📦 Installation

### Option 1: DSH plugin manager (recommended)

```bash
# When published to npm
dsh plugin --profile web add @timgong/dsh-public-access@2.2.0-beta

# From GitHub (pnpm reads the package.json in the repository)
dsh plugin --profile web add github:laoer/dsh-public-access

# Pin a commit for reproducibility
dsh plugin --profile web add 'github:laoer/dsh-public-access#<commit>'
```

### Option 2: Manual install / local development

```bash
# Clone the repository
git clone https://github.com/laoer/dsh-public-access.git
cd dsh-public-access

# Install dependencies
pnpm install

# Add it to the web profile as a link: dependency (recommended; the plugin
# resolves @deepseek-ai/dsh-host-webserver from the profile root, avoiding a
# second module instance)
dsh plugin --profile web add .
```

> When upgrading from the old package name, always run `dsh plugin --profile web remove dsh-public-access` first; `add` would otherwise leave the old bundle behind.
>
> Do not `npm link` the package globally and expect it to resolve dsh's internal packages. dsh anchors runtime resolution at the profile root, so `dsh plugin add .` is the supported development install.

## 🚀 Usage

### Quick start

```bash
# Default credentials admin/admin (only for localhost or a trusted LAN)
./start.sh

# Or run dsh directly (the same core flags start.sh uses)
dsh --profile web --no-open --host 0.0.0.0 --port 3080
```

Open `http://<host-ip>:3080/` in a browser; the first visit redirects to `/_auth/login`. LAN addresses are added to `trustedHosts` automatically from the NICs. Declare public IPs / domains through `--trusted-host` or `DSH_TRUSTED_HOSTS`.

### Custom configuration

```bash
# Custom credentials
DSH_AUTH_USER=myuser DSH_AUTH_PASS=mypassword ./start.sh

# Custom bind address / port
DSH_HOST=0.0.0.0 DSH_PORT=8080 ./start.sh

# Advertise a public domain or prefix-proxy root (used in startup logs,
# DSH_WEB_URL, and the agent runtime context)
DSH_PUBLIC_URL=https://app.example/ui/ ./start.sh

# Let dsh terminate TLS itself instead of nginx
DSH_TLS_CERT=/etc/ssl/app-chain.pem DSH_TLS_KEY=/etc/ssl/app-key.pem ./start.sh

# Extra trusted authorities (space-separated)
DSH_TRUSTED_HOSTS="app.example 203.0.113.10" ./start.sh
```

### Production deployment (nginx terminating TLS, recommended)

Let dsh listen on loopback only and put nginx in front for TLS and the public entry point. This avoids the wildcard bind entirely and shrinks the attack surface:

```bash
dsh --profile web --host 127.0.0.1 --port 3080 \
  --public-url https://app.example/ --trusted-host app.example
```

Use `--host 0.0.0.0` (or `::`) only when every local interface really must be reachable.

### systemd example

```bash
sudo tee /etc/systemd/system/dsh.service <<EOF
[Unit]
Description=DeepSeek Harness with Public Access
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/dsh-public-access
Environment=DSH_AUTH_USER=admin
Environment=DSH_AUTH_PASS=your-secure-password
Environment=DSH_PORT=3080
Environment=DSH_PUBLIC_URL=https://app.example/
Environment=DSH_TRUSTED_HOSTS=app.example
ExecStart=/path/to/dsh-public-access/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable dsh
sudo systemctl start dsh
```

## ⚙️ Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DSH_AUTH_USER` | `admin` | Login username |
| `DSH_AUTH_PASS` | `admin` | Login password |
| `DSH_AUTH_SALT` | `dsh-reverse-proxy-salt` | Password hash salt |
| `DSH_AUTH_IDLE_HOURS` | `24` | Sliding idle window (hours): the session dies after this long without a renewal |
| `DSH_AUTH_MAX_DAYS` | `7` | Absolute session lifetime (days) counted from login; `0` disables the cap |
| `DSH_AUTH_RENEW_MINUTES` | `5` | Renewal throttle: at most one `Set-Cookie` per N minutes |
| `DSH_AUTH_LANG` | browser | Login-page language: `zh-CN` or `en`; when unset, `Accept-Language` decides |
| `DSH_HOST` | `0.0.0.0` | Bind address `start.sh` passes to `--host` |
| `DSH_PORT` | `3080` | Listen port |
| `DSH_PUBLIC_URL` | empty | Public root URL passed to `--public-url` |
| `DSH_TRUSTED_HOSTS` | empty | Extra `--trusted-host` values, space-separated |
| `DSH_TLS_CERT` / `DSH_TLS_KEY` | empty | Passed to `--tls-cert` / `--tls-key`; must be set together |

### Command-line flags

| Flag | Description |
|------|-------------|
| `--host <host>` | Bind address: `127.0.0.1`, `0.0.0.0`, `::`, or a concrete IPv4/IPv6 literal |
| `--port <port>` | Listen port (0 lets the OS pick one) |
| `--no-open` | Do not open a browser automatically |
| `--trusted-host <authority>` | Add an extra trusted authority (repeatable; LAN addresses are derived automatically) |
| `--public-url <url>` | Advertised HTTP(S) root used for the printed/opened URL, `DSH_WEB_URL`, and the agent runtime context |
| `--tls-cert <file>` | PEM certificate chain; requires `--tls-key` |
| `--tls-key <file>` | Unencrypted PEM private key; requires `--tls-cert` |

> `--public-url` / `--tls-*` require dsh 0.2.1+. On older harnesses they fail loudly instead of being ignored.

## 🔧 Using with nginx

Let dsh listen on `127.0.0.1` and terminate TLS in nginx:

```bash
dsh --profile web --host 127.0.0.1 --port 3080 \
  --public-url https://your-domain.com/ --trusted-host your-domain.com
```

Key points:

- nginx must forward the real `Host` header (the default `proxy_set_header Host $host;` is enough). If it sends `127.0.0.1`, dsh treats the request as local.
- `--trusted-host` must include the authority in the browser's address bar; otherwise `/api` returns plain-text `forbidden`. That is dsh's Host fence, not a failed plugin login.
- For a path prefix (for example `https://app.example/ui/`), use `--public-url https://app.example/ui/` and have nginx strip `/ui/` before proxying. The plugin's login/logout/index redirects are relative, so they work behind a prefix.
- `X-Forwarded-Proto` is never trusted for auth decisions. To get `Secure` cookies, configure `--public-url https://...` or let dsh terminate TLS itself.

### Basic configuration

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### HTTPS configuration

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

## 🔒 Security

### Authentication (dsh 0.2.1 adaptation)

dsh 0.2.1 introduced native browser auth for the web UI: each process generates a random launch token, and visiting `http://<host>:<port>/?token=...` exchanges it for a signed cookie bound to that authority (30 days by default). Both `/api` and `index.html` require that cookie, and `/api` additionally passes the Host/Origin fence first. This plugin layers username/password login **on top** of that mechanism:

- **Plugin login (recommended, easy to share)**: an unauthenticated visit to the root redirects to `/_auth/login`; logging in with `DSH_AUTH_USER` / `DSH_AUTH_PASS` issues a sliding `dsh_session` cookie.
- **Auth wiring**: in dsh 0.2.1, `/api` and API WebSocket upgrades go through `connection.admit`, and the index goes through `connection.authorizeIndex`. The plugin feeds a valid `dsh_session` into both; everything else falls through to dsh's native token/cookie flow unchanged.
- **Trust fence**: the Host/Origin fence still applies. `--trusted-host` declares public IPs/domains; with `0.0.0.0` the plugin derives LAN addresses from the NICs and `start.sh` additionally probes the public IP. An undeclared Host gets 403 on `/api`.
- **Sliding renewal**: a session expires after `DSH_AUTH_IDLE_HOURS` (24 by default) of inactivity, renews at most once per `DSH_AUTH_RENEW_MINUTES` (5 by default) while in use, and never exceeds `DSH_AUTH_MAX_DAYS` (7 by default) from login. There are two renewal paths: the heartbeat script injected into the index calls `POST /_auth/renew` (only while the tab is visible and the user has produced keyboard/pointer input in that interval), and every index load renews opportunistically inside the auth gate (covering JS-disabled browsers and static deployments). The heartbeat only refreshes an existing session — `/_auth/renew` never hands a cookie to an unauthenticated request and requires the `x-dsh-renew: 1` header, which cross-site forms and images cannot set.
- **Login-page language**: resolved as `?lang=` → `dsh_lang` cookie → `DSH_AUTH_LANG` → `Accept-Language`. The cookie is written only when the visitor picks a language from the page links (one year), so auto-detection is never pinned by accident.
- **Session management**: `dsh_session` is signed with HMAC-SHA256. A v2 token carries `issuedAt.expiresAt` and is signed with a domain-separation prefix so the two formats cannot be replayed as each other; legacy 2-part tokens still validate and are upgraded on the next renewal. Passwords are salted SHA-256, and both username and password comparisons use `timingSafeEqual` to avoid timing leaks. Logout clears `dsh_session` plus every `dsh-auth-*` native cookie carried by the request.
- **Frontend compatibility**: an injected script sets `globalThis.__DSH_TRANSPORT__.ownsHost = true`, giving public access the same `isLoopback` state as loopback (host-side settings persistence, file open, …), and polyfills `crypto.randomUUID` on plain-HTTP public origins.

### Security boundaries of wildcard binding

dsh 0.2.1 rejects `0.0.0.0` on the grounds that exposing every interface amplifies remote-code-execution risk. To keep the one-command public/LAN workflow, this plugin **widens the `WebServer.Config.host` schema in place on the boot path** and treats the login gate above as the compensating control. Keep in mind:

1. **This is not an upstream-supported configuration.** The schema shape may change on a dsh upgrade; when widening fails the plugin fails loudly instead of degrading silently.
2. **Login is not a substitute for network isolation.** When exposing to the internet, use HTTPS, a firewall/security group, and change the default password.
3. **Third-party routes are outside this plugin's auth scope**: it only protects dsh's index and the `/api` routes managed by `connection`. Routes other plugins register directly on `webServer` follow their own security policy; install only plugins you trust.
4. **The plugin session is the only revocable credential**: it never forges or replays dsh's native `dsh-auth-*` cookie; the native cookie remains a fallback entry point.

### Recommendations

1. **Change the default password**: always set `DSH_AUTH_USER` / `DSH_AUTH_PASS` in production.
2. **Prefer nginx + loopback**: use `--host 0.0.0.0` only when multi-NIC direct access is truly needed.
3. **Use HTTPS**: terminate TLS in nginx, or configure `--tls-cert` / `--tls-key`.
4. **Restrict access**: limit source IPs with a firewall or security group.
5. **Keep it current**: keep the plugin and dsh versions in sync.

## 🛠️ Troubleshooting

### Common issues

#### 1. The web UI is unreachable

```bash
# Is the service running?
ps aux | grep dsh

# Is the port listening?
netstat -tlnp | grep 3080

# Firewall rules
sudo ufw status
sudo iptables -L -n
```

#### 2. Login keeps bouncing back to the login page

```bash
# Check whether the browser blocks cookies
# Check that the system clock is accurate (session validation depends on timestamps)
date

# Clear browser cache and cookies
```

If you were working and got kicked out: sessions have an absolute cap, so after `DSH_AUTH_MAX_DAYS` (7 by default) from login you must sign in again; a tab that stays in the background or sees no input for longer than `DSH_AUTH_IDLE_HOURS` (24 by default) also expires.

#### 3. Startup fails with a webserver wildcard / `--host 0.0.0.0` error

The plugin could not widen the boot-path `WebServer.Config.host` (dsh version mismatch, or the boot path failed to resolve). Check:

```bash
dsh --profile web --dump-config | grep -A3 web-startup
```

Confirm that `web-startup` is disabled and `public-access-web-startup` is inserted. If it still fails:

- upgrade dsh to 0.2.1-rc.2;
- or bind a concrete NIC address: `--host 192.168.1.5`;
- or let dsh listen on `127.0.0.1` and expose it through nginx.

#### 4. The login POST returns 405 at `/_auth/_auth/login`

2.1.0 used the wrong relative path (`_auth/login`) in the login form, so `/_auth/login` resolved to `/_auth/_auth/login`. 2.1.1 switched to the sibling `login` and fixed the relative redirects after login and logout. After upgrading to 2.2.0-beta, force-reload the login page (or clear the cache):

```bash
dsh plugin --profile web remove dsh-public-access
dsh plugin --profile web add @timgong/dsh-public-access@2.2.0-beta
sudo systemctl restart dsh
```

#### 5. API requests return 401

```bash
# Make sure you are logged in and the session has not expired
# Check that the request carries the right cookie
curl -v -b "dsh_session=your-session" http://localhost:3080/api/status
```

If login succeeds but `/api` still returns 401, check that the plugin actually loaded and that `connection.admit` was patched; in dsh 0.2.1 `/api` no longer goes through `requestRejection`.

#### 6. API requests return 403 / plain-text forbidden

That is dsh's Host/Origin fence, not a failed plugin login. Add the authority from the browser's address bar to `--trusted-host` (or `DSH_TRUSTED_HOSTS`) and make sure the reverse proxy forwards the real `Host`. The response shape tells you which layer answered:

| Response | Origin | Fix |
|----------|--------|-----|
| 401 / redirect to `/_auth/login` | Plugin session invalid | Log in again |
| Plain-text `forbidden` | dsh Host fence | Add `--trusted-host` |
| 403 page on the login POST | Plugin rejected an untrusted Host | Add `--trusted-host` |

#### 7. WebSocket connections fail behind nginx

Make sure the nginx configuration carries WebSocket support:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### Logs

```bash
# dsh logs
journalctl -u dsh -f

# Or the process output directly
./start.sh 2>&1 | tee dsh.log
```

## 📁 Project structure

```
dsh-public-access/
├── src/
│   ├── *.ts                   # the only sources (tsc emits the sibling .js)
│   ├── reverse-proxy-fix.js   # main plugin (login/logout/renew routes + admit/authorizeIndex wiring + polyfills)
│   ├── auth.js                # auth module (v2 session tokens, sliding-renewal policy, password check, login page)
│   ├── login-i18n.js          # login copy + locale resolution (zh-CN / en)
│   ├── web-startup.js         # web startup config (host schema widening, new flags, trustedHosts derivation)
│   ├── webserver-schema.js    # boot-path webserver host schema widening + LAN authority derivation
│   └── public-url.js          # --public-url validation (same rules as stock)
├── test/                      # node:test unit tests
├── tsconfig.json              # type-check config (noEmit)
├── tsconfig.build.json        # build config (emits src/*.js in place)
├── cordis.patch.yml           # DSH plugin configuration patch
├── start.sh                   # launch script
├── package.json               # package metadata
├── README.md                  # Chinese documentation
└── README.en.md               # English documentation
```

## 🤝 Contributing

Contributions are welcome. The usual flow:

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-feature`.
3. Commit your changes: `git commit -m 'feat: add your feature'`.
4. Push the branch: `git push origin feature/your-feature`.
5. Open a pull request.

### Development setup

```bash
# Clone the repository
git clone https://github.com/laoer/dsh-public-access.git
cd dsh-public-access

# Install dependencies
pnpm install

# Type check + unit tests
npm run check

# Add it to the web profile as a link: dependency
dsh plugin --profile web add .
```

### Build (`src/*.ts` → `src/*.js`)

`src/*.ts` is the only source; `src/*.js` is build output. The dsh runtime, the `main`/`exports` fields in `package.json`, and the tests all load the `.js` files directly. The build is an **in-place tsc emit** (same directory, same basename), so the package layout and installation flows are unchanged and installing from git needs no build step.

```bash
npm run build             # tsc -p tsconfig.build.json, emits src/*.js in place
npm run typecheck         # tsc -p tsconfig.json (noEmit, types only)
npm run check             # typecheck + test
npm run verify:artifacts  # build, then check src/*.js matches the committed version
                          # (prepublishOnly runs this automatically)
```

Rules:

- **Edit `.ts` only, never the `.js` by hand.** Run `npm run build` and commit the output alongside the source change.
- The `.js` files must stay committed: `dsh plugin add github:...` does not compile on install, so missing artifacts break plugin loading.
- tsc normalizes indentation to 4 spaces and adds semicolons; that is expected. Comments and JSDoc are preserved.
- `prepublishOnly` runs `verify:artifacts` + `test`, so a stale artifact blocks publishing.

> Why not tsup/esbuild: this project needs no bundling (every file is an independent ESM entry point), and esbuild drops comments by default — the JSDoc in `src/*.js` is the only documentation JS consumers get, so the build uses tsc, which preserves it.

### Coding standards

- Use ES modules.
- Follow the existing style.
- Comment what is not obvious.
- Update the documentation.

## 📄 License

Released under the [Mulan Permissive Software License, Version 2](LICENSE) (MulanPSL-2.0).

## 🔗 Links

- **Repository**: https://github.com/laoer/dsh-public-access
- **DeepSeek Harness**: https://github.com/deepseek-ai/deepseek-harness
- **Issues**: https://github.com/laoer/dsh-public-access/issues

## 📞 Support

Questions and suggestions are welcome:

- Open an issue on the Gitee repository.
- Email the maintainer.

---

**Enjoy DeepSeek Harness!** 🎉
