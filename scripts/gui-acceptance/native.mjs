/**
 * Native flavor mode for the GUI acceptance toolbox (G20).
 *
 * The `--flavor native` mode closes the "toolbox only drives Electron" gap at
 * the layer that a headless run CAN check: the Node sidecar the packaged Swift
 * shell spawns (packages/desktop/release/sidecar — the same assembly
 * build-swift-app.mjs embeds). It:
 *
 *   1. resolves the assembly and LOUDLY skips when it is absent (never a silent
 *      pass — a missing native artifact must be visible in the run summary);
 *   2. launches the shipped `sidecar.js` with the bundled node (or the running
 *      node), waits for the real `ready` frame over the NDJSON B bridge, drives
 *      `dsh-chamber:info` + `dsh-chamber:settings-get`, and probes the
 *      control-plane HTTP surface (`/health`, the origin fence, and the shell
 *      index + declared assets when `dist/web` is part of the assembly);
 *   3. terminates the sidecar with SIGTERM and requires a clean exit 0;
 *   4. writes the same report artifacts as the Electron walkthrough.
 *
 * WHAT IT DOES NOT CHECK (honest coverage): the WKWebView UI itself. WKWebView
 * exposes no CDP endpoint, so the native window's DOM, hover cards and settings
 * surface cannot be driven from this toolbox; those stay real-machine
 * acceptance items (docs/checklists/gui-acceptance-checklist.md). `--attach`
 * targets an already-running native shell's control plane through the same
 * minimal HTTP walkthrough; it still cannot attach to the web view.
 *
 * CI: with no sidecar assembly built, the mode prints `SKIP:` and exits 0. Run
 * `pnpm run build:sidecar --skip-vendor --skip-host-packages` (plus
 * `build:control-plane`) first to give it a real artifact.
 *
 * G33: `--require-assembly` (runNativeAcceptance({ requireAssembly: true })) is
 * the machine-gate form: when the assembly is absent the preflight becomes a
 * FAIL instead of a loud SKIP, so a CI step cannot lose its build prerequisite
 * and still exit 0. ci.yml's "Native assembly acceptance" step uses it. What it
 * still cannot check (WKWebView UI, the .app double-click path) stays a
 * documented real-machine item either way.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecorder, isShellIndex, parseShellAssets, renderMarkdown, safeJson } from './checks.mjs'
import { DEFAULT_SIDECAR_DIR, resolveNodeBinary, resolveSidecarDir } from '../lib/sidecar-assembly.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Native-flavor aliases of the shared assembly resolver
 * (scripts/lib/sidecar-assembly.mjs — ONE implementation for the G4 smoke, this
 * toolbox and remote-state-acceptance; P1-4 of the 13-scripts audit).
 */
export { resolveNodeBinary, resolveSidecarDir as resolveNativeSidecarDir }

/**
 * Fail-closed preflight of the native assembly: the entry and the compiled
 * control-plane must both exist. A partial assembly is a build-order bug, so it
 * is reported as a SKIP reason that names the missing artifact (the caller
 * still prints `SKIP:` loudly — never a green "walkthrough complete").
 * @param {{ sidecarDir?: string }} [options] - assembly dir override.
 * @returns {{ ok: true, entry: string, controlPlaneEntry: string } | { ok: false, reason: string, missing: string[] }} verdict.
 */
export function nativePreflight({ sidecarDir = DEFAULT_SIDECAR_DIR } = {}) {
  const entry = path.join(sidecarDir, 'sidecar.js')
  const controlPlaneEntry = path.join(sidecarDir, 'dist', 'control-plane', 'index.js')
  const missing = []
  if (!existsSync(entry)) missing.push(entry)
  if (!existsSync(controlPlaneEntry)) missing.push(controlPlaneEntry)
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `native sidecar assembly is absent or incomplete: ${missing.join(', ')}`
        + ' — build it with pnpm run build:sidecar --skip-vendor --skip-host-packages (and build:control-plane first)',
    }
  }
  return { ok: true, entry, controlPlaneEntry }
}

/**
 * The argv the native sidecar is launched with. Exported so the launch contract
 * (compiled marker, throwaway user data, explicit port) is a testable pure
 * function.
 * @param {{ userDataDir: string, port: number }} input - launch inputs.
 * @returns {string[]} argv.
 */
export function nativeSidecarArgs({ userDataDir, port }) {
  return ['--user-data-dir', userDataDir, '--port', String(port)]
}

/** The environment the shipped sidecar.js requires (compiled assembly marker + no update check). */
export function nativeSidecarEnv(base = process.env) {
  return { ...base, DSH_CHAMBER_SIDECAR_COMPILED: '1', ELECTRON_RUN_AS_NODE: '1', DSH_SIDECAR_TEST_NO_UPDATE_CHECK: '1' }
}

