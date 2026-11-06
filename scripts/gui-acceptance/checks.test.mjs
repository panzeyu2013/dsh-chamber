/**
 * Unit tests for the GUI acceptance toolbox's judgement layer (checks.mjs). The driving layers need
 * a display, app and CDP port and are local gates (docs/checklists/gui-acceptance-checklist.md), so
 * everything that decides pass/fail is pure and runs in CI like the other policed tools
 * (test:upgrade-tools, test:release-workflow). The walkthrough-SELECTION miniature at the end runs
 * the real page expressions against a fake DOM — their row selection decides whether W-4b judges the
 * product or itself.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  BROWSER_ADDRESS_LABELS, BROWSER_FRAME_CONTRACT, BROWSER_FRAME_CSP_MAX_BYTES, BROWSER_FRAME_CSP_SOURCES,
  BROWSER_FRAME_CSP_V1, BROWSER_SANDBOX_LABELS, BROWSER_TOOLBAR_LABELS,
  EXPECTED_FIXTURE_CONSOLE_NOISE, EXPECTED_FIXTURE_REQUEST_FAILURES,
  HOVER_RACE_FALLBACK_OFFSETS, HOVER_RACE_WINDOW_CAP_MS, KNOWN_UPSTREAM_BOOT_NOISE,
  RAIL_TOGGLE_BAND_MAX_TOP_PX, RAIL_TOGGLE_BOX_MAX_PX, RAIL_TOGGLE_LEFT_FRACTION, TOLERATED_REQUEST_FAILURES,
  applyRequireEmbed, applyRequireHover, browserFrameCspVerdict, browserPanelVerdict, cardIdentityHolds,
  closeReleaseVerdict, createRecorder, deriveSourceIds, embedFrameVerdict, hasSecurityHeaders,
  hoverCardVerdict, hoverDismissVerdict, hoverExclusiveVerdict, hoverRaceVerdict, isAliasFrameUrl,
  isHonestError, isInstanceIndex, isLocalFixtureUrl, isShellIndex, isWriterQuiescent, leakedFileContent,
  normalizeCardText, parseBaseHref, parseInstanceAssets, parsePluginLoaderUrls, parseShellAssets,
  partitionFailures, pickBrowserGuideEntry, pickRailToggle, raceBandForWindow, railToggleVerdict,
  externalExitVerdict, remoteEmbedVerdict, renderMarkdown, railFactsSnapshot, resolveDeclaredUrl, safeJson, sourceFoldVerdict,
  fixtureNoiseRules, pickDirectoryEditButton, pickDirectoryOpenButton, pickNewSessionControl,
  pickWorkspaceChip, sessionBootstrapVerdict, sourceIdAllowsForward, summarize, summarizeNetFailures,
  veilLayeringVerdict, viewPrefsDelta, viewPrefsFingerprint, viewPrefsUnreadable,
  writerEvidence,
} from './checks.mjs'
// The two page-level click expressions are imported so CI can run the REAL strings against a fake
// DOM (identity addressing and the no-click-when-missing rule are behaviour, not source facts).
import {
  BROWSER_LANDSCAPE, CLICK_BROWSER_EXTERNAL, CLICK_BROWSER_GUIDE_ENTRY, CLICK_RIGHT_SIDEBAR_EXPAND,
  CLICK_STASHED_BUTTON, CLOSE_BROWSER_TAB, INSTALL_EMBED_WITNESS, READ_EMBED_WITNESS, RELOAD_BROWSER_PAGE,
  SESSION_BOOTSTRAP_FACTS, SUBMIT_BROWSER_ADDRESS, VEIL_LAYERING_PROBE_INSTALL, VEIL_LAYERING_PROBE_READ,
  clickButtonAt, clickButtonDescriptor, setBrowserAddress, typeDirectoryPath,
} from './walkthrough.mjs'
// The v2 embed fixture (W-14a/W-15's real local document): its routes and the
// release probe are exercised here so a fixture change cannot silently turn the
// driving legs into no-ops.
import { FIXTURE_MARKER, FIXTURE_MESSAGE_TYPE, FIXTURE_XFO_PATH, probeTcpReachable, startEmbedFixture } from './fixture.mjs'
// 一处回归直接驱动真实的 --live 探针：实例文档声明 URL 的解析决定 IP-2/IP-3 的判定。
import { runLiveAcceptance } from './probe.mjs'
// Native flavor mode helpers: the native walkthrough drives the sidecar assembly the packaged Swift shell spawns (WKWebView has no CDP).
import {
  nativePreflight,
  nativeSidecarArgs,
  nativeSidecarEnv,
  resolveNativeSidecarDir,
  resolveNativeWebDistDir,
  runNativeAcceptance,
} from './native.mjs'
const SHELL_HTML = `<!doctype html><html lang="zh-CN"><head><title>dsh-chamber</title>
<script type="module" crossorigin src="/assets/chamber-abc.js"></script>
<link rel="stylesheet" href="/assets/chamber-def.css"></head><body><div id="root"></div></body></html>`
const INSTANCE_HTML = `<!doctype html><html lang="en"><head><base href="./">
<link rel="preload" as="script" href="plugins/??@deepseek-ai/dsh-typert-registry/client.js,@deepseek-ai/dsh-api-gateway/client.js">
<script src="./plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=cddf5581d5d5"></script>
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
  assert.equal(isInstanceIndex(200, INSTANCE_HTML.replace(/<base href="\.\/">/, '')), false,
    'without the base tag the per-entry rewrite is missing')
  assert.equal(isInstanceIndex(200, SHELL_HTML), false)
})

test('asset parsing keeps only what the document itself declares', () => {
  assert.deepEqual(parseShellAssets(SHELL_HTML), ['/assets/chamber-abc.js', '/assets/chamber-def.css'])
  assert.deepEqual(parseInstanceAssets(INSTANCE_HTML), ['assets/index-Df-65__b.js', 'assets/index-b24khbeK.css'])
  assert.deepEqual(parseShellAssets('<html></html>'), [])
})

test('plugin loader urls are decoded and kept as declared for the document base to resolve', () => {
  const urls = parsePluginLoaderUrls(INSTANCE_HTML)
  assert.equal(urls.length, 2)
  assert.equal(urls[0], 'plugins/??@deepseek-ai/dsh-typert-registry/client.js,@deepseek-ai/dsh-api-gateway/client.js',
    'the pinned host declares loader rows document-relative (client-modules comboReference)')
  assert.equal(urls[1], './plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=cddf5581d5d5',
    'the &amp; entity must be decoded — the instance 404s the same path without rev')
  assert.deepEqual(parsePluginLoaderUrls(SHELL_HTML), [])
  // A root-absolute declaration stays root-absolute. Prefixing `/` onto the relative
  // form (the old normalisation) erased the difference the probe has to see: with
  // <base href="./"> the browser resolves it to the ORIGIN root, not the instance prefix.
  const rootAbsolute = INSTANCE_HTML.replace('href="plugins/', 'href="/plugins/')
  assert.equal(parsePluginLoaderUrls(rootAbsolute)[0],
    '/plugins/??@deepseek-ai/dsh-typert-registry/client.js,@deepseek-ai/dsh-api-gateway/client.js')
})

test('base resolution: the document base decides, root-absolute never rides the instance prefix', () => {
  const documentUrl = 'http://127.0.0.1:17500/api/i/local/'
  // 钉住的宿主注入 ./（host/frontend-static/src/index.ts:119）；不声明 base 的文档
  // 以自己的 URL 为 base（HTML 的 fallback base URL）。
  assert.equal(parseBaseHref(INSTANCE_HTML), './')
  assert.equal(parseBaseHref(SHELL_HTML), null)
  const baseHref = parseBaseHref(INSTANCE_HTML)
  const declared = parsePluginLoaderUrls(INSTANCE_HTML)[1]
  assert.equal(resolveDeclaredUrl(declared, { documentUrl, baseHref }),
    '/api/i/local/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=cddf5581d5d5')
  // 文档相对（裸写或 ./ 前缀）落在实例前缀下。
  assert.equal(resolveDeclaredUrl('plugins/??a/client.js&rev=r', { documentUrl, baseHref }),
    '/api/i/local/plugins/??a/client.js&rev=r')
  assert.equal(resolveDeclaredUrl('./plugins/??a/client.js&rev=r', { documentUrl, baseHref }),
    '/api/i/local/plugins/??a/client.js&rev=r')
  assert.equal(resolveDeclaredUrl('assets/index-abc.js', { documentUrl, baseHref }), '/api/i/local/assets/index-abc.js')
  // 根绝对解析到 ORIGIN 根——浏览器就是这么做，这也是两种形态不等价的根据。
  assert.equal(resolveDeclaredUrl('/plugins/??a/client.js&rev=r', { documentUrl, baseHref }),
    '/plugins/??a/client.js&rev=r')
  // base 是另一个决定落点的输入：同一段相对 URL 在 "/" base 下也被重新定根。
  assert.equal(resolveDeclaredUrl('plugins/??a/client.js&rev=r', { documentUrl, baseHref: '/' }),
    '/plugins/??a/client.js&rev=r')
  // 无 <base href> 时文档 URL 自身即 base。
  assert.equal(resolveDeclaredUrl('plugins/??a/client.js&rev=r', { documentUrl }),
    '/api/i/local/plugins/??a/client.js&rev=r')
  // 跨源/无法解析的声明一律拒绝，绝不去别处取。
  for (const declaredUrl of ['https://evil.example/x.js', '//evil.example/x.js', 'data:text/javascript,1', '']) {
    assert.equal(resolveDeclaredUrl(declaredUrl, { documentUrl, baseHref }), null, `${declaredUrl} must not resolve`)
  }
})

/**
 * 回归：实例页的 base 是 `./`，探针必须按浏览器语义解析声明 URL。
 * 旧行为把 base 路径直接拼到声明 URL 前（`base + url`），于是根绝对 `/plugins/…`
 * 即使在其真实落点（origin 根）404 也报 PASS；现在根绝对按 origin 根探、404 即 FAIL，
 * 相对形式仍走实例前缀并通过。
 */
