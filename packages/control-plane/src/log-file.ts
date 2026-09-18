/**
 * 控制面自身的滚动日志文件（2026-12；Swift 原生版「ui-chat 卡死」取证缺口修复）。
 *
 * ## 为什么需要它
 *
 * 控制面最有价值的取证行是 WS splice 的
 * `WebSocket stream <id> closed (<cause>, <ms>ms)`（proxy-forward.ts）与
 * `heartbeat lost after N unanswered ping(s)`——它们区分「实例判死 / 浏览器腿
 * 消失 / 代理自身心跳拆链」。但控制面此前只把日志交给注入的 logger（默认
 * console）：打包态从 Finder/Dock 启动时 stdout/stderr 不落盘（实测
 * `log show --predicate 'process == "DSHChamberPoc"'` 无输出），Electron 主进程
 * 同理——两类 flavor 的这条证据都等于丢失，事故只能靠猜。
 *
 * ## 位置与纪律
 *
 * 写给 `<stateDir>/logs/control-plane.log`（JSONL，一行一条；与
 * `host-logs/<port>.log` 同构，便于同一套 grep/解析）。控制面拥有 stateDir，
 * 因此**两 flavor 共用同一实现**，不产生新的 flavor 偏差。
 *
 * - **有界**：单文件 `maxBytes`（默认 2 MiB），轮转保留 `files` 份
 *   （默认 3 份：`.log`、`.1`、`.2`）；
 * - **fail-soft**：目录创建失败、写失败、轮转失败一律只告警一次并降级为
 *   不落盘——日志绝不阻断控制面（与 sidecar/NativeShellLog 同纪律）；
 * - **不脱敏的边界**：这里只是控制面自己的日志（不含凭据；秘密面契约见
 *   design 05 §8 / 17 §8 不变）。调用方仍不得把凭据写进日志。
 */

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import type { Logger } from './types.ts'

/** 单个日志文件默认上限（2 MiB；环内总占用 ≤ 6 MiB）。 */
export const DEFAULT_CONTROL_LOG_MAX_BYTES = 2 * 1024 * 1024
/** 默认保留份数（`.log` + 2 份轮转）。最小值 2（1 份 = 只能截断，不是轮转环）。 */
export const DEFAULT_CONTROL_LOG_FILES = 3
/** 环内最小份数（`.log` + 至少 1 份轮转）。 */
export const MIN_CONTROL_LOG_FILES = 2
/** 每写多少行做一次磁盘身份巡检（外删/替换检测；stat 成本按行摊薄）。 */
export const IDENTITY_CHECK_EVERY = 64
/** 日志目录名（stateDir 下）。 */
export const CONTROL_LOG_DIR = 'logs'
/** 日志文件名。 */
export const CONTROL_LOG_FILE = 'control-plane.log'

/** 一行日志的封装（单行、有界；调用方保证无换行注入）。 */
export interface ControlLogRecord {
  readonly ts: string
  readonly level: 'log' | 'warn' | 'error'
  readonly line: string
}

/** 日志文件写入器（`write` 只接受已封装的记录）。 */
export interface ControlLogSink {
  /** 追加一条记录（fail-soft；失败后自动降级为 no-op）。 */
  write(record: ControlLogRecord): void
  /** 当前是否仍在落盘（诊断/测试用）。 */
  isActive(): boolean
  /** 停止落盘并关掉句柄（不删除已有文件）。 */
  close(): void
  /**
   * 重新打开（控制面 `start()` 支持 stop→start 重启；不重开会表现为「看起来还在写、
   * 实际只转发不落盘」的静默取证缺口）。关闭后再次 write 不会自动重开。
   */
  reopen(): void
}

/** 序列化一条日志行（bounded、单行；无法序列化时退化为 String()）。 */
export function formatControlLogLine(args: readonly unknown[]): string {
  const parts: string[] = []
  for (const arg of args) {
    if (typeof arg === 'string') parts.push(arg)
    else if (arg instanceof Error) parts.push(arg.stack ?? `${arg.name}: ${arg.message}`)
    else {
      try {
        parts.push(JSON.stringify(arg) ?? String(arg))
      } catch {
        // String() 本身也可能抛（null 原型 + 自定义 toString/BigInt 的宿主对象）：
        // 日志序列化绝不允许把异常抛回调用方的 logger（2026-12 独立复核）。
        try { parts.push(String(arg)) } catch { parts.push('[unserializable log argument]') }
      }
    }
  }
  const text = parts.join(' ').replaceAll(/\r?\n/g, ' ⏎ ')
  return text.length > 8_192 ? `${text.slice(0, 8_192)}…` : text
}

