import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_LOCALE,
  configuredLocale,
  cookieLocale,
  fromAcceptLanguage,
  parseLocale,
  resolveLocale
} from '../src/login-i18n.js'

test('parseLocale maps supported tags and rejects everything else', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-cn', 'zh-Hans', 'ZH-Hant-TW']) {
    assert.equal(parseLocale(tag), 'zh-CN', tag)
  }
  for (const tag of ['en', 'en-US', 'EN-gb']) {
    assert.equal(parseLocale(tag), 'en', tag)
  }
  for (const tag of ['fr', 'de-DE', '', '   ', undefined, null, 'english']) {
    assert.equal(parseLocale(tag), undefined, String(tag))
  }
})

test('Accept-Language picks the first supported tag and honours q=0', () => {
  assert.equal(fromAcceptLanguage('en-US,en;q=0.9,zh-CN;q=0.8'), 'en')
  assert.equal(fromAcceptLanguage('fr-FR,fr;q=0.9,zh-CN;q=0.8'), 'zh-CN')
  assert.equal(fromAcceptLanguage('fr,de'), undefined)
  assert.equal(fromAcceptLanguage('en;q=0'), undefined)
  assert.equal(fromAcceptLanguage('en;q=0, zh-CN;q=0.5'), 'zh-CN')
  assert.equal(fromAcceptLanguage(undefined), undefined)
})

test('the language cookie is read strictly by name', () => {
  assert.equal(cookieLocale('theme=dark; dsh_lang=en; other=1'), 'en')
  assert.equal(cookieLocale('dsh_lang=zh-CN'), 'zh-CN')
  assert.equal(cookieLocale('dsh_language=en'), undefined)
  assert.equal(cookieLocale(undefined), undefined)
})

test('an explicit pick beats the cookie, which beats the header', () => {
  assert.equal(resolveLocale({ lang: 'zh-CN', cookieHeader: 'dsh_lang=en' }), 'zh-CN')
  assert.equal(
    resolveLocale({ cookieHeader: 'dsh_lang=en', acceptLanguage: 'zh-CN,zh;q=0.9' }),
    'en'
  )
  assert.equal(resolveLocale({ acceptLanguage: 'en-US,en;q=0.9' }), 'en')
  assert.equal(resolveLocale({}), DEFAULT_LOCALE)
})

test('DSH_AUTH_LANG is the deployment default and must be valid', () => {
  const previous = process.env.DSH_AUTH_LANG
  try {
    delete process.env.DSH_AUTH_LANG
    assert.equal(configuredLocale(), undefined)
    assert.equal(resolveLocale({ acceptLanguage: 'en-US' }), 'en')

    process.env.DSH_AUTH_LANG = 'en'
    assert.equal(configuredLocale(), 'en')
    assert.equal(resolveLocale({ acceptLanguage: 'zh-CN' }), 'en')
    // A remembered pick still wins over the deployment default.
    assert.equal(resolveLocale({ cookieHeader: 'dsh_lang=zh-CN' }), 'zh-CN')

    process.env.DSH_AUTH_LANG = 'klingon'
    assert.throws(() => configuredLocale(), /DSH_AUTH_LANG/)
    assert.throws(() => resolveLocale({}), /DSH_AUTH_LANG/)
  } finally {
    if (previous === undefined) delete process.env.DSH_AUTH_LANG
    else process.env.DSH_AUTH_LANG = previous
  }
})
