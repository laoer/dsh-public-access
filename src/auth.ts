import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const SESSION_TTL = 24 * 60 * 60 * 1000 // 24 hours

// Hash password with salt
function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(salt + password).digest('hex')
}

// Get credentials from environment or config
function getCredentials() {
  const username = process.env.DSH_AUTH_USER || 'admin'
  const password = process.env.DSH_AUTH_PASS || 'admin'
  const salt = process.env.DSH_AUTH_SALT || 'dsh-reverse-proxy-salt'
  return { username, password: hashPassword(password, salt), salt }
}

function getSessionSecret(): string {
  const creds = getCredentials()
  return `${creds.password}:${creds.salt}`
}

function signSession(expiresAt: number): string {
  return createHmac('sha256', getSessionSecret()).update(String(expiresAt)).digest('hex')
}

/**
 * Validate the plugin session cookie. The cookie name is matched only at the
 * start of the header or after a `;`, so a similarly named foreign cookie
 * cannot satisfy it.
 * @param cookieHeader raw `Cookie` header.
 * @returns true for an unexpired, correctly signed session.
 */
export function validateSession(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false
  const match = cookieHeader.match(/(?:^|;\s*)dsh_session=(\d+)\.([a-f0-9]+)/)
  if (!match) return false
  const expiresAt = Number(match[1])
  const signature = match[2]
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false

  const expected = Buffer.from(signSession(expiresAt), 'hex')
  const actual = Buffer.from(signature, 'hex')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

// Create a new session
export function createSession(): string {
  const expiresAt = Date.now() + SESSION_TTL
  return `${expiresAt}.${signSession(expiresAt)}`
}

/**
 * Validate username/password against the environment credentials. Both
 * comparisons use fixed-length byte buffers so a mismatch does not leak
 * length or prefix information through timing.
 * @param username submitted username.
 * @param password submitted plaintext password.
 * @returns true when both match.
 */
export function validateLogin(username: string, password: string): boolean {
  const creds = getCredentials()
  const expectedUser = Buffer.from(creds.username)
  const actualUser = Buffer.from(username)
  const expectedPass = Buffer.from(creds.password, 'hex')
  const actualPass = Buffer.from(hashPassword(password, creds.salt), 'hex')
  const userOk =
    expectedUser.length === actualUser.length && timingSafeEqual(expectedUser, actualUser)
  const passOk =
    expectedPass.length === actualPass.length && timingSafeEqual(expectedPass, actualPass)
  return userOk && passOk
}

/**
 * Escape text placed into the login page's HTML. Error messages can include
 * request-controlled values (for example a Host header), so this is not
 * optional.
 * @param value text to escape.
 * @returns HTML-safe text.
 */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * Render the login page. The form posts to its sibling `login`: from
 * /_auth/login (or /ui/_auth/login) that resolves to /_auth/login (or
 * /ui/_auth/login). `_auth/login` would resolve to /_auth/_auth/login.
 * @param error optional error message shown above the form.
 * @returns the complete HTML document.
 */
export function getLoginPage(error?: string): string {
  const errorHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepSeek Harness - 登录</title>
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
      <p>请登录以继续</p>
    </div>
    ${errorHtml}
    <form method="POST" action="login">
      <div class="form-group">
        <label>用户名</label>
        <input type="text" name="username" required autocomplete="username" autofocus>
      </div>
      <div class="form-group">
        <label>密码</label>
        <input type="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit">登 录</button>
    </form>
  </div>
</body>
</html>`
}
