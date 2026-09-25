/**
 * 致命诊断的本地报告面（Electron 主进程）：把「白屏/秒退/子进程消失」的现场
 * 落成一份**可读的本地报告文件**，并把它的路径告诉用户（对话框内点名），
 * 与上游 0.1.7 的 fatal diagnostics 口径对齐（升级计划 §18 行 1 / §22.3.1）。
 *
 * 三条纪律：
 * 1. **只落盘、不外发**：报告永不上传（crashReporter 亦 uploadToServer=false）。
 * 2. **有界**：单条记录字段截断、渲染端 console 环 64KiB、报告目录不轮转以外
 *    只追加（轮转不做：证据不该被自己删掉）。
 * 3. **诚实**：写入失败绝不谎报路径——只有真正 append 成功才返回 written=true。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describeError } from './describe-error.ts'

/** 报告文件名（与 Swift 侧 shell-crash.log 分列，互不覆盖）。 */
export const FATAL_REPORT_FILE = 'fatal-report.log'
/** 渲染端 console 错误环上限（上游为 64KiB 有界环）。 */
export const CONSOLE_RING_BYTES = 64 * 1024
/** 报告里单条 detail 的上限（对话框文案另有更小上限）。 */
export const REPORT_DETAIL_LIMIT = 64 * 1024

/** 报告落点：<userData>/logs/fatal-report.log（与 shell.log 同目录）。 */
export function fatalReportPath(userDataDir: string): string {
  return join(userDataDir, 'logs', FATAL_REPORT_FILE)
}

export interface FatalReportRecord {
  /** ISO 时间戳。 */
  readonly at: string
  /** 应用版本（app.getVersion()）。 */
  readonly version: string
  /** 记录来源：electron 主进程 / 原生壳。 */
  readonly source: 'electron-main' | 'native-shell'
  /** 阶段：启动期 / 运行期（上游报告含 source/phase）。 */
  readonly phase: 'startup' | 'running'
  /** 事件种类：fatal / child-process-gone / renderer-gone / console。 */
  readonly event: string
  /** 已描述的错误或事件正文（调用方用 describeFatalError 等有界描述器）。 */
  readonly detail: string
  /** 附加事实行（如 console 环、stderr 尾、子进程类型/退出码）。 */
  readonly extras?: readonly string[]
}

/** 单条记录的纯渲染（键=值 行式，便于 grep 与人工阅读）。 */
export function renderFatalReport(record: FatalReportRecord): string {
  const detail = record.detail.length > REPORT_DETAIL_LIMIT
    ? record.detail.slice(0, REPORT_DETAIL_LIMIT) + '…(截断)'
    : record.detail
  const lines = [
    '--- dsh-chamber fatal report ---',
    'at=' + record.at,
    'version=' + record.version,
    'source=' + record.source,
    'phase=' + record.phase,
    'event=' + record.event,
    'detail=' + detail.replace(/\r?\n/gu, ' ⏎ '),
  ]
  for (const extra of record.extras ?? []) {
    if (extra === '') continue
    lines.push('extra=' + extra.replace(/\r?\n/gu, ' ⏎ '))
  }
  return lines.join('\n') + '\n'
}

export interface FatalReportIo {
  /** 递归建目录（幂等）。 */
  ensureDir(path: string): void
  /** 追加正文。 */
  append(path: string, text: string): void
}

export interface FatalReportResult {
  /** false = 未写入（reason 给出原因；调用方绝不给用户假路径）。 */
  readonly written: boolean
  readonly path: string
  readonly reason?: string
}

const diskIo: FatalReportIo = {
  ensureDir: (path) => { mkdirSync(path, { recursive: true }) },
  append: (path, text) => { appendFileSync(path, text, { encoding: 'utf8', mode: 0o600 }) },
}

/**
 * 追加一条已渲染的报告（IO 可注入；失败返回 written=false 而不是抛）。
 * @param input - 目标路径、已渲染正文、可选 IO 实现。
 * @returns 写入结果（诚实：只有成功才带 written=true）。
 */
export function appendFatalReport(input: { path: string; text: string; io?: FatalReportIo }): FatalReportResult {
  const io = input.io ?? diskIo
  try {
    io.ensureDir(dirname(input.path))
    io.append(input.path, input.text)
    return { written: true, path: input.path }
  } catch (error) {
    return { written: false, path: input.path, reason: describeError(error) }
  }
}

/**
 * 渲染 + 追加一条记录，返回可直接拼进对话框文案的后缀行：成功给路径，失败给
 * 明确的「写入失败」说明（绝不让用户去找一个不存在的文件）。
 * @param input - 报告记录 + 落点目录 + 可选 IO（用例注入）。
 * @returns 面向对话框的一行（永不抛）。
 */
export function recordFatalReport(input: {
  readonly userDataDir: string
  readonly record: FatalReportRecord
  readonly io?: FatalReportIo
}): { readonly line: string; readonly result: FatalReportResult } {
  const path = fatalReportPath(input.userDataDir)
  const result = appendFatalReport({ path, text: renderFatalReport(input.record), io: input.io })
  const line = result.written
    ? '本地报告：' + result.path
    : '本地报告写入失败（' + (result.reason ?? 'unknown') + '）：' + result.path
  return { line, result }
}

/**
 * 渲染端 console 错误的**有界环**（64KiB，只留尾部）：主进程只欠证据链，不欠
 * 转发——环只进本地报告，绝不外发、绝不阻塞渲染端。
 */
export class ConsoleRing {
  private chunks: string[] = []
  private bytes = 0
  private readonly limit: number

  /** @param limit - 字节上限（缺省 64KiB）。 */
  constructor(limit: number = CONSOLE_RING_BYTES) {
    this.limit = limit
  }

  /** 追加一行（超出上限时从头部丢弃整块，保留最近证据）。 */
  push(line: string): void {
    const text = line.endsWith('\n') ? line : line + '\n'
    this.chunks.push(text)
    this.bytes += Buffer.byteLength(text, 'utf8')
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift() ?? ''
      this.bytes -= Buffer.byteLength(dropped, 'utf8')
    }
    if (this.bytes > this.limit) {
      const kept = this.chunks[0] ?? ''
      const sliced = Buffer.from(kept, 'utf8').subarray(-this.limit).toString('utf8')
      this.bytes = Buffer.byteLength(sliced, 'utf8')
      this.chunks = [sliced]
    }
  }

  /** 当前内容（尾部证据）。 */
  snapshot(): string {
    return this.chunks.join('')
  }

  /** 当前字节数（用例与报告可读）。 */
  get size(): number {
    return this.bytes
  }
}

/**
 * 渲染端 console 事件 → 环。Electron 43 的 `console-message` 既可能是旧式
 * 位置参数，也可能是 details 对象；只收 error 级（level >= 3 / 'error'）。
 * @param ring - 目标环。
 * @param args - 事件参数（旧式或 details 形态）。
 */
export function pushConsoleMessage(ring: ConsoleRing, args: readonly unknown[]): void {
  const [first, second, third, fourth, fifth] = args
  let level: unknown = second
  let message: unknown = third
  let line: unknown = fourth
  let sourceId: unknown = fifth
  if (typeof first === 'object' && first !== null) {
    const details = first as Record<string, unknown>
    level = details.level
    message = details.message
    line = details.lineNumber
    sourceId = details.sourceId
  }
  const isError = level === 3 || level === 'error' || level === 4
  if (!isError) return
  const text = typeof message === 'string' ? message : String(message ?? '')
  const where = [sourceId, line].filter((value) => value !== undefined && value !== null && value !== '').join(':')
  ring.push(where === '' ? text : where + ' ' + text)
}