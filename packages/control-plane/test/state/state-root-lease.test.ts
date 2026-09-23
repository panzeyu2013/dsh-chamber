/**
 * state 根写者唯一租约契约（packages/control-plane/src/state-root-lease.ts）。
 *
 * 覆盖 R2 plan §8 的跨进程矩阵 T1–T9 与 §8.2 单进程用例：T1/T2/T7/T8/T9 是租约
 * 模块本身，T3–T6 是 entry-point 行为——直接 spawn 生产入口（gateway auth /
 * cli serve / standalone），T6 用 desktop 的 acquireHostRootLease +
 * shell-core.stateRootDir 复现「desktop 双根占用」，不新增 test-only 生产 helper。
 *
 * 裸 node 可直跑：node packages/control-plane/test/state/state-root-lease.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STATE_ROOT_LEASE_FILENAME,
  StateRootLeaseError,
  acquireStateRootLease,
  assertDedicatedStateRoot,
  retireLegacyStateLocks,
} from '../../src/state-root-lease.ts'
// T3–T6 直接跑生产入口。T6 的 desktop 双根占用只用 desktop 自己的生产函数
// （host-root 租约 + state 根派生单源），不复制它的派生/租约逻辑。
import { acquireHostRootLease } from '../../../desktop/host-root-lease.ts'
import { stateRootDir } from '../../../desktop/shell-core.ts'

const MODULE_URL = new URL('../../src/state-root-lease.ts', import.meta.url).href

/** 生产入口绝对路径（spawn 与 cwd 无关）。 */
const CLI_ENTRY = fileURLToPath(new URL('../../../cli/src/index.ts', import.meta.url))
const STANDALONE_ENTRY = fileURLToPath(new URL('../../src/standalone.ts', import.meta.url))
const GATEWAY_CLI_ENTRY = fileURLToPath(new URL('../../../gateway/src/cli.ts', import.meta.url))
const CONTROL_PLANE_ENTRY_URL = new URL('../../src/index.ts', import.meta.url).href

/** T6 释放后正控：只构造生产 plane（不 start/不 bind），退出时 exit listener 释放租约。 */
const PLANE_CONSTRUCT_SCRIPT = [
  'import { createControlPlane } from ' + JSON.stringify(CONTROL_PLANE_ENTRY_URL) + ';',
  'const plane = createControlPlane({ stateDir: process.env.LEASE_DIR });',
  "console.log('PLANE_OK');",
  'process.exit(0);',
].join('\n')

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
const leaseFile = (dir: string): string => join(dir, STATE_ROOT_LEASE_FILENAME)
const modeOf = (path: string): number => statSync(path).mode & 0o777
const readLease = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(leaseFile(dir), 'utf8')) as Record<string, unknown>

function symlinkOrSkip(t: { skip: (reason?: string) => void }, target: string, path: string, type: 'file' | 'dir'): boolean {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return false
    }
    throw error
  }
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

/** 子进程脚本：HELD <token>（成功并停在 stdin）或 REFUSED <code>。 */
const CHILD_SCRIPT = [
  "import { acquireStateRootLease } from " + JSON.stringify(MODULE_URL) + ";",
  "const action = process.env.LEASE_ACTION ?? 'hold';",
  'const dir = process.env.LEASE_DIR;',
  'try {',
  "  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' });",
  "  console.log('HELD ' + lease.token);",
  "  if (action === 'hold') {",
  '    process.stdin.resume();',
  "    process.stdin.on('end', () => { try { lease.release(); } catch {} process.exit(0); });",
  '  } else {',
  '    process.exit(0);',
  '  }',
  '} catch (error) {',
  "  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unexpected';",
  "  console.log('REFUSED ' + code);",
  "  if (process.env.LEASE_EXPECT) process.exit(code === process.env.LEASE_EXPECT ? 0 : 3);",
  '  process.exit(0);',
  '}',
].join('\n')

interface LeaseChild {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string>
  stop: () => Promise<void>
}

function startLeaseChild(dir: string, action = 'hold'): LeaseChild {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
    env: { ...process.env, LEASE_DIR: dir, LEASE_ACTION: action },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { out += chunk })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { err += chunk })
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    async waitFor(pattern, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (pattern.test(out)) return out
        if (exited()) throw new Error('lease child exited before ' + String(pattern) + ': out=' + out + ' err=' + err)
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + String(pattern) + ': out=' + out + ' err=' + err)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    async stop() {
      if (exited()) return
      child.stdin?.end()
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    },
  }
}

