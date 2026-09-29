/**
 * Chamber dialog layers: add-workspace directory browser, per-source archive
 * manager, armed workspace-delete confirm, and the archive-active confirm the
 * host's refusal arms. One hook owns the state, the openers and the
 * single-dialog-layer predicate; one component renders the four layers.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryBrowser } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { createHostDirectory, getInstanceClient, listHostDirectory } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { archiveSessionForSource } from '@dsh-chamber/dsh-chamber-client-core/session-mutations'
import { createWorkspaceForSource, deleteWorkspaceForSource } from '@dsh-chamber/dsh-chamber-client-core/workspace-mutations'
import { getWorkspaceGitFlag } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import { ArchiveManagerDialog } from './ArchiveManagerDialog.tsx'
import { SessionArchiveConfirmDialog } from './SessionArchiveConfirmDialog.tsx'
import type { SessionArchiveConfirmRequest } from './session-archive-confirm.ts'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import type { RunActionWithOutcome } from './sidebar-root-actions.ts'
import cc from './sidebar-chamber.module.css'

/**
 * One armed workspace-delete confirmation. The subject is resolved at ARM time:
 * the row may unmount while the confirmation is up.
 */
interface WorkspaceDeleteTarget {
  sourceId: string
  workspaceId: string
  title: string
  /** The workspace's path is gone: only its registration is deleted. */
  orphaned: boolean
}

