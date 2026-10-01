/**
 * mobile-walkthrough.test.mjs — 走查**驱动层**的脱敏与降级契约：凭据泄漏发生在驱动的**落盘点**
 * （帧摘要、M-8/M-9 证据、报告 meta、帧文件、stdout、fail-soft 报告），删掉一处 `scrub(...)` 或
 * 一处 `secrets:` 传参 CI 就会全绿。用注入的 discover/connect 把整条驱动路径拉进单测：
 * 不连真浏览器、不写仓库、只写临时目录。跑法：
 * `node --test scripts/gui-acceptance/mobile-walkthrough.test.mjs`（已登记在 root `test:gui-acceptance`）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectWebSocketFrames, runMobileWalkthrough } from './mobile-walkthrough.mjs'
import { HEADER_FACTS_EXPRESSION, MOBILE_DEVICE, OVERLAY_FACTS_EXPRESSION, summarizeWebSocketFrames } from './mobile-checks.mjs'
const SECRETS = ['SECRET_URL_TOKEN', 'SECRET_TITLE_TOKEN', 'SECRET_FRAME_TOKEN', 'SECRET_NET_TOKEN', 'SECRET_CONSOLE_TOKEN']
/** A CDP session stub with exactly the surface the driver uses; deliver() pushes planted frames
 *  through the driver's OWN collector (onMessage), so the real frame path is exercised, not a side channel. */
function fakeSession() {
  const listeners = []
  const buffered = []
  const session = {
    netFailures: new Map([['GET http://127.0.0.1:9/api/x?token=SECRET_NET_TOKEN -> 500', 1]]),
    consoleErrors: ['boom ?token=SECRET_CONSOLE_TOKEN'],
    consoleWarnings: [],
    async enableObservation() {},
    async send() {},
    async reload() {},
    async screenshot(path) { void path },
    async waitFor() {},
    beginObservationWindow() {},
    close() {},
    // Buffer until the collector subscribes (the driver subscribes after connect resolves, so a plain fan-out would drop early frames).
    onMessage(handler) { listeners.push(handler); for (const pending of buffered.splice(0)) handler(pending) },
    deliver(method, params) {
      const message = { method, params }
      if (listeners.length === 0) { buffered.push(message); return }
      for (const handler of listeners) handler(message)
    },
    async evaluate() {
      return {
        url: 'http://127.0.0.1:9/index.html?token=SECRET_URL_TOKEN',
        title: 'fake ?token=SECRET_URL_TOKEN',
        innerWidth: 390, innerHeight: 844, clientWidth: 390, clientHeight: 844,
        scrollWidth: 390, scrollHeight: 900,
        visualViewport: { width: 390, height: 844, scale: 1 },
        dpr: 3, screenWidth: 390, screenHeight: 844, maxTouchPoints: 5, ontouchstart: true,
        pointerCoarse: true, pointerFine: false, hoverNone: true, anyPointerCoarse: true,
        touchTier: true, phoneTier: true, rootSlots: 1, mobileFrames: 1,
        mobileRoles: ['main'], pluginStyle: true,
        hasOutlet: false, hasHeader: false, headerBox: null, firstRowBox: null,
        headerChildren: [], tabs: [], buttons: [], lineage: null, texts: [],
        sessionHeaderPresent: false, rootPhase: null,
      }
    },
  }
  return session
}
/** Capture what the driver writes to the console by swapping `console.*` — NOT `process.stdout.write`,
 *  which under `node --test` carries the runner's own per-test report. */
