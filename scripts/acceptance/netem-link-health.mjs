#!/usr/bin/env node
/**
 * Real-link acceptance for design 27 (weak-network resilience): a REAL tc netem
 * impairment on a REAL veth pair, with the REAL transport manager, its REAL TCP
 * port probe and the REAL gateway identity probe (no fakes anywhere).
 *
 * Why this exists: the transport unit tests inject probe/verify fakes and the
 * design's §7 matrix ("netem 100/300ms, 1/5% loss, 10s blackhole, flap") had no
 * executable form. This script is that form: it builds a two-namespace link,
 * shapes it with netem, and asserts the link-health sequence
 *
 *   impaired-but-alive → ready/healthy
 *   blackhole          → suspect → down while the phase stays ready (grace)
 *   recovery in grace  → healthy, NO reconnect (phase never leaves ready)
 *   blackhole past grace → leaves ready (a reconnect actually happens, after grace)
 *   OS-resume path     → reverifyAll() recovers a ready+down link immediately,
 *                        while the periodic cadence is 5s away (proves the seam)
 *
 * Requirements: Linux, root (CAP_NET_ADMIN), iproute2 (ip/tc), util-linux
 * (unshare/nsenter). It is NOT part of the test gate (needs privileges); run it
 * explicitly: `pnpm run acceptance:netem`. Exit code 0 = every check passed.
 * Cleanup (veth + namespace holder + stub) always runs, including on SIGINT.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const NODE = process.execPath
const LOCAL_IP = '10.99.0.1'
const REMOTE_IP = '10.99.0.2'
const STUB_PORT = 3080
const INSTANCE_ID = 'netem'
const VETH_LOCAL = 'dshnet0'
const VETH_REMOTE = 'dshnet1'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
}
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)}): ${result.stderr || result.stdout}`)
  }
  return result.stdout ?? ''
}

function requirePrivileges() {
  if (process.platform !== 'linux') throw new Error('netem acceptance is Linux-only')
  if (process.getuid?.() !== 0) throw new Error('netem acceptance needs root (CAP_NET_ADMIN)')
  for (const command of ['ip', 'tc', 'unshare', 'nsenter']) {
    if (spawnSync('which', [command]).status !== 0) throw new Error(`missing required tool: ${command}`)
  }
  if (spawnSync('unshare', ['-n', 'true']).status !== 0) throw new Error('cannot create a network namespace (unshare -n)')
}

const state = { holder: null, stub: null, manager: null, proxy: null, dir: null }

/** The gateway runtime-identity stub, served INSIDE the impaired namespace. */
function writeStub(dir) {
  const path = join(dir, 'gateway-stub.mjs')
  writeFileSync(path, [
    "import { createServer } from 'node:http'",
    'const server = createServer((req, res) => {',
    "  if (req.url === '/chamber/runtime/status') {",
    "    res.writeHead(200, { 'content-type': 'application/json' })",
    "    res.end(JSON.stringify({ kind: 'dsh-chamber-gateway-runtime' }))",
    '    return',
    '  }',
    "  if (req.url === '/bulk-upload') {",
    '    let bytes = 0',
    "    req.on('data', chunk => { bytes += chunk.length })",
    "    req.on('end', () => {",
    "      res.writeHead(200, { 'content-type': 'application/json' })",
    '      res.end(JSON.stringify({ bytes }))',
    '    })',
    '    return',
    '  }',
    "  res.writeHead(404, { 'content-type': 'application/json' })",
    '  res.end(JSON.stringify({ error: "not found" }))',
    '})',
    `server.listen(${STUB_PORT}, '${REMOTE_IP}', () => { console.log('stub-ready') })`,
    "process.on('SIGTERM', () => server.close(() => process.exit(0)))",
  ].join('\n'), 'utf8')
  return path
}

