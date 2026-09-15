/**
 * Unit tests for the GUI acceptance toolbox's judgement layer (checks.mjs).
 *
 * WHY ONLY PURE HELPERS: the driving layers need a display, a running app and a
 * CDP port, so they are local gates (docs/checklists/gui-acceptance-checklist.md);
 * everything that decides pass/fail is pure — and therefore runs in CI, which is
 * how every other tool in this repo is policed (test:upgrade-tools,
 * test:release-workflow).
 *
 * The one exception is the walkthrough-SELECTION miniature at the end: the page
 * expressions it guards are strings (only a real page can run them), but their
 * row selection decides whether W-4b judges the product or itself, so the real
 * expressions run here against a fake DOM.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOVER_RACE_FALLBACK_OFFSETS, HOVER_RACE_WINDOW_CAP_MS, KNOWN_UPSTREAM_BOOT_NOISE,
  RAIL_TOGGLE_BAND_MAX_TOP_PX, RAIL_TOGGLE_BOX_MAX_PX, RAIL_TOGGLE_LEFT_FRACTION, TOLERATED_REQUEST_FAILURES,
  applyRequireHover, cardIdentityHolds, createRecorder, deriveSourceIds, hasSecurityHeaders, hoverCardVerdict,
  hoverDismissVerdict, hoverExclusiveVerdict, hoverRaceVerdict, isHonestError, isInstanceIndex, isShellIndex,
  isWriterQuiescent, leakedFileContent, normalizeCardText, parseInstanceAssets, parsePluginLoaderUrls,
  parseShellAssets, partitionFailures, pickRailToggle, raceBandForWindow, railToggleVerdict, renderMarkdown,
  railFactsSnapshot, safeJson, sourceFoldVerdict, summarize, summarizeNetFailures, viewPrefsDelta,
  viewPrefsFingerprint, viewPrefsUnreadable, writerEvidence,
} from './checks.mjs'
// The two page-level click expressions are imported so CI can run the REAL
// strings against a fake DOM (identity addressing and the no-click-when-missing
// rule are behaviour, not something a source-text assertion can guard).
import { CLICK_STASHED_BUTTON, clickButtonAt } from './walkthrough.mjs'

const SHELL_HTML = `<!doctype html><html lang="zh-CN"><head><title>dsh-chamber</title>
<script type="module" crossorigin src="/assets/chamber-abc.js"></script>
<link rel="stylesheet" href="/assets/chamber-def.css"></head><body><div id="root"></div></body></html>`

const INSTANCE_HTML = `<!doctype html><html lang="en"><head><base href="/">
<link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-typert-registry/client.js,@deepseek-ai/dsh-api-gateway/client.js">
<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=cddf5581d5d5"></script>
<script type="module" crossorigin src="./assets/index-Df-65__b.js"></script>
<script>window.__DSH_BOOT__={"version":"0.1.5-rc.1"}</script>
<link rel="stylesheet" href="./assets/index-b24khbeK.css"></head><body></body></html>`

test('shell index: doctype + the chamber marker, and never a look-alike', () => {
  assert.equal(isShellIndex(200, SHELL_HTML), true)
  assert.equal(isShellIndex(404, SHELL_HTML), false, 'a status other than 200 is never the shell')
  assert.equal(isShellIndex(200, INSTANCE_HTML), false, 'the instance frontend is not the chamber shell')
})

test('instance index: boot manifest + <base href> are both required', () => {
  assert.equal(isInstanceIndex(200, INSTANCE_HTML), true)
  assert.equal(isInstanceIndex(200, INSTANCE_HTML.replace(/<base href="\/">/, '')), false,
    'without the base tag the per-entry rewrite is missing')
  assert.equal(isInstanceIndex(200, SHELL_HTML), false)
})

test('asset parsing keeps only what the document itself declares', () => {
  assert.deepEqual(parseShellAssets(SHELL_HTML), ['/assets/chamber-abc.js', '/assets/chamber-def.css'])
  assert.deepEqual(parseInstanceAssets(INSTANCE_HTML), ['assets/index-Df-65__b.js', 'assets/index-b24khbeK.css'])
  assert.deepEqual(parseShellAssets('<html></html>'), [])
})

test('plugin loader urls are unescaped and keep their rev query', () => {
  const urls = parsePluginLoaderUrls(INSTANCE_HTML)
  assert.equal(urls.length, 2)
  assert.equal(urls[1], '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=cddf5581d5d5',
    'the &amp; entity must be decoded — the instance 404s the same path without rev')
  assert.deepEqual(parsePluginLoaderUrls(SHELL_HTML), [])
})

test('security headers: all four stamped, any one missing fails', () => {
  const full = {
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval' 'nonce-x'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  }
  assert.equal(hasSecurityHeaders(full), true)
  for (const key of Object.keys(full)) {
    const clone = { ...full }
    delete clone[key]
    assert.equal(hasSecurityHeaders(clone), false, `${key} must be required`)
  }
  assert.equal(hasSecurityHeaders({ ...full, 'x-frame-options': 'SAMEORIGIN' }), false)
})

test('traversal fence judges the leak, not the status code', () => {
  assert.equal(leakedFileContent('root:x:0:0:root:/root:/bin/sh'), true)
  assert.equal(leakedFileContent('{"error":"not_found","code":"not_found"}'), false)
  assert.equal(leakedFileContent(''), false)
})

test('honest error requires the named code inside the body', () => {
  const body = '{"error":"unknown instance path","code":"instance_not_found"}'
  assert.equal(isHonestError(404, body, 'instance_not_found'), true)
  assert.equal(isHonestError(200, body, 'instance_not_found'), false, '2xx is not an error answer')
  assert.equal(isHonestError(404, '{"error":"not_found"}', 'instance_not_found'), false,
    'a code-less 404 is the silent shape the surface must not produce')
})

test('writer quiescence: the VERDICT is quiescent, not an empty scan list', () => {
  assert.equal(isWriterQuiescent('{"quiescent":true,"writers":[],"errors":[]}'), true)
  // A reclaimed orphan is listed exactly so the connections page can show it —
  // it blocks nothing (api.ts: "GET /api/connections/local/writers → {quiescent,…}").
  assert.equal(isWriterQuiescent('{"quiescent":true,"writers":[{"name":"63396.json","status":"reclaimed","pid":63396,"reason":"orphan-reclaimed","takeOverAvailable":false}],"errors":[]}'), true)
  assert.equal(isWriterQuiescent('{"quiescent":false,"writers":[{"name":"x.json","status":"kept","takeOverAvailable":true}],"errors":[]}'), false)
  assert.equal(isWriterQuiescent('{"error":"not_found"}'), false)
  assert.equal(isWriterQuiescent('not json'), false)
})

test('writer evidence names every scan outcome and the error count', () => {
  const evidence = writerEvidence('{"quiescent":true,"writers":[{"name":"a.json","status":"reclaimed"},{"name":"b.json","status":"kept","takeOverAvailable":true}],"errors":["boom"]}')
  assert.match(evidence, /quiescent=true/)
  assert.match(evidence, /a\.json:reclaimed/)
  assert.match(evidence, /b\.json:kept\(可接管\)/)
  assert.match(evidence, /errors=1/)
  assert.equal(writerEvidence('nope'), 'not json')
})

test('tolerances cover exactly the documented states and nothing else', () => {
  const coldStart = '503 http://127.0.0.1:17500/api/i/local/api/clientGraph/graph'
  const sseAbort = 'FAILED(net::ERR_ABORTED) http://127.0.0.1:17500/api/host/health-events'
  const partition = partitionFailures([coldStart, sseAbort, '500 http://x/api/connections', '404 http://x/assets/a.js'], TOLERATED_REQUEST_FAILURES)
  assert.equal(partition.tolerated.length, 2)
  assert.deepEqual(partition.unexpected, ['500 http://x/api/connections', '404 http://x/assets/a.js'])
  assert.match(partition.tolerated[0], /design 09 §3\.2/)
  // The same endpoint with a real server answer is NOT tolerated.
  assert.equal(partitionFailures(['500 http://x/api/i/local/api/clientGraph/graph'], TOLERATED_REQUEST_FAILURES).tolerated.length, 0)
  assert.equal(partitionFailures(['FAILED(net::ERR_CONNECTION_REFUSED) http://x/api/host/health-events'], TOLERATED_REQUEST_FAILURES).tolerated.length, 0)
})

test('known upstream boot noise is described, not silently dropped', () => {
  const noise = '[cordis-client-runner] syncing inspect providers failed: Error: client api: dynamicCordisRunner/syncInspectManifest has no active Connection'
  const partition = partitionFailures([noise, 'TypeError: x is not a function'], KNOWN_UPSTREAM_BOOT_NOISE)
  assert.equal(partition.tolerated.length, 1)
  assert.match(partition.tolerated[0], /上游 cordis-client-runner/)
  assert.match(partition.tolerated[0], /no active Connection/, 'the raw text stays in the report')
  assert.deepEqual(partition.unexpected, ['TypeError: x is not a function'])
})

test('source ids come from id+kind only, deduped and sorted', () => {
  const registry = [
    { id: 'pve-vm-develop', kind: 'gateway', host: '10.0.0.9', user: 'root', sshPort: 22 },
    { id: 'local', kind: 'dsh' },
    { id: 'pve-vm-develop', kind: 'gateway' },
    { kind: 'gateway' },
    { id: '', kind: 'dsh' },
    null,
  ]
  assert.deepEqual(deriveSourceIds(registry), ['dsh-local', 'gateway-pve-vm-develop'])
  assert.deepEqual(deriveSourceIds({ 0: { id: 'a', kind: 'dsh' }, 1: { id: 'b', kind: 'gateway' } }), ['dsh-a', 'gateway-b'])
  assert.deepEqual(deriveSourceIds(undefined), [])
  const serialized = JSON.stringify(deriveSourceIds(registry))
  assert.equal(serialized.includes('10.0.0.9'), false, 'host facts must never reach a report')
  assert.equal(serialized.includes('root'), false, 'user facts must never reach a report')
})

test('net failures summarize deterministically with counts', () => {
  assert.deepEqual(summarizeNetFailures(new Map([['503 /a', 2], ['404 /b', 1]])), ['404 /b ×1', '503 /a ×2'])
  assert.deepEqual(summarizeNetFailures(undefined), [])
})

test('recorder counts passes and failures, and INFO never fails', () => {
  const rec = createRecorder()
  rec.add('A', 'pass', true, 'ok')
  rec.add('B', 'info', null, 'not applicable')
  rec.add('C', 'fail', false, 'boom')
  assert.equal(rec.passed, 1)
  assert.equal(rec.failed, 1)
  assert.deepEqual(summarize(rec.results), { total: 3, passed: 1, failed: 1, info: 1 })
})

test('report renders one table row per check and escapes pipes', () => {
  const rec = createRecorder()
  rec.add('X-1', 'a | b', true, 'evi|dence')
  const markdown = renderMarkdown({ title: 'T', meta: { 目标: 'http://x' }, results: rec.results })
  assert.match(markdown, /^\| X-1 \| a \\\| b \| ✅ \| evi\\\|dence \|$/m)
  assert.match(markdown, /- 结果：1 pass \/ 0 fail \/ 0 info（共 1 项）/)
  assert.match(markdown, /## 页面失败请求（≥400 \/ loadingFailed）：0/)
})

test('safeJson never throws on hostile input', () => {
  assert.equal(safeJson('{"a":1}').a, 1)
  for (const value of ['', 'nope', '<html>', undefined, '{"a":']) assert.equal(safeJson(value), null)
})

test('hover card verdict: opens and clears is a pass, a lingering card is a failure, no cardable row is INFO', () => {
  assert.equal(hoverCardVerdict({ cardable: true, opened: true, closed: true, rowTitle: '工作区 A', cardText: '工作区 A 3 个会话' }).ok, true)
  assert.equal(hoverCardVerdict({ cardable: true, opened: true, closed: false, rowTitle: '工作区 A', cardText: '工作区 A' }).ok, false)
  assert.equal(hoverCardVerdict({ cardable: true, opened: false, closed: true, rowTitle: '工作区 A', cardText: '' }).ok, false)
  const info = hoverCardVerdict({ cardable: false, anchorCount: 0, wrappedRows: 0 })
  assert.equal(info.ok, null)
  assert.match(info.evidence, /未执行/)
})

test('hover card verdict: identity is the hovered row own title inside the card', () => {
  // Containment, not equality: a session card appends time / state lines.
  const pass = hoverCardVerdict({
    cardable: true, opened: true, closed: true,
    rowTitle: '  session   title ', cardText: 'session title 3 分钟前 进行中',
  })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /identity=true/)
  // The card exists and clears, but it is ANOTHER row's card: a failure.
  const wrongRow = hoverCardVerdict({
    cardable: true, opened: true, closed: true, rowTitle: 'B 行', cardText: 'A 行的卡片',
  })
  assert.equal(wrongRow.ok, false)
  assert.match(wrongRow.evidence, /identity=false/)
  // No observable title at all is never a pass.
  assert.equal(hoverCardVerdict({ cardable: true, opened: true, closed: true, rowTitle: '', cardText: 'x' }).ok, false)
})

test('hover card verdict: cardable-looking rows without the anchor marker are a FAIL, not INFO', () => {
  // The pre-fix vendored atom stamps no marker: rows exist, wrapped by the
  // anchor-shaped span, but [data-chamber-hovercard-anchor] is absent.
  const missing = hoverCardVerdict({ cardable: false, anchorCount: 0, wrappedRows: 7 })
  assert.equal(missing.ok, false)
  assert.match(missing.evidence, /data-chamber-hovercard-anchor/)
  assert.match(missing.evidence, /标记契约缺失/)
  // No rows at all (or none cardable by construction) stays INFO.
  assert.equal(hoverCardVerdict({ cardable: false, anchorCount: 0, wrappedRows: 0 }).ok, null)
  // Anchors exist but no row qualified for the viewport: INFO, never the
  // "marker missing" failure — the marker is demonstrably there.
  const noneFit = hoverCardVerdict({ cardable: false, anchorCount: 3, wrappedRows: 0, note: 'viewport' })
  assert.equal(noneFit.ok, null)
  assert.match(noneFit.evidence, /anchors=3/)
  assert.match(noneFit.evidence, /viewport/)
})

test('hover race verdict: zero stranded passes only when the run could discriminate', () => {
  const clean = hoverRaceVerdict({ trials: 12, stranded: 0, bandMs: [13, 25, 45], windowMs: 50 })
  assert.equal(clean.ok, true)
  assert.match(clean.evidence, /trials=12/)
  assert.match(clean.evidence, /band=dwell\+\{13\/25\/45\}ms/)
  assert.match(clean.evidence, /stranded=0/)
  assert.match(clean.evidence, /window=50ms（可区分）/)
  // The whole point: a single stranded card IS the reported defect — and it is a
  // FAIL even when the window could not be measured.
  const stranded = hoverRaceVerdict({ trials: 12, stranded: 1, bandMs: [13, 25, 45], windowMs: 50, strandedTrials: [4] })
  assert.equal(stranded.ok, false)
  assert.match(stranded.evidence, /stranded=1/)
  assert.match(stranded.evidence, /第 4 次/)
  assert.equal(hoverRaceVerdict({ trials: 12, stranded: 2, bandMs: [10, 20, 35], windowMs: null }).ok, false)
  // No cardable row → the leg never ran: INFO, never a pass.
  const info = hoverRaceVerdict({ trials: 0, stranded: 0, bandMs: [10, 20, 35], windowMs: null })
  assert.equal(info.ok, null)
  assert.match(info.evidence, /未执行/)
})

test('hover race verdict: a clean run that could NOT discriminate is INFO, never a pass', () => {
  // No window measured (no card observed): the fallback band proves nothing.
  const unmeasured = hoverRaceVerdict({ trials: 12, stranded: 0, bandMs: [10, 20, 35, 50, 60], windowMs: null })
  assert.equal(unmeasured.ok, null)
  assert.match(unmeasured.evidence, /窗口未测到/)
  assert.match(unmeasured.evidence, /不具区分力/)
  assert.match(unmeasured.evidence, /stranded=0/, 'the observed facts stay in the evidence')
  // Window measured but below the probe resolution (<= 2ms).
  for (const windowMs of [0, 1, 2]) {
    const tiny = hoverRaceVerdict({ trials: 12, stranded: 0, bandMs: [1], windowMs })
    assert.equal(tiny.ok, null, `window ${windowMs}ms must not read as a pass`)
    assert.match(tiny.evidence, /低于探针分辨率/)
    assert.match(tiny.evidence, /不具区分力/)
  }
  // One millisecond above the threshold is a real pass.
  assert.equal(hoverRaceVerdict({ trials: 12, stranded: 0, bandMs: [1, 2, 3], windowMs: 3 }).ok, true)
  // NaN / Infinity / a missing fact are "unmeasured", not a crash and not a pass.
  for (const windowMs of [NaN, Infinity, undefined]) {
    assert.equal(hoverRaceVerdict({ trials: 12, stranded: 0, bandMs: [1], windowMs }).ok, null)
  }
  // --require-hover closes the loop: a non-discriminating clean run becomes FAIL.
  const strict = applyRequireHover(hoverRaceVerdict({ trials: 12, stranded: 0, bandMs: [1], windowMs: 1 }), true)
  assert.equal(strict.ok, false)
  assert.match(strict.evidence, /要求 hover 腿必须真实执行/)
})

test('race band is derived from the measured window, with a fallback when unusable', () => {
  // Unusable measurements fall back to the historical fixed band (a copy, never
  // the exported array itself).
  for (const unusable of [null, undefined, NaN, Infinity, -Infinity, 0, -5, 'x']) {
    assert.deepEqual(raceBandForWindow(unusable), [10, 20, 35, 50, 60], `${String(unusable)} must fall back`)
  }
  assert.notEqual(raceBandForWindow(null), HOVER_RACE_FALLBACK_OFFSETS, 'the caller cannot mutate the constant')
  // A probeable window yields deterministic offsets inside (0, window].
  assert.deepEqual(raceBandForWindow(50), [13, 25, 45])
  assert.deepEqual(raceBandForWindow(3), [1, 2, 3])
  assert.deepEqual(raceBandForWindow(100), [25, 50, 90])
  // Below the probe resolution the offsets collapse to the smallest deliverable
  // step; the verdict (not the helper) calls that non-discriminating.
  assert.deepEqual(raceBandForWindow(1), [1])
  assert.deepEqual(raceBandForWindow(2), [1, 2])
  // A huge window is capped so one trial cannot blow up the walkthrough.
  assert.deepEqual(raceBandForWindow(5_000), raceBandForWindow(HOVER_RACE_WINDOW_CAP_MS))
  assert.deepEqual(raceBandForWindow(1e9), [50, 100, 180])
  // Determinism + invariants across the whole range the probe can produce.
  for (const windowMs of [0.5, 1, 2, 3, 7, 19, 50, 137, 200, 400]) {
    const band = raceBandForWindow(windowMs)
    assert.deepEqual(band, raceBandForWindow(windowMs), 'deterministic')
    assert.ok(band.length >= 1 && band.length <= 5, `3-5 offsets, got ${band.length}`)
    for (const offset of band) {
      assert.ok(Number.isInteger(offset) && offset >= 1, `offset ${offset} must be a whole ms >= 1`)
      // A sub-millisecond window cannot hold any deliverable offset: 1ms is the
      // smallest step there is, and the VERDICT is what calls that run
      // non-discriminating (window <= HOVER_RACE_MIN_WINDOW_MS).
      const ceiling = Math.max(1, Math.min(windowMs, HOVER_RACE_WINDOW_CAP_MS))
      assert.ok(offset <= ceiling, `offset ${offset} must stay in the window (${windowMs}ms)`)
    }
  }
})

test('hover exclusivity verdict: at most one card across A→B, ending on B', () => {
  const pass = hoverExclusiveVerdict({
    pairs: 2, startCount: 1, maxCount: 1, endCount: 1, rowTitle: 'B 行', endText: 'B 行 刚刚',
  })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /startCardCount=1/)
  assert.match(pass.evidence, /maxCardCount=1/)
  // Two cards on screen at once: the exclusivity invariant broke.
  assert.equal(hoverExclusiveVerdict({ pairs: 2, startCount: 1, maxCount: 2, endCount: 1, rowTitle: 'B', endText: 'B' }).ok, false)
  // Never reached one card (B never opened) or ended on A's card: failure.
  assert.equal(hoverExclusiveVerdict({ pairs: 2, startCount: 1, maxCount: 1, endCount: 0, rowTitle: 'B', endText: '' }).ok, false)
  assert.equal(hoverExclusiveVerdict({ pairs: 2, startCount: 1, maxCount: 1, endCount: 1, rowTitle: 'B', endText: 'A 行' }).ok, false)
  // A never rose, so nothing was ever crossed: the leg must not pass vacuously.
  assert.equal(hoverExclusiveVerdict({ pairs: 2, startCount: 0, maxCount: 1, endCount: 1, rowTitle: 'B', endText: 'B' }).ok, false)
  // Only one cardable row on screen → nothing to swap to: INFO.
  const info = hoverExclusiveVerdict({ pairs: 1 })
  assert.equal(info.ok, null)
  assert.match(info.evidence, /未执行/)
})

test('hover dismiss verdict: blur and hidden each clear an open card, else FAIL', () => {
  const both = { opened: true, cleared: true }
  assert.equal(hoverDismissVerdict({ cardable: true, blur: both, hidden: both }).ok, true)
  const evidence = hoverDismissVerdict({ cardable: true, blur: both, hidden: both }).evidence
  assert.match(evidence, /blur\(opened=true,cleared=true\)/)
  assert.match(evidence, /visibilitychange-hidden\(opened=true,cleared=true\)/)
  // The listener did not fire, or it fired while no card was open (vacuous leg).
  assert.equal(hoverDismissVerdict({ cardable: true, blur: { opened: true, cleared: false }, hidden: both }).ok, false)
  assert.equal(hoverDismissVerdict({ cardable: true, blur: { opened: false, cleared: true }, hidden: both }).ok, false)
  assert.equal(hoverDismissVerdict({ cardable: true, blur: both, hidden: { opened: true, cleared: false } }).ok, false)
  assert.equal(hoverDismissVerdict({ cardable: true, blur: both, hidden: null }).ok, false)
  const info = hoverDismissVerdict({ cardable: false })
  assert.equal(info.ok, null)
  assert.match(info.evidence, /未执行/)
})

test('hover text facts normalize whitespace and never throw', () => {
  assert.equal(normalizeCardText('  a \n b\t'), 'a b')
  assert.equal(normalizeCardText(null), '')
  assert.equal(normalizeCardText(undefined), '')
  assert.equal(cardIdentityHolds('  session  title  ', 'session title (3 分钟前)'), true)
  assert.equal(cardIdentityHolds('', 'anything'), false)
  assert.equal(cardIdentityHolds('title', ''), false)
  assert.equal(cardIdentityHolds('title', 'another row'), false)
})

test('require-hover turns a not-executed (INFO) verdict into a FAIL and nothing else', () => {
  const info = hoverCardVerdict({ cardable: false, anchorCount: 0, wrappedRows: 0 })
  assert.equal(info.ok, null)
  // Off (the default): INFO stays INFO — exit-code semantics are unchanged.
  assert.equal(applyRequireHover(info, false), info, 'the verdict object is passed through untouched')
  // On: the same verdict becomes an explicit FAIL that says why.
  const strict = applyRequireHover(info, true)
  assert.equal(strict.ok, false)
  assert.match(strict.evidence, /本次运行要求 hover 腿必须真实执行/)
  assert.match(strict.evidence, /未执行/, 'the original evidence is kept')
  // A verdict that already decided is never re-labelled.
  const pass = hoverCardVerdict({ cardable: true, opened: true, closed: true, rowTitle: 'A', cardText: 'A' })
  assert.equal(pass.ok, true)
  assert.equal(applyRequireHover(pass, true), pass)
  const fail = hoverCardVerdict({ cardable: true, opened: true, closed: false, rowTitle: 'A', cardText: 'A' })
  assert.equal(fail.ok, false)
  assert.equal(applyRequireHover(fail, true), fail)
  // Every hover verdict's INFO path is covered by the same wrapper.
  assert.equal(applyRequireHover(hoverRaceVerdict({ trials: 0, stranded: 0, bandMs: [10, 60] }), true).ok, false)
  assert.equal(applyRequireHover(hoverExclusiveVerdict({ pairs: 1 }), true).ok, false)
  assert.equal(applyRequireHover(hoverDismissVerdict({ cardable: false }), true).ok, false)
})

test('marker contract: RowHoverCard.tsx stamps exactly the attribute names the walkthrough selects', () => {
  const source = readFileSync(new URL('../../packages/dsh-chamber-client-ui-sidebar/src/client/RowHoverCard.tsx', import.meta.url), 'utf8')
  // Counting and row selection are ONLY as good as these exact names: the card
  // `<div>` that is portaled to document.body stamps `data-chamber-hovercard`,
  // and the wrapper `<span>` around the hover target stamps
  // `data-chamber-hovercard-anchor` (the sidebar package's own wiring test,
  // packages/dsh-chamber-client-ui-sidebar/test/hover-card-wiring.test.ts:176-180,
  // pins the same pair).
  assert.ok(source.includes('data-chamber-hovercard=""'), 'the card must stamp data-chamber-hovercard')
  assert.ok(source.includes('data-chamber-hovercard-anchor=""'), 'the anchor must stamp data-chamber-hovercard-anchor')
  const markers = [...new Set([...source.matchAll(/data-chamber-hovercard[\w-]*/g)].map(match => match[0]))]
  for (const marker of markers) {
    assert.ok(['data-chamber-hovercard', 'data-chamber-hovercard-anchor'].includes(marker),
      `${marker} is not one of the two contracted hover-card markers`)
  }
})

