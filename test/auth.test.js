import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createSession, escapeHtml, getLoginPage, validateLogin, validateSession } from '../src/auth.js'
import {
  INDEX_LOGIN_LOCATION,
  LOGIN_SUCCESS_LOCATION,
  LOGOUT_LOCATION
} from '../src/reverse-proxy-fix.js'

before(() => {
  process.env.DSH_AUTH_USER = 'admin'
  process.env.DSH_AUTH_PASS = 'secret'
  process.env.DSH_AUTH_SALT = 'test-salt'
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
  const html = getLoginPage('<script>alert(1)</script>')
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})