async function setup(dir) {
  const holder = spawn('unshare', ['-n', 'sleep', '600'], { stdio: 'ignore' })
  state.holder = holder
  await sleep(150)
  if (holder.pid === undefined) throw new Error('failed to start the namespace holder')
  const pid = String(holder.pid)
  run('ip', ['link', 'add', VETH_LOCAL, 'type', 'veth', 'peer', 'name', VETH_REMOTE])
  run('ip', ['link', 'set', VETH_REMOTE, 'netns', pid])
  run('ip', ['addr', 'add', `${LOCAL_IP}/30`, 'dev', VETH_LOCAL])
  run('ip', ['link', 'set', VETH_LOCAL, 'up'])
  run('nsenter', ['-t', pid, '-n', 'ip', 'addr', 'add', `${REMOTE_IP}/30`, 'dev', VETH_REMOTE])
  run('nsenter', ['-t', pid, '-n', 'ip', 'link', 'set', VETH_REMOTE, 'up'])
  run('nsenter', ['-t', pid, '-n', 'ip', 'link', 'set', 'lo', 'up'])
  const stub = spawn('nsenter', ['-t', pid, '-n', NODE, writeStub(dir)], { stdio: ['ignore', 'pipe', 'inherit'] })
  state.stub = stub
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway stub did not start')), 10_000)
    stub.stdout.on('data', chunk => {
      if (String(chunk).includes('stub-ready')) { clearTimeout(timer); resolvePromise() }
    })
  })
  return { pid }
}

/** Shape both directions: delay/jitter/loss on egress of each end. */
function shape(delayMs, lossPercent, rateMbit) {
  const netem = ['root', 'netem', 'delay', `${String(delayMs)}ms`, '20ms', 'loss', `${String(lossPercent)}%`]
  if (rateMbit !== undefined) netem.push('rate', `${String(rateMbit)}mbit`)
  run('tc', ['qdisc', 'replace', 'dev', VETH_LOCAL, ...netem])
  run('nsenter', ['-t', String(state.holder.pid), '-n', 'tc', 'qdisc', 'replace', 'dev', VETH_REMOTE, ...netem])
}

function blackhole(on) {
  shape(0, on ? 100 : 0)
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return false
}