/**
 * The walkthrough's page-side expressions are strings CDP evaluates inside the
 * real page, so CI cannot run them against a real DOM — but the SELECTION logic
 * inside them decides whether W-4b judges the product or itself. This miniature
 * executes the real `HOVER_TARGETS` / `CARD_FACTS` expressions against a fake
 * DOM, and is the regression guard for the defect that motivated the hardening:
 * the ungrouped workspace bucket carries `data-chamber-row` + `role="treeitem"`
 * while being card-less by design, so a row selector that ignores the anchor
 * marker records a false FAIL on an instance whose first fitting row is it.
 */
test('walkthrough selection: card-less bucket excluded, pre-fix bundle detected, identity resolves', () => {
  const source = readFileSync(new URL('./walkthrough.mjs', import.meta.url), 'utf8')
  const expression = name => {
    const literal = source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`\\n`))
    assert.ok(literal !== null, `${name} must stay a template literal in walkthrough.mjs`)
    const body = literal[1]
      .replace(/\$\{HOVER_ANCHOR_MARKER\}/g, 'data-chamber-hovercard-anchor')
      .replace(/\$\{HOVER_CARD_MARKER\}/g, 'data-chamber-hovercard')
    return new Function('document', 'window', `return (${body})`)
  }
  class TextNode { constructor(text) { this.nodeType = 3; this.textContent = text } }
  class El {
    constructor(tag, { attrs = {}, rect = { top: 100, bottom: 130, left: 10, right: 240, width: 230, height: 30 }, children = [] } = {}) {
      this.tagName = tag.toUpperCase(); this.nodeType = 1; this.attrs = attrs; this.rect = rect; this.children = children
      this.parentElement = null
      for (const child of children) if (child instanceof El) child.parentElement = this
    }
    get childNodes() { return this.children }
    get textContent() { return this.children.map(child => child.textContent ?? '').join('') }
    getBoundingClientRect() { return { ...this.rect } }
    closest(selector) {
      const key = selector.replace(/[[\]]/g, '')
      let node = this
      while (node !== null) { if (node.attrs[key] !== undefined) return node; node = node.parentElement }
      return null
    }
    scrollIntoView() { this.scrolled = true }
  }
  const row = (title, key, rect) => new El('div', { attrs: { 'data-chamber-row': key, role: 'treeitem' }, rect, children: [new El('span', { children: [new TextNode(title)] })] })
  const anchorOf = element => { const span = new El('span', { attrs: { 'data-chamber-hovercard-anchor': '' }, children: [element] }); element.parentElement = span; return span }
  const cardFor = title => new El('div', { attrs: { 'data-chamber-hovercard': '' }, children: [new El('div', { children: [new TextNode(title), new TextNode(' · 3 分钟前')] })] })
  const window = {
    innerWidth: 1400,
    innerHeight: 900,
    // The real page provides computed styles; the fake reports visible so the
    // selection logic (not the style engine) is what this miniature judges.
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }
  const page = (rows, anchors, cards) => ({
    querySelectorAll: selector => (selector.includes('data-chamber-hovercard-anchor') ? anchors
      : selector.includes('data-chamber-hovercard') ? cards : rows),
    body: { querySelectorAll: () => cards },
    visibilityState: 'visible',
  })

  // 1. The only row is the card-less ungrouped bucket: nothing cardable, and
  //    nothing that even looks like an anchor → INFO, never a false FAIL.
  const bucket = row('未分组', 'srv:ungrouped')
  let facts = expression('HOVER_TARGETS')(page([bucket], [], []), window)
  assert.equal(facts.first, null)
  assert.equal(facts.anchors, 0)
  assert.equal(facts.wrappedRows, 0, 'the bucket is not wrapped by an anchor span')
  assert.equal(hoverCardVerdict({ cardable: false, anchorCount: facts.anchors, wrappedRows: facts.wrappedRows }).ok, null)

  // 2. A pre-fix bundle: anchor-shaped rows without the marker → FAIL naming it.
  const preA = row('会话 A', 'srv:s1')
  const preB = row('会话 B', 'srv:s2')
  new El('span', { children: [preA] })
  new El('span', { children: [preB] })
  facts = expression('HOVER_TARGETS')(page([bucket, preA, preB], [], []), window)
  assert.equal(facts.wrappedRows, 2)
  const preFix = hoverCardVerdict({ cardable: false, anchorCount: facts.anchors, wrappedRows: facts.wrappedRows })
  assert.equal(preFix.ok, false)
  assert.match(preFix.evidence, /data-chamber-hovercard-anchor/)

  // 3. A marker-stamped build: the bucket is never picked, A/B are the two
  //    anchored rows, and the card's text carries the row's own title.
  const first = row('会话 A', 'srv:s1')
  const second = row('会话 B', 'srv:s2', { top: 140, bottom: 170, left: 10, right: 240, width: 230, height: 30 })
  const anchors = [anchorOf(first), anchorOf(second)]
  const rows = [bucket, first, second]
  facts = expression('HOVER_TARGETS')(page(rows, anchors, []), window)
  assert.equal(facts.first.title, '会话 A')
  assert.equal(facts.second.title, '会话 B')
  const dwelling = expression('CARD_FACTS')(page(rows, anchors, [cardFor('会话 A')]), window)
  assert.equal(dwelling.count, 1)
  assert.equal(hoverCardVerdict({
    cardable: true, opened: true, closed: true, rowTitle: facts.first.title, cardText: dwelling.text,
    anchorCount: facts.anchors, wrappedRows: facts.wrappedRows,
  }).ok, true, 'the card carries the hovered row own title')
  assert.equal(hoverCardVerdict({
    cardable: true, opened: true, closed: true, rowTitle: facts.first.title,
    cardText: expression('CARD_FACTS')(page(rows, anchors, [cardFor('会话 B')]), window).text,
  }).ok, false, "another row's card is not this row's card")
})

