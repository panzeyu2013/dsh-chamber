/**
 * Unit tests for the GUI acceptance toolbox's judgement layer (checks.mjs).
 *
 * WHY ONLY PURE HELPERS: the driving layers need a display, a running app and a
 * CDP port, so they are local gates (docs/checklists/gui-acceptance-checklist.md);
 * everything that decides pass/fail is pure — and therefore runs in CI, which is
 * how every other tool in this repo is policed (test:upgrade-tools,
 * test:release-workflow).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KNOWN_UPSTREAM_BOOT_NOISE, TOLERATED_REQUEST_FAILURES, createRecorder, deriveSourceIds,
  hasSecurityHeaders, hoverCardVerdict, isHonestError, isInstanceIndex, isShellIndex, isWriterQuiescent, leakedFileContent,
  parseInstanceAssets, parsePluginLoaderUrls, parseShellAssets, partitionFailures, renderMarkdown,
  safeJson, summarize, summarizeNetFailures, writerEvidence,
} from './checks.mjs'

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
  assert.equal(hoverCardVerdict({ cardable: true, opened: true, closed: true }).ok, true)
  assert.equal(hoverCardVerdict({ cardable: true, opened: true, closed: false }).ok, false)
  assert.equal(hoverCardVerdict({ cardable: true, opened: false, closed: true }).ok, false)
  const info = hoverCardVerdict({ cardable: false })
  assert.equal(info.ok, null)
  assert.match(info.evidence, /未执行/)
})
