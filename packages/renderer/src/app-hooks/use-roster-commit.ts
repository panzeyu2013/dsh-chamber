/**
 * 远程 roster 提交簇：一次 roster 刷新 = 一个逻辑快照对（先 health，再 instances_get），
 * 决策在纯规划器 host/roster-commit.ts，执行顺序在这里落地——retire → activate/reincarnate →
 * install → settle → live → remount → refreshStatus。App 只保留接线。
 *
 * 换代真值落"完整快照提交期"（推送只作提示）：规划输入是壳记录的启动传输字（shell.ts 的
 * bootTransports）与权威行传输字的比较，所以推送丢失也不会漏换代，迟到响应由 refreshSeq 丢弃。
 *
 * 世代纪律：refreshSeq 在两次 await 后各校验一次；instances-changed 推送先 invalidateRemoteRoster
 * （seq+1 + rosterGate.invalidate）再重拉，因此两次读取之间不可能换代表，迟到的旧响应在任一
 * await 后返回 false。
 */
import { useCallback } from 'react'
import { reincarnate, type SourceRegistry } from '@dsh-chamber/dsh-stream-state'
import type { SourceOwnershipRegistry } from '../deep-link-activation.ts'
import type { SshInstanceSpec, SshInstancesHealth } from '../global.d.ts'
import type { RemotesStore } from '../host/remotes-store.ts'
import { planRosterCommit, type RosterCommitPlan } from '../host/roster-commit.ts'
import type { RosterGate } from '../host/roster-gate.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { bootTransportOf } from '../shell.ts'
import { sourceIdForInstance } from '../transport-source.ts'
import {
  healthProbeUnavailableDiagnostic, rosterIncompleteDiagnostic,
  type HealthProbeUnavailableKind,
} from './use-bridge-subscriptions.ts'

/** 提交执行端：App 的同步副作用全部经这些显式入口，hook 不直接读写 App 的 ref。 */
export interface RosterCommitSinks {
  /** 同步退役实体（owner + 壳 + 账本/outbox/facts 观察者），与推送退役共用同一实体。 */
  retireSources: (sourceIds: ReadonlySet<string>) => void
  /** owner registry 的 activate（同指纹幂等；退役后 = 新化身）。 */
  activateSource: (sourceId: string, fingerprint: string) => void
  /** 生命周期账本的 reincarnate（同指纹幂等；换代 = epoch+1）。 */
  reincarnateSource: (sourceId: string, fingerprint: string) => void
  /** remotesStore.setInstances（partial 无变化时收到的是 prior 数组引用）。 */
  installInstances: (instances: SshInstanceSpec[]) => void
  /** rosterGate.settle（仅权威快照调用）。 */
  settleRoster: () => void
  /** liveServerIdsRef.current = 权威集合（仅权威快照调用）。 */
  setLive: (sourceIds: Set<string>) => void
  /** 窄重挂一个 live 来源的壳（换容器冷 boot；不触 durable 账本/owner/facts）。 */
  remountShell: (sourceId: string) => void
  /** 安装行的隧道状态刷新。 */
  refreshStatus: (instance: SshInstanceSpec, sourceId: string) => void
}

/**
 * 执行一次提交计划。顺序即契约：退役先于任何 replacement 激活（退役删 owner，随后 activate 才
 * mint 新化身，同一来源只退役一次）；activate/reincarnate 先于安装，安装行到达 deriveServers 时
 * 身份已就位；只有完整快照允许 settle、替换 live 与窄换代，且换代排在 install/live 之后——新行
 * 的 transport 必须先到位，重挂的新壳才会按权威行冷 boot。degraded 计划不落地（返回 false）。
 */
export function commitRosterPlan(plan: RosterCommitPlan, sinks: RosterCommitSinks): boolean {
  if (plan.mode === 'degraded') return false
  sinks.retireSources(plan.retire)
  // local 不进规划器：本地来源恒活跃，同指纹重新登记是幂等的。
  sinks.activateSource(LOCAL_INSTANCE_ID, 'local')
  sinks.reincarnateSource(LOCAL_INSTANCE_ID, 'local')
  for (const { sourceId, fingerprint } of plan.activate) {
    sinks.activateSource(sourceId, fingerprint)
    sinks.reincarnateSource(sourceId, fingerprint)
  }
  sinks.installInstances(plan.instances)
  if (plan.settle) sinks.settleRoster()
  if (plan.mode === 'complete') {
    sinks.setLive(plan.live)
    // 先 install 后 remount 是硬顺序：重挂 sink 只对 live 来源生效，且新壳读已安装行的
    // transport。规划器保证 partial/degraded 的 remount 恒空、退役优先，这里再加一次模式门。
    for (const { sourceId } of plan.remount) sinks.remountShell(sourceId)
  }
  for (const { instance, sourceId } of plan.refreshStatus) sinks.refreshStatus(instance, sourceId)
  return true
}

