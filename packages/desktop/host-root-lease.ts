/**
 * host-root-lease.ts —— <userData> host-root 租约（R2 plan §3.6 L2；design 25 §6.3）。
 *
 * 两个正交层级（不合并，可同时持有）：
 *   L1 app 实例锁 = <userData>/.dsh-chamber.lock（chamber-lock.ts 的 O_EXLOCK /
 *      Swift 壳 flock；内核仲裁、随进程死亡释放；只挡同一 userData 的两个 flavor
 *      兄弟）；
 *   L2 根写者租约 = <userData>/owner.json（本模块；跨平台 O_EXCL + rename 认领 +
 *      token/inode，挡**任何**声明同一 userData 的进程，含被显式指向 userData 的
 *      gateway/standalone）。
 *
 * 取租约时机：desktop main 在 acquireChamberLock 成功后（main.ts），Swift sidecar
 * 在 boot() 首段（sidecar-entry.ts）——都早于任何 runtime 元数据写入与
 * buildHeadlessCtx 装配。state 根（<userData>/state）的租约是另一个文件、另一个
 * scope，由 createControlPlane 构造期自取（ControlPlaneOptions.stateLease 缺省
 * 路径），严格早于 plane.start() 的 reaper。
 *
 * 失败诊断（sidecar stderr 契约 / desktop 对话框共用）：code + root 路径 +
 * holder pid/flavor + 操作提示；调用方 fail-closed 退出，绝不继续装配。
 */
import {
  StateRootLeaseError,
  acquireStateRootLease,
  type StateRootLease,
} from './control-plane-module.ts'
import { describeError } from './describe-error.ts'

/** desktop / Swift sidecar 两个宿主 flavor（租约记录的诊断字段）。 */
export type HostRootLeaseFlavor = 'desktop' | 'sidecar'

/**
 * 取 <userData> host-root 租约（scope host-root，flavor 区分记录写者）。
 * 失败 fail-closed（StateRootLeaseError / 广根普通 Error）；绝不返回无租约的
 * handle。
 */
export function acquireHostRootLease(userDataDir: string, flavor: HostRootLeaseFlavor): StateRootLease {
  return acquireStateRootLease(userDataDir, { scope: 'host-root', flavor })
}

/** holder 的 pid/flavor 诊断后缀（记录可缺 flavor —— legacy/撕裂认领）。 */
function holderSuffix(holder: { pid: number; flavor: string | null } | null): string {
  if (holder === null) return ''
  return '（pid=' + String(holder.pid) + (holder.flavor === null ? '' : '，flavor=' + holder.flavor) + '）'
}

/**
 * 任意 state 根租约错误的诊断文本：code + root 路径 + holder pid/flavor
 * （sidecar stderr 的机器可读前缀 = code 字面量）。非租约错误返回 null，
 * 调用方回落到自己的错误格式化。
 */
export function describeStateRootLeaseError(error: unknown): string | null {
  if (!(error instanceof StateRootLeaseError)) return null
  return error.code + '：' + error.stateRoot + holderSuffix(error.holder) + '（' + error.message + '）'
}

/**
 * host-root 获取失败的完整诊断行。state_root_locked（活属主）附带操作提示
 * 「另一写者占用该 userData，停掉它或换路径」；其余码（duplicate / unreadable /
 * takeover_race）同样带 root 路径与 holder 诊断，原样 loud。
 */
export function describeHostRootLeaseFailure(error: unknown): string {
  const detail = describeStateRootLeaseError(error)
  if (detail === null) return 'host-root 租约获取失败：' + describeError(error)
  const hint = error instanceof StateRootLeaseError && error.code === 'state_root_locked'
    ? '；另一写者占用该 userData，停掉它或换路径'
    : ''
  return detail + hint
}
