/**
 * PluginDialog read-fence wiring drift (design 21 §6.2 读/写面共享栅栏, the §7
 * open item "客户端重试消费方未接线" — closed 2026-12).
 *
 * The gateway withholds `GET /chamber/plugins/installed` with 409
 * `runtime_busy` while a plugin mutation holds the managed-profile write lease.
 * The transport half (bounded retry + the typed `runtime_busy` arm) is covered
 * by control-plane.test.ts; the DIALOG is a React component this DOM-free suite
 * cannot render, so its half is pinned at the SOURCE level — the same lockstep
 * discipline as runtime-gate-wiring.test.ts. Each assertion is a regression
 * that was real:
 *
 * 1. `gatewayInstalled(gatewayId)` mapped only 404/500, so the fence's 409 fell
 *    through to the effect's `.catch` and rendered as the generic read error
 *    ("请求失败 409 …") — the busy state was reported as a failure.
 * 2. The effect registered no signal, so a reload/unmount could not stop a
 *    pending fence re-read.
 * 3. The `installed.ok === false` branch rendered profile_absent/profile_corrupt
 *    only; a new arm must render its own localized copy, not fall into the
 *    corrupted-profile banner.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(TEST_DIR, '..', 'src', 'client', 'PluginDialog.tsx'), 'utf8')

/** A source window around a marker (JSX call sites are matched in context). */
function window(marker: string, before = 900, after = 900): string {
  const index = source.indexOf(marker)
  assert.notEqual(index, -1, `PluginDialog.tsx no longer contains: ${marker}`)
  return source.slice(Math.max(0, index - before), index + after)
}

test('the installed read passes an abort signal and its cleanup aborts it', () => {
  const effect = window('gatewayInstalled(gatewayId, { signal: controller.signal })', 0, 500)
  assert.match(effect, /gatewayInstalled\(gatewayId, \{ signal: controller\.signal \}\)/u,
    'the fence re-read must be bound to the effect\'s controller')
  assert.match(source, /const controller = new AbortController\(\)/u,
    'the effect must own a controller')
  assert.match(source, /return \(\) => \{ cancelled = true; controller\.abort\(\) \}/u,
    'reload/unmount must abort the pending fence re-read — a discarded read fires no retry')
  assert.match(source, /setInstalledError\(errorMessage\(err\)\)/u,
    'genuine read failures keep their own error path (the fence must not be folded into it)')
})

test('the fence arm renders its own localized busy copy, never the read-error alert', () => {
  const arm = window("installed.code === 'runtime_busy'", 0, 1200)
  assert.match(arm, /gatewayReadFenceText\(installed\.refusalCode, 409, 'gatewayReadFencedBusy', t\)/u,
    'the busy arm is projected through the shared fence text helper (the classify*/serverRefusalText family)')
  // Warn-toned status banner — the profile_absent/profile_corrupt treatment —
  // NOT the red `css.error` + role="alert" the read failures render.
  assert.match(arm, /<p className=\{css\.pluginBanner\} role="status">\s*\{gatewayReadFenceText\(/u,
    'the busy copy renders as the zone banner with role="status"')
  assert.equal(/css\.error/u.test(arm), false,
    'the busy state is not the red error class the generic read failure uses')
})

test('the profile_absent/profile_corrupt copy stays reachable and distinct', () => {
  assert.match(source, /installed\.code === 'profile_absent' \? t\('profileAbsentBanner'\) : t\('profileCorruptBanner'\)/u,
    'the two readManifest codes keep their own banner copy')
  assert.ok(
    source.indexOf("installed.code === 'runtime_busy'") < source.indexOf("t('profileAbsentBanner')"),
    'the fence arm is decided BEFORE the profile codes, so a fenced read can never render as profile_corrupt',
  )
  assert.equal(
    /'runtime_busy'[\s\S]{0,400}profileCorruptBanner/u.test(source), false,
    'no branch may fold the fence arm into the corruption copy',
  )
})
