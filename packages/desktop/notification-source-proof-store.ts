/**
 * Durable source-proof roster: the <userData> file seam plus the two healthy
 * flush points. Kept out of shell-core.ts (god-file budget) while the proof
 * singleton lives there so every registry projection shares one instance.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SourceProofStoreSeam } from './notifications.ts'
import { describeUnknownError } from './deep-link.ts'
import { notificationSourceProofs, projectNotificationSourceInstances, syncNotificationSourceRegistry } from './shell-core.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

/** <userData>/notification-source-proofs.json（design 19 §3.6：跨宿主重启存活、传输身份编辑轮换；只存 identity 摘要）。 */
function notificationSourceProofsFilePath(userData: string): string {
  return path.join(userData, 'notification-source-proofs.json')
}

/** 与回执同纪律（0600、临时文件 + rename 原子替换）；读失败=空名册（一次轮换），写失败只告警。 */
function notificationSourceProofsSeam(file: string): SourceProofStoreSeam {
  return {
    load: () => {
      try { return readFileSync(file, 'utf8') } catch { return null }
    },
    save: (text) => {
      const temporary = file + '.tmp'
      try {
        writeFileSync(temporary, text, { mode: 0o600 })
        renameSync(temporary, file)
      } catch (error) {
        console.warn('[dsh-chamber] 来源证明持久化失败（保留 dirty，下一个提交点重试）:', describeUnknownError(error))
        throw error
      }
    },
  }
}

/**
 * 启动装配：先 attach 再首次 sync；degraded/缺行 roster 不是删除 proof 的权威
 * （retainMissing），且不落盘——避免把空/子集名册写成权威。
 */
export function initializeNotificationSourceRegistry(
  sm: { loadFailure(): string | null; registryIncomplete(): boolean; listInstances(): readonly TransportInstanceSpec[] },
  userData: string,
): void {
  notificationSourceProofs.attach(notificationSourceProofsSeam(notificationSourceProofsFilePath(userData)))
  const unhealthy = sm.loadFailure() !== null || sm.registryIncomplete()
  syncNotificationSourceRegistry(
    projectNotificationSourceInstances(sm.listInstances(), { retainMissing: unhealthy }),
    { retainMissing: unhealthy },
  )
  if (!unhealthy) notificationSourceProofs.persist()
}

/** committed transition 的落盘点（health 由提交语义保证）。 */
export function persistNotificationSourceProofs(): void {
  notificationSourceProofs.persist()
}