async function main() {
  requirePrivileges()
  const { createTransportManager } = await import(new URL('../../packages/desktop/transport-manager.ts', import.meta.url).href)
  const { gatewayProvider } = await import(new URL('../../packages/desktop/gateway-provider.ts', import.meta.url).href)
  state.dir = mkdtempSync(join(tmpdir(), 'dsh-netem-'))
  await setup(state.dir)

  // The instance proxy exists for the optional 20MB scenario, and the MANAGER is
  // wired to its busy window exactly like production: its probes must not count a
  // timeout behind our own upload as link death.
  const { createInstanceProxy } = await import(new URL('../../packages/control-plane/src/instance-proxy.ts', import.meta.url).href)
  state.proxy = createInstanceProxy({
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    getLocalState: () => 'ready',
    getLocalDshPort: () => null,
    busyActivityWindowMs: 2_000,
  })

  // A tight probe budget so the blackhole scenarios finish in seconds; the
  // production budget (35s) only changes how long a hung probe may wait.
  const provider = { ...gatewayProvider, verifyUpBudgetMs: 1_000 }
  state.manager = createTransportManager({
    provider,
    instancesFile: join(state.dir, 'instances.json'),
    logger: {
      log: () => {},
      warn: line => console.log('      [manager]', line),
      error: line => console.log('      [manager]', line),
    },
    allocatePort: async () => 43123,
    options: {
      readyTimeoutMs: 20_000,
      probeIntervalMs: 200,
      retryBaseMs: 400,
      retryMaxMs: 2_000,
      maxRetryAttempts: 5,
      disconnectGraceMs: 300,
      // Production wiring: the manager's busy signal is the proxy's, so the
      // 20MB scenario below exercises the real seam (not a hand-made fake).
      linkBusy: (id) => state.proxy?.isLinkBusy(`gateway:${id}`) ?? false,
      linkPolicy: {
        probeTimeoutMs: 1_500,
        // 5s: long enough that a recovery observed in <1.5s can ONLY come from the
        // forced seam (reverify/reverifyAll), never from the periodic cadence.
        suspectProbeIntervalMs: 5_000,
        reachableProbeIntervalMs: 1_000,
        healthyProbeIntervalMs: 30_000,
        watchProbeIntervalMs: 30_000,
        watchWindowMs: 60_000,
        failuresBeforeDown: 2,
        downGraceMs: 3_000,
      },
    },
  })
  // Phase history: the "no reconnect" / "reconnect happened" claims need evidence.
  const phases = []
  state.manager.onStatusChanged((_id, projection) => { phases.push(projection.phase) })
  const phasesSince = mark => phases.slice(mark)

  state.manager.saveInstances([{
    id: INSTANCE_ID,
    kind: 'gateway',
    label: 'netem',
    transport: 'http',
    host: REMOTE_IP,
    remotePort: STUB_PORT,
    insecureHttp: true,
  }])
  const status = () => state.manager.status(INSTANCE_ID)

  // 300ms RTT, 2% loss: the link must reach ready and STAY healthy.
  shape(150, 2)
  state.manager.connect(INSTANCE_ID)
  check('impaired link (300ms RTT, 2% loss) reaches ready',
    await waitFor(() => status()?.phase === 'ready', 20_000),
    `phase=${status()?.phase}`)

  // 2% loss can drop a probe's SYN/segment (the 1s budget then reports suspect):
  // that is honest classification, so the invariant is "never down", not "never
  // suspect". The link must also be healthy again by the end.
  let everDown = false
  for (let index = 0; index < 3; index += 1) {
    state.manager.reverify(INSTANCE_ID, 'resume')
    await sleep(700)
    if (status()?.link?.state === 'down') everDown = true
  }
  const healthyAtEnd = await (async () => {
    for (let index = 0; index < 4; index += 1) {
      state.manager.reverify(INSTANCE_ID, 'resume')
      await sleep(400)
      if (status()?.phase === 'ready' && status()?.link?.state === 'healthy') return true
    }
    return false
  })()
  check('impaired link (2% loss) never goes down and heals back to ready+healthy',
    !everDown && healthyAtEnd,
    `phase=${status()?.phase} link=${status()?.link?.state} everDown=${String(everDown)}`)

  // Blackhole: one failed probe = suspect, the second = down, but the PHASE must
  // stay ready inside the grace window (in-flight traffic keeps its chance).
  blackhole(true)
  state.manager.reverify(INSTANCE_ID, 'resume')
  check('blackhole: the first failed probe marks the link suspect',
    await waitFor(() => status()?.link?.state === 'suspect', 4_000),
    `link=${status()?.link?.state}`)
  state.manager.reverify(INSTANCE_ID, 'resume')
  check('blackhole: the second failed probe marks it down',
    await waitFor(() => status()?.link?.state === 'down', 4_000),
    `link=${status()?.link?.state}`)
  check('down inside the grace window keeps the phase ready', status()?.phase === 'ready',
    `phase=${status()?.phase}`)

  // Recovery inside the grace window: a forced probe heals it. With the periodic
  // cadence at 5s (beyond the 3s grace) and no reconnect in the phase history,
  // the healing MUST have come from the probe, not from a teardown cycle.
  const markGrace = phases.length
  blackhole(false)
  state.manager.reverify(INSTANCE_ID, 'resume')
  check('recovery inside the grace window returns to healthy without a reconnect',
    await waitFor(() => status()?.phase === 'ready' && status()?.link?.state === 'healthy', 2_500),
    `phase=${status()?.phase} link=${status()?.link?.state}`)
  check('the grace-window recovery never left ready', !phasesSince(markGrace).includes('connecting'),
    `phases=${phasesSince(markGrace).join(',') || '(none)'}`)

  // Blackhole past the grace window: the phase leaves ready (teardown/reconnect),
  // and it waits out the grace rather than giving up immediately. TWO forced probes
  // are needed to reach down (the periodic cadence is 5s), and the elapsed time is
  // measured from the OBSERVED down edge — otherwise the assertion could pass
  // without a down edge ever happening.
  blackhole(true)
  state.manager.reverify(INSTANCE_ID, 'resume')
  await waitFor(() => status()?.link?.state === 'suspect', 4_000)
  state.manager.reverify(INSTANCE_ID, 'resume')
  const reachedDown = await waitFor(() => status()?.link?.state === 'down', 4_000)
  const downAt = Date.now()
  check('the blackhole actually reached down before the grace measurement', reachedDown && status()?.phase === 'ready',
    `phase=${status()?.phase} link=${status()?.link?.state}`)
  check('down past the grace window leaves ready (reconnect)',
    await waitFor(() => status()?.phase !== 'ready', 8_000),
    `phase=${status()?.phase} after ${String(Date.now() - downAt)}ms`)
  check('the reconnect waited out the grace window', Date.now() - downAt >= 2_750,
    `${String(Date.now() - downAt)}ms since the down edge`)

  // The teardown happened while the blackhole was still on: clear it so the retry
  // loop can actually come back (a reconnect into a black hole can never succeed).
  blackhole(false)
  check('reconnected after the grace window', await waitFor(() => status()?.phase === 'ready', 20_000),
    `phase=${status()?.phase}`)

  // OS-resume / renderer-online path: get back to ready+down INSIDE a grace window,
  // clear the impairment, and force the resume wave. The periodic cadence is 5s
  // away, so a <1.5s recovery proves reverifyAll() did the work.
  blackhole(true)
  state.manager.reverify(INSTANCE_ID, 'resume')
  await waitFor(() => status()?.link?.state === 'suspect', 4_000)
  state.manager.reverify(INSTANCE_ID, 'resume')
  const downAgain = await waitFor(() => status()?.link?.state === 'down', 4_000)
  check('the resume scenario starts from ready+down', downAgain && status()?.phase === 'ready',
    `phase=${status()?.phase} link=${status()?.link?.state}`)
  blackhole(false)
  const resumedAt = Date.now()
  state.manager.reverifyAll()
  check('reverifyAll (OS resume / online) recovers a ready+down link immediately',
    await waitFor(() => status()?.phase === 'ready' && status()?.link?.state === 'healthy', 1_500),
    `after ${String(Date.now() - resumedAt)}ms, phase=${status()?.phase} link=${status()?.link?.state}`)

  // OPT-IN: the 20MB@2Mbps scenario (~90s) — the only one that exercises the busy
  // window against a REAL shaped uplink and a concurrent manager probe.
  if (process.env.NETEM_BULK_UPLOAD === '1') {
    await runBulkUploadScenario()
  }
}

