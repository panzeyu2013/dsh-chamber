/**
 * Shared control-plane REST client: the browser half of the management REST
 * surface (/health, /api/connections, /api/host/logs), consumed by BOTH the
 * renderer App layer and the connections settings plugin. The wire contract
 * mirrors packages/control-plane/src/api.ts and is the single frontend source.
 *
 * PURE BROWSER on purpose: it also ships inside settings-plugin bundles that
 * execute in the renderer page — no Node imports or globals. Every value is
 * non-secret (tunnel URLs and SSH material never cross this module); the page's
 * own origin is authoritative, and the injected URL / fixed default are
 * fallbacks for non-page harnesses only（桌面 dev 可用 `DSH_CHAMBER_CP_PORT` 覆盖）。
 */

import { isPageChannelKeepaliveItem, subscribePageChannel, type PageChannelSubscription } from './page-channel.ts'

/** 统一错误形状 {error, code?} + HTTP 状态 + 响应体 + 限流提示。 */
export interface ApiErrorBody {
  error?: string
  code?: string
  message?: string
}

export interface ApiError extends Error {
  status?: number
  body?: ApiErrorBody | null
  retryAfter?: number
}

/** 控制面 loopback 默认端口（前端单源；桌面 dev 可用 `DSH_CHAMBER_CP_PORT` 覆盖）。 */
const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:17500'

/** The window.dshChamber box this module reads (structural subset of the renderer's DshChamberBridge, so the sidebar needs no renderer import). */
interface ControlPlaneBridgeSlot {
  dshChamber?: { controlPlaneUrl?: string | null }
}

