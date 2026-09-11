/**
 * Wiring contract for the boot-time early-open arm inside the sidebar plugin
 * (design 05 §2.2 revision 2026-12; 2026-12 field report problem 1).
 *
 * Source-text contract (the sidebar package's `producer-purged-wiring.test.ts`
 * pattern): `client/index.ts` is a cordis plugin body that cannot be imported by
 * a node test without a full client ctx. The arm's BEHAVIOUR is covered by
 * `early-open.test.ts` and the shared rules by `open-intent.test.ts`; this file
 * pins the three links that would silently disable the preemption:
 *
 * 1. the arm is started inside a `ctx.effect` (so ctx teardown disposes it — an
 *    arm outliving its ctx could open a session in a dead shell);
 * 2. the intent is read LIVE from the shared slot, not captured at apply time
 *    (a captured value would open whatever was pending when the ctx mounted);
 * 3. the open goes through THIS ctx's own `sessions.open` (a detached reference
 *    or a page-global open would target the wrong instance).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('the plugin starts the arm inside a ctx.effect, bound to its own instance id', () => {
  const plugin = read('../src/client/index.ts')
  const effectIndex = plugin.indexOf("}, 'dsh-chamber: boot-time session open intent')")
  assert.notEqual(effectIndex, -1, 'the arm must be a dedicated ctx effect')
  const body = plugin.slice(plugin.lastIndexOf('ctx.effect(() => {', effectIndex), effectIndex)
  assert.match(body, /const chamberInstanceId = \(ctx as any\)\.chamberInstanceId as string \| undefined/)
  assert.match(body, /if \(typeof chamberInstanceId !== 'string' \|\| chamberInstanceId === ''\) return \(\) => \{\}/, 'a non-chamber boot must not arm')
  assert.match(body, /return startEarlyOpenArm\(\{/)
  assert.match(body, /instanceId: chamberInstanceId,/)
})

test('the arm reads the LIVE intent and opens through this ctx own sessions service', () => {
  const plugin = read('../src/client/index.ts')
  assert.match(
    plugin,
    /readIntent: \(\) => getOpenIntent\(chamberInstanceId\)/,
    'the intent must be read at attempt time — a captured value would open a stale request',
  )
  assert.match(
    plugin,
    /open: \(sessionId\) => \{ ctx\.sessions\.open\(sessionId\) \}/,
    'the open must be a method call on THIS ctx sessions service (never a detached reference)',
  )
  assert.match(
    plugin,
    /isAddressable: \(sessionId\) => \{/,
    'the addressability probe must live at the ctx seam, where a hostile face is caught',
  )
  assert.match(
    plugin,
    /if \(snapshot\?\.byId === undefined\) return false/,
    'a readable-but-empty face is `false` (keep polling), never `undefined` (retire)',
  )
})

test('the arm module itself owns the decision logic (no duplicated rules at the seam)', () => {
  const plugin = read('../src/client/index.ts')
  assert.doesNotMatch(
    plugin,
    /EARLY_OPEN_BUDGET_MS|EARLY_OPEN_RETRY_MS|shouldEarlyOpenSession/,
    'deadline/cadence/predicate belong to shared/open-intent.ts + client/early-open.ts',
  )
  const arm = read('../src/client/early-open.ts')
  assert.match(arm, /shouldEarlyOpenSession\(intent, addressable\)/)
  assert.match(arm, /deadline = now\(\) \+ EARLY_OPEN_BUDGET_MS/)
  assert.doesNotMatch(
    arm,
    /new Set\(/,
    'the arm must probe per id: materializing an id set every 50ms over a multi-thousand-row list is pure waste',
  )
})