/**
 * OPTIONAL heavy scenario (NETEM_BULK_UPLOAD=1): 20MB through the REAL instance
 * proxy over a 2mbit link, while the transport manager probes the SAME link. This
 * is the H3 case the design names: without the busy window the probe times out
 * behind our own upload and the link is judged down mid-transfer.
 */
async function runBulkUploadScenario() {
  const { createServer } = await import('node:http')
  const proxy = state.proxy
  proxy.registerTransport('gateway:netem', `http://${REMOTE_IP}:${String(STUB_PORT)}`)
  const listener = createServer((req, res) => { void proxy.handleHttp(req, res) })
  await new Promise(resolvePromise => listener.listen(0, '127.0.0.1', resolvePromise))
  const proxyPort = listener.address().port

  shape(150, 0, 2) // 2mbit, both directions
  let busyObserved = false
  let downObserved = false
  const sampler = setInterval(() => {
    if (proxy.isLinkBusy('gateway:netem')) busyObserved = true
    if (state.manager.status(INSTANCE_ID)?.link?.state === 'down') downObserved = true
  }, 100)

  const { request } = await import('node:http')
  const payload = Buffer.alloc(20 * 1024 * 1024, 0x61)
  const startedAt = Date.now()
  const outcome = await new Promise(resolvePromise => {
    const req = request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/api/i/gateway-netem/bulk-upload',
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': payload.length },
    }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', error => resolvePromise({ status: 0, body: String(error) }))
    req.end(payload)
  }).catch(error => ({ status: 0, body: String(error) }))
  clearInterval(sampler)
  const elapsedMs = Date.now() - startedAt
  let bytes = -1
  try { bytes = JSON.parse(outcome.body).bytes } catch { /* not our answer */ }
  check('20MB@2mbit upload completes through the real proxy',
    outcome.status === 200 && bytes === payload.length,
    `status=${String(outcome.status)} bytes=${String(bytes)} after ${String(elapsedMs)}ms`)
  check('the upload owns the link (busy window observed)', busyObserved,
    `busy=${String(busyObserved)}`)
  check('the upload never gets the link judged down', !downObserved,
    `link=${state.manager.status(INSTANCE_ID)?.link?.state}`)

  proxy.closeAllStreams()
  proxy.unregisterTransport('gateway:netem')
  await new Promise(resolvePromise => listener.close(() => resolvePromise()))
  // Restore the base profile for nothing else to depend on (script ends after this).
  shape(150, 2)
}

let cleanupDone = false
function cleanup() {
  if (cleanupDone) return
  cleanupDone = true
  try { state.manager?.dispose() } catch { /* best effort */ }
  try { state.proxy?.closeAllStreams() } catch { /* best effort */ }
  try {
    state.stub?.kill('SIGTERM')
    state.holder?.kill('SIGKILL')
  } catch { /* best effort */ }
  spawnSync('ip', ['link', 'del', VETH_LOCAL])
  try { if (state.dir !== null) rmSync(state.dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nnetem acceptance interrupted (${signal}); cleaning up`)
    cleanup()
    process.exit(130)
  })
}

try {
  await main()
} catch (error) {
  console.error('netem acceptance crashed:', error)
  check('harness completed', false, String(error))
} finally {
  cleanup()
  const failed = results.filter(result => !result.ok)
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} netem acceptance checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}
