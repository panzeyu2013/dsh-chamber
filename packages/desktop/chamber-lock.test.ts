/**
 * chamber-lock.test.ts —— Electron 侧双 flavor 互斥锁单测（design 25 §6.3）
 *
 * 覆盖（真实 fs，临时目录）：
 *  ① darwin：取锁写记录（pid/startedAt/shell 与 Swift 侧同格式）+ 0600 权限；
 *  ② 第二个持有者 fail-closed（EAGAIN → holderPid），释放后可重取；
 *  ③ release 幂等；
 *  ④ 符号链接 fail-closed（O_NOFOLLOW）；
 *  ⑤ 非 darwin：unsupported 放行且**不创建锁文件**（平台范围诚实）；
 *  ⑥ 记录读取对损坏/缺字段的容错（诊断面绝不 throw）。
 * 非 darwin 平台自动跳过 ①–④（本机 macOS 恒跑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CHAMBER_LOCK_FILE,
  acquireChamberLock,
  readChamberLockRecord,
} from './chamber-lock.ts'

const isDarwin = process.platform === 'darwin'

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-chamber-lock-'))
}

test('① darwin：取锁写记录（与 Swift 侧同格式）+ 0600', (t) => {
  if (!isDarwin) return t.skip('O_EXLOCK 仅 darwin')
  const dir = tempDir()
  try {
    const result = acquireChamberLock({ userDataDir: dir, shell: 'electron', now: 1_700_000_000_000 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.unsupported, false)
    const recordPath = path.join(dir, CHAMBER_LOCK_FILE)
    assert.ok(existsSync(recordPath))
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(record.pid, process.pid)
    assert.equal(record.shell, 'electron')
    assert.equal(record.startedAt, 1_700_000_000)
    assert.equal(lstatSync(recordPath).mode & 0o777, 0o600)
    result.handle.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② 第二个持有者 fail-closed（EAGAIN），释放后可重取', (t) => {
  if (!isDarwin) return t.skip('O_EXLOCK 仅 darwin')
  const dir = tempDir()
  try {
    const first = acquireChamberLock({ userDataDir: dir, shell: 'electron' })
    assert.equal(first.ok, true)
    if (!first.ok) return
    const second = acquireChamberLock({ userDataDir: dir, shell: 'swift' })
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.holderPid, process.pid)
    assert.match(second.error, /目录锁被占用/)

    first.handle.release()
    const third = acquireChamberLock({ userDataDir: dir, shell: 'electron' })
    assert.equal(third.ok, true)
    if (third.ok) third.handle.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('②b 既有宽松权限的锁文件被收紧为 0600（fchmod 分支）', (t) => {
  if (!isDarwin) return t.skip('O_EXLOCK 仅 darwin')
  const dir = tempDir()
  try {
    const recordPath = path.join(dir, CHAMBER_LOCK_FILE)
    writeFileSync(recordPath, '{}', { mode: 0o644 })
    assert.equal(lstatSync(recordPath).mode & 0o777, 0o644)
    const result = acquireChamberLock({ userDataDir: dir })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(lstatSync(recordPath).mode & 0o777, 0o600, '既有宽松权限必须被收紧')
    result.handle.release()

    // setuid/sticky 位同样必须被清掉（0o1600 → 0600；三审边界）。
    rmSync(recordPath, { force: true })
    // macOS 在「创建时」会剥掉普通文件的 sticky 位（实测 writeFileSync 的
    // mode 不生效），必须创建后 chmod 才能造出 0o1600 场景。
    writeFileSync(recordPath, '{}')
    chmodSync(recordPath, 0o1600)
    assert.equal(lstatSync(recordPath).mode & 0o7777, 0o1600)
    const sticky = acquireChamberLock({ userDataDir: dir })
    assert.equal(sticky.ok, true)
    if (!sticky.ok) return
    assert.equal(lstatSync(recordPath).mode & 0o7777, 0o600, 'sticky/setuid 位必须被清掉')
    sticky.handle.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ release 幂等', (t) => {
  if (!isDarwin) return t.skip('O_EXLOCK 仅 darwin')
  const dir = tempDir()
  try {
    const result = acquireChamberLock({ userDataDir: dir })
    assert.equal(result.ok, true)
    if (!result.ok) return
    result.handle.release()
    assert.doesNotThrow(() => result.handle.release())
    assert.doesNotThrow(() => result.handle.release())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 符号链接 fail-closed（O_NOFOLLOW）', (t) => {
  if (!isDarwin) return t.skip('O_EXLOCK 仅 darwin')
  const dir = tempDir()
  try {
    const target = path.join(dir, 'target')
    writeFileSync(target, 'x')
    symlinkSync(target, path.join(dir, CHAMBER_LOCK_FILE))
    const result = acquireChamberLock({ userDataDir: dir })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /目录锁打开失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ 非 darwin：unsupported 放行且不创建锁文件', () => {
  const dir = tempDir()
  try {
    const result = acquireChamberLock({ userDataDir: dir, platform: 'linux' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.unsupported, true)
    assert.equal(existsSync(path.join(dir, CHAMBER_LOCK_FILE)), false, '非 darwin 不留锁文件')
    result.handle.release() // no-op
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑥ 记录读取容错（损坏/缺字段 → null，不 throw）', () => {
  const dir = tempDir()
  try {
    const recordPath = path.join(dir, CHAMBER_LOCK_FILE)
    assert.equal(readChamberLockRecord(recordPath), null)
    writeFileSync(recordPath, '{not json')
    assert.equal(readChamberLockRecord(recordPath), null)
    writeFileSync(recordPath, JSON.stringify({ pid: -1 }))
    assert.equal(readChamberLockRecord(recordPath), null)
    writeFileSync(recordPath, JSON.stringify({ pid: 42 }))
    assert.deepEqual(readChamberLockRecord(recordPath), { pid: 42, startedAt: 0, shell: '' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
