import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * The browser half is a classic script that registers itself with the
 * harness's module loader. This test installs a fake loader and a fake React,
 * then checks the contract the harness relies on:
 *
 * - the factory id equals the package name (the loader keys modules by it);
 * - `apply` + `inject: ['slots']` are returned;
 * - applying registers exactly one `settings.section` entry with our id.
 *
 * It deliberately does not render: the harness supplies React, and a throw
 * here would catch a registration bug without a browser.
 */

/** Minimal React stand-in: enough to build elements, never to render them. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn
}

/** Distinguishes module instances so each test re-executes the classic script. */
let loadCount = 0

/** Capture what the bundle does at load time. */
function loadBundle() {
  const registrations = []
  const injections = []
  const loads = []

  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loads.push(spec)
      }
    },
    location: { href: 'http://127.0.0.1:3080/', reload() {} }
  }
  globalThis.document = { cookie: '', documentElement: { lang: 'en' } }

  const path = new URL('../src/client/index.js', import.meta.url)
  loadCount += 1
  return import(`${path.href}?v=${loadCount}`).then(() => ({ loads, registrations, injections }))
}

/** The last loaded spec's exports, materialized as the loader would. */
function materialize(loads, requireImpl) {
  const spec = loads.at(-1)
  return spec.factory(requireImpl)
}

test('the artifact parses as a classic script, not an ES module', () => {
  // `node --check` parses the file the way a <script> tag would. A stray
  // `export {}` (which tsc adds under moduleDetection: auto) fails here, and
  // the harness's loader would fail the same way at boot.
  const file = fileURLToPath(new URL('../src/client/index.js', import.meta.url))
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
})

test('the bundle registers one factory under the package name', async () => {
  const { loads } = await loadBundle()
  assert.equal(loads.length, 1)
  assert.equal(loads[0].id, '@timgong/dsh-public-access')
  assert.equal(typeof loads[0].factory, 'function')
})

test('the factory asks only for react and exposes apply/inject', async () => {
  const { loads } = await loadBundle()
  const required = []
  const exports = materialize(loads, (id) => {
    required.push(id)
    return React
  })

  assert.deepEqual(required, ['react'], 'no other module may be required')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers the auth section and waits for the slot declaration', async () => {
  const { loads } = await loadBundle()
  const exports = materialize(loads, () => React)

  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(name, callback) {
        injections.push(name)
        callback()
        return () => {}
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      }
    }
  }

  exports.apply(ctx)

  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].spec.name, 'settings.section')
  assert.equal(registrations[0].spec.id, 'auth')
  assert.equal(typeof registrations[0].spec.order, 'number')
  assert.equal(typeof registrations[0].component, 'function')
})

test('the nav label follows the dsh_lang cookie', async () => {
  const { loads } = await loadBundle()
  const exports = materialize(loads, () => React)

  const registrations = []
  const ctx = {
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(spec) {
        registrations.push(spec)
      }
    }
  }
  exports.apply(ctx)
  const label = registrations[0].label

  assert.equal(label(), 'Auth')
  globalThis.document.cookie = 'dsh_lang=zh-CN'
  assert.equal(label(), '认证')
  globalThis.document.cookie = 'theme=dark; dsh_lang=en'
  assert.equal(label(), 'Auth')
})

test('the section renders a password form from the server copy', async () => {
  const { loads } = await loadBundle()
  const exports = materialize(loads, () => React)

  const registrations = []
  exports.apply({
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(spec, component) {
        registrations.push({ spec, component })
      }
    }
  })

  const Section = registrations[0].component
  const tree = Section({})
  const flat = JSON.stringify(tree)
  // The fallback copy is what renders before the state request resolves.
  assert.match(flat, /Administrator sign-in/)
  assert.match(flat, /Current password/)
  assert.match(flat, /Change password/)
})