export function controlPlaneUrl(): string {
  const pageOrigin = window.location?.origin
  const injected = (window as ControlPlaneBridgeSlot).dshChamber?.controlPlaneUrl
  return String(pageOrigin || injected || DEFAULT_CONTROL_PLANE_URL).replace(/\/+$/, '')
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = controlPlaneUrl() + path
  const headers = { ...(options.headers || {}) }
  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  let res: Response
  try {
    res = await fetch(url, { ...options, headers, credentials: 'include' })
  } catch (err) {
    throw new Error(`无法访问控制面（${url}）：${err instanceof Error ? err.message : '网络错误'}`)
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // 非 JSON 响应（如 500 纯文本），按状态码兜底
  }

  if (!res.ok) {
    // Unified error shape {error, code?} (control-plane api.ts).
    const body = data as ApiErrorBody | null
    const code = body?.code
    const message = body?.error || body?.message
    const error = new Error(
      `请求失败 ${res.status} ${path}${code ? `（${code}）` : ''}${message ? `：${message}` : ''}`
    ) as ApiError
    error.status = res.status
    error.body = body
    const retryAfter = Number(res.headers.get('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter
    throw error
  }

  return data as T
}

export function post<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}


/** GET /health → {ok, dsh:{status, port, error?}}（port 0 = 未就绪）。 */
export interface HealthResponse {
  ok: boolean
  dsh: { status: string; port: number; error?: string | null }
}

/** host 健康流的页面通道句柄（design 26）：与消费者原本用的 EventSource 三件套同形——
 *  `onmessage`/`onerror` 可赋值（初始 null），`close()` 只关闭本订阅且可重复调用。 */
export interface HealthEventsHandle {
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  close(): void
}

/**
 * 订阅 host 健康流（design 26）：控制面原生 health 生产者经页面通道承载——连接即快照，
 * 随后每次机器状态迁移；通道断开只触发 `onerror`（调用方据此做一次性 /health 回退），
 * 本订阅由通道自己重连并重订阅，调用方不排自己的重连阶梯。
 *
 * 这是 App 与设置页**唯一**的一份实现：两边曾各包一层同形句柄、各写一个诊断前缀，
 * 而本模块（共享控制面客户端）正是该面的单源所在，漂移面必须只剩这里一处。
 */
export function subscribeHostHealth(): HealthEventsHandle {
  let subscription: PageChannelSubscription | undefined
  const handle: HealthEventsHandle = {
    onmessage: null,
    onerror: null,
    // 订阅句柄自身的 close 已幂等（重复调用是 no-op），这里不再维护关闭位。
    close: () => { subscription?.close() },
  }
  subscription = subscribePageChannel({
    family: 'health',
    // keepalive item 只是上游活性（data 为空），不是状态帧：在这里挡住，消费方不必
    // 靠 JSON.parse('') 抛错来兜底，也不必知道通道的保活词汇。
    onItem: (event, data) => {
      if (isPageChannelKeepaliveItem(event, data)) return
      handle.onmessage?.({ data })
    },
    // 不传 onOpen：host 的（重）订阅从快照帧重新开始（控制面在 ready 之后立即发当前快照），
    // 调用方无需补拉。
    onError: (_code, _message) => { handle.onerror?.() },
    onDiagnostic: message => { console.warn('[renderer] page-channel health: ' + message) },
  })
  return handle
}

/** `GET /api/connections/local/writers` 的 wire 形状：本地实例为何起不来。`sticky` 表示闩锁被「写入期终止失败」关死（扫描无法再证明），只能重启应用恢复。 */
export interface LocalWriterBlockerWire {
  name: string
  status: 'reclaimed' | 'kept' | 'removed'
  pid: number | null
  reason: string
  takeOverAvailable: boolean
}

export interface LocalWriterDiagnosisWire {
  quiescent: boolean
  writers: LocalWriterBlockerWire[]
  errors: string[]
}

/** 规范化诊断响应：只保留 blocking（kept）条目并把缺字段补成安全默认；不提供该路由的
 *  控制面让调用方拿到 null，页面就不渲染该块。 */
export function toLocalWriterDiagnosis(wire: unknown): LocalWriterDiagnosisWire | null {
  if (wire === null || typeof wire !== 'object') return null
  const raw = wire as { quiescent?: unknown; writers?: unknown; errors?: unknown }
  if (typeof raw.quiescent !== 'boolean' || !Array.isArray(raw.writers)) return null
  const writers = raw.writers.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return []
    const row = entry as Partial<LocalWriterBlockerWire>
    if (typeof row.reason !== 'string') return []
    return [{
      name: typeof row.name === 'string' ? row.name : '—',
      status: row.status === 'reclaimed' || row.status === 'removed' ? row.status : 'kept',
      pid: typeof row.pid === 'number' ? row.pid : null,
      reason: row.reason,
      takeOverAvailable: row.takeOverAvailable === true,
    } satisfies LocalWriterBlockerWire]
  })
  return {
    quiescent: raw.quiescent,
    writers,
    errors: Array.isArray(raw.errors) ? raw.errors.filter((line): line is string => typeof line === 'string') : [],
  }
}

/** /api/connections 行的 wire 形状（控制面为权威）。 */
export interface ConnectionRowWire {
  id: string
  label?: string
  accentColor?: string
  status: string
  dshPort?: number
  error?: string
}

/** Connection row public projection（kind:'local' 恒为本地行）。 */
export interface ConnectionSummary {
  connectionId: string
  kind: 'local'
  label?: string
  accentColor?: string
  status: string
  dshPort?: number | null
  error?: string
}

/** wire 行 → 摘要（kind 恒为 'local'；connectionId 即行 id）。 */
export function toConnectionSummary(row: ConnectionRowWire): ConnectionSummary {
  const summary: ConnectionSummary = { connectionId: row.id, kind: 'local', status: row.status }
  if (typeof row.label === 'string' && row.label !== '') summary.label = row.label
  if (typeof row.accentColor === 'string' && row.accentColor !== '') summary.accentColor = row.accentColor
  if (typeof row.dshPort === 'number' && row.dshPort > 0) summary.dshPort = row.dshPort
  if (typeof row.error === 'string' && row.error !== '') summary.error = row.error
  return summary
}

export interface HostLogLine {
  ts: number
  stream: 'stdout' | 'stderr'
  line: string
}

/** GET /api/host/logs 响应。 */
export interface HostLogsResponse {
  port: number
  lines: HostLogLine[]
  truncated: boolean
}
