#!/usr/bin/env node
/**
 * dsh-chamber — DSH 控制面 CLI（v4 连接管理器薄壳命令面，05 §3.2 保留面）。
 *
 * 全部非 serve 命令消费控制面 REST（05 §3.2 / 04 §3 保留端点）：
 * - serve: 内嵌 @dsh-chamber/control-plane（createControlPlane），SIGINT/SIGTERM 优雅退出。
 * - 认证/审计：v1 收敛整体移除——无 auth/audit 子命令，控制面无登录面。
 * - 输出：人读表格；--json 时 JSON.stringify 原样输出。
 */

import { createControlPlane, DEFAULT_CONTROL_PLANE_PORT } from '@dsh-chamber/control-plane'
import { followNewLines } from './follow-filter.ts'

const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_CONTROL_PLANE_PORT}`

/** 命令标志：--flag VALUE → string；布尔 --flag → true。 */
type FlagValue = string | boolean
type FlagMap = Map<string, FlagValue>

interface ParsedArgs {
  flags: FlagMap
  positionals: string[]
}

/** REST 请求选项（request 的第三参）。 */
interface RequestOptions {
  url: string
  body?: unknown
}

/** 统一错误形状（设计 04 D1）：{error, code?}；其余字段仅作展示。 */
interface ApiErrorBody {
  error?: unknown
  message?: unknown
  code?: unknown
}

/** request 抛出的 HTTP 错误：status/code/raw 供命令级错误映射。 */
class ApiRequestError extends Error {
  status: number
  code: string | null
  raw: unknown
  constructor(status: number, code: string | null, raw: unknown, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.raw = raw
  }
}

function asApiError(error: unknown): ApiRequestError | null {
  return error instanceof ApiRequestError ? error : null
}

/** 各端点响应形状（api.ts 顶部 docblock 为准）。 */
interface HealthDsh {
  status?: string
  port?: number
  error?: string
}
interface HealthResponse {
  ok: boolean
  dsh?: HealthDsh
}
/** 连接行投影（04 §3.2：id/label/accentColor/status/dshPort/error）。 */
interface ConnectionRow {
  id: string
  label?: string
  accentColor?: string
  status: string
  dshPort?: number
  error?: string
}
interface ConnectionsResponse {
  connection: ConnectionRow | null
}
interface LogLine {
  ts: number | string
  stream?: string
  line?: string
}
interface HostLogsResult {
  lines?: LogLine[]
  port?: number
  truncated?: boolean
}

function usage() {
  console.log(`dsh-chamber — DSH 控制面 CLI（v4 管理面）

用法:
  dsh-chamber serve [--port N] [--state-dir DIR] [--dsh-path PATH]
  dsh-chamber status [--url URL] [--json]
  dsh-chamber connections list [--url URL] [--json]
  dsh-chamber connections add --kind local [--url URL] [--json]
  dsh-chamber connections rename --label L [--accent-color C] [--url URL] [--json]
  dsh-chamber connections remove [--url URL] [--json]
  dsh-chamber host status [--url URL] [--json]
  dsh-chamber host logs [--limit N] [--follow] [--url URL] [--json]

环境变量:
  DSH_CHAMBER_URL     控制面 URL（默认 ${DEFAULT_URL}）
  DSH_CHAMBER_STATE   控制面状态目录（serve 默认 ~/.dsh-chamber）
  DSH_CHAMBER_DSH_PATH dsh 工作区路径（serve --dsh-path 的默认值）
`)
}

/** 解析参数：--flag VALUE 与布尔 --flag；其余为位置参数。 */
function parseArgs(argv: string[]): ParsedArgs {
  const flags: FlagMap = new Map()
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json' || arg === '--follow') {
      flags.set(arg.slice(2), true)
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 缺少参数值`)
      flags.set(name, value)
      i++
    } else {
      positionals.push(arg)
    }
  }
  return { flags, positionals }
}

/** 控制面 URL：--url > DSH_CHAMBER_URL > 默认。 */
function resolveUrl(flags: FlagMap): string {
  return String(flags.get('url') || process.env.DSH_CHAMBER_URL || DEFAULT_URL).replace(/\/+$/, '')
}

/** REST 请求：返回解析后的 JSON 体。 */
async function request<T = unknown>(method: string, path: string, { url, body }: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    throw new Error(`无法访问控制面（${url}）：${err instanceof Error ? err.message : '网络错误'}`)
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    // 非 JSON 响应（如 500 纯文本），按状态码兜底
  }
  if (!res.ok) {
    // Unified error shape (design 04 D1): {error: string, code?: string}.
    const errorBody = data as ApiErrorBody | null
    const code = errorBody?.code
    const message = errorBody?.error || errorBody?.message
    throw new ApiRequestError(
      res.status,
      typeof code === 'string' ? code : null,
      data,
      `请求失败 ${res.status} ${path}${code ? `（${code}）` : ''}${message ? `：${message}` : ''}`
    )
  }
  return data as T
}