test('live probe: a root-absolute plugin URL that 404s at the origin root FAILs, the relative form passes', async () => {
  const loaderPath = '??@scope/x/client.js&rev=r'
  let instanceHtml = ''
  const server = createServer((request, response) => {
    const target = request.url ?? '/'
    if (target === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok","dsh":{"status":"ready"}}')
      return
    }
    if (target === '/api/i/local/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(instanceHtml)
      return
    }
    // 实例确实在代理前缀下提供该资源；ORIGIN 根什么都不提供（落到下面的 404）。
    if (target === `/api/i/local/plugins/${loaderPath}` || target === '/api/i/local/assets/index-abc.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' })
      response.end('/* instance resource */')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not_found","code":"not_found"}')
  })
  // 升级探测要有个答复，否则探针会等一个没人拥有的 socket。
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsh-gui-base-'))
  try {
    const run = async (declared) => {
      instanceHtml = `<!doctype html><html lang="en"><head><base href="./">
<script src="${declared}"></script>
<script type="module" crossorigin src="./assets/index-abc.js"></script>
<script>window.__DSH_BOOT__={"version":"0.1.5-rc.1"}</script></head><body></body></html>`
      const { results } = await runLiveAcceptance({
        planeOrigin: origin, instanceOrigin: origin, sourceIds: [], outDir,
      })
      return new Map(results.map(entry => [entry.id, entry]))
    }
    const relative = await run(`plugins/${loaderPath}`)
    assert.equal(relative.get('IP-2').ok, true, '实例资源的 ./assets 声明按实例前缀解析')
    assert.equal(relative.get('IP-3').ok, true, '相对声明落在实例前缀，实例提供该资源')
    // 同一个资源声明成根绝对：浏览器问的是 origin 根（那里没有它）。旧代码把实例
    // 前缀拼到两种形态上，因此这里会取到实例资源并 PASS。
    const rootAbsolute = await run(`/plugins/${loaderPath}`)
    assert.equal(rootAbsolute.get('IP-3').ok, false, '根绝对声明按 origin 根解析：404 必须 FAIL')
    assert.match(rootAbsolute.get('IP-3').evidence, /404/)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(outDir, { recursive: true, force: true })
  }
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
  // A reclaimed orphan is listed so the connections page can show it but blocks nothing (api.ts: "GET /api/connections/local/writers → {quiescent,…}").
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
  const partition = partitionFailures([coldStart, '500 http://x/api/connections', '404 http://x/assets/a.js'], TOLERATED_REQUEST_FAILURES)
  assert.equal(partition.tolerated.length, 1)
  assert.deepEqual(partition.unexpected, ['500 http://x/api/connections', '404 http://x/assets/a.js'])
  assert.match(partition.tolerated[0], /design 09 §3\.2/)
  // The same endpoint with a real server answer is NOT tolerated.
  assert.equal(partitionFailures(['500 http://x/api/i/local/api/clientGraph/graph'], TOLERATED_REQUEST_FAILURES).tolerated.length, 0)
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
  // Rows exist wrapped by the anchor-shaped span, but [data-chamber-hovercard-anchor] is absent: FAIL, not INFO.
  const missing = hoverCardVerdict({ cardable: false, anchorCount: 0, wrappedRows: 7 })
  assert.equal(missing.ok, false)
  assert.match(missing.evidence, /data-chamber-hovercard-anchor/)
  assert.match(missing.evidence, /标记契约缺失/)
  // No rows at all (or none cardable by construction) stays INFO.
  assert.equal(hoverCardVerdict({ cardable: false, anchorCount: 0, wrappedRows: 0 }).ok, null)
  // Anchors exist but no row qualified for the viewport: INFO, never the "marker missing" failure.
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
  // A single stranded card IS the reported defect — a FAIL even when the window could not be measured.
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
  // Unusable measurements fall back to the historical fixed band (a copy, never the exported array).
  for (const unusable of [null, undefined, NaN, Infinity, -Infinity, 0, -5, 'x']) {
    assert.deepEqual(raceBandForWindow(unusable), [10, 20, 35, 50, 60], `${String(unusable)} must fall back`)
  }
  assert.notEqual(raceBandForWindow(null), HOVER_RACE_FALLBACK_OFFSETS, 'the caller cannot mutate the constant')
  // A probeable window yields deterministic offsets inside (0, window].
  assert.deepEqual(raceBandForWindow(50), [13, 25, 45])
  assert.deepEqual(raceBandForWindow(3), [1, 2, 3])
  assert.deepEqual(raceBandForWindow(100), [25, 50, 90])
  // Below the probe resolution the offsets collapse to the smallest deliverable step; the verdict calls that non-discriminating.
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
      // A sub-millisecond window cannot hold any deliverable offset (1ms is the smallest step):
      // the VERDICT calls that run non-discriminating (window <= HOVER_RACE_MIN_WINDOW_MS).
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
  // Counting and row selection are ONLY as good as these exact names: the portaled card `<div>`
  // stamps `data-chamber-hovercard` and the hover-target wrapper `<span>` stamps
  // `data-chamber-hovercard-anchor` (the pair the shell pins).
  assert.ok(source.includes('data-chamber-hovercard=""'), 'the card must stamp data-chamber-hovercard')
  assert.ok(source.includes('data-chamber-hovercard-anchor=""'), 'the anchor must stamp data-chamber-hovercard-anchor')
  const markers = [...new Set([...source.matchAll(/data-chamber-hovercard[\w-]*/g)].map(match => match[0]))]
  for (const marker of markers) {
    assert.ok(['data-chamber-hovercard', 'data-chamber-hovercard-anchor'].includes(marker),
      `${marker} is not one of the two contracted hover-card markers`)
  }
})
/**
 * The walkthrough's page-side expressions are strings CDP evaluates in the real page, but their
 * SELECTION logic decides whether W-4b judges the product or itself: this miniature runs the real
 * `HOVER_TARGETS` / `CARD_FACTS` against a fake DOM, guarding the defect that motivated the hardening
 * — the card-less ungrouped bucket carries `data-chamber-row` + `role="treeitem"`, so a row selector
 * ignoring the anchor marker records a false FAIL on an instance whose first fitting row is it.
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
    // The real page provides styles; the fake reports visible so this miniature judges the selection logic.
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }
  const page = (rows, anchors, cards) => ({
    querySelectorAll: selector => (selector.includes('data-chamber-hovercard-anchor') ? anchors
      : selector.includes('data-chamber-hovercard') ? cards : rows),
    body: { querySelectorAll: () => cards },
    visibilityState: 'visible',
  })
  // 1. Only the card-less ungrouped bucket: nothing cardable, nothing anchor-shaped → INFO, never a false FAIL.
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
  // 3. A marker-stamped build: the bucket is never picked, A/B are the anchored rows, the card carries A's title.
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
/** W-4 / W-4a regression fixtures (the descriptors a real --dev instance produced): the rail toggle
 *  carries NO aria-expanded (only a label that flips), so a "first button[aria-expanded] in the
 *  left half" selector would take the SOURCE-SECTION fold switch and the leg would pass without the
 *  sidebar moving — hence the structural pick below. */
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
  // The exact defect: these two candidates carry aria-expanded and a naive pick takes them first.
  assert.notEqual(expanded.picked.index, 3, 'the source-section fold is not the rail toggle')
  assert.notEqual(expanded.picked.index, 9, 'the composer disclosure is not the rail toggle')
  // The rail's new-session button (36×36 at top≈66, measured) must stay OUT of the candidate set:
  // it STARTS A SESSION, and a missing toggle must degrade to no-candidate (FAIL), never to
  // clicking a mutating control.
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
  // Inactive N-ctx views keep layout but are hidden: their controls must not enter the candidate set
  // (otherwise a hidden shell's toggle wins the topmost rule or ties with the visible one — measured).
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
  // Happy path: the frame attribute appears on the click and is gone after the restore click (the mobile plugin's contract too).
  const good = railToggleVerdict({
    pick,
    identity: RAIL_EXPANDED_BUTTONS[1],
    before,
    after: { railCollapsed: true, sections: 0, rows: 0, settingsOpen: false },
    restored: before,
  })
  assert.equal(good.ok, true)
  assert.match(good.evidence, /\[data-sidebar-collapsed\] false → true → false/)
  // A source-fold click toggles its own aria-expanded but leaves the frame attribute untouched.
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
  // A missing collapse fact is "not checked", not "the click failed": an unreadable snapshot is not a product defect.
  const unreadableFacts = railToggleVerdict({
    pick, identity: RAIL_EXPANDED_BUTTONS[1], before: {}, after: {}, restored: {},
  })
  assert.equal(unreadableFacts.ok, false)
  assert.match(unreadableFacts.evidence, /壳折叠状态不可读/)
  // "Not located" is a shell-control contract: FAIL, never INFO.
  const missing = railToggleVerdict({ pick: { ok: false, reason: 'no-candidate', candidates: [] }, before })
  assert.equal(missing.ok, false)
  assert.match(missing.evidence, /未定位到侧栏导轨开关/)
  // The WRITE boundary is asserted, not promised: design 06 §3.1 keeps the collapsed state in the
  // store, so a preference write across either click fails the leg.
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
  // Identity drift is reported, not a FAIL by itself: the click landed on the named control (the effect decides).
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
  // The attribute flipped but nothing visible collapsed: design 06 §2.4 is about the collapsed LIST, so this is a FAIL.
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
 * The page-side dumps the structural legs rely on, executed against a fake DOM: the page only
 * REPORTS descriptors and the pure picker decides, so the selection policy itself is covered in CI.
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
    // Real pages expose computed styles; the fake reports the visible view (the N-ctx hidden-view case is covered by the locator and fold tests).
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
  // 2. The page re-rendered and this index now points at ANOTHER control: the expression re-locates by descriptor.
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
  // A hidden first section (an inactive N-ctx view) must be skipped: folding it would judge a view the user cannot see.
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
  // A malformed height is not "no change": NaN fails both <= and > comparisons, silently passing every geometry gate.
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
  // An unparsable or unread snapshot cannot support a "nothing was written" claim: the boundary is NOT CHECKED, not a pass.
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
  // A fresh --dev instance starts without the store; the first fold creates the
  // default shape. That is not residue; real user state still reports a delta.
  assert.equal(viewPrefsDelta({ present: false }, base), null, 'default-store creation is not residue')
  assert.match(viewPrefsDelta({ present: false }, { ...base, sourceFolded: { local: true } }), /sourceFolded/)
  assert.match(viewPrefsDelta({ present: false }, { ...base, foldedKeys: 1 }), /foldedKeys/)
})
// Native flavor mode (native.mjs)

