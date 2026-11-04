/**
 * Projection publish (design 05): archive filters (a projection INPUT), the two
 * per-source projection caches, the derived server projection and its chamberBridge
 * publication. Extracted verbatim from App.tsx; the input types are derived from
 * deriveServers itself, so the hook cannot drift from the projection it feeds.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { deriveServers } from '../host/servers.ts'
import { usePublishServerProjection, useServerProjectionCaches } from './use-server-projection-publish.ts'
import { getViewPrefs, subscribeViewPrefs, type ArchivedFilter } from '@dsh-chamber/dsh-chamber-client-core'
import { getWorkspaceGitFlagsVersion, subscribeWorkspaceGitFlags } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'

type DeriveArgs = Parameters<typeof deriveServers>

export interface ProjectionPublishInputs {
  health: DeriveArgs[0]
  connections: DeriveArgs[1]
  remoteInstances: DeriveArgs[2]
  remoteStatus: DeriveArgs[3]
  aggregates: DeriveArgs[4]
  hostFacts: DeriveArgs[5]
  runtimeFacts: DeriveArgs[6]
  correctionArms: DeriveArgs[7]
  paintedView: DeriveArgs[8]
  pluginDiagnostics: DeriveArgs[9]
  shellStates: DeriveArgs[10]
  managedRuntime: DeriveArgs[11]
  echoes: {
    workspace: DeriveArgs[12]
    session: DeriveArgs[13]
    archive: DeriveArgs[14]
    placement: DeriveArgs[19]
    removal: DeriveArgs[21]
  }
  openIntents: DeriveArgs[15]
  locale: DeriveArgs[16]
  sessionFacts: DeriveArgs[17]
}

export function useProjectionPublish(inputs: ProjectionPublishInputs) {
  const {
    health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts,
    correctionArms, paintedView, pluginDiagnostics, shellStates, managedRuntime, echoes,
    openIntents, locale, sessionFacts,
  } = inputs  // 归档筛选（per-source 视图选项）是**投影输入**：三态决定归档行是否进入导航列表。
  // 只订阅"筛选映射的签名"——其他 view-prefs 写（折叠/排序活动簿记）不会触发 App 级
  // 重渲染；签名不变时 useSyncExternalStore 直接 bail out。
  const archivedFilterSignature = useSyncExternalStore(
    subscribeViewPrefs,
    () => JSON.stringify(getViewPrefs().archivedFilter ?? {}),
    () => JSON.stringify(getViewPrefs().archivedFilter ?? {}),
  )
  const archivedFilters = useMemo(
    () => JSON.parse(archivedFilterSignature) as Record<string, ArchivedFilter>,
    [archivedFilterSignature],
  )
  // Git 布局通道（design 08 §3.2-§3.3）：客户端 Git 插件每轮 snapshot 发布每来源的
  // RepoGitLayout（worktree 不是 workspace，所以这条通道独立于 aggregates）。派生
  // checkout 行只由它出现/消失；没有这条订阅，外部创建（forge/agent/seed）要等下一次
  // 无关 poll 才成行。版本进 derive 的 memo 键与发布闸；逐来源布局在 deriveServers 读 store。
  const gitFlagsVersion = useSyncExternalStore(
    subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion,
  )

  // chamberBridge 投影：health/remoteStatus/aggregates 任一变化后派生并发布；首帧（health 未就绪）即发布 connected=false 的分组。
  // 两个缓存（按来源投影 + 签名片段）在本 hook 内建，随 App 生命周期常驻。
  const projectionCaches = useServerProjectionCaches()
  const servers = useMemo(
    // current 投影（侧栏高亮）跟随 **paintedView**（屏上是谁），不是选择——持有窗内用户点向 B 时
    // 屏上仍是 A，摘掉再装回 A 的高亮是纯闪烁；揭示完成那一拍 painted 变化自然交棒给 B。
    () => deriveServers(health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, correctionArms, paintedView, pluginDiagnostics, shellStates, managedRuntime, echoes.workspace, echoes.session, echoes.archive, openIntents, locale, sessionFacts, projectionCaches.servers, echoes.placement, archivedFilters, echoes.removal, gitFlagsVersion),
    [health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, correctionArms, paintedView, pluginDiagnostics, shellStates, managedRuntime, echoes, openIntents, locale, sessionFacts, projectionCaches, archivedFilters, gitFlagsVersion],
  )
  // chamberBridge publish 签名闸（等值不发布；签名与缓存见 app-hooks/use-server-projection-publish.ts）。
  // 闸里同时含 git 布局版本：布局推进时即使内容签名巧合未变，也必须走一次发布流程
  // （订阅侧仍按内容签名去重，不会因此多渲染）。
  usePublishServerProjection(servers, projectionCaches, gitFlagsVersion)
  return { servers }
}
