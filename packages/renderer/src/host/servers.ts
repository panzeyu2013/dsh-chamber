/**
 * The chamberBridge source projection: raw per-source facts (health, roster,
 * transport phases, aggregates, facts snapshots, echo ledgers) → the
 * ChamberServerAggregate rows the sidebar renders. Pure and framework-free
 * (no React, no DOM): the App wires inputs and states; every ordering rule
 * lives here.
 */
import {
  deriveArchivedSessions,
  deriveServerWorkspaces,
  managedRuntimeDown,
  mergeRuntimeFacts,
  projectableCurrent,
  SOURCE_PHASE_UNKNOWN,
  withPendingArchives,
  withSessionEcho,
  withWorkspaceEcho,
  type ChamberServerAggregate,
  type InstanceAggregate,
  type InstanceRuntimeReport,
  type PluginGraphDiagnostic,
  type RuntimeFactsOverlay,
  type SessionArchiveLedger,
  type SessionEchoLedger,
  type WorkspaceEchoLedger,
} from '@dsh-chamber/dsh-chamber-client-core'
import type { ConnectionSummary, HealthResponse } from '../api.ts'
import { type SessionFactsSnapshot } from '../session-facts-source.ts'
import { sourceSessionFactsMode } from '../session-facts-mode.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { type ShellState } from '../shell.ts'
import { frameText, type FrameLocale } from '../locales.ts'
import { toServerBootGap } from '../boot-gap.ts'
import type { SshInstanceSpec, SshStatusProjection, TransportKind } from '../global.d.ts'
import { instanceConnected, sourceIdForInstance } from '../transport-source.ts'

/**
 * 轮询状态 → chamberBridge 投影（design 05）：local + 每个注册表远程实例一条。
 * connected 只看权威状态（本地 /health dsh；远程隧道 phase）；workspaces
 * 只在对应聚合 state==='ok' 时派生（否则空数组，不显示陈旧数据）；拉取
 * 失败时把错误文本带上 aggregateError（UI 区分「拉取失败」与「无工作区」）。
 */

/** Per-source dsh version fact: the LOCAL instance comes from the desktop
 *  bridge (`window.dshChamber.dshVersion`); remote instances stay absent
 *  until a remote version probe is wired (host.describe is not available). */
export type HostFacts = { dshVersion?: string }

/**
 * facts 行 → 侧栏渲染字段 overlay：
 * 只过**渲染字段**（pending / runningSubagents），判定字段（updatedAt /
 * completedAt / lastTurnEnd）刻意不过桥（derive.ts 的反 churn 纪律）。
 * 只有 verdict ok 且 serviceable 的未读事实才参与——forward-skew / 停机 /
 * legacy 一律返回 undefined，回到 channel-only（不静默假装有事实）。
 */