/**
 * W-4 / W-4a regression fixtures (2026-09-15: the leg reported PASS while the sidebar never moved).
 *
 * The rail leg used to select "the first button[aria-expanded] in the left half
 * of the viewport". The rail toggle carries NO aria-expanded (only a label that
 * flips), so that selector took the SOURCE-SECTION fold switch — and the leg
 * reported PASS with "aria-expanded true → false" while the sidebar never moved.
 * The descriptors below are the ones a real --dev instance produced.
 */
const RAIL_EXPANDED_BUTTONS = [
  { index: 0, ariaLabel: '新建会话', left: 12, top: 18, width: 120, height: 28, inDialog: false },
  { index: 1, ariaLabel: '收起侧边栏', left: 240, top: 22, width: 28, height: 28, inDialog: false },
  { index: 3, ariaLabel: '收起全部工作区', ariaExpanded: 'true', left: 18, top: 128, width: 16, height: 16, inDialog: false },
  { index: 8, ariaLabel: '设置', ariaExpanded: 'false', left: 10, top: 716, width: 260, height: 42, inDialog: false },
  { index: 9, ariaLabel: '选择工作区', ariaExpanded: 'false', left: 423, top: 321, width: 117, height: 28, inDialog: false },
  { index: 11, ariaLabel: '指令', ariaExpanded: 'false', left: 427, top: 434, width: 28, height: 28, inDialog: false },
]
const RAIL_COLLAPSED_BUTTONS = [
  { index: 0, ariaLabel: '打开侧边栏', left: 10, top: 18, width: 36, height: 36, inDialog: false },
  { index: 1, ariaLabel: '新建会话', left: 10, top: 66, width: 36, height: 36, inDialog: false },
  { index: 3, ariaLabel: '设置', ariaExpanded: 'false', left: 10, top: 716, width: 36, height: 36, inDialog: false },
]

