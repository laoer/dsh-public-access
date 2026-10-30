import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { before, test } from 'node:test'
import { apply } from '../src/reverse-proxy-fix.js'

const routes = new Map()
const state = { trusted: true }
let conn

function createConnection() {
  return {
    browserPeer: { id: 'owner' },
    isTrusted: () => state.trusted,
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
    on: () => {}
  }
}

/** Resolve once the handler has ended the response. */
function respond(req) {
  return new Promise((resolve) => {
    const res = {
      status: undefined,
      headers: undefined,
      body: undefined,
      ended: false,
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      setHeader() {},
      end(body) {
        this.body = body
        this.ended = true
        resolve(this)
      }
    }
    routes.get('/_auth/login').handler(req, res)
  })
}

function get(headers = {}, url = '/_auth/login') {
  return respond({ method: 'GET', url, headers })
}

function post(body, headers = {}) {
  const req = Readable.from([Buffer.from(body)])
  req.method = 'POST'
  req.url = '/_auth/login'
  req.headers = { 'content-type': 'application/x-www-form-urlencoded', ...headers }
  return respond(req)
}

before(() => {
  process.env.DSH_AUTH_USER = 'admin'
  process.env.DSH_AUTH_PASS = 'secret'
  process.env.DSH_AUTH_SALT = 'test-salt'
  delete process.env.DSH_AUTH_LANG
  conn = createConnection()
  apply(createCtx())
})

test('the login page follows Accept-Language and sets no cookie', async () => {
  const res = await get({ 'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8' })
  assert.equal(res.status, 200)
  assert.match(res.body, /<html lang="en">/)
  assert.match(res.body, /Sign in to continue/)
  assert.equal(res.headers['Set-Cookie'], undefined)
})

test('?lang= renders that locale and remembers the pick', async () => {
  const res = await get({}, '/_auth/login?lang=en')
  assert.equal(res.status, 200)
  assert.match(res.body, /Sign in to continue/)
  assert.match(res.headers['Set-Cookie'], /^dsh_lang=en; Path=\/; SameSite=Lax; Max-Age=31536000/)
  assert.doesNotMatch(res.headers['Set-Cookie'], /Secure/)
})

test('the remembered pick beats the browser preference', async () => {
  const res = await get({ cookie: 'dsh_lang=en', 'accept-language': 'zh-CN,zh;q=0.9' })
  assert.match(res.body, /Sign in to continue/)
  assert.equal(res.headers['Set-Cookie'], undefined)
})

test('login errors are localized', async () => {
  const en = await post('username=admin&password=wrong', { cookie: 'dsh_lang=en' })
  assert.equal(en.status, 200)
  assert.match(en.body, /Incorrect username or password/)

  const zh = await post('username=admin&password=wrong')
  assert.equal(zh.status, 200)
  assert.match(zh.body, /用户名或密码错误/)
})

test('the untrusted-host page is localized too', async () => {
  state.trusted = false
  try {
    const res = await post('username=admin&password=secret', {
      host: 'evil.example',
      'accept-language': 'en'
    })
    assert.equal(res.status, 403)
    assert.match(res.body, /Host evil\.example is not trusted/)
    assert.doesNotMatch(res.body, /未被信任/)
  } finally {
    state.trusted = true
  }
})

test('a successful login still redirects regardless of locale', async () => {
  const res = await post('username=admin&password=secret', { cookie: 'dsh_lang=en' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.Location, '../')
  assert.match(res.headers['Set-Cookie'], /^dsh_session=\d+\.\d+\.[a-f0-9]+;/)
})