/** Pick a free loopback port for the sidecar's control plane. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

/** A small NDJSON driver for the sidecar stdio (subset of the G4 smoke driver). */
function createBridgeDriver(child) {
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  const notifiers = new Map()
  let nextId = 1
  lines.on('line', (line) => {
    if (line.length === 0) return
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (typeof frame.notify === 'string') {
      const waiter = notifiers.get(frame.notify)
      if (waiter !== undefined) { notifiers.delete(frame.notify); waiter(frame.payload ?? {}) }
      return
    }
    if (typeof frame.id === 'number') {
      const settle = pending.get(frame.id)
      if (settle !== undefined) { pending.delete(frame.id); settle(frame) }
    }
  })
  return {
    waitNotify(name, timeoutMs) {
      return new Promise((resolveNotify, reject) => {
        const timer = setTimeout(() => { notifiers.delete(name); reject(new Error(`timed out waiting for '${name}'`)) }, timeoutMs)
        notifiers.set(name, (payload) => { clearTimeout(timer); resolveNotify(payload) })
      })
    },
    invoke(method, payload, timeoutMs) {
      return new Promise((resolveInvoke, reject) => {
        const id = nextId
        nextId += 1
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out waiting for ${method}`)) }, timeoutMs)
        pending.set(id, (frame) => { clearTimeout(timer); resolveInvoke(frame) })
        child.stdin.write(JSON.stringify({ id, method, payload }) + '\n')
      })
    },
  }
}

/** Minimal HTTP GET returning { status, headers, body }. */
async function get(origin, target, headers = {}) {
  const response = await fetch(`${origin}${target}`, { redirect: 'manual', headers })
  const body = await response.text()
  return { status: response.status, headers: Object.fromEntries(response.headers), body }
}

/**
 * Launch the native sidecar and hold it for the walkthrough.
 * @param {{ sidecarDir: string, outDir: string, timeoutMs?: number }} input - launch inputs.
 * @returns {Promise<{ child: object, port: number, stop: Function, logPath: string, ready: object }>} handle.
 */
export async function launchNativeSidecar({ sidecarDir, outDir, timeoutMs = 30_000 }) {
  mkdirSync(outDir, { recursive: true })
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-native-acceptance-'))
  const port = await freePort()
  const logPath = path.join(outDir, 'native-sidecar.log')
  const child = spawn(resolveNodeBinary(sidecarDir), [path.join(sidecarDir, 'sidecar.js'), ...nativeSidecarArgs({ userDataDir, port })], {
    cwd: sidecarDir,
    env: nativeSidecarEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const driver = createBridgeDriver(child)
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exit = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })))
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode }
    child.kill('SIGTERM')
    const outcome = await Promise.race([
      exit,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ code: 'timeout', signal: null }), 10_000)),
    ])
    if (outcome.code !== 0) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      throw new Error(`native sidecar SIGTERM exit was ${String(outcome.code)} signal ${String(outcome.signal)}, expected 0\n---- stderr tail ----\n${stderr.slice(-800)}`)
    }
    rmSync(userDataDir, { recursive: true, force: true })
    return outcome
  }
  let ready
  try {
    ready = await driver.waitNotify('ready', timeoutMs)
  } catch (error) {
    try { await stop() } catch { /* keep the original timeout as the reported failure */ }
    throw error
  }
  if (typeof ready.port !== 'number') {
    try { await stop() } catch { /* the missing-port report is the primary failure */ }
    throw new Error(`native sidecar ready frame carried no port: ${JSON.stringify(ready)}`)
  }
  writeFileSync(logPath, `native sidecar: port=${port} userData=${userDataDir}\n`)
  return { child, port, stop, logPath, ready, driver, stderrRef: () => stderr }
}

/**
 * Run the native-flavor walkthrough.
 * @param {{ sidecarDir?: string, outDir?: string, attachPlaneOrigin?: string|null, requireAssembly?: boolean, timeoutMs?: number, log?: Function }} [options] - options.
 * @returns {Promise<{ skipped: boolean, reason?: string, results: object[], passed: number, failed: number, info: number, reportPath: string, planeOrigin: string|null }>} verdict.
 */
export async function runNativeAcceptance({
  sidecarDir = resolveSidecarDir(),
  outDir = '.tmp/gui-acceptance',
  attachPlaneOrigin = null,
  requireAssembly = false,
  timeoutMs = 30_000,
  log = console.log,
} = {}) {
  const rec = createRecorder()
  mkdirSync(outDir, { recursive: true })
  const reportPath = path.join(outDir, 'gui-native-report.md')
  let handle = null
  let planeOrigin = attachPlaneOrigin

  const preflight = nativePreflight({ sidecarDir })
  if (!preflight.ok && attachPlaneOrigin === null) {
    // G33: the default form records the missing assembly as INFO/SKIP (a local
    // run without a build is not a product failure); the machine-gate form
    // (--require-assembly) records it as FAIL, so a CI step whose build
    // prerequisite was deleted fails instead of exiting 0 on a skip.
    rec.add('N-0', '原生 sidecar 装配存在', requireAssembly ? false : null, preflight.reason)
    const report = renderMarkdown({
      title: 'GUI 验收（--flavor native：原生 sidecar 走查）',
      meta: { 模式: 'launch', 装配: sidecarDir, 结果: requireAssembly ? 'FAIL（--require-assembly）' : 'SKIP' },
      results: rec.results,
    })
    writeFileSync(reportPath, report)
    writeFileSync(path.join(outDir, 'gui-native-report.json'), JSON.stringify({ skipped: !requireAssembly, reason: preflight.reason, results: rec.results }, null, 2))
    return {
      skipped: !requireAssembly,
      reason: preflight.reason,
      results: rec.results,
      passed: 0,
      failed: requireAssembly ? 1 : 0,
      info: requireAssembly ? 0 : 1,
      reportPath,
      planeOrigin: null,
    }
  }

  try {
    if (attachPlaneOrigin === null) {
      handle = await launchNativeSidecar({ sidecarDir, outDir, timeoutMs })
      planeOrigin = `http://127.0.0.1:${handle.port}`
      rec.add('N-1', '原生 sidecar 就绪（ready 帧带端口）', typeof handle.ready.port === 'number', `port=${handle.port}`)
      const info = await handle.driver.invoke('dsh-chamber:info', null, 10_000)
      const platform = info.ok === true && info.result !== null && typeof info.result === 'object' ? info.result.platform : undefined
      rec.add('N-2', 'B 桥 dsh-chamber:info 应答', info.ok === true && platform === process.platform, `ok=${info.ok} platform=${String(platform)}`)
      const settings = await handle.driver.invoke('dsh-chamber:settings-get', null, 10_000)
      rec.add('N-3', 'B 桥 dsh-chamber:settings-get 应答', settings.ok === true, `ok=${settings.ok}`)
    } else {
      rec.add('N-1', 'attach 模式：不启动 sidecar', true, `plane=${attachPlaneOrigin}`)
    }

    const health = await get(planeOrigin, '/health')
    const healthJson = safeJson(health.body)
    rec.add('N-4', 'GET /health 存活探针', health.status === 200 && healthJson !== null, `status=${health.status} body=${health.body.slice(0, 120)}`)

    const hostile = await get(planeOrigin, '/api/connections', { origin: 'https://evil.example' })
    rec.add('N-5', '敌意 Origin 被拒（403 origin_forbidden）', hostile.status === 403 && hostile.body.includes('origin_forbidden'),
      `status=${hostile.status} body=${hostile.body.slice(0, 120)}`)

    const shell = await get(planeOrigin, '/')
    const webDist = path.join(sidecarDir, 'dist', 'web', 'index.html')
    if (isShellIndex(shell.status, shell.body)) {
      const assets = parseShellAssets(shell.body)
      const assetResults = []
      for (const asset of assets) {
        const probe = await get(planeOrigin, asset)
        assetResults.push(`${asset}→${probe.status}`)
      }
      rec.add('N-6', '原生装配壳 index 与声明资源可服务', assets.length > 0 && assetResults.every((item) => item.endsWith('→200')), assetResults.join(' ') || '（无声明资源）')
    } else if (!existsSync(webDist)) {
      rec.add('N-6', '原生装配壳（本次装配未携带 dist/web，未执行）', null,
        `status=${shell.status}；--skip-vendor 装配不含 dist/web；打包 .app 的 Swift 侧另有 web dist 装载断言`)
    } else {
      rec.add('N-6', '原生装配壳 index 服务', false, `status=${shell.status} body=${shell.body.slice(0, 120)}`)
    }
  } catch (error) {
    rec.add('N-err', '原生走查执行异常', false, String(error instanceof Error ? error.message : error))
  } finally {
    if (handle !== null) {
      try {
        await handle.stop()
        rec.add('N-7', 'sidecar SIGTERM 干净退出（exit 0）', true, 'exit 0')
      } catch (error) {
        rec.add('N-7', 'sidecar SIGTERM 干净退出（exit 0）', false, String(error instanceof Error ? error.message : error))
      }
    }
  }

  const counts = { passed: rec.passed, failed: rec.failed }
  const report = renderMarkdown({
    title: 'GUI 验收（--flavor native：原生 sidecar 走查）',
    meta: {
      模式: attachPlaneOrigin === null ? 'launch' : 'attach',
      控制面: planeOrigin,
      装配: sidecarDir,
      覆盖: 'sidecar 就绪/B 桥/US 面（HTTP）；WKWebView UI 不可驱动（无 CDP），仍属实机验收',
    },
    results: rec.results,
  })
  writeFileSync(reportPath, report)
  writeFileSync(path.join(outDir, 'gui-native-report.json'), JSON.stringify({
    skipped: false,
    meta: { mode: attachPlaneOrigin === null ? 'launch' : 'attach', planeOrigin, sidecarDir },
    results: rec.results,
  }, null, 2))
  log(`\n=== --flavor native: ${counts.passed} pass / ${counts.failed} fail / ${rec.results.length} checks ===\nreport: ${reportPath}`)
  return { skipped: false, results: rec.results, passed: counts.passed, failed: counts.failed, info: rec.results.filter((entry) => entry.ok === null).length, reportPath, planeOrigin }
}