test('rail toggle locator: structural pick, never the source fold or another disclosure', () => {
  const expanded = pickRailToggle(RAIL_EXPANDED_BUTTONS, { viewportWidth: 1280 })
  assert.equal(expanded.ok, true)
  assert.equal(expanded.picked.index, 1, 'the sidebar header icon button is the rail toggle')
  assert.equal(expanded.picked.ariaLabel, '收起侧边栏')
  // The exact defect: these two candidates carry aria-expanded (the source fold
  // and the composer's workspace selector) and used to be picked first.
  assert.notEqual(expanded.picked.index, 3, 'the source-section fold is not the rail toggle')
  assert.notEqual(expanded.picked.index, 9, 'the composer disclosure is not the rail toggle')

  // Collapsed (rail) state: the toggle is the only candidate — the rail's
  // new-session button (36×36 at top≈66, measured) must stay OUT of the
  // candidate set: it STARTS A SESSION, and a missing toggle must degrade to
  // no-candidate (FAIL), never to clicking a mutating control.
  const collapsed = pickRailToggle(RAIL_COLLAPSED_BUTTONS, { viewportWidth: 1280 })
  assert.equal(collapsed.ok, true)
  assert.equal(collapsed.picked.index, 0)
  assert.equal(collapsed.picked.ariaLabel, '打开侧边栏')
  assert.equal(collapsed.candidates.length, 1, 'the rail new-session button is not a rail-toggle candidate')
  const railWithoutToggle = pickRailToggle(RAIL_COLLAPSED_BUTTONS.filter(entry => entry.index !== 0), { viewportWidth: 1280 })
  assert.equal(railWithoutToggle.ok, false, 'no toggle ⇒ not located, never the new-session button')
  assert.equal(railWithoutToggle.reason, 'no-candidate')

  // A control inside a modal is never the toggle (the settings dialog's close box).
  assert.equal(pickRailToggle(
    [{ index: 13, ariaLabel: null, left: 998, top: 36, width: 28, height: 28, inDialog: true }],
    { viewportWidth: 1280 },
  ).ok, false)

  // Right-side chrome is out of scope: candidates must sit on the sidebar side.
  assert.equal(pickRailToggle(
    [{ index: 2, ariaLabel: 'x', left: 1280 * RAIL_TOGGLE_LEFT_FRACTION, top: 10, width: 28, height: 28, inDialog: false }],
    { viewportWidth: 1280 },
  ).ok, false, 'a control at the left-side boundary is not on the sidebar side')

  // Wide buttons (the brand button) and content below the header band are not candidates.
  assert.equal(pickRailToggle(
    [{ index: 0, ariaLabel: '新建会话', left: 12, top: 18, width: RAIL_TOGGLE_BOX_MAX_PX + 1, height: 28, inDialog: false }],
    { viewportWidth: 1280 },
  ).ok, false)
  assert.equal(pickRailToggle(
    [{ index: 0, ariaLabel: 'y', left: 10, top: RAIL_TOGGLE_BAND_MAX_TOP_PX, width: 28, height: 28, inDialog: false }],
    { viewportWidth: 1280 },
  ).ok, false)

  // Inactive instance views (N-ctx) keep layout but are hidden: their controls
  // must not enter the candidate set — otherwise a hidden shell's toggle either
  // wins the topmost rule or ties with the visible one (both measured).
  assert.equal(pickRailToggle([
    { index: 0, ariaLabel: '收起侧边栏', left: 240, top: 22, width: 28, height: 28, visibility: 'hidden', inDialog: false },
    { index: 1, ariaLabel: '收起侧边栏', left: 240, top: 22, width: 28, height: 28, visibility: 'visible', inDialog: false },
  ], { viewportWidth: 1280 }).picked.index, 1, 'the visible view wins; the hidden twin is not a candidate')
  assert.equal(pickRailToggle([
    { index: 0, ariaLabel: '收起侧边栏', left: 240, top: 22, width: 28, height: 28, visibility: 'hidden', inDialog: false },
  ], { viewportWidth: 1280 }).ok, false, 'a hidden-only candidate set is NOT LOCATED, never clicked')
  assert.equal(pickRailToggle([
    { index: 7, ariaLabel: '收起侧边栏', left: 240, top: 22, width: 28, height: 28, visibility: 'visible', inDialog: false },
  ], { viewportWidth: 1280 }).ok, true)

  // Two controls tied for the topmost slot are ambiguous: fail closed, no guess.
  const ambiguous = pickRailToggle([
    { index: 1, ariaLabel: 'a', left: 10, top: 18, width: 28, height: 28, inDialog: false },
    { index: 2, ariaLabel: 'b', left: 60, top: 18, width: 28, height: 28, inDialog: false },
  ], { viewportWidth: 1280 })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.reason, 'ambiguous')
})

