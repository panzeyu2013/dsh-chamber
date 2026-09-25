/**
 * Browser-side plugin read-face lockstep (design 21 §3 「单一定义」): the retained
 * settings-connections plugin READ face consumes the ONE manifest/refusal definition
 * from the neutral wire package through client-core's browser face — no local
 * re-declaration may exist here, and the retired plugin WRITE surface must not come
 * back (D1：写面退役，读面保留).
 *
 * Reference identity proves the face is a pass-through, not a copy; the source locks
 * pin control-plane.ts to the shared refusal vocabulary and keep every retired IPC
 * method name (apply/materialize/undo/npm search/local add) out of this package.
 *
 * Run directly: node packages/dsh-chamber-client-ui-settings-connections/test/plugin-management/plugin-manifest-lockstep.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  hasXWildcard as faceHasXWildcard,
  isMaterializedValue as faceIsMaterializedValue,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-manifest'
import {
  hasXWildcard as wireHasXWildcard,
  isMaterializedValue as wireIsMaterializedValue,
} from '../../../dsh-chamber-wire/src/plugin-manifest.ts'
// The retired write-face name set has ONE owner (the dead-export gate), which
// also scans every shipped surface; this suite keeps the local read-face lock.
import { RETIRED_PLUGIN_WRITE_FACE_NAMES } from '../../../../scripts/gates/verify-no-dead-exports.mjs'

test('client-core face is a pass-through: the same function objects as the wire source', () => {
  assert.equal(faceIsMaterializedValue, wireIsMaterializedValue)
  assert.equal(faceHasXWildcard, wireHasXWildcard)
})

test('hasXWildcard parity with the wire definition', () => {
  for (const value of ['x', '1.x', '1.2.x', '^1.x', '~2.x', 'v1.x', '1.2.3', 'latest', 'lexical']) {
    assert.equal(faceHasXWildcard(value), wireHasXWildcard(value), value)
  }
})

test('control-plane.ts consumes the shared manifest/refusal face and declares no local copy', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/client/control-plane.ts', import.meta.url)), 'utf8')
  assert.match(source, /from '@dsh-chamber\/dsh-chamber-client-core\/plugin-manifest'/,
    'the retained installed projection must import the single source through the browser face')
  assert.doesNotMatch(source, /export (?:type|interface) PluginProfileRefusalCode/,
    'the refusal-code vocabulary has ONE definition — the wire face')
  assert.doesNotMatch(source, /export (?:type|interface) PluginManifestModel/,
    'the manifest model has ONE definition — the wire face')
})

test('the retired plugin write IPC surface does not reappear in the read face', () => {
  // D1: every user-reachable plugin write surface was deleted; a wrapper that starts
  // calling one of these again is a regression, not a new feature. The name set is
  // the gate's single constant (also repo-scanned there).
  const retired = new RegExp(RETIRED_PLUGIN_WRITE_FACE_NAMES.join('|'))
  for (const rel of ['../../src/client/control-plane.ts', '../../src/client/PluginDialog.tsx']) {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, retired, `${rel} must not reference a retired plugin write IPC method`)
  }
})
