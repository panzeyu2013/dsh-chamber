/**
 * 控制面自身的滚动日志文件。
 *
 * 为什么：打包态从 Finder/Dock 启动时 stdout/stderr 不落盘，WS splice 关闭原因与
 * `heartbeat lost` 这些取证行会丢失。写给 `<stateDir>/logs/control-plane.log`
 * （JSONL，与 `host-logs/<port>.log` 同构）；控制面拥有 stateDir，两 flavor 共用。
 *
 * - **有界**：单文件 maxBytes（默认 2 MiB），轮转保留 files 份（默认 3）；
 * - **fail-soft**：目录/写/轮转失败只告警一次并降级为不落盘，绝不阻断控制面；
 * - 调用方仍不得把凭据写进日志（这里只含控制面自己的日志）。
 */

import { closeSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  ensurePrivateDirectoryNoFollow,
  noFollowOpenFlag,
  openPrivateAppendNoFollow,
  rotatePrivateFileRingNoFollow,
  writePrivateFdAll,
} from './private-file.ts'
import type { Logger } from './types.ts'

/** 单个日志文件默认上限（2 MiB；环内总占用 ≤ 6 MiB）。 */
export const DEFAULT_CONTROL_LOG_MAX_BYTES = 2 * 1024 * 1024
/** 默认保留份数（`.log` + 2 份轮转）。最小值 2（1 份 = 只能截断，不是轮转环）。 */
export const DEFAULT_CONTROL_LOG_FILES = 3
export const MIN_CONTROL_LOG_FILES = 2
/** 每写多少行做一次磁盘身份巡检（外删/替换检测；stat 成本按行摊薄）。 */
export const IDENTITY_CHECK_EVERY = 64
export const CONTROL_LOG_DIR = 'logs'
export const CONTROL_LOG_FILE = 'control-plane.log'

/** 平台暴露 O_NOFOLLOW / O_NONBLOCK 时取其值，否则显式 0。win32 两个常量都
 *  不存在：不能依赖位或把 `undefined` 静默转成 0（那正是守卫消失而无告警的原因）。 */
const CONTROL_LOG_NOFOLLOW_FLAG = noFollowOpenFlag()
const CONTROL_LOG_NONBLOCK_FLAG = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0

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
  /** 当前是否仍在落盘。 */
  isActive(): boolean
  /** 停止落盘并关掉句柄（不删除已有文件）。 */
  close(): void
  /** 重新打开（stop→start 必须；关闭后 write 不会自动重开——不重开会静默只转发不落盘）。 */
  reopen(): void
}

/** 序列化一条日志行（bounded、单行；无法序列化时退化为 String()）。 */
export function formatControlLogLine(args: readonly unknown[]): string {
  const parts: string[] = []
  for (const arg of args) {
    try {
      if (typeof arg === 'string') { parts.push(arg); continue }
      // `instanceof` 触发 [[GetPrototypeOf]]：可撤销 Proxy 在这一步就抛，
      // 所以类型判别也要在 try 里——日志序列化绝不把异常抛回调用方的 logger。
      if (arg instanceof Error) {
        parts.push(arg.stack ?? `${arg.name}: ${arg.message}`)
        continue
      }
      try {
        parts.push(JSON.stringify(arg) ?? String(arg))
      } catch {
        // String() 本身也可能抛（null 原型 + 自定义 toString/BigInt 的宿主对象）。
        try { parts.push(String(arg)) } catch { parts.push('[unserializable log argument]') }
      }
    } catch {
      parts.push('[unserializable log argument]')
    }
  }
  const text = parts.join(' ').replaceAll(/\r?\n/g, ' ⏎ ')
  return text.length > 8_192 ? `${text.slice(0, 8_192)}…` : text
}