/** 对齐的人读表格（utf8 按字符数估算宽度）。 */
function printTable(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>) {
  const all = [headers, ...rows]
  const widths = headers.map((_, c) => Math.max(...all.map(r => String(r[c] ?? '').length)))
  for (const row of all) {
    console.log(
      row.map((cell, c) => String(cell ?? '').padEnd(widths[c])).join('  ').trimEnd()
    )
  }
}

/** 表格兜底：任意对象/数组 → 键值对表格。 */
function printKeyValue(data: unknown) {
  const entries = Array.isArray(data)
    ? data.map((item, i) => [`[${i}]`, JSON.stringify(item)])
    : Object.entries(data ?? {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
  printTable(['项目', '值'], entries)
}

async function serveCommand({ flags }: ParsedArgs) {
  const port = flags.has('port') ? Number(flags.get('port')) : DEFAULT_CONTROL_PLANE_PORT
  if (flags.has('port') && !Number.isInteger(port)) {
    throw new Error(`--port 必须是整数（收到 ${JSON.stringify(flags.get('port'))}）`)
  }
  const stateDirArg = flags.get('state-dir')
  const stateDir = typeof stateDirArg === 'string' ? stateDirArg : undefined
  const dshPathArg = flags.get('dsh-path')
  const dshWorkspacePath = typeof dshPathArg === 'string' ? dshPathArg : undefined
  const logger = {
    log: (...args: unknown[]) => console.log('[control-plane]', ...args),
    warn: (...args: unknown[]) => console.warn('[control-plane]', ...args),
    error: (...args: unknown[]) => console.error('[control-plane]', ...args),
  }
  const plane = createControlPlane({ port, stateDir, dshWorkspacePath, logger })
  let exiting = false
  async function shutdown(signal: string, code: number) {
    if (exiting) return
    exiting = true
    logger.log(`received ${signal}, stopping`)
    try {
      await plane.stop()
    } finally {
      process.exit(code)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT', 130))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
  try {
    await plane.start()
  } catch (error) {
    logger.error(`failed to start: ${String(error)}`)
    process.exit(1)
  }
}

async function statusCommand({ flags }: ParsedArgs) {
  const url = resolveUrl(flags)
  const health = await request<HealthResponse>('GET', '/health', { url })
  let connections: ConnectionsResponse | null = null
  try {
    connections = await request<ConnectionsResponse>('GET', '/api/connections', { url })
  } catch (error) {
    // 从未创建过 local 连接行时控制面答 404（connection_not_found）——如实呈现为空。
    if (asApiError(error)?.status !== 404) throw error
  }
  if (flags.has('json')) {
    console.log(JSON.stringify({ health, connections }, null, 2))
    return
  }
  printTable(['项目', '值'], [
    ['控制面', health?.ok === true ? 'ok' : 'error'],
    ['dsh 状态', health?.dsh?.status ?? 'unknown'],
    ['连接数', connections?.connection != null ? '1' : '0'],
  ])
}

async function connectionsListCommand(flags: FlagMap) {
  const url = resolveUrl(flags)
  let data: ConnectionsResponse
  try {
    data = await request<ConnectionsResponse>('GET', '/api/connections', { url })
  } catch (error) {
    if (asApiError(error)?.status === 404) {
      if (flags.has('json')) {
        console.log(JSON.stringify({ connection: null }, null, 2))
        return
      }
      console.log('（无连接行：尚未创建 local 连接）')
      return
    }
    throw error
  }
  if (flags.has('json')) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  const row = data?.connection
  if (row === null || row === undefined) {
    console.log('（无连接行：尚未创建 local 连接）')
    return
  }
  printTable(
    ['连接ID', '状态', 'dsh 端口', '标签'],
    [[row.id, row.status ?? '', String(row.dshPort ?? ''), row.label ?? '']]
  )
}

async function connectionsAddCommand(flags: FlagMap) {
  const kind = flags.get('kind')
  if (typeof kind !== 'string' || kind === '') throw new Error('connections add 需要 --kind local')
  const url = resolveUrl(flags)
  const data = await request<{ connection: ConnectionRow | null; spawned?: boolean }>(
    'POST', '/api/connections', { url, body: { kind } }
  )
  if (flags.has('json')) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  printKeyValue({
    connectionId: data?.connection?.id ?? 'local',
    status: data?.connection?.status ?? 'unknown',
    spawned: data?.spawned ?? false,
  })
}

/** PATCH /api/connections/local（04 §3.2）：仅 label / accentColor。 */
async function connectionsRenameCommand(flags: FlagMap) {
  const label = flags.get('label')
  const accentColor = flags.get('accent-color')
  const body: { label?: string; accentColor?: string } = {}
  if (typeof label === 'string' && label !== '') body.label = label
  if (typeof accentColor === 'string' && accentColor !== '') body.accentColor = accentColor
  if (body.label === undefined && body.accentColor === undefined) {
    throw new Error('connections rename 需要 --label L 或 --accent-color C')
  }
  const url = resolveUrl(flags)
  const data = await request<ConnectionsResponse>('PATCH', '/api/connections/local', { url, body })
  if (flags.has('json')) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  printKeyValue(data?.connection ?? {})
}

/** DELETE /api/connections/local（04 §3.2）：优雅停止 local 实例。 */
async function connectionsRemoveCommand(flags: FlagMap) {
  const url = resolveUrl(flags)
  let data: { stopped?: boolean }
  try {
    data = await request<{ stopped?: boolean }>('DELETE', '/api/connections/local', { url })
  } catch (error) {
    const apiError = asApiError(error)
    if (apiError?.status === 409 && apiError.code === 'connection_busy') {
      throw new Error('连接正在重启中（409 connection_busy），请稍后重试')
    }
    throw error
  }
  if (flags.has('json')) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  console.log(data?.stopped === true ? '已停止 local 连接' : '停止失败：控制面未确认停止')
}

/** GET /health 的 dsh 子面（宿主状态/端口/错误）。 */
async function hostStatusCommand(flags: FlagMap) {
  const url = resolveUrl(flags)
  const health = await request<HealthResponse>('GET', '/health', { url })
  if (flags.has('json')) {
    console.log(JSON.stringify(health, null, 2))
    return
  }
  printTable(['项目', '值'], [
    ['控制面', health?.ok === true ? 'ok' : 'error'],
    ['dsh 状态', health?.dsh?.status ?? 'unknown'],
    ['dsh 端口', String(health?.dsh?.port ?? '')],
    ['错误', health?.dsh?.error ?? ''],
  ])
}

const LOG_FOLLOW_INTERVAL_MS = 2000

/** GET /api/host/logs（{lines:[{ts,stream,line}]}）；--follow 每 2s 轮询追加。 */
async function hostLogsCommand(flags: FlagMap) {
  const limit = flags.has('limit') ? Number(flags.get('limit')) : 100
  if (!Number.isInteger(limit) || limit < 1) throw new Error('host logs --limit 需要正整数')
  const url = resolveUrl(flags)
  const json = flags.has('json')
  async function fetchLogs(): Promise<HostLogsResult> {
    try {
      return await request<HostLogsResult>('GET', `/api/host/logs?limit=${limit}`, { url })
    } catch (error) {
      if (asApiError(error)?.status === 404) throw new Error('宿主日志端点不可用（GET /api/host/logs 未实现）')
      throw error
    }
  }
  function printLines(lines: LogLine[]) {
    for (const entry of lines) {
      if (json) {
        console.log(JSON.stringify(entry))
      } else {
        console.log(`[${new Date(entry?.ts).toISOString()}] [${entry?.stream ?? '?'}] ${entry?.line ?? ''}`)
      }
    }
  }
  if (!flags.has('follow')) {
    const data = await fetchLogs()
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    const lines = Array.isArray(data?.lines) ? data.lines : null
    if (lines === null) throw new Error('宿主日志响应形状未知（期望 {lines:[{ts,stream,line}]}）')
    printLines(lines)
    return
  }
  let previousKeys: string[] = []
  for (;;) {
    const data = await fetchLogs()
    const lines = Array.isArray(data?.lines) ? data.lines : []
    const followed = followNewLines(lines, previousKeys)
    printLines(followed.newLines)
    previousKeys = followed.nextKeys
    await new Promise(resolve => setTimeout(resolve, LOG_FOLLOW_INTERVAL_MS))
  }
}

async function main(argv: string[]) {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    usage()
    return
  }
  if (command === 'serve') return serveCommand(parseArgs(rest))
  if (command === 'status') return statusCommand(parseArgs(rest))
  if (command === 'connections') {
    const { flags, positionals } = parseArgs(rest)
    if (positionals[0] === 'list') return connectionsListCommand(flags)
    if (positionals[0] === 'add') return connectionsAddCommand(flags)
    if (positionals[0] === 'rename') return connectionsRenameCommand(flags)
    if (positionals[0] === 'remove') return connectionsRemoveCommand(flags)
    throw new Error('用法: dsh-chamber connections list | connections add --kind local | connections rename --label L | connections remove')
  }
  if (command === 'host') {
    const { flags, positionals } = parseArgs(rest)
    if (positionals[0] === 'status') return hostStatusCommand(flags)
    if (positionals[0] === 'logs') return hostLogsCommand(flags)
    throw new Error('用法: dsh-chamber host status | host logs [--limit N] [--follow]')
  }
  throw new Error(`未知命令 ${JSON.stringify(command)}（--help 查看用法）`)
}

try {
  await main(process.argv.slice(2))
} catch (err) {
  console.error(`dsh-chamber: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
