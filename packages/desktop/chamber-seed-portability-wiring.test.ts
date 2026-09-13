/**
 * Chamber host-seed PORTABILITY wiring (design 13 §6 / design 20 §6; 2026-12
 * review). In the desktop main process, every path that judges "what should be
 * on that OTHER host" must read the portable seed list
 * (`portableChamberHostPackageSeeds`), never the full registry projection: a
 * `localOnly` row carries an EMPTY `sourceDir` by design, so counting it as a
 * seedable package
 *   - failed the manual 「注入」 action with "…的 dist/index.js 缺失" naming the
 *     one package that must never be seeded there,
 *   - appended a false "chamber host 包部分未注入（构建产物缺失）" gap to the
 *     REMOTE instance's ring-buffer log on every ready transition, and
 *   - warned on every gateway sync that the local-shape-only package "is NOT
 *     uploaded to the gateway seed cache".
 *
 * main.ts is an Electron entry this suite cannot import, so the wiring is pinned
 * at the SOURCE level — the same lockstep discipline as the *-wiring tests in
 * the connections package and renderer-trust.test.ts. The behavioural half
 * (`portableChamberHostPackageSeeds` / `builtChamberHostPackageSeeds` and the
 * writer's own drop) is covered by plugin-sync.test.ts.
 *
 * Assertions are made over COMMENT-STRIPPED code and count IDENTIFIER
 * occurrences rather than banning a spelling: this file's house style puts long
 * prose in comments, so a char-window or a `filter(`-literal ban would red on a
 * legitimate future edit while still missing `.map(`/`.some(`/spread reads
 * (2026-12 review).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainSource = readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8')

/**
 * Comment stripper (house implementation, same as the visual-lock tests):
 * quote-aware, so a `/*` inside a string or a template literal can never open
 * a block comment. A naive regex stripper ate ~40% of this 290 KB file.
 */
function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) { if (ch === '\n') { line = false; out += ch } else out += ' '; continue }
    if (block) { if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '; continue }
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

/** Comments removed: this file's house style is long prose in comments, so
 *  identifier counting must not see them. */
const mainCode = stripComments(mainSource)

/** Slice between two code markers (exclusive of the end marker). */
function between(startMarker: string, endMarker: string): string {
  const start = mainCode.indexOf(startMarker)
  assert.notEqual(start, -1, `main.ts no longer contains: ${startMarker}`)
  const end = mainCode.indexOf(endMarker, start)
  assert.notEqual(end, -1, `main.ts no longer contains ${endMarker} after ${startMarker}`)
  return mainCode.slice(start, end)
}

test('main.ts: the portability rule is derived once, and the full projection is read exactly once', () => {
  assert.ok(
    mainCode.includes('const portableHostSeeds = portableChamberHostPackageSeeds(chamberHostPackageSeeds)'),
    'the desktop must derive the portable seed list from the registry projection',
  )
  // The declaration + the derivation are the ONLY two mentions in code: any
  // other read (`.filter(`, `.map(`, `.some(`, spread) re-introduces the
  // defect this change fixed, and a legitimately added read is a deliberate
  // edit of this gate rather than a silent regression.
  const mentions = mainCode.match(/chamberHostPackageSeeds/g) ?? []
  assert.equal(mentions.length, 2,
    `the full registry projection must be read only where it is declared and made portable (found ${mentions.length} mentions)`)
})

test('main.ts: both ssh preflights and the ready-time gap log read the portable list', () => {
  const ready = between('const builtSeeds = builtChamberHostPackageSeeds(', 'const result = await seedRemoteChamberHostPackages(')
  assert.ok(ready.includes('const missingSeeds = portableHostSeeds.filter('),
    'the ready-time gap log judges the portable list')

  const manual = between('IPC_CHANNELS.SSH_SEED_HOST_GRAPH', 'const begun = hostPackageSeeding.begin(')
  assert.ok(manual.includes('const built = builtChamberHostPackageSeeds(portableHostSeeds)'),
    'the manual 注入 preflight judges the SHIPPED portable rows')
  assert.ok(manual.includes('const missing = portableHostSeeds.filter(seed => !built.includes(seed))'),
    'and reports an unbuilt/unmapped row as missing (loud, never a phantom upload)')

  // BOTH writer call sites (ready-time and manual) receive the portable list.
  // The argument is asserted by count rather than inside a window: the ready
  // call's argument sits between the two anchors, so a window ending at the
  // call could never contain it (2026-12 review).
  assert.equal((mainCode.match(/seedRemoteChamberHostPackages\(/g) ?? []).length, 2,
    'both writer call sites must still exist')
  assert.equal((mainCode.match(/portableHostSeeds,/g) ?? []).length, 2,
    'both writer call sites must pass the portable list (a full-projection argument would be the regression)')
})

test('main.ts: the gateway upload source list iterates the portable seeds (one rule, one implementation)', () => {
  const upload = between('const localChamberHostPackageSources = ', 'const syncGatewayChamberPluginsFor = ')
  assert.ok(upload.includes('return portableHostSeeds.flatMap(seed =>'),
    'the upload must be built from the portable list, not from the full registry with an inline re-check')
  assert.ok(upload.includes('chamberHostSourceDirs[seed.packageName]'),
    'per-package source dirs still come from the single map')
  assert.ok(upload.includes('if (dir === undefined)'),
    'a genuine "registry row lost its source dir" must stay loud')
  assert.equal(upload.includes('descriptor.localOnly'), false,
    'the hand-rolled portability filter is the duplicate this test forbids')
})
