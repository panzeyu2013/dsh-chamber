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
 *      index + declared assets against the resolved web dist: explicit
 *      `--web-dist`, else `sidecarDir/dist/web` → `sidecarDir/../dist/web`);
 *   3. terminates the sidecar with SIGTERM and requires a clean exit 0;
 *   4. writes the same report artifacts as the Electron walkthrough.
 *
 * WHAT IT DOES NOT CHECK (honest coverage): the WKWebView UI itself. WKWebView
 * exposes no CDP endpoint, so the native window's DOM, hover cards and settings
 * surface cannot be driven from this toolbox; those stay real-machine
 * acceptance items (docs/checklists/gui-acceptance-checklist.md). `--attach`
 * targets an already-running native shell's control plane through the same
 * minimal HTTP walkthrough; it still cannot attach to the web view. Attach mode
 * records N-1/N-7 as INFO — no ready frame is observed and there is no sidecar
 * lifecycle to terminate — so the report never claims a launch that did not
 * happen (an unobserved ready frame is not a PASS).
 *
 * CI: with no sidecar assembly built, the mode prints `SKIP:` and exits 0. Run
 * `pnpm run build:sidecar --skip-vendor --skip-host-packages` (plus
 * `build:control-plane`) first to give it a real artifact.
 *
 * G33: `--require-assembly` (runNativeAcceptance({ requireAssembly: true })) is
 * the machine-gate form: when the assembly is absent the preflight becomes a
 * FAIL instead of a loud SKIP, so a CI step cannot lose its build prerequisite
 * and still exit 0. ci.yml's "Native assembly acceptance" step uses it. N-6
 * follows the same rule: when no web dist can be found the shell index + declared
 * assets leg cannot execute, and the machine gate records it as FAIL naming the
 * missing index.html instead of INFO (the default form keeps INFO) — a green CI
 * run must mean that leg really ran. What it still cannot check (WKWebView UI,
 * the .app double-click path) stays a documented real-machine item either way.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecorder, isShellIndex, parseShellAssets, renderMarkdown, safeJson } from './checks.mjs'
