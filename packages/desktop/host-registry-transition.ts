/**
 * Committed registry transition: rotations the source-lifecycle authority must finish
 * before a roster is published — renderer/native-notification proofs, exact plugin-seed
 * owner revocation, retried seeds and the committed lifecycle push.
 * Split out of host-assembly.ts (B4-2); every effect and clock arrives as a dependency.
 */
import { IPC_CHANNELS } from './ipc-events.ts'
import {
  projectInstanceSecrets, projectNotificationSourceInstances, syncNotificationSourceRegistry,
  type ProjectedRegistryInstance,
} from './shell-core.ts'
import { attemptCommittedRegistryPush, type TransportManager } from './transport-manager.ts'
import type { ActiveRegistrationRegistry } from './active-registration.ts'
import { computeRosterChangeSet } from './roster-change.ts'
import { persistNotificationSourceProofs } from './notification-source-proof-store.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'
export interface RegistryTransitionDeps {
  sm: Pick<TransportManager, 'status'>
  edges: {
    mainWindowAlive(): boolean
    rendererPush(channel: string, payload: unknown): boolean
    retireNotificationsForSources(sources: ReadonlySet<string>): void
  }
  logTag: string
  readySeedEdges: { forget(id: string): void }
  hostPackageSeeding: { revoke(id: string): void }
  startAutomaticHostSeed: (id: string) => void
  /** THE commit entry: removed rows revoke their live registration (idempotent). */
  registrations: Pick<ActiveRegistrationRegistry, 'commit'>
}

export function createRegistryTransition(deps: RegistryTransitionDeps) {
  const { sm, edges, logTag, readySeedEdges, hostPackageSeeding, startAutomaticHostSeed, registrations } = deps
  /**
   * Finish every committed registry transition through the source-lifecycle authority：旋转
   * renderer/native-notification 证明、撤销精确 plugin-seed owner、发布 committed roster。
   * 证明投影/代际同步/队列退役清理在 shell-core；活跃原生通知退役经
   * edges.retireNotificationsForSources。元数据/secret 持久化归事务（connection-save.ts）。
   */
  const publishRegistryTransition = (
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ): ProjectedRegistryInstance[] => {
    const projected = projectNotificationSourceInstances(after)
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return projected.map(projectInstanceSecrets)
    }
    const projectedSaved = projected.map(projectInstanceSecrets)

    // The committed diff is computed HERE (no third argument): this function already holds
    // the authoritative before/after snapshots, and the same pure change set drives the
    // registry's save consequences — one field-classification source, no second table.
    const changeSet = computeRosterChangeSet(before, after)
    const removedIds = [...changeSet.removedIds]
    // Manual gateway-sync re-entry dies with the instance：removed 行的活动注册随行撤销
    // （幂等；墓碑拒绝随后到达的同/更旧代际 register）。
    for (const id of removedIds) {
      registrations.commit({ kind: 'revoke', id, reason: 'removed' })
    }
    const retiredIds = [...changeSet.retiredIds]
    // Seed owner revocation/reseed use the change set's operationalFingerprint dimensions
    // (service/home edit of a dsh×ssh target reseeds under the same owner; removal revokes),
    // so the old inline fingerprint loop here is gone rather than duplicated.
    for (const id of changeSet.seedRevokeIds) {
      readySeedEdges.forget(id)
      hostPackageSeeding.revoke(id)
    }
    const reseedIds = changeSet.seedReseedIds

    const retiredNotificationSources = new Set(syncNotificationSourceRegistry(projected))
    persistNotificationSourceProofs()
    if (retiredNotificationSources.size > 0) {
      edges.retireNotificationsForSources(retiredNotificationSources)
    }
    // A service/home edit may complete while the transport is already ready：显式 seed 替换
    // owner（仅 ready 实例可达：startAutomaticHostSeed 经 findRemoteTarget + 单飞注册表）。
    for (const id of reseedIds) {
      if (sm.status(id)?.phase === 'ready') startAutomaticHostSeed(id)
    }

    // Committed lifecycle push（{removedIds, retiredIds} 文本被 renderer-trust 锚定；窗口门 =
    // edges.mainWindowAlive，push 前竞态复查；无窗口常驻期间由下次查询兜底）。
    if (edges.mainWindowAlive()) {
      const pushed = attemptCommittedRegistryPush(() => {
        if (!edges.mainWindowAlive()) {
          throw new Error('registry renderer changed before push')
        }
        if (!edges.rendererPush(IPC_CHANNELS.SSH_INSTANCES_CHANGED, { removedIds, retiredIds })) {
          throw new Error('registry renderer push failed')
        }
      })
      if (!pushed.sent) {
        console.warn(`${logTag} registry 已保存但 lifecycle push 失败（等待 renderer 重拉）：${pushed.error}`)
      }
    }
    return projectedSaved;
  }

  return { publishRegistryTransition }
}