test('native sidecar preflight: a missing or partial assembly is a named loud skip, a complete one passes', () => {
  const missing = nativePreflight({ sidecarDir: '/nonexistent/native-sidecar' })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /native sidecar assembly is absent or incomplete/)
  assert.match(missing.reason, /build:sidecar/)
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-native-preflight-'))
  try {
    // Entry without the compiled control-plane: still a partial assembly.
    writeFileSync(path.join(dir, 'sidecar.js'), '// sidecar')
    const partial = nativePreflight({ sidecarDir: dir })
    assert.equal(partial.ok, false)
    assert.match(partial.reason, /dist\/control-plane\/index\.js/)
    mkdirSync(path.join(dir, 'dist', 'control-plane'), { recursive: true })
    writeFileSync(path.join(dir, 'dist', 'control-plane', 'index.js'), 'export {}')
    const complete = nativePreflight({ sidecarDir: dir })
    assert.equal(complete.ok, true)
    assert.equal(complete.entry, path.join(dir, 'sidecar.js'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 装配解析器（resolveNativeSidecarDir / resolveNodeBinary）的行为与覆盖语义
// 由 scripts/gates/run-checks.test.mjs 对同一 scripts/lib/sidecar-assembly.mjs 单测。
test('native launch contract: throwaway user data + explicit port + compiled marker', () => {
  assert.deepEqual(nativeSidecarArgs({ userDataDir: '/tmp/u', port: 12345 }), ['--user-data-dir', '/tmp/u', '--port', '12345'])
  assert.deepEqual(nativeSidecarArgs({ userDataDir: '/tmp/u', port: 12345, webDistDir: '/web/dist' }),
    ['--user-data-dir', '/tmp/u', '--port', '12345', '--web-dist-dir', '/web/dist'],
    'a resolved web dist rides the packaged shell flag (sidecar-entry --web-dist-dir), so N-6 judges the real UI and not the stub')
  assert.deepEqual(nativeSidecarArgs({ userDataDir: '/tmp/u', port: 12345, webDistDir: null }),
    ['--user-data-dir', '/tmp/u', '--port', '12345'], 'no resolved web dist means no flag')
  const env = nativeSidecarEnv({ KEEP: '1' })
  assert.equal(env.DSH_CHAMBER_SIDECAR_COMPILED, '1', 'the assembly-relative control-plane import requires the compiled marker')
  assert.equal(env.KEEP, '1', 'the base environment is preserved')
})

test('native web dist probe: explicit wins, else sidecarDir/dist/web → sidecarDir/../dist/web (.app mirror)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-native-webdist-'))
  try {
    const sidecarDir = path.join(root, 'release', 'sidecar')
    // .app 布局镜像：<root>/release/dist/web（= Contents/Resources/dist/web）
    const appMirror = path.join(root, 'release', 'dist', 'web')
    mkdirSync(appMirror, { recursive: true })
    writeFileSync(path.join(appMirror, 'index.html'), SHELL_HTML)
    const detected = resolveNativeWebDistDir({ sidecarDir })
    assert.equal(detected.dir, appMirror)
    assert.equal(detected.source, 'detected')
    assert.equal(detected.ready, true)
    const inAssembly = path.join(sidecarDir, 'dist', 'web')
    mkdirSync(inAssembly, { recursive: true })
    writeFileSync(path.join(inAssembly, 'index.html'), SHELL_HTML)
    assert.equal(resolveNativeWebDistDir({ sidecarDir }).dir, inAssembly, 'sidecarDir/dist/web 先于 ../ 镜像探测')
    const explicit = path.join(root, 'explicit-web')
    mkdirSync(explicit, { recursive: true })
    writeFileSync(path.join(explicit, 'index.html'), SHELL_HTML)
    const byExplicit = resolveNativeWebDistDir({ sidecarDir, webDistDir: ` ${explicit} ` })
    assert.equal(byExplicit.dir, explicit, '显式 --web-dist 优先于探测（含首尾空白）')
    assert.equal(byExplicit.source, 'explicit')
    const empty = path.join(root, 'empty-web')
    mkdirSync(empty, { recursive: true })
    assert.equal(resolveNativeWebDistDir({ sidecarDir, webDistDir: empty }).ready, false,
      '目录存在但没有 index.html 不算携带（判据是页面入口，不是目录）')
    const missing = resolveNativeWebDistDir({ sidecarDir: path.join(root, 'absent', 'sidecar') })
    assert.equal(missing.ready, false)
    assert.equal(missing.source, 'missing')
    assert.deepEqual(missing.candidates,
      [path.join(root, 'absent', 'sidecar', 'dist', 'web'), path.join(root, 'absent', 'dist', 'web')],
      '缺件证据必须点出两个候选（说明缺什么）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native mode skips LOUDLY (not silently) when the assembly is absent, and writes a report', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsh-native-skip-'))
  try {
    const verdict = await runNativeAcceptance({
      sidecarDir: path.join(outDir, 'no-assembly'),
      outDir,
      log: () => {},
    })
    assert.equal(verdict.skipped, true)
    assert.match(verdict.reason, /native sidecar assembly is absent or incomplete/)
    assert.equal(verdict.failed, 0)
    assert.equal(verdict.info, 1, 'the skip rides the INFO count, so a green run does not read as coverage')
    assert.ok(existsSync(verdict.reportPath), 'the skip must be recorded in the report artifact')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('native machine gate: --require-assembly makes an absent assembly a FAIL, never a green skip (G33)', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsh-native-required-'))
  try {
    const verdict = await runNativeAcceptance({
      sidecarDir: path.join(outDir, 'no-assembly'),
      outDir,
      requireAssembly: true,
      log: () => {},
    })
    assert.equal(verdict.skipped, false, 'the machine gate must not report a skip')
    assert.equal(verdict.failed, 1, 'the missing assembly is a failure, not green coverage')
    assert.equal(verdict.info, 0, 'the machine gate does not ride the INFO count')
    assert.equal(verdict.results[0].ok, false)
    assert.match(verdict.reason, /native sidecar assembly is absent or incomplete/)
    assert.ok(existsSync(verdict.reportPath), 'the failure must be recorded in the report artifact')
    const json = JSON.parse(readFileSync(path.join(outDir, 'gui-native-report.json'), 'utf8'))
    assert.equal(json.skipped, false)
    assert.match(json.reason, /build:sidecar/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

/**
 * 最小控制面替身：attach 腿只发只读 GET（/health、/api/connections、/、/assets/*）。
 * @param {{ shellHtml?: string|null }} [options] - shellHtml 非 null 时 `/` 返回壳文档（否则 404）。
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>} 替身句柄。
 */
function startStubPlane({ shellHtml = null } = {}) {
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
    if (request.url === '/api/connections') {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end('{"error":"forbidden","code":"origin_forbidden"}')
      return
    }
    if (request.url === '/' && shellHtml !== null) {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(shellHtml)
      return
    }
    if (request.url?.startsWith('/assets/') === true) {
      response.writeHead(200, { 'content-type': 'application/javascript' })
      response.end('/* asset */')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not_found","code":"not_found"}')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({
      origin: `http://127.0.0.1:${address.port}`,
      close: () => new Promise((done) => server.close(done)),
    })
  }))
}

test('native attach: no ready frame and no lifecycle are INFO, never a fake PASS (N-1/N-7)', async () => {
  const plane = await startStubPlane({ shellHtml: SHELL_HTML })
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsh-native-attach-'))
  try {
    const verdict = await runNativeAcceptance({
      sidecarDir: path.join(outDir, 'no-assembly'),
      outDir,
      attachPlaneOrigin: plane.origin,
      log: () => {},
    })
    const byId = new Map(verdict.results.map(entry => [entry.id, entry]))
    assert.equal(byId.get('N-1').ok, null, 'attach 未观测 ready 帧 ⇒ INFO（旧形态恒 true 是假通过）')
    assert.match(byId.get('N-1').evidence, /attach/)
    assert.equal(byId.get('N-7').ok, null, 'attach 无 sidecar 生命周期 ⇒ INFO（旧形态直接缺行）')
    assert.match(byId.get('N-7').evidence, /无 sidecar 生命周期/)
    assert.equal(byId.get('N-6').ok, true, '运行中的控制面伺服壳 index + 声明资源时 N-6 照常判 PASS')
    assert.equal(verdict.failed, 0)
    assert.equal(verdict.info, 2, 'N-1/N-7 按未执行计入 INFO')
    assert.equal(verdict.passed, 3, 'N-4/N-5/N-6 才是本次真正判过的项')
  } finally {
    await plane.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('native N-6 tiers: a missing web dist is INFO by default and FAIL under --require-assembly', async () => {
  const plane = await startStubPlane()
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsh-native-n6-gate-'))
  const sidecarDir = path.join(outDir, 'no-assembly')
  try {
    const relaxed = await runNativeAcceptance({ sidecarDir, outDir: path.join(outDir, 'relaxed'), attachPlaneOrigin: plane.origin, log: () => {} })
    const relaxedN6 = relaxed.results.find(entry => entry.id === 'N-6')
    assert.equal(relaxedN6.ok, null, '默认档：腿没执行 ⇒ INFO（不假装通过，也不判红）')
    assert.match(relaxedN6.evidence, /默认档/)
    assert.match(relaxedN6.evidence, /index\.html/, 'INFO 也要说清缺什么')
    assert.equal(relaxed.failed, 0)
    const strict = await runNativeAcceptance({ sidecarDir, outDir: path.join(outDir, 'strict'), attachPlaneOrigin: plane.origin, requireAssembly: true, log: () => {} })
    const strictN6 = strict.results.find(entry => entry.id === 'N-6')
    assert.equal(strictN6.ok, false, '机器门：N-6 无法执行 ⇒ FAIL（门不得在腿没跑时变绿）')
    assert.match(strictN6.title, /无法执行/)
    assert.match(strictN6.evidence, /--require-assembly/)
    assert.equal(strict.failed, 1)
    // 显式 --web-dist 指向不完整目录：证据必须点名那个 index.html
    const emptyWeb = path.join(outDir, 'empty-web')
    mkdirSync(emptyWeb, { recursive: true })
    const explicit = await runNativeAcceptance({
      sidecarDir, outDir: path.join(outDir, 'explicit'), attachPlaneOrigin: plane.origin,
      requireAssembly: true, webDistDir: emptyWeb, log: () => {},
    })
    const explicitN6 = explicit.results.find(entry => entry.id === 'N-6')
    assert.equal(explicitN6.ok, false)
    assert.match(explicitN6.title, /--web-dist 目录不完整/)
    assert.ok(explicitN6.evidence.includes(path.join(emptyWeb, 'index.html')), 'FAIL 证据点名显式目录缺的 index.html')
  } finally {
    await plane.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('native mode drives the REAL packaged sidecar assembly when present (loud skip otherwise) (G20)', async (t) => {
  const sidecarDir = resolveNativeSidecarDir()
  const preflight = nativePreflight({ sidecarDir })
  if (!preflight.ok) {
    t.diagnostic('SKIP: ' + preflight.reason)
    return
  }
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsh-native-real-'))
  try {
    const verdict = await runNativeAcceptance({ sidecarDir, outDir, log: () => {} })
    assert.equal(verdict.skipped, false)
    assert.equal(verdict.failed, 0, 'the real native sidecar walkthrough must be green: ' + JSON.stringify(verdict.results.filter(r => r.ok === false)))
    const ids = verdict.results.map(entry => entry.id)
    for (const expected of ['N-1', 'N-2', 'N-3', 'N-4', 'N-5', 'N-7']) {
      assert.ok(ids.includes(expected), `${expected} must be part of the native walkthrough`)
    }
    assert.ok(existsSync(verdict.reportPath))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('walkthrough source: the first-match aria-expanded picker is gone, restore is identity-based', () => {
  const source = readFileSync(new URL('./walkthrough.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('CLICK_SIDEBAR_TOGGLE'), false,
    'the old "first aria-expanded in the left half" picker must not come back')
  for (const symbol of ['pickRailToggle(', 'railToggleVerdict(', 'sourceFoldVerdict(', 'clickButtonAt(', 'CLICK_STASHED_BUTTON', 'DOM_FACTS', 'SOURCE_FOLD_FACTS', 'VIEW_PREFS', 'VEIL_LAYERING_PROBE_INSTALL', 'VEIL_LAYERING_PROBE_READ', 'veilLayeringVerdict(']) {
    assert.ok(source.includes(symbol), `walkthrough.mjs must use ${symbol}`)
  }
  assert.ok(source.includes('allowPersistentWrites'),
    'the state-writing source-fold leg must be gated to the throwaway instance')
})

test('veil layering: a broken probe is INFO, never a PASS', () => {
  const broken = veilLayeringVerdict({
    veilFrames: 9,
    samples: [{ point: '[data-composer-seat]', winner: 'veil', count: 12 }],
    error: 'TypeError: document.elementFromPoint is not a function',
  })
  assert.equal(broken.ok, null, '探针异常 ⇒ 未判定（fail-closed），不能因为前半窗采样过就报 PASS')
  assert.match(broken.evidence, /探针异常/)
})

test('veil layering: PASS evidence states which segment was sampled', () => {
  const held = veilLayeringVerdict({
    veilFrames: 8,
    samples: [{ point: '[data-composer-seat]', winner: 'veil', count: 8 }],
    heldFrames: 8,
    bootFrames: 0,
  })
  assert.equal(held.ok, true)
  assert.match(held.evidence, /持有态 8 帧 \/ boot 段 0 帧/)
  assert.match(held.evidence, /完整判别力/)
})

test('veil layering: a tenant above the veil fails, veil-only passes, portal is a note', () => {
  assert.equal(veilLayeringVerdict({ veilFrames: 0, samples: [] }).ok, null,
    'no veil frames observed = INFO: the layering question was not asked this run')
  assert.equal(veilLayeringVerdict({ veilFrames: 3, samples: [] }).ok, null,
    'veil seen but no anchor to sample = INFO, never a silent pass')
  const pass = veilLayeringVerdict({
    veilFrames: 12,
    samples: [
      { point: '[data-composer-seat]', winner: 'veil', count: 24, hit: 'div.instance-loading' },
      { point: '[data-composer-input]', winner: 'none', count: 4 },
    ],
  })
  assert.equal(pass.ok, true, 'every sampled point resolved to the veil = PASS')
  assert.match(pass.evidence, /均由遮罩获胜/)
  const portal = veilLayeringVerdict({
    veilFrames: 6,
    samples: [
      { point: '[data-composer-seat]', winner: 'veil', count: 2 },
      { point: '[data-conversation-scroll]', winner: 'portal', count: 3, hit: 'div.portal' },
    ],
  })
  assert.equal(portal.ok, true, 'a document-level portal is the registered residual: recorded, not failed')
  assert.match(portal.evidence, /body portal/)
  const fail = veilLayeringVerdict({
    veilFrames: 9,
    samples: [
      { point: '[data-composer-seat]', winner: 'veil', count: 12 },
      { point: '[data-composer-seat]', winner: 'tenant', count: 5, hit: 'div.composerSeat' },
    ],
  })
  assert.equal(fail.ok, false, 'a tenant element painting above the veil = FAIL (the P0 invariant)')
  assert.match(fail.evidence, /composerSeat/)
  assert.match(fail.evidence, /累计 5 次采样/)
})

/**
 * The REAL probe expressions, against a fake DOM: their owner classification decides
 * whether the acceptance leg judges the product (a tenant above the veil = FAIL) or
 * itself. `elementFromPoint` is scripted per scenario; every node answers `closest`
 * for exactly the selectors the probe asks about.
 */
function probeNodes({ hit, veilIn = 'active' }) {
  const node = (tag, cls, rect, closest) => ({ tagName: tag, className: cls, getBoundingClientRect: () => rect, closest })
  const rect = { left: 100, top: 100, width: 200, height: 100, bottom: 200 }
  const veil = node('DIV', 'instance-loading', rect, selector => (selector === '.instance-loading' ? veil : null))
  const composer = node('DIV', 'composerSeat', rect, selector => (selector === '.instance-shell' ? { shell: true } : null))
  const portal = node('DIV', 'portal', rect, () => null)
  const anchors = { '[data-composer-seat]': composer, '[data-composer-input]': composer, '[data-conversation-scroll]': composer }
  // 活动视图作用域：探针只在这里查遮罩与锚点。SCOPE 字面量与 walkthrough.mjs 的表达式
  // 一致——表达式漂移时这里返回 null，"veil 获胜"剧本会红。
  const activeView = {
    querySelector: selector => (selector === '.instance-loading' ? (veilIn === 'active' ? veil : null) : anchors[selector] ?? null),
  }
  return {
    veil, composer, portal,
    document: {
      querySelector: selector => {
        if (selector === '.instance-view:not(.instance-hidden):not(.instance-pending)') return activeView
        // 全文档口径的回归探测：隐藏视图的遮罩照样命中。
        if (selector === '.instance-loading') return veil
        if (anchors[selector] !== undefined) return anchors[selector]
        return null
      },
      elementFromPoint: () => hit(veil, composer, portal),
    },
  }
}

function runVeilProbe(hit, options = {}) {
  const built = probeNodes({ hit, ...options })
  const win = { innerWidth: 1000, innerHeight: 800 }
  let queued = 0
  const raf = callback => { if (queued >= 12) return 0; queued += 1; callback(); return queued }
  // getComputedStyle 作为形参注入：Node 里它不存在，不注入的话
  // 探针的"computed hidden 不算可见遮罩"分支永远零覆盖。
  const install = new Function('window', 'document', 'requestAnimationFrame', 'Date', 'getComputedStyle', 'return (' + VEIL_LAYERING_PROBE_INSTALL + ')')
  const read = new Function('window', 'document', 'return (' + VEIL_LAYERING_PROBE_READ + ')')
  const installed = install(win, built.document, raf, Date, options.computedStyle)
  return { installed, state: read(win, built.document) }
}

test('veil probe: real expressions classify veil / tenant / portal hits', () => {
  const veilWins = runVeilProbe(veil => veil)
  assert.equal(veilWins.installed.installed, true, 'the install expression must run against a plain DOM')
  assert.ok(veilWins.state.veilFrames > 0, 'frames with a veil on screen must be counted')
  assert.ok(veilWins.state.samples.every(sample => sample.winner === 'veil'), 'a veil hit wins')
  assert.equal(veilLayeringVerdict(veilWins.state).ok, true, 'veil-only samples pass')

  const tenantWins = runVeilProbe((_veil, composer) => composer)
  assert.ok(tenantWins.state.samples.some(sample => sample.winner === 'tenant'), 'a shell hit is the tenant')
  assert.equal(veilLayeringVerdict(tenantWins.state).ok, false, 'and that is the FAIL this leg exists for')

  const portalWins = runVeilProbe((_veil, _composer, portal) => portal)
  assert.ok(portalWins.state.samples.some(sample => sample.winner === 'portal'), 'anything else is a document-level portal')
  assert.equal(veilLayeringVerdict(portalWins.state).ok, true, 'the registered residual must not turn the leg red')

  const emptyWin = { innerWidth: 1000, innerHeight: 800 }
  const readAgain = new Function('window', 'document', 'return (' + VEIL_LAYERING_PROBE_READ + ')')(emptyWin, { querySelector: () => null })
  assert.equal(readAgain.veilFrames, 0, 'reading without an install is an honest empty result, not a throw')
})

/**
 * 回归锁：后台预热/收割视图（.instance-pending，只
 * visibility:hidden）的遮罩仍在 DOM 里；若探针按全文档口径取遮罩、却把活动视图的
 * 锚点配上去，健康构建会被判成"租客画在遮罩之上"的假 FAIL。探针只认活动视图
 * 作用域：隐藏视图的遮罩不构成"遮罩可见帧" ⇒ 本腿记 INFO 而不是红。
 */
test('veil probe: a background view\'s veil is not paired with the active view', () => {
  const scene = runVeilProbe((_veil, composer) => composer, { veilIn: 'hidden' })
  assert.equal(scene.state.veilFrames, 0, '隐藏视图的遮罩不算遮罩帧（作用域限定为活动视图）')
  assert.equal(
    veilLayeringVerdict(scene.state).ok,
    null,
    '没有遮罩帧 = INFO；旧的全文档口径在这种场景下会判出 tenant FAIL（假红）',
  )
  const active = runVeilProbe(veil => veil)
  assert.ok(active.state.veilFrames > 0, '活动视图的遮罩仍必须被计入（修正不能把探针探空）')
})

test('veil probe: a computed-hidden veil is not a visible veil frame', () => {
  const hidden = runVeilProbe(veil => veil, { computedStyle: () => ({ visibility: 'hidden', display: 'block' }) })
  assert.ok(hidden.state.frames > 0, '探针必须真的跑了帧')
  assert.equal(hidden.state.veilFrames, 0, 'computed visibility:hidden 的遮罩不算"遮罩可见帧"（双保险真实生效）')
  assert.equal(veilLayeringVerdict(hidden.state).ok, null, '没有遮罩帧 ⇒ INFO')
  const visible = runVeilProbe(veil => veil, { computedStyle: () => ({ visibility: 'visible', display: 'block' }) })
  assert.ok(visible.state.veilFrames > 0, '同一剧本下可见遮罩必须被计入（证明上一句不是因为探针没跑）')
})

/**
 * 严格旗标的**归属必须可机器校验**——真正会切换的两个腿各带自己的
 * `--require-switch`，而走查（walkthrough）没有切换腿，因此**不得**给它加同名旗标：
 * 一个「看门却不管事」的旗标正是这条纪律要消灭的假绿来源（看着严格，实际什么都没门住）。
 */
test('I15: the switch legs own --require-switch and the walkthrough declares none', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const measure = readFileSync(path.join(root, 'scripts/perf/switch-measure.mjs'), 'utf8')
  const probe = readFileSync(path.join(root, 'scripts/perf/switch-frame-probe.mjs'), 'utf8')
  const walkthrough = readFileSync(new URL('./walkthrough.mjs', import.meta.url), 'utf8')
  // 尺子：严格档必须真的接在「未绘制目标实例」这个判据上（不是只解析了一个旗标）。
  assert.match(measure, /--require-switch/)
  assert.match(measure, /function assertPainted/)
  assert.match(measure, /paintSeen/)
  // 探针：自带严格档 + 三形态白帧判据。
  assert.match(probe, /--require-switch/)
  // 走查：没有切换腿 ⇒ 不得声明该旗标（否则就是假严格）。
  assert.doesNotMatch(walkthrough, /require-switch/)
})

// ============================================================================
// Browser (design 28 §16.9): the upstream ui-sidebar-browser iframe fork.
// Part 1 = product source-lock mirrors; part 2 = pure verdicts; part 3 = the
// REAL page expressions against a fake upstream DOM; part 4 = fixture + SH-7
// over real HTTP.
// ============================================================================

const readProduct = relative => readFileSync(new URL('../../packages/dsh-chamber-client-ui-browser/' + relative, import.meta.url), 'utf8')
const BROWSER_IFRAME_PRESENTATION = readProduct('src/client/view/IframePresentation.ts')
const BROWSER_BODY_SOURCE = readProduct('src/client/view/BrowserBody.tsx')
const BROWSER_DEFINITION_SOURCE = readProduct('src/client/definition.tsx')
const BROWSER_INDEX_SOURCE = readProduct('src/client/index.ts')
const BROWSER_SOURCE_GATE = readProduct('src/shared/source.ts')
const BROWSER_RESOLVER_SOURCE = readProduct('src/client/browser/ForwardFrameResolver.ts')
const BROWSER_LOCALES = readProduct('src/client/locales.ts')
const WIRE_FORWARD_SOURCE = readFileSync(new URL('../../packages/dsh-chamber-wire/src/forward.ts', import.meta.url), 'utf8')
const CONTROL_PLANE_FRAME_SOURCES = readFileSync(new URL('../../packages/control-plane/src/browser-frame-sources.ts', import.meta.url), 'utf8')
const DESKTOP_MAIN_SOURCE = readFileSync(new URL('../../packages/desktop/main.ts', import.meta.url), 'utf8')
const BROWSER_WALKTHROUGH = readFileSync(new URL('./walkthrough.mjs', import.meta.url), 'utf8')

test('upstream fork contract mirror: sandbox/referrer/marker/guide kind agree with the product source', () => {
  const sandboxMatch = /export const WEB_BROWSER_SANDBOX = '([^']+)'/u.exec(BROWSER_IFRAME_PRESENTATION)
  assert.notEqual(sandboxMatch, null, 'the upstream sandbox constant must stay readable')
  assert.equal(sandboxMatch[1], BROWSER_FRAME_CONTRACT.sandbox, 'the sandbox mirror drifted from IframePresentation.ts')
  assert.deepEqual(sandboxMatch[1].split(' '), [...BROWSER_FRAME_CONTRACT.sandboxTokens])
  for (const marker of [
    "element.referrerPolicy = 'no-referrer'",
    "element.dataset.sidebarBrowserFrame = 'iframe'",
    "element.setAttribute('sandbox', WEB_BROWSER_SANDBOX)",
    'element.src = current.url',
  ]) {
    assert.equal(BROWSER_IFRAME_PRESENTATION.includes(marker), true, marker)
  }
  assert.equal(BROWSER_FRAME_CONTRACT.referrerPolicy, 'no-referrer')
  assert.equal(BROWSER_FRAME_CONTRACT.frameMarkerValue, 'iframe', 'the dataset VALUE is the upstream contract, not mere presence')
  const kindMatch = /export const BROWSER_KIND = '([^']+)'/u.exec(BROWSER_DEFINITION_SOURCE)
  assert.equal(kindMatch[1], 'browser', 'the fork keeps upstream tab kind browser')
  assert.equal(BROWSER_FRAME_CONTRACT.guideEntryKind, kindMatch[1])
  for (const marker of [
    'className={css.root}',
    'className={css.toolbar}',
    "aria-label={t('address.placeholder')}",
    "aria-label={t('back')}",
    "aria-label={t('forward')}",
    "aria-label={t('reload')}",
    "aria-label={t('go')}",
    "aria-label={t('external')}",
    "window.open(externalUrl, '_blank', 'noopener,noreferrer')",
    'className={css.content}',
    'className={css.viewport}',
    'role="status"',
    'role="alert"',
  ]) {
    assert.equal(BROWSER_BODY_SOURCE.includes(marker), true, marker)
  }
  assert.match(BROWSER_RESOLVER_SOURCE, /FORWARD_TARGET_HOST = '127\.0\.0\.1'/u)
  assert.match(BROWSER_RESOLVER_SOURCE, /controller\.attach\(/u)
  assert.match(BROWSER_RESOLVER_SOURCE, /detachCurrent\(\)/u)
  assert.match(BROWSER_RESOLVER_SOURCE, /return target\.url/u, 'local/direct targets keep the upstream URL')
  assert.match(BROWSER_INDEX_SOURCE, /resolveBrowserEntry\(/u, 'the chamber source gate must stay')
  assert.match(BROWSER_SOURCE_GATE, /transport !== 'local' && transport !== 'ssh'/u, 'plain-http sources are excluded')
  assert.match(BROWSER_SOURCE_GATE, /prefix: 'dsh-'/u)
  assert.match(BROWSER_SOURCE_GATE, /prefix: 'gateway-'/u)
  for (const gone of [
    'src/shared/frame-policy.ts', 'src/client/BrowserPanel.tsx', 'src/client/BrowserPanel.module.css',
    'src/shared/launcher-model.ts', 'src/shared/address.ts', 'src/locales.ts',
  ]) {
    assert.equal(existsSync(new URL('../../packages/dsh-chamber-client-ui-browser/' + gone, import.meta.url)), false, gone)
  }
  for (const forbidden of ['data-chamber-browser-panel', 'data-frame-phase', 'chamber-remote-browser', 'attachedRows']) {
    assert.equal(BROWSER_WALKTHROUGH.includes(forbidden), false, 'the acceptance layer must not lock the deleted self-built UI: ' + forbidden)
  }
  for (const marker of [
    'iframe[data-sidebar-browser-frame]',
    "'[data-sidebar-right-guide-entry]'",
    "'[data-sidebar-right-tab]'",
    "'[data-dockkit-tab-close]'",
    "'[data-sidebar-right-expand]'",
    'data-sidebar-right-panel',
    "=== 'browser'",
    'http://127.0.0.1:',
    'window.open',
  ]) {
    assert.equal(BROWSER_WALKTHROUGH.includes(marker), true, marker)
  }
})

test('copy mirrors: the acceptance label allowlists cover the upstream zh dictionary', () => {
  const zhValue = key => {
    const escaped = key.replace(/\./gu, '\\.')
    const match = new RegExp("(?:'" + escaped + "'|" + escaped + "): '([^']*)'", 'u').exec(BROWSER_LOCALES)
    assert.notEqual(match, null, 'missing locale key ' + key)
    return match[1]
  }
  assert.equal(BROWSER_ADDRESS_LABELS.includes(zhValue('address.placeholder')), true)
  for (const [role, labels] of Object.entries(BROWSER_TOOLBAR_LABELS)) {
    assert.notEqual(labels.indexOf(zhValue(role)), -1, 'toolbar mirror missing ' + role)
  }
  assert.equal(BROWSER_SANDBOX_LABELS.disable.indexOf(zhValue('sandbox.disable')) !== -1, true)
  assert.equal(BROWSER_SANDBOX_LABELS.enable.indexOf(zhValue('sandbox.enable')) !== -1, true)
})

test('CSP frame-src mirror: wire sources + the desktop bare http:/https: widening; v1 default stays blob:', () => {
  const range = /FORWARD_ALIAS_OCTETS = Object\.freeze\(\{ min: (\d+), max: (\d+), capacity: \d+ \}\)/u.exec(WIRE_FORWARD_SOURCE)
  assert.notEqual(range, null, 'the wire alias range must stay readable')
  const hosts = [.../FORWARD_LOCAL_LOOPBACK_HOSTS = Object\.freeze\(\[([^\]]*)\]/u.exec(WIRE_FORWARD_SOURCE)[1]
    .matchAll(/'([^']+)'/gu)].map(match => match[1])
  assert.deepEqual(hosts, ['127.0.0.1', 'localhost'])
  const expected = [
    'blob:',
    ...hosts.map(host => 'http://' + host + ':*'),
    ...Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_unused, index) => 'http://127.0.0.' + String(index + Number(range[1])) + ':*'),
    'http:',
    'https:',
  ]
  assert.deepEqual([...BROWSER_FRAME_CSP_SOURCES], expected, 'the SH-7 mirror drifted from wire + desktop widening')
  assert.match(CONTROL_PLANE_FRAME_SOURCES, /ANY_HTTP_SCHEME_FRAME_SOURCES: ReadonlySet<string> = new Set\(\['http:', 'https:'\]\)/u)
  assert.match(CONTROL_PLANE_FRAME_SOURCES, /DEFAULT_BROWSER_FRAME_SOURCES: readonly string\[\] = Object\.freeze\(\['blob:'\]\)/u)
  assert.match(CONTROL_PLANE_FRAME_SOURCES, /isAllowedBrowserFrameSource/u)
  assert.match(DESKTOP_MAIN_SOURCE, /frameSources: \[\.\.\.forwardFrameSources\(\), 'http:', 'https:'\]/u)
  assert.deepEqual([...BROWSER_FRAME_CSP_V1], ['blob:'])
})

test('SH-7: the v2 frame-src set passes, v1 stays INFO, forbidden sources and drift FAIL', () => {
  const v2 = "default-src 'self'; frame-src " + BROWSER_FRAME_CSP_SOURCES.join(' ') + "; frame-ancestors 'none'; script-src 'self'"
  const pass = browserFrameCspVerdict(v2)
  assert.equal(pass.ok, true)
  assert.equal(pass.shape, 'v2')
  assert.match(pass.evidence, /258 源/u)
  const v1 = "default-src 'self'; frame-src blob:; frame-ancestors 'none'; script-src 'self'"
  assert.equal(browserFrameCspVerdict(v1).ok, null)
  assert.equal(browserFrameCspVerdict(v1).shape, 'v1')
  assert.equal(applyRequireEmbed(browserFrameCspVerdict(v1), true).ok, false)
  assert.match(applyRequireEmbed(browserFrameCspVerdict(v1), true).evidence, /--require-embed/)
  assert.equal(applyRequireEmbed(browserFrameCspVerdict(v2), true).ok, true)
  for (const widened of ["'self'", '*', 'data:']) {
    const verdict = browserFrameCspVerdict("default-src 'self'; frame-src blob: " + widened + "; frame-ancestors 'none'")
    assert.equal(verdict.ok, false, widened + ' must FAIL')
    assert.match(verdict.evidence, /禁止源/u)
  }
  const old256 = "default-src 'self'; frame-src " + BROWSER_FRAME_CSP_SOURCES.slice(0, -2).join(' ') + "; frame-ancestors 'none'"
  const oldVerdict = browserFrameCspVerdict(old256)
  assert.equal(oldVerdict.ok, false)
  assert.equal(oldVerdict.shape, 'drift')
  assert.match(oldVerdict.evidence, /http:/u)
  assert.equal(browserFrameCspVerdict("default-src 'self'; script-src 'self'").ok, false)
  assert.equal(browserFrameCspVerdict("default-src 'self'; frame-src blob:; frame-ancestors *").ok, false)
  assert.equal(browserFrameCspVerdict('').ok, false)
  const partial = "default-src 'self'; frame-src blob: http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'"
  const partialVerdict = browserFrameCspVerdict(partial)
  assert.equal(partialVerdict.ok, false)
  assert.equal(partialVerdict.shape, 'drift')
  assert.match(partialVerdict.evidence, /127\.0\.0\.2/iu)
})

test('CSP size ceiling: the exact v2 set over the 8KB header ceiling FAILs', () => {
  const overLong = "default-src 'self'; frame-src " + BROWSER_FRAME_CSP_SOURCES.join(' ')
    + "; frame-ancestors 'none'; report-uri " + 'x'.repeat(BROWSER_FRAME_CSP_MAX_BYTES)
  const verdict = browserFrameCspVerdict(overLong)
  assert.equal(verdict.ok, false)
  assert.match(verdict.evidence, /8192/u)
})

test('browser guide entry picker: kind marker + visibility only, ambiguity fails closed', () => {
  const visible = { index: 1, kind: 'browser', visible: true, labelLength: 2 }
  const hidden = { index: 0, kind: 'browser', visible: false, labelLength: 2 }
  const other = { index: 2, kind: 'terminal', visible: true, labelLength: 4 }
  assert.equal(pickBrowserGuideEntry([hidden, visible, other]).ok, true)
  assert.equal(pickBrowserGuideEntry([hidden, visible, other]).picked.index, 1)
  assert.equal(pickBrowserGuideEntry([hidden, other]).reason, 'no-entry')
  assert.equal(pickBrowserGuideEntry([visible, { ...visible, index: 3 }]).reason, 'ambiguous')
})

/** One upstream BrowserBody fact set for verdict tests. */
function bodyFacts(overrides = {}) {
  return {
    visible: true,
    addressInput: true,
    addressLabel: BROWSER_ADDRESS_LABELS[0],
    addressValue: 'http://127.0.0.1:41234/',
    toolbarRoles: ['back', 'forward', 'reload', 'go', 'external'],
    externalButton: true,
    externalEnabled: true,
    sandboxToggle: true,
    sandboxed: true,
    busy: false,
    failureTexts: [],
    tabId: 'tab-browser',
    frameCount: 0,
    ...overrides,
  }
}

/** One upstream iframe fact set for verdict tests. */
function frameFacts(overrides = {}) {
  return {
    src: 'http://127.0.0.1:41234/',
    sandbox: BROWSER_FRAME_CONTRACT.sandbox,
    referrerpolicy: BROWSER_FRAME_CONTRACT.referrerPolicy,
    markerValue: 'iframe',
    insideBody: true,
    ...overrides,
  }
}

const FIXTURE_MESSAGE = Object.freeze({ type: FIXTURE_MESSAGE_TYPE, marker: FIXTURE_MARKER })

test('W-13 verdict: upstream BrowserBody structure, toolbar roles and sandbox default', () => {
  const pass = browserPanelVerdict({
    hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true,
    openedVia: 'clicked-entry', bodyCount: 1, bodies: [bodyFacts()],
  })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /toolbar=/)
  assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: false }).ok, null)
  assert.equal(browserPanelVerdict({
    hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: false, bodyCount: 1, bodies: [bodyFacts()],
  }).ok, false)
  assert.equal(browserPanelVerdict({
    hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true,
    entryPick: { ok: true, picked: { index: 1 } }, openedVia: 'clicked-entry', bodyCount: 0, bodies: [],
  }).ok, false)
  assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true, bodyCount: 2, bodies: [bodyFacts(), bodyFacts()] }).ok, false)
  for (const missing of ['back', 'forward', 'reload', 'go', 'external']) {
    const body = bodyFacts({ toolbarRoles: ['back', 'forward', 'reload', 'go', 'external'].filter(role => role !== missing) })
    assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true, bodyCount: 1, bodies: [body] }).ok, false, missing)
  }
  assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true, bodyCount: 1, bodies: [bodyFacts({ addressInput: false })] }).ok, false)
  assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true, bodyCount: 1, bodies: [bodyFacts({ sandboxToggle: false })] }).ok, false)
  assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true, bodyCount: 1, bodies: [bodyFacts({ sandboxed: false })] }).ok, false)
  assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true, bodyCount: 1, bodies: [bodyFacts({ busy: null })] }).ok, false)
  assert.equal(browserPanelVerdict({ hasActiveView: true, activeSource: 'local', sessionPresent: true, sessionOpen: true, bodyCount: 1, bodies: [bodyFacts({ visible: false })] }).ok, false)
  assert.equal(browserPanelVerdict({ hasActiveView: false }).ok, false)
})