async function captureConsole(run) {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const lines = []
  const record = (...args) => { lines.push(args.map(String).join(' ')) }
  console.log = record
  console.warn = record
  console.error = record
  try {
    const value = await run()
    return { value, stdout: lines.join('\n') }
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}
/** Read every file under `dir` (recursively) as text; binaries are skipped by extension. */
function readArtifacts(dir) {
  const out = []
  const walk = current => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(?:json|md|txt)$/.test(entry)) continue
      out.push([full, readFileSync(full, 'utf8')])
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}
const FAKE_TARGET = {
  url: 'http://127.0.0.1:9/index.html?token=SECRET_URL_TOKEN',
  title: 'dsh gateway ?token=SECRET_TITLE_TOKEN',
  webSocketDebuggerUrl: 'ws://fake-devtools/page/1',
}
async function runCase(t, { wsFrames = 'summary', requireRun = false, target = FAKE_TARGET, frames = [], url = null, device = undefined, mutate = () => {} } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'walkthrough-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const session = fakeSession()
  // Test seam for the M-10 tolerance cases: adjust the planted net/console facts before the run.
  mutate(session)
  // Frames whose payloads carry credentials in three spellings the rules must all catch, plus one token DESCRIPTOR that must survive.
  const planted = [
    ['Network.webSocketCreated', { url: 'ws://127.0.0.1:9/api/remote.mux?token=SECRET_FRAME_TOKEN', timestamp: 1 }],
    ['Network.webSocketFrameSent', { response: { opcode: 1, payloadData: JSON.stringify({ Authorization: `Bearer ${SECRETS[2]}`, token: SECRETS[2] }) }, timestamp: 2 }],
    ['Network.webSocketFrameReceived', { response: { opcode: 1, payloadData: '{"token":{"kind":"opaque","ttl":30},"keep":1}' }, timestamp: 3 }],
    ...frames,
  ]
  let subscriptions = 0
  const realOnMessage = session.onMessage.bind(session)
  session.onMessage = handler => { subscriptions += 1; return realOnMessage(handler) }
  const { value: result, stdout } = await captureConsole(() => runMobileWalkthrough({
    outDir,
    wsFrames,
    requireRun,
    url,
    device,
    discover: async () => target,
    connect: async () => {
      for (const [method, params] of planted) session.deliver(method, params)
      return session
    },
    settleMs: 0,
    navigateSettleMs: 0,
    reloadSettleMs: 0,
    frameSettleMs: 0,
    env: { DSH_MOBILE_AUTH_TOKEN: 'SECRET_ENV_TOKEN' },
  }))
  return { outDir, stdout, result, subscriptions }
}

test('no credential reaches stdout or any artifact, and the diagnostic content survives', async t => {
  const { outDir, stdout, result, subscriptions } = await runCase(t, { frames: [
    ['Network.webSocketFrameSent', { response: { opcode: 1, payloadData: '{"apiKey":"SECRET_FRAME_TOKEN"}' }, timestamp: 4 }],
  ] })
  assert.equal(result.skipped, false)
  assert.equal(subscriptions, 1, 'the default tier subscribes exactly once')
  const leaks = []
  for (const secret of SECRETS) {
    if (stdout.includes(secret)) leaks.push(`stdout: ${secret}`)
    for (const [file, text] of readArtifacts(outDir)) if (text.includes(secret)) leaks.push(`${file}: ${secret}`)
  }
  assert.deepEqual(leaks, [], 'the driver must never let a planted credential out')
  // Redaction MASKS, it does not delete the evidence: the masked forms are there and the token descriptor is intact.
  const frames = JSON.parse(readFileSync(join(outDir, 'mobile-ws-frames.json'), 'utf8'))
  const sent = frames.frames.find(frame => frame.direction === 'sent')
  assert.match(sent.payload, /"Authorization":"\*\*\*"/)
  assert.match(sent.payload, /"token":"\*\*\*"/)
  const received = frames.frames.find(frame => frame.direction === 'received')
  assert.ok(received.payload.includes('{"token":{"kind":"opaque","ttl":30},"keep":1}'),
    'a token DESCRIPTOR must survive: redacting into it produced unbalanced JSON in the evidence a human reads')
  assert.match(frames.meta.target, /token=\*\*\*/)
  const report = readFileSync(join(outDir, 'gui-mobile-walkthrough-report.md'), 'utf8')
  assert.match(report, /token=\*\*\*/)
  assert.ok(!report.includes('SECRET_ENV_TOKEN'))
})

test('--ws-frames off collects nothing and writes no frame file', async t => {
  const { outDir, result, subscriptions } = await runCase(t, { wsFrames: 'off' })
  assert.equal(subscriptions, 0, 'off must not even subscribe to the CDP frame events')
  assert.equal(result.framesPath, null)
  assert.equal(existsSync(join(outDir, 'mobile-ws-frames.json')), false)
  const report = readFileSync(join(outDir, 'gui-mobile-walkthrough-report.md'), 'utf8')
  assert.ok(!report.includes('## WebSocket 帧'), 'the off tier must not render a frame section')
})