test('rail toggle verdict: a click that does not move [data-sidebar-collapsed] is a FAIL', () => {
  const pick = pickRailToggle(RAIL_EXPANDED_BUTTONS, { viewportWidth: 1280 })
  const before = { railCollapsed: false, sections: 1, rows: 1, settingsOpen: false }

  // Happy path: the frame attribute appears on the click and is gone after the
  // restore click (the official contract the mobile plugin also consumes).
  const good = railToggleVerdict({
    pick,
    identity: RAIL_EXPANDED_BUTTONS[1],
    before,
    after: { railCollapsed: true, sections: 0, rows: 0, settingsOpen: false },
    restored: before,
  })
  assert.equal(good.ok, true)
  assert.match(good.evidence, /\[data-sidebar-collapsed\] false → true → false/)

  // THE REGRESSION: the old selector's victim — clicking the source fold toggles
  // its own aria-expanded but leaves the frame attribute untouched.
  const misTarget = railToggleVerdict({
    pick,
    identity: RAIL_EXPANDED_BUTTONS[2],
    before,
    after: { ...before, settingsOpen: false },
    restored: { ...before, settingsOpen: true },
  })
  assert.equal(misTarget.ok, false, 'the leg must never pass when the sidebar did not move')
  assert.match(misTarget.evidence, /点击未折叠/)
  assert.match(misTarget.evidence, /收起全部工作区/, 'the evidence names what was actually clicked')

  // A restore click that never lands (or lands on something else) is a FAIL.
  const notRestored = railToggleVerdict({
    pick,
    identity: RAIL_EXPANDED_BUTTONS[1],
    before,
    after: { railCollapsed: true, sections: 0, rows: 0, settingsOpen: false },
    restored: { railCollapsed: true, sections: 0, rows: 0, settingsOpen: true },
    restoredVia: 'rescan',
  })
  assert.equal(notRestored.ok, false)
  assert.match(notRestored.evidence, /复原失败/)

  // A missing collapse fact is "not checked", not "the click failed": the verdict
  // must not read an unreadable snapshot as a product defect.
  const unreadableFacts = railToggleVerdict({
    pick, identity: RAIL_EXPANDED_BUTTONS[1], before: {}, after: {}, restored: {},
  })
  assert.equal(unreadableFacts.ok, false)
  assert.match(unreadableFacts.evidence, /壳折叠状态不可读/)

  // "Not located" is a shell-control contract: FAIL, never INFO.
  const missing = railToggleVerdict({ pick: { ok: false, reason: 'no-candidate', candidates: [] }, before })
  assert.equal(missing.ok, false)
  assert.match(missing.evidence, /未定位到侧栏导轨开关/)

  // The WRITE boundary is asserted, not promised: design 06 §3.1 keeps the
  // collapsed state in the store, so a preference write across either click
  // fails the leg.
  const cleanPrefs = { present: true, v: 1, sourceFolded: null, foldedKeys: 0, sidebarWidth: null, serverOrder: null, orderByKeys: 0 }
  const goodPrefs = railToggleVerdict({
    pick,
    identity: RAIL_EXPANDED_BUTTONS[1],
    before,
    after: { railCollapsed: true, sections: 0, rows: 0, settingsOpen: false },
    restored: before,
    prefs: { before: cleanPrefs, after: cleanPrefs, restored: cleanPrefs },
  })
  assert.equal(goodPrefs.ok, true)
  assert.match(goodPrefs.evidence, /持久化偏好未变/)

  const wrote = railToggleVerdict({
    pick,
    identity: RAIL_EXPANDED_BUTTONS[1],
    before,
    after: { railCollapsed: true, sections: 0, rows: 0, settingsOpen: false },
    restored: before,
    prefs: { before: cleanPrefs, after: { ...cleanPrefs, sidebarWidth: 320 }, restored: { ...cleanPrefs, sidebarWidth: 320 } },
  })
  assert.equal(wrote.ok, false, 'a persisted preference write must fail W-4')
  assert.match(wrote.evidence, /持久化边界被破坏/)
  assert.match(wrote.evidence, /sidebarWidth/)

  // Identity drift is reported, and it is not a FAIL by itself: the click landed
  // on the control the descriptor names (the effect decides).
  const drifted = railToggleVerdict({
    pick,
    identity: RAIL_EXPANDED_BUTTONS[1],
    drift: true,
    before,
    after: { railCollapsed: true, sections: 0, rows: 0, settingsOpen: false },
    restored: before,
  })
  assert.equal(drifted.ok, true)
  assert.match(drifted.evidence, /索引漂移/)
})