test('W-14a verdict: upstream iframe contract + fixture postMessage + logical address', () => {
  const origin = 'http://127.0.0.1:41234'
  const messages = [{ origin, data: FIXTURE_MESSAGE }]
  const pass = embedFrameVerdict({
    bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts()], fixtureOrigin: origin, messages, expectedAddress: origin + '/',
  })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /postMessage=/)
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts()], fixtureOrigin: origin, messages: [] }).ok, false, 'the script-run proof is mandatory')
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ markerValue: null })], fixtureOrigin: origin, messages }).ok, false)
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ sandbox: 'allow-scripts allow-forms allow-same-origin' })], fixtureOrigin: origin, messages }).ok, false, 'the upstream popup tokens are part of the contract')
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ referrerpolicy: 'origin' })], fixtureOrigin: origin, messages }).ok, false)
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: 'http://127.0.0.1:41235/' })], fixtureOrigin: origin, messages }).ok, false)
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ insideBody: false })], fixtureOrigin: origin, messages }).ok, false)
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts({ addressValue: 'https://127.0.0.1:41234/' })], frames: [frameFacts()], fixtureOrigin: origin, messages, expectedAddress: origin + '/' }).ok, false, 'a bare host defaulting to https is not the typed http address')
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts({ busy: true })], frames: [frameFacts()], fixtureOrigin: origin, messages }).ok, false)
  assert.equal(embedFrameVerdict({ bodyCount: 2, bodies: [bodyFacts(), bodyFacts()], frames: [frameFacts()], fixtureOrigin: origin, messages }).ok, false)
  assert.equal(embedFrameVerdict({ bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts(), frameFacts()], fixtureOrigin: origin, messages }).ok, false)
})