test('the fail-soft no-target path still writes a report and still scrubs', async t => {
  // The URL the user typed is what this report persists, so it must carry a credential in a position
  // the regexes CANNOT see: a path segment. A `?token=` one is masked even without the secrets list,
  // which would make dropping the `secrets:` argument invisible.
  const { outDir, stdout, result } = await runCase(t, {
    target: null,
    url: 'https://gw.example/path/SECRET_ENV_TOKEN',
  })
  assert.equal(result.skipped, true)
  assert.match(stdout, /需要什么/)
  const report = readFileSync(join(outDir, 'gui-mobile-walkthrough-report.json'), 'utf8')
  assert.ok(!report.includes('SECRET_ENV_TOKEN'), 'the fail-soft report must receive the secrets')
  assert.match(report, /path\/\*\*\*/, 'the env-supplied value must be masked even in a path segment')
})

test('--require-run turns an unmounted page into FAIL (M-1 and the geometry legs)', async t => {
  const session = fakeSession()
  const outDir = mkdtempSync(join(tmpdir(), 'walkthrough-strict-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  // No mount marker (waitFor rejects) ⇒ M-1 fails; the header facts say "no session" ⇒ M-5..M-7; M-3 (overflow) is judged, so it must be gated too.
  session.waitFor = async () => { throw new Error('no mount marker') }
  session.evaluate = async expression => (expression.includes('#root')
    ? false
    : { url: 'http://127.0.0.1:9/', title: 'fake', innerWidth: 390, innerHeight: 844, clientWidth: 390, clientHeight: 844,
        // Unmeasurable overflow (`overflowVerdict` returns ok:null): only the --require-run gate turns M-3 into a FAIL.
        scrollWidth: null, scrollHeight: null, visualViewport: { width: 390, height: 844, scale: 1 }, dpr: 3,
        screenWidth: 390, screenHeight: 844, maxTouchPoints: 5, ontouchstart: true, pointerCoarse: true, pointerFine: false,
        hoverNone: true, anyPointerCoarse: true, touchTier: true, phoneTier: true, rootSlots: 0, mobileFrames: 0,
        mobileRoles: [], pluginStyle: true, hasOutlet: false, hasHeader: false, headerBox: null, firstRowBox: null,
        headerChildren: [], tabs: [], buttons: [], lineage: null, texts: [], sessionHeaderPresent: false, rootPhase: null })
  const { value: result } = await captureConsole(() => runMobileWalkthrough({
    outDir, requireRun: true,
    discover: async () => ({ url: 'http://127.0.0.1:9/', title: 'fake', webSocketDebuggerUrl: 'ws://fake' }),
    connect: async () => session, settleMs: 0, navigateSettleMs: 0, reloadSettleMs: 0, frameSettleMs: 0, env: {},
  }))
  assert.equal(result.failed >= 5, true, `M-1/M-3/M-5/M-6/M-7 must fail under --require-run (failed=${result.failed})`)
  const byId = new Map(result.results.map(row => [row.id, row.ok]))
  for (const id of ['M-1', 'M-3', 'M-5', 'M-6', 'M-7']) assert.equal(byId.get(id), false, `${id} must be FAIL`)
})

test('redaction runs BEFORE truncation: redact() sees the full payload, the stored one is capped', async t => {
  const cap = 40
  const raw = '{"Authorization":"Bearer ' + "A".repeat(80) + 'SECRET_FRAME_TOKEN"}'
  const seen = []
  const listeners = []
  const session = { onMessage(handler) { listeners.push(handler) } }
  const { frames } = collectWebSocketFrames(session, {
    cap,
    redact: value => { seen.push(value); return value.replace("SECRET_FRAME_TOKEN", "***") },
  })
  for (const handler of listeners) handler({ method: "Network.webSocketFrameSent", params: { response: { opcode: 1, payloadData: raw }, timestamp: 1 } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].length, raw.length, "redaction must see the FULL payload, not a truncated prefix")
  assert.equal(frames[0].payloadLength, raw.length, "payloadLength keeps the raw length")
  assert.equal(frames[0].truncated, true)
  assert.ok(frames[0].payload.length <= cap, frames[0].payload.length)
  assert.ok(!frames[0].payload.includes("SECRET_FRAME_TOKEN"), frames[0].payload)
  const summary = summarizeWebSocketFrames(frames)
  assert.match(summary.summary, /已截断：原始 \d+ 字节/)
  assert.match(summary.summary, /截断帧 1 个/)
})

test('M-9 is the read-only overlay probe; the console/network observation moved to M-10', async t => {
  const { result } = await runCase(t, {})
  const ids = result.results.map(row => row.id)
  assert.ok(ids.includes("M-9"), ids.join(","))
  assert.ok(ids.includes("M-10"), ids.join(","))
  const overlay = result.results.find(row => row.id === "M-9")
  assert.equal(overlay.ok, null, "the fake page exposes no overlay facts => INFO, never a silent pass")
  assert.match(overlay.evidence, /拿不到视口尺寸/)
})

test('--require-run 不得把 M-9 的「无覆盖层 INFO」改判 FAIL（扫描完成即算执行）', async t => {
  // 「页面没有覆盖层」是这个只读扫描的合法结论：把 INFO 改判 FAIL 等于惩罚一条
  // 确实执行过的腿。用真实的 OVERLAY_FACTS_EXPRESSION 分支喂一个扫描成功但零命中的
  // 页面事实，证明 M-9 仍是 INFO；其余按 --require-run 照常改判（M-1 未挂载 ⇒ FAIL）。
  const session = fakeSession()
  const evaluate = session.evaluate.bind(session)
  session.evaluate = async expression => expression === OVERLAY_FACTS_EXPRESSION
    ? { limitW: 390, limitH: 844, visualW: 390, visualH: 844, overlays: [], scanCapped: false }
    : evaluate(expression)
  session.waitFor = async () => { throw new Error('no mount marker') }
  const outDir = mkdtempSync(join(tmpdir(), 'walkthrough-m9-strict-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const { value: result } = await captureConsole(() => runMobileWalkthrough({
    outDir, requireRun: true,
    discover: async () => ({ url: 'http://127.0.0.1:9/', title: 'fake', webSocketDebuggerUrl: 'ws://fake' }),
    connect: async () => session, settleMs: 0, navigateSettleMs: 0, reloadSettleMs: 0, frameSettleMs: 0, env: {},
  }))
  const byId = new Map(result.results.map(row => [row.id, row.ok]))
  assert.equal(byId.get('M-1'), false, 'M-1 still fails under --require-run')
  assert.equal(byId.get('M-9'), null, 'M-9 stays INFO: the read-only scan did run and found no overlays')
  const overlay = result.results.find(row => row.id === 'M-9')
  assert.match(overlay.evidence, /只读探查未命中/)
})

test('M-10 是真判定：注入未预期 500 + 渲染层 error ⇒ FAIL（failed > 0 ⇒ CLI exit 1）', async t => {
  // fakeSession 默认就注入了一个未预期的 500 与一条 console error：观察项不再恒 INFO。
  const { result } = await runCase(t, {})
  const m10 = result.results.find(row => row.id === 'M-10')
  assert.equal(m10.ok, false, m10.evidence)
  assert.match(m10.evidence, /未预期网络：.*500/)
  assert.match(m10.evidence, /未预期 console error：boom/)
  assert.ok(result.failed > 0, 'failed > 0 正是 CLI exit 1 的分支条件')
})

test('M-10：容忍表命中的请求/日志不判红；干净页面判 PASS', async t => {
  const tolerated = await runCase(t, { mutate: session => {
    session.netFailures = new Map([['503 http://127.0.0.1:9/api/i/x/api/clientGraph/graph', 1]])
    session.consoleErrors = ['[cordis-client-runner] syncing inspect providers failed: boom has no active Connection']
  } })
  const row = tolerated.result.results.find(entry => entry.id === 'M-10')
  assert.equal(row.ok, true, row.evidence)
  assert.match(row.evidence, /已登记容忍/)
  const clean = await runCase(t, { mutate: session => { session.netFailures = new Map(); session.consoleErrors = [] } })
  assert.equal(clean.result.results.find(entry => entry.id === 'M-10').ok, true)
})

test('报告编号顺序与文件头一致：M-8 在 M-9 之前，M-10 收尾', async t => {
  const { result } = await runCase(t, {})
  const ids = result.results.map(row => row.id)
  assert.deepEqual(ids, ['M-1', 'M-2', 'M-3', 'M-4', 'M-5', 'M-6', 'M-7', 'M-8', 'M-9', 'M-10'], ids.join(','))
})

test('connect 失败：写 fail-soft 报告并返回，不抛异常；--require-run 下记 FAIL', async t => {
  const outDir = mkdtempSync(join(tmpdir(), 'walkthrough-connect-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const attempt = requireRun => captureConsole(() => runMobileWalkthrough({
    outDir: requireRun ? outDir + '-strict' : outDir,
    requireRun,
    discover: async () => FAKE_TARGET,
    // 错误文本里带一个环境变量凭据：fail-soft 的打印与报告都必须过同一层脱敏。
    connect: async () => { throw new Error('attach 失败 ws://fake-devtools/page/1?token=SECRET_ENV_TOKEN') },
    settleMs: 0, navigateSettleMs: 0, reloadSettleMs: 0, frameSettleMs: 0,
    env: { DSH_MOBILE_AUTH_TOKEN: 'SECRET_ENV_TOKEN' },
  }))
  const { value: result, stdout } = await attempt(false)
  assert.equal(result.skipped, true)
  assert.equal(result.failed, 0, '默认档：会话建立失败与「没有 CDP 目标」同档，记 INFO')
  assert.equal(result.results[0].id, 'M-0')
  assert.equal(result.results[0].ok, null)
  assert.match(result.results[0].evidence, /CDP 会话建立失败/)
  const report = readFileSync(join(outDir, 'gui-mobile-walkthrough-report.md'), 'utf8')
  assert.match(report, /M-0/)
  assert.ok(!report.includes('SECRET_ENV_TOKEN'), 'fail-soft 报告同样要过脱敏')
  assert.ok(!stdout.includes('SECRET_ENV_TOKEN'), stdout)
  const { value: strict } = await attempt(true)
  assert.equal(strict.failed, 1)
  assert.equal(strict.results[0].ok, false)
  assert.match(strict.results[0].evidence, /--require-run|需要什么/)
})

