import { InstanceRpcError } from './instance-rpc-error.ts'

export interface DecodedWorkspaceCreate {
  workspaceId: string
  path: string
  created: boolean
}

/** Correlate workspace.create before a lifecycle saga consumes ownership facts. */
export function decodeWorkspaceCreateValue(value: any, requestedPath: string): DecodedWorkspaceCreate {
  const workspaceId = value?.workspace?.workspaceId
  const workspacePath = value?.workspace?.path
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new InstanceRpcError('invalid-response', 'workspace.create 未返回 workspace id')
  }
  if (typeof workspacePath !== 'string' || workspacePath === '') {
    throw new InstanceRpcError('invalid-response', 'workspace.create 未返回 workspace path')
  }
  if (workspacePath !== requestedPath) {
    throw new InstanceRpcError('invalid-response', 'workspace.create 返回了不同的 workspace path', {
      expectedPath: requestedPath,
      actualPath: workspacePath,
    })
  }
  if (typeof value?.created !== 'boolean') {
    throw new InstanceRpcError('invalid-response', 'workspace.create 未返回 created 布尔值')
  }
  return { workspaceId, path: workspacePath, created: value.created }
}

/** A caller-supplied session id is an idempotency identity, not a suggestion. */
export function decodeSessionCreateValue(value: any, expectedSessionId?: string): string {
  const publishedSessionId = value?.sessionId
  if (typeof publishedSessionId !== 'string' || publishedSessionId === '') {
    throw new InstanceRpcError('invalid-response', 'session.create 未返回会话 id')
  }
  if (expectedSessionId !== undefined && publishedSessionId !== expectedSessionId) {
    throw new InstanceRpcError('invalid-response', 'session.create 返回了不同的预分配会话 id', {
      expectedSessionId,
      actualSessionId: publishedSessionId,
    })
  }
  return publishedSessionId
}

export function decodeWorkspaceDeleteValue(value: any): void {
  if (value?.deleted !== true) {
    throw new InstanceRpcError('invalid-response', 'workspace.delete 未确认删除完成')
  }
}