test('W-14b verdict: alias iframe + logical address + fixture postMessage (no attached-row UI)', () => {
  const alias = 'http://127.0.0.2:51234/'
  const messages = [{ origin: alias, data: FIXTURE_MESSAGE }]
  const pass = remoteEmbedVerdict({
    executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: alias })],
    messages, requireMessage: true, expectedAddress: 'http://127.0.0.1:41234/',
  })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /alias=true/)
  assert.equal(remoteEmbedVerdict({}).ok, null)
  assert.match(remoteEmbedVerdict({ reason: 'no ssh source' }).evidence, /no ssh source/)
  for (const src of ['http://127.0.0.1:51234/', 'http://10.0.0.9:8080/', 'http://127.0.0.3.evil:1/']) {
    assert.equal(remoteEmbedVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src })], messages, requireMessage: true }).ok, false, src)
  }
  assert.equal(remoteEmbedVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: alias })], messages: [], requireMessage: true }).ok, false)
  assert.equal(remoteEmbedVerdict({
    executed: true, bodyCount: 1, bodies: [bodyFacts({ addressValue: alias })], frames: [frameFacts({ src: alias })], messages, requireMessage: true,
  }).ok, false, 'the address bar must keep the logical address, never the alias')
  assert.equal(remoteEmbedVerdict({
    executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: alias, sandbox: 'allow-scripts' })], messages, requireMessage: true,
  }).ok, false)
  assert.equal(remoteEmbedVerdict({
    executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: alias, referrerpolicy: null })], messages, requireMessage: true,
  }).ok, false)
})

