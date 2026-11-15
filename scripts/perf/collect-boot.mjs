#!/usr/bin/env node
/**
 * Restart-dsh-chamber boot collector (E1 启动账).
 *
 * Marks: the shell's `[perf] boot <stage> +Nms` lines and the sidecar's
 * `[perf] sidecar <stage> +Nms` lines. `firstFrame` is the shell's document
 * commit (window presented) and `pageReady` is the renderer's bridge handshake
 * (page usable); they are reported separately because an early window is not
 * early content.
 *
 * Per run: quit the app (graceful request, wait for the process to exit, then
 * SIGTERM, and SIGKILL only with --force-quit), record each log's identity, relaunch,
 * wait for a FRESH sidecar mark plus firstFrame and pageReady, then slice that run.
 *
 * THIS RESTARTS THE RUNNING APP — pass --yes. Never run it from inside a session
 * the app hosts (the session dies with the app).
 *
 *   node scripts/perf/collect-boot.mjs --runs 5 --yes
 *   node scripts/perf/collect-boot.mjs --self-test
 *   node scripts/perf/collect-boot.mjs --runs 1 --yes --app /Applications/dsh-chamber.app
 *   node scripts/perf/collect-boot.mjs --runs 5 --yes --logs "<userData>/logs"
 *
 * Output: one JSON object per run on stdout (keys = stages, values = ms since
 * that process's start), then a p50/p95 summary on stderr.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const RUNS = Number(flag('--runs', '5'))
const APP = flag('--app', '/Applications/dsh-chamber.app')
const LOGS = flag('--logs', join(homedir(), 'Library', 'Application Support', '@dsh-chamber', 'desktop', 'logs'))
const YES = argv.includes('--yes')
/** SIGKILL discards a running session's state, so it is opt-in: a plain run stops at
 *  SIGTERM and reports that the app would not quit. */
const FORCE_QUIT = argv.includes('--force-quit')
const SELF_TEST = argv.includes('--self-test')
const SHELL_LOG = join(LOGS, 'shell.log')
const SIDECAR_LOG = join(LOGS, 'sidecar.log')
const SIDECAR_JS = join(APP, 'Contents', 'Resources', 'sidecar', 'sidecar.js')

/** The app's own binary name: CFBundleExecutable, not the .app basename. */
function defaultProcessName(app) {
  try {
    const xml = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')
    const m = xml.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/u)
    if (m !== null && m[1].trim() !== '') return m[1].trim()
  } catch { /* fall through */ }
  return basename(app, '.app')
}
const PROCESS = flag('--process', defaultProcessName(APP))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Refuse BEFORE quitting anything when the installed build cannot emit the marks: a
 *  pre-mark build would leave the app down and every run empty. */
function preflight() {
  const problems = []
  if (!existsSync(SIDECAR_JS)) {
    problems.push('missing ' + SIDECAR_JS)
  } else if (!readFileSync(SIDECAR_JS, 'utf8').includes('[perf] sidecar ')) {
    problems.push('the INSTALLED sidecar has no [perf] sidecar marks — run build:sidecar + build:swift-app and reinstall first')
  }
  const shell = existsSync(SHELL_LOG) ? readFileSync(SHELL_LOG, 'utf8') : ''
  if (shell !== '' && !shell.includes('sidecarSpawned')) {
    problems.push('the current shell.log has no [perf] boot sidecarSpawned — the installed shell predates this build')
  }
  if (problems.length === 0) return
  console.error('preflight failed (nothing was restarted):')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(3)
}

/** PIDs of the app (pgrep by executable, then by the bundle's binary path: the
 *  control-plane port stops listening before the process exits, so a port probe is
 *  not an exit test). */
