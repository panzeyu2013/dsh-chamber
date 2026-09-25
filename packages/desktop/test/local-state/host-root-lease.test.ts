/**
 * host-root-lease.test.ts —— desktop / Swift sidecar 的 <userData> host-root 租约
 * （R2 plan §3.6 L2 / §8.3）。
 *
 * 覆盖：
 *  1. <userData>/state 的派生单源：sidecar-ctx/sidecar-entry 的裸 join + 自建
 *     state 根已删，sidecar-entry 传给 createControlPlane 的 stateDir 就是
 *     shell-core.stateRootDir()；desktop main 的 flock → host-root 租约 →
 *     control-plane 构造序与 quit 逆序释放；
 *  2. 租约本体：<userData>/owner.json 的 scope=host-root / flavor 记录、同进程
 *     重复 acquire 拒绝、release 精确删除；
 *  3. sidecar 端到端冲突：活属主占用 host-root → startup-failure（exit 70，
 *     Swift Supervisor fatal 不重启）+ stderr 含 state_root_locked + holder
 *     pid/flavor + root 路径 + 操作提示，且冲突先于 <userData>/state 创建；
 *  4. sidecar 端到端生命周期：boot 取租约（记录 pid = sidecar pid），SIGTERM
 *     清理完成后释放。
 *
 * 只依赖 node:test / node:child_process（与 sidecar-stdio 同一 spawn 纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { StateRootLeaseError } from '../../control-plane-module.ts'
import { EXIT_GRACEFUL, EXIT_STARTUP_FAILURE } from '../../sidecar-exit-codes.ts'
import { acquireHostRootLease } from '../../host-root-lease.ts'
import { stateRootDir } from '../../shell-core.ts'

const DESKTOP_DIR = fileURLToPath(new URL('../../', import.meta.url))
const sidecarPath = path.join(DESKTOP_DIR, 'sidecar-entry.ts')
const SIDECAR_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SIDECAR_TEST_NO_UPDATE_CHECK: '1' }

/** 源文本锁：去注释 + 折叠空白（注释不得满足锁，格式化不得打破锁）。 */
function desktopSource(name: string): string {
  return normalize(stripComments(readFileSync(path.join(DESKTOP_DIR, name), 'utf8')))
}

function leaseError(run: () => unknown): StateRootLeaseError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof StateRootLeaseError, 'expected StateRootLeaseError, got ' + String(error))
    return error
  }
  throw new Error('expected the call to throw StateRootLeaseError')
}

interface SidecarRun {
  child: ChildProcessWithoutNullStreams
  ready: Promise<void>
  exit: Promise<number | null>
  stderr: () => string
}

/** 启动真 sidecar（--port 0 = 系统分配，避免与其它套件/实例抢端口）。 */
function startSidecar(userDataDir: string): SidecarRun {
  const child = spawn(
    process.execPath,
    [sidecarPath, '--user-data-dir', userDataDir, '--port', '0'],
    { env: SIDECAR_ENV, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const exit = new Promise<number | null>((resolve) => { child.on('exit', (code) => resolve(code)) })
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('ready 超时（30s）；stderr=' + stderr))
    }, 30000)
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (settled || line.length === 0) return
      try {
        const frame = JSON.parse(line) as { notify?: unknown }
        if (frame.notify === 'ready') {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      } catch { /* 非协议行忽略 */ }
    })
    void exit.then((code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('ready 前退出 code=' + String(code) + '；stderr=' + stderr))
    })
  })
  void ready.catch(() => {})
  return { child, ready, exit, stderr: () => stderr }
}

test('state 根派生单源：sidecar 两文件不再裸 join <userData>/state，entry 传 stateRootDir()', () => {
  const ctx = desktopSource('sidecar-ctx.ts')
  assert.doesNotMatch(ctx, /path\.join\(userDataDir, 'state'\)/u,
    'sidecar-ctx 不得再拼 <userData>/state（单源 = shell-core.stateRootDir）')
  assert.doesNotMatch(ctx, /mkdirSync/u,
    'sidecar-ctx 不得自建 state 根（创建归 control-plane 构造期租约）')

  const entry = desktopSource('sidecar-entry.ts')
  assert.doesNotMatch(entry, /path\.join\(args\.userDataDir, 'state'\)/u,
    'sidecar-entry 不得再裸 join <userData>/state')
  assert.match(entry, /stateDir: stateRootDir\(args\.userDataDir\)/u,
    'createControlPlane 的 stateDir 必须来自 shell-core.stateRootDir')
  // 时序：host-root 租约 → 无头 ctx 装配 → plane 构造（构造期自取 state-root
  // 并启动时 reaper）→ plane.start()。任何一步提前都会把写者身份留到写之后。
  const leaseAt = entry.indexOf('acquireHostRootLease(args.userDataDir')
  const ctxAt = entry.indexOf('buildHeadlessCtx(args.userDataDir')
  const planeAt = entry.indexOf('createControlPlane({')
  const startAt = entry.indexOf('await controlPlane.start()')
  assert.ok(leaseAt >= 0 && ctxAt > leaseAt && planeAt > ctxAt && startAt > planeAt,
    'sidecar 时序必须是 host-root 租约 → buildHeadlessCtx → createControlPlane → start')
})