function runLeaseChildSync(dir: string, expectCode?: string): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, LEASE_DIR: dir, LEASE_ACTION: 'exit' }
  if (expectCode !== undefined) env.LEASE_EXPECT = expectCode
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

interface EntryRun {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** 直接跑一个生产入口并收齐 stdout/stderr；30s 后 SIGKILL（测试不挂死）。 */
function runEntryPoint(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<EntryRun> {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { stdout += chunk })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** 活写者拒绝的公共断言：exit 1 + code 字面量 + holder pid/flavor + root，且无栈。 */
function assertLiveWriterRefusal(run: EntryRun, stateRoot: string, holderFlavor: string): void {
  assert.equal(run.code, 1, 'a live state-root writer must fail the entry with exit 1; stderr=' + run.stderr)
  assert.match(run.stderr, /state_root_locked/u, 'stderr must carry the machine-readable code: ' + run.stderr)
  assert.ok(run.stderr.includes('is owned by pid ' + String(process.pid) + ' '),
    'stderr must name the holder pid: ' + run.stderr)
  assert.ok(run.stderr.includes('(' + holderFlavor + ')'), 'stderr must name the holder flavor: ' + run.stderr)
  assert.ok(run.stderr.includes(stateRoot), 'stderr must name the state root: ' + run.stderr)
  assert.equal(/\n\s+at .+:\d+:\d+/.test(run.stderr), false,
    'a lease refusal must not print a stack trace: ' + run.stderr)
}

function killIfAlive(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

test('单进程：记录形状 / 0700+0600 / 唯一文件 / release 幂等', { skip: process.platform === 'win32' }, t => {
  const dir = tempDir('cp-lease-shape-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  assert.equal(lease.stateRoot, dir)
  assert.equal(lease.file, leaseFile(dir))
  assert.equal(lease.held(), true)
  assert.equal(lease.scope, 'state-root')
  assert.equal(lease.flavor, 'control-plane')
  assert.equal(modeOf(dir), 0o700)
  assert.equal(modeOf(leaseFile(dir)), 0o600)
  const record = readLease(dir)
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.pid, process.pid)
  assert.equal(record.token, lease.token)
  assert.equal(record.scope, 'state-root')
  assert.equal(record.flavor, 'control-plane')
  assert.equal(typeof record.startedAt, 'number')
  assert.equal(Number.isSafeInteger(record.startedAt), true)
  assert.deepEqual(readdirSync(dir), [STATE_ROOT_LEASE_FILENAME], 'the lease is the only file the contract creates')
  assert.doesNotThrow(() => lease.assertCurrent())
  lease.release()
  assert.equal(lease.held(), false)
  assert.equal(existsSync(leaseFile(dir)), false)
  lease.release()
  assert.equal(existsSync(leaseFile(dir)), false)
  assert.equal(existsSync(join(dir, '.gateway.lock')), false)
  assert.equal(existsSync(join(dir, 'dsh-runtime')), false)
})

test('单进程：活属主记录拒绝（state_root_locked + holder pid/flavor）', t => {
  const dir = tempDir('cp-lease-live-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(leaseFile(dir), JSON.stringify({
    schemaVersion: 1, pid: process.ppid, startedAt: 1, token: 'a'.repeat(48), scope: 'state-root', flavor: 'gateway',
  }) + '\n', { mode: 0o600 })
  const error = leaseError(() => acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' }))
  assert.equal(error.code, 'state_root_locked')
  assert.equal(error.pid, process.ppid)
  assert.equal(error.holder?.flavor, 'gateway')
  assert.match(error.message, /owned by pid/)
})

test('单进程：死 pid 记录被 rename 认领 + 告警', t => {
  const dir = tempDir('cp-lease-stale-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(leaseFile(dir), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, startedAt: 1, token: 'b'.repeat(48) }) + '\n', { mode: 0o600 })
  const warns: string[] = []
  const lease = acquireStateRootLease(dir, {
    scope: 'state-root', flavor: 'control-plane', logger: { warn: message => warns.push(message) },
  })
  assert.equal(readLease(dir).pid, process.pid)
  assert.equal(warns.some(message => message.includes('took over a stale lease record')), true)
  lease.release()
})

test('单进程：空/撕裂记录可认领 + 告警（O_EXCL 创建中途崩溃）', t => {
  const dir = tempDir('cp-lease-torn-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const torn of ['', '{not-json', JSON.stringify({ schemaVersion: 1 })]) {
    writeFileSync(leaseFile(dir), torn, { mode: 0o600 })
    const warns: string[] = []
    const lease = acquireStateRootLease(dir, {
      scope: 'state-root', flavor: 'control-plane', logger: { warn: message => warns.push(message) },
    })
    assert.equal(readLease(dir).pid, process.pid)
    assert.equal(warns.some(message => message.includes('torn lease record')), true, 'torn record must warn: ' + JSON.stringify(torn))
    lease.release()
  }
})

test('单进程：未知 schemaVersion fail-closed（state_root_unreadable，证据保留）', t => {
  const dir = tempDir('cp-lease-future-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(leaseFile(dir), JSON.stringify({ schemaVersion: 2, pid: 99_999_999, token: 'c'.repeat(48) }) + '\n', { mode: 0o600 })
  const error = leaseError(() => acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' }))
  assert.equal(error.code, 'state_root_unreadable')
  assert.match(error.message, /schemaVersion/)
  assert.equal(existsSync(leaseFile(dir)), true, 'future-format evidence is never removed')
})

test('单进程：同进程同根第二个租约拒绝，release 后可再取', t => {
  const dir = tempDir('cp-lease-dup-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  const error = leaseError(() => acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' }))
  assert.equal(error.code, 'state_root_duplicate')
  first.release()
  const second = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  assert.notEqual(second.token, first.token)
  second.release()
})

test('单进程：release 只删本租约（successor 在场时 state_root_not_owner）', t => {
  const dir = tempDir('cp-lease-successor-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  const displaced = leaseFile(dir) + '.displaced'
  renameSync(leaseFile(dir), displaced)
  const successor = JSON.stringify({
    schemaVersion: 1, pid: process.ppid, startedAt: 2, token: 'd'.repeat(48), scope: 'state-root', flavor: 'gateway',
  }) + '\n'
  writeFileSync(leaseFile(dir), successor, { mode: 0o600 })
  const error = leaseError(() => lease.release())
  assert.equal(error.code, 'state_root_not_owner')
  assert.equal(readFileSync(leaseFile(dir), 'utf8'), successor, 'successor record is never removed')
  assert.equal(lease.held(), false, 'lost ownership is recorded so reacquire can retake')
})

test('单进程：assertCurrent 在记录被替换后 fail-closed', t => {
  const dir = tempDir('cp-lease-current-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  writeFileSync(leaseFile(dir), JSON.stringify({
    schemaVersion: 1, pid: process.pid, startedAt: 3, token: 'e'.repeat(48),
  }) + '\n', { mode: 0o600 })
  const error = leaseError(() => lease.assertCurrent())
  assert.equal(error.code, 'state_root_not_owner')
  assert.equal(lease.held(), false)
})

test('单进程：symlink 租约叶子 fail-closed 且不动目标', { skip: process.platform === 'win32' }, t => {
  const dir = tempDir('cp-lease-link-')
  const outside = tempDir('cp-lease-link-target-')
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  const target = join(outside, 'owner-target')
  const bytes = JSON.stringify({ pid: 99_999_999 })
  writeFileSync(target, bytes, { mode: 0o644 })
  if (!symlinkOrSkip(t, target, leaseFile(dir), 'file')) return
  const error = leaseError(() => acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' }))
  assert.equal(error.code, 'state_root_unreadable')
  assert.equal(readFileSync(target, 'utf8'), bytes)
  assert.equal(modeOf(target), 0o644)
})

test('单进程：state 根为 symlink 时拒绝且不动目标', { skip: process.platform === 'win32' }, t => {
  const real = tempDir('cp-lease-root-real-')
  const linkParent = tempDir('cp-lease-root-link-')
  t.after(() => { rmSync(real, { recursive: true, force: true }); rmSync(linkParent, { recursive: true, force: true }) })
  const link = join(linkParent, 'state')
  if (!symlinkOrSkip(t, real, link, 'dir')) return
  assert.throws(() => acquireStateRootLease(link, { scope: 'state-root', flavor: 'control-plane' }))
  assert.deepEqual(readdirSync(real), [], 'linked root is never written through')
})

test('单进程：广根（home/temp/fs root）被拒绝', () => {
  for (const root of [parse(homedir()).root, homedir(), tmpdir()]) {
    assert.throws(() => assertDedicatedStateRoot(root), /dedicated child directory/)
  }
  assert.throws(
    () => acquireStateRootLease(homedir(), { scope: 'state-root', flavor: 'control-plane' }),
    /dedicated child directory/,
  )
})

test('单进程：legacy 退役——活 pid 拒绝，死 pid/空文件 identity 精确删除', t => {
  const dir = tempDir('cp-lease-legacy-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const gatewayLock = join(dir, '.gateway.lock')
  const runtimeOwner = join(dir, 'dsh-runtime', 'owner.json')
  writeFileSync(gatewayLock, JSON.stringify({ pid: process.ppid, createdAt: 1 }), { mode: 0o600 })
  const liveError = leaseError(() => acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' }))
  assert.equal(liveError.code, 'state_root_locked')
  assert.match(liveError.message, /legacy state lock/)
  writeFileSync(gatewayLock, JSON.stringify({ pid: 99_999_999, createdAt: 1 }), { mode: 0o600 })
  mkdirSync(join(dir, 'dsh-runtime'), { recursive: true, mode: 0o700 })
  writeFileSync(runtimeOwner, '', { mode: 0o600 })
  const warns: string[] = []
  const lease = acquireStateRootLease(dir, {
    scope: 'state-root', flavor: 'control-plane', logger: { warn: message => warns.push(message) },
  })
  assert.equal(existsSync(gatewayLock), false)
  assert.equal(existsSync(runtimeOwner), false)
  assert.equal(warns.some(message => message.includes('retired legacy state lock')), true)
  assert.doesNotThrow(() => retireLegacyStateLocks(dir))
  lease.release()
})

test('单进程：beforeStaleRename 并发缝——误移新鲜记录时还原并 fail-closed', t => {
  const dir = tempDir('cp-lease-interleave-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const displaced = leaseFile(dir) + '.old-fixture'
  writeFileSync(leaseFile(dir), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, startedAt: 1, token: 'f'.repeat(48) }) + '\n', { mode: 0o600 })
  const freshPayload = JSON.stringify({
    schemaVersion: 1, pid: process.pid, startedAt: 2, token: 'g'.repeat(48), scope: 'state-root', flavor: 'control-plane',
  }) + '\n'
  const error = leaseError(() => acquireStateRootLease(dir, {
    scope: 'state-root',
    flavor: 'control-plane',
    beforeStaleRename: () => {
      renameSync(leaseFile(dir), displaced)
      writeFileSync(leaseFile(dir), freshPayload, { mode: 0o600 })
    },
  }))
  assert.equal(error.code, 'state_root_takeover_race')
  assert.equal(readFileSync(leaseFile(dir), 'utf8'), freshPayload, 'losing takeover restores the concurrent fresh record')
  assert.equal(existsSync(displaced), true, 'original stale evidence stays available')
})

test('T1 跨进程：活写者拒绝第二写者，释放后可接管', async t => {
  const dir = tempDir('cp-lease-t1-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const holder = startLeaseChild(dir)
  t.after(() => killIfAlive(holder.child))
  await holder.waitFor(/^HELD /m)
  const before = readFileSync(leaseFile(dir))
  const error = leaseError(() => acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' }))
  assert.equal(error.code, 'state_root_locked')
  assert.equal(error.pid, holder.child.pid)
  assert.deepEqual(readFileSync(leaseFile(dir)), before, 'refused acquisition never touches the live record')
  await holder.stop()
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  assert.equal(lease.held(), true)
  lease.release()
})

test('T2 跨进程：持锁进程 SIGKILL 后下一次 acquire 认领', { skip: process.platform === 'win32' }, async t => {
  const dir = tempDir('cp-lease-t2-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const holder = startLeaseChild(dir)
  t.after(() => killIfAlive(holder.child))
  await holder.waitFor(/^HELD /m)
  const oldToken = readLease(dir).token
  holder.child.kill('SIGKILL')
  await new Promise<void>(resolve => holder.child.once('exit', () => resolve()))
  assert.equal(existsSync(leaseFile(dir)), true, 'a SIGKILL leaves the lease record behind')
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  assert.notEqual(lease.token, oldToken)
  assert.equal(readLease(dir).pid, process.pid)
  lease.release()
})

test('T7 跨进程：正常退出由 exit listener 释放租约', t => {
  const dir = tempDir('cp-lease-t7-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = runLeaseChildSync(dir)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^HELD /m)
  assert.equal(existsSync(leaseFile(dir)), false, 'exit listener released the record')
})

test('T8 跨进程：失败获取不删活锁（bytes + inode 不变）', t => {
  const dir = tempDir('cp-lease-t8-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'control-plane' })
  const before = readFileSync(leaseFile(dir))
  const beforeIno = statSync(leaseFile(dir)).ino
  const result = runLeaseChildSync(dir, 'state_root_locked')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /REFUSED state_root_locked/)
  assert.deepEqual(readFileSync(leaseFile(dir)), before)
  assert.equal(statSync(leaseFile(dir)).ino, beforeIno)
  lease.release()
})

test('T9 跨进程：陈旧记录并发认领恰好一个成功', async t => {
  const dir = tempDir('cp-lease-t9-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(leaseFile(dir), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, startedAt: 1, token: 'h'.repeat(48) }) + '\n', { mode: 0o600 })
  const a = startLeaseChild(dir)
  const b = startLeaseChild(dir)
  t.after(() => { killIfAlive(a.child); killIfAlive(b.child) })
  // 等完整的一行（stdout 可能分块到达）：token 是 48 hex，code 是小写+下划线。
  const settled = /^(HELD [0-9a-f]{48}|REFUSED [a-z_]+)\n/m
  await a.waitFor(settled)
  await b.waitFor(settled)
  const aHeld = /^HELD /m.test(a.stdout())
  const bHeld = /^HELD /m.test(b.stdout())
  assert.equal((aHeld ? 1 : 0) + (bHeld ? 1 : 0), 1, 'exactly one contender must win: a=' + a.stdout() + ' b=' + b.stdout())
  const winner = aHeld ? a : b
  const token = /^HELD ([0-9a-f]{48})$/m.exec(winner.stdout())?.[1]
  assert.ok(token)
  assert.equal(readLease(dir).token, token)
  assert.equal(readLease(dir).pid, winner.child.pid)
  await a.stop()
  await b.stop()
  assert.equal(existsSync(leaseFile(dir)), false, 'winner release removes the record; loser never wrote')
})

// T3–T6 entry-point 行为（R2 plan §8.1）：直接跑生产入口，断言真实 exit code 与
// stderr；不新增 test-only 生产 helper。

test('T3 entry：gateway auth reset-password 被活写者的短租约拒绝', async t => {
  const dir = tempDir('cp-lease-t3-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'gateway' })
  t.after(() => { try { if (lease.held()) lease.release() } catch { /* the temp dir may already be gone */ } })
  const before = readFileSync(leaseFile(dir), 'utf8')
  const run = await runEntryPoint([
    GATEWAY_CLI_ENTRY, 'auth', 'reset-password', '--new', 't3-new-password-123', '--state-dir', dir,
  ])
  assert.equal(run.code, 1, 'auth against a live writer is a runtime failure (exit 1): ' + run.stderr)
  assert.match(run.stderr, new RegExp('gateway is running \\(pid ' + String(process.pid) + '\\)'),
    'the localized running-gateway copy must reach the user: ' + run.stderr)
  assert.equal(readFileSync(leaseFile(dir), 'utf8'), before, 'the refused auth run never touches the live lease record')
  assert.equal(existsSync(join(dir, 'password-credential')), false, 'no credential write happened')
  assert.equal(existsSync(join(dir, 'jwt-secret')), false, 'no session-secret rotation happened')
})

test('T4 entry：cli serve 被 gateway 租约拒绝（exit 1 + state_root_locked + pid），且未 spawn 宿主', async t => {
  const dir = tempDir('cp-lease-t4-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'gateway' })
  t.after(() => { try { if (lease.held()) lease.release() } catch { /* the temp dir may already be gone */ } })
  const run = await runEntryPoint([CLI_ENTRY, 'serve', '--state-dir', dir])
  assertLiveWriterRefusal(run, dir, 'gateway')
  // 拒绝发生在任何 state 根写入之前：除活租约记录外没有任何控制面/宿主痕迹。
  assert.deepEqual(readdirSync(dir), [STATE_ROOT_LEASE_FILENAME],
    'the refused serve leaves only the live lease record')
  assert.equal(run.stdout.includes('listening'), false, 'the refused serve never binds the HTTP surface')
})

test('T5 entry：standalone 被 gateway 租约拒绝（exit 1 + state_root_locked + pid），且未 spawn 宿主', async t => {
  const dir = tempDir('cp-lease-t5-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lease = acquireStateRootLease(dir, { scope: 'state-root', flavor: 'gateway' })
  t.after(() => { try { if (lease.held()) lease.release() } catch { /* the temp dir may already be gone */ } })
  const run = await runEntryPoint([STANDALONE_ENTRY, '--state-dir', dir])
  assertLiveWriterRefusal(run, dir, 'gateway')
  // resolveStateRoot 接线：boot 行报告的 state dir 就是显式 --state-dir（resolve 后）。
  assert.ok(run.stdout.includes('boot: state dir ' + dir),
    'the boot line must report the resolved state dir: ' + run.stdout)
  assert.deepEqual(readdirSync(dir), [STATE_ROOT_LEASE_FILENAME],
    'the refused standalone leaves only the live lease record')
  assert.equal(run.stdout.includes('listening'), false, 'the refused standalone never binds the HTTP surface')
})

test('T6 entry：desktop 双根占用拒绝 standalone，释放后 createControlPlane 可构造', async t => {
  const userData = tempDir('cp-lease-t6-')
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  // 与 desktop 生产接线同形（main.ts / sidecar-entry.ts）：<userData> 取 host-root，
  // <userData>/state 取 state-root（后者由 plane 构造期自取，这里用短租约复现）。
  const hostLease = acquireHostRootLease(userData, 'desktop')
  const planeStateDir = stateRootDir(userData)
  const stateLease = acquireStateRootLease(planeStateDir, { scope: 'state-root', flavor: 'control-plane' })
  let released = false
  const releaseBoth = (): void => {
    if (released) return
    released = true
    try { if (stateLease.held()) stateLease.release() } catch { /* diagnosis cleanup only */ }
    try { if (hostLease.held()) hostLease.release() } catch { /* diagnosis cleanup only */ }
  }
  t.after(releaseBoth)

  // (a) desktop plane 的 state-root 租约占住 <userData>/state → standalone 被拒。
  const atStateRoot = await runEntryPoint([STANDALONE_ENTRY, '--state-dir', planeStateDir])
  assertLiveWriterRefusal(atStateRoot, planeStateDir, 'control-plane')
  // (b) 根直接指向 <userData> → desktop 的 host-root 租约拒绝（跨 scope 同文件仲裁）。
  const atHostRoot = await runEntryPoint([STANDALONE_ENTRY, '--state-dir', userData])
  assertLiveWriterRefusal(atHostRoot, userData, 'desktop')
  // 两个被拒的子进程都没有写 state 根内容（只有 plane 构造期的那把租约文件）。
  assert.deepEqual(readdirSync(planeStateDir), [STATE_ROOT_LEASE_FILENAME])

  // 释放双根后可起：生产构造入口 createControlPlane({ stateDir: stateRootDir(userData) })。
  releaseBoth()
  assert.equal(existsSync(join(userData, STATE_ROOT_LEASE_FILENAME)), false, 'host-root lease released')
  assert.equal(existsSync(join(planeStateDir, STATE_ROOT_LEASE_FILENAME)), false, 'state-root lease released')
  const built = await runEntryPoint(['--input-type=module', '-e', PLANE_CONSTRUCT_SCRIPT], {
    ...process.env,
    LEASE_DIR: planeStateDir,
  })
  assert.equal(built.code, 0, 'released roots must let the production plane constructor run: ' + built.stderr)
  assert.match(built.stdout, /^PLANE_OK$/mu)
  assert.equal(existsSync(join(planeStateDir, STATE_ROOT_LEASE_FILENAME)), false,
    'the constructor exit listener released its lease')
})
