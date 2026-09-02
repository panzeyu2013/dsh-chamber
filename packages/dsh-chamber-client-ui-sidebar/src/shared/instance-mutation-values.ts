import { InstanceRpcError } from './instance-rpc-error.ts'

export interface DecodedWorkspaceCreate {
  workspaceId: string
  path: string
  created: boolean
}

/**
 * Correlate workspace.create before a lifecycle saga consumes ownership facts.
 *
 * NOTE (2026): the returned `path` is the host's CANONICAL path — the
 * workspace registry canonicalizes every path through `fs.realpath`
 * (`dsh-workspace` paths.ts), while the browser-side directory picker hands
 * string-joined paths that may traverse symlinks (e.g. a picked directory
 * under a symlinked parent). The OFFICIAL client never compares the returned
 * path, and an exact-equality check here made every symlinked pick fail with
 * a false `invalid-response` although the host DID create the workspace —
 * and the retry stayed hard-blocked (the reused existing workspace keeps
 * returning its canonical path). Structural validation only: the returned
 * row must carry a non-empty workspace id and path plus the created boolean.
 */
export function decodeWorkspaceCreateValue(value: any): DecodedWorkspaceCreate {
  const workspaceId = value?.workspace?.workspaceId
  const workspacePath = value?.workspace?.path
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new InstanceRpcError('invalid-response', 'workspace.create 未返回 workspace id')
  }
  if (typeof workspacePath !== 'string' || workspacePath === '') {
    throw new InstanceRpcError('invalid-response', 'workspace.create 未返回 workspace path')
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
