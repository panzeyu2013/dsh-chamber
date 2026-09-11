/**
 * Wiring contract for the boot-time early-open arm inside the sidebar plugin
 * (design 05 §2.2 revision 2026-12; 2026-12 field report problem 1).
 *
 * Source-text contract (the sidebar package's `producer-purged-wiring.test.ts`
 * pattern): `client/index.ts` is a cordis plugin body that cannot be imported by
 * a node test without a full client ctx. The arm's BEHAVIOUR is covered by
 * `early-open.test.ts` and the shared rules by `open-intent.test.ts`; this file
 * pins the links that would silently disable or misfire the preemption:
 *
 * 1. the arm is started inside a `ctx.effect` (so ctx teardown disposes it — an
 *    arm outliving its ctx could open a session in a dead shell);
 * 2. the intent is read LIVE from the shared slot, not captured at apply time
 *    (a captured value would open whatever was pending when the ctx mounted);
 * 3. the open goes through THIS ctx's own `sessions.open` (a detached reference
 *    or a page-global open would target the wrong instance);
 * 4. the arm proves the SOURCE IDENTITY before it mutates the host (2026-09-11
 *    review F3) — the intent slot is page-wide and keyed by sourceId only, so
 *    without the fingerprint guard any boot sharing that id would open a
 *    session on the strength of another incarnation's intent.
 *
 * The assertions run against COMMENT-STRIPPED source (`stripComments`, the
 * precedent is `panel-wiring.test.ts`): the contract is the executable shape,
 * so a line that only exists inside a comment must not satisfy it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * Remove line/block comments while preserving string and template literals.
 * @param code - the source text.
 * @returns the source with comments replaced by spaces.
 */
function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) {
      if (ch === '\n') { line = false; out += ch } else out += ' '
      continue
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '
      continue
    }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

/** The `ctx.effect` body that starts the early-open arm (comments stripped). */
function armEffectBody(plugin: string): string {
  const code = stripComments(plugin)
  const effectIndex = code.indexOf("}, 'dsh-chamber: boot-time session open intent')")
  assert.notEqual(effectIndex, -1, 'the arm must be a dedicated ctx effect')
  return code.slice(code.lastIndexOf('ctx.effect(() => {', effectIndex), effectIndex)
}

test('the plugin starts the arm inside a ctx.effect, bound to its own instance id', () => {
  const body = armEffectBody(read('../src/client/index.ts'))
  assert.match(body, /const chamberInstanceId = \(ctx as any\)\.chamberInstanceId as string \| undefined/)
  assert.match(body, /if \(typeof chamberInstanceId !== 'string' \|\| chamberInstanceId === ''\) return \(\) => \{\}/, 'a non-chamber boot must not arm')
  assert.match(body, /return startEarlyOpenArm\(\{/)
  assert.match(body, /instanceId: chamberInstanceId,/)
})

test('the arm proves the source identity before it opens on that host (2026-09-11 review F3)', () => {
  // Deleting this guard re-opens the hole the review found: the arm MUTATES
  // (`sessions.open`) on a page-wide, sourceId-keyed intent, so a same-id boot
  // of another incarnation could be driven by an intent armed for a previous
  // one. It is the same proof the runtime-facts producer above requires.
  const body = armEffectBody(read('../src/client/index.ts'))
  assert.match(
    body,
    /const chamberSourceFingerprint = \(ctx as any\)\.chamberSourceFingerprint as string \| undefined/,
    'the arm must read the ctx source fingerprint the same way the producer effect does',
  )
  assert.match(
    body,
    /if \(!isValidProducerSourceFingerprint\(chamberInstanceId, chamberSourceFingerprint\)\) return \(\) => \{\}/,
    'an unproven source identity must leave the arm unarmed',
  )
  const guardAt = body.indexOf('isValidProducerSourceFingerprint(chamberInstanceId, chamberSourceFingerprint)')
  const armAt = body.indexOf('return startEarlyOpenArm(')
  assert.ok(guardAt !== -1 && armAt > guardAt, 'the identity proof must precede the arm')
})

test('the arm reads the LIVE intent and opens through this ctx own sessions service', () => {
  const body = armEffectBody(read('../src/client/index.ts'))
  assert.match(
    body,
    /readIntent: \(\) => getOpenIntent\(chamberInstanceId\)/,
    'the intent must be read at attempt time — a captured value would open a stale request',
  )
  assert.match(
    body,
    /open: \(sessionId\) => \{ ctx\.sessions\.open\(sessionId\) \}/,
    'the open must be a method call on THIS ctx sessions service (never a detached reference)',
  )
  assert.match(
    body,
    /isAddressable: \(sessionId\) => \{/,
    'the addressability probe must live at the ctx seam, where a hostile face is caught',
  )
  assert.match(
    body,
    /if \(snapshot\?\.byId === undefined\) return undefined/,
    'an ABSENT face is `undefined` (retire silently, 2026-09-11 review F2) — a readable-but-empty face is `false` (keep polling), handled by the next line',
  )
  assert.doesNotMatch(
    body,
    /resolveInstanceListFace/,
    'the probe must stay silent: that helper warns loudly and the same ctx runtime-facts producer already warns for this defect',
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