test('desktop main：flock → host-root 租约 → plane，quit 先放 L2 再放 L1', () => {
  const main = desktopSource('main.ts')
  const lockAt = main.indexOf('acquireChamberLock({')
  const leaseAt = main.indexOf('acquireHostRootLease(runtimeBaseDir,')
  const planeAt = main.indexOf('createControlPlane({')
  assert.ok(lockAt >= 0, 'main 必须取 L1 目录锁（acquireChamberLock）')
  assert.ok(leaseAt > lockAt, 'host-root 租约必须在 flock 成功之后取得')
  assert.ok(planeAt > leaseAt, 'host-root 租约必须早于 control-plane 构造（state-root 租约在构造期自取）')
  assert.ok(main.includes('dialog.showErrorBox(shellStrings(app.getLocale()).startupFailedTitle, detail)'),
    '租约冲突必须 loud 到原生对话框（标题经 shell-locale，不写死语言）')
  assert.ok(main.includes('app.exit(1)'), '租约冲突必须 exit 1（fail-closed，不继续装配）')
  assert.match(main, /hostRootLease\?\.release\(\);([\s\S]{0,300}?)chamberLock\.handle\.release\(\);/u,
    'quit 必须按 L2→L1 逆序释放（反序会制造瞬时假冲突）')
})

test('host-root 租约：owner.json 记录 scope/flavor，同进程重复拒绝，release 精确删除', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-host-lease-'))
  const ownerFile = path.join(dir, 'owner.json')
  const lease = acquireHostRootLease(dir, 'desktop')
  try {
    assert.equal(lease.held(), true)
    assert.equal(lease.scope, 'host-root')
    assert.equal(lease.flavor, 'desktop')
    assert.equal(lease.file, ownerFile)
    const record = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>
    assert.equal(record.schemaVersion, 1)
    assert.equal(record.pid, process.pid)
    assert.equal(record.scope, 'host-root')
    assert.equal(record.flavor, 'desktop')
    const duplicate = leaseError(() => acquireHostRootLease(dir, 'desktop'))
    assert.equal(duplicate.code, 'state_root_duplicate')
    assert.equal(duplicate.stateRoot, lease.stateRoot)
    assert.equal(lease.held(), true, '失败的第二次 acquire 不得影响已持有的租约')
  } finally {
    lease.release()
  }
  assert.equal(existsSync(ownerFile), false, 'release 必须精确删除本租约')
  rmSync(dir, { recursive: true, force: true })
})

test('sidecar：host-root 活属主 → exit 70 + state_root_locked 诊断，且不建 state 根', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-host-lease-conflict-'))
  const lease = acquireHostRootLease(dir, 'desktop')
  try {
    const sidecar = startSidecar(dir)
    const code = await sidecar.exit
    assert.equal(code, EXIT_STARTUP_FAILURE, 'startup-failure 语义（Swift Supervisor 视作 fatal，不重启）')
    const stderr = sidecar.stderr()
    assert.ok(stderr.includes('state_root_locked'), 'stderr 必须含机器可读 code：' + stderr)
    assert.ok(stderr.includes(String(process.pid)), 'stderr 必须含 holder pid：' + stderr)
    assert.ok(stderr.includes('flavor=desktop'), 'stderr 必须含 holder flavor：' + stderr)
    assert.ok(stderr.includes(dir), 'stderr 必须含 root 路径：' + stderr)
    assert.ok(stderr.includes('另一写者占用该 userData'), 'stderr 必须含操作提示：' + stderr)
    assert.equal(existsSync(stateRootDir(dir)), false, '冲突必须先于 state 根创建（plane 未构造）')
  } finally {
    lease.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sidecar：boot 取两 scope 租约（host-root + <state>/state-root），SIGTERM 清理后释放', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-host-lease-run-'))
  const ownerFile = path.join(dir, 'owner.json')
  const stateOwnerFile = path.join(stateRootDir(dir), 'owner.json')
  let sidecar: SidecarRun | null = null
  try {
    sidecar = startSidecar(dir)
    await sidecar.ready
    const record = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>
    assert.equal(record.pid, sidecar.child.pid)
    assert.equal(record.scope, 'host-root')
    assert.equal(record.flavor, 'sidecar')
    // plane 自取的 state-root 租约（不同文件、不同 scope）：createControlPlane
    // 构造期即持有——早于 start() 的 reaper。
    const stateRecord = JSON.parse(readFileSync(stateOwnerFile, 'utf8')) as Record<string, unknown>
    assert.equal(stateRecord.pid, sidecar.child.pid)
    assert.equal(stateRecord.scope, 'state-root')
    assert.equal(stateRecord.flavor, 'sidecar')
    assert.notEqual(stateOwnerFile, ownerFile)
    sidecar.child.kill('SIGTERM')
    const code = await sidecar.exit
    assert.equal(code, EXIT_GRACEFUL, 'SIGTERM = 优雅退出')
    assert.equal(existsSync(ownerFile), false, 'shutdown 必须在写者腿静止后释放 host-root 租约')
    assert.equal(existsSync(stateOwnerFile), false, 'cp.stop 必须释放 plane 自持的 state-root 租约')
  } finally {
    if (sidecar !== null && sidecar.child.exitCode === null) sidecar.child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