test('source fold verdict: the collapse must show in the geometry, not only in the attribute', () => {
  assert.equal(sourceFoldVerdict({ executed: false, reason: 'attach 不写持久化偏好' }).ok, null)

  const before = { expanded: true, height: 56, rows: 1 }
  const good = sourceFoldVerdict({
    executed: true,
    identity: RAIL_EXPANDED_BUTTONS[2],
    before,
    after: { expanded: false, height: 28, rows: 1 },
    restored: before,
  })
  assert.equal(good.ok, true)
  assert.match(good.evidence, /来源节高度 56 → 28 → 56 px/)

  // The attribute flipped but nothing visible collapsed: design 06 §2.4 is about
  // the collapsed LIST, so this is a FAIL, not a pass.
  const invisible = sourceFoldVerdict({
    executed: true,
    before,
    after: { expanded: false, height: 56, rows: 1 },
    restored: before,
  })
  assert.equal(invisible.ok, false)
  assert.match(invisible.evidence, /点击后未收拢/)

  const notRestored = sourceFoldVerdict({
    executed: true,
    before,
    after: { expanded: false, height: 28, rows: 1 },
    restored: { expanded: true, height: 84, rows: 3 },
  })
  assert.equal(notRestored.ok, false)
  assert.match(notRestored.evidence, /展开未恢复/)

  assert.equal(sourceFoldVerdict({
    executed: true,
    before: { expanded: false, height: 28, rows: 1 },
    after: { expanded: true, height: 56, rows: 1 },
    restored: { expanded: true, height: 56, rows: 1 },
  }).ok, false, 'a start state that is not expanded cannot judge the collapse direction')

  // The fold is a PERSISTED preference: the round trip must leave the stored
  // value exactly as it found it (design 06 §3.1's sourceFolded).
  const foldedPrefs = { present: true, v: 1, sourceFolded: null, foldedKeys: 0, sidebarWidth: null, serverOrder: null, orderByKeys: 0 }
  const netZero = sourceFoldVerdict({
    executed: true, before, after: { expanded: false, height: 28, rows: 1 }, restored: before,
    prefs: { before: foldedPrefs, after: foldedPrefs },
  })
  assert.equal(netZero.ok, true)
  assert.match(netZero.evidence, /持久化偏好未变/)

  const residue = sourceFoldVerdict({
    executed: true, before, after: { expanded: false, height: 28, rows: 1 }, restored: before,
    prefs: { before: foldedPrefs, after: { ...foldedPrefs, sourceFolded: { local: true } } },
  })
  assert.equal(residue.ok, false, 'a leftover sourceFolded entry must fail W-4a')
  assert.match(residue.evidence, /收拢偏好未复原/)
  assert.match(residue.evidence, /sourceFolded/)
})