/**
 * 提交期读数：快照里的每个来源 → 该壳（或在飞 boot）的启动传输字。壳只可能挂在权威行上
 * （挂载门控在 live），所以按快照行遍历即可；无绑定的行不进表（未挂载来源将来按当前行冷 boot，
 * 天然正确）。这也是 bootTransportOf 的生产消费点：换代判定是"当前绑定 vs 权威行"的函数，
 * 推送只触发重拉、不承载换代真值。
 */
function readBootTransports(instances: readonly SshInstanceSpec[]): ReadonlyMap<string, string> {
  const bootTransports = new Map<string, string>()
  for (const instance of instances) {
    const sourceId = sourceIdForInstance(instance)
    const transport = bootTransportOf(sourceId)
    if (transport !== null) bootTransports.set(sourceId, transport)
  }
  return bootTransports
}

export interface RosterCommitInputs {
  remotesStore: RemotesStore
  rosterGate: RosterGate
  /** 最近一次开始的 roster 拉取代际（推送先 invalidate 再重拉）。 */
  remoteRosterRefreshSeqRef: { current: number }
  /** 命令式权威 live 集合（只有完整快照提交替换它）。 */
  liveServerIdsRef: { current: Set<string> }
  /** 当前来源的 owner registry（身份权威；partial 保留其已确认指纹）。 */
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
  /** 每来源生命周期账本（reincarnate 的写入目标）。 */
  sourceLedgerStoreRef: { current: SourceRegistry }
  refreshRemoteStatus: (id: string, expectedSourceId?: string) => Promise<void>
  /** 同步退役实体（App 的 retireSources：owner/壳/账本/outbox/facts 观察者同拍收敛）。 */
  retireSources: (sourceIds: ReadonlySet<string>) => void
  /** 窄重挂执行端（App 的 remountSourceShell：只换壳，绝不触 durable 账本/owner/facts）。 */
  remountShell: (sourceId: string) => void
  setRegistryDegraded: (value: boolean) => void
  registryDegradedWarnedRef: { current: string | null }
  setRosterIncomplete: (value: boolean) => void
  rosterIncompleteWarnedRef: { current: string | null }
  healthUnavailableWarnedRef: { current: string | null }
}

