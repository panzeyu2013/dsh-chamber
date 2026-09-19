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
import { runMobileWalkthrough } from './mobile-walkthrough.mjs'
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
        dpr: 3, screenWidth: 390, maxTouchPoints: 5, ontouchstart: true,
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
 *  which under `node --test` carries the runner's own per-test report (2026-12 review). */
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
async function runCase(t, { wsFrames = 'summary', requireRun = false, target = FAKE_TARGET, frames = [], url = null } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'walkthrough-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const session = fakeSession()
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
    discover: async () => target,
    connect: async () => {
      for (const [method, params] of planted) session.deliver(method, params)
      return session
    },
    settleMs: 0,
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
  // which made dropping the `secrets:` argument invisible (2026-12 mutation M31).
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
        // Unmeasurable overflow (`overflowVerdict` returns ok:null): only the --require-run gate turns M-3 into a FAIL (2026-12 mutation M34).
        scrollWidth: null, scrollHeight: null, visualViewport: { width: 390, height: 844, scale: 1 }, dpr: 3,
        screenWidth: 390, maxTouchPoints: 5, ontouchstart: true, pointerCoarse: true, pointerFine: false,
        hoverNone: true, anyPointerCoarse: true, touchTier: true, phoneTier: true, rootSlots: 0, mobileFrames: 0,
        mobileRoles: [], pluginStyle: true, hasOutlet: false, hasHeader: false, headerBox: null, firstRowBox: null,
        headerChildren: [], tabs: [], buttons: [], lineage: null, texts: [], sessionHeaderPresent: false, rootPhase: null })
  const { value: result } = await captureConsole(() => runMobileWalkthrough({
    outDir, requireRun: true,
    discover: async () => ({ url: 'http://127.0.0.1:9/', title: 'fake', webSocketDebuggerUrl: 'ws://fake' }),
    connect: async () => session, settleMs: 0, env: {},
  }))
  assert.equal(result.failed >= 5, true, `M-1/M-3/M-5/M-6/M-7 must fail under --require-run (failed=${result.failed})`)
  const byId = new Map(result.results.map(row => [row.id, row.ok]))
  for (const id of ['M-1', 'M-3', 'M-5', 'M-6', 'M-7']) assert.equal(byId.get(id), false, `${id} must be FAIL`)
})
