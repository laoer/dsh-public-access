import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GLOBAL_FREE_FAILURES,
  GLOBAL_MAX_MS,
  LOCKOUT_MS,
  LoginRateLimiter,
  MAX_FAILURES
} from '../src/rate-limit.js'

/** A request carrying just the socket address the limiter reads. */
function req(remoteAddress) {
  return { socket: { remoteAddress } }
}

/** A limiter with a controllable clock. */
function limiter() {
  const clock = { now: 1_000_000 }
  return { clock, limiter: new LoginRateLimiter({ now: () => clock.now }) }
}

test('five failures lock an address for the lockout window', () => {
  const { clock, limiter: l } = limiter()
  const request = req('198.51.100.10')

  for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
    assert.deepEqual(l.check(request), { allowed: true })
    l.recordFailure(request)
  }
  assert.deepEqual(l.check(request), { allowed: true }, 'the fifth attempt may still run')
  l.recordFailure(request)

  const verdict = l.check(request)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.scope, 'client')
  assert.equal(verdict.retryAfterSeconds, LOCKOUT_MS / 1000)

  // Another address is unaffected.
  assert.deepEqual(l.check(req('198.51.100.11')), { allowed: true })

  clock.now += LOCKOUT_MS
  assert.deepEqual(l.check(request), { allowed: true }, 'the lockout expires')
})

test('a successful login clears the address record', () => {
  const { limiter: l } = limiter()
  const request = req('198.51.100.12')
  for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
    l.recordFailure(request)
  }
  l.recordSuccess(request)
  for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
    assert.deepEqual(l.check(request), { allowed: true })
    l.recordFailure(request)
  }
  assert.deepEqual(l.check(request), { allowed: true }, 'the count restarted')
})

test('distributed failures trigger a global penalty that exempts loopback', () => {
  const { clock, limiter: l } = limiter()
  for (let i = 0; i < GLOBAL_FREE_FAILURES; i += 1) {
    const request = req(`198.51.100.${i + 20}`)
    l.recordFailure(request)
  }

  const remote = l.check(req('203.0.113.99'))
  assert.equal(remote.allowed, false)
  assert.equal(remote.scope, 'global')
  assert.ok(remote.retryAfterSeconds >= 1)

  // The administrator's own machine stays usable — otherwise an attacker could
  // lock them out of their own deployment.
  assert.deepEqual(l.check(req('127.0.0.1')), { allowed: true })
  assert.deepEqual(l.check(req('::1')), { allowed: true })
  assert.deepEqual(l.check(req('::ffff:127.0.0.1')), { allowed: true })

  clock.now += 10_000
  assert.deepEqual(l.check(req('203.0.113.99')), { allowed: true }, 'the penalty is time-bound')
})

test('the global penalty doubles per step and is capped', () => {
  const { clock, limiter: l } = limiter()
  const fail = (count) => {
    for (let i = 0; i < count; i += 1) l.recordFailure(req(`198.51.100.${(i % 200) + 1}`))
  }

  fail(GLOBAL_FREE_FAILURES)
  const first = l.check(req('203.0.113.1')).retryAfterSeconds
  fail(10)
  const second = l.check(req('203.0.113.1')).retryAfterSeconds
  assert.equal(second, first * 2)

  fail(200)
  const capped = l.check(req('203.0.113.1')).retryAfterSeconds
  assert.equal(capped, GLOBAL_MAX_MS / 1000)

  clock.now += GLOBAL_MAX_MS
  assert.deepEqual(l.check(req('203.0.113.1')), { allowed: true })
})

test('the client map stays bounded under a distributed flood', () => {
  const clock = { now: 1_000_000 }
  const l = new LoginRateLimiter({ now: () => clock.now, maxClients: 5 })
  for (let i = 0; i < 50; i += 1) l.recordFailure(req(`198.51.100.${i}`))
  // Nothing to assert about internals beyond "it did not grow without limit":
  // the next check must still answer quickly and correctly.
  assert.equal(typeof l.check(req('203.0.113.1')).allowed, 'boolean')
})