export function useSidebarDialogs({ servers, runActionWithOutcome, setRowErrors }: {
  servers: readonly ChamberServerAggregate[]
  runActionWithOutcome: RunActionWithOutcome
  setRowErrors: Dispatch<SetStateAction<Record<string, string>>>
}) {
  const [addingWorkspace, setAddingWorkspace] = useState<string | null>(null)
  const [addingWorkspaceBusy, setAddingWorkspaceBusy] = useState(false)
  // chamber (design 24): per-source ARCHIVE MANAGER dialog。列出该来源的归档会话（元数据来自
  // ChamberServerAggregate.archivedSessions，对话框自身不发会话读），经可选 sessionIds 过滤器
  // 提供逐行/多选 purge。整集删除没有独立按钮：勾选 select-all 再确认计数删除，purge 绝不覆盖
  // 对话框列不出的行；破坏性调用在对话框内确认。
  const [archiveCleanupServerId, setArchiveCleanupServerId] = useState<string | null>(null)
  // Focus restore：对话框关闭时把焦点还给打开它的 trash 按钮，否则键盘用户会落到 <body>。
  const archiveCleanupOpenerRef = useRef<HTMLElement | null>(null)

  /**
   * SYMMETRIC closure：任何时刻至多一个 chamber 拥有的 Modal 层，与用户到达顺序无关。官方
   * Modal 没有焦点陷阱（mask + 每实例一个 document 级冒泡 Escape 监听），mask 后其余 shell
   * 仍可 Tab：常驻 orphan 徽标与来源头控件都在任一 mask 之后可达。两层同开则各自注册
   * Escape，一次 Escape 关掉**两层**。
   * 唯一谓词在此，每个打开方都必须查询（只闸 delete 会漏掉反向顺序）：`onDeleteWorkspace`
   * 武装删除确认、`onOpenArchiveCleanup` 打开归档管理器、`openWorkspaceBrowser` 打开目录
   * 浏览器、`openArchiveConfirm` 武装归档活动确认。拒绝不丢功能：每层都可取消/X/mask/Escape
   * 关闭，关闭后被拒控件立即可用（归档确认的拒绝由调用方回退成原始失败上报，见 opener）。
   * 刻意用 hoisted `function`：各 opener 与下方 arm 处理器共用一条规则（函数声明提升），
   * 但它判定的是 `openLayersRef` 而不是渲染闭包里的 state：
   * `openArchiveConfirm` 在任一行级归档入口首调失败后（最长一个 unary 超时）才被调用，它所在闭包里的
   * state 早已过期——期间键盘用户可在任一 mask 后从常驻 orphan 徽标武装删除确认，或第二个会话的
   * 首调先拒绝并武装。过期闭包看到「没有别的层」就会叠出第二层（各注册一个 Escape，一次 Esc
   * 双关），或在 `setArchiveConfirm` 上静默覆盖前一个待确认目标（连同它的 pending/error 一起
   * 清掉）。因此闸门读这个同步权威：打开方在武装的同一 tick 声明，关闭方同步释放，每次提交后再
   * 由 state 对齐兜底；state 只负责渲染。
   */
  const openLayersRef = useRef({
    delete: false,
    archive: false,
    browser: false,
    sessionArchive: false,
    /** 本层已武装的会话（同步权威）：跨行换靶与"第二段在飞"两道保护都读它，绝不读过期闭包里的 state。 */
    archiveTarget: null as string | null,
    archivePending: false,
  })

  function otherChamberDialogOpen(self: 'delete' | 'archive' | 'browser' | 'sessionArchive'): boolean {
    const open = openLayersRef.current
    return (self !== 'delete' && open.delete)
      || (self !== 'archive' && open.archive)
      || (self !== 'browser' && open.browser)
      || (self !== 'sessionArchive' && open.sessionArchive)
  }

  /** 添加工作区入口（来源头的 `+`）走本 opener 而不暴露原始 setter——单层规则必须在打开处
   *  执行，而不是每个调用点。 */
  const openWorkspaceBrowser = (sourceId: string): void => {
    if (otherChamberDialogOpen('browser')) return
    openLayersRef.current.browser = true
    setAddingWorkspace(sourceId)
  }

  const onOpenArchiveCleanup = (server: ChamberServerAggregate): void => {
    // 反方向：删除确认 mask 之下仍可从来源头到达（无焦点陷阱），必须同样拒绝。
    if (otherChamberDialogOpen('archive')) return
    openLayersRef.current.archive = true
    archiveCleanupOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setArchiveCleanupServerId(server.id)
  }
  const closeArchiveCleanup = (): void => {
    openLayersRef.current.archive = false
    setArchiveCleanupServerId(null)
    // 关闭渲染提交后再聚焦（opener 可能已卸载——折叠 rail 或来源移除——focus() 此时是无害 no-op）。
    requestAnimationFrame(() => {
      archiveCleanupOpenerRef.current?.focus()
      archiveCleanupOpenerRef.current = null
    })
  }
  // 管理器只能停留在活来源之上：会话中途消失/断连即关闭（对死实例的确认会失败进虚空）；同排序菜单清理。
  useEffect(() => {
    if (archiveCleanupServerId === null) return
    const server = servers.find(candidate => candidate.id === archiveCleanupServerId)
    if (server === undefined || !server.connected) {
      setArchiveCleanupServerId(null)
    }
  }, [servers, archiveCleanupServerId])

  /**
   * 撤销事实用的 best-effort 工作区路径：投影不带 path，唯一本地来源是桥上本 ctx 的快照，
   * 必须在 wire 调用前读。未挂载来源没有也不需要：`removePendingWorkspace` 按 workspaceId 匹配回显。
   */
  const workspacePathForFact = (sourceId: string, workspaceId: string): string =>
    chamberBridge.getInstanceSnapshots()[sourceId]?.workspaces
      .find(row => row.workspaceId === workspaceId)?.path ?? ''

  /**
   * ARMED 工作区删除确认。上游以应用内 Modal 渲染（outline 取消 + outline 危险确认、描述句、
   * role="status" pending 行），绝不是无法使用 alias token 的原生 confirm。状态在 SHELL 而非
   * 每行：被删行可能在确认仍飞行时卸载。
   * nav 行在打开的 Modal mask 之后可达（orphan 徽标是 hover 簇之外的常驻可 Tab 按钮，官方
   * Modal 无焦点陷阱），键盘用户能在任一 chamber 对话框 mask 后 Tab 并武装本确认，两层随后
   * 各注册 document Escape，一次 Escape 关掉**两层**。真正的不变量因此在打开方而非 mask：
   * `otherChamberDialogOpen` 被全部四个打开方查询（含本确认与归档活动确认），任一顺序下至多一层。
   */
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceDeleteTarget | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  /** 最后一次失败删除的消息，显示在对话框内（role="alert"）；被删行卸载后行级 rowErrors
   *  已无表面——这正是 deleteTarget 放在 shell 上的原因。 */
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /** 武装时键盘焦点落在对话框内（官方 Modal 不移动焦点）；记住 opener 以便关闭时归还焦点。 */
  const deleteBodyRef = useRef<HTMLDivElement | null>(null)
  const deleteOpenerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (deleteTarget === null) return
    deleteBodyRef.current?.focus()
  }, [deleteTarget])
  /** 确认只能停留在活来源之上（同归档管理器的守卫）；但当失败消息在屏时暂停自动丢弃——
   *  因来源消失而失败的删除，其唯一可见解释（对话框内 `role="alert"`）不能被一起卸载。 */
  useEffect(() => {
    if (deleteTarget === null || deletePending || deleteError !== null) return
    const server = servers.find(candidate => candidate.id === deleteTarget.sourceId)
    if (server === undefined || !server.connected) setDeleteTarget(null)
  }, [servers, deleteTarget, deletePending, deleteError])

  /**
   * ARMED 归档活动确认：**唯一**会先问一次的归档场合——宿主以
   * `workspace/session-active` 拒绝，details 列出将被停止的工作（回合/子代理后代/
   * 后台任务/定时提醒）。任一行级归档入口在首调失败后武装它，确认才发第二调（stopActivity）。
   * 状态放在 SHELL（同删除确认）：打开它的行可能在确认仍开着时卸载/断连，行级 rowErrors
   * 已无表面。
   */
  const [archiveConfirm, setArchiveConfirm] = useState<SessionArchiveConfirmRequest | null>(null)
  const [archiveConfirmPending, setArchiveConfirmPending] = useState(false)
  const [archiveConfirmError, setArchiveConfirmError] = useState<string | null>(null)
  const archiveConfirmBodyRef = useRef<HTMLDivElement | null>(null)
  const archiveConfirmOpenerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (archiveConfirm === null) return
    archiveConfirmBodyRef.current?.focus()
  }, [archiveConfirm])
  /** 同删除确认的来源守卫：失败消息在屏时暂停自动丢弃——唯一可见解释不能被一起卸载。 */
  useEffect(() => {
    if (archiveConfirm === null || archiveConfirmPending || archiveConfirmError !== null) return
    const server = servers.find(candidate => candidate.id === archiveConfirm.sourceId)
    if (server === undefined || !server.connected) setArchiveConfirm(null)
  }, [servers, archiveConfirm, archiveConfirmPending, archiveConfirmError])

  /**
   * 每次提交后把闸门 ref 对齐 state 兜底：显式关闭方已同步释放，但来源断连的自动丢弃
   * （上面三个 effect）与任何将来的关闭路径都只改 state——没有这层对齐，漏写一次释放就会
   * 让闸门永久关闭（其余三层再也打不开）。
   */
  useEffect(() => {
    // 原地改写而不是整体替换：本兜底只对齐四个「层是否在屏」的布尔。`archiveTarget` /
    // `archivePending` 是打开方在同一 tick 声明的同步权威（见上），不由 state 派生——整体
    // 替换会把已武装的目标与在飞标记一起清成 undefined，两道保护（跨行换靶 / 第二次点击
    // 在飞）随即失效（类型上也要求补齐这两个字段）。
    const open = openLayersRef.current
    open.delete = deleteTarget !== null
    open.archive = archiveCleanupServerId !== null
    open.browser = addingWorkspace !== null
    open.sessionArchive = archiveConfirm !== null
  })

  /**
   * 行级归档入口首调失败（可解码的 session-active 拒绝）后武装。返回 false = 单层规则拒绝了这次
   * 武装（另一个 chamber 对话框在屏；或同一层已为另一个会话武装——跨行换靶）：调用方据此保留原始
   * 失败上报，绝不静默吞掉用户动作。
   */
  const openArchiveConfirm = (request: SessionArchiveConfirmRequest): boolean => {
    if (otherChamberDialogOpen('sessionArchive')) return false
    const open = openLayersRef.current
    // 跨行换靶保护：已为**另一个**会话武装时拒绝这次武装——否则后到的拒绝会静默覆盖已武装目标
    // 并清掉它的 pending/error（不同行两次点击落在同一次 unary 往返窗内即可达，远程/SSH 源常见）。
    if (open.sessionArchive && open.archiveTarget !== null && open.archiveTarget !== request.sessionId) return false
    // 同一目标、第二段在飞时同样不重武装（否则会清掉 pending 闩、放行并发的第二次 stopActivity）。
    if (open.sessionArchive && open.archiveTarget === request.sessionId && open.archivePending) return false
    // 同步声明本层：同一 tick 里的第二个拒绝（或紧随其后的其它 opener）必须看到它，
    // 而不是等下一次提交后由 state 告诉它们。
    open.sessionArchive = true
    open.archiveTarget = request.sessionId
    archiveConfirmOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 失败/在飞属于它自己的尝试：武装新目标绝不能继承上一轮的状态。
    setArchiveConfirmError(null)
    setArchiveConfirmPending(false)
    setArchiveConfirm(request)
    return true
  }

  /** 无条件关闭（确认路径已在同一批清掉 pending 标志）；连同显示过的失败一起丢弃。 */
  const dismissArchiveConfirm = (): void => {
    openLayersRef.current.sessionArchive = false
    openLayersRef.current.archiveTarget = null
    openLayersRef.current.archivePending = false
    setArchiveConfirm(null)
    setArchiveConfirmError(null)
    requestAnimationFrame(() => {
      const opener = archiveConfirmOpenerRef.current
      archiveConfirmOpenerRef.current = null
      if (opener !== null && opener.isConnected) opener.focus()
    })
  }

  const closeArchiveConfirm = (): void => {
    if (archiveConfirmPending) return
    dismissArchiveConfirm()
  }

  /**
   * 第二段：带 `stopActivity` 重发——宿主自己写归档集并让 provider 停止该会话的工作
   * （回合、子代理后代、后台任务、定时提醒），客户端不再有补偿停止腿。失败留在对话框内并
   * 保持打开（同删除确认：重新抛出以保留行级 rowErrors 上报）。
   */
  const confirmArchive = (): void => {
    const target = archiveConfirm
    if (target === null || archiveConfirmPending) return
    setArchiveConfirmPending(true)
    setArchiveConfirmError(null)
    openLayersRef.current.archivePending = true
    void runActionWithOutcome(`${target.sourceId}/${'session'}/${target.sessionId}/archive`, async () => {
      try {
        await archiveSessionForSource(target.sourceId, target.sessionId, { stopActivity: true })
        chamberBridge.requestRefresh(target.sourceId)
      } catch (reason) {
        setArchiveConfirmError(reason instanceof Error ? reason.message : String(reason))
        throw reason
      }
    }).then((ok) => {
      openLayersRef.current.archivePending = false
      setArchiveConfirmPending(false)
      if (ok) dismissArchiveConfirm()
    })
  }

  const onDeleteWorkspace = (server: ChamberServerAggregate, workspaceId: string, title: string): void => {
    // 武装确认是这里唯一的副作用——wire 调用在 confirmDeleteWorkspace，用户接受前不会有破坏性操作。
    if (deletePending) return
    // 拒绝在另一个 chamber 对话框之上武装：本处理器可从常驻 orphan 徽标（任一层 mask 后）到达，
    // 两层各注册 Escape 会让一次 Escape 关掉两层。规则在 `otherChamberDialogOpen`（唯一谓词，双向）。
    if (otherChamberDialogOpen('delete')) return
    openLayersRef.current.delete = true
    deleteOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 失败消息属于它自己的尝试：武装新目标绝不能把上次失败显示进新对话框。
    setDeleteError(null)
    setDeleteTarget({
      sourceId: server.id,
      workspaceId,
      title,
      // ORPHANED 工作区（路径已消失）只丢持久注册——描述句会说明，仍在同一确认之后。
      orphaned: getWorkspaceGitFlag(server.id, workspaceId)?.orphaned === true,
    })
  }

  /** 无条件关闭（确认路径已在同一批清掉 pending 标志）；连同其显示过的失败一起丢弃。 */
  const dismissDeleteWorkspace = (): void => {
    openLayersRef.current.delete = false
    setDeleteTarget(null)
    setDeleteError(null)
    requestAnimationFrame(() => {
      const opener = deleteOpenerRef.current
      deleteOpenerRef.current = null
      if (opener !== null && opener.isConnected) opener.focus()
    })
  }

  const closeDeleteWorkspace = (): void => {
    if (deletePending) return
    dismissDeleteWorkspace()
  }

  /** 接受已武装确认：跑同一个 keyed action（rowErrors 上报一致），wire 在飞行时保持 pending，
   *  成功且 action 落定后关闭。失败**不**关闭对话框：消息同时渲染在对话框内 role="alert"，
   *  行级 rowErrors 在被删行卸载后已无表面（这正是 deleteTarget 放在 shell 上的原因），
   *  对话框直到用户取消/X/mask/Escape 才关闭。 */
  const confirmDeleteWorkspace = (): void => {
    const target = deleteTarget
    if (target === null || deletePending) return
    setDeletePending(true)
    setDeleteError(null)
    void runActionWithOutcome(`${target.sourceId}/workspace/${target.workspaceId}/delete`, async () => {
      try {
        const path = workspacePathForFact(target.sourceId, target.workspaceId)
        // chamber (design 05 §2.2.1): workspace echo 的 WITHDRAW 半边走单一漏斗——wire 与事实
        // 一起发布，属于行自己的来源（绝不是发布壳的来源）。未挂载来源没有可退休该回显的权威基线
        // （`reconcilePendingWorkspaces` 匹配不到），否则 create → delete 会留下带真 id 动作的
        // 幽灵行直到 TTL。
        await deleteWorkspaceForSource(target.sourceId, target.workspaceId, path)
        chamberBridge.requestRefresh(target.sourceId)
      } catch (reason) {
        // 对话框自己的一份失败文案；重新抛出以保留行级 rowErrors 上报。
        setDeleteError(reason instanceof Error ? reason.message : String(reason))
        throw reason
      }
    }).then((ok) => {
      setDeletePending(false)
      // 成功：移除事实 + refresh 已在 action 内完成，关闭对话框。
      if (ok) dismissDeleteWorkspace()
    })
  }

  // 添加工作区目录浏览器（应用内 unified dialog）：驱动浏览来源自己的 unary client
  // （directoryPicker.list / createDirectory——每个受管宿主都提供的 browse 能力）。browse
  // 调用用 useCallback 稳定：vendor 对话框在 `navigate` 闭包每次变化时重置全部导航，而本壳
  // 会因桥发布重渲染，内联箭头会在刷新时抹掉用户的浏览。确认路径对该来源提交
  // workspace.create；失败关闭对话框并内联呈现，绝不静默。
  const browseClient = useMemo(
    () => (addingWorkspace === null ? null : getInstanceClient(addingWorkspace)),
    [addingWorkspace],
  )
  const browseListDirectory = useCallback(
    (path: string | undefined, signal?: AbortSignal) => {
      if (browseClient === null) return Promise.reject(new Error('no instance'))
      return listHostDirectory(browseClient, path, signal)
    },
    [browseClient],
  )
  const browseCreateDirectory = useCallback(
    (path: string, name: string) => {
      if (browseClient === null) return Promise.reject(new Error('no instance'))
      return createHostDirectory(browseClient, path, name)
    },
    [browseClient],
  )
  const browsePick = useCallback(
    (path: string) => {
      const sourceId = addingWorkspace
      if (sourceId === null || browseClient === null) return
      setAddingWorkspaceBusy(true)
      const key = `${sourceId}/add-workspace`
      setRowErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      // chamber (design 05 §2.2): 宿主工作区身份由单一漏斗与 wire 调用一起发布——没有挂载壳
      // 时唯一可信的「该宿主存在此工作区」事实；否则该行要等用户点击服务器才出现（unary 兜底
      // 从 session cwd 派生分组，新工作区还没有；已推送来源的工作区集是冻结的）。App 立即回显，
      // 挂载后的 follow 基线稍后收敛。
      createWorkspaceForSource(sourceId, path)
        .then(() => {
          setAddingWorkspace(null)
          chamberBridge.requestRefresh(sourceId)
        })
        .catch((reason: unknown) => {
          const message = reason instanceof Error ? reason.message : String(reason)
          setRowErrors((prev) => ({ ...prev, [key]: message }))
          setAddingWorkspace(null)
        })
        .finally(() => {
          setAddingWorkspaceBusy(false)
        })
    },
    [addingWorkspace, browseClient],
  )
  const browseClose = useCallback(() => {
    openLayersRef.current.browser = false
    setAddingWorkspace(null)
    setAddingWorkspaceBusy(false)
  }, [])
  return {
    addingWorkspace, addingWorkspaceBusy, archiveCleanupServerId,
    deleteTarget, deletePending, deleteError, deleteBodyRef,
    archiveConfirm, archiveConfirmPending, archiveConfirmError, archiveConfirmBodyRef,
    openWorkspaceBrowser, onOpenArchiveCleanup, onDeleteWorkspace, openArchiveConfirm,
    closeArchiveCleanup, closeDeleteWorkspace, confirmDeleteWorkspace,
    closeArchiveConfirm, confirmArchive,
    browseListDirectory, browseCreateDirectory, browsePick, browseClose,
  }
}

