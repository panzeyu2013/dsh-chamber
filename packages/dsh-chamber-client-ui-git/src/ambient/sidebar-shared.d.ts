/**
 * Narrow typecheck mirror of the sidebar's neutral shared face. Runtime Vite
 * resolves the real module; this path keeps the Git package's standalone
 * program from compiling the whole sibling package under its local ambients.
 */
export interface ChamberServerAggregate {
  id: string
  connected: boolean
  runtime?: { current?: string }
}

export const chamberBridge: {
  getServers(): ChamberServerAggregate[]
  subscribe(listener: () => void): () => void
  requestOpenSession(sourceId: string, sessionId: string): void
  requestRefresh(sourceId: string): void
}

export class InstanceRpcError extends Error {
  readonly code: string
  readonly details: unknown
}

export function getInstanceClient(instanceId: string): unknown
export function createWorkspace(client: unknown, path: string): Promise<{ workspaceId: string; path: string; created: boolean }>
export function createSession(client: unknown, workspaceId: string, sessionId?: string): Promise<string>
export function deleteWorkspace(client: unknown, workspaceId: string): Promise<void>
