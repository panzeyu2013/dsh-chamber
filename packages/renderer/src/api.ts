/**
 * Renderer REST client — narrowed to the design 05 §3.1 surface:
 * health, connections (local). Auth/audit routes were removed
 * with the control-plane auth removal (v1 consolidation); everything else
 * (sessions/projects/interactions/SSE/config/… passthrough, and the host
 * logs REST surface — the settings-connections plugin owns its own
 * control-plane client) was deleted with the thin-shell chat UI.
 *
 * The transport + wire-contract shapes are the SINGLE shared copy in the
 * chamber sidebar package (shared/control-plane-client.ts, design 04 §3 /
 * 05 §3.1 — B2 convergence): the App layer here and the connections
 * plugin's control-plane client both consume it, so the two former copies
 * can never drift again. This module keeps the App-facing `api` object and
 * re-exports the shared types/functions unchanged (App.tsx's import surface
 * stays as-is).
 */
import {
  controlPlaneUrl,
  post,
  request,
  toConnectionSummary,
  type ApiError,
  type ApiErrorBody,
  type ConnectionRowWire,
  type ConnectionSummary,
  type HealthResponse,
} from '@dsh-chamber/dsh-client-ui-sidebar/shared'

/** 统一错误形状（design 04 D1：{error, code?}）+ HTTP 状态 + 响应体 + 限流提示。 */
export type { ApiError, ApiErrorBody }

export { controlPlaneUrl }

export type { ConnectionSummary, HealthResponse }

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
        return row === undefined || row === null ? [] : [toConnectionSummary(row)]
      } catch (err) {
        if ((err as ApiError)?.status === 404) return []
        throw err
      }
    },
    /** POST /api/connections {kind:'local'} → {connection, spawned}（幂等启动） */
    createLocal: async (): Promise<ConnectionSummary> => {
      const body = await post<{ connection?: ConnectionRowWire }>('/api/connections', { kind: 'local' })
      return toConnectionSummary(body?.connection ?? { id: 'local', status: 'starting' })
    },
    /** DELETE /api/connections/<id> → {stopped:true}（04 §3.2；本面上只有 local 行） */
    remove: (connectionId: string): Promise<{ stopped: boolean }> =>
      request(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),
  },
}

export default api