function appPids() {
  for (const args of [['-x', PROCESS], ['-f', join(APP, 'Contents', 'MacOS') + '/']]) {
    try {
      const out = execFileSync('pgrep', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const pids = out.split('\n').map(line => line.trim()).filter(Boolean)
      if (pids.length > 0) return pids
    } catch { /* pgrep exits 1 when nothing matches */ }
  }
  return []
}

/** Liveness that does not depend on pgrep seeing the process (it can miss an app on some
 *  hosts): killall -0 signals nothing and only reports existence. */
function appRunning() {
  if (appPids().length > 0) return true
  try {
    execFileSync('killall', ['-0', PROCESS], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Signal by name when pgrep cannot list pids (pkill resolves the same name). */
function signalApp(signal) {
  const pids = appPids()
  if (pids.length > 0) {
    for (const pid of pids) { try { process.kill(Number(pid), signal) } catch { /* gone */ } }
    return
  }
  try { execFileSync('killall', [signal === 'SIGKILL' ? '-KILL' : '-TERM', PROCESS], { stdio: 'ignore' }) } catch { /* gone */ }
}

/** A SIGKILL of the shell skips its cleanup chain, which can leave the sidecar child
 *  holding the host-root lease; release it before the next launch. */
function killOrphanSidecar() {
  const sidecarPath = join(APP, 'Contents', 'Resources', 'sidecar', 'sidecar.js')
  for (const signal of ['-TERM', '-KILL']) {
    try { execFileSync('pkill', [signal, '-f', sidecarPath], { stdio: 'ignore' }) } catch { /* none */ }
    try { execFileSync('sleep', ['0.5'], { stdio: 'ignore' }) } catch { /* ignore */ }
  }
}

/** Identity of a log at capture time (byte size alone cannot see a rotation to a
 *  LARGER file). */
function logState(file) {
  if (!existsSync(file)) return { ino: 0, size: 0 }
  const st = statSync(file)
  return { ino: st.ino, size: st.size }
}

/** Entries appended after a BYTE offset (0 when the log rotated under us). */
function sliceFrom(file, state) {
  if (!existsSync(file)) return ''
  const bytes = readFileSync(file)
  const ino = statSync(file).ino
  const rotated = (state.ino !== 0 && ino !== state.ino) || bytes.length < state.size
  return bytes.subarray(rotated ? 0 : state.size).toString('utf8')
}

/** Marks of one run: the lines appended to each log after the captured identity. */
function marksSince(offsets) {
  const out = {}
  for (const line of sliceFrom(SHELL_LOG, offsets.shell).split('\n')) {
    const m = line.match(/\[perf\] boot (\S+)(?: .*?)? \+(\d+)ms/)
    if (m) out[m[1]] = Number(m[2])
  }
  for (const line of sliceFrom(SIDECAR_LOG, offsets.sidecar).split('\n')) {
    const m = line.match(/\[perf\] sidecar (.+?) \+(\d+)ms/)
    if (m === null) continue
    // `loginShellEnv-settled(651ms)` carries its own duration: keep the stage
    // aggregatable and record the parenthesised span separately.
    const stage = m[1].replace(/\(.*\)$/u, '')
    out['sidecar:' + stage] = Number(m[2])
    const inner = m[1].match(/\((\d+)ms\)$/u)
    if (inner !== null) out['sidecar:' + stage + '-duration'] = Number(inner[1])
  }
  return out
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(120)
  }
  throw new Error('timed out waiting for ' + label)
}

/** Nearest-rank percentile (p95 of 5 samples = the 5th, not the 4th). */
function percentile(values, p) {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

async function quitApp() {
  try {
    // A quit-confirmation dialog answers nothing here, so bound the request.
    execFileSync('osascript', ['-e', 'quit app "' + PROCESS + '"'], { stdio: 'ignore', timeout: 8_000 })
  } catch { /* not running, or swallowed by a modal: the wait below decides */ }
  // A graceful quit runs the shell's cleanup chain (worst case ~7s) AFTER the request
  // returns, so wait before escalating — otherwise a healthy quit gets SIGTERMed.
  try {
    await waitFor('the app to exit after the quit request', () => !appRunning(), 15_000)
    return
  } catch { /* still running */ }
  console.error('quit request did not land (a quit-confirmation dialog can swallow it); sending SIGTERM')
  signalApp('SIGTERM')
  try {
    await waitFor('the app to exit after SIGTERM', () => !appRunning(), 8_000)
    return
  } catch {
    if (!FORCE_QUIT) {
      throw new Error('the app is still running after SIGTERM (a quit-confirmation dialog or a running task). '
        + 'Answer the dialog and re-run, or pass --force-quit to discard the session state with SIGKILL')
    }
    console.error('SIGTERM did not stop the app either; sending SIGKILL (--force-quit: session state may be discarded)')
  }
  signalApp('SIGKILL')
  await waitFor('the app to exit after SIGKILL', () => !appRunning(), 10_000)
  // SIGKILL skips the shell's cleanup chain: release a surviving sidecar child so the next
  // launch does not fail on the host-root lease.
  killOrphanSidecar()
}

// ── self-test: parsing, multi-byte offsets, rotation, percentile ────────────
if (SELF_TEST) {
  const dir = mkdtempSync(join(tmpdir(), 'collect-boot-selftest-'))
  try {
    const file = join(dir, 'shell.log')
    const before = '[2026-11-15T16:00:00Z] [shell] 中文日志 \n'.repeat(20)
    writeFileSync(file, before)
    const state = logState(file)
    const after = '[perf] boot logConfigured +209ms\n[perf] boot firstFrame http://x/ +1500ms\n'
    writeFileSync(file, before + after)
    const marks = {}
    for (const line of sliceFrom(file, state).split('\n')) {
      const m = line.match(/\[perf\] boot (\S+)(?: .*?)? \+(\d+)ms/)
      if (m) marks[m[1]] = Number(m[2])
    }
    if (marks.logConfigured !== 209 || marks.firstFrame !== 1500) throw new Error('append slice parse failed')
    // Rotation: a NEW file smaller than the captured offset must read from 0.
    writeFileSync(file, '[perf] boot logConfigured +7ms\n')
    const afterRotation = sliceFrom(file, state)
    if (!afterRotation.includes('logConfigured +7ms')) throw new Error('rotation reset failed')
    // Rotation to a LARGER file is caught by the inode, not the size: recreate the file.
    const state3 = logState(file)
    rmSync(file)
    writeFileSync(file, '[perf] boot logConfigured +9ms\n'.repeat(10))
    if (!sliceFrom(file, state3).includes('logConfigured +9ms')) throw new Error('inode rotation reset failed')
    if (percentile([1, 2, 3, 4, 5], 0.95) !== 5) throw new Error('p95 must be the 5th of 5 (nearest-rank)')
    if (!Number.isNaN(percentile([], 0.5))) throw new Error('empty percentile must be NaN')
    console.log('collect-boot: self-test OK')
    process.exit(0)
  } catch (error) {
    console.error('collect-boot: self-test FAILED — ' + String(error))
    process.exit(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (!YES) {
  console.error('refusing to restart the app without --yes (the running session dies with it)')
  process.exit(2)
}
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 20) {
  console.error('--runs must be an integer between 1 and 20')
  process.exit(2)
}
preflight()

const runs = []
for (let run = 1; run <= RUNS; run += 1) {
  await quitApp()
  // Rotation-safe: capture the identity AFTER the old process is gone.
  const offsets = { shell: logState(SHELL_LOG), sidecar: logState(SIDECAR_LOG) }
  execFileSync('open', ['-a', APP], { stdio: 'ignore' })
  await waitFor('run ' + String(run) + ' to spawn its sidecar', () => {
    const marks = marksSince(offsets)
    return 'sidecarSpawned' in marks || 'sidecar:boot-begin' in marks
  }, 60_000)
  await waitFor('firstFrame of run ' + String(run), async () => 'firstFrame' in marksSince(offsets), 90_000)
  // pageReady is a SIDECAR-process mark and usually lands after the shell's firstFrame
  // (the renderer handshake follows the document commit), so a fixed short window would
  // systematically drop it. Wait for it, bounded, then settle one write.
  try {
    await waitFor('pageReady of run ' + String(run), async () => 'sidecar:pageReady' in marksSince(offsets), 30_000)
  } catch {
    console.error('run ' + String(run) + ': pageReady did not arrive within 30s (that run is reported without it)')
  }
  await sleep(300)
  const marks = marksSince(offsets)
  // A failure page also commits (firstFrame), so a run without pageReady is not a usable
  // cold-start sample: keep the row, exclude it from the aggregates.
  const valid = 'sidecar:pageReady' in marks && 'sidecarSpawned' in marks
  runs.push({ ...marks, valid })
  if (!valid) console.error('run ' + String(run) + ': no pageReady/sidecarSpawned — excluded from the aggregates')
  console.log(JSON.stringify({ run, valid, ...marks }))
}

// firstFrame is measured from the SHELL process start; pageReady/planeListening from the
// SIDECAR process start — subtract only within one process.
const validRuns = runs.filter(r => r.valid === true)
const firstFrame = validRuns.map(r => r.firstFrame).filter(Number.isFinite)
const pageReady = validRuns.map(r => r['sidecar:pageReady']).filter(Number.isFinite)
const sinceCp = validRuns
  .map(r => (Number.isFinite(r['sidecar:pageReady']) && Number.isFinite(r['sidecar:planeListening'])
    ? r['sidecar:pageReady'] - r['sidecar:planeListening'] : NaN))
  .filter(Number.isFinite)
console.error('')
console.error('firstFrame (document commit)      p50=' + percentile(firstFrame, 0.5) + '  p95=' + percentile(firstFrame, 0.95) + '  n=' + firstFrame.length)
console.error('pageReady (renderer handshake)    p50=' + percentile(pageReady, 0.5) + '  p95=' + percentile(pageReady, 0.95) + '  n=' + pageReady.length)
console.error('pageReady-planeListening          p50=' + percentile(sinceCp, 0.5) + '  p95=' + percentile(sinceCp, 0.95))
console.error('per-run firstFrame: ' + runs.map(r => String(r.firstFrame)).join(', '))