import { DEFAULT_SIDECAR_DIR, resolveNodeBinary, resolveSidecarDir } from '../lib/sidecar-assembly.mjs'
import { freeLoopbackPort, sidecarLaunchArgs, sidecarLaunchEnv } from '../lib/sidecar-launch.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Native-flavor aliases of the shared assembly resolver
 * (scripts/lib/sidecar-assembly.mjs — ONE implementation for the G4 smoke, this
 * toolbox and remote-state-acceptance).
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
 * The web dist N-6 must judge, resolved the way the packaged shell resolves it
 * (macos/Sources/DSHChamber/AppDelegate.swift: explicit arg, else the
 * `<Resources>/dist/web` / `sidecar/dist/web` mirror pair).
 *
 * Resolution order: an explicit `--web-dist` wins (the CI step passes the
 * renderer output it just built); otherwise the two same-named candidates are
 * probed in the order `sidecarDir/dist/web` → `sidecarDir/../dist/web` (the
 * latter IS the .app layout's `Contents/Resources/dist/web`). The
 * judgement is `index.html` existing, not the directory existing: an empty
 * directory left behind by a failed build is exactly the "carried but broken"
 * shape that must not read as ready (build-swift-app.mjs uses the same judge).
 * @param {{ sidecarDir?: string, webDistDir?: string|null }} [options] - assembly dir and explicit override.
 * @returns {{ dir: string, source: 'explicit'|'detected'|'missing', ready: boolean, candidates: string[] }} verdict.
 */
export function resolveNativeWebDistDir({ sidecarDir = DEFAULT_SIDECAR_DIR, webDistDir = null } = {}) {
  const candidates = [
    path.join(sidecarDir, 'dist', 'web'),
    // .app 布局：Contents/Resources/sidecar → Contents/Resources/dist/web（join 会把 `..` 归一）。
    path.join(sidecarDir, '..', 'dist', 'web'),
  ]
  if (typeof webDistDir === 'string' && webDistDir.trim() !== '') {
    const explicit = path.resolve(webDistDir.trim())
    return { dir: explicit, source: 'explicit', ready: existsSync(path.join(explicit, 'index.html')), candidates: [explicit] }
  }
  for (const candidate of candidates) {
    // 探测结果要交给子进程（--web-dist-dir），而子进程 cwd=sidecarDir：相对候选必须
    // 先按本进程 cwd 定死，否则同一路径在父子进程里指向两处。existsSync 用的就是同一基准。
    if (existsSync(path.join(candidate, 'index.html'))) return { dir: path.resolve(candidate), source: 'detected', ready: true, candidates }
  }
  return { dir: candidates[0], source: 'missing', ready: false, candidates }
}

/**
 * The argv the native sidecar is launched with — the shared launch contract
 * (scripts/lib/sidecar-launch.mjs) plus the packaged shell's web-dist flag.
 * Exported so the contract stays a testable pure function.
 *
 * WHY `--web-dist-dir`: without it the sidecar serves a temporary stub UI
 * (sidecar-entry.ts), so "the shell index + declared assets are servable" would
 * have no real object to judge. The packaged .app passes the flag unconditionally
 * (AppDelegate); this leg passes it whenever a ready web dist was resolved, so
 * N-6 drives the same static-serving chain.
 * @param {{ userDataDir: string, port: number, webDistDir?: string|null }} input - launch inputs.
 * @returns {string[]} argv.
 */
export function nativeSidecarArgs({ userDataDir, port, webDistDir = null }) {
  const args = sidecarLaunchArgs({ userDataDir, port })
  if (typeof webDistDir === 'string' && webDistDir !== '') args.push('--web-dist-dir', webDistDir)
  return args
}

/** The environment the shipped sidecar.js requires — the shared launch contract
 * (scripts/lib/sidecar-launch.mjs: compiled marker + update-check opt-out).
 * @param {NodeJS.ProcessEnv} [base] - the environment to extend.
 * @returns {NodeJS.ProcessEnv} the launch environment.
 */
export function nativeSidecarEnv(base = process.env) {
  return sidecarLaunchEnv(base)
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
 * @param {{ sidecarDir: string, outDir: string, timeoutMs?: number, webDistDir?: string|null }} input - launch inputs.
 * @returns {Promise<{ child: object, port: number, stop: Function, logPath: string, ready: object }>} handle.
 */
export async function launchNativeSidecar({ sidecarDir, outDir, timeoutMs = 30_000, webDistDir = null }) {
  mkdirSync(outDir, { recursive: true })
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-native-acceptance-'))
  const port = await freeLoopbackPort()
  const logPath = path.join(outDir, 'native-sidecar.log')
  const child = spawn(resolveNodeBinary(sidecarDir), [path.join(sidecarDir, 'sidecar.js'), ...nativeSidecarArgs({ userDataDir, port, webDistDir })], {
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
 * @param {{ sidecarDir?: string, outDir?: string, attachPlaneOrigin?: string|null, requireAssembly?: boolean, webDistDir?: string|null, timeoutMs?: number, log?: Function }} [options] - options.
 * @returns {Promise<{ skipped: boolean, reason?: string, results: object[], passed: number, failed: number, info: number, reportPath: string, planeOrigin: string|null }>} verdict.
 */
export async function runNativeAcceptance({
  sidecarDir = resolveSidecarDir(),
  outDir = '.tmp/gui-acceptance',
  attachPlaneOrigin = null,
  requireAssembly = false,
  webDistDir = null,
  timeoutMs = 30_000,
  log = console.log,
} = {}) {
  const rec = createRecorder()
  mkdirSync(outDir, { recursive: true })
  const reportPath = path.join(outDir, 'gui-native-report.md')
  let handle = null
  let planeOrigin = attachPlaneOrigin
  // Resolved once: the launch flag and N-6's verdicts must agree on ONE web dist.
  const webDist = resolveNativeWebDistDir({ sidecarDir, webDistDir })

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
      // Only a ready web dist is handed over: pointing the sidecar at a directory
      // without index.html would turn a missing renderer build into a boot
      // failure (N-err) instead of N-6's named FAIL/INFO.
      handle = await launchNativeSidecar({ sidecarDir, outDir, timeoutMs, webDistDir: webDist.ready ? webDist.dir : null })
      planeOrigin = `http://127.0.0.1:${handle.port}`
      rec.add('N-1', '原生 sidecar 就绪（ready 帧带端口）', typeof handle.ready.port === 'number', `port=${handle.port}`)
      const info = await handle.driver.invoke('dsh-chamber:info', null, 10_000)
      const platform = info.ok === true && info.result !== null && typeof info.result === 'object' ? info.result.platform : undefined
      rec.add('N-2', 'B 桥 dsh-chamber:info 应答', info.ok === true && platform === process.platform, `ok=${info.ok} platform=${String(platform)}`)
      const settings = await handle.driver.invoke('dsh-chamber:settings-get', null, 10_000)
      rec.add('N-3', 'B 桥 dsh-chamber:settings-get 应答', settings.ok === true, `ok=${settings.ok}`)
    } else {
      // Attach never launches a sidecar, so no ready frame can be observed: an
      // unobserved frame is INFO, not a vacuous PASS (the old shape passed N-1
      // just for being in attach mode).
      rec.add('N-1', '原生 sidecar 就绪（ready 帧带端口）', null,
        `未执行：attach 模式指向运行中的原生壳（plane=${attachPlaneOrigin}），不启动 sidecar；未观测 ready 帧`)
    }

    const health = await get(planeOrigin, '/health')
    const healthJson = safeJson(health.body)
    rec.add('N-4', 'GET /health 存活探针', health.status === 200 && healthJson !== null, `status=${health.status} body=${health.body.slice(0, 120)}`)

    const hostile = await get(planeOrigin, '/api/connections', { origin: 'https://evil.example' })
    rec.add('N-5', '敌意 Origin 被拒（403 origin_forbidden）', hostile.status === 403 && hostile.body.includes('origin_forbidden'),
      `status=${hostile.status} body=${hostile.body.slice(0, 120)}`)

    const shell = await get(planeOrigin, '/')
    if (isShellIndex(shell.status, shell.body)) {
      const assets = parseShellAssets(shell.body)
      const assetResults = []
      for (const asset of assets) {
        const probe = await get(planeOrigin, asset)
        assetResults.push(`${asset}→${probe.status}`)
      }
      rec.add('N-6', '原生装配壳 index 与声明资源可服务', assets.length > 0 && assetResults.every((item) => item.endsWith('→200')), assetResults.join(' ') || '（无声明资源）')
    } else if (!webDist.ready) {
      // The leg could not execute: no web dist was resolved (explicitly pointed at
      // an incomplete dir, or neither candidate carries index.html). INFO is
      // honest for a local run; under --require-assembly it is a FAIL that names
      // the missing artifact, so a CI step cannot keep its green while the
      // "shell index + declared assets" chain never ran.
      const missing = webDist.source === 'explicit'
        ? `--web-dist 指向的目录缺 index.html：${path.join(webDist.dir, 'index.html')}`
        : `未找到携带 web dist 的目录，候选均缺 index.html：${webDist.candidates.map((candidate) => path.join(candidate, 'index.html')).join('、')}`
      rec.add(
        'N-6',
        webDist.source === 'explicit'
          ? '原生装配壳 index 与声明资源可服务（无法执行：--web-dist 目录不完整）'
          : '原生装配壳 index 与声明资源可服务（无法执行：未找到 web dist）',
        requireAssembly ? false : null,
        `${missing}；status=${shell.status}（控制面未伺服壳 index）；补救：pnpm run build:renderer 后把产物目录传给 --web-dist`
          + `（或 --sidecar-dir 指向自带 dist/web 的装配）${requireAssembly ? '——--require-assembly：本腿必须真执行，缺件即 FAIL' : '——本次为默认档，记 INFO'}`,
      )
    } else {
      rec.add('N-6', '原生装配壳 index 服务', false,
        `status=${shell.status} body=${shell.body.slice(0, 120)}；web dist=${webDist.dir}（index.html 在，但伺服的不是壳 index）`)
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
    } else if (attachPlaneOrigin !== null) {
      // attach has no sidecar lifecycle: it neither spawns nor terminates the
      // running shell, so the SIGTERM leg is INFO with the reason, never a
      // silently missing row (the old shape just omitted N-7).
      rec.add('N-7', 'sidecar SIGTERM 干净退出（exit 0）', null,
        '未执行：attach 模式无 sidecar 生命周期（不启动、不终止运行中的原生壳）')
    }
  }

  const counts = { passed: rec.passed, failed: rec.failed, info: rec.results.filter((entry) => entry.ok === null).length }
  const report = renderMarkdown({
    title: 'GUI 验收（--flavor native：原生 sidecar 走查）',
    meta: {
      模式: attachPlaneOrigin === null ? 'launch' : 'attach',
      控制面: planeOrigin,
      装配: sidecarDir,
      'web dist': webDist.ready ? webDist.dir : `未找到（候选：${webDist.candidates.join('、')}）`,
      覆盖: 'sidecar 就绪/B 桥/US 面（HTTP）；WKWebView UI 不可驱动（无 CDP），仍属实机验收',
    },
    results: rec.results,
  })
  writeFileSync(reportPath, report)
  writeFileSync(path.join(outDir, 'gui-native-report.json'), JSON.stringify({
    skipped: false,
    meta: { mode: attachPlaneOrigin === null ? 'launch' : 'attach', planeOrigin, sidecarDir, webDistDir: webDist.ready ? webDist.dir : null },
    results: rec.results,
  }, null, 2))
  // The tail line must not overstate coverage: INFO rows are counted separately
  // from the rows that actually decided something (pass+fail).
  log(`\n=== --flavor native: ${counts.passed} pass / ${counts.failed} fail / ${counts.info} info（共 ${rec.results.length} 项，实际执行 ${counts.passed + counts.failed} 项） ===\nreport: ${reportPath}`)
  return { skipped: false, results: rec.results, passed: counts.passed, failed: counts.failed, info: counts.info, reportPath, planeOrigin }
}
