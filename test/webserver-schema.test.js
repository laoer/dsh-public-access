import assert from 'node:assert/strict'
import { isIP } from 'node:net'
import { test } from 'node:test'
import z from '@deepseek-ai/schemastery'
import {
  canonicalIpv6,
  lanHosts,
  normalizeBindHost,
  widenHostMember
} from '../src/webserver-schema.js'

/** A stand-in for the stock 0.2.1 webserver schema: concrete literals only. */
function stockSchema() {
  return z.object({
    host: z
      .transform(z.string(), (value) => {
        if (value === '0.0.0.0' || value === '::') {
          throw new Error('wildcard address rejected')
        }
        if (isIP(value) === 0) throw new Error('not an IP literal')
        return value
      })
      .required(),
    port: z.natural().required()
  })
}

test('widenHostMember accepts wildcard and literal hosts', () => {
  const schema = stockSchema()
  assert.throws(() => schema.dict.host('0.0.0.0'))
  assert.equal(widenHostMember(schema), true)
  assert.equal(schema.dict.host('0.0.0.0'), '0.0.0.0')
  assert.equal(schema.dict.host('::'), '::')
  assert.equal(schema.dict.host('192.168.1.5'), '192.168.1.5')
  assert.equal(schema.dict.host('fd00::1'), 'fd00::1')
  assert.throws(() => schema.dict.host('example.com'))
})

test('widenHostMember preserves the required meta', () => {
  const schema = stockSchema()
  widenHostMember(schema)
  assert.throws(() => schema.dict.host(undefined))
})

test('widenHostMember is idempotent', () => {
  const schema = stockSchema()
  assert.equal(widenHostMember(schema), true)
  const first = schema.dict.host
  assert.equal(widenHostMember(schema), true)
  assert.equal(schema.dict.host, first)
})

test('widenHostMember refuses an unusable schema', () => {
  assert.equal(widenHostMember({}), false)
  assert.equal(widenHostMember({ dict: {} }), false)
  assert.equal(widenHostMember({ dict: { host: 'not-a-schema' } }), false)
})

test('normalizeBindHost normalizes IPv6 and rejects unsupported values', () => {
  assert.equal(normalizeBindHost('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeBindHost('0.0.0.0'), '0.0.0.0')
  assert.equal(normalizeBindHost('192.168.1.5'), '192.168.1.5')
  assert.equal(normalizeBindHost('0:0:0:0:0:0:0:0'), '::')
  assert.equal(normalizeBindHost('[fd00:0:0:0:0:0:0:1]'), 'fd00::1')
  assert.throws(() => normalizeBindHost('example.com'))
  assert.throws(() => normalizeBindHost('fe80::1%eth0'))
  assert.throws(() => normalizeBindHost('::ffff:192.168.1.5'))
})

test('canonicalIpv6 canonicalizes and rejects non-literals', () => {
  assert.equal(canonicalIpv6('fd00:0:0:0:0:0:0:1'), 'fd00::1')
  assert.equal(canonicalIpv6('[::1]'), '::1')
  assert.equal(canonicalIpv6('192.168.1.5'), undefined)
  assert.equal(canonicalIpv6('example.com'), undefined)
})

const fakeInterfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }],
  eth1: [{ address: 'fd00:0:0:0:0:0:0:1', family: 'IPv6', internal: false }]
}

test('lanHosts mirrors the wildcard surface', () => {
  assert.deepEqual(lanHosts('127.0.0.1', fakeInterfaces), [])
  assert.deepEqual(lanHosts('0.0.0.0', fakeInterfaces), ['192.168.1.5'])
  assert.deepEqual(lanHosts('::', fakeInterfaces), ['192.168.1.5', '[fd00::1]'])
  assert.deepEqual(lanHosts('192.168.1.5', fakeInterfaces), ['192.168.1.5'])
  assert.deepEqual(lanHosts('fd00::1', fakeInterfaces), ['[fd00::1]'])
  assert.deepEqual(lanHosts(undefined, fakeInterfaces), [])
})
