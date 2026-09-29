/**
 * Shared fixture builders for the split derive suite (test/session-rows/):
 * SessionRow / WorkspaceRow / InstanceSnapshot factories and the
 * ChamberServerAggregate server-stub used by the ordering tests.
 */

import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { InstanceSnapshot, SessionRow, WorkspaceRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'

export function session(
  id: string,
  updatedAt = 0,
  extra: Partial<Pick<SessionRow, 'blank' | 'origin' | 'title' | 'displayTitle' | 'running' | 'parentSessionId' | 'cwd'>> = {},
): SessionRow {
  return { sessionId: id, updatedAt, running: false, blank: false, ...extra }
}

export function workspace(workspaceId: string, title: string, sessionIds: string[] = []): WorkspaceRow {
  return {
    workspaceId,
    path: `/${workspaceId}`,
    title,
    sessionIds,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

/**
 * 默认取**挂载生产者的形状**（两个置顶键都在场、集合为空 = 真无置顶）：老宿主形状
 * （键缺席 = 未知集）在磁盘上已经不可达，把它当默认会让整套 derive 测试跑在一条
 * 不存在的路径上；需要未知集的用例显式传 `pinSetKnown: false`。
 */
export function snapshot(
  workspaces: WorkspaceRow[],
  sessions: SessionRow[],
  pin: { pinnedSessionIds?: string[]; pinSetKnown?: boolean } = { pinnedSessionIds: [], pinSetKnown: true },
): InstanceSnapshot {
  return { workspaces, sessions, archivedSessionIds: [], ...pin }
}

export function server(id: string, overrides: Partial<ChamberServerAggregate> = {}): ChamberServerAggregate {
  return {
    id,
    sourceFingerprint: id === 'local' ? 'local' : 'a'.repeat(64),
    kind: id === 'local' ? 'local' : 'dsh',
    transport: id === 'local' ? 'local' : 'ssh',
    label: id,
    connected: true,
    phase: 'ready',
    workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 1 }] }],
    updatedAt: 0,
    ...overrides,
  }
}
