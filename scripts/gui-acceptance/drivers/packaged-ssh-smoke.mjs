#!/usr/bin/env node
/**
 * ARCHIVED (2026-11, Electron frozen; docs/progress/electron-frozen.md): this is the
 * Electron packaged/CDP counterpart; the shipped native shell has no CDP endpoint.
 *
 * Packaged-app SSH smoke: run the W-13…W-15b walkthrough against an already
 * BUILT desktop payload (release/<platform>-unpacked) with the local SSH
 * fixture. This is the packaged counterpart of `run.mjs --dev --ssh-fixture`:
 * the fixture seeds a throwaway userData tree, the packaged binary launches
 * with that tree + the fixture ssh-agent, and the normal CDP walkthrough drives
 * the upstream BrowserBody / real SSH alias iframe end to end.
 *
 *   xvfb-run -a node scripts/gui-acceptance/drivers/packaged-ssh-smoke.mjs \
 *     --binary packages/desktop/release/linux-unpacked/dsh-chamber-electron \
 *     --out .tmp/gui-acceptance-pkg-ssh
 *
 * Requires a display (Xvfb is fine) and a packaged payload; it never touches
 * the real userData or the real ~/.ssh. Exit 0 iff the walkthrough has no FAIL.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { startSshFixture } from '../fixtures/ssh-fixture.mjs'
import { runWalkthrough } from './walkthrough.mjs'

const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    out: { type: 'string', default: '.tmp/gui-acceptance-pkg-ssh' },
    'cdp-port': { type: 'string', default: '9333' },
    'plane-port': { type: 'string', default: '17500' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})
if (values.help || !values.binary) {
  console.log('用法：node scripts/gui-acceptance/drivers/packaged-ssh-smoke.mjs --binary <packaged executable>'
    + ' [--out <dir>] [--cdp-port <9333>] [--plane-port <17500>]')
  process.exit(values.help ? 0 : 2)
}
const cdpPort = Number(values['cdp-port'])
const planePort = Number(values['plane-port'])
for (const [flag, port] of [['--cdp-port', cdpPort], ['--plane-port', planePort]]) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(flag + ' 只接受 1–65535 的整数端口，收到：' + String(values[flag.slice(2)]))
    process.exit(2)
  }
}
if (typeof values.out !== 'string' || values.out.trim() === '') {
  console.error('--out 不能为空')
  process.exit(2)
}
let binaryStat
try { binaryStat = statSync(values.binary) } catch { binaryStat = null }
if (binaryStat === null || !binaryStat.isFile()
  || (process.platform !== 'win32' && (binaryStat.mode & 0o111) === 0)) {
  console.error('--binary 不是可执行文件：' + values.binary)
  process.exit(2)
}
const outDir = path.resolve(values.out)
// Do not delete the caller-supplied --out tree. The fixture owns exactly two
// generated subpaths: <out>/ssh-fixture (startSshFixture recreates it) and the
// throwaway <out>/dev-user-data it seeds. Wiping the latter keeps repeat runs
// cold (the earlier throwaway runner wiped all of --out for that reason); every
// other --out file is left alone. Stale shots are removed and the app log is
// truncated by openSync('w'); the report writer replaces the report files.
mkdirSync(outDir, { recursive: true })
rmSync(path.join(outDir, 'dev-user-data'), { recursive: true, force: true })
rmSync(path.join(outDir, 'shots'), { recursive: true, force: true })
const fixture = await startSshFixture({ outDir })
const logPath = path.join(outDir, 'pkg-app.log')
const logFd = openSync(logPath, 'w')
const env = { ...process.env, ...fixture.env }
const app = spawn(path.resolve(values.binary), ['--no-sandbox', '--user-data-dir=' + fixture.userDataDir, '--remote-debugging-port=' + String(cdpPort)], {
  env, stdio: ['ignore', logFd, logFd], detached: process.platform !== 'win32',
})
closeSync(logFd)
const kill = () => { try { process.platform === 'win32' ? app.kill('SIGTERM') : process.kill(-app.pid, 'SIGTERM') } catch { /* already gone */ } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let ready = false
for (let i = 0; i < 120; i += 1) {
  try { const res = await fetch('http://127.0.0.1:' + String(planePort) + '/health'); if (res.ok) { ready = true; break } } catch { /* booting */ }
  await sleep(500)
}
if (!ready) {
  kill()
  await fixture.stop()
  console.error('打包 app 未在 60s 内就绪（控制面 /health 不可达）')
  process.exit(1)
}
// The shell page can still be loading right after /health; the walkthrough's
// first Page.reload needs a settled target.
await sleep(6_000)
let walked
try {
  walked = await runWalkthrough({
    cdpPort, outDir, settleMs: 1_500, advanceOnboarding: true, allowPersistentWrites: true,
    requireEmbed: true, sshFixture: fixture,
  })
} finally {
  kill()
  await sleep(1_500)
  await fixture.stop()
}
console.log(JSON.stringify({ passed: walked.passed, failed: walked.failed, info: walked.info, reportPath: walked.reportPath }))
process.exit(walked.failed === 0 ? 0 : 1)
