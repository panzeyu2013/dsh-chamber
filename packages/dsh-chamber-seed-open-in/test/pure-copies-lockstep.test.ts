/**
 * Pure-copy lockstep against the pinned upstream host half (registry
 * `seed.dsh-chamber-seed-open-in`: `icons.ts` / `resolver.ts` / `catalog.ts` are
 * unclassified ⇒ C1 classifies them PURE, i.e. the fork must carry the pinned
 * upstream bytes verbatim; only `index.ts` / `shared.ts` are patched).
 *
 * Why a package-local lock on top of C1: the registry gate runs at the pipeline
 * level, while this package's own suite must fail WHERE the drift is. A pin bump
 * that changes any of the three (alpha.1 changed `icons.ts` and `resolver.ts`;
 * alpha.1's host routes/auth change stayed out of `index.ts` on purpose — the
 * seed registers no webServer route, design 20 §4.1/§6.1) has to be replayed
 * consciously instead of leaving a stale copy that compiles.
 *
 * Missing vendor tree fails LOUDLY (repo convention); the explicit
 * `DSH_CHAMBER_VENDOR_ABSENT=skip` local-debug opt-out is the only skip.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripComments } from '../../../scripts/dev/test-support/source-text.ts'

/** The pinned vendor link tree (ensure-harness-vendor builds it). */
const VENDOR_PACKAGE = fileURLToPath(new URL(
  '../../../vendor/harness-packages/@deepseek-ai/dsh-host-open-in-app/src/', import.meta.url))
const PACKAGE_SRC = fileURLToPath(new URL('../src/', import.meta.url))
const MISSING = !existsSync(VENDOR_PACKAGE + 'catalog.ts')
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

const local = (name: string): string => readFileSync(PACKAGE_SRC + name, 'utf8')
const vendor = (name: string): string => readFileSync(VENDOR_PACKAGE + name, 'utf8')

const seeIt = (name: string, body: () => void): void => {
  test(name, { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages/@deepseek-ai/dsh-host-open-in-app is not materialized; '
        + 'this lock must stay loud (explicit DSH_CHAMBER_VENDOR_ABSENT=skip is the only skip)')
    }
    body()
  })
}

for (const file of ['catalog.ts', 'icons.ts', 'resolver.ts']) {
  seeIt('the pure copy ' + file + ' is byte-identical to the pinned upstream host half', () => {
    assert.equal(local(file), vendor(file),
      file + ' drifted from vendor/harness-packages/@deepseek-ai/dsh-host-open-in-app/src/' + file
      + ': replay the upstream file (it is classified PURE in the registry) or re-decide the classification')
  })
}

seeIt('the pinned host half is the alpha.1 shape this replay was made from', () => {
  // Negative control for a stale BOTH-sides-identical state (e.g. a local
  // checkout still on the previous pin): the alpha.1 marker strings must exist
  // on both sides.
  const icons = vendor('icons.ts')
  assert.match(icons, /catch \(_malformedPlist\)/u,
    'icons.ts must carry the alpha.1 plist-parse refactor (catch (_malformedPlist))')
  const resolver = vendor('resolver.ts')
  assert.match(resolver, /ELECTRON_RUN_AS_NODE/u,
    'resolver.ts must carry the alpha.1 inherited-Electron-env filter')
  assert.match(local('resolver.ts'), /ELECTRON_RUN_AS_NODE/u, 'the local resolver carries the same filter')
})

seeIt('the patched host entry registers no webServer route (route auth stays upstream-only)', () => {
  // alpha.1 moved the three open-in routes behind `auth: 'required'` + owner
  // Peer checks (tree-alpha1 host/open-in-app/src/index.ts). The chamber seed is
  // a typert Remote gateway with no webServer route at all (design 20 §4.1/
  // §6.1), so the route-trust hunk is deliberately NOT mirrored — this lock
  // keeps the deliberate divergence visible instead of letting a future replay
  // import route auth into a package that has no route to guard.
  const own = stripComments(local('index.ts'))
  assert.doesNotMatch(own, /webServer\.register/u, 'the seed must not grow a webServer route')
  assert.match(own, /TypertRemoteService/u, 'the seed stays a typert Remote gateway')
})
