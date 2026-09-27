import { InstanceRpcError } from './instance-rpc-error.ts'

export interface DecodedWorkspaceCreate {
  workspaceId: string
  path: string
  created: boolean
}

/**
 * Correlate workspace.create before a lifecycle saga consumes ownership facts. `path` is the
 * host's CANONICAL path (`fs.realpath` in the workspace registry), while the browser picker
 * hands string-joined paths that may traverse symlinks. Never compare them for equality: a
 * symlinked pick would fail with a false `invalid-response` although the host created the
 * workspace, and the retry would stay hard-blocked. Structural validation only — non-empty id
 * and path plus the created boolean.
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

/** One active item of an archive-admission family (upstream SessionActivityItem). */
export interface SessionArchiveActivityItem {
  /** Family-specific identity: a session id, a job id or a schedule id. */
  readonly id: string
  /** Display label when the family carries one (a job label, a subagent label). */
  readonly label?: string
}

/**
 * One reason the archived session still counts as active (the
 * `workspace/session-active` refusal details, upstream SessionActivity).
 * `items` is normalized to a list: the wire omits it for families without
 * per-item identity (`turn`), the dialog always reads a list.
 */
export interface SessionArchiveActivity {
  readonly kind: string
  readonly items: readonly SessionArchiveActivityItem[]
}

/** Hostile-value caps: an absurd list is refused (raw error shown), never rendered. */
const MAX_ARCHIVE_ACTIVITY = 64
const MAX_ARCHIVE_ACTIVITY_ITEMS = 4096
const MAX_ARCHIVE_ACTIVITY_KIND = 64
const MAX_ARCHIVE_ACTIVITY_STRING = 512

function boundedArchiveString(value: unknown, cap: number): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= cap ? value : undefined
}

/**
 * Decode the `activity` a `workspace/session-active` refusal reported into
 * display rows. All-or-nothing: the dialog's promise is "this is what will be
 * stopped", so a malformed family — or one over the hostile-value caps —
 * returns undefined and the caller keeps the raw refusal instead of showing a
 * partial (misleading) list. `kind` stays an open bounded string: upstream's
 * `SessionActivityKindMap` is extended by provider packages, so an unknown
 * family is rendered by the generic line, not rejected here.
 */
export function decodeSessionArchiveActivity(details: unknown): readonly SessionArchiveActivity[] | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const raw = (details as { activity?: unknown }).activity
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ARCHIVE_ACTIVITY) return undefined
  const activity: SessionArchiveActivity[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const kind = boundedArchiveString((entry as { kind?: unknown }).kind, MAX_ARCHIVE_ACTIVITY_KIND)
    if (kind === undefined) return undefined
    const rawItems = (entry as { items?: unknown }).items
    if (rawItems === undefined) {
      activity.push({ kind, items: [] })
      continue
    }
    if (!Array.isArray(rawItems) || rawItems.length > MAX_ARCHIVE_ACTIVITY_ITEMS) return undefined
    const items: SessionArchiveActivityItem[] = []
    for (const item of rawItems) {
      if (typeof item !== 'object' || item === null) return undefined
      const id = boundedArchiveString((item as { id?: unknown }).id, MAX_ARCHIVE_ACTIVITY_STRING)
      if (id === undefined) return undefined
      const label = (item as { label?: unknown }).label
      if (label === undefined) {
        items.push({ id })
        continue
      }
      const boundedLabel = boundedArchiveString(label, MAX_ARCHIVE_ACTIVITY_STRING)
      if (boundedLabel === undefined) return undefined
      items.push({ id, label: boundedLabel })
    }
    activity.push({ kind, items })
  }
  return activity
}

/**
 * The activity an official `workspace/session-active` archive refusal reported,
 * or undefined for any other failure (and for a refusal whose details do not
 * decode). One wrapper so no caller reaches into `InstanceRpcError.details`:
 * the confirmation lists exactly what the host said would stop, and a malformed
 * report falls back to the raw error instead of a partial list.
 */
export function sessionArchiveRefusal(error: unknown): readonly SessionArchiveActivity[] | undefined {
  if (!(error instanceof InstanceRpcError) || error.code !== 'workspace/session-active') return undefined
  return decodeSessionArchiveActivity(error.details)
}
