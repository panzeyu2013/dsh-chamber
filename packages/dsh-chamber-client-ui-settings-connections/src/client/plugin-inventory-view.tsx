/**
 * Plugin inventory view for gateway connections (design 05 §5 / design 17):
 * the per-connection plugin surface for targets without the SSH exec
 * channel — gateway targets (both transports; the desktop SSH exec surface
 * refuses `kind !== 'dsh'`, design 17 §9.3) and dsh+http direct endpoints.
 *
 * Gateway management is NOT absent: chamber-injected components are synced
 * by the desktop main process through the gateway's own `/chamber/plugins`
 * channel at every ready registration (version-match skip, controlled
 * restart on change — see desktop gateway-provider.ts syncGatewayChamberPlugins)
 * and seeded into the managed profile at every spawn. This view is the
 * read side of that loop — with the design 21 §5.1「重启生效」managed-restart
 * action for gateway sources (the same POST + pollGatewayReady semantics as
 * the connection card; dsh+http direct targets stay read-only — no /chamber
 * surface, design 21 §3 backend matrix): it mirrors the SSH plugin dialog's
 * sync tab (PluginSyncModal.tsx) — the chamber 内建组件 block (local injection
 * state from the desktop's own local manifest, remote side from the managed
 * instance's LIVE Loader state) plus the third-party loaded plugins
 * (inventory entries minus official `@deepseek-ai/*` and the chamber
 * packages). Data rides the per-instance proxy
 * (`/api/i/<sourceId>/api/pluginInventory/list`, plugin-inventory-api.ts)
 * plus the same `localPluginList` IPC the SSH dialog uses; third-party
 * plugin install/manage happens on the server side (no gateway surface for
 * arbitrary packages — the seed registry whitelist is the bounded channel).
 *
 * Design 21 A0 read side (2026-12 Phase 3): for gateway sources the chamber
 * zone additionally reads the gateway seed-cache projection (GET
 * /chamber/plugins through the instance proxy — the desktop-synced chamber
 * versions) and shows per-package drift against the LOCAL manifest versions,
 * plus a manual「立即同步」re-run (the gateway_plugin_sync IPC, design 21
 * §6.5) — the fallback when the ready-edge auto-sync failed or versions
 * drifted. http+dsh direct targets stay unchanged (no /chamber surface).
 *
 * Phase 5 ③ gateway 管理面（design 21 §6.6/§6.8, gateway arm）：gateway 源
 * 在既有 chamber/差异/清单内容下方追加「已安装」区（/chamber/plugins/
 * installed 投影，third-party 行 + 逐行移除）与「变更记录」区（/chamber/
 * plugins/tasks 投影：deferred 意图 + journal 行），外加表头「撤销最近变
 * 更」（模型层 undoForLatest derive）——同一模型分类
 * (classifyGatewayApplyResult/partialCounts) 落到结果行；所有新文案键都只
 * 在 gatewaySource 分支内可达，http+dsh 直连目标的渲染逐字节不变。恢复区
 * 文案：profile_absent/corrupt 横幅 + blocked-recovery 提示行 + chamber 区
 * 未就绪标签（seed-cache 读失败时）。
 *
 * Loading / failure states stay local to this component; a failed read can
 * be retried without exposing transport details.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutline16, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsConnectionsKey } from '../locales.ts'
import { pollGatewayReady } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { gatewayChamberSeedCache, gatewayInstalled, gatewayPluginApply, gatewayPluginSync, gatewayTasks, localPluginList, type GatewayInstalledProjection } from './control-plane.ts'
import { classifyRestartError, serverRefusalText } from './managed-restart.ts'
import { loadPluginInventory, type PluginInventorySnapshot } from './plugin-inventory-api.ts'
import {
  classifyGatewayApplyResult, filterDeniedRows, partialCounts, projectTasks, undoForLatest,
  type TaskRow,
} from './plugin-model.ts'
import {
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  chamberRemoteKey,
  chamberSeedDrift,
  thirdPartyEntries,
  type ChamberSeedDriftState,
} from './plugin-inventory-text.ts'
import { pluginDiagnosticText, pluginDiagnosticTone, type PluginDiagnostic } from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

type ViewPhase = 'loading' | 'error' | 'ready'

/** Tone of the gateway management-zone operation status line (remove /
 *  undo outcomes — the ssh modal's RemoteListTone equivalent). */
type ManageTone = 'ok' | 'warn' | 'error'

/** One management-zone outcome line (row remove / undo executed outcomes). */
interface ManageStatus {
  tone: ManageTone
  text: string
}

/** Tone of the restart-to-apply outcome line (two-tone pair, mirroring the
 *  connection card's restart note): 'error' renders css.error + role="alert";
 *  'ok' renders css.hint + role="status". */
type RestartNote = { tone: 'ok' | 'error'; text: string }

