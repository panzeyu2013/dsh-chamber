/**
 * Copy boundary lock (design 08 §5.4, design 16 §7.2): every user-facing Git
 * string lives in the locale dictionaries, the zh/en pairs stay key-identical and
 * non-empty, and the client occupants' literal t('…') keys can never point at a
 * missing entry. The PR2 checkout row's new copy is pinned here too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { en, zh, type GitSidebarKey } from '../../src/locales.ts'

const CJK = /[\u4e00-\u9fff]/u

/** The client occupant/dialog sources that render localized copy. */
const CLIENT_SOURCES = [
  'SidebarWorkspaceGitLine.tsx',
  'CreateWorktreeDialog.tsx',
].map(name => stripComments(readFileSync(new URL('../../src/client/' + name, import.meta.url), 'utf8')))

/** Literal t('key') call sites (an identifier suffix such as set('x') is not a call). */
function literalKeys(source: string): string[] {
  return [...source.matchAll(/(?<![A-Za-z0-9_$.])t\('([A-Za-z0-9]+)'\)/gu)].map(match => match[1]!)
}

test('zh and en define exactly the same keys, all with non-empty copy', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys, 'the two dictionaries must stay key-identical')
  for (const key of zhKeys as GitSidebarKey[]) {
    assert.ok(zh[key].trim() !== '', 'zh.' + key + ' is empty')
    assert.ok(en[key].trim() !== '', 'en.' + key + ' is empty')
  }
})

test('the en dictionary never falls back to Chinese', () => {
  for (const key of Object.keys(en) as GitSidebarKey[]) {
    assert.doesNotMatch(en[key], CJK, 'en.' + key + ' carries Chinese')
  }
})

test('the PR2 checkout row actions have translated copy in both languages', () => {
  for (const key of [
    'checkoutNewSession',
    'checkoutNewSessionTitle',
    'checkoutCopyPath',
    'checkoutCopied',
    'checkoutFactsUnavailable',
    'checkoutLockedBadge',
    'checkoutDirtyBadge',
    'checkoutStatusUnknownBadge',
  ] as const) {
    assert.match(zh[key], CJK, 'zh.' + key + ' must be translated')
    assert.doesNotMatch(en[key], CJK, 'en.' + key + ' must not be Chinese')
  }
})

test('every literal t(…) key in the client occupants exists in BOTH dictionaries', () => {
  const keys = new Set<string>()
  for (const source of CLIENT_SOURCES) for (const key of literalKeys(source)) keys.add(key)
  assert.ok(keys.size >= 35, 'the client copy set must not collapse (got ' + keys.size + ')')
  for (const key of keys) {
    assert.ok(Object.hasOwn(zh, key), 'missing zh.' + key)
    assert.ok(Object.hasOwn(en, key), 'missing en.' + key)
  }
})
