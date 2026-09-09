/**
 * Base-plugin ↔ composite-covered lockstep (2026-12).
 *
 * THE INVARIANT: every id the settings child context mounts as a BASE plugin
 * must be in the renderer composite's `CHAMBER_COVERED_IDS`. If one is not, the
 * source's own graph would deliver that package as an EXTENSION row too, and the
 * same package would be mounted twice on one cordis context (duplicate
 * service/slot registration → the plugin is reported failed for no reason).
 *
 * This test is the mechanical guard behind design 05 §5's documented invariant
 * ("每个基础 id 必须 ∈ CHAMBER_COVERED_IDS").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_PRESET_ID, BASE_PLUGIN_IDS, RUNTIME_SECTION_ID, isBasePluginId } from '../src/client/base-plugins.ts'
import { CHAMBER_COVERED_IDS } from '../../renderer/src/chamber-covered.ts'

test('every BASE plugin id is composite-covered (no double mount on one child ctx)', () => {
  const covered = new Set(CHAMBER_COVERED_IDS)
  const missing = BASE_PLUGIN_IDS.filter((id) => {
    // The chamber-owned pseudo-ids are not packages: they can never arrive as a
    // graph row, so they need no coverage entry.
    if (id === RUNTIME_SECTION_ID || id === 'root') return false
    return !covered.has(id)
  })
  assert.deepEqual(missing, [], `base plugin id(s) missing from CHAMBER_COVERED_IDS: ${missing.join(', ')}`)
})

test('the pure base list carries the lazy + pseudo ids the assembly needs', () => {
  assert.equal(BASE_PLUGIN_IDS.includes(AGENT_PRESET_ID), true)
  assert.equal(BASE_PLUGIN_IDS.includes(RUNTIME_SECTION_ID), true)
  assert.equal(new Set(BASE_PLUGIN_IDS).size, BASE_PLUGIN_IDS.length, 'no duplicate ids')
  assert.equal(isBasePluginId(AGENT_PRESET_ID), true)
  assert.equal(isBasePluginId('@scope/third-party-plugin'), false)
})