/** 创建/打开一个滚动日志写入器（fail-soft）。 */
export function createControlLogSink(options: {
  readonly stateDir: string
  readonly maxBytes?: number
  readonly files?: number
  /** 降级告警（默认 console.warn）。 */
  readonly warn?: (message: string) => void
}): ControlLogSink {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_CONTROL_LOG_MAX_BYTES)
  // 份数下限 2：`files: 1` 走轮转环会留下 `.log` + `.1` 两份，与「保留 files 份」不符。
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
    // 告警通道（注入的 logger）本身也可能抛：日志降级绝不能再制造一个失败面。
    try {
      warn(`[control-plane] log file disabled: ${reason} (persisting control-plane logs is unavailable this run)`)
    } catch { /* 告警失败即放弃告警 */ }
  }
  const closeHandle = (): void => {
    if (handle === undefined) return
    try { closeSync(handle) } catch { /* 关闭失败不影响调用方 */ }
    handle = undefined
  }
  /**
   * 目录纪律（**每次开句柄前都查**，不只构造期）：0700 创建 + 目录本身 no-follow。
   * 文件级 O_NOFOLLOW 只保护最后一段，若 logs/ 是指向别处的符号链接，
   * mkdirSync(recursive) 会接受它并把日志写进攻击者选定的目录。reopen()/start()
   * 是生产必走路径，只在构造期查会让降级后的 sink 在 reopen 时被重新激活。
   * @returns true = 目录可用；false = 已降级，调用方不得继续开句柄。
   */
  const validateDirectory = (): boolean => {
    try {
      // 目录纪律单一源（ensurePrivateDirectoryNoFollow）：no-follow + identity +
      // 0700，且先判链接再 chmod；任何失败即降级原因。
      ensurePrivateDirectoryNoFollow(directory, 0o700, { existingMode: 'tighten' })
      return true
    } catch (error) {
      degrade(`cannot create ${directory}: ${String(error)}`)
      return false
    }
  }
  validateDirectory()
  /**
   * 打开常驻句柄：**0600 + 不跟随符号链接**（O_NOFOLLOW）。
   *
   * 常驻而不每行 open/close：宿主 stdout/stderr 每行都经此 sink，逐行 4 次同步
   * 系统调用是真实开销；句柄在写失败/降级/close 时关闭，字节水位在内存维护。
   */
  const openHandle = (): boolean => {
    if (handle !== undefined) return true
    // reopen()/start() 是生产必走路径：构造期的目录检查不能只做一次，
    // 否则符号链接目录会在 reopen 时被重新激活（O_NOFOLLOW 只保护最后一段）。
    if (!validateDirectory()) return false
    try {
      // 打开语义单一源（openPrivateAppendNoFollow）：O_APPEND|O_CREAT + O_NOFOLLOW、
      // 0600 收紧（fail-soft，故 strictTighten=false）、O_NONBLOCK（叶子被换成
      // FIFO 时不得阻塞事件循环）；身份取自句柄本身（fstat），换文件也不失明。
      const opened = openPrivateAppendNoFollow(path, {
        create: true,
        verifyPathIdentity: CONTROL_LOG_NOFOLLOW_FLAG === 0,
        tightenMode: 0o600,
        strictTighten: false,
        extraFlags: CONTROL_LOG_NONBLOCK_FLAG,
      })
      handle = opened.fd
      writtenBytes = opened.size
      handleDev = opened.identity.dev
      handleIno = opened.identity.ino
      return true
    } catch (error) {
      // degrade() 内部会 closeHandle()：必须先降级再清 handle，否则刚打开的 fd 泄漏。
      degrade(`cannot open ${path}: ${String(error)}`)
      handle = undefined
      return false
    }
  }
  /**
   * 句柄身份巡检（每 IDENTITY_CHECK_EVERY 行一次 stat）：常驻句柄在外删/替换后会继续
   * 写进已 unlink 的 inode，最多丢掉整个上限的日志而不自知。dev/ino 变化或文件消失即
   * 丢弃旧句柄并按新文件重开；返回 false = 已降级（调用方必须放弃这一行）。
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
    // 环语义单一源（rotatePrivateFileRingNoFollow）：轮转前校验每个现存槽位（单链接
    // 常规文件、非符号链接、同 uid）；被预置的链接/多链接/他人文件作为证据拒绝整个
    // 轮转，绝不删除或覆盖。失败返回 false，由调用方按「文件将无界增长」告警一次。
    try {
      rotatePrivateFileRingNoFollow(path, { files })
    } catch {
      return false
    }
    // 只靠 catch 无法区分「本来就没有当前文件」与「rename 持续失败」（后者会让文件
    // 无界增长且不报错）：用「当前文件是否还超限」作为轮转确实发生的证据。
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
        const bytes = Buffer.byteLength(line)
        writePrivateFdAll(handle as number, line)
        // 短写由 writePrivateFdAll 循环吸收；零进展抛错并降级，水位只在写完后推进。
        writtenBytes += bytes
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
      // 内存水位与磁盘上的真实大小脱节（边界可涨到 2x maxBytes）。
      closeHandle()
      active = true
      warned = false
      writtenBytes = 0
      openHandle()
    },
  }
}

/**
 * 把控制面 logger 包成「原样转发 + 落盘」的形状（两 flavor 共用）。
 * @param base - 调用方注入的 logger（默认 console）。
 * @returns 同形 logger（`close` 经属性暴露）。
 */
export function withControlLogFile(
  base: Logger,
  stateDir: string,
  options: { maxBytes?: number; files?: number; now?: () => Date; warn?: (message: string) => void } = {},
): Logger & { close: () => void; reopen: () => void } {
  // 降级告警走注入的 logger（不是硬编码 console.warn），保证不绕过调用方；落盘失败后
  // sink 已 inactive，这条转发不会递归写回文件。
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