test('W-15 verdict: upstream explicit system-browser exit, never automatic, XFO failure UI not promised', () => {
  const xfo = 'http://127.0.0.1:41234/embed-xfo'
  const pass = externalExitVerdict({
    executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: xfo })],
    expectedFrameUrl: xfo, autoOpened: 0, openedAfterClick: [xfo], expectedExternalUrl: xfo, failureTexts: [],
  })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /autoOpen=0/)
  assert.match(pass.evidence, /不承诺 XFO/u)
  const withBar = externalExitVerdict({
    executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: xfo })],
    expectedFrameUrl: xfo, autoOpened: 0, openedAfterClick: [xfo], expectedExternalUrl: xfo, failureTexts: ['页面加载失败'],
  })
  assert.equal(withBar.ok, true)
  assert.match(withBar.evidence, /上游失败条/u)
  assert.equal(externalExitVerdict({}).ok, null)
  assert.equal(externalExitVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts({ externalButton: false })], frames: [frameFacts({ src: xfo })], expectedFrameUrl: xfo, openedAfterClick: [xfo] }).ok, false)
  assert.equal(externalExitVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts({ externalEnabled: false })], frames: [frameFacts({ src: xfo })], expectedFrameUrl: xfo, openedAfterClick: [xfo] }).ok, false)
  assert.equal(externalExitVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: xfo })], expectedFrameUrl: xfo, autoOpened: 1, openedAfterClick: [xfo] }).ok, false, 'auto-opening the system browser is forbidden')
  assert.equal(externalExitVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: xfo })], expectedFrameUrl: xfo, openedAfterClick: [] }).ok, false, 'the explicit exit must open exactly once')
  assert.equal(externalExitVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: xfo })], expectedFrameUrl: xfo, expectedExternalUrl: xfo, openedAfterClick: ['http://other/'] }).ok, false)
  assert.equal(externalExitVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [], expectedFrameUrl: xfo, openedAfterClick: [xfo] }).ok, false, 'the iframe must still exist (upstream leaves the framed document)')
  assert.equal(externalExitVerdict({ executed: true, bodyCount: 1, bodies: [bodyFacts()], frames: [frameFacts({ src: 'http://127.0.0.1:41234/' })], expectedFrameUrl: xfo, openedAfterClick: [xfo] }).ok, false)
})

test('W-15b verdict: closing the tab removes BrowserBody/iframe and releases the alias', () => {
  const pass = closeReleaseVerdict({
    executed: true, bodyCount: 0, frameCount: 0, busy: false, settled: true,
    aliasProbe: { url: 'http://127.0.0.2:51234/', reachable: 'closed' },
  })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /127\.0\.0\.2/)
  const local = closeReleaseVerdict({ executed: true, bodyCount: 0, frameCount: 0, busy: false, settled: true, aliasProbe: null })
  assert.equal(local.ok, true)
  assert.match(local.evidence, /本次无 forward/)
  assert.equal(closeReleaseVerdict({}).ok, null)
  assert.equal(closeReleaseVerdict({ executed: true, bodyCount: 1, frameCount: 1, busy: false, settled: true }).ok, false)
  assert.equal(closeReleaseVerdict({ executed: true, bodyCount: 0, frameCount: 0, busy: null, settled: true }).ok, false, 'unreadable pending is not a release claim')
  assert.equal(closeReleaseVerdict({ executed: true, bodyCount: 0, frameCount: 0, busy: false, settled: false }).ok, false)
  assert.equal(closeReleaseVerdict({ executed: true, bodyCount: 0, frameCount: 0, busy: false, settled: true, aliasProbe: { url: 'http://127.0.0.2:51234/', reachable: 'open' } }).ok, false)
  assert.equal(closeReleaseVerdict({ executed: true, bodyCount: 0, frameCount: 0, busy: false, settled: true, aliasProbe: { url: 'http://127.0.0.2:51234/', reachable: 'unknown' } }).ok, false)
})

test('fixture XFO noise is tolerated BY THE FIXTURE PATH, never as a blanket failure', () => {
  const requestKey = 'FAILED(net::ERR_BLOCKED_BY_RESPONSE) http://127.0.0.1:41234/embed-xfo'
  const partition = partitionFailures(
    [requestKey, 'FAILED(net::ERR_FAILED) http://127.0.0.1:41234/elsewhere'],
    EXPECTED_FIXTURE_REQUEST_FAILURES,
  )
  assert.equal(partition.tolerated.length, 1)
  assert.deepEqual(partition.unexpected, ['FAILED(net::ERR_FAILED) http://127.0.0.1:41234/elsewhere'])
  const consoleText = "Refused to display 'http://127.0.0.1:41234/embed-xfo' in a frame because it set 'X-Frame-Options' to 'deny'."
  const consolePartition = partitionFailures([consoleText, 'TypeError: unrelated'], EXPECTED_FIXTURE_CONSOLE_NOISE)
  assert.equal(consolePartition.tolerated.length, 1)
  assert.deepEqual(consolePartition.unexpected, ['TypeError: unrelated'])
})

// ---------------------------------------------------------------- fake DOM layer
/**
 * Mini fake DOM for the REAL upstream-browser page expressions. Each node
 * carries the selector maps the expression asks for (one = querySelector,
 * many = querySelectorAll, closest = selector to node), plus
 * attributes/rect/computed style. Deliberately not a general DOM: an unmapped
 * selector returns nothing, so drift in the selector set surfaces as a
 * fact-free result instead of a silent pass.
 */
function fakeNode({
  tag = 'DIV', attrs = {}, rect = { left: 0, top: 0, width: 100, height: 100 },
  style = { visibility: 'visible', display: 'block' }, one = {}, many = {}, closest = {},
  text = '', className = '', disabled = false,
} = {}) {
  const node = {
    tagName: tag,
    attrs,
    clicks: 0,
    focused: false,
    className,
    disabled,
    getAttribute: name => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    hasAttribute: name => Object.hasOwn(attrs, name),
    getBoundingClientRect: () => ({ right: rect.left + rect.width, bottom: rect.top + rect.height, ...rect }),
    querySelector: selector => one[selector] ?? null,
    querySelectorAll: selector => many[selector] ?? [],
    closest: selector => (Object.hasOwn(closest, selector) ? closest[selector] : null),
    click() { node.clicks += 1 },
    focus() { node.focused = true },
    style,
  }
  Object.defineProperty(node, 'innerText', { get: () => text })
  Object.defineProperty(node, 'textContent', { get: () => text })
  return node
}

function fakeWindow({ witness = undefined } = {}) {
  const win = {
    innerWidth: 1400,
    innerHeight: 900,
    getComputedStyle: element => element.style ?? { visibility: 'visible', display: 'block' },
    open: () => { throw new Error('the acceptance witness must stub window.open') },
  }
  if (witness !== undefined) win.__dshGuiEmbedWitness = witness
  return win
}

/** One composed upstream-browser scene: active view + hidden N-ctx view. */
function browserScene({ origin = 'http://127.0.0.1:41234', sessionOpen = true, frameSrc = origin + '/', extraChips = [] } = {}) {
  const input = fakeNode({ tag: 'INPUT', attrs: { 'aria-label': BROWSER_ADDRESS_LABELS[0] } })
  input.value = origin + '/'
  const button = label => fakeNode({ attrs: { 'aria-label': label } })
  const buttons = [
    button(BROWSER_TOOLBAR_LABELS.back[0]),
    button(BROWSER_TOOLBAR_LABELS.forward[0]),
    button(BROWSER_TOOLBAR_LABELS.reload[0]),
    button(BROWSER_TOOLBAR_LABELS.go[0]),
    button(BROWSER_TOOLBAR_LABELS.external[0]),
    fakeNode({ attrs: { 'aria-label': BROWSER_SANDBOX_LABELS.disable[0], 'aria-pressed': 'false' } }),
  ]
  const frame = fakeNode({
    attrs: {
      'data-sidebar-browser-frame': 'iframe',
      src: frameSrc,
      sandbox: BROWSER_FRAME_CONTRACT.sandbox,
      referrerpolicy: BROWSER_FRAME_CONTRACT.referrerPolicy,
    },
  })
  const content = fakeNode({ attrs: { 'aria-busy': 'false' } })
  const tabBody = fakeNode({
    attrs: { 'data-sidebar-right-tab': 'tab-browser' },
    one: { '[aria-busy]': content },
    many: {
      button: buttons,
      input: [input],
      '[role="status"], [role="alert"]': [],
      '[role="status"]': [],
      '[role="alert"]': [],
      'iframe[data-sidebar-browser-frame]': [frame],
    },
  })
  const form = fakeNode({
    one: { 'button[type="submit"]': buttons[3] },
    many: { button: buttons, input: [input] },
    closest: { '[data-sidebar-right-tab]': tabBody },
  })
  input.form = form
  input.closest = selector => (selector === 'form' ? form : null)
  const closeButton = fakeNode({ attrs: { 'data-dockkit-tab-close': 'tab-browser' } })
  const chip = fakeNode({
    attrs: { 'data-dockkit-tab': 'tab-browser' },
    one: { '[data-dockkit-tab-title]': fakeNode({ text: '127.0.0.1' }) },
    many: { '[data-dockkit-tab-close]': [closeButton] },
  })
  const entry = fakeNode({ attrs: { 'data-sidebar-right-guide-entry': 'browser' }, text: '浏览器' })
  const hiddenEntry = fakeNode({
    attrs: { 'data-sidebar-right-guide-entry': 'browser' },
    rect: { left: 0, top: 0, width: 0, height: 0 },
  })
  const panel = fakeNode({ attrs: sessionOpen ? { 'data-sidebar-right-panel': '', 'data-sidebar-right-open': '' } : { 'data-sidebar-right-panel': '' } })
  const session = fakeNode({
    attrs: { 'data-sidebar-right-session': 's1' },
    one: { '[data-sidebar-right-panel]': panel, '[data-sidebar-right-unavailable]': null },
    many: {
      '[data-sidebar-right-guide-entry]': [hiddenEntry, entry],
      '[data-sidebar-right-unavailable]': [],
      'form input': [input],
      '[data-dockkit-tab]': [chip],
    },
  })
  const activeView = fakeNode({
    attrs: { 'data-instance': 'local' },
    many: {
      '[data-sidebar-right-session]': [session],
      '[data-sidebar-right-expand]': [],
      'form input': [input],
      button: buttons,
      '[data-dockkit-tab]': [...extraChips, chip],
    },
  })
  const hiddenView = fakeNode({
    attrs: { 'data-instance': 'gateway-x' },
    style: { visibility: 'hidden', display: 'block' },
    rect: { left: 0, top: 0, width: 0, height: 0 },
  })
  return {
    document: { querySelectorAll: selector => (selector === '[data-instance]' ? [hiddenView, activeView] : []) },
    window: fakeWindow(),
    nodes: { input, buttons, frame, tabBody, form, chip, closeButton, content, entry, hiddenEntry, panel, session, activeView, hiddenView },
  }
}

