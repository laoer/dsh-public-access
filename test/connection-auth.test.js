import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inherentlyCoveredPath, installConnectionAuth } from '../src/reverse-proxy-fix.js'

const SESSION = 'dsh_session=ok'
const validate = (cookie) => cookie === SESSION

function createConn({ trusted = true, withAdmit = true } = {}) {
  const browserPeer = { id: 'owner' }
  const calls = { admit: 0, index: 0 }
  const conn = {
    browserPeer,
    isTrusted: () => trusted,
    admit() {
      calls.admit += 1
      return { rejection: 401 }
    },
    authorizeIndex() {
      calls.index += 1
      return false
    },
    requestRejection() {
      return 401
    }
  }
  if (!withAdmit) delete conn.admit
  return { conn, calls, browserPeer }
}

function createRes() {
  return {
    status: undefined,
    headers: undefined,
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end() {
      this.ended = true
    }
  }
}

test('admit accepts a trusted plugin session as the owner peer', () => {
  const { conn, browserPeer, calls } = createConn()
  installConnectionAuth(conn, { validateSession: validate })
  assert.deepEqual(conn.admit({ headers: { cookie: SESSION } }), { peer: browserPeer })
  assert.equal(calls.admit, 0)
})

test('admit falls through for untrusted or unauthenticated requests', () => {
  const trusted = createConn()
  installConnectionAuth(trusted.conn, { validateSession: validate })
  assert.deepEqual(trusted.conn.admit({ headers: { cookie: SESSION } }), { peer: trusted.browserPeer })
  assert.deepEqual(trusted.conn.admit({ headers: {} }), { rejection: 401 })

  const untrusted = createConn({ trusted: false })
  installConnectionAuth(untrusted.conn, { validateSession: validate })
  assert.deepEqual(untrusted.conn.admit({ headers: { cookie: SESSION } }), { rejection: 401 })
  assert.equal(untrusted.calls.admit, 1)
})

test('authorizeIndex serves the index for a plugin session', () => {
  const { conn } = createConn()
  installConnectionAuth(conn, { validateSession: validate })
  assert.equal(conn.authorizeIndex({ headers: { cookie: SESSION }, url: '/' }, createRes()), true)
})

test('authorizeIndex redirects unauthenticated browsers to the login page', () => {
  const { conn } = createConn()
  installConnectionAuth(conn, { validateSession: validate })
  const res = createRes()
  assert.equal(conn.authorizeIndex({ headers: {}, url: '/' }, res), false)
  assert.equal(res.status, 302)
  assert.equal(res.headers.Location, './_auth/login')
  assert.equal(res.ended, true)
})

test('authorizeIndex hands launch-token requests to the native flow', () => {
  const { conn, calls } = createConn()
  installConnectionAuth(conn, { validateSession: validate })
  assert.equal(conn.authorizeIndex({ headers: {}, url: '/?token=abc' }, createRes()), false)
  assert.equal(calls.index, 1)
})

test('legacy versions patch requestRejection instead of admit', () => {
  const { conn } = createConn({ withAdmit: false })
  installConnectionAuth(conn, { validateSession: validate })
  assert.equal(conn.requestRejection({ headers: { cookie: SESSION } }), undefined)
  assert.equal(conn.requestRejection({ headers: {} }), 401)
})

test('DSH_AUTH_REQUIRE_SESSION makes the plugin session the only credential', () => {
  process.env.DSH_AUTH_REQUIRE_SESSION = '1'
  try {
    const { conn, browserPeer, calls } = createConn()
    installConnectionAuth(conn, { validateSession: validate })

    // A session still works, and still short-circuits the native gate.
    assert.deepEqual(conn.admit({ headers: { cookie: SESSION } }), { peer: browserPeer })
    assert.equal(calls.admit, 0)

    // Anything else is refused instead of falling through to the native
    // 30-day cookie / launch token.
    assert.deepEqual(conn.admit({ headers: {} }), { rejection: 401 })
    assert.equal(calls.admit, 0, 'the native gate must not be consulted')

    // The launch-token bootstrap no longer bypasses the login page.
    const res = createRes()
    assert.equal(conn.authorizeIndex({ headers: {}, url: '/?token=abc' }, res), false)
    assert.equal(res.status, 302)
    assert.equal(res.headers.Location, './_auth/login')
  } finally {
    delete process.env.DSH_AUTH_REQUIRE_SESSION
  }
})

test('the route diagnostic ignores paths dsh already gates or serves publicly', () => {
  // Covered by connection.admit / authorizeIndex / the launch-token exchange,
  // or public build artifacts: none of these belong in the warning.
  for (const path of ['/api', '/api/rpc', '/api*', '/connect', '/plugins', '/plugins/events']) {
    assert.equal(inherentlyCoveredPath(path), true, path)
  }
  // A third-party plugin route is the audience of the warning.
  for (const path of ['/open-in-app/open', '/im/webhook', '/pluginsx']) {
    assert.equal(inherentlyCoveredPath(path), false, path)
  }
})

test('installConnectionAuth fails loudly on an unknown connection shape', () => {
  assert.throws(() => installConnectionAuth(undefined), /auth gate not found/)
  assert.throws(
    () => installConnectionAuth({ admit() {}, authorizeIndex() {}, requestRejection() {} }),
    /browserPeer/
  )
})