/**
 * The page-side dumps the structural legs rely on, executed against a fake DOM:
 * the page only REPORTS descriptors, the pure picker decides — so the selection
 * policy itself is covered in CI.
 */
test('walkthrough selection: DOM_FACTS descriptors resolve to the rail toggle (fake DOM)', () => {
  const source = readFileSync(new URL('./walkthrough.mjs', import.meta.url), 'utf8')
  const pattern = 'const DOM_FACTS = `([\\s\\S]*?)`\\n'
  const literal = source.match(new RegExp(pattern))
  assert.ok(literal !== null, 'DOM_FACTS must stay a template literal in walkthrough.mjs')
  const domFacts = new Function('document', 'window', `return (${literal[1]})`)

  const el = ({ className = '', attrs = {}, rect = { left: 0, top: 0, width: 0, height: 0 }, parent = null } = {}) => ({
    className,
    attrs,
    parentElement: parent,
    getAttribute(name) { return this.attrs[name] ?? null },
    getBoundingClientRect() { return { right: rect.left + rect.width, bottom: rect.top + rect.height, ...rect } },
    querySelector: () => null,
    querySelectorAll: () => [],
  })
  const dialog = el({ attrs: { role: 'dialog' }, rect: { left: 192, top: 24, width: 644, height: 572 } })
  const buttons = [
    el({ className: 'brand', attrs: { 'aria-label': '新建会话' }, rect: { left: 12, top: 18, width: 120, height: 28 } }),
    el({ className: 'iconButton toggle', attrs: { 'aria-label': '收起侧边栏' }, rect: { left: 240, top: 22, width: 28, height: 28 } }),
    el({ className: 'sourceFoldToggle', attrs: { 'aria-label': '收起全部工作区', 'aria-expanded': 'true' }, rect: { left: 18, top: 128, width: 16, height: 16 } }),
    el({ className: 'close', attrs: {}, rect: { left: 998, top: 36, width: 28, height: 28 }, parent: dialog }),
  ]
  const document = {
    title: 'dsh-chamber',
    querySelectorAll: selector => (selector === 'button' ? buttons
      : selector === '[role="dialog"][aria-modal="true"]' ? [dialog] : []),
    querySelector: () => null,
  }
  const window = {
    innerWidth: 1280,
    innerHeight: 768,
    // Real pages expose computed styles; the fakes below report the visible view
    // (the N-ctx hidden-view case is covered by the locator test and the fold
    // miniature).
    getComputedStyle: () => ({ visibility: 'visible' }),
  }

  const state = domFacts(document, window)
  assert.equal(state.buttons.length, 4)
  assert.equal(state.railCollapsed, false)
  assert.equal(state.sidebarSources, 0)
  assert.equal(state.settingsOpen, false, 'the plain onboarding modal is not the settings surface')
  assert.equal(state.otherDialogs, 1)
  assert.equal(state.buttons[3].inDialog, true, 'a button inside [role=dialog] is flagged')

  const pick = pickRailToggle(state.buttons, { viewportWidth: state.viewport.width })
  assert.equal(pick.ok, true)
  assert.equal(pick.picked.index, 1, 'the descriptor dump + pure picker select the rail toggle')
  assert.notEqual(pick.picked.index, 2, 'the source fold is never the rail toggle')
})

test('walkthrough clicks: index drift re-locates by identity, a missing control clicks nothing', () => {
  const node = ({ label = null, left = 0, top = 0, width = 28, height = 28, connected = true } = {}) => ({
    isConnected: connected,
    clicks: 0,
    getAttribute: name => (name === 'aria-label' ? label : null),
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
    click() { this.clicks += 1 },
  })
  const buttons = [
    node({ label: '新建会话', left: 12, top: 18, width: 120, height: 28 }),
    node({ label: '收起侧边栏', left: 240, top: 22 }),
  ]
  const document = { querySelectorAll: selector => (selector === 'button' ? buttons : []) }
  const window = {}
  const run = (index, expected) => new Function('document', 'window', `return (${clickButtonAt(index, expected)})`)(document, window)
  const expected = { ariaLabel: '收起侧边栏', left: 240, top: 22 }

  // 1. The index still points at the control: clicked, no drift.
  let result = run(1, expected)
  assert.equal(result.clicked, true)
  assert.equal(result.drifted, false)
  assert.equal(buttons[1].clicks, 1)
  assert.equal(buttons[0].clicks, 0)

  // 2. The page re-rendered and that index now points at ANOTHER control: the
  //    expression re-locates by descriptor and still clicks the right one.
  result = run(0, expected)
  assert.equal(result.clicked, true)
  assert.equal(result.drifted, true, 'a stale index is reported as drift')
  assert.equal(buttons[1].clicks, 2)
  assert.equal(buttons[0].clicks, 0, 'the wrong control is never clicked')

  // 3. The control is gone: nothing is clicked (the leg then fails on the effect).
  result = run(0, { ariaLabel: '打开侧边栏', left: 10, top: 18 })
  assert.equal(result.clicked, false)
  assert.equal(result.drifted, true)
  assert.equal(buttons[0].clicks, 0)
  assert.equal(buttons[1].clicks, 2)

  // 4. Sub-pixel layout shifts inside the tolerance are not drift.
  result = run(1, { ariaLabel: '收起侧边栏', left: 241, top: 23 })
  assert.equal(result.clicked, true)
  assert.equal(result.drifted, false)
  assert.equal(buttons[1].clicks, 3)

  // The restore click re-clicks the SAME node, and refuses a detached one.
  const stashed = new Function('document', 'window', `return (${CLICK_STASHED_BUTTON})`)(document, window)
  assert.equal(stashed.clicked, true)
  assert.equal(buttons[1].clicks, 4)
  buttons[1].isConnected = false
  const detached = new Function('document', 'window', `return (${CLICK_STASHED_BUTTON})`)(document, window)
  assert.equal(detached.clicked, false)
  assert.equal(buttons[1].clicks, 4, 'a detached control is not clicked again')
})