/** The three dialog layers, rendered at the shell root. */
export function SidebarRootDialogs({ dialogs, servers, t, directoryBrowserT }: {
  dialogs: ReturnType<typeof useSidebarDialogs>
  servers: readonly ChamberServerAggregate[]
  t: SidebarRootComponentProps['t']
  directoryBrowserT: SidebarRootComponentProps['directoryBrowserT']
}) {
  const {
    addingWorkspace, addingWorkspaceBusy, archiveCleanupServerId,
    deleteTarget, deletePending, deleteError, deleteBodyRef,
    archiveConfirm, archiveConfirmPending, archiveConfirmError, archiveConfirmBodyRef,
    closeArchiveCleanup, closeDeleteWorkspace, confirmDeleteWorkspace,
    closeArchiveConfirm, confirmArchive,
    browseListDirectory, browseCreateDirectory, browsePick, browseClose,
  } = dialogs
  return (
    <>
      {/* 添加工作区目录浏览器（单实例；仅在选定来源时挂载——重新挂载即重置对话框）。 */}
      {addingWorkspace !== null && (
        <DirectoryBrowser
          open
          listDirectory={browseListDirectory}
          createDirectory={browseCreateDirectory}
          busy={addingWorkspaceBusy}
          t={directoryBrowserT}
          onOpen={browsePick}
          onClose={browseClose}
        />
      )}
      {/* chamber (design 24): per-source 归档管理器——列出归档（按工作区分组），支持逐行/
          多选删除；整集只能经显式 select-all。仅在选定来源时挂载。 */}
      {archiveCleanupServerId !== null && (
        <ArchiveManagerDialog
          server={servers.find(candidate => candidate.id === archiveCleanupServerId) ?? null}
          t={t}
          onClose={closeArchiveCleanup}
        />
      )}
      {/* chamber: 工作区删除确认——应用内 Modal（上游 chrome：outline 取消/危险确认、
          描述句、role="status" pending 行、role="alert" 失败行）。仅在武装目标存在时挂载，
          开启它的行可能已不在。单层不变量：本确认绝不在另一 chamber 对话框之上或之下——
          四个打开方都查询 `otherChamberDialogOpen`，任一顺序下只有一层。 */}
      <Modal
        open={deleteTarget !== null}
        onClose={closeDeleteWorkspace}
        closeLabel={t('action.cancel')}
        title={t('delete.workspace')}
        {...deleteTarget === null
          ? {}
          : {
            description: deleteTarget.orphaned
              // orphan 情况有自己的一份文案，但对话框需要陈述句：`confirm.deleteOrphan`
              // 带尾随「？」在「删除工作区」标题下读作疑问；该 key 仍是导航里 orphan 徽标的
              // 原生 title。
              ? t('delete.descOrphan', { name: deleteTarget.title })
              : t('delete.desc', { name: deleteTarget.title }),
          }}
        footer={(
          <>
            <Button variant="outline" disabled={deletePending} onClick={closeDeleteWorkspace}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="outline"
              className={cc.archiveManagerDanger}
              disabled={deletePending}
              onClick={confirmDeleteWorkspace}
            >
              {t('delete.workspace')}
            </Button>
          </>
        )}
      >
        <div ref={deleteBodyRef} tabIndex={-1}>
          {deletePending && <div className={cc.deleteStatus} role="status">{t('delete.pending')}</div>}
          {/* 失败留在对话框内（对话框也保持打开）。 */}
          {deleteError !== null && <div className={cc.deleteError} role="alert">{deleteError}</div>}
        </div>
      </Modal>
      {/* chamber: 归档活动确认——宿主以 `workspace/session-active` 拒绝后的第二段。仅在
          武装目标存在时挂载；开启它的行可能已不在。单层不变量同删除确认：四个打开方都查询
          `otherChamberDialogOpen`。 */}
      {archiveConfirm !== null && (
        <SessionArchiveConfirmDialog
          request={archiveConfirm}
          t={t}
          pending={archiveConfirmPending}
          error={archiveConfirmError}
          bodyRef={archiveConfirmBodyRef}
          onClose={closeArchiveConfirm}
          onConfirm={confirmArchive}
        />
      )}
    </>
  )
}
