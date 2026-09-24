/**
 * Renderer REST client, narrowed to health + connections (local); the settings-connections
 * plugin owns its own control-plane client.
 * The transport + wire-contract shapes are the SINGLE shared copy in the chamber sidebar
 * package (shared/control-plane-client.ts): this module and that plugin both consume it, so
 * the two cannot drift apart. This module keeps the App-facing `api` object and re-exports
 * the shared types/functions unchanged (App.tsx's import surface stays as-is).
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
} from '@dsh-chamber/dsh-chamber-client-core'

/** 统一错误形状 {error, code?} + HTTP 状态 + 响应体 + 限流提示。 */
export type { ApiError, ApiErrorBody }

export type { ConnectionSummary, HealthResponse }

/** App 与各组件唯一的数据入口，映射控制面 REST 面；组件不得直接调用 fetch。 */
export const api = {
  host: {
    /** GET /health → {ok, dsh:{status, port, error?}} */
    health: (): Promise<HealthResponse> => request('/health'),
    /** GET /api/host/health-events: SSE push channel — snapshot on connect, then every machine transition. */
    healthEvents: (): EventSource => new EventSource(controlPlaneUrl() + '/api/host/health-events'),
  },
  connections: {
    /** GET /api/connections → {connection}；无连接行 404 → 空数组 */
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
      const row = body?.connection
      // 契约破缺（2xx 但没有连接行）绝不折成伪造的 {id:'local', status:'starting'}——那让调用方
      // 以为本地实例已在启动。按本文件既有方式抛 ApiError；status=200 = HTTP 成功但响应体违约。
      if (row === undefined || row === null) {
        const error = new Error('connections.createLocal: response carried no connection row') as ApiError
        error.status = 200
        error.body = null
        throw error
      }
      return toConnectionSummary(row)
    },
    /** DELETE /api/connections/<id> → {stopped:true}（本面上只有 local 行） */
    remove: (connectionId: string): Promise<{ stopped: boolean }> =>
      request(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),
  },
}

export default api