function factsOverlay(snapshot: SessionFactsSnapshot | undefined): RuntimeFactsOverlay | undefined {
  if (snapshot === undefined || snapshot.verdict !== 'ok' || snapshot.serviceable === false) return undefined
  const overlay: Record<string, { pending?: 'approval' | 'plan-review' | 'question'; runningSubagents?: number; factAt?: number }> = {}
  for (const row of Object.values(snapshot.rows)) {
    const pending = row.pendingKind === 'approval'
      ? 'approval' as const
      : row.pendingKind === 'question' ? 'question' as const : undefined
    // I5：factAt 也是渲染字段（这一行有多新），因此只带它的行同样要过桥。
    if (pending === undefined && row.subagentCount <= 0 && !(row.factAt > 0)) continue
    overlay[row.sessionId] = {
      ...(pending !== undefined ? { pending } : {}),
      ...(row.subagentCount > 0 ? { runningSubagents: row.subagentCount } : {}),
      ...(row.factAt > 0 ? { factAt: row.factAt } : {}),
    }
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined
}

export function deriveServers(
  health: HealthResponse | null,
  connections: ConnectionSummary[] | null,
  remoteInstances: SshInstanceSpec[],
  remoteStatus: Record<string, SshStatusProjection>,
  aggregates: Record<string, InstanceAggregate>,
  hostFacts: Record<string, HostFacts | undefined>,
  runtimeFacts: Record<string, InstanceRuntimeReport | undefined>,
  completedBySource: Record<string, Record<string, boolean>>,
  activeViewId: string,
  pluginDiagnostics: Record<string, PluginGraphDiagnostic | undefined>,
  // 降级事实要过投影给侧栏来源行与连接页，
  // 所以 shellStates 与 pluginDiagnostics 一样是 derive 的输入——只读
  // `degraded`，失败态（error）不进这条投影。
  shellStates: Record<string, ShellState | undefined>,
  managedRuntime: Record<string, string | null>,
  workspaceEcho: WorkspaceEchoLedger,
  // 会话创建回声账本，与会话状态
  // 同一汇合点并入（见下方 withSessionEcho 的调用与 shared/session-echo.ts）。
  sessionEcho: SessionEchoLedger,
  // 它必须最先施加——归档会
  // 把同一 id 的会话回声行一并藏掉（即使那条回声还没退休）。
  sessionArchive: SessionArchiveLedger,
  openIntents: Readonly<Record<string, string>>,
  // The local source's fallback label is
  // frame copy (the connection row may carry no label), so it comes from the
  // frame's dictionary in the locale the frame renders in.
  locale: FrameLocale,
  // overlay 的来源；判定输入不过桥，见 factsOverlay。刻意追加在参数表末尾：
  // 既有接线锁按 completedBySource/paintedView/pluginDiagnostics 的文本锚点
  // 钉 current 投影（veil-layering-invariants.test.ts），不重排既有参数。
  sessionFacts: Record<string, SessionFactsSnapshot | undefined>,
): ChamberServerAggregate[] {
  const servers: ChamberServerAggregate[] = []
  const now = Date.now()
  const push = (
    kind: ChamberServerAggregate['kind'],
    transport: ChamberServerAggregate['transport'],
    id: string,
    label: string,
    sourceFingerprint: string,
    rawId?: string,
    statusKind?: TransportKind,
  ): void => {
    const statusKey = kind === 'local' ? id : (rawId ?? id)
    const transportPhase = kind === 'local'
      ? (health?.dsh?.status ?? 'unknown')
      : (remoteStatus[statusKey]?.phase ?? SOURCE_PHASE_UNKNOWN)
    // gateway 形态的 ready 只证明 gateway 进程活着
    // （desktop 的就绪探针读的就是 `/chamber/runtime/status`），托管 dsh 是
    // 独立进程。把它的 connectionState 投影进该源——phase 走侧栏既有的状态点
    // （status.stopped/error/restartExhausted 文案已存在），终态停机时
    // connected=false 让动作入口按既有语义禁用而不是"可点但背后不可用"。
    // 探针缺失/未知一律 fail open（不拿缺失的探针隐藏健康来源）。
    // **只在该源的传输确实可用时**才认这条事实：`phase` 是"托管态 ∪ 传输态"的
    // 合并值，而两套词表都含 `error`——若让消费者重新分类合并后的 phase，
    // SSH/隧道失败会被误诊为"托管 dsh 停机"。
    const runtimeState = kind === 'gateway' ? managedRuntime[id] : null
    const transportUsable = kind === 'local'
      ? transportPhase === 'ready'
      : transportPhase === 'ready' || transportPhase === 'degraded'
    const managedDown = kind === 'gateway' && transportUsable && managedRuntimeDown(runtimeState)
    // 托管态的**瞬态**（starting/restarting）同样投影进 phase：此时隧道是好的、
    // 但 dsh 还没起来，绿点会撒谎。degraded 保持传输态
    // （设计 17 既有语义：degraded 仍可交互）。
    const managedTransient = kind === 'gateway' && transportUsable
      && (runtimeState === 'starting' || runtimeState === 'restarting')
    const phase = managedDown || managedTransient ? runtimeState! : transportPhase
    let workspaces: ChamberServerAggregate['workspaces'] = []
    const aggregate = aggregates[id]
    // 托管态瞬态（starting/restarting）同样不可用：dsh 还没服务，动作入口只会
    // 503（与终态停机同一理由）。phase 已携带忙碌点。
    const connected = !managedDown && !managedTransient && instanceConnected(
      kind === 'local' ? 'local' : (statusKind ?? kind),
      health,
      remoteStatus,
      statusKey,
    )
    let archivedSessions: ChamberServerAggregate['archivedSessions']
    let archiveSetKnown: ChamberServerAggregate['archiveSetKnown']
    if (connected && aggregate !== undefined && aggregate.state === 'ok') {
      // 当前会话事实只给活动来源：blank（新建未首发的）会话行只在正在查看的
      // 来源投影（design 06 全局单选纪律）——否则每个已挂载来源都会冒出它的
      // 空"新建会话"行。其他来源 blank 行照旧不进入导航列表。
      // chamber (design 05 §2.2 修订)：该来源还有在途 open、且官方运行时
      // 当前选中的**不是**用户要打开的那个会话时，不投影 current——冷 boot 期间官方
      // 初始导航策略会先给自己选中一个 blank 会话，此刻投影它就会渲染出一行高亮的
      // "新会话"，下一次分发（最多 400ms 后）又消失，正是该问题的可见形态。
      // 幂等重开（current 已经就是要打开的那个会话）不受影响：投影本就正确，
      // 为一次分发把高亮摘掉再装回去是纯闪烁、零信息。
      const current = projectableCurrent(
        activeViewId,
        id,
        runtimeFacts[id]?.current,
        openIntents[id],
      )
      // Positional contract of deriveServerWorkspaces (derive.ts): (snapshot,
      // serverId, ungroupedTitle, currentSessionId?, now?). `current` must ride
      // the currentSessionId slot so the
      // blank-row currentness branch (and the sidebar ghost-key arming on the
      // REAL source id) actually fires; the ungrouped bucket title is
      // display-only (''), overridden by the sidebar's own t('list.ungrouped').
      // chamber (design 05 §2.2 revision): the workspace-creation echo
      // rides the SAME projection pass — one choke point for every workspace
      // row (derived or echoed), so the echo needs no second copy inside the
      // aggregate. `withWorkspaceEcho` is identity-preserving for an absent or
      // empty ledger, so it adds nothing to the derive output.
      workspaces = deriveServerWorkspaces(
        // 顺序是契约：①归档墓碑先把本页刚归档的 id 并进归档集（可见性规则只认这个
        // 字段，回声行也一并被它过滤）；②工作区回声补齐可能刚建的工作区行；③会话
        // 回声再按 workspaceId/路径把新建的会话挂进那一行。三步都只做纯投影。
        withSessionEcho(
          withWorkspaceEcho(withPendingArchives(aggregate, sessionArchive[id]), workspaceEcho[id]),
          sessionEcho[id],
        ),
        id,
        '',
        current,
      )
      // Archive-manager metadata (design 24 revision): archived rows
      // of this source's snapshot ride the same aggregate; the manager UI
      // never issues its own session read. archiveSetKnown is the provenance
      // tri-state: the mounted baseline reports an authoritative set (even
      // when empty); the unary-fallback view reports NOT known — consumers
      // must never read its set as "no archived sessions" (it may be empty OR
      // the remembered authoritative set).
      archivedSessions = deriveArchivedSessions(aggregate)
      archiveSetKnown = aggregate.archiveSetKnown === true
    }
    const entry: ChamberServerAggregate = {
      id,
      sourceFingerprint,
      kind,
      transport,
      ...(rawId === undefined ? {} : { rawId }),
      label,
      connected,
      phase,
      ...(managedDown ? { managedRuntimeDown: true } : {}),
      workspaces,
      ...(archivedSessions === undefined ? {} : { archivedSessions, archiveSetKnown }),
      aggregateReady: aggregate !== undefined && aggregate.state === 'ok',
      updatedAt: now,
    }
    // 运行时事实附加闸：connected 仍是主闸，
    // 但**未读事实与 facts overlay 破例**——断连来源仍附只读事实并标
    // stale:true，消费者（todo-attention）按 stale 出「离线未读」条目；没有
    // 事实时合并结果不变（mergeRuntimeFacts 兼容锁）。
    // App 自持的完成未读点（completedBySource）与通道上报并集：蓝点以派生
    // 投影为准（deriveSourceUnread；它无视后台来源 shell 的陈旧 selected），
    // vendor 的 completed 作兜底保留。合并为纯函数 mergeRuntimeFacts（shared/
    // derive.ts，单测覆盖）。
    // 能力一览：把该来源事实的 probe 判定投影进聚合条目。无快照时
    // 保持缺席（侧栏把缺席读作未知；臆造 full 会让能力说明在未知状态下撒谎）。
    // 位置纪律：必须在 entry 字面量**之后**（否则 TDZ 直接抛）。
    const factsMode = sourceSessionFactsMode(sessionFacts[id])
    if (factsMode !== undefined) entry.sessionFacts = factsMode
    if (connected) {
      const dshVersion = hostFacts[id]?.dshVersion
      if (dshVersion !== undefined) entry.dshVersion = dshVersion
    }
    const overlay = factsOverlay(sessionFacts[id])
    const sourceLedger = completedBySource[id]
    const hasLedger = sourceLedger !== undefined && Object.values(sourceLedger).some(value => value === true)
    if (connected || hasLedger || overlay !== undefined) {
      const merged = mergeRuntimeFacts(
        runtimeFacts[id],
        sourceLedger,
        overlay,
        connected ? undefined : true,
      )
      if (merged !== undefined) entry.runtime = merged
    }
    if (aggregate !== undefined && aggregate.state === 'error') {
      // This fallback is frame-owned copy —
      // it is rendered verbatim by the sidebar's source alert and the archive
      // dialog (ServerSection.tsx role="alert", ArchiveManagerDialog.tsx), i.e.
      // it crosses the frame→plugin boundary as a finished string, so it must
      // come from the frame dictionary in the frame's locale like every other
      // audited string.
      entry.aggregateError = aggregate.error ?? frameText(locale, 'error.unknown')
    }
    if (pluginDiagnostics[id] !== undefined) entry.pluginDiagnostic = pluginDiagnostics[id]
    // Settled-boot gap：结构化事实过桥，渲染方（侧栏来源行 / 连接页）
    // 各出各的文案；生产者的诊断句子不过界。
    const bootGap = shellStates[id]?.degraded
    if (bootGap !== undefined && bootGap !== null) entry.bootGap = toServerBootGap(bootGap)
    servers.push(entry)
  }
  push('local', 'local', LOCAL_INSTANCE_ID,
    (connections ?? [])[0]?.label ?? frameText(locale, 'source.local'), 'local')
  for (const instance of remoteInstances) {
    // The persisted/runtime target kind is independent of the transport.
    // `ssh` is accepted only as the legacy spelling of a dsh target.
    const targetKind: 'dsh' | 'gateway' = instance.kind === 'gateway' ? 'gateway' : 'dsh'
    push(
      targetKind,
      instance.transport,
      sourceIdForInstance(instance),
      instance.label,
      instance.sourceFingerprint,
      instance.id,
      instance.kind,
    )
  }
  return servers
}