test('walkthrough selection: SOURCE_FOLD_FACTS reports the control identity and geometry (fake DOM)', () => {
  const source = readFileSync(new URL('./walkthrough.mjs', import.meta.url), 'utf8')
  const pattern = 'const SOURCE_FOLD_FACTS = `([\\s\\S]*?)`\\n'
  const literal = source.match(new RegExp(pattern))
  assert.ok(literal !== null, 'SOURCE_FOLD_FACTS must stay a template literal in walkthrough.mjs')
  const foldFacts = new Function('document', 'window', `return (${literal[1]})`)

  const button = ({ label, expanded, left = 18, top = 128 }) => ({
    attrs: { 'aria-label': label, 'aria-expanded': String(expanded) },
    getAttribute(name) { return this.attrs[name] ?? null },
    getBoundingClientRect: () => ({ left, top, width: 16, height: 16, right: left + 16, bottom: top + 16 }),
  })
  const fold = button({ label: '收起全部工作区', expanded: true })
  const sort = button({ label: '排序', expanded: false, left: 200, top: 200 })
  const section = {
    querySelectorAll: selector => (selector === 'button[aria-expanded]' ? [fold, sort]
      : selector === '[data-chamber-row]' ? [{}, {}] : []),
    getBoundingClientRect: () => ({ left: 12, top: 122, width: 260, height: 62, right: 272, bottom: 184 }),
  }
  // A hidden first section (an inactive N-ctx view) must be skipped: folding it
  // would judge a view the user cannot see.
  const hiddenSection = {
    hidden: true,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
  }
  const document = {
    querySelector: selector => (selector === '[data-chamber-section]' ? hiddenSection : null),
    querySelectorAll: selector => (selector === 'button' ? [fold, sort]
      : selector === '[data-chamber-section]' ? [hiddenSection, section] : []),
  }
  const window = { getComputedStyle: el => ({ visibility: el.hidden === true ? 'hidden' : 'visible' }) }
  const facts = foldFacts(document, window)
  assert.equal(facts.found, true)
  assert.equal(facts.expanded, true)
  assert.equal(facts.height, 62)
  assert.equal(facts.rows, 2)
  assert.equal(facts.foldIndex, 0, 'the header-row fold control, not the sort button below it')
  assert.deepEqual(facts.control, { ariaLabel: '收起全部工作区', left: 18, top: 128, width: 16, height: 16 })
})

test('fail-closed inputs: unreadable geometry or preferences never read as a pass', () => {
  // A malformed height is not "no change": NaN fails both <= and > comparisons,
  // so the fold leg would otherwise pass every geometry gate silently.
  for (const height of [undefined, Number.NaN, null]) {
    const broken = sourceFoldVerdict({
      executed: true,
      before: { expanded: true, height, rows: 1 },
      after: { expanded: false, height, rows: 1 },
      restored: { expanded: true, height, rows: 1 },
    })
    assert.equal(broken.ok, false, `height=${height} must fail closed`)
    assert.match(broken.evidence, /来源节几何不可读/)
  }

  // An unparsable or unread snapshot cannot support a "nothing was written"
  // claim — the boundary is then NOT CHECKED, which must not read as a pass.
  const button = { ariaLabel: '收起侧边栏', left: 240, top: 22, width: 28, height: 28 }
  const pick = { ok: true, picked: button }
  const before = { railCollapsed: false }
  const after = { railCollapsed: true }
  const restored = { railCollapsed: false }
  const parsed = { present: true, v: 1, sourceFolded: null, foldedKeys: 0, sidebarWidth: null, serverOrder: null, orderByKeys: 0 }
  assert.equal(viewPrefsUnreadable(null), true)
  assert.equal(viewPrefsUnreadable({ present: false }), false, 'an absent key is a readable fact')
  assert.equal(viewPrefsUnreadable({ present: true, parseError: 'boom' }), true)

  const unparsable = railToggleVerdict({
    pick, identity: button, before, after, restored,
    prefs: { before: { present: true, parseError: 'boom' }, after: parsed, restored: parsed },
  })
  assert.equal(unparsable.ok, false)
  assert.match(unparsable.evidence, /写入边界不可判/)

  const halfRead = railToggleVerdict({ pick, identity: button, before, after, restored, prefs: { before: parsed, after: null, restored: parsed } })
  assert.equal(halfRead.ok, false)
  assert.match(halfRead.evidence, /after/)

  const foldHalfRead = sourceFoldVerdict({
    executed: true,
    before: { expanded: true, height: 56, rows: 1 },
    after: { expanded: false, height: 28, rows: 1 },
    restored: { expanded: true, height: 56, rows: 1 },
    prefs: { before: parsed, after: null },
  })
  assert.equal(foldHalfRead.ok, false)
  assert.match(foldHalfRead.evidence, /写入边界不可判/)

  // A parse error must also change the fingerprint, not hide inside null fields.
  assert.match(viewPrefsFingerprint({ present: true, parseError: 'boom' }), /parseError/)
})

test('rail facts adapter: DOM_FACTS names map onto the verdict snapshot', () => {
  assert.equal(railFactsSnapshot(null), null)
  assert.deepEqual(
    railFactsSnapshot({ railCollapsed: true, sidebarSources: 0, sidebarRows: 0, settingsOpen: false }),
    { railCollapsed: true, sections: 0, rows: 0, settingsOpen: false },
  )
  assert.deepEqual(
    railFactsSnapshot({ sidebarSources: 1, sidebarRows: 2 }),
    { railCollapsed: false, sections: 1, rows: 2, settingsOpen: false },
  )
})

test('view prefs fingerprint: only the persisted fields decide "did this leg write?"', () => {
  const base = { present: true, v: 1, sourceFolded: null, foldedKeys: 0, sidebarWidth: null, serverOrder: null, orderByKeys: 0 }
  assert.equal(viewPrefsFingerprint(base), viewPrefsFingerprint({ ...base }))
  assert.equal(viewPrefsDelta(base, { ...base }), null)
  assert.match(viewPrefsDelta(base, { ...base, sidebarWidth: 320 }), /sidebarWidth null→320/)
  assert.match(viewPrefsDelta(base, { ...base, sourceFolded: { local: true } }), /sourceFolded/)
  assert.equal(viewPrefsFingerprint({ present: false }), 'absent')
  assert.equal(viewPrefsDelta(null, base), null, 'no snapshot taken ⇒ no claim made')
})

test('walkthrough source: the first-match aria-expanded picker is gone, restore is identity-based', () => {
  const source = readFileSync(new URL('./walkthrough.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('CLICK_SIDEBAR_TOGGLE'), false,
    'the old "first aria-expanded in the left half" picker must not come back')
  for (const symbol of ['pickRailToggle(', 'railToggleVerdict(', 'sourceFoldVerdict(', 'clickButtonAt(', 'CLICK_STASHED_BUTTON', 'DOM_FACTS', 'SOURCE_FOLD_FACTS', 'VIEW_PREFS']) {
    assert.ok(source.includes(symbol), `walkthrough.mjs must use ${symbol}`)
  }
  assert.ok(source.includes('allowPersistentWrites'),
    'the state-writing source-fold leg must be gated to the throwaway instance')
})