/** 一次 roster 刷新的稳定入口（依赖列表保持旧 refreshRemotes 语义）。 */
export function useRosterCommit(inputs: RosterCommitInputs): () => Promise<boolean> {
  const {
    remotesStore, rosterGate, remoteRosterRefreshSeqRef, liveServerIdsRef,
    sourceLifecyclesRef, sourceLedgerStoreRef, refreshRemoteStatus, retireSources, remountShell,
    setRegistryDegraded, registryDegradedWarnedRef, setRosterIncomplete,
    rosterIncompleteWarnedRef, healthUnavailableWarnedRef,
  } = inputs

  /** F16/A4 健康探针不可用的 warn-once（按诊断文案去重）：缺失/抛错都不是「健康」，
   *  refreshRemotes 保持 fail-closed（不安装 roster、不置结算位）。 */
  const warnHealthProbeUnavailable = useCallback((kind: HealthProbeUnavailableKind): void => {
    const diagnostic = healthProbeUnavailableDiagnostic(kind)
    if (healthUnavailableWarnedRef.current === diagnostic) return
    healthUnavailableWarnedRef.current = diagnostic
    console.warn(`[renderer] ${diagnostic}; the remote roster is NOT installed or settled (fail-closed)`)
  }, [healthUnavailableWarnedRef])

  const refreshRemotes = useCallback(async (): Promise<boolean> => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) {
      // 无桥形态的收敛不在这里放行：本分支可能被可见性补偿在**桥迟到窗口**内提前调用
      // （desktopSsh 尚未 expose ≠ 无桥），置结算位会把远端 durable 键当退役来源剪掉。
      // 无桥收敛由 500ms 探测预算得出的 bridgeVerdict='absent' 在 durable 剪枝门完成；
      // 本函数保持「有桥才拉取」语义。
      return false
    }
    const seq = remoteRosterRefreshSeqRef.current + 1
    remoteRosterRefreshSeqRef.current = seq
    // F16/A4：健康探针不可用 ≠ 健康。旧桥/旧 shim 没有 desktopSsh.instances_health，探针
    // invoke 也可能抛错（IPC/sidecar 不可达）。两种形态都保持 fail-closed（不安装 roster、
    // 不置结算位），warn-once 明确 'health unavailable'，绝不静默折叠成健康。
    if (typeof ssh.instances_health !== 'function') {
      warnHealthProbeUnavailable('missing-method')
      return false
    }
    let health: SshInstancesHealth
    try {
      health = await ssh.instances_health()
    } catch {
      warnHealthProbeUnavailable('invoke-failed')
      return false
    }
    if (remoteRosterRefreshSeqRef.current !== seq) return false
    try {
      // 注册表健康位先于 roster 读取（F13）：加载降级时空 roster 不是权威——不安装、不结算
      // （保持「有桥但未结算」，剪枝门恒关），warn 一次；健康恢复后走原有结算路径。
      if (health.degraded === true) {
        const reason = health.reason ?? 'registry load failed'
        if (registryDegradedWarnedRef.current !== reason) {
          registryDegradedWarnedRef.current = reason
          console.warn(
            `[renderer] SSH instance registry is degraded (${reason}); the empty roster is NOT authoritative — durable notification state is retained until the registry is rebuilt`,
          )
        }
        setRegistryDegraded(true)
        return false
      }
      setRegistryDegraded(false)
      // V5-A 行级丢弃：load 成功但 drop 了行时磁盘有内容而 roster 只是子集。合法行照常**安装**
      // （连接不能不可见），但只走 partial 提交：不退役、不覆盖已确认身份、不结算，durable
      // 剪枝门由 rosterIncomplete 关死（与 degraded 同档）。
      const incomplete = health.rosterIncomplete === true
      if (incomplete) {
        const diagnostic = rosterIncompleteDiagnostic(health.droppedCount ?? 0)
        if (rosterIncompleteWarnedRef.current !== diagnostic) {
          rosterIncompleteWarnedRef.current = diagnostic
          console.warn(
            `[renderer] SSH instance registry roster is incomplete (${diagnostic}); confirmed rows/identities are retained and durable notification state is kept until the roster is complete`,
          )
        }
      }
      setRosterIncomplete(incomplete)
      const instances = await ssh.instances_get()
      if (remoteRosterRefreshSeqRef.current !== seq) return false
      const lifecycle = sourceLifecyclesRef.current!
      const plan = planRosterCommit({
        health: { degraded: false, rosterIncomplete: incomplete },
        instances,
        priorInstances: remotesStore.getSnapshot().instances,
        live: liveServerIdsRef.current,
        fingerprints: lifecycle.fingerprints(),
        bootTransports: readBootTransports(instances),
      })
      return commitRosterPlan(plan, {
        retireSources,
        activateSource: (sourceId, fingerprint) => { lifecycle.activate(sourceId, fingerprint) },
        reincarnateSource: (sourceId, fingerprint) => {
          sourceLedgerStoreRef.current = reincarnate(sourceLedgerStoreRef.current, { sourceId, fingerprint })
        },
        installInstances: rows => { remotesStore.setInstances(rows) },
        settleRoster: () => { rosterGate.settle() },
        setLive: sourceIds => { liveServerIdsRef.current = sourceIds },
        remountShell,
        refreshStatus: (instance, sourceId) => { void refreshRemoteStatus(instance.id, sourceId) },
      })
    } catch {
      // 桌面 SSH 面不可达时保持现状；首次权威结果前 settled 仍为 false，deep-link intent 继续 held，由快速重试/30s 轮询再拉。
      return false
    }
  }, [refreshRemoteStatus, retireSources, remountShell, warnHealthProbeUnavailable])

  return refreshRemotes
}