/** 创建/打开一个滚动日志写入器（fail-soft）。 */
export function createControlLogSink(options: {
  /** stateDir 根（日志写在其下的 logs/）。 */
  readonly stateDir: string
  readonly maxBytes?: number
  readonly files?: number
  /** 降级告警（默认 console.warn；注入以便测试静默）。 */
  readonly warn?: (message: string) => void
}): ControlLogSink {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_CONTROL_LOG_MAX_BYTES)
  // 份数下限 2：`files: 1` 若走轮转环会实际留下 `.log` + `.1` 两份（与文档的
  // 「保留 files 份」不符），故直接夹到 2（2026-12 独立复核发现）。
  const files = Math.max(MIN_CONTROL_LOG_FILES, options.files ?? DEFAULT_CONTROL_LOG_FILES)
  const warn = options.warn ?? ((message: string) => { console.warn(message) })
  const directory = join(options.stateDir, CONTROL_LOG_DIR)
  const path = join(directory, CONTROL_LOG_FILE)
  let active = true
  let warned = false
  /** 常驻句柄与内存内的字节水位（避免每行一次 stat+open+close 往返）。 */
  let handle: number | undefined
  let writtenBytes = 0
  /** 常驻句柄对应的磁盘身份（dev/ino）：外删/替换检测用（见 refreshHandleIdentity）。 */
  let handleDev = 0
  let handleIno = 0
  /** 距上次身份巡检写入的行数（巡检本身要 stat，按行数摊薄）。 */
  let writesSinceIdentityCheck = 0
  const degrade = (reason: string): void => {
    active = false
    closeHandle()
    if (warned) return
    warned = true
    warn(`[control-plane] log file disabled: ${reason} (persisting control-plane logs is unavailable this run)`)
  }
  const closeHandle = (): void => {
    if (handle === undefined) return
    try { closeSync(handle) } catch { /* 关闭失败不影响调用方 */ }
    handle = undefined
  }
  /**
   * 目录纪律（**每次开句柄前都查**，不只构造期）：0700 创建 + 目录本身 no-follow。
   * 与同 stateDir 的 host-logs.ts（design 02 §3.8）和原生壳 NativeShellLog
   * （0600/0700）同一纪律。文件级 O_NOFOLLOW 只保护最后一段，若 logs/ 是指向
   * 别处的符号链接，mkdirSync(recursive) 会接受它，随后把日志写进攻击者选定的
   * 目录（对照 host-logs.ts 同族检查）。2026-12 复核修正：reopen()/start() 是生产
   * 必走路径，只在构造期查会让降级后的 sink 在 reopen 时被重新激活。
   * @returns true = 目录可用；false = 已降级，调用方不得继续开句柄。
   */
  const validateDirectory = (): boolean => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      // 0700 只在**创建**时生效：已存在的宽松目录必须显式收紧（文档承诺 0700，
      // 但 mode 参数不会改既有目录的位，2026-12 独立复核）。
      try { chmodSync(directory, 0o700) } catch { /* 非 POSIX 或无权限：不因此停写 */ }
      if (lstatSync(directory).isSymbolicLink()) {
        degrade('logs directory is a symbolic link: ' + directory)
        return false
      }
      return true
    } catch (error) {
      degrade(`cannot create ${directory}: ${String(error)}`)
      return false
    }
  }
  validateDirectory()
  /**
   * 打开常驻句柄：**0600 + 不跟随符号链接**（O_NOFOLLOW），与 host-logs.ts 的
   * `open(..., O_WRONLY|O_APPEND|O_NOFOLLOW|O_CREAT|O_EXCL, 0o600)` 同族。
   *
   * 常驻而不每行 open/close（2026-12 二轮复核）：宿主的 stdout/stderr 每一行都会
   * 经控制面 logger（spawn-dsh 同时写 host-logs 与这里），逐行 4 次同步系统调用
   * 是真实开销；句柄在 write 失败/降级/close 时关闭，字节水位在内存里维护。
   */
  const openHandle = (): boolean => {
    if (handle !== undefined) return true
    // reopen()/start() 是生产必走路径：构造期的目录检查不能只做一次，
    // 否则符号链接目录会在 reopen 时被重新激活（O_NOFOLLOW 只保护最后一段）。
    if (!validateDirectory()) return false
    try {
      handle = openSync(path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      // 0600 同样只在创建时生效：已存在的宽松文件（旧版本留下/手工改过）必须显式
      // 收紧，否则文档与 T-25 的"无条件 0600"是假的（2026-12 独立复核）。
      try { fchmodSync(handle, 0o600) } catch { /* 某些文件系统不支持：不因此停写 */ }
      const stat = statSync(path)
      writtenBytes = stat.size
      handleDev = stat.dev
      handleIno = stat.ino
      return true
    } catch (error) {
      handle = undefined
      degrade(`cannot open ${path}: ${String(error)}`)
      return false
    }
  }
  /**
   * 句柄身份巡检（每 {@link IDENTITY_CHECK_EVERY} 行一次 stat）：常驻句柄在外删/替换
   * 当前文件时会继续写进已 unlink 的 inode——最多丢掉整个上限的日志且不自知
   * （2026-12 独立复核）。发现 dev/ino 变化或文件消失即丢弃旧句柄并按新文件重开。
   * @returns true = 句柄可继续写；false = 已降级（调用方必须放弃这一行）。
   */
  const refreshHandleIdentity = (): boolean => {
    try {
      const stat = statSync(path)
      if (stat.dev === handleDev && stat.ino === handleIno) return true
    } catch { /* 文件已被删除：下面按"需要重开"处理 */ }
    closeHandle()
    writtenBytes = 0
    return openHandle()
  }
  /** @returns 轮转后当前文件是否确实被挪走（false = 该环失效，须降级）。 */
  const rotate = (): boolean => {
    closeHandle()
    // 每一步独立容错：环里尚未生成的槽位（.1 不存在等）不得让整轮轮转中止
    // ——整轮 try/catch 会吞掉「.log → .1」这一步，表现为文件无限增长
    // （由 log-file 单测抓出）。
    try { rmSync(`${path}.${String(files - 1)}`, { force: true }) } catch { /* 不存在即目的达成 */ }
    for (let index = files - 2; index >= 1; index -= 1) {
      try {
        renameSync(`${path}.${String(index)}`, `${path}.${String(index + 1)}`)
      } catch { /* 该槽位尚未生成 */ }
    }
    try {
      renameSync(path, `${path}.1`)
    } catch { /* 首次轮转前没有当前文件 */ }
    // 只靠 catch 无法区分「本来就没有当前文件」与「rename 持续失败」：后者在
    // 槽位被目录/权限卡住时会让文件无界增长且不报错（2026-12 独立复核发现）。
    // 用「当前文件是否还超限」作为轮转确实发生的证据。
    try {
      const onDisk = statSync(path).size
      writtenBytes = onDisk
      return onDisk < maxBytes
    } catch {
      writtenBytes = 0
      return true
    }
  }
  return {
    write(record: ControlLogRecord): void {
      if (!active) return
      try {
        if (writtenBytes >= maxBytes && !rotate()) {
          degrade(`rotation failed for ${path} (the log would grow without bound)`)
          return
        }
        if (!openHandle()) return
        writesSinceIdentityCheck += 1
        if (writesSinceIdentityCheck >= IDENTITY_CHECK_EVERY && !refreshHandleIdentity()) return
        if (writesSinceIdentityCheck >= IDENTITY_CHECK_EVERY) writesSinceIdentityCheck = 0
        const line = `${JSON.stringify(record)}\n`
        writeSync(handle as number, line)
        writtenBytes += Buffer.byteLength(line)
      } catch (error) {
        degrade(`write failed: ${String(error)}`)
      }
    },
    isActive: () => active,
    close: () => {
      active = false
      closeHandle()
    },
    reopen: () => {
      // 先关旧句柄：句柄已开时 openHandle() 会直接返回且不重新 stat，于是清零后的
      // 内存水位与磁盘上的真实大小脱节（边界可涨到 2x maxBytes；三轮复核实测）。
      closeHandle()
      active = true
      warned = false
      writtenBytes = 0
      openHandle()
    },
  }
}

