import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import {
  MIN_PASSWORD_LENGTH,
  changePassword,
  clearInitialPassword,
  credentialFilePath,
  ensureCredentials,
  generatePassword,
  getSessionSecret,
  getUsername,
  initialPasswordFilePath,
  readCredentials,
  resetCredentials,
  verifyCredentials
} from '../src/credentials.js'
import { useTempHome } from './helpers.js'

/** Boot the store with a fixed password, as an upgraded deployment would. */
function seed(password = 'secret-password') {
  process.env.DSH_AUTH_USER = 'admin'
  process.env.DSH_AUTH_PASS = password
  const result = ensureCredentials()
  assert.equal(verifyCredentials('admin', password), true, 'seed must be verifiable')
  return result
}

test('a first start without DSH_AUTH_PASS generates a password instead of admin/admin', () => {
  useTempHome()
  delete process.env.DSH_AUTH_USER
  delete process.env.DSH_AUTH_PASS

  const result = ensureCredentials()

  assert.equal(result.status, 'generated')
  assert.equal(result.username, 'admin')
  assert.match(result.generatedPassword, /^[A-Za-z2-9]{20}$/)
  assert.equal(verifyCredentials('admin', result.generatedPassword), true)
  // The very bug this replaced: a guessable default must not authenticate.
  assert.equal(verifyCredentials('admin', 'admin'), false)

  // The plaintext lands in a 0600 sidecar file the operator can read.
  const sidecar = initialPasswordFilePath()
  assert.equal(result.initialPasswordFile, sidecar)
  assert.ok(existsSync(sidecar))
  assert.match(readFileSync(sidecar, 'utf8'), new RegExp(result.generatedPassword))
  assert.equal(statSync(sidecar).mode & 0o777, 0o600)
  // ... and never in the credential file itself.
  const raw = readFileSync(credentialFilePath(), 'utf8')
  assert.doesNotMatch(raw, new RegExp(result.generatedPassword))
  assert.match(raw, /scrypt\$/)
})

test('DSH_AUTH_PASS seeds the file once, then the file wins', () => {
  useTempHome()
  seed('env-password-1')

  // The operator changes the password through the panel, then an old unit file
  // restores DSH_AUTH_PASS: the stored password must win.
  assert.equal(changePassword('env-password-1', 'panel-password').ok, true)
  process.env.DSH_AUTH_PASS = 'env-password-1'
  const again = ensureCredentials()
  assert.equal(again.status, 'existing')
  assert.equal(again.envIgnored, true)
  assert.equal(verifyCredentials('admin', 'panel-password'), true)
  assert.equal(verifyCredentials('admin', 'env-password-1'), false)
})

test('credentials are stored as scrypt with a per-file salt', () => {
  useTempHome()
  seed()
  const first = readCredentials()
  assert.match(first.passwordHash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/)

  useTempHome()
  seed()
  const second = readCredentials()
  assert.notEqual(first.passwordHash, second.passwordHash, 'a fresh salt must be drawn')
})

test('verifyCredentials rejects a wrong username and a wrong password', () => {
  useTempHome()
  seed('correct-horse')
  assert.equal(verifyCredentials('admin', 'correct-horse'), true)
  assert.equal(verifyCredentials('admin', 'correct-horse '), false)
  assert.equal(verifyCredentials('root', 'correct-horse'), false)
  assert.equal(verifyCredentials('', ''), false)
})

test('changePassword enforces the minimum length and the old password', () => {
  useTempHome()
  seed('old-password')

  assert.deepEqual(changePassword('old-password', 'short'), { ok: false, reason: 'too-short' })
  assert.deepEqual(changePassword('wrong-password', 'brand-new-password'), {
    ok: false,
    reason: 'wrong-password'
  })
  assert.deepEqual(changePassword('', 'brand-new-password'), { ok: false, reason: 'empty' })
  assert.equal(verifyCredentials('admin', 'old-password'), true, 'a refused change must not apply')

  const result = changePassword('old-password', 'brand-new-password')
  assert.deepEqual(result, { ok: true, username: 'admin' })
  assert.equal(verifyCredentials('admin', 'brand-new-password'), true)
  assert.equal(verifyCredentials('admin', 'old-password'), false)
  assert.ok('brand-new-password'.length >= MIN_PASSWORD_LENGTH)
})

test('a password change rotates the session secret and deletes the sidecar file', () => {
  useTempHome()
  delete process.env.DSH_AUTH_PASS
  const bootstrap = ensureCredentials()
  assert.equal(bootstrap.status, 'generated')
  assert.ok(existsSync(initialPasswordFilePath()))

  const before = getSessionSecret()
  assert.equal(changePassword(bootstrap.generatedPassword, 'a-fresh-password').ok, true)
  assert.notEqual(getSessionSecret(), before, 'every issued cookie must die')
  assert.equal(existsSync(initialPasswordFilePath()), false)
})

test('resetCredentials rotates the secret and can rename the administrator', () => {
  useTempHome()
  seed('original-password')
  const before = getSessionSecret()

  const result = resetCredentials({ password: 'reset-password', username: 'alice' })

  assert.deepEqual(result, { username: 'alice', passwordChanged: true, usernameChanged: true })
  assert.equal(getUsername(), 'alice')
  assert.equal(verifyCredentials('alice', 'reset-password'), true)
  assert.equal(verifyCredentials('admin', 'reset-password'), false)
  assert.notEqual(getSessionSecret(), before)
})

test('resetCredentials refuses a short password and an empty username', () => {
  useTempHome()
  seed('original-password')
  assert.throws(() => resetCredentials({ password: 'short' }), /at least/)
  assert.throws(() => resetCredentials({ username: '  ' }), /username/)
})

test('a missing credential file cannot authenticate anybody', () => {
  useTempHome()
  assert.equal(verifyCredentials('admin', 'admin'), false)
  assert.equal(verifyCredentials('admin', ''), false)
  assert.throws(() => getSessionSecret(), /credential file missing/)
})

test('generatePassword avoids look-alike characters and is not repeated', () => {
  const passwords = new Set()
  for (let i = 0; i < 50; i += 1) {
    const value = generatePassword()
    assert.match(value, /^[A-HJ-NP-Za-km-z2-9]{20}$/)
    assert.doesNotMatch(value, /[0O1lI]/)
    passwords.add(value)
  }
  assert.equal(passwords.size, 50)
})

test('clearInitialPassword is safe when nothing was generated', () => {
  useTempHome()
  seed()
  assert.equal(existsSync(initialPasswordFilePath()), false)
  clearInitialPassword()
  assert.equal(existsSync(initialPasswordFilePath()), false)
})
