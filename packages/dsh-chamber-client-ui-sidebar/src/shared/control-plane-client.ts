/**
 * Shared control-plane REST client (design 04 §3 / 05 §3.1, B2 convergence):
 * the browser half of the management REST surface — /health,
 * /api/connections (local), /api/host/logs — consumed by BOTH the renderer
 * App layer (packages/renderer/src/api.ts) and the connections settings
 * plugin (packages/dsh-chamber-client-ui-settings-connections control-plane.ts).
 * The two former copies had drifted (health port nullability, request
 * options, credentials); the wire contract here mirrors
 * packages/control-plane/src/api.ts (04 §3 verbatim) and is the single
 * frontend source.
 *
 * PURE BROWSER implementation on purpose: this module also ships inside the
 * settings plugin bundles, which execute in the renderer page — no Node
 * imports, no Node globals. Every value is non-secret: tunnel URLs and SSH
 * material never cross this module.
 *
 * The page's own origin is authoritative: the shell itself is served by the
 * control plane, so REST and SSE must not wait for the asynchronous preload
 * bridge before learning a dev/overridden port. The injected URL and fixed
 * default remain fallbacks for non-page harnesses only.
 */

/** 统一错误形状（design 04 D1：{error, code?}）+ HTTP 状态 + 响应体 + 限流提示。 */
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

/** 控制面 loopback 默认端口（B1-fe 前端单源；桌面 dev 可用 `DSH_CHAMBER_CP_PORT` 覆盖）。 */
export const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:17500'

/**
 * The window.dshChamber page bridge slot this module reads (structural
 * subset of the renderer's authoritative global.d.ts DshChamberBridge —
 * self-contained so the sidebar package needs no renderer import).
 */
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
    // 非 JSON 响应（如 500 纯文本），下面按状态码兜底
  }

  if (!res.ok) {
    // Unified error shape (design 04 D1): {error: string, code?: string}.
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

/* ---- 控制面 REST 契约响应形状（04 §3；与 control-plane api.ts 对齐） ---- */

/** GET /health → {ok, dsh:{status, port, error?}}（04 §3.1；port 0 = 未就绪）。 */
export interface HealthResponse {
  ok: boolean
  dsh: { status: string; port: number; error?: string | null }
}

/** /api/connections 行的 wire 形状（04 §3.2；控制面为权威）。 */
export interface ConnectionRowWire {
  id: string
  label?: string
  accentColor?: string
  status: string
  dshPort?: number
  error?: string
}

/** Connection row public projection（04 §3.2：kind:'local' 恒为本地行）。 */
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

/** 一行主机滚动日志（04 §3.3）。 */
export interface HostLogLine {
  ts: number
  stream: 'stdout' | 'stderr'
  line: string
}

/** GET /api/host/logs 响应（04 §3.3）。 */
export interface HostLogsResponse {
  port: number
  lines: HostLogLine[]
  truncated: boolean
}
