import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePublicUrl } from '../src/public-url.js'

test('parsePublicUrl normalizes the trailing slash', () => {
  assert.equal(parsePublicUrl('https://app.example/ui').href, 'https://app.example/ui/')
  assert.equal(parsePublicUrl('http://127.0.0.1:3080').href, 'http://127.0.0.1:3080/')
  assert.equal(parsePublicUrl('https://app.example/').href, 'https://app.example/')
})

test('parsePublicUrl rejects unusable roots', () => {
  for (const value of [
    'app.example',
    'ftp://app.example/',
    'https://app.example/?x=1',
    'https://app.example/#frag',
    'https://user:pass@app.example/',
    'https:///ui',
    'https://',
    'https://app.example/a b'
  ]) {
    assert.throws(() => parsePublicUrl(value), undefined, value)
  }
})
