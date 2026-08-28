/**
 * Renderer REST client — narrowed to the design 05 §3.1 surface:
 * health, connections (local). Auth/audit routes were removed
 * with the control-plane auth removal (v1 consolidation); everything else
 * (sessions/projects/interactions/SSE/config/… passthrough, and the host
 * logs REST surface — the settings-connections plugin owns its own
 * control-plane client) was deleted with the thin-shell chat UI.
 *
 * 统一错误形状（design 04 D1：{error, code?}）+ HTTP 状态 + 响应体 + 限流提示。
 */
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

const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:17500'

export function controlPlaneUrl() {
  const injected = window.dshChamber?.controlPlaneUrl
  return String(injected || DEFAULT_CONTROL_PLANE_URL).replace(/\/+$/, '')
}

interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
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

  let data: any = null
  try {
    data = await res.json()
  } catch {
    // 非 JSON 响应（如 500 纯文本），下面按状态码兜底
  }

  if (!res.ok) {
    // Unified error shape (design 04 D1): {error: string, code?: string}.
    const code = data?.code
    const message = data?.error || data?.message
    const error = new Error(
      `请求失败 ${res.status} ${path}${code ? `（${code}）` : ''}${message ? `：${message}` : ''}`
    ) as ApiError
    error.status = res.status
    error.body = data
    const retryAfter = Number(res.headers.get('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter
    throw error
  }

  return data as T
}

function post<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

/* ---- 控制面 REST 契约响应形状（design 05 §3.1；形状与 control-plane api.ts 对齐） ---- */

export interface HealthResponse {
  ok: boolean
  // port 0 = 未就绪（04 §3.1 契约，控制面以 0 而非 null 表达）
  dsh: { status: string; port: number; error?: string | null }
}

/** /api/connections 行的 wire 形状（04 §3.2；控制面为权威）。 */
interface ConnectionRowWire {
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

/** wire 行 → renderer 摘要（kind 恒为 'local'；connectionId 即行 id）。 */
function toSummary(row: ConnectionRowWire): ConnectionSummary {
  const summary: ConnectionSummary = { connectionId: row.id, kind: 'local', status: row.status }
  if (typeof row.label === 'string' && row.label !== '') summary.label = row.label
  if (typeof row.accentColor === 'string' && row.accentColor !== '') summary.accentColor = row.accentColor
  if (typeof row.dshPort === 'number' && row.dshPort > 0) summary.dshPort = row.dshPort
  if (typeof row.error === 'string' && row.error !== '') summary.error = row.error
  return summary
}

/**
 * RuntimeAPIs resolver：App 与各组件唯一的数据入口，域命名空间一一映射
 * 控制面 REST 面（契约见 control-plane api.ts 头注注释）。组件不得直接
 * 调用 fetch。
 */
export const api = {
  host: {
    /** GET /health → {ok, dsh:{status, port, error?}} */
    health: (): Promise<HealthResponse> => request('/health'),
    /**
     * GET /api/host/health-events (设计 05 §3): SSE push channel — current
     * snapshot on connect, then every machine transition. The local
     * instance's status never waits for a poll tick (the remote roster
     * already rides desktop pushes).
     */
    healthEvents: (): EventSource => new EventSource(controlPlaneUrl() + '/api/host/health-events'),
  },
  connections: {
    /** GET /api/connections → {connection}（04 §3.2）；无连接行 404 → 空数组 */
    list: async (): Promise<ConnectionSummary[]> => {
      try {
        const body = await request<{ connection?: ConnectionRowWire }>('/api/connections')
        const row = body?.connection
        return row === undefined || row === null ? [] : [toSummary(row)]
      } catch (err) {
        if ((err as ApiError)?.status === 404) return []
        throw err
      }
    },
    /** POST /api/connections {kind:'local'} → {connection, spawned}（幂等启动） */
    createLocal: async (): Promise<ConnectionSummary> => {
      const body = await post<{ connection?: ConnectionRowWire }>('/api/connections', { kind: 'local' })
      return toSummary(body?.connection ?? { id: 'local', status: 'starting' })
    },
    /** DELETE /api/connections/<id> → {stopped:true}（04 §3.2；本面上只有 local 行） */
    remove: (connectionId: string): Promise<{ stopped: boolean }> =>
      request(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),
  },
}

export default api
