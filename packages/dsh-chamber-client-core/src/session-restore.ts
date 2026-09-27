/**
 * I-1 恢复面（官方 `workspace/unarchiveSession`）的事实通道：wire 成功后，本页记录的归档
 * 墓碑必须同拍清除（完整契约见 session-echo.ts 的 `removePendingArchive`），且生产端的
 * purge 墓碑不得把这次归档集收缩误当 purge 完成（purged-tracker.ts 的 `release`）。
 *
 * WHY 独立通道：事实形状与 chamberBridge 的 sessionCreated/sessionRemoved 同构
 * （sourceId + sessionId），但 aggregate-store.ts / instance-api.ts 都在 god-file 棘轮里
 * （只降不升、当前零余量）——恢复是加性能力，不该靠挤占预算落地。通道原语复用
 * aggregate-store 的 `createChannel`（同一订阅快照与错误隔离语义）。
 *
 * 发布者 = session-mutations.ts 的 `unarchiveSessionForSource`（wire 成功之后）；
 * 订阅者 = renderer App（清墓碑）+ 侧栏生产者（释放 purge 墓碑）。
 */
import { assertSingletonModule } from './singleton.ts'
import { createChannel } from './aggregate-store.ts'

assertSingletonModule('session-restore')

/** 一次成功的官方单条恢复（`workspace/unarchiveSession`，幂等）。 */
export interface SessionRestoredFact {
  sourceId: string
  sessionId: string
}

type SessionRestoredListener = (fact: SessionRestoredFact) => void

const sessionRestoredChannel = createChannel<Parameters<SessionRestoredListener>>(
  () => '[dsh-chamber] session-restored listener threw',
)

/** 发布恢复事实（仅 wire 成功后调用；订阅者抛错由通道隔离，不影响发布方）。 */
export function reportSessionRestored(fact: SessionRestoredFact): void {
  sessionRestoredChannel.emit(fact)
}

/** 订阅恢复事实；返回退订。 */
export function onSessionRestored(listener: SessionRestoredListener): () => void {
  return sessionRestoredChannel.subscribe(listener)
}
