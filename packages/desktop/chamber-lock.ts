/**
 * chamber-lock.ts —— 双 flavor 跨进程互斥锁（design 25 §6.3；Electron 侧，W-27 后续）
 *
 * 设计契约（design 25 §6.3 B2）：同一 userData 根绝不允许 Electron 版与 Swift
 * 版并发（registry/凭据事务/runtime 树无跨进程锁）。Swift 侧用
 * `flock(LOCK_EX|LOCK_NB)`（SidecarSupervisor）；Electron 侧没有 Node 的 flock
 * API，但 **Darwin 的 open(2) 支持 O_EXLOCK**，且 `fs.open` 接受数值 flags
 * （2026-09 实测：同进程第二次 open 得 EAGAIN，close 后可重取）——因此
 * darwin 上可零依赖实现同一把锁：
 *
 *   open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK, 0o600)
 *
 * 平台范围（有意收窄，文档化）：`O_EXLOCK` 是 BSD/Darwin 专有；Linux 需 flock(2)
 * （Node 未导出）、Windows 无等价物。而 Swift flavor 只在 macOS 存在——非 darwin
 * 平台不存在跨 flavor 冲突，因此本模块在非 darwin 返回 `unsupported` 标记并
 * 放行（调用方 loud 记录该范围，绝不假装已互斥）。
 *
 * 记录格式与 Swift 侧逐字一致 `{pid, startedAt, shell}`（诊断用；仲裁权在锁
 * 本身，绝不用 pid 探活做仲裁）。
 */
import {
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

/** 锁文件名（与 Swift `SidecarDirectoryLock` / sidecar-entry 复验同一路径）。 */
export const CHAMBER_LOCK_FILE = '.dsh-chamber.lock'

/** Darwin `sys/fcntl.h` 数值（Node 的 fs.constants 不导出 O_EXLOCK/O_NONBLOCK 组合位）。 */
const DARWIN_O_EXLOCK = 0x20
const DARWIN_O_NONBLOCK = 0x4
const O_RDWR = 0x2
const O_CREAT = 0x200
const O_NOFOLLOW = 0x100

export interface ChamberLockRecord {
  pid: number
  startedAt: number
  shell: string
}

export interface ChamberLockHandle {
  /** 锁记录路径（诊断）。 */
  recordPath: string
  /** 释放（幂等；进程退出由内核兜底）。 */
  release(): void
}

export type ChamberLockResult =
  | { ok: true; handle: ChamberLockHandle; unsupported: boolean }
  | { ok: false; holderPid: number | null; error: string }

export interface AcquireChamberLockOptions {
  userDataDir: string
  /** 注入平台（测试用；缺省 process.platform）。 */
  platform?: NodeJS.Platform
  /** 注入时间戳（测试用）。 */
  now?: number
  /** 记录里的 shell 标识（诊断）。 */
  shell?: string
}

/** 读取锁记录（诊断用；不存在/不可解析 → null）。 */
export function readChamberLockRecord(recordPath: string): ChamberLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as Partial<ChamberLockRecord>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      shell: typeof parsed.shell === 'string' ? parsed.shell : '',
    }
  } catch {
    return null
  }
}

/**
 * 取锁（darwin：O_EXLOCK 独占；非 darwin：unsupported 放行）。失败 fail-closed：
 * 调用方必须据此拒绝启动（另一 flavor 正持有同一 userData）。
 */
export function acquireChamberLock(options: AcquireChamberLockOptions): ChamberLockResult {
  const platform = options.platform ?? process.platform
  const recordPath = path.join(options.userDataDir, CHAMBER_LOCK_FILE)
  if (platform !== 'darwin') {
    // 非 darwin 无 Swift flavor → 无跨 flavor 冲突；不创建锁文件（避免留下
    // 误导性记录），由调用方 loud 记录平台范围。
    return {
      ok: true,
      unsupported: true,
      handle: { recordPath, release: () => {} },
    }
  }

  const flags = O_RDWR | O_CREAT | O_NOFOLLOW | DARWIN_O_EXLOCK | DARWIN_O_NONBLOCK
  let fd: number
  try {
    fd = openSync(recordPath, flags, 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
      const holder = readChamberLockRecord(recordPath)
      return {
        ok: false,
        holderPid: holder?.pid ?? null,
        error: `目录锁被占用（pid=${holder?.pid ?? '未知'}）——另一 flavor/实例正在使用该 userData`,
      }
    }
    return {
      ok: false,
      holderPid: null,
      error: `目录锁打开失败（${code ?? 'unknown'}）：${recordPath}`,
    }
  }

  // 规整文件 + 属主校验（与秘密文件同纪律：no-follow 已在 flags 里）。
  const info = fstatSync(fd)
  if (!info.isFile()) {
    closeSync(fd)
    return { ok: false, holderPid: null, error: `锁文件非规整文件（fail-closed）：${recordPath}` }
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    closeSync(fd)
    return { ok: false, holderPid: null, error: `锁文件属主异常（uid=${info.uid}）：${recordPath}` }
  }
  // 收紧既有宽松权限（O_CREAT 的 mode 只对新建生效；2026-09 审计 info 项：
  // 与「秘密文件同纪律」措辞对齐）。
  // 0o7777 而非 0o777：setuid/setgid/sticky 位同样要收紧（三审边界）。
  if ((info.mode & 0o7777) !== 0o600) {
    try {
      fchmodSync(fd, 0o600)
    } catch (error) {
      closeSync(fd)
      return { ok: false, holderPid: null, error: `锁文件权限收紧失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const record: ChamberLockRecord = {
    pid: process.pid,
    startedAt: (options.now ?? Date.now()) / 1000,
    shell: options.shell ?? 'electron',
  }
  try {
    const payload = JSON.stringify(record)
    ftruncateSync(fd, 0)
    writeSync(fd, payload, 0, 'utf8')
  } catch (error) {
    closeSync(fd)
    return {
      ok: false,
      holderPid: null,
      error: `锁记录写入失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let released = false
  return {
    ok: true,
    unsupported: false,
    handle: {
      recordPath,
      release() {
        if (released) return
        released = true
        closeSync(fd) // close 即释放 O_EXLOCK
      },
    },
  }
}
