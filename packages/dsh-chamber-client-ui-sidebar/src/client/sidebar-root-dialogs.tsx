/**
 * Chamber dialog layers: add-workspace directory browser, per-source archive
 * manager, armed workspace-delete confirm. One hook owns the state, the openers
 * and the single-dialog-layer predicate; one component renders the three layers.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryBrowser } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { createHostDirectory, getInstanceClient, listHostDirectory } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { createWorkspaceForSource, deleteWorkspaceForSource } from '@dsh-chamber/dsh-chamber-client-core/workspace-mutations'
import { getWorkspaceGitFlag } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import { ArchiveManagerDialog } from './ArchiveManagerDialog.tsx'
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
   * 浏览器。拒绝不丢功能：每层都可取消/X/mask/Escape 关闭，关闭后被拒控件立即可用。
   * 刻意用 hoisted `function`：两个 opener 与下方 arm 处理器共用一条规则，而它读的 `deleteTarget` 声明在组件更后面（函数声明提升）。
   */
  function otherChamberDialogOpen(self: 'delete' | 'archive' | 'browser'): boolean {
    return (self !== 'delete' && deleteTarget !== null)
      || (self !== 'archive' && archiveCleanupServerId !== null)
      || (self !== 'browser' && addingWorkspace !== null)
  }

  /** 添加工作区入口（来源头的 `+`）走本 opener 而不暴露原始 setter——单层规则必须在打开处
   *  执行，而不是每个调用点。 */
  const openWorkspaceBrowser = (sourceId: string): void => {
    if (otherChamberDialogOpen('browser')) return
    setAddingWorkspace(sourceId)
  }

  const onOpenArchiveCleanup = (server: ChamberServerAggregate): void => {
    // 反方向：删除确认 mask 之下仍可从来源头到达（无焦点陷阱），必须同样拒绝。
    if (otherChamberDialogOpen('archive')) return
    archiveCleanupOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setArchiveCleanupServerId(server.id)
  }
  const closeArchiveCleanup = (): void => {
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
   * `otherChamberDialogOpen` 被全部三个打开方查询，任一顺序下至多一层。
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

  const onDeleteWorkspace = (server: ChamberServerAggregate, workspaceId: string, title: string): void => {
    // 武装确认是这里唯一的副作用——wire 调用在 confirmDeleteWorkspace，用户接受前不会有破坏性操作。
    if (deletePending) return
    // 拒绝在另一个 chamber 对话框之上武装：本处理器可从常驻 orphan 徽标（任一层 mask 后）到达，
    // 两层各注册 Escape 会让一次 Escape 关掉两层。规则在 `otherChamberDialogOpen`（唯一谓词，双向）。
    if (otherChamberDialogOpen('delete')) return
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
    setAddingWorkspace(null)
    setAddingWorkspaceBusy(false)
  }, [])
  return {
    addingWorkspace, addingWorkspaceBusy, archiveCleanupServerId,
    deleteTarget, deletePending, deleteError, deleteBodyRef,
    openWorkspaceBrowser, onOpenArchiveCleanup, onDeleteWorkspace,
    closeArchiveCleanup, closeDeleteWorkspace, confirmDeleteWorkspace,
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
    closeArchiveCleanup, closeDeleteWorkspace, confirmDeleteWorkspace,
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
          三个打开方都查询 `otherChamberDialogOpen`，任一顺序下只有一层。 */}
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
    </>
  )
}
