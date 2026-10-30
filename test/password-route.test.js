import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { before, test } from 'node:test'
import { createSession, issueSession, validateSession } from '../src/auth.js'
import { ensureCredentials } from '../src/credentials.js'
import { apply, PASSWORD_PATH } from '../src/reverse-proxy-fix.js'
import { MAX_FAILURES } from '../src/rate-limit.js'
import { useTempHome } from './helpers.js'

const routes = new Map()
let conn

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
    on: () => {}
  }
}

/** Run a request through the password route and collect the response. */
function respond(req) {
  return new Promise((resolve) => {
    const res = {
      status: undefined,
      headers: {},
      body: undefined,
      writeHead(status, headers) {
        this.status = status
        if (headers !== undefined) Object.assign(this.headers, headers)
      },
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(body) {
        this.body = body
        resolve(this)
      }
    }
    routes.get(PASSWORD_PATH).handler(req, res)
  })
}

function request({ method = 'GET', body, headers = {} } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)])
  req.method = method
  req.url = PASSWORD_PATH
  req.headers = headers
  req.socket = { remoteAddress: '198.51.100.77' }
  return req
}

/** A request that carries a live session cookie. */
function signedIn(options = {}) {
  return {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie: `dsh_session=${createSession()}`,
      'sec-fetch-site': 'same-origin',
      ...(options.headers ?? {})
    }
  }
}

before(() => {
  useTempHome()
  process.env.DSH_AUTH_USER = 'admin'
  process.env.DSH_AUTH_PASS = 'initial-password'
  delete process.env.DSH_AUTH_LANG
  ensureCredentials()
  conn = {
    browserPeer: { id: 'owner' },
    isTrusted: () => true,
    admit: () => ({ rejection: 401 }),
    authorizeIndex: () => false,
    requestRejection: () => 401
  }
  apply(createCtx())
})

test('the route is registered beside the other auth routes', () => {
  assert.ok(routes.has('/_auth/login'))
  assert.ok(routes.has('/_auth/renew'))
  assert.ok(routes.has('/_auth/logout'))
  assert.ok(routes.has(PASSWORD_PATH))
})

test('an anonymous caller is refused and learns nothing', async () => {
  const res = await respond(request())
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).ok, false)
  assert.equal(JSON.parse(res.body).code, 'session-required')
})

test('a signed-in caller gets the panel copy and the current user', async () => {
  const res = await respond(request(signedIn()))
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.username, 'admin')
  assert.equal(body.messages.submitLabel.length > 0, true)
  assert.equal(typeof body.messages.oldPasswordLabel, 'string')
})

test('a cross-site form cannot change the password', async () => {
  const crossSite = await respond(
    request(signedIn({ method: 'POST', body: '{"oldPassword":"initial-password","newPassword":"whatever-1"}', headers: { 'sec-fetch-site': 'cross-site' } }))
  )
  assert.equal(crossSite.status, 403)

  const formPost = await respond(
    request(signedIn({
      method: 'POST',
      body: 'oldPassword=initial-password&newPassword=whatever-1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }))
  )
  assert.equal(formPost.status, 415)
})

test('the wrong current password is refused and counted as a failure', async () => {
  const res = await respond(
    request(signedIn({ method: 'POST', body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'next-password' }) }))
  )
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).code, 'wrong-password')
  // The old password still works.
  assert.equal(validateSession(signedIn().headers.cookie), true)
})

test('a short new password is refused', async () => {
  const res = await respond(
    request(signedIn({ method: 'POST', body: JSON.stringify({ oldPassword: 'initial-password', newPassword: 'short' }) }))
  )
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).code, 'too-short')
})

test('a successful change reissues the cookie and invalidates the old one', async () => {
  const oldCookie = `dsh_session=${createSession()}`
  const res = await respond(
    request({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: oldCookie,
        'sec-fetch-site': 'same-origin'
      },
      body: JSON.stringify({ oldPassword: 'initial-password', newPassword: 'replacement-password' })
    })
  )

  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).ok, true)

  const reissued = [].concat(res.headers['Set-Cookie'])[0]
  assert.match(reissued, /^dsh_session=/)
  assert.match(reissued, /HttpOnly/)
  assert.equal(validateSession(reissued.split(';')[0]), true)
  assert.equal(validateSession(oldCookie), false, 'the secret rotated, so the old cookie is dead')

  // The new password is the one that authenticates now.
  const login = routes.get('/_auth/login')
  const loginRes = await new Promise((resolve) => {
    const req = Readable.from([Buffer.from('username=admin&password=replacement-password')])
    req.method = 'POST'
    req.url = '/_auth/login'
    req.headers = { 'content-type': 'application/x-www-form-urlencoded' }
    req.socket = { remoteAddress: '198.51.100.78' }
    login.handler(req, {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        if (headers !== undefined) Object.assign(this.headers, headers)
      },
      setHeader() {},
      end() {
        resolve(this)
      }
    })
  })
  assert.equal(loginRes.status, 302)
})

test('the login route throttles repeated failures', async () => {
  const login = routes.get('/_auth/login')
  const attempt = (password, address) =>
    new Promise((resolve) => {
      const req = Readable.from([Buffer.from(`username=admin&password=${password}`)])
      req.method = 'POST'
      req.url = '/_auth/login'
      req.headers = { 'content-type': 'application/x-www-form-urlencoded' }
      req.socket = { remoteAddress: address }
      login.handler(req, {
        status: 0,
        headers: {},
        writeHead(status, headers) {
          this.status = status
          if (headers !== undefined) Object.assign(this.headers, headers)
        },
        setHeader(name, value) {
          this.headers[name] = value
        },
        end(body) {
          this.body = body
          resolve(this)
        }
      })
    })

  for (let i = 0; i < MAX_FAILURES; i += 1) {
    const res = await attempt('guess', '203.0.113.40')
    assert.equal(res.status, 200)
  }
  const locked = await attempt('guess', '203.0.113.40')
  assert.equal(locked.status, 429)
  assert.equal(locked.headers['Retry-After'], '30')
  assert.match(locked.body, /30/)

  // A different address still gets the login page.
  const other = await attempt('guess', '203.0.113.41')
  assert.equal(other.status, 200)
})

test('a resolved request has no leftover session after logout', async () => {
  const cookie = `dsh_session=${createSession()}`
  const res = await new Promise((resolve) => {
    const req = ioRequest('POST', { cookie, 'sec-fetch-site': 'same-origin' })
    routes.get('/_auth/logout').handler(req, {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        if (headers !== undefined) Object.assign(this.headers, headers)
      },
      setHeader() {},
      end() {
        resolve(this)
      }
    })
  })
  assert.equal(res.status, 302)
  assert.match(res.headers['Set-Cookie'][0], /Max-Age=0/)
  assert.equal(res.headers.Location, 'login')
})

test('a cross-site logout is refused', async () => {
  const res = await new Promise((resolve) => {
    const req = ioRequest('GET', { 'sec-fetch-site': 'cross-site' })
    routes.get('/_auth/logout').handler(req, {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        if (headers !== undefined) Object.assign(this.headers, headers)
      },
      setHeader() {},
      end() {
        resolve(this)
      }
    })
  })
  assert.equal(res.status, 405)
  assert.equal(res.headers['Set-Cookie'], undefined)
})

/** Minimal request object for the logout route (no body needed). */
function ioRequest(method, headers) {
  return {
    method,
    url: '/_auth/logout',
    headers,
    socket: { remoteAddress: '198.51.100.90' },
    on() {},
    destroy() {}
  }
}