/**
 * 把控制面 logger 包成「原样转发 + 落盘」的形状（**两 flavor 共用**）。
 * @param base - 调用方注入的 logger（默认 console）。
 * @param stateDir - 控制面 state 根。
 * @param options - 测试注入（上限/时钟/告警）。
 * @returns 与 {@link Logger} 同形的 logger（`close` 经属性暴露给调用方）。
 */
export function withControlLogFile(
  base: Logger,
  stateDir: string,
  options: { maxBytes?: number; files?: number; now?: () => Date; warn?: (message: string) => void } = {},
): Logger & { close: () => void; reopen: () => void } {
  // 降级告警走**注入的** logger（而不是硬编码 console.warn）：打包态从 Finder/Dock
  // 启动时 stdout 不落盘，控制面的告警应当落在调用方的诊断面上（2026-12 独立复核）。
  // 落盘失败后 sink 已 inactive，这条转发不会递归写回文件。
  const sink = createControlLogSink({
    stateDir,
    ...options,
    warn: options.warn ?? ((message: string) => { base.warn(message) }),
  })
  const timestamp = (): string => (options.now ?? (() => new Date()))().toISOString()
  const emit = (level: ControlLogRecord['level'], args: readonly unknown[]): void => {
    sink.write({ ts: timestamp(), level, line: formatControlLogLine(args) })
  }
  return {
    log: (...args: unknown[]) => { emit('log', args); base.log(...args) },
    warn: (...args: unknown[]) => { emit('warn', args); base.warn(...args) },
    error: (...args: unknown[]) => { emit('error', args); base.error(...args) },
    close: () => { sink.close() },
    reopen: () => { sink.reopen() },
  }
}
