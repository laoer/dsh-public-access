import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_LOCALE, LANGUAGE_NAMES, LOCALES, loginMessages } from './login-i18n.js';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Domain separation: a v2 signature must never be replayable as a legacy one.
const SIGNATURE_DOMAIN = 'dsh-session-v2|';
function envNumber(name) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '')
        return undefined;
    if (!/^\d+(\.\d+)?$/.test(raw.trim())) {
        throw new Error(`@timgong/dsh-public-access: ${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
    }
    return Number(raw);
}
/**
 * Read and validate the sliding-renewal policy. Throws on a present but
 * malformed value instead of silently running with a weaker default; the
 * plugin calls this during activation so a typo fails at startup.
 * @returns the resolved policy in milliseconds.
 */
export function getSessionPolicy() {
    const idleHours = envNumber('DSH_AUTH_IDLE_HOURS') ?? 24;
    const maxDays = envNumber('DSH_AUTH_MAX_DAYS') ?? 7;
    const renewMinutes = envNumber('DSH_AUTH_RENEW_MINUTES') ?? 5;
    const idle = idleHours * HOUR;
    if (!(idle > 0)) {
        throw new Error('@timgong/dsh-public-access: DSH_AUTH_IDLE_HOURS must be greater than 0');
    }
    return {
        idle,
        absolute: maxDays * DAY,
        // A step at or beyond the idle window would make renewal pointless.
        renew: Math.min(renewMinutes * MINUTE, idle)
    };
}
// Hash password with salt
function hashPassword(password, salt) {
    return createHash('sha256').update(salt + password).digest('hex');
}
// Get credentials from environment or config
function getCredentials() {
    const username = process.env.DSH_AUTH_USER || 'admin';
    const password = process.env.DSH_AUTH_PASS || 'admin';
    const salt = process.env.DSH_AUTH_SALT || 'dsh-reverse-proxy-salt';
    return { username, password: hashPassword(password, salt), salt };
}
function getSessionSecret() {
    const creds = getCredentials();
    return `${creds.password}:${creds.salt}`;
}
// The cookie name is matched only at the start of the header or after a `;`,
// so a similarly named foreign cookie (`foo_dsh_session`) cannot satisfy it.
const SESSION_COOKIE_PATTERN = /(?:^|;\s*)dsh_session=([^;]*)/;
function signPayload(payload) {
    return createHmac('sha256', getSessionSecret()).update(SIGNATURE_DOMAIN + payload).digest('hex');
}
// Legacy 2-part token: HMAC over the expiry alone. Accepted so an upgrade
// does not log everyone out; the next renewal turns it into a v2 token.
function signLegacy(expiresAt) {
    return createHmac('sha256', getSessionSecret()).update(String(expiresAt)).digest('hex');
}
function signatureMatches(expectedHex, actualHex) {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** The expiry a renewal issued now may reach: idle window, capped by login. */
function expiryFor(issuedAt, now, policy) {
    const idleDeadline = now + policy.idle;
    if (!(policy.absolute > 0))
        return idleDeadline;
    return Math.min(idleDeadline, issuedAt + policy.absolute);
}
function tokenFor(issuedAt, expiresAt) {
    const payload = `${issuedAt}.${expiresAt}`;
    return `${payload}.${signPayload(payload)}`;
}
function readSessionValue(cookieHeader) {
    if (!cookieHeader)
        return undefined;
    const match = cookieHeader.match(SESSION_COOKIE_PATTERN);
    return match?.[1].trim() || undefined;
}
/**
 * Inspect the plugin session cookie without extending it. Returns `undefined`
 * for a missing, foreign, expired, or badly signed cookie.
 * @param cookieHeader raw `Cookie` header.
 * @param now clock used for the expiry check (tests pass a fixed value).
 * @returns the session when it is still valid.
 */
export function inspectSession(cookieHeader, now = Date.now()) {
    const value = readSessionValue(cookieHeader);
    if (value === undefined)
        return undefined;
    const parts = value.split('.');
    if (parts.length === 3) {
        const issuedAt = Number(parts[0]);
        const expiresAt = Number(parts[1]);
        if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt))
            return undefined;
        if (issuedAt <= 0 || expiresAt <= issuedAt)
            return undefined;
        if (!signatureMatches(signPayload(`${issuedAt}.${expiresAt}`), parts[2]))
            return undefined;
        if (now > expiresAt)
            return undefined;
        return { issuedAt, expiresAt, remaining: expiresAt - now, legacy: false };
    }
    if (parts.length === 2) {
        const expiresAt = Number(parts[0]);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)
            return undefined;
        if (!signatureMatches(signLegacy(expiresAt), parts[1]))
            return undefined;
        if (now > expiresAt)
            return undefined;
        // A 2-part token carries no issue time: assume it was minted a full idle
        // window before it expires, but never claim it was issued in the future.
        const issuedAt = Math.min(expiresAt - getSessionPolicy().idle, now);
        return { issuedAt, expiresAt, remaining: expiresAt - now, legacy: true };
    }
    return undefined;
}
/**
 * Validate the plugin session cookie.
 * @param cookieHeader raw `Cookie` header.
 * @returns true for an unexpired, correctly signed session.
 */
export function validateSession(cookieHeader) {
    return inspectSession(cookieHeader) !== undefined;
}
/**
 * Mint a fresh session at login: the idle window and the absolute cap are
 * both counted from `now`.
 * @param now issue time (tests pass a fixed value).
 * @returns the cookie value and the expiry it carries.
 */
export function issueSession(now = Date.now()) {
    const expiresAt = expiryFor(now, now, getSessionPolicy());
    return { value: tokenFor(now, expiresAt), expiresAt };
}
/**
 * Mint a fresh session token at login.
 * @param now issue time (tests pass a fixed value).
 * @returns the cookie value.
 */
export function createSession(now = Date.now()) {
    return issueSession(now).value;
}
/**
 * Renew a still-valid session, sliding its expiry forward. Returns `undefined`
 * when the session was renewed too recently (throttle) or has hit the absolute
 * cap — callers then simply keep the cookie they already have.
 * @param info the inspected session.
 * @param now renewal time (tests pass a fixed value).
 * @returns the new cookie value and expiry, or `undefined` for "no change".
 */
export function renewSession(info, now = Date.now()) {
    const policy = getSessionPolicy();
    // Throttle: one renewal per step, so a busy tab does not churn Set-Cookie.
    // The last renewal is recoverable from the token itself: a slide always
    // stamps `expiresAt = renewedAt + idle`, so subtracting the idle window
    // gives `renewedAt` without any server state.
    const lastRenewedAt = info.expiresAt - policy.idle;
    if (now - lastRenewedAt < policy.renew)
        return undefined;
    const expiresAt = expiryFor(info.issuedAt, now, policy);
    // At the absolute cap (or with a clock that moved backwards) there is
    // nothing to extend; the session is about to end and must re-login.
    if (expiresAt <= info.expiresAt)
        return undefined;
    return { value: tokenFor(info.issuedAt, expiresAt), expiresAt };
}
/**
 * Validate username/password against the environment credentials. Both
 * comparisons use fixed-length byte buffers so a mismatch does not leak
 * length or prefix information through timing.
 * @param username submitted username.
 * @param password submitted plaintext password.
 * @returns true when both match.
 */
export function validateLogin(username, password) {
    const creds = getCredentials();
    const expectedUser = Buffer.from(creds.username);
    const actualUser = Buffer.from(username);
    const expectedPass = Buffer.from(creds.password, 'hex');
    const actualPass = Buffer.from(hashPassword(password, creds.salt), 'hex');
    const userOk = expectedUser.length === actualUser.length && timingSafeEqual(expectedUser, actualUser);
    const passOk = expectedPass.length === actualPass.length && timingSafeEqual(expectedPass, actualPass);
    return userOk && passOk;
}
/**
 * Escape text placed into the login page's HTML. Error messages can include
 * request-controlled values (for example a Host header), so this is not
 * optional.
 * @param value text to escape.
 * @returns HTML-safe text.
 */
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
        switch (char) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}
/**
 * Render the login page in one locale. The form posts to its sibling `login`:
 * from /_auth/login (or /ui/_auth/login) that resolves to /_auth/login (or
 * /ui/_auth/login). `_auth/login` would resolve to /_auth/_auth/login.
 *
 * The language links are relative (`?lang=en`), so they keep working behind a
 * prefix-stripping proxy, and the current language is shown as plain text
 * rather than a link to itself.
 * @param locale page language; the caller resolves it per request.
 * @param error optional, already-localized error message shown above the form.
 * @returns the complete HTML document.
 */
export function getLoginPage(locale = DEFAULT_LOCALE, error) {
    const messages = loginMessages(locale);
    const errorHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
    const languageLinks = LOCALES.map((code) => code === locale
        ? `<span aria-current="true">${LANGUAGE_NAMES[code]}</span>`
        : `<a href="?lang=${code}" hreflang="${code}" lang="${code}">${LANGUAGE_NAMES[code]}</a>`).join('<span class="sep">·</span>');
    return `<!DOCTYPE html>
<html lang="${messages.tag}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${messages.docTitle}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .login-card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo h1 {
      font-size: 24px;
      font-weight: 600;
      color: #fff;
    }
    .logo p {
      font-size: 14px;
      color: #888;
      margin-top: 8px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 14px;
      color: #aaa;
      margin-bottom: 8px;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      background: #0d0d0d;
      border: 1px solid #333;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: #4a9eff;
    }
    button {
      width: 100%;
      padding: 12px;
      background: #4a9eff;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #3a8eef;
    }
    .langs {
      margin-top: 24px;
      text-align: center;
      font-size: 12px;
      color: #777;
    }
    .langs a { color: #4a9eff; text-decoration: none; }
    .langs a:hover { text-decoration: underline; }
    .langs .sep { color: #444; margin: 0 6px; }
    .langs span[aria-current] { color: #aaa; }
    .error {
      background: #2d1b1b;
      border: 1px solid #5c2b2b;
      color: #ff6b6b;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">
      <h1>DeepSeek Harness</h1>
      <p>${messages.subtitle}</p>
    </div>
    ${errorHtml}
    <form method="POST" action="login">
      <div class="form-group">
        <label>${messages.usernameLabel}</label>
        <input type="text" name="username" required autocomplete="username" autofocus>
      </div>
      <div class="form-group">
        <label>${messages.passwordLabel}</label>
        <input type="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit">${messages.submitLabel}</button>
    </form>
    <div class="langs">${languageLinks}</div>
  </div>
</body>
</html>`;
}
