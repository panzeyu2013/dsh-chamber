/**
 * Single error-stringification boundary for the desktop main process: every
 * catch/report site uses one function, so a diagnostic cannot be lost to a
 * thrown proxy/getter or a re-thrown second exception (the discipline the
 * structured IPC result channel depends on). An Error's `cause` chain is
 * appended as `<message>: <cause>`, bounded to MAX_CAUSE_DEPTH links and
 * cycle-safe, so a wrapped failure keeps why it happened.
 */
const MAX_CAUSE_DEPTH = 4

/** Hostile-safe stable text for one thrown value (never throws, never ''). */
function primaryText(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = typeof error.message === 'string' ? error.message : ''
      if (message !== '') return message
      const name = typeof error.name === 'string' ? error.name : ''
      if (name !== '') return name
    }
  } catch {
  }
  try {
    const text = String(error)
    return text === '' ? 'unknown error' : text
  } catch {
    return 'unknown error'
  }
}

function causeText(error: unknown, depth: number): string | null {
  if (depth >= MAX_CAUSE_DEPTH) return null
  let cause: unknown
  try {
    if (!(error instanceof Error)) return null
    cause = (error as { cause?: unknown }).cause
  } catch {
    return null
  }
  if (cause === undefined || cause === null) return null
  const text = primaryText(cause)
  const nested = causeText(cause, depth + 1)
  return nested === null ? text : text + ': ' + nested
}

/** Stable, non-empty, hostile-safe diagnostic including the cause chain. */
export function describeError(error: unknown): string {
  const text = primaryText(error)
  const cause = causeText(error, 0)
  return cause === null ? text : text + ': ' + cause
}

/**
 * 致命诊断专用描述（进本地报告，不进用户可见的通用文案）：在 describeError 的
 * cause 链（≤4 层）之外，再带上 Node 错误对象的 `code`/`errno`/`syscall`/`path`
 * ——上游 fatal 报告用 util.inspect(depth 4) 给出的正是这组事实，缺了它
 * 「EACCES / 哪个路径 / 哪个系统调用」只能靠猜。有界：每个字段截断、整体截断、
 * 全部读写包在 try 里（代理/getter 抛错不得让诊断本身炸掉）。
 */
const FATAL_FIELD_LIMIT = 300
const FATAL_TOTAL_LIMIT = 2000

function boundedField(value: unknown): string | null {
  try {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const text = String(value)
    if (text === '') return null
    return text.length > FATAL_FIELD_LIMIT ? text.slice(0, FATAL_FIELD_LIMIT) + '…' : text
  } catch {
    return null
  }
}

function fatalFields(error: unknown): string[] {
  const fields: string[] = []
  try {
    if (!(error instanceof Error)) return fields
    const holder = error as unknown as Record<string, unknown>
    for (const key of ['code', 'errno', 'syscall', 'path', 'address', 'port'] as const) {
      const text = boundedField(holder[key])
      if (text !== null) fields.push(key + '=' + text)
    }
  } catch {
    // hostile getter: keep whatever was collected so far
  }
  return fields
}

/** 有界、不会抛的致命错误描述（含 cause 链与 Node 错误字段）。 */
export function describeFatalError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === undefined || current === null) break
    const fields = fatalFields(current)
    const text = primaryText(current)
    parts.push(fields.length === 0 ? text : text + ' (' + fields.join(', ') + ')')
    let next: unknown
    try {
      next = current instanceof Error ? (current as { cause?: unknown }).cause : undefined
    } catch {
      next = undefined
    }
    if (next === undefined || next === null) break
    current = next
  }
  const joined = parts.join(' ← ').replace(/\s+/gu, ' ').trim()
  const text = joined === '' ? 'unknown fatal error' : joined
  return text.length > FATAL_TOTAL_LIMIT ? text.slice(0, FATAL_TOTAL_LIMIT) + '…(截断)' : text
}