test('BROWSER_LANDSCAPE fake DOM: active-view scoping, BrowserBody/toolbar/frame/tab facts', () => {
  const scene = browserScene()
  const witness = { messages: [{ origin: 'http://127.0.0.1:41234', data: FIXTURE_MESSAGE }], external: [], opened: [] }
  scene.window.__dshGuiEmbedWitness = witness
  const facts = new Function('document', 'window', 'return (' + BROWSER_LANDSCAPE + ')')(scene.document, scene.window)
  assert.equal(facts.hasActiveView, true)
  assert.equal(facts.activeSource, 'local', 'the hidden N-ctx view must never become the active source')
  assert.equal(facts.sessionPresent, true)
  assert.equal(facts.sessionOpen, true)
  assert.equal(facts.bodyCount, 1)
  const body = facts.bodies[0]
  assert.deepEqual(body.toolbarRoles, ['back', 'forward', 'reload', 'go', 'external'])
  assert.equal(body.addressLabel, BROWSER_ADDRESS_LABELS[0])
  assert.equal(body.sandboxToggle, true)
  assert.equal(body.sandboxed, true)
  assert.equal(body.busy, false)
  assert.equal(facts.frames.length, 1)
  assert.equal(facts.frames[0].markerValue, 'iframe')
  assert.equal(facts.browserTabs.length, 1)
  assert.equal(facts.browserTabs[0].tabId, 'tab-browser')
  assert.equal(facts.browserTabs[0].close, 1)
  assert.deepEqual(facts.entries.map(entry => entry.visible), [false, true])
  assert.equal(facts.messages.length, 1)
  const pick = pickBrowserGuideEntry(facts.entries)
  assert.equal(pick.ok, true)
  assert.equal(browserPanelVerdict({ ...facts, entryPick: pick, openedVia: 'existing' }).ok, true)
  assert.equal(embedFrameVerdict({
    bodyCount: facts.bodyCount, bodies: facts.bodies, frames: facts.frames,
    fixtureOrigin: 'http://127.0.0.1:41234', messages: facts.messages,
  }).ok, true)
  assert.equal(embedFrameVerdict({
    bodyCount: facts.bodyCount, bodies: facts.bodies, frames: facts.frames,
    fixtureOrigin: 'http://127.0.0.1:41234', messages: [],
  }).ok, false)
})

test('BROWSER_LANDSCAPE fake DOM: collapsed panel and no-active-view fail closed', () => {
  const scene = browserScene({ sessionOpen: false })
  const facts = new Function('document', 'window', 'return (' + BROWSER_LANDSCAPE + ')')(scene.document, scene.window)
  assert.equal(facts.sessionOpen, false)
  assert.equal(browserPanelVerdict({ ...facts, entryPick: pickBrowserGuideEntry(facts.entries) }).ok, false)
  const hiddenOnly = { querySelectorAll: selector => (selector === '[data-instance]' ? [scene.nodes.hiddenView] : []) }
  const empty = new Function('document', 'window', 'return (' + BROWSER_LANDSCAPE + ')')(hiddenOnly, fakeWindow())
  assert.equal(empty.hasActiveView, false)
  assert.equal(empty.bodyCount, 0)
  assert.equal(browserPanelVerdict(empty).ok, false)
})

test('upstream click expressions: guide kind browser, expand, close by body/chip tab id', () => {
  const visibleToggle = fakeNode({ attrs: { 'data-sidebar-right-expand': '' } })
  const hiddenToggle = fakeNode({ attrs: { 'data-sidebar-right-expand': '' }, rect: { left: 0, top: 0, width: 0, height: 0 } })
  const win = fakeWindow()
  const expandDoc = { querySelectorAll: selector => (selector === '[data-sidebar-right-expand]' ? [hiddenToggle, visibleToggle] : []) }
  assert.equal(new Function('document', 'window', 'return (' + CLICK_RIGHT_SIDEBAR_EXPAND + ')')(expandDoc, win).clicked, true)
  assert.equal(visibleToggle.clicks, 1)
  const visibleEntry = fakeNode({ attrs: { 'data-sidebar-right-guide-entry': 'browser' } })
  const otherKind = fakeNode({ attrs: { 'data-sidebar-right-guide-entry': 'terminal' } })
  const hiddenEntry = fakeNode({ attrs: { 'data-sidebar-right-guide-entry': 'browser' }, rect: { left: 0, top: 0, width: 0, height: 0 } })
  const entryDoc = { querySelectorAll: selector => (selector === '[data-sidebar-right-guide-entry]' ? [hiddenEntry, otherKind, visibleEntry] : []) }
  assert.equal(new Function('document', 'window', 'return (' + CLICK_BROWSER_GUIDE_ENTRY + ')')(entryDoc, win).clicked, true)
  assert.equal(visibleEntry.clicks, 1)
  assert.equal(otherKind.clicks, 0)
  const scene = browserScene()
  const closeResult = new Function('document', 'window', 'return (' + CLOSE_BROWSER_TAB + ')')(scene.document, win)
  assert.equal(closeResult.clicked, true)
  assert.equal(closeResult.tabId, 'tab-browser')
  assert.equal(scene.nodes.closeButton.clicks, 1)
  const otherClose = fakeNode({ attrs: { 'data-dockkit-tab-close': 'tab-other' } })
  const otherChip = fakeNode({ attrs: { 'data-dockkit-tab': 'tab-other' }, many: { '[data-dockkit-tab-close]': [otherClose] } })
  const twoChips = browserScene({ extraChips: [otherChip] })
  assert.equal(new Function('document', 'window', 'return (' + CLOSE_BROWSER_TAB + ')')(twoChips.document, win).clicked, true, 'a non-browser chip is ignored')
  assert.equal(otherClose.clicks, 0)
})

test('upstream address expressions: native-setter typing, own submit, reload and external click', () => {
  function FakeInput() {}
  Object.defineProperty(FakeInput.prototype, 'value', {
    get() { return this._value },
    set(value) { this._value = value },
  })
  const input = new FakeInput()
  input.getAttribute = name => (name === 'aria-label' ? BROWSER_ADDRESS_LABELS[0] : null)
  input.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 })
  input.style = { visibility: 'visible', display: 'block' }
  input.dispatchEvent = event => { input.events = (input.events ?? []).concat(event.type) }
  input.focus = () => { input.focused = true }
  input.form = null
  input.closest = selector => (selector === 'form' ? input.form : null)
  const win = fakeWindow()
  win.HTMLInputElement = FakeInput
  const view = fakeNode({
    attrs: { 'data-instance': 'local' },
    many: { 'form input': [input], button: [], '[data-sidebar-right-session]': [] },
  })
  const doc = { querySelectorAll: selector => (selector === '[data-instance]' ? [view] : []) }
  const typed = new Function('document', 'window', 'return (' + setBrowserAddress('http://127.0.0.1:41234/') + ')')(doc, win)
  assert.equal(typed.set, true)
  assert.equal(typed.value, 'http://127.0.0.1:41234/', 'React reads the native setter value')
  assert.deepEqual(input.events, ['input', 'change'])
  assert.equal(input.focused, true)
  const submitButton = { clicks: 0, click() { submitButton.clicks += 1 } }
  const form = { querySelector: selector => (selector === 'button[type="submit"]' ? submitButton : null) }
  input.form = form
  const submitted = new Function('document', 'window', 'return (' + SUBMIT_BROWSER_ADDRESS + ')')(doc, win)
  assert.equal(submitted.submitted, true)
  assert.equal(submitButton.clicks, 1)
  const reloadButton = fakeNode({ attrs: { 'aria-label': BROWSER_TOOLBAR_LABELS.reload[0] } })
  const externalButton = fakeNode({ attrs: { 'aria-label': BROWSER_TOOLBAR_LABELS.external[0] } })
  const actionView = fakeNode({ many: { button: [reloadButton, externalButton] } })
  const actionDoc = { querySelectorAll: selector => (selector === '[data-instance]' ? [actionView] : []) }
  assert.equal(new Function('document', 'window', 'return (' + RELOAD_BROWSER_PAGE + ')')(actionDoc, win).reloaded, true)
  assert.equal(reloadButton.clicks, 1)
  const clickedExternal = new Function('document', 'window', 'return (' + CLICK_BROWSER_EXTERNAL + ')')(actionDoc, win)
  assert.equal(clickedExternal.clicked, true)
  assert.equal(externalButton.clicks, 1)
  externalButton.disabled = true
  assert.equal(new Function('document', 'window', 'return (' + CLICK_BROWSER_EXTERNAL + ')')(actionDoc, win).clicked, false, 'a disabled exit is never clicked')
})

test('embed witness: postMessage, anchor suppression and the stubbed window.open record', () => {
  const win = fakeWindow()
  const windowListeners = new Map()
  win.addEventListener = (type, listener) => windowListeners.set(type, listener)
  win.removeEventListener = (type, listener) => { if (windowListeners.get(type) === listener) windowListeners.delete(type) }
  const documentListeners = new Map()
  const doc = {
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: (type, listener) => { if (documentListeners.get(type) === listener) documentListeners.delete(type) },
  }
  const installed = new Function('window', 'document', 'return (' + INSTALL_EMBED_WITNESS + ')')(win, doc)
  assert.equal(installed.installed, true)
  assert.equal(windowListeners.has('message'), true)
  assert.equal(documentListeners.has('click'), true)
  windowListeners.get('message')({ origin: 'http://127.0.0.1:41234', data: FIXTURE_MESSAGE })
  const anchor = { getAttribute: name => (name === 'href' ? 'http://127.0.0.1:41234/embed-xfo' : null) }
  const clickEvent = {
    target: { closest: selector => (selector === 'a[href][target="_blank"]' ? anchor : null) },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true },
  }
  documentListeners.get('click')(clickEvent)
  assert.equal(clickEvent.prevented, true)
  assert.equal(clickEvent.stopped, true)
  const openedUrl = win.open('http://127.0.0.1:41234/embed-xfo', '_blank', 'noopener,noreferrer')
  assert.equal(openedUrl, null, 'the acceptance stub never opens a real browser')
  const read = new Function('window', 'document', 'return (' + READ_EMBED_WITNESS + ')')(win, doc)
  assert.equal(read.messages.length, 1)
  assert.equal(read.external.length, 1)
  assert.deepEqual(read.opened, ['http://127.0.0.1:41234/embed-xfo'])
  assert.match(read.external[0], /embed-xfo/)
  assert.equal(win.__dshGuiEmbedWitness, undefined)
  assert.equal(typeof win.open, 'function')
  const empty = new Function('window', 'document', 'return (' + READ_EMBED_WITNESS + ')')(fakeWindow(), {})
  assert.equal(empty.installed, false)
})

// ---------------------------------------------------------------- real HTTP layers
test('embed fixture: / serves the marker page, /embed-xfo adds XFO DENY, close frees the port', async () => {
  const fixture = await startEmbedFixture({ host: '127.0.0.1' })
  try {
    assert.equal(fixture.xfoPath, FIXTURE_XFO_PATH)
    const ok = await fetch(fixture.origin + '/')
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('x-frame-options'), null)
    const body = await ok.text()
    assert.match(body, new RegExp(FIXTURE_MESSAGE_TYPE))
    assert.match(body, new RegExp(FIXTURE_MARKER))
    assert.match(body, /parent\.postMessage/)
    const xfo = await fetch(fixture.origin + fixture.xfoPath)
    assert.equal(xfo.status, 200)
    assert.equal(xfo.headers.get('x-frame-options'), 'DENY')
    assert.equal(await probeTcpReachable(fixture.origin), 'open')
  } finally {
    await fixture.close()
  }
  assert.equal(await probeTcpReachable(fixture.origin), 'closed', 'closing the fixture releases the port')
})

