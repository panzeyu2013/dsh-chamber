/**
 * Local declaration for the chamber sidebar package's shared control-plane
 * REST client face (packages/dsh-chamber-client-ui-sidebar/src/shared/
 * control-plane-client.ts, design 04 §3 / 05 §3.1 — B2 convergence): the
 * connections plugin consumes the shared client through
 * `@dsh-chamber/dsh-client-ui-sidebar/shared`. Resolved via tsconfig paths —
 * the sidebar package's own sources are never compiled here (settings-bridge
 * pattern); at runtime the renderer's vite shared chunk keeps one instance.
 *
 * MIRROR WARNING: this face mirrors the REAL control-plane-client.ts exports
 * this package imports. If the real client's exports change, this declaration
 * and control-plane.ts MUST be updated together.
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

/** 控制面 loopback 默认端口（B1-fe 前端单源）。 */
export const DEFAULT_CONTROL_PLANE_URL: string

export function controlPlaneUrl(): string

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export function request<T = unknown>(path: string, options?: RequestOptions): Promise<T>

export function post<T = unknown>(path: string, body: unknown): Promise<T>

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

export function toConnectionSummary(row: ConnectionRowWire): ConnectionSummary

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