test('采集中断（evaluate 抛错）：写 fail-soft 报告、关会话、中断记 FAIL', async t => {
  const outDir = mkdtempSync(join(tmpdir(), 'walkthrough-abort-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const session = fakeSession()
  let closed = 0
  session.close = () => { closed += 1 }
  const evaluate = session.evaluate.bind(session)
  session.evaluate = async expression => {
    if (expression === HEADER_FACTS_EXPRESSION) throw new Error('Execution context was destroyed')
    return evaluate(expression)
  }
  const { value: result } = await captureConsole(() => runMobileWalkthrough({
    outDir,
    discover: async () => ({ url: 'http://127.0.0.1:9/', title: 'fake', webSocketDebuggerUrl: 'ws://fake' }),
    connect: async () => session, settleMs: 0, navigateSettleMs: 0, reloadSettleMs: 0, frameSettleMs: 0, env: {},
  }))
  assert.equal(closed, 1, '会话必须被关掉（finally）')
  assert.equal(result.skipped, false, '跑过几腿就不算 skipped')
  assert.equal(result.results[0].id, 'M-0')
  assert.equal(result.results[0].ok, false, '半份报告不能看起来是绿的')
  assert.match(result.results[0].evidence, /采集中断/)
  assert.match(result.results[0].evidence, /Execution context was destroyed/)
  assert.deepEqual(result.results.slice(0, 2).map(row => row.id), ['M-0', 'M-1'], 'M-0 仍排在报告首行')
  assert.ok(result.failed > 0)
  const report = readFileSync(join(outDir, 'gui-mobile-walkthrough-report.md'), 'utf8')
  assert.match(report, /采集中断/)
})

test('设备尺寸跟随 --width/--height/--dpr：M-2 标题、报告标题与 meta.设备、fail-soft 报告', async t => {
  const device = { ...MOBILE_DEVICE, width: 430, height: 932, deviceScaleFactor: 2 }
  const { outDir, result } = await runCase(t, { device })
  const m2 = result.results.find(row => row.id === 'M-2')
  assert.match(m2.title, /430×932@2x/)
  const json = JSON.parse(readFileSync(join(outDir, 'gui-mobile-walkthrough-report.json'), 'utf8'))
  assert.match(json.meta.设备, /430×932 @2x/)
  const md = readFileSync(join(outDir, 'gui-mobile-walkthrough-report.md'), 'utf8')
  assert.match(md, /^# GUI 验收（移动档：CDP 设备模拟走查 430×932@2x）/m)
  // 无目标的 fail-soft 报告也必须写请求设备，而不是默认的 390×844。
  const softDir = mkdtempSync(join(tmpdir(), 'walkthrough-device-'))
  t.after(() => rmSync(softDir, { recursive: true, force: true }))
  const { value: soft } = await captureConsole(() => runMobileWalkthrough({ outDir: softDir, device, discover: async () => null, env: {} }))
  assert.equal(soft.skipped, true)
  const softJson = JSON.parse(readFileSync(join(softDir, 'gui-mobile-walkthrough-report.json'), 'utf8'))
  assert.match(softJson.meta.设备, /430×932 @2x/)
  assert.ok(!softJson.meta.设备.includes('390×844'))
})
