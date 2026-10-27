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
import {
  attemptCommittedRegistryPush, computeRemovedInstanceIds, computeRetiredInstanceIds,
  type TransportManager,
} from './transport-manager.ts'
import { setGatewaySyncRegistration } from './gateway-sync-registry.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

export interface RegistryTransitionDeps {
  sm: Pick<TransportManager, 'status'>
  edges: {
    mainWindowAlive(): boolean
    rendererPush(channel: string, payload: unknown): boolean
    retireNotificationsForSources(sources: ReadonlySet<string>): void
  }
  logTag: string
  operationalFingerprint: (instance: TransportInstanceSpec) => string
  readySeedEdges: { forget(id: string): void }
  hostPackageSeeding: { revoke(id: string): void }
  startAutomaticHostSeed: (id: string) => void
}

export function createRegistryTransition(deps: RegistryTransitionDeps) {
  const { sm, edges, logTag, operationalFingerprint, readySeedEdges, hostPackageSeeding, startAutomaticHostSeed } = deps
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

    const removedIds = computeRemovedInstanceIds(before, after)
    // Manual gateway-sync re-entry dies with the instance：removed 行绝不保留后续还能同步的注册。
    for (const id of removedIds) {
      setGatewaySyncRegistration(id, null)
    }
    const retiredIds = computeRetiredInstanceIds(before, after)
    const afterById = new Map(after.map(instance => [instance.id, instance]))
    const reseedIds: string[] = []
    for (const previous of before) {
      const current = afterById.get(previous.id)
      if (current === undefined || operationalFingerprint(previous) !== operationalFingerprint(current)) {
        readySeedEdges.forget(previous.id)
        hostPackageSeeding.revoke(previous.id)
        // service/home 编辑后仍是 dsh+ssh 目标的同 id 替换 → 若已完成即显式 reseed（普通重连由 ready 边缘拾取）。
        if (current?.kind === 'dsh' && current.transport === 'ssh') reseedIds.push(previous.id)
      }
    }

    const retiredNotificationSources = new Set(syncNotificationSourceRegistry(projected))
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
