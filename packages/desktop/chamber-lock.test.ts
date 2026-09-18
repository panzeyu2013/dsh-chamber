/**
 * chamber-lock.test.ts —— Electron 侧双 flavor 互斥锁单测（design 25 §6.3）
 *
 * 覆盖（真实 fs，临时目录）：
 *  ① darwin：取锁写记录（pid/startedAt/shell 与 Swift 侧同格式）+ 0600 权限；
 *  ② 第二个持有者 fail-closed（EAGAIN → holderPid），释放后可重取；
 *  ③ release 幂等；
 *  ④ 符号链接 fail-closed（O_NOFOLLOW）；
 *  ⑤ 非 darwin：unsupported 放行且**不创建锁文件**（平台范围诚实）；
 *  ⑥ 记录读取对损坏/缺字段的容错（诊断面绝不 throw）；
 *  ⑦ 双 flavor 同根 lockstep：Swift `PackagedLayout.userDataDir` == Electron
 *     `app.getName()` 推导（顶层 productName ?? name），防两 flavor 各锁各的。
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
import { fileURLToPath } from 'node:url'
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

/**
 * ⑦ 双 flavor 同根 lockstep（2026-09 GUI 验收 P1 修正）：Swift 的
 * `PackagedLayout.userDataDir` 必须与 Electron `app.getPath('userData')` 的
 * 推导**逐字一致**，否则两个 flavor 锁的是两个不同文件，互斥静默失效
 * （design 25 §6.3 的不变量）。
 *
 * Electron 的推导：userData = appData + `app.getName()`，而 `app.getName()` 取
 * package.json 的**顶层** `productName`，其次 `name`（`build.productName` 是
 * electron-builder 的产物命名，不参与推导——本仓正是踩了这个坑）。
 * 同源声明见 scripts/electron-dev.mjs 的 dev 隔离注释。
 */
test('⑦ 双 flavor 同根 lockstep：Swift 常量 == Electron identity 推导', () => {
  const desktopDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(desktopDir, '..', '..')
  const manifest = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8')) as {
    name?: string
    productName?: string
  }
  // Electron app.getName()：顶层 productName 优先，其次 name。
  const identity = manifest.productName ?? manifest.name
  assert.equal(identity, '@dsh-chamber/desktop',
    'Electron userData 目录名 = app.getName()；改了 package.json identity 就必须同步 Swift 常量')

  const swiftSource = readFileSync(
    path.join(repoRoot, 'macos', 'Sources', 'DSHChamber', 'ChamberResources.swift'), 'utf8')
  const match = /func userDataDir\(home: String\) -> String \{\s*\n\s*home \+ "([^"]+)"/.exec(swiftSource)
  assert.ok(match, 'ChamberResources.swift 的 userDataDir 字面量形状变化——请同步本 lockstep 断言')
  assert.equal(match[1], `/Library/Application Support/${identity}`,
    'Swift PackagedLayout.userDataDir 必须与 Electron app.getName() 推导同根（双 flavor 目录锁据此互斥）')
})
