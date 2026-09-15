/**
 * Shared fixture builders for the split derive suite (test/session-rows/):
 * SessionRow / WorkspaceRow / InstanceSnapshot factories and the
 * ChamberServerAggregate server-stub used by the ordering tests.
 */

import type { ChamberServerAggregate } from '../../src/shared/aggregate-store.ts'
import type { InstanceSnapshot, SessionRow, WorkspaceRow } from '../../src/shared/instance-api.ts'

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

export function snapshot(workspaces: WorkspaceRow[], sessions: SessionRow[]): InstanceSnapshot {
  return { workspaces, sessions, archivedSessionIds: [] }
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