/** Management status tone → the shared copy class it renders with. */
function manageStatusClass(tone: ManageTone): string {
  switch (tone) {
    case 'ok': return css.hint
    case 'warn': return css.pluginWarn
    default: return css.error
  }
}

/** The runnable task rows kept in view (newest first, retention-capped
 *  journal; deferred intents first per the projection contract). */
const TASK_ROWS_SHOWN = 20

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The inventory dialog.
 * @param props.sourceId - proxy source id of the target (`dsh-<id>` /
 *   `gateway-<id>`); the RPC rides `/api/i/<sourceId>/api/pluginInventory/list`.
 * @param props.label - connection label for the dialog title.
 * @param props.diagnostic - this instance's client-plugin runtime diagnostic
 *   (design 09 §3.5), shown as the same detail banner as the sync dialog.
 * @param props.onRecheckDiagnostic - host-provided CHANNEL-class self-heal
 *   recheck (design 09 §3.5): fired when the banner is visible on open and
 *   on every explicit 刷新, so a diagnostic that healed since the source's
 *   last shell boot clears without an app restart.
 */
export function PluginInventoryView({ t, sourceId, label, diagnostic, onRecheckDiagnostic, onClose }: {
  t: (key: SettingsConnectionsKey) => string
  sourceId: string
  label: string
  diagnostic?: PluginDiagnostic
  onRecheckDiagnostic?: () => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<ViewPhase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PluginInventorySnapshot | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // The LOCAL side of the chamber rows comes from the desktop's own profile
  // manifest — the exact source the SSH dialog's sync tab reads. Unreadable
  // (local instance not started) is the same loud hint, never a silent
  // "not injected". Re-runs on every reload so 刷新/重试 also refreshes the
  // local side (e.g. the local instance started while the dialog was open).
  const [localInjected, setLocalInjected] = useState<{ hostGraph: boolean; gitWorktree: boolean } | null>(null)
  const [localVersion, setLocalVersion] = useState<{ hostGraph: string | null; gitWorktree: string | null } | null>(null)
  const [localFailed, setLocalFailed] = useState(false)
  // 「重启生效」（design 21 §5.1）：受控重启托管 dsh 以装载插件变更 —— 同一
  // POST + pollGatewayReady 动作语义，卡片入口之外的第二处入口。
  const [restarting, setRestarting] = useState(false)
  /** 重启结果行（成功/失败/拒绝/超时）：tone 决定红字 alert（error）或灰字
   *  status（ok）渲染（P2-1：结果行必须带语气渲染，与卡片的 restartNotes 同款）。 */
  const [restartNote, setRestartNote] = useState<RestartNote | null>(null)
  const restartAbortRef = useRef<AbortController | null>(null)
  // Gateway chamber seed-cache projection (design 21 §6.2, Phase 3 A0 read
  // side): GET /chamber/plugins over the instance proxy — the cached chamber
  // versions the manual sync keeps in step with the LOCAL manifest. Name →
  // version map; null version = that package was never synced. A failed read
  // degrades the chamber zone only (the Loader view stays readable).
  const [seedCache, setSeedCache] = useState<Record<string, string | null> | null>(null)
  const [seedCacheError, setSeedCacheError] = useState<string | null>(null)
  // Manual chamber sync (design 21 §6.5, Phase 3): re-runs the ready
  // registration's seed-cache sync through the main process.
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // dsh+http 直连目标没有 /chamber 管理面（design 21 §3 后端矩阵：只读）——
  // 同一 gateway 门控同时保护受控重启（Phase 2）与 chamber 同步动作及其漂移
  // 读面（Phase 3 A0，design 21 §6.2/§6.5）：非 gateway 源绝不发起 /chamber
  // 读或写。
  const gatewaySource = sourceId.startsWith('gateway-')
  /** The RAW registry instance id (no `gateway-` proxy prefix): every
   *  /chamber REST wrapper and gateway IPC in this file takes it (mirrors
   *  chamberSyncNow's IPC slice and cp.gatewayHostLogs' raw-id convention —
   *  the wrappers own the /api/i/gateway-<id> prefix themselves). */
  const gatewayId = gatewaySource ? sourceId.slice('gateway-'.length) : null

  // ---- Phase 5 ③ gateway 管理面（已安装列表 / 变更记录 / 撤销）----
  /** GET /chamber/plugins/installed readManifest projection; null = first
   *  load in flight or a failed read (installedError carries the verbatim
   *  refusal). Profile-absent/corrupt map to their typed codes. */
  const [installed, setInstalled] = useState<GatewayInstalledProjection | null>(null)
  const [installedError, setInstalledError] = useState<string | null>(null)
  /** GET /chamber/plugins/tasks projection (rows + busy); null = load in
   *  flight or failed (tasksError). */
  const [taskRows, setTaskRows] = useState<TaskRow[] | null>(null)
  const [tasksBusy, setTasksBusy] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  /** Row-remove / undo apply in flight (profile-mutating — same single-wire
   *  discipline as syncing/restarting: never two at once). */
  const [removeBusy, setRemoveBusy] = useState(false)
  /** Row awaiting its per-row remove/undo confirm modal. */
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  /** Which flow opened the confirm modal ('undo' vs 'row') — picks the
   *  executed-outcome copy (undoDone vs the row-remove copy). */
  const [removeOrigin, setRemoveOrigin] = useState<'row' | 'undo' | null>(null)
  /** Management-zone outcome line (remove/undo executed/refused); survives
   *  the post-op reload (reloadNonce only refills the lists). */
  const [manageStatus, setManageStatus] = useState<ManageStatus | null>(null)

  useEffect(() => {
    return () => { restartAbortRef.current?.abort() }
  }, [])

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setError(null)
    loadPluginInventory(sourceId).then(next => {
      if (cancelled) return
      setSnapshot(next)
      setPhase('ready')
    }).catch(err => {
      if (cancelled) return
      setSnapshot(null)
      setError(errorMessage(err))
      setPhase('error')
    })
    return () => { cancelled = true }
  }, [sourceId, reloadNonce])

  useEffect(() => {
    let cancelled = false
    localPluginList().then(res => {
      if (cancelled) return
      if ('error' in res) {
        setLocalFailed(true)
        setLocalInjected(null)
        setLocalVersion(null)
        return
      }
      const chamber = res.manifest.chamber
      if (chamber.ok !== true) {
        setLocalFailed(true)
        setLocalInjected(null)
        setLocalVersion(null)
        return
      }
      setLocalFailed(false)
      setLocalInjected({
        hostGraph: chamber.hostGraph.installed && chamber.hostGraph.patched,
        gitWorktree: chamber.gitWorktree.installed && chamber.gitWorktree.patched,
      })
      setLocalVersion({
        hostGraph: chamber.hostGraph.version,
        gitWorktree: chamber.gitWorktree.version,
      })
    }).catch(() => {
      if (cancelled) return
      setLocalFailed(true)
      setLocalInjected(null)
      setLocalVersion(null)
    })
    return () => { cancelled = true }
  }, [reloadNonce])

  // Gateway-only chamber seed-cache read (Phase 3 A0, design 21 §6.2): load
  // on open and re-run on every reload / after a manual sync. http+dsh direct
  // targets never mount this effect (no /chamber surface, design 21 §3).
  // The wrapper takes the RAW registry id and owns the /api/i/gateway-<id>
  // prefix (control-plane.ts gatewayChamberSeedCache) — the proxy-source
  // sourceId must never be passed here (it would double-prefix the path).
  useEffect(() => {
    if (gatewayId === null) return
    let cancelled = false
    gatewayChamberSeedCache(gatewayId).then(next => {
      if (cancelled) return
      const byName: Record<string, string | null> = {}
      for (const item of next.items) byName[item.name] = item.version ?? null
      setSeedCache(byName)
      setSeedCacheError(null)
    }).catch(err => {
      if (cancelled) return
      setSeedCache(null)
      setSeedCacheError(errorMessage(err))
    })
    return () => { cancelled = true }
  }, [gatewayId, reloadNonce])

  // Gateway-only management projections (Phase 5 ③, design 21 §6.2/§6.6):
  // the installed list + the task journal load on open and re-run on every
  // reload (刷新/重试) and after every executed management op. Both reads
  // fail loudly per zone (never a silent empty). http+dsh direct targets
  // never mount this effect.
  useEffect(() => {
    if (gatewayId === null) return
    let cancelled = false
    gatewayInstalled(gatewayId).then(next => {
      if (cancelled) return
      setInstalled(next)
      setInstalledError(null)
    }).catch(err => {
      if (cancelled) return
      setInstalled(null)
      setInstalledError(errorMessage(err))
    })
    gatewayTasks(gatewayId).then(next => {
      if (cancelled) return
      const projected = projectTasks(next)
      setTaskRows(projected.rows)
      setTasksBusy(projected.busy)
      setTasksError(null)
    }).catch(err => {
      if (cancelled) return
      setTaskRows(null)
      setTasksError(errorMessage(err))
    })
    return () => { cancelled = true }
  }, [gatewayId, reloadNonce])

  /** 受控重启托管 dsh（design 21 §5.1）：POST /api/i/<sourceId>/
   *  chamber/runtime/restart —— 仅 202 接受；409/400 body.error 逐字。202 后
   *  按 shared pollGatewayReady 语义轮询；成功刷新清单（同手动刷新通道）。 */
  const restartManagedDsh = async (): Promise<void> => {
    if (restarting) return
    restartAbortRef.current?.abort()
    const controller = new AbortController()
    restartAbortRef.current = controller
    setRestarting(true)
    setRestartNote(null)
    try {
      let response: Response
      try {
        response = await fetch(`/api/i/${sourceId}/chamber/runtime/restart`, { method: 'POST' })
      } catch (err) {
        if (controller.signal.aborted) return
        setRestartNote({ tone: 'error', text: errorMessage(err) })
        return
      }
      if (response.status !== 202) {
        let body: unknown = null
        try { body = await response.json() } catch { body = null }
        setRestartNote({ tone: 'error', text: serverRefusalText(body, response.status) })
        return
      }
      try {
        await pollGatewayReady(sourceId, controller.signal)
        setRestartNote({ tone: 'ok', text: t('restartManagedDshOk') })
        // 重启 = 刷新插件挂载 → 清单重读（Loader 事实行随之更新）。
        setReloadNonce(n => n + 1)
      } catch (err) {
        if (controller.signal.aborted) return
        const cls = classifyRestartError(err)
        // accepted-timeout = 重启已接受、仍在恢复 → 本地化说明（ok 语气：
        // 动作已被接受，仅提示仍在恢复）；其余 = 轮询/服务的英文错误串原样
        // 透出（error 语气；未本地化文案登记接受，design 21 §5.2）。
        setRestartNote(cls.kind === 'accepted-timeout'
          ? { tone: 'ok', text: t('restartManagedDshAccepted') }
          : { tone: 'error', text: cls.detail })
      }
    } finally {
      setRestarting(false)
      if (restartAbortRef.current === controller) restartAbortRef.current = null
    }
  }

  /** 手动 chamber 同步（design 21 §6.5 / plan Phase 3）：把桌面本机 chamber
   *  两包重新上传进 gateway 种子缓存 —— ready 自动同步失败或版本漂移时的兜底
   *  入口。IPC 收 RAW 注册表实例 id（INSTANCE_ID_PATTERN 键），即去掉
   *  `gateway-` 代理前缀的 spec.id —— 与 ConnectionsSection 同款 id 语义
   *  （runTunnelOp/restart 均以 spec.id 原文调主进程）。成功按 {uploaded,
   *  skipped} 投影如实提示（uploaded = 上传并请求了受控重启；skipped = 本机
   *  无构建产物；双 false = 网关缓存已是最新）。失败（HTTP/网络/上传被拒）由
   *  主进程显式投影为 ok:false + error（design 21 review P2-B1 修复 —— 失败
   *  绝不再伪装成「已是最新」）；无论成败都重读两条投影 —— 失败路径也可能已
   *  有部分包上传成功。 */
  const chamberSyncNow = async (): Promise<void> => {
    if (!gatewaySource || syncing || restarting || removeBusy) return
    setSyncing(true)
    setSyncNote(null)
    setSyncError(null)
    try {
      const result = await gatewayPluginSync(sourceId.slice('gateway-'.length))
      if (!result.ok) {
        setSyncError(result.error)
      } else if (result.uploaded) {
        setSyncNote(t('chamberSyncUploaded'))
      } else if (result.skipped) {
        setSyncNote(t('chamberSyncSkipped'))
      } else {
        setSyncNote(t('chamberSyncUpToDate'))
      }
    } catch (err) {
      setSyncError(errorMessage(err))
    } finally {
      setSyncing(false)
      setReloadNonce(n => n + 1)
    }
  }

  /** 逐行移除 / 撤销最近变更的共同执行面（Phase 5 ③, design 21 §6.6/§6.8）：
   *  以 {remove:[name], deferRestart:false} 走 gateway_plugin_apply IPC
   *  （主进程二次确认 + 白名单复核；restart-to-apply 由 gateway 执行器在
   *  profile 存在时自动触发）。结果经模型层分类（classifyGatewayApplyResult
   *  + partialCounts）：cancelled = 静默无操作；executed = 成功行
   *  （restarted → 已重启并恢复就绪；否则重启后生效提示）；failed = n/m 如
   *  实 + 逐字 error。executed 或 partial-failed 都重读清单（可能有行变更）；
   *  纯拒绝不重读。opBusy 期间禁止任何其他写面（restart/sync/另一行）。 */
  const applyRemove = async (name: string, origin: 'row' | 'undo'): Promise<void> => {
    if (gatewayId === null || removeBusy || restarting || syncing) return
    setRemoveBusy(true)
    setManageStatus(null)
    try {
      const result = await gatewayPluginApply(gatewayId, { add: [], remove: [name], deferRestart: false })
      const outcome = classifyGatewayApplyResult(result, 1)
      if ('cancelled' in outcome) {
        // User dismissed the main-process confirmation: silent no-op.
        return
      }
      if ('failed' in outcome) {
        const counts = partialCounts(outcome)
        // 0-done refusals are pure submissions — the error explains itself;
        // only real partials (≥1 op ran) get the n/m prefix.
        const partialText = counts === null || counts.done === 0
          ? ''
          : `${t('partialNofM').replace('{done}', String(counts.done)).replace('{total}', String(counts.total))}${t('partialSep')}`
        setManageStatus({ tone: 'error', text: `${partialText}${outcome.failed.error}` })
        // A partial failure means ops ran before the refusal — refresh (a
        // pure submission refusal changed nothing).
        if (counts !== null && counts.done > 0) setReloadNonce(n => n + 1)
        return
      }
      const executed = outcome.executed
      if (origin === 'row') {
        setManageStatus(executed.restarted
          ? { tone: 'ok', text: `${name} · ${t('restartManagedDshOk')}` }
          : { tone: 'warn', text: `${name} · ${t('restartNeededHint')}` })
      } else {
        // Undo copy: clean executed (restart ok) = 已撤销最近变更; executed
        // but not restarted (e.g. the runtime was stopped) = the change is
        // applied but not effective until the instance runs again.
        setManageStatus(executed.restarted
          ? { tone: 'ok', text: t('undoDone') }
          : { tone: 'warn', text: `${t('undoDone')} · ${t('restartNeededHint')}` })
      }
      setReloadNonce(n => n + 1)
    } catch (err) {
      setManageStatus({ tone: 'error', text: errorMessage(err) })
    } finally {
      setRemoveBusy(false)
      setRemoveTarget(null)
      setRemoveOrigin(null)
    }
  }

  /** 「撤销最近变更」表头入口（design 21 §6.4/§6.6, gateway journal）：模型层
   *  undoForLatest derive 只读当前 task 行 —— 无动作时给原因文案（无成功变
   *  更 / remove 无 spec 可重建）；有 remove 动作时与逐行移除同一条确认 +
   *  执行管线（applyRemove origin:'undo'）。撤销从不带 renderer 侧 spec。 */
  const requestUndo = (): void => {
    if (gatewayId === null || removeBusy || restarting || syncing) return
    const undo = taskRows === null ? null : undoForLatest(taskRows)
    if (undo === null) return
    if (undo.action === null) {
      setManageStatus(undo.reason === 'remove-lacks-spec'
        ? { tone: 'warn', text: t('undoUnavailableRemove') }
        : { tone: 'warn', text: t('undoUnavailableNone') })
      return
    }
    setRemoveTarget(undo.action.name)
    setRemoveOrigin('undo')
  }

  const footer = ((): ReactNode => {
    if (phase === 'loading') return undefined
    return (
      <>
        <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { setReloadNonce(n => n + 1) }}>
          {phase === 'error' ? t('pluginsRetry') : t('pluginsRefresh')}
        </Button>
        {gatewaySource
          // A manual sync may already have asked the gateway for a controlled
          // restart — no double restart during the window. Management ops
          // (row remove / undo) mutate the same profile — single-flight.
          ? (
            <Button variant="outline" disabled={restarting || syncing || removeBusy} onClick={() => { void restartManagedDsh() }}>
              {restarting ? t('restartManagedDshBusy') : t('restartApplyInPanel')}
            </Button>
          )
          : null}
      </>
    )
  })()

  // Diagnostic self-heal (design 09 §3.5): the banner can describe the
  // source's LAST shell boot while the channel healed since (e.g. the
  // gateway's managed dsh restarted with the synced chamber host packages).
  // Whenever the banner shows a problem, ask the host to re-check — the host
  // runner re-verifies CHANNEL-class states only and skips boot-fact classes
  // without fetching, so this cannot loop (an explicit 刷新 re-checks too).
  useEffect(() => {
    if (diagnostic === undefined || diagnostic.state === 'ok') return
    onRecheckDiagnostic?.()
  }, [diagnostic?.state])

  const title = `${t('pluginsTitle')} · ${label}`
  const thirdParty = snapshot === null ? [] : thirdPartyEntries(snapshot)

  // Name-keyed drift states per package (local manifest vs gateway seed
  // cache). null while either side is unknown (local read failed / cache not
  // loaded yet / http+dsh direct) — row segments then fall back to bare
  // cached versions without a mismatch claim.
  const driftStates = gatewaySource && seedCache !== null && localVersion !== null
    ? chamberSeedDrift(localVersion, seedCache)
    : null
  // Whole cache absent = the gateway has no synced chamber packages yet (the
  // pre-first-sync state): one block note covers it — per-row「未同步」chips
  // would be redundant. Partial absence (a single package cached after a
  // partially failed sync) keeps the row-level chips.
  const bothAbsent = seedCache !== null
    && (seedCache[HOST_GRAPH_PACKAGE] ?? null) === null
    && (seedCache[GIT_WORKTREE_PACKAGE] ?? null) === null

  /** One chamber row's gateway seed-cache segment (design 21 A0 read side):
   *  `· gateway v<x>` when the package is cached — with a drift marker when
   *  it differs from the LOCAL version (the「立即同步」gap) — and `· 未同步`
   *  when the cache lacks the package (suppressed while the whole cache is
   *  absent). http+dsh direct targets have no /chamber surface → null. */
  const cachedChamberSegment = (packageName: string, driftState: ChamberSeedDriftState | null): ReactNode => {
    if (seedCache === null) return null
    const cachedVersion = seedCache[packageName] ?? null
    if (cachedVersion === null) {
      if (bothAbsent) return null
      return <span className={css.dim}> · {t('chamberNotSynced')}</span>
    }
    const localFor = packageName === HOST_GRAPH_PACKAGE
      ? (localVersion?.hostGraph ?? null)
      : (localVersion?.gitWorktree ?? null)
    return (
      <>
        <span className={css.dim}> · gateway v{cachedVersion}</span>
        {driftState === 'drift'
          ? (
            <span
              className={css.pluginWarn}
              title={`${t('chamberVersionDrift')}: v${localFor} ≠ gateway v${cachedVersion}`}
            >
              {t('chamberVersionDrift')}
            </span>
          )
          : null}
      </>
    )
  }

  const chamberBlock = snapshot === null ? null : (
    <div className={css.pluginChamber}>
      <p className={css.pluginChamberTitle}>
        {t('chamberInjectedTitle')}
        <span className={css.dim}> · {t('chamberInjectedHint')}</span>
        {/* chamber 区降级标签（Phase 5 ③）：seed-cache 读失败 = 该区数据源
            不可达（实例停机 / 代理拒绝）——区标题如实标注，不静默。 */}
        {gatewaySource && seedCacheError !== null
          ? <span className={css.error}> · {t('instanceNotReadyZone')}</span>
          : null}
      </p>
      {seedCacheError !== null ? <p className={css.error} role="alert">{seedCacheError}</p> : null}
      {bothAbsent ? <p className={css.hint} role="status">{t('chamberSeedCacheAbsent')}</p> : null}
      <div className={css.pluginChamberRow}>
        <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>
        {localVersion?.hostGraph !== null && localVersion !== null
          ? <span className={css.dim}> · v{localVersion.hostGraph}</span>
          : null}
        {cachedChamberSegment(HOST_GRAPH_PACKAGE, driftStates?.hostGraph ?? null)}
        <span className={css.pluginCellSpec}>
          {localInjected === null && !localFailed
            ? <span>—</span>
            : <span>{localInjected?.hostGraph === true ? t('chamberLocalInjected') : t('chamberLocalNotInjected')}</span>}
          <span> · {t(chamberRemoteKey(snapshot.entries, HOST_GRAPH_PACKAGE))}</span>
        </span>
      </div>
      <div className={css.pluginChamberRow}>
        <code className={css.pluginName}>{GIT_WORKTREE_PACKAGE}</code>
        {localVersion?.gitWorktree !== null && localVersion !== null
          ? <span className={css.dim}> · v{localVersion.gitWorktree}</span>
          : null}
        {cachedChamberSegment(GIT_WORKTREE_PACKAGE, driftStates?.gitWorktree ?? null)}
        <span className={css.pluginCellSpec}>
          {localInjected === null && !localFailed
            ? <span>—</span>
            : <span>{localInjected?.gitWorktree === true ? t('chamberInstalled') : t('chamberNotInstalled')}</span>}
          <span> · {t(chamberRemoteKey(snapshot.entries, GIT_WORKTREE_PACKAGE))}</span>
        </span>
      </div>
      {localFailed ? <p className={css.hint}>{t('pluginsStartLocalFirst')}</p> : null}
      {syncError !== null
        ? <p className={css.error} role="alert">{t('chamberSyncFailed')}{syncError}</p>
        : null}
      {syncNote !== null ? <p className={css.hint} role="status">{syncNote}</p> : null}
      {gatewaySource
        ? (
          <p className={css.hint}>
            <button
              type="button"
              className={css.chamberSeedButton}
              disabled={syncing || restarting || removeBusy}
              onClick={() => { void chamberSyncNow() }}
            >
              {syncing ? t('chamberSyncBusy') : t('chamberSyncNow')}
            </button>
          </p>
        )
        : null}
    </div>
  )

  /** The gateway-only management surface (Phase 5 ③): installed rows
   *  (readManifest) with per-row remove + the task journal projection with
   *  the 撤销最近变更 entry. Deliberately rendered in EVERY dialog phase
   *  for gateway sources: the /chamber reads are HOST-owned and stay
   *  reachable while the managed instance is down (design 21 §6.8 r1 — the
   *  removal window includes stopped states), so a Loader read failure never
   *  hides the management rows. null for http+dsh direct targets (no
   *  /chamber surface) — every t() in this block is gatewaySource-gated. */
  const gatewayManageBlock = gatewaySource
    ? ((): ReactNode => {
      // Profile-mutating ops (row remove / undo / manual sync / restart)
      // are single-flight: one busy flag disables every other entry.
      const opsBlocked = removeBusy || restarting || syncing
      // Third-party installed rows only (reserved domains never listed —
      // the deny mirror the model and the main process share).
      const installedRows = installed !== null && installed.ok === true
        ? filterDeniedRows(Object.entries(installed.dependencies).map(([name, spec]) => ({ name, spec }))).allowed
        : []
      // Undo mirrors the ssh modal's interaction: disabled only while an op
      // is in flight (or the journal is still loading); a click with nothing
      // undoable reveals the reason (undoUnavailable*) in the status line.
      const undoDisabled = opsBlocked || taskRows === null
      const statusTone = manageStatus?.tone
      return (
        <div className={css.pluginManageSections}>
          <div className={css.pluginStack}>
            <p className={css.pluginChamberTitle}>{t('installedTab')}</p>
            <div className={css.pluginToolbar}>
              <Button
                variant="ghost"
                size="sm"
                disabled={undoDisabled}
                onClick={requestUndo}
              >
                {t('undoAvailable')}
              </Button>
            </div>
            {manageStatus !== null
              ? (
                <p className={manageStatusClass(statusTone ?? 'ok')} role={statusTone === 'error' ? 'alert' : 'status'}>
                  {manageStatus.text}
                </p>
              )
              : null}
            {installedError !== null
              ? <p className={css.error} role="alert">{installedError}</p>
              : installed === null
                ? <p className={css.dim}>{t('loading')}</p>
                : installed.ok
                  ? (
                    <>
                      {installedRows.length === 0
                        ? <p className={css.dim}>{t('installedEmpty')}</p>
                        : (
                          <div className={css.pluginRows}>
                            <div className={clsx(css.pluginRow, css.pluginRowRemote, css.pluginRowHead)}>
                              <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                              <span className={css.pluginCellSpec}>{t('pluginsRemoteCol')}</span>
                              <span className={css.pluginCellCat} />
                            </div>
                            {installedRows.map(row => (
                              <div key={row.name} className={clsx(css.pluginRow, css.pluginRowRemote)}>
                                <label className={clsx(css.pluginCell, css.pluginCellName)}>
                                  <code className={css.pluginName}>{row.name}</code>
                                </label>
                                <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                                  {/* file: values are the server-side mask of
                                      materialized copies — the chip names what
                                      it is (ssh-modal mirror). */}
                                  {row.spec.startsWith('file:')
                                    ? <span className={clsx(css.pluginKindBadge, css.pluginKindPlain)}>{t('installedFromMask')}</span>
                                    : <code className={css.pluginSpec}>{row.spec}</code>}
                                </span>
                                <button
                                  type="button"
                                  className={css.iconButton}
                                  disabled={opsBlocked}
                                  data-tip={t('pluginsRemoveRow')}
                                  aria-label={`${t('pluginsRemoveRow')}: ${row.name}`}
                                  onClick={() => { setManageStatus(null); setRemoveTarget(row.name); setRemoveOrigin('row') }}
                                >
                                  <IconTrashOutline16 />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                    </>
                  )
                  : (
                    // profile_absent / profile_corrupt — the readManifest
                    // codes render as the zone banner and the rows hide
                    // (nothing trustworthy to list); reload retries.
                    <p className={css.pluginBanner} role="status">
                      {installed.code === 'profile_absent' ? t('profileAbsentBanner') : t('profileCorruptBanner')}
                    </p>
                  )}
          </div>

          <div className={css.pluginStack}>
            <p className={css.pluginChamberTitle}>{t('tasksTitle')}</p>
            {tasksBusy ? <p className={css.hint} role="status">{t('busyTasks')}</p> : null}
            {/* 恢复面（design 21 §6.8 r0-r4）：任一 blocked 行的 error 带
                recovery 字样 = 实例处于恢复态、写面被恢复门挡住 —— 区级提示
                行说明插件变更被推迟。 */}
            {taskRows !== null && taskRows.some(row => row.status === 'blocked' && (row.error ?? '').includes('recovery'))
              ? <p className={css.pluginWarn} role="status">{t('recoveryHintDeferred')}</p>
              : null}
            {tasksError !== null
              ? <p className={css.error} role="alert">{tasksError}</p>
              : taskRows === null
                ? <p className={css.dim}>{t('loading')}</p>
                : taskRows.length === 0
                  ? <p className={css.dim}>{t('tasksEmpty')}</p>
                  : (
                    <>
                      {/* Task rows: deferred-intent rows first (awaiting a
                          ready edge), then journal ops newest-first; the
                          newest TASK_ROWS_SHOWN stay in view. Kind verbs
                          have no zh/en keys in the Phase-5 family — rows
                          render the wire token (install/remove/materialize)
                          as a mono chip, honest and locale-free. */}
                      {taskRows.slice(0, TASK_ROWS_SHOWN).map(row => (
                        <div key={row.opId !== '' ? row.opId : (row.intentId ?? row.name)} className={css.pluginChamberRow}>
                          <span className={clsx(css.pluginKindBadge, css.pluginKindPlain)}>{row.kind}</span>
                          <code className={css.pluginName}>{row.name}</code>
                          {row.spec !== null
                            ? row.spec.startsWith('file:')
                              ? <span className={clsx(css.pluginKindBadge, css.pluginKindPlain)}>{t('installedFromMask')}</span>
                              : <code className={css.pluginSpec}>{row.spec}</code>
                            : null}
                          {row.deferred
                            ? <span className={css.dim}>{t('deferredOfflineNote')}</span>
                            : row.status === 'pending'
                              ? <span className={css.dim}>{t('taskPending')}</span>
                              : row.status === 'failed'
                                // Journal rows are a persistent history —
                                // role=alert would re-announce every failed
                                // op on each reload/open; the error text stays
                                // visible inline and zone errors keep alert.
                                ? <span className={css.error}>{t('taskFailed').replace('{error}', row.error ?? '')}</span>
                                : row.status === 'blocked'
                                  ? <span className={css.error}>{t('taskBlocked').replace('{error}', row.error ?? '')}</span>
                                  : null}
                        </div>
                      ))}
                    </>
                  )}
          </div>
        </div>
      )
    })()
    : null

  /** Row-remove / undo confirm (Phase 5 ③): shared by both origins — the
   *  undo confirm mirrors the ssh list's remove confirm copy (removing the
   *  name the undo derives IS a removal). */
  const removeConfirmModal = gatewaySource
    ? (
      <Modal
        open={removeTarget !== null}
        onClose={() => { if (!removeBusy) setRemoveTarget(null) }}
        title={t('removeRowConfirmTitle')}
        closeLabel={t('close')}
        description={t('removeRowConfirmDescription').replace('{name}', removeTarget ?? '')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={removeBusy} onClick={() => { setRemoveTarget(null) }}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={removeBusy}
              onClick={() => { if (removeTarget !== null && removeOrigin !== null) void applyRemove(removeTarget, removeOrigin) }}
            >
              {removeBusy ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      />
    )
    : null

  /** 关闭门：嵌套确认 Modal 开着时（primitives 的 Modal 各自注册 Esc 监听），
   *  一次 Esc 不能连带关掉主对话框（PluginSyncModal 同款纪律）。 */
  const close = (): void => {
    if (removeTarget !== null || removeBusy) return
    onClose()
  }

  return (
    <>
      <Modal
        open
        onClose={close}
        title={title}
        closeLabel={t('close')}
        className={css.dialog}
        contentClassName={css.dialogContent}
        footer={footer}
      >
        {diagnostic !== undefined && diagnostic.state !== 'ok'
          ? (
            <p
              className={clsx(
                css.pluginDiagnostic,
                css.pluginDiagnosticDetail,
                pluginDiagnosticTone(diagnostic.state) === 'problem' ? css.pluginDiagnosticProblem : css.pluginDiagnosticInfo,
              )}
              role="status"
            >
              <strong>{t('pluginDiagnosticLabel')}：{pluginDiagnosticText(diagnostic.state, t)}</strong>
              {diagnostic.pluginId !== undefined && <span>{diagnostic.pluginId}</span>}
              {diagnostic.message !== undefined && <span>{diagnostic.message}</span>}
            </p>
          )
          : null}
        {restartNote !== null
          ? restartNote.tone === 'error'
            ? <p className={css.error} role="alert">{restartNote.text}</p>
            : <p className={css.hint} role="status">{restartNote.text}</p>
          : null}
        {phase === 'loading'
          ? <p className={css.dim}>{t('pluginsLoading')}</p>
          : phase === 'error'
            ? <p className={css.error} role="alert">{error !== null ? error : t('inventoryError')}</p>
            : snapshot === null
              ? <p className={css.dim}>{t('inventoryError')}</p>
              : (
              <div className={css.pluginStack}>
                {chamberBlock}
                {thirdParty.length === 0
                  ? <p className={css.dim}>{t('inventoryNoThirdParty')}</p>
                  : (
                  <div className={css.pluginStack}>
                    {thirdParty.map(entry => (
                      <div key={entry.entryId} className={css.pluginChamberRow}>
                        <code className={css.pluginName}>{entry.moduleName}</code>
                        {!entry.enabled
                          ? <span className={css.dim}>{t('pluginDisabled')}</span>
                          : null}
                        {entry.fiberPhase === 'failed'
                          ? <span className={css.error}>{t('pluginPhaseFailed')}</span>
                          : null}
                      </div>
                    ))}
                  </div>
                  )}
              </div>
              )}
        {gatewayManageBlock}
      </Modal>
      {removeConfirmModal}
    </>
  )
}