test('live probe SH-7: the v2 CSP header passes, the v1 default is INFO and --require-embed FAILs it', async () => {
  const shellHtml = '<!doctype html><html><head><title>dsh-chamber</title></head><body><div id="root"></div></body></html>'
  let csp = "default-src 'self'; frame-src " + BROWSER_FRAME_CSP_SOURCES.join(' ') + "; frame-ancestors 'none'; script-src 'self'"
  const server = createServer((request, response) => {
    const target = request.url ?? '/'
    if (target === '/') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': csp,
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      })
      response.end(shellHtml)
      return
    }
    if (target === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok","dsh":{"status":"ready"}}')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not_found","code":"not_found"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + String(server.address().port)
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsh-gui-csp-'))
  try {
    const run = async requireEmbed => {
      const { results } = await runLiveAcceptance({ planeOrigin: origin, instanceOrigin: '', sourceIds: [], outDir, requireEmbed })
      return results.find(entry => entry.id === 'SH-7')
    }
    const v2 = await run(false)
    assert.equal(v2.ok, true)
    assert.match(v2.evidence, /v2 源集/u)
    csp = "default-src 'self'; frame-src blob:; frame-ancestors 'none'; script-src 'self'"
    const v1 = await run(false)
    assert.equal(v1.ok, null, 'the gateway/default v1 header must not fail SH-7')
    const strict = await run(true)
    assert.equal(strict.ok, false, '--require-embed demands the v2 frame-src set')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(outDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- W-13 session bootstrap
test('W-13 bootstrap pickers: new-session shortcut first, workspace/edit/open exactly-one', () => {
  const buttons = [
    { index: 1, ariaLabel: '新建会话', keys: 'Control+N', text: '', width: 216, height: 24 },
    { index: 2, ariaLabel: '新建会话', keys: 'Control+N', text: '新会话 Ctrl N', width: 252, height: 38 },
    { index: 3, ariaLabel: '设置', keys: null, text: '设置', width: 260, height: 42 },
  ]
  const picked = pickNewSessionControl(buttons)
  assert.equal(picked.ok, true)
  assert.equal(picked.picked.index, 2, 'the labelled new-session row (largest) wins deterministically')
  assert.equal(picked.candidates.length, 2)
  // Shortcut attribute is the structural locator; the label list is the fallback.
  assert.equal(pickNewSessionControl([{ index: 4, ariaLabel: 'New session', keys: null, width: 200, height: 30 }]).picked.index, 4)
  // Disabled controls and unrelated labels are never picked.
  assert.equal(pickNewSessionControl([{ ...buttons[2], disabled: true }]).ok, false)
  assert.equal(pickNewSessionControl([{ index: 0, ariaLabel: '其他', keys: null, text: 'x', width: 1, height: 1 }]).ok, false)
  // Meta+N (macOS spelling) matches too.
  assert.equal(pickNewSessionControl([{ index: 5, keys: 'Meta+N', width: 10, height: 10 }]).ok, true)

  const chip = pickWorkspaceChip([
    { index: 1, ariaLabel: '设置', width: 1, height: 1 },
    { index: 2, ariaLabel: '选择工作区', width: 117, height: 28 },
  ])
  assert.equal(chip.ok, true)
  assert.equal(chip.picked.index, 2)
  assert.equal(pickWorkspaceChip([{ index: 1, ariaLabel: 'Choose workspace', width: 1, height: 1 }]).ok, true)
  assert.equal(pickWorkspaceChip([]).reason, 'no-control')
  assert.equal(pickWorkspaceChip([
    { index: 1, ariaLabel: '选择工作区', width: 1, height: 1 },
    { index: 2, ariaLabel: 'Choose workspace', width: 1, height: 1 },
  ]).reason, 'ambiguous')

  const dialogButtons = [
    { index: 1, ariaLabel: '编辑路径', text: '', width: 40, height: 28 },
    { index: 2, ariaLabel: null, text: '取消', primary: false, width: 80, height: 32 },
    { index: 3, ariaLabel: null, text: '打开', primary: true, width: 80, height: 32 },
  ]
  assert.equal(pickDirectoryEditButton(dialogButtons).picked.index, 1)
  assert.equal(pickDirectoryOpenButton(dialogButtons).picked.index, 3)
  assert.equal(pickDirectoryEditButton([dialogButtons[1]]).ok, false)
  // A disabled open button is "no target yet": fail closed, never click it.
  assert.equal(pickDirectoryOpenButton([{ index: 3, text: '打开', primary: true, disabled: true, width: 80, height: 32 }]).ok, false)
  // Without a readable primary class the localized label is the fallback.
  assert.equal(pickDirectoryOpenButton([{ index: 4, text: 'Open', primary: false, width: 80, height: 32 }]).picked.index, 4)
})

test('W-13 bootstrap verdict: a visible Session is a pass, --attach INFO, a failed attempt FAIL', () => {
  assert.equal(sessionBootstrapVerdict({ executed: false, reason: 'attach' }).ok, null)
  assert.match(sessionBootstrapVerdict({ executed: false, reason: 'attach' }).evidence, /未执行/u)
  const pass = sessionBootstrapVerdict({ executed: true, sessionPresent: true, via: 'workspace-created', note: 'workspace=/tmp/x' })
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /workspace-created/u)
  assert.match(pass.evidence, /workspace=\/tmp\/x/u)
  const fail = sessionBootstrapVerdict({ executed: true, sessionPresent: false, via: 'none', note: 'typed=false' })
  assert.equal(fail.ok, false)
  assert.match(fail.evidence, /仍没有可见 Session/u)
  // --require-embed turns the --attach INFO into FAIL, same as every embed leg.
  assert.equal(applyRequireEmbed(sessionBootstrapVerdict({ executed: false, reason: 'x' }), true).ok, false)
})

test('fixture noise scoping: only THIS run fixture origin is tolerated', () => {
  const rules = fixtureNoiseRules('http://127.0.0.1:36199')
  assert.equal(partitionFailures([
    'FAILED(net::ERR_BLOCKED_BY_RESPONSE) http://127.0.0.1:36199/embed-xfo',
  ], rules.request).tolerated.length, 1)
  assert.equal(partitionFailures([
    'FAILED(net::ERR_BLOCKED_BY_RESPONSE) http://127.0.0.1:40000/embed-xfo',
  ], rules.request).unexpected.length, 1)
  const consoleLine = "other: Refused to display 'http://127.0.0.1:36199/' in a frame because it set 'X-Frame-Options' to 'deny'."
  assert.equal(partitionFailures([consoleLine], rules.console).tolerated.length, 1, 'the console line may name the framed origin root')
  assert.equal(partitionFailures(["Refused to display 'http://127.0.0.1:40000/x' in a frame because X-Frame-Options"], rules.console).unexpected.length, 1)
  assert.deepEqual(fixtureNoiseRules(''), { request: [], console: [] })
})

test('SESSION_BOOTSTRAP_FACTS fake DOM: active-view buttons, session surface, directory dialog', () => {
  const sessionSurface = fakeNode({ attrs: { 'data-sidebar-right-session': 's1' } })
  const newSession = fakeNode({ attrs: { 'aria-label': '新建会话', 'aria-keyshortcuts': 'Control+N' }, rect: { left: 14, top: 70, width: 252, height: 38 }, text: '新会话 Ctrl N' })
  const chip = fakeNode({ attrs: { 'aria-label': '选择工作区' }, rect: { left: 425, top: 342, width: 117, height: 28 } })
  const disabled = fakeNode({ attrs: { 'aria-label': '新建会话' }, rect: { left: 16, top: 24, width: 216, height: 24 }, disabled: true })
  const edit = fakeNode({ attrs: { 'aria-label': '编辑路径' }, rect: { left: 500, top: 200, width: 40, height: 28 } })
  const open = fakeNode({ rect: { left: 900, top: 600, width: 80, height: 32 }, text: '打开', className: '_button_primary' })
  const input = fakeNode({ tag: 'INPUT', attrs: { 'aria-label': '编辑路径' } })
  const dialog = fakeNode({
    attrs: { role: 'dialog' },
    rect: { left: 300, top: 120, width: 700, height: 500 },
    one: { input },
    many: { input: [input], button: [edit, open] },
  })
  const view = fakeNode({
    attrs: { 'data-instance': 'local' },
    many: {
      button: [newSession, chip, disabled],
      '[data-session-id]': [fakeNode()],
      '[data-sidebar-right-session]': [sessionSurface],
    },
  })
  const document = {
    querySelectorAll: selector => {
      if (selector === '[data-instance]') return [view]
      if (selector === '[role="dialog"]') return [dialog]
      return []
    },
  }
  const facts = new Function('document', 'window', 'return (' + SESSION_BOOTSTRAP_FACTS + ')')(document, fakeWindow())
  assert.equal(facts.hasActiveView, true)
  assert.equal(facts.activeSource, 'local')
  assert.equal(facts.sessionRows, 1)
  assert.equal(facts.rightSessions, 1)
  assert.equal(facts.sessionPresent, true)
  assert.equal(facts.buttons.length, 3)
  const picked = pickNewSessionControl(facts.buttons.filter(button => button.disabled !== true))
  assert.equal(picked.ok, true)
  assert.equal(picked.picked.index, 0, 'only the enabled 252x38 new-session row can be picked')
  assert.equal(pickWorkspaceChip(facts.buttons).picked.index, 1)
  assert.equal(facts.dialog.buttons.length, 2)
  assert.equal(pickDirectoryEditButton(facts.dialog.buttons).picked.ariaLabel, '编辑路径')
  assert.equal(pickDirectoryOpenButton(facts.dialog.buttons).picked.primary, true)
  assert.equal(facts.dialog.inputs.length, 1)
})

test('clickButtonDescriptor / typeDirectoryPath: identity click + native-setter path entry', () => {
  function FakeInput() {}
  Object.defineProperty(FakeInput.prototype, 'value', {
    get() { return this._value },
    set(value) { this._value = value },
  })
  const input = new FakeInput()
  const events = []
  input.dispatchEvent = event => events.push(event.type)
  input.focus = () => {}
  const openButton = fakeNode({ attrs: { 'aria-label': '打开' }, rect: { left: 900, top: 600, width: 80, height: 32 }, text: '打开' })
  const lookalike = fakeNode({ attrs: { 'aria-label': '打开' }, rect: { left: 900, top: 640, width: 80, height: 32 }, text: '打开' })
  const dialog = fakeNode({ attrs: { role: 'dialog' }, one: { input }, many: { input: [input] } })
  const document = { querySelectorAll: selector => (selector === 'button' ? [lookalike, openButton] : selector === '[role="dialog"]' ? [dialog] : []) }
  const win = fakeWindow()
  win.HTMLInputElement = FakeInput
  if (typeof globalThis.KeyboardEvent !== 'function') {
    globalThis.KeyboardEvent = class KeyboardEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init) }
    }
  }
  const clicked = new Function('document', 'window', 'return (' + clickButtonDescriptor({ ariaLabel: '打开', text: '打开', left: 900, top: 600, width: 80, height: 32 }) + ')')(document, win)
  assert.equal(clicked.clicked, true)
  assert.equal(openButton.clicks, 1)
  assert.equal(lookalike.clicks, 0, 'a different control at another rect is never clicked')
  const missing = new Function('document', 'window', 'return (' + clickButtonDescriptor({ ariaLabel: '打开', text: '打开', left: 1, top: 1, width: 1, height: 1 }) + ')')(document, win)
  assert.equal(missing.clicked, false)
  const typed = new Function('document', 'window', 'return (' + typeDirectoryPath('/tmp/ws') + ')')(document, win)
  assert.equal(typed.typed, true)
  assert.equal(input._value, '/tmp/ws')
  assert.ok(events.includes('input'))
})
