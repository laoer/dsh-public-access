import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createSession, validateSession } from '../src/auth.js'
import { ensureCredentials } from '../src/credentials.js'
import { apply } from '../src/reverse-proxy-fix.js'
import { useTempHome } from './helpers.js'

const routes = new Map()
const injectionHooks = []
let conn

function createConnection() {
  return {
    browserPeer: { id: 'owner' },
    isTrusted: () => true,
    admit: () => ({ rejection: 401 }),
    authorizeIndex: () => false,
    requestRejection: () => 401
  }
}

function createCtx() {
  return {
    webServer: {
      protocol: 'http:',
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      }
    },
    get: (name) => (name === 'connection' ? conn : undefined),
    effect: (fn) => fn(),
    on: (event, callback) => {
      if (event === 'webserver/index-inject') injectionHooks.push(callback)
    }
  }
}

function createRes() {
  return {
    status: undefined,
    headers: undefined,
    set: Object.create(null),
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    setHeader(name, value) {
      this.set[name] = value
    },
    end() {
      this.ended = true
    }
  }
}

/** A session minted far enough in the past that a renewal is due. */
function dueSession() {
  return createSession(Date.now() - 10 * 60 * 1000)
}

before(() => {
  useTempHome()
  process.env.DSH_AUTH_USER = 'admin'
  process.env.DSH_AUTH_PASS = 'secret'
  delete process.env.DSH_AUTH_SALT
  ensureCredentials()
  conn = createConnection()
  apply(createCtx())
})

test('apply registers the renewal route and injects the heartbeat', () => {
  assert.ok(routes.has('/_auth/renew'))

  const table = []
  for (const hook of injectionHooks) hook(table)
  const script = table.filter((row) => row.kind === 'script').map((row) => row.text).join('\n')
  assert.match(script, /_auth\/renew/)
  assert.match(script, /x-dsh-renew/)
  assert.match(script, /setInterval/)
})

test('renew slides a due session and returns a valid cookie', () => {
  const res = createRes()
  routes.get('/_auth/renew').handler(
    {
      method: 'POST',
      headers: { cookie: `dsh_session=${dueSession()}`, 'x-dsh-renew': '1' }
    },
    res
  )
  assert.equal(res.status, 204)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  const cookie = res.headers['Set-Cookie']
  assert.match(cookie, /^dsh_session=\d+\.\d+\.[a-f0-9]+;/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.doesNotMatch(cookie, /Secure/)

  const value = cookie.slice('dsh_session='.length, cookie.indexOf(';'))
  assert.equal(validateSession(`dsh_session=${value}`), true)
  assert.equal(res.ended, true)
})

test('renew leaves a freshly issued session alone', () => {
  const res = createRes()
  routes.get('/_auth/renew').handler(
    {
      method: 'POST',
      headers: { cookie: `dsh_session=${createSession()}`, 'x-dsh-renew': '1' }
    },
    res
  )
  assert.equal(res.status, 204)
  assert.equal(res.headers['Set-Cookie'], undefined)
})

test('renew refuses a missing, expired, or forged session', () => {
  for (const cookie of [undefined, 'dsh_session=1.2.3', 'dsh_session=999.abc']) {
    const res = createRes()
    routes.get('/_auth/renew').handler(
      { method: 'POST', headers: { cookie, 'x-dsh-renew': '1' } },
      res
    )
    assert.equal(res.status, 401)
    assert.equal(res.headers['Set-Cookie'], undefined)
  }
})

test('renew refuses requests the heartbeat did not send', () => {
  const noHeader = createRes()
  routes.get('/_auth/renew').handler(
    { method: 'POST', headers: { cookie: `dsh_session=${dueSession()}` } },
    noHeader
  )
  assert.equal(noHeader.status, 403)

  const crossSite = createRes()
  routes.get('/_auth/renew').handler(
    {
      method: 'POST',
      headers: { cookie: `dsh_session=${dueSession()}`, 'x-dsh-renew': '1', 'sec-fetch-site': 'cross-site' }
    },
    crossSite
  )
  assert.equal(crossSite.status, 403)
})

test('renew only answers POST', () => {
  const res = createRes()
  routes.get('/_auth/renew').handler({ method: 'GET', headers: { 'x-dsh-renew': '1' } }, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.Allow, 'POST')
})

test('an index load renews through the connection gate', () => {
  const res = createRes()
  const authorized = conn.authorizeIndex(
    { headers: { cookie: `dsh_session=${dueSession()}` }, url: '/' },
    res
  )
  assert.equal(authorized, true)
  assert.match(res.set['Set-Cookie'], /^dsh_session=\d+\.\d+\.[a-f0-9]+;/)
})
