import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import {
  createSession,
  escapeHtml,
  getLoginPage,
  getSessionPolicy,
  inspectSession,
  issueSession,
  renewSession,
  validateLogin,
  validateSession
} from '../src/auth.js'
import { ensureCredentials } from '../src/credentials.js'
import {
  INDEX_LOGIN_LOCATION,
  LOGIN_SUCCESS_LOCATION,
  LOGOUT_LOCATION
} from '../src/reverse-proxy-fix.js'

const HOUR = 60 * 60 * 1000

before(() => {
  // An isolated home: the credential store must not touch the real ~/.dsh.
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-public-access-test-'))
  process.env.DSH_AUTH_USER = 'admin'
  process.env.DSH_AUTH_PASS = 'secret'
  delete process.env.DSH_AUTH_SALT
  delete process.env.DSH_AUTH_FILE
  // Seeding from the environment is exactly the upgrade path a deployed
  // instance takes, so the tests exercise it instead of a private back door.
  ensureCredentials()
})

test('createSession / validateSession round-trip', () => {
  const session = createSession()
  assert.equal(validateSession(`dsh_session=${session}`), true)
  assert.equal(validateSession(`theme=dark; dsh_session=${session}`), true)
})

test('validateSession rejects foreign names, expiry, and tampering', () => {
  const session = createSession()
  assert.equal(validateSession(`foo_dsh_session=${session}`), false)
  assert.equal(validateSession('dsh_session=1.0000'), false)
  const tampered = `${session.slice(0, -1)}${session.endsWith('a') ? 'b' : 'a'}`
  assert.equal(validateSession(`dsh_session=${tampered}`), false)
  assert.equal(validateSession(undefined), false)
})

test('validateLogin compares both fields', () => {
  assert.equal(validateLogin('admin', 'secret'), true)
  assert.equal(validateLogin('admin', 'wrong'), false)
  assert.equal(validateLogin('other', 'secret'), false)
})

test('login page posts to the sibling login route', () => {
  const html = getLoginPage()
  assert.match(html, /action="login"/)
  assert.doesNotMatch(html, /action="_auth\/login"/)
  assert.doesNotMatch(html, /action="\/_auth\/login"/)
})

test('auth relative URLs resolve at root and under a prefix', () => {
  // form action: sibling `login`
  assert.equal(new URL('login', 'https://h/_auth/login').pathname, '/_auth/login')
  assert.equal(new URL('login', 'https://h/ui/_auth/login').pathname, '/ui/_auth/login')

  // after login: `../` from the login page reaches the app root
  assert.equal(new URL(LOGIN_SUCCESS_LOCATION, 'https://h/_auth/login').pathname, '/')
  assert.equal(new URL(LOGIN_SUCCESS_LOCATION, 'https://h/ui/_auth/login').pathname, '/ui/')

  // after logout: `login` from the logout route reaches the login page
  assert.equal(new URL(LOGOUT_LOCATION, 'https://h/_auth/logout').pathname, '/_auth/login')
  assert.equal(new URL(LOGOUT_LOCATION, 'https://h/ui/_auth/logout').pathname, '/ui/_auth/login')

  // index redirect: root and prefix
  assert.equal(new URL(INDEX_LOGIN_LOCATION, 'https://h/').pathname, '/_auth/login')
  assert.equal(new URL(INDEX_LOGIN_LOCATION, 'https://h/ui/').pathname, '/ui/_auth/login')
})

