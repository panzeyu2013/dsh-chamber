/**
 * `--dev` launcher: a THROWAWAY dev dsh-chamber with its own user-data dir, its
 * own control-plane port and a CDP port, so the walkthrough never touches the
 * packaged app's state (sessions, connections, credentials).
 *
 * Mirrors packages/desktop/scripts/electron-dev.mjs and reuses its shared
 * Electron-dist resolver (single source for the binary cache); the additions are
 * the CDP switch and a readiness wait.
 *
 * PIPE DISCIPLINE: the child's stdout/stderr go to a FILE, never to pipes. The
 * launcher exits immediately, and an inherited pipe closes under the child — the
 * Electron main process then aborts with SIGABRT before the window opens (found
 * the hard way while writing this toolbox).
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RENDERER_DIST_RELATIVE, ensureSharedElectronDist, platformExecutableName } from '../../packages/desktop/scripts/electron-shared.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DESKTOP_DIR = path.join(REPO, 'packages/desktop')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Dev-mode build prerequisites. electron-dev.mjs lazily builds the renderer and
 * preload; this launcher adds the CDP switch, so it fails fast with the exact
 * command instead of half-building behind the worker's back.
 */
function preflight() {
  const required = [
    [path.join(DESKTOP_DIR, ...RENDERER_DIST_RELATIVE), 'pnpm run build:desktop'],
    [path.join(DESKTOP_DIR, 'dist/preload.cjs'), 'pnpm run build:desktop'],
    [path.join(DESKTOP_DIR, 'dist/control-plane/index.js'), 'pnpm run build:desktop'],
    [path.join(DESKTOP_DIR, 'vendor/dsh/node_modules'), 'pnpm --filter @dsh-chamber/desktop run bundle:dsh'],
  ]
  const missing = required.filter(([target]) => !existsSync(target))
  if (missing.length > 0) {
    throw new Error(`dev 实例缺少构建产物（--dev 不隐式构建）：\n${missing.map(([target, fix]) => `  - ${path.relative(REPO, target)} → 先跑 ${fix}`).join('\n')}`)
  }
}

async function waitForHealth(cpPort, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer yet'
  let announced = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cpPort}/health`)
      const body = await response.json()
      const status = body?.dsh?.status
      // Only `ready` is a green light: with the instance still starting the
      // proxy answers 503 for every /api/i/* and /api/host/logs probe, which
      // would surface as acceptance failures that are really just timing.
      if (response.status === 200 && status === 'ready') return body
      last = JSON.stringify(body).slice(0, 160)
      if (!announced) { console.log(`dev 实例启动中（dsh status=${status ?? '?'}），等待 ready…`); announced = true }
    } catch (error) {
      last = String(error?.message ?? error)
    }
    await sleep(1_000)
  }
  throw new Error(`dev 实例在 ${timeoutMs}ms 内未到达 ready（control-plane :${cpPort}，last: ${last}）`)
}

/**
 * PIDs listening on a TCP port, with their cwd — used only to reclaim OUR OWN
 * leftovers. Returns [] on platforms without lsof (the caller then relies on the
 * graceful stop alone and says so).
 */
function listenersOn(port) {
  try {
    const pids = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(line => line.trim()).filter(Boolean)
    return [...new Set(pids)].map(pid => {
      let cwd = ''
      try {
        cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
          .split('\n').find(line => line.startsWith('n'))?.slice(1) ?? ''
      } catch { /* process gone between the two calls */ }
      return { pid: Number(pid), cwd }
    })
  } catch {
    return []
  }
}

/**
 * Kill a leftover process ONLY when it is provably ours: its cwd must be inside
 * this repo's bundled dsh tree (`packages/desktop/vendor/dsh`). Anything else —
 * notably the packaged app's own instance on 17510 — is left untouched.
 */
function reclaimOwnLeftover(port) {
  const expectedRoot = path.join(DESKTOP_DIR, 'vendor/dsh')
  const reclaimed = []
  for (const listener of listenersOn(port)) {
    if (!listener.cwd.startsWith(expectedRoot)) continue
    try { process.kill(listener.pid, 'SIGTERM') } catch { /* gone */ }
    reclaimed.push(listener.pid)
  }
  return reclaimed
}

/**
 * Launch the dev instance and wait until its control plane and CDP target exist.
 * @param opts.outDir artifact dir; the throwaway user-data dir lives here
 * @param opts.cpPort dev control-plane port (dev default range starts at 17520)
 * @param opts.cdpPort remote debugging port (scripts/perf convention: 9333)
 * @param opts.electronArgs extra Electron switches (e.g. ['--no-sandbox'] in sandboxed CI/dev containers)
 */
export async function launchDevInstance({ outDir = '.tmp/gui-acceptance', cpPort = 17530, cdpPort = 9333, electronArgs = [] } = {}) {
  preflight()
  const userDataDir = path.join(outDir, 'dev-user-data')
  mkdirSync(userDataDir, { recursive: true })
  const logPath = path.join(outDir, 'dev-app.log')
  const logFd = openSync(logPath, 'a')

  const { distDir, status } = await ensureSharedElectronDist()
  const executable = path.join(distDir, platformExecutableName())
  const env = { ...process.env, DSH_CHAMBER_ELECTRON_DEV: '1', DSH_CHAMBER_CP_PORT: String(cpPort) }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(
    executable,
    [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`, ...electronArgs, '.'],
    { cwd: DESKTOP_DIR, env, stdio: ['ignore', logFd, logFd], detached: process.platform !== 'win32' },
  )
  closeSync(logFd)
  child.unref()

  let dshPort = null

  const killGroup = signal => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { /* already gone */ }
  }

  /**
   * Shutdown order matters: ask the app to STOP its managed instance first (the
   * control plane's own DELETE /api/connections/local), because the instance is
   * a grandchild the process-group kill does not reach — it would survive as an
   * orphan holding the dsh port (observed, and cleaned by hand the first time).
   * The port sweep is the belt to that braces, scoped to our own vendor tree.
   */
  const stop = async () => {
    try {
      await fetch(`http://127.0.0.1:${cpPort}/api/connections/local`, { method: 'DELETE' })
    } catch { /* app already gone */ }
    killGroup('SIGTERM')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) break
      await sleep(250)
    }
    killGroup('SIGKILL')
    await sleep(500)
    if (dshPort !== null) {
      const reclaimed = reclaimOwnLeftover(dshPort)
      if (reclaimed.length > 0) console.log(`已回收遗留的托管 dsh 进程：${reclaimed.join(', ')}（端口 ${dshPort}）`)
      const left = listenersOn(dshPort).length
      if (left > 0) console.warn(`注意：端口 ${dshPort} 仍有监听者（非本仓 vendor/dsh 进程，未动）：${JSON.stringify(listenersOn(dshPort))}`)
    }
  }

  try {
    const health = await waitForHealth(cpPort)
    dshPort = Number(health?.dsh?.port ?? 0) || null
    console.log(`dev 实例就绪：control-plane :${cpPort}（dsh ${health?.dsh?.status} @${health?.dsh?.port}）、CDP :${cdpPort}、electron dist=${status}`)
    console.log(`隔离 user-data：${userDataDir}；应用日志：${logPath}`)
  } catch (error) {
    await stop()
    throw error
  }

  return { pid: child.pid, cpPort, cdpPort, dshPort, userDataDir, logPath, stop }
}