test('escapeHtml keeps request-controlled error text inert', () => {
  assert.equal(escapeHtml('<script>"x"&</script>'), '&lt;script&gt;&quot;x&quot;&amp;&lt;/script&gt;')
  const html = getLoginPage('zh-CN', '<script>alert(1)</script>')
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('the login page speaks Chinese by default and English on request', () => {
  const zh = getLoginPage()
  assert.match(zh, /<html lang="zh-CN">/)
  assert.match(zh, /请登录以继续/)
  assert.match(zh, /<label>用户名<\/label>/)
  assert.match(zh, /<label>密码<\/label>/)

  const en = getLoginPage('en')
  assert.match(en, /<html lang="en">/)
  assert.match(en, /Sign in to continue/)
  assert.match(en, /<label>Username<\/label>/)
  assert.match(en, /<label>Password<\/label>/)
  assert.match(en, />Sign in<\/button>/)
  assert.doesNotMatch(en, /请登录/)
})

test('the language switcher links to the other locale only', () => {
  const zh = getLoginPage('zh-CN')
  assert.match(zh, /href="\?lang=en"/)
  assert.doesNotMatch(zh, /href="\?lang=zh-CN"/)
  assert.match(zh, /aria-current="true">中文<\/span>/)

  const en = getLoginPage('en')
  assert.match(en, /href="\?lang=zh-CN"/)
  assert.match(en, /aria-current="true">English<\/span>/)
})

test('sessions carry their issue time and idle expiry', () => {
  const now = Date.now()
  const value = createSession(now)
  assert.equal(value.split('.').length, 3)

  const info = inspectSession(`dsh_session=${value}`, now)
  assert.ok(info)
  assert.equal(info.issuedAt, now)
  assert.equal(info.expiresAt, now + 24 * HOUR)
  assert.equal(info.remaining, 24 * HOUR)
})

test('tampering with either timestamp breaks the signature', () => {
  const now = Date.now()
  const [issuedAt, expiresAt, signature] = createSession(now).split('.')
  const shifted = `${issuedAt}.${Number(expiresAt) + HOUR}.${signature}`
  assert.equal(validateSession(`dsh_session=${shifted}`), false)
  const swapped = `${expiresAt}.${issuedAt}.${signature}`
  assert.equal(validateSession(`dsh_session=${swapped}`), false)
})

test('renewal slides the expiry but no more than once per step', () => {
  const now = Date.now()
  const info = inspectSession(`dsh_session=${createSession(now)}`)
  assert.ok(info)

  // Within the 5-minute step nothing is reissued, so a busy tab is silent.
  assert.equal(renewSession(info, now + 60 * 1000), undefined)

  const renewed = renewSession(info, now + 10 * 60 * 1000)
  assert.ok(renewed)
  assert.equal(renewed.expiresAt, now + 10 * 60 * 1000 + 24 * HOUR)
  assert.equal(validateSession(`dsh_session=${renewed.value}`), true)

  // The renewed token keeps the original login time, so the cap still holds.
  const renewedInfo = inspectSession(`dsh_session=${renewed.value}`, now + 10 * 60 * 1000)
  assert.equal(renewedInfo.issuedAt, now)

  // And the throttle restarts from the renewal, not from the login.
  assert.equal(renewSession(renewedInfo, now + 11 * 60 * 1000), undefined)
  assert.ok(renewSession(renewedInfo, now + 16 * 60 * 1000))
})

test('the absolute cap stops renewal even for an active session', () => {
  const previous = process.env.DSH_AUTH_MAX_DAYS
  // 0.02 day = 28.8 minutes, so a 24h idle window can never be reached.
  process.env.DSH_AUTH_MAX_DAYS = '0.02'
  try {
    const now = Date.now()
    const issued = now - 20 * 60 * 1000
    const info = inspectSession(`dsh_session=${createSession(issued)}`, now)
    assert.ok(info)
    assert.equal(info.expiresAt, issued + 0.02 * 24 * HOUR)

    // A renewal may only reach the cap, i.e. the expiry it already has.
    assert.equal(renewSession(info, now + 6 * 60 * 1000), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_AUTH_MAX_DAYS
    else process.env.DSH_AUTH_MAX_DAYS = previous
  }
})

test('tokens from the old signing scheme are rejected, not reinterpreted', () => {
  const now = Date.now()
  const expiresAt = now + 12 * HOUR
  // The pre-2.2.1 build derived the secret from the password hash; that shape
  // must now fail instead of authenticating anyone.
  const signature = 'a'.repeat(64)
  assert.equal(validateSession(`dsh_session=${expiresAt}.${signature}`), false)
})

test('issueSession reports the expiry it stamped, cap included', () => {
  const previous = process.env.DSH_AUTH_MAX_DAYS
  process.env.DSH_AUTH_MAX_DAYS = '0.02'
  try {
    const now = Date.now()
    const session = issueSession(now)
    assert.equal(session.expiresAt, now + 0.02 * 24 * HOUR)
    assert.equal(inspectSession(`dsh_session=${session.value}`, now).expiresAt, session.expiresAt)
  } finally {
    if (previous === undefined) delete process.env.DSH_AUTH_MAX_DAYS
    else process.env.DSH_AUTH_MAX_DAYS = previous
  }
})

test('the policy rejects a malformed override instead of silently defaulting', () => {
  const previous = process.env.DSH_AUTH_IDLE_HOURS
  process.env.DSH_AUTH_IDLE_HOURS = 'soon'
  try {
    assert.throws(() => getSessionPolicy(), /DSH_AUTH_IDLE_HOURS/)
  } finally {
    if (previous === undefined) delete process.env.DSH_AUTH_IDLE_HOURS
    else process.env.DSH_AUTH_IDLE_HOURS = previous
  }
})
