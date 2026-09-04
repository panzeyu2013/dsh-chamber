/**
 * PluginDialog.tsx — the single unified plugin-management dialog (plan 24
 * B1 / D5-A, design 21 §6.6 + §10 勘误⑥ closed): PluginSyncModal (local +
 * ssh) and PluginInventoryView (gateway + http-direct) merged into one
 * component whose backend fork is confined to the data sources and the
 * action dispatch (design 21 §3 single-model matrix). Unified zones:
 *   ① diagnostic banner (bannerProjection — state name + message, never the
 *     state/pluginId/message triple repetition);
 *   ② chamber built-in component table (host-graph / git-worktree / mobile,
 *     mobile for gateway sources only, injected with the gateway release) —
 *     columns package | local badge | remote/gateway badge | version, using
 *     the badge projections localChamberBadge/remoteChamberBadge; version
 *     drift chips and the「重新同步 chamber 组件」action live in this zone;
 *   ③ third-party plugin zone (installed list + per-row remove + add: spec
 *     input + npm search + folder import);
 *   ④ recovery/action row (gateway only: runtimeDown + undoForLatest →
 *     recovery banner + recoveryUninstallRestart through the remove confirm
 *     and applyRemove origin:'undo' pipeline).
 *
 * Backend surfaces (design 21 §3):
 *   local  → localPluginList / localPluginAdd / localPluginAddFile /
 *            localPluginRemove (desktop local `dsh plugin` exec);
 *   ssh    → pluginList / pluginApply / pluginMaterializeAddPick /
 *            restartService / seedHostGraph / sshPluginUndo — the sync diff
 *            tab behavior (rows, filters, apply orchestration, chamber
 *            seed/restart actions, installed list with per-row remove and
 *            the「撤销最近变更」toolbar entry) is preserved byte-for-byte;
 *   gateway→ pluginInventory read (Loader badges) + gatewayChamberSeedCache
 *            / gatewayInstalled / gatewayTasks (read-only undo derive — task
 *            rows are NEVER rendered, design D4-A) / gatewayPluginApply /
 *            gatewayPluginMaterialize / gatewayPluginSync + the controlled
 *            managed-dsh restart (POST + pollGatewayReady). Add capability:
 *            spec → gatewayPluginApply(id, {add:[value], remove:[],
 *            deferRestart:false}); folder → gatewayPluginMaterialize(id);
 *            outcomes classified via classifyGatewayApplyResult.
 *   http   → read-only Loader manifest (pluginInventory list) — no /chamber
 *            surface, no add surface.
 *
 * The「变更记录」zone is deleted (the backend journal/backups are kept, the
 * UI no longer renders task rows — D4-A). The gateway undo entry is
 * recovery-shaped: only while runtimeDown (the card passes stopped/error/
 * restart-exhausted) AND undoForLatest(taskRows) has an action. The ssh
 * undo button stays in the installed tab (behavior unchanged — plan 24
 * scope: this round makes GATEWAY recovery-shaped only).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutline16, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { pollGatewayReady } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import type {
  ChamberHostGraphState,
  LocalPluginManifest,
  NpmSearchPackage,
  PluginApplyFailure,
  PluginApplyResult,
  RemotePluginManifest,
  SshInstanceSpec,
} from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import {
  gatewayChamberSeedCache,
  gatewayInstalled,
  gatewayPluginApply,
  gatewayPluginMaterialize,
  gatewayPluginSync,
  gatewayTasks,
  localPluginAdd,
  localPluginAddFile,
  localPluginList,
  localPluginRemove,
  npmSearch,
  pluginApply,
  pluginList,
  pluginMaterializeAddPick,
  restartService,
  seedHostGraph,
  sshPluginUndo,
  type GatewayInstalledProjection,
} from './control-plane.ts'
import { classifyRestartError, serverRefusalText } from './managed-restart.ts'
import {
  classifyGatewayApplyResult, classifySshApplyResult, filterDeniedRows, isDeniedPluginName, partialCounts, projectTasks, undoForLatest,
  type TaskRow,
} from './plugin-model.ts'
import { loadPluginInventory, type PluginInventorySnapshot } from './plugin-inventory-api.ts'
import {
  computePluginDiff, defaultChecked, isDifferenceRow, rowAddArg,
  type PluginDiff, type PluginRow, type PluginRowKind,
} from './plugin-diff.ts'
import {
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  MOBILE_PACKAGE,
  chamberSeedDrift,
  localChamberBadge,
  remoteChamberBadge,
  thirdPartyEntries,
  type ChamberBadge,
  type ChamberBadgeTone,
  type ChamberSeedDriftState,
} from './plugin-inventory-text.ts'
import { bannerProjection, pluginDiagnosticTone, type PluginDiagnostic } from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

/** The §7.2 add-spec whitelist: `name`, `@scope/name`, or `name@<safe version>`. */
const ADD_SPEC = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(@(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next))?$/

type PluginPhase = 'loading' | 'error' | 'ready' | 'applying' | 'done'
type PluginTab = 'sync' | 'list' | 'add'
type CategoryFilter = 'all' | 'bundle' | 'plain' | 'client'
type StatusFilter = 'diff' | 'all'
type ViewPhase = 'loading' | 'error' | 'ready'

/** Tone of the remote-list operation status line (design 21 §6.6 list tab). */
type RemoteListTone = 'ok' | 'warn' | 'error'

/** One operation outcome line (undo / row-remove executed outcomes). */
interface RemoteListStatus {
  tone: RemoteListTone
  text: string
}

/** Remote-list status tone → the shared copy class it renders with. */
function remoteStatusClass(tone: RemoteListTone): string {
  switch (tone) {
    case 'ok': return css.hint
    case 'warn': return css.pluginWarn
    default: return css.error
  }
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Row-kind → localized label key. */
function kindLabel(kind: PluginRowKind): SettingsConnectionsKey {
  switch (kind) {
    case 'missing': return 'pluginsRowAdd'
    case 'update': return 'pluginsRowUpdate'
    case 'extra': return 'pluginsRowRemove'
    case 'materialize': return 'pluginsRowMaterialize'
    case 'unsyncable': return 'pluginsRowUnsyncable'
    default: return 'pluginsConsistent'
  }
}

/** A row's category badge: bundle / client / plain. */
function categoryLabel(category: PluginRow['category']): SettingsConnectionsKey {
  switch (category) {
    case 'bundle': return 'pluginsCatBundle'
    case 'client': return 'pluginsCatClient'
    default: return 'pluginsCatPlain'
  }
}

/** Whether a row has a checkbox (the four actionable kinds). */
function isActionable(kind: PluginRowKind): boolean {
  return isDifferenceRow(kind)
}

/** Chamber badge tone → the shared .badge pill family (plan 24 B1.5 reuses
 *  the .badge vocabulary: ok = filled success, warn = outlined warn, danger =
 *  filled error, muted = plain pill). */
function chamberBadgeClass(tone: ChamberBadgeTone): string {
  switch (tone) {
    case 'ok': return clsx(css.badge, css.badgeOk)
    case 'warn': return clsx(css.badge, css.badgeWarn)
    case 'danger': return clsx(css.badge, css.badgeBad)
    default: return css.badge
  }
}

/**
 * The ssh remote-side chamber badge: the probed ChamberHostGraphState
 * tri-state mapped onto the shared badge vocabulary — present + enabled +
 * live = 已生效 (ok); present but not proven live = 已注入 (muted); present
 * without the boot layer = 已注入 (warn, the half-injected state); absent =
 * 未注入; probe failure/absent state = 未知 (warn/muted). Never a live claim
 * from a file probe (the same live-Loader semantics the gateway badge uses).
 */
function sshRemoteBadge(state: ChamberHostGraphState | null | undefined): ChamberBadge {
  if (state === undefined) return { labelKey: 'chamberBadgeUnknown', tone: 'muted' }
  if (state === null) return { labelKey: 'chamberBadgeUnknown', tone: 'warn' }
  if (state.installed && state.patched) {
    if (state.live === true) return { labelKey: 'chamberBadgeLive', tone: 'ok' }
    return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
  }
  if (state.installed) return { labelKey: 'chamberBadgeInjected', tone: 'warn' }
  return { labelKey: 'chamberBadgeNotInjected', tone: 'muted' }
}

/** The dialog target descriptor the four card kinds build (plan 24 B1.1). */
export type PluginDialogTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; spec: SshInstanceSpec }
  | { kind: 'gateway'; sourceId: string; label: string }
  | { kind: 'http'; sourceId: string; label: string }

/** One chamber table row (plan 24 B1.5). */
interface ChamberRowView {
  key: string
  nameCell: ReactNode
  localBadge: ChamberBadge | null
  remoteBadge: ChamberBadge | null
  versionCell: ReactNode
}

/**
 * The unified plugin dialog.
 * @param props.target - the built target descriptor (see PluginDialogTarget).
 * @param props.diagnostic - this instance's client-plugin runtime diagnostic
 *   (design 09 §3.5): the dialog is the detail surface.
 * @param props.onRecheckDiagnostic - host-provided CHANNEL-class self-heal
 *   recheck, fired when the banner is visible / turns channel-class.
 * @param props.runtimeDown - gateway only (plan 24 B1.6): the card passes
 *   true while the managed dsh connectionState ∈ {stopped, error,
 *   restart-exhausted} — the recovery undo surface is gated on it.
 * @param props.onClose - close (gated while nested confirms are open).
 */
export function PluginDialog({ t, target, diagnostic, onRecheckDiagnostic, runtimeDown, onClose }: {
  t: (key: SettingsConnectionsKey) => string
  target: PluginDialogTarget
  diagnostic?: PluginDiagnostic | undefined
  onRecheckDiagnostic?: () => void
  runtimeDown?: boolean
  onClose: () => void
}): ReactNode {
  const isLocal = target.kind === 'local'
  const isSsh = target.kind === 'ssh'
  const isGateway = target.kind === 'gateway'
  const isHttp = target.kind === 'http'
  const sshSpec = target.kind === 'ssh' ? target.spec : null
  const sourceId = target.kind === 'gateway' || target.kind === 'http' ? target.sourceId : null
  /** The RAW registry instance id (no `gateway-` proxy prefix) — every
   *  /chamber REST wrapper and gateway IPC takes it (the wrappers own the
   *  /api/i/gateway-<id> prefix themselves). */
  const gatewayId = target.kind === 'gateway' ? target.sourceId.slice('gateway-'.length) : null

  const [tab, setTab] = useState<PluginTab>('sync')

  // ---- ssh sync three-view state ----
  const [phase, setPhase] = useState<PluginPhase>('loading')
  const [localManifest, setLocalManifest] = useState<LocalPluginManifest | null>(null)
  const [remoteManifest, setRemoteManifest] = useState<RemotePluginManifest | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [localFailed, setLocalFailed] = useState(false)
  const [profileNotInit, setProfileNotInit] = useState(false)
  const [diff, setDiff] = useState<PluginDiff | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [restart, setRestart] = useState(true)
  const [result, setResult] = useState<PluginApplyResult | null>(null)
  const [resultError, setResultError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const applyingRef = useRef(false)

  // ---- chamber-injected host-graph (design 09): manual seed fallback ----
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)
  // ---- one-click restart for the injected-but-not-live state (08 §11) ----
  const [restartBusy, setRestartBusy] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  /** A seed that wrote/patched needs a restart to take effect, even when
   *  module A was already live (host-graph live does not prove the newly
   *  seeded git-worktree boot row loaded). Cleared by a successful restart. */
  const [pendingRestart, setPendingRestart] = useState(false)

  // ---- filters ----
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('diff')

  // ---- local list state (local instance) ----
  const [localList, setLocalList] = useState<LocalPluginManifest | null>(null)
  const [localListError, setLocalListError] = useState<string | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const [localRemoveTarget, setLocalRemoveTarget] = useState<string | null>(null)
  const [localRemoveBusy, setLocalRemoveBusy] = useState(false)
  const [localRemoveError, setLocalRemoveError] = useState<string | null>(null)

  // ---- ssh installed-list state (design 21 §6.6 list tab) ----
  const [remoteListStatus, setRemoteListStatus] = useState<RemoteListStatus | null>(null)
  const [remoteRowErrors, setRemoteRowErrors] = useState<Record<string, string>>({})
  const [remoteRemoveTarget, setRemoteRemoveTarget] = useState<string | null>(null)
  const [remoteRemoveBusy, setRemoteRemoveBusy] = useState(false)
  const [undoBusy, setUndoBusy] = useState(false)

  // ---- gateway / http-direct Loader read ----
  const [viewPhase, setViewPhase] = useState<ViewPhase>('loading')
  const [viewError, setViewError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PluginInventorySnapshot | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // The LOCAL side of the chamber rows (gateway/http): the desktop's own
  // profile manifest — unreadable is the same loud hint, never a silent
  // "not injected". Re-runs on every reload.
  const [localInjected, setLocalInjected] = useState<{ hostGraph: boolean; gitWorktree: boolean } | null>(null)
  const [localVersion, setLocalVersion] = useState<{ hostGraph: string | null; gitWorktree: string | null } | null>(null)
  const [localSideFailed, setLocalSideFailed] = useState(false)
  // 「重启生效」(design 21 §5.1): controlled managed-dsh restart — the same
  // POST + pollGatewayReady semantics as the connection card.
  const [restarting, setRestarting] = useState(false)
  const [restartNote, setRestartNote] = useState<RestartNote | null>(null)
  const restartAbortRef = useRef<AbortController | null>(null)
  // Gateway chamber seed-cache projection (design 21 §6.2 A0 read side).
  const [seedCache, setSeedCache] = useState<Record<string, string | null> | null>(null)
  const [seedCacheError, setSeedCacheError] = useState<string | null>(null)
  // Manual chamber sync (design 21 §6.5): re-runs the ready registration's
  // seed-cache sync through the main process.
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // Gateway management projections (design 21 §6.2): installed list + the
  // task journal (READ-ONLY undo derive — rows are never rendered, D4-A).
  const [installed, setInstalled] = useState<GatewayInstalledProjection | null>(null)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [taskRows, setTaskRows] = useState<TaskRow[] | null>(null)
  const [tasksError, setTasksError] = useState<string | null>(null)
  /** Row-remove / undo apply in flight (profile-mutating — single-flight
   *  with syncing/restarting). */
  const [removeBusy, setRemoveBusy] = useState(false)
  /** Row awaiting its per-row remove/undo confirm modal. */
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  /** Which flow opened the confirm modal ('undo' vs 'row'). */
  const [removeOrigin, setRemoveOrigin] = useState<'row' | 'undo' | null>(null)
  /** Management-zone outcome line (remove/undo executed/refused). */
  const [manageStatus, setManageStatus] = useState<ManageStatus | null>(null)

  // ---- shared add-view state (local / ssh / gateway) ----
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [addResult, setAddResult] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<NpmSearchPackage[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  // Diagnostic self-heal (design 09 §3.5): whenever the banner shows a
  // problem, ask the host to re-check — the host runner re-verifies
  // CHANNEL-class states only and skips boot-fact classes without fetching,
  // so this cannot loop.
  useEffect(() => {
    if (diagnostic === undefined || diagnostic.state === 'ok') return
    onRecheckDiagnostic?.()
  }, [diagnostic?.state])

  useEffect(() => {
    return () => { restartAbortRef.current?.abort() }
  }, [])

  // ---- local: load the local manifest on open ----
  const loadLocalList = useCallback(async (): Promise<void> => {
    setLocalLoading(true)
    try {
      const res = await localPluginList()
      if ('error' in res) {
        setLocalListError(res.error)
        setLocalList(null)
      } else {
        setLocalList(res.manifest)
        setLocalListError(null)
      }
    } catch (err) {
      setLocalListError(errorMessage(err))
      setLocalList(null)
    } finally {
      setLocalLoading(false)
    }
  }, [])

  /** Confirm-remove one plugin from the LOCAL dsh profile (design 13 §5.1). */
  const confirmLocalRemove = useCallback(async (): Promise<void> => {
    if (localRemoveTarget === null || localRemoveBusy) return
    setLocalRemoveBusy(true)
    setLocalRemoveError(null)
    try {
      const res = await localPluginRemove(localRemoveTarget)
      if ('error' in res) {
        setLocalRemoveError(res.error)
      } else {
        setLocalRemoveTarget(null)
        // Main-process confirmation dismissed: silent no-op — nothing was
        // removed, keep the list as-is (never a misleading refresh).
        if (!('cancelled' in res)) await loadLocalList()
      }
    } catch (err) {
      setLocalRemoveError(errorMessage(err))
    } finally {
      setLocalRemoveBusy(false)
    }
  }, [localRemoveTarget, localRemoveBusy, loadLocalList])

  /**
   * Reload the ssh sync projection. `keepChecked` preserves the user's
   * checked rows (a seed 注入 re-probe must not silently reset the
   * selection — the chamber rows are not part of the third-party diff).
   */
  const loadSync = useCallback(async (keepChecked = false): Promise<void> => {
    if (!isSsh || sshSpec === null) return
    setPhase('loading')
    setLoadError(null)
    setLocalFailed(false)
    setProfileNotInit(false)
    try {
      const localRes = await localPluginList()
      if ('error' in localRes) {
        setLoadError(localRes.error)
        setLocalFailed(true)
        setPhase('error')
        return
      }
      const remoteRes = await pluginList(sshSpec.id)
      if ('error' in remoteRes) {
        setLoadError(remoteRes.error)
        setPhase('error')
        return
      }
      // cat succeeded but package.json failed to parse: the manifest carries a
      // loud error with an empty dependency set — surface it, never show a
      // silent "manifests match" against the empty projection.
      if (remoteRes.manifest.error !== undefined && remoteRes.manifest.error !== '') {
        setLoadError(remoteRes.manifest.error)
        setPhase('error')
        return
      }
      setLocalManifest(localRes.manifest)
      setRemoteManifest(remoteRes.manifest)
      setProfileNotInit(!remoteRes.manifest.profileExists)
      const d = computePluginDiff(localRes.manifest, remoteRes.manifest)
      setDiff(d)
      if (keepChecked) {
        const rows = new Set(d.rows.map(row => row.name))
        setChecked(prev => new Set([...prev].filter(name => rows.has(name))))
      } else {
        setChecked(new Set(d.rows.filter(row => defaultChecked(row.kind)).map(row => row.name)))
      }
      setResult(null)
      setResultError(null)
      setPhase('ready')
    } catch (err) {
      setLoadError(errorMessage(err))
      setPhase('error')
    }
  }, [isSsh, sshSpec])

  /** Manual host-graph seed fallback (design 09 module B): writes module A
   *  onto the remote + ensures the cordis.patch.yml insert, then re-probes. */
  const doSeedHostGraph = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null || seedBusy) return
    if (applyingRef.current) return
    setSeedBusy(true)
    setSeedError(null)
    try {
      const res = await seedHostGraph(sshSpec.id)
      if ('cancelled' in res) {
        // User dismissed the main-process confirmation: a silent no-op.
        setPendingRestart(false)
      } else if (res.ok) {
        setPendingRestart(res.wrote === true || res.patched === true)
      } else {
        setSeedError(res.error)
        setPendingRestart(false)
      }
    } catch (err) {
      setSeedError(errorMessage(err))
      setPendingRestart(false)
    } finally {
      setSeedBusy(false)
      await loadSync(true)
    }
  }, [isSsh, sshSpec, seedBusy, loadSync])

  /** One-click restart (design 08 §11): the chamber host packages are seeded
   *  and the insert is in place, but the RUNNING instance has not loaded
   *  them — restarting is the step that makes them live. Re-probes after. */
  const doRestartNow = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null || restartBusy || seedBusy) return
    if (applyingRef.current) return
    setRestartBusy(true)
    setRestartError(null)
    try {
      const res = await restartService(sshSpec.id)
      if ('error' in res) {
        setRestartError(res.error)
      } else {
        setPendingRestart(false)
        onRecheckDiagnostic?.()
      }
    } catch (err) {
      setRestartError(errorMessage(err))
    } finally {
      setRestartBusy(false)
      await loadSync(true)
    }
  }, [isSsh, sshSpec, restartBusy, seedBusy, loadSync, onRecheckDiagnostic])

  /**
   * Row-level REMOVE on the ssh installed list (design 21 §6.6 ssh 等价):
   * one-row remove batch through the same plugin_apply surface, classified
   * through the model layer. Row-level honesty: a refused or executed-but-
   * failed remove leaves the plugin installed — the failure is attached to
   * the ROW (verbatim) and no reload runs (nothing changed).
   */
  const confirmRemoteRemove = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null || remoteRemoveTarget === null) return
    if (remoteRemoveBusy || undoBusy) return
    if (applyingRef.current || seedBusy || restartBusy) return
    const name = remoteRemoveTarget
    setRemoteRemoveBusy(true)
    setRemoteListStatus(null)
    setRemoteRowErrors(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    try {
      const res = await pluginApply(sshSpec.id, { add: [], remove: [name], restart })
      if ('cancelled' in res) {
        // User dismissed the main-process confirmation: silent no-op.
      } else if ('error' in res) {
        setRemoteRowErrors(prev => ({ ...prev, [name]: res.error }))
      } else {
        const r = res.result
        const failed = r.failed.find(item => item.spec === name)
        if (failed !== undefined) {
          setRemoteRowErrors(prev => ({ ...prev, [name]: failed.error }))
        } else {
          const outcome = classifySshApplyResult(res)
          if ('cancelled' in outcome) {
            // Defensive: the wrapper's cancelled arm is handled above.
          } else if ('failed' in outcome) {
            setRemoteListStatus({ tone: 'error', text: outcome.failed.error })
          } else {
            const executed = outcome.executed
            let tone: RemoteListTone
            let text: string
            if (executed.verified === false) {
              tone = 'error'
              text = `${t('pluginsVerifyFailed')}${executed.readyNote === undefined ? '' : ` ${executed.readyNote}`}`
            } else if (executed.ready === false) {
              tone = 'error'
              text = t('pluginsReadyFailed')
            } else if (executed.restarted) {
              tone = 'ok'
              text = `${t('pluginsApplied')}${executed.readyNote === undefined ? '' : ` · ${executed.readyNote}`}`
            } else {
              tone = 'warn'
              text = t('restartNeededHint')
            }
            setRemoteListStatus({ tone, text })
            await loadSync(true)
          }
        }
      }
    } catch (err) {
      setRemoteRowErrors(prev => ({ ...prev, [name]: errorMessage(err) }))
    } finally {
      setRemoteRemoveBusy(false)
      setRemoteRemoveTarget(null)
      setRestart(true)
    }
  }, [isSsh, sshSpec, remoteRemoveTarget, remoteRemoveBusy, undoBusy, restart, loadSync, t])

  /** 「撤销最近变更」on the ssh installed list (design 21 §6.4/§6.6 ssh
   *  journal undo): id-only intent into the main-process undo — the journal
   *  is authoritative, the renderer never supplies a spec. */
  const doUndo = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null) return
    if (undoBusy || remoteRemoveBusy) return
    if (applyingRef.current || seedBusy || restartBusy) return
    setUndoBusy(true)
    setRemoteListStatus(null)
    setRemoteRowErrors({})
    try {
      const res = await sshPluginUndo(sshSpec.id)
      if ('cancelled' in res) {
        // User dismissed the main-process undo confirmation: silent no-op.
      } else if (res.ok) {
        const undone = res.undone
        const clean = undone.restarted === undefined
          || (undone.restarted === true && undone.ready !== false)
        if (clean) {
          setRemoteListStatus({ tone: 'ok', text: t('undoDone') })
        } else if (undone.restarted === false) {
          const note = undone.readyNote === undefined ? '' : ` ${undone.readyNote}`
          setRemoteListStatus({ tone: 'warn', text: `${t('undoDone')} · ${t('restartNeededHint')}${note}` })
        } else {
          const note = undone.readyNote === undefined ? '' : ` ${undone.readyNote}`
          setRemoteListStatus({ tone: 'error', text: `${t('undoNotEffective')}${note}` })
        }
        await loadSync(true)
      } else if (res.unavailable === 'none') {
        setRemoteListStatus({ tone: 'ok', text: t('undoUnavailableNone') })
      } else if (res.unavailable === 'file-backed') {
        setRemoteListStatus({ tone: 'warn', text: t('undoUnavailableFileBacked') })
      } else {
        setRemoteListStatus({ tone: 'error', text: res.error })
      }
    } catch (err) {
      setRemoteListStatus({ tone: 'error', text: errorMessage(err) })
    } finally {
      setUndoBusy(false)
    }
  }, [isSsh, sshSpec, undoBusy, remoteRemoveBusy, loadSync, t])

  useEffect(() => {
    if (isSsh) void loadSync()
    else if (isLocal) void loadLocalList()
  }, [isSsh, isLocal, loadSync, loadLocalList])

  // ---- gateway / http-direct Loader read ----
  useEffect(() => {
    if (sourceId === null) return
    let cancelled = false
    setViewPhase('loading')
    setViewError(null)
    loadPluginInventory(sourceId).then(next => {
      if (cancelled) return
      setSnapshot(next)
      setViewPhase('ready')
    }).catch(err => {
      if (cancelled) return
      setSnapshot(null)
      setViewError(errorMessage(err))
      setViewPhase('error')
    })
    return () => { cancelled = true }
  }, [sourceId, reloadNonce])

  useEffect(() => {
    if (sourceId === null) return
    let cancelled = false
    localPluginList().then(res => {
      if (cancelled) return
      if ('error' in res) {
        setLocalSideFailed(true)
        setLocalInjected(null)
        setLocalVersion(null)
        return
      }
      const chamber = res.manifest.chamber
      if (chamber.ok !== true) {
        setLocalSideFailed(true)
        setLocalInjected(null)
        setLocalVersion(null)
        return
      }
      setLocalSideFailed(false)
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
      setLocalSideFailed(true)
      setLocalInjected(null)
      setLocalVersion(null)
    })
    return () => { cancelled = true }
  }, [sourceId, reloadNonce])

  // Gateway-only chamber seed-cache read (design 21 §6.2, Phase 3 A0 read
  // side): load on open and re-run on every reload / after a manual sync.
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

  // Gateway-only management projections (design 21 §6.2/§6.6): the installed
  // list + the task journal load on open and re-run on every reload and
  // after every executed management op. The journal feeds ONLY the undo
  // derive (undoForLatest) — task rows are never rendered (D4-A).
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
      setTaskRows(projectTasks(next).rows)
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
    if (sourceId === null || restarting) return
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
        setReloadNonce(n => n + 1)
      } catch (err) {
        if (controller.signal.aborted) return
        const cls = classifyRestartError(err)
        setRestartNote(cls.kind === 'accepted-timeout'
          ? { tone: 'ok', text: t('restartManagedDshAccepted') }
          : { tone: 'error', text: cls.detail })
      }
    } finally {
      setRestarting(false)
      if (restartAbortRef.current === controller) restartAbortRef.current = null
    }
  }

  /** 手动 chamber 同步（design 21 §6.5）：把桌面本机 chamber 两包重新上传进
   *  gateway 种子缓存 —— ready 自动同步失败或版本漂移时的兜底入口。失败由
   *  主进程显式投影为 ok:false + error；无论成败都重读两条投影。 */
  const chamberSyncNow = async (): Promise<void> => {
    if (gatewayId === null || syncing || restarting || removeBusy) return
    setSyncing(true)
    setSyncNote(null)
    setSyncError(null)
    try {
      const result = await gatewayPluginSync(gatewayId)
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

  /** 逐行移除 / 撤销最近变更的共同执行面（design 21 §6.6/§6.8）：以
   *  {remove:[name], deferRestart:false} 走 gateway_plugin_apply IPC（主进程
   *  二次确认 + 白名单复核）。结果经模型层分类（classifyGatewayApplyResult +
   *  partialCounts）。 */
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
        const partialText = counts === null || counts.done === 0
          ? ''
          : `${t('partialNofM').replace('{done}', String(counts.done)).replace('{total}', String(counts.total))}${t('partialSep')}`
        setManageStatus({ tone: 'error', text: `${partialText}${outcome.failed.error}` })
        if (counts !== null && counts.done > 0) setReloadNonce(n => n + 1)
        return
      }
      const executed = outcome.executed
      if (origin === 'row') {
        setManageStatus(executed.restarted
          ? { tone: 'ok', text: `${name} · ${t('restartManagedDshOk')}` }
          : { tone: 'warn', text: `${name} · ${t('restartNeededHint')}` })
      } else {
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

  // ---- shared add view ----
  const reloadAfterAdd = useCallback((): void => {
    if (isSsh) void loadSync()
    else if (isLocal) void loadLocalList()
    else setReloadNonce(n => n + 1)
  }, [isSsh, isLocal, loadSync, loadLocalList])

  const installSpec = useCallback(async (raw: string): Promise<void> => {
    const value = raw.trim()
    if (!ADD_SPEC.test(value)) {
      setDraftError(t('pluginsAddSpecInvalid'))
      return
    }
    setInstalling(true)
    setDraftError(null)
    setAddResult(null)
    try {
      if (isSsh && sshSpec !== null) {
        const res = await pluginApply(sshSpec.id, { add: [value], remove: [], restart: false })
        if ('cancelled' in res) { /* silent no-op (user dismissed the main-process confirmation) */ }
        else if ('error' in res) setDraftError(res.error)
        else if (res.result.failed.length > 0 || !res.result.verified) {
          const first = res.result.failed[0]
          setDraftError(first !== undefined ? `${value}${t('partialSep')}${first.error}` : t('pluginsVerifyFailed'))
        } else {
          setAddResult(t('pluginsDeferred'))
          setDraft('')
          reloadAfterAdd()
        }
      } else if (isGateway && gatewayId !== null) {
        const res = await gatewayPluginApply(gatewayId, { add: [value], remove: [], deferRestart: false })
        const outcome = classifyGatewayApplyResult(res, 1)
        if ('cancelled' in outcome) { /* silent no-op */ }
        else if ('failed' in outcome) {
          const counts = partialCounts(outcome)
          const partialText = counts === null || counts.done === 0
            ? ''
            : `${t('partialNofM').replace('{done}', String(counts.done)).replace('{total}', String(counts.total))}${t('partialSep')}`
          setDraftError(`${partialText}${outcome.failed.error}`)
        } else {
          const executed = outcome.executed
          setAddResult(executed.restarted
            ? t('pluginsApplied')
            : executed.deferred
              ? t('pluginsDeferred')
              : t('restartNeededHint'))
          setDraft('')
          reloadAfterAdd()
        }
      } else {
        const res = await localPluginAdd(value)
        if ('error' in res) setDraftError(res.error)
        else if ('cancelled' in res) { /* silent no-op (user dismissed the confirmation) */ }
        else { setAddResult(t('pluginsApplied')); setDraft(''); reloadAfterAdd() }
      }
    } catch (err) {
      setDraftError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }, [isSsh, sshSpec, isGateway, gatewayId, t, reloadAfterAdd])

  const importFolder = useCallback(async (): Promise<void> => {
    setInstalling(true)
    setDraftError(null)
    setAddResult(null)
    try {
      if (isSsh && sshSpec !== null) {
        const res = await pluginMaterializeAddPick(sshSpec.id)
        if ('error' in res) setDraftError(res.error)
        else if ('cancelled' in res) { /* silent no-op (picker dismissed) */ }
        else { setAddResult(t('pluginsDeferred')); reloadAfterAdd() }
      } else if (isGateway && gatewayId !== null) {
        const res = await gatewayPluginMaterialize(gatewayId)
        if ('error' in res) setDraftError(res.error)
        else if ('cancelled' in res) { /* silent no-op (picker dismissed) */ }
        else {
          // deferred = the gateway cached the install intent for the next
          // ready edge (it may run after this desktop disconnects); false =
          // accepted onto the executor (auto restart-to-apply).
          setAddResult(res.deferred === true ? t('deferredOfflineNote') : t('pluginsApplied'))
          reloadAfterAdd()
        }
      } else {
        const res = await localPluginAddFile()
        if ('error' in res) setDraftError(res.error)
        else if ('cancelled' in res) { /* silent no-op (picker dismissed) */ }
        else { setAddResult(t('pluginsApplied')); reloadAfterAdd() }
      }
    } catch (err) {
      setDraftError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }, [isSsh, sshSpec, isGateway, gatewayId, t, reloadAfterAdd])

  const runSearch = useCallback(async (): Promise<void> => {
    const value = searchQuery.trim()
    if (value === '') return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await npmSearch(value)
      if ('error' in res) setSearchError(res.error)
      else setHits(res.packages)
    } catch (err) {
      setSearchError(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }, [searchQuery])

  // ---- ssh sync apply orchestration (design 13 §4.5, unchanged) ----
  const toggleRow = useCallback((name: string): void => {
    if (applyingRef.current) return
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const selected = diff?.rows.filter(row => checked.has(row.name)) ?? []
  const removeRows = selected.filter(row => row.kind === 'extra')
  const changeCount = selected.filter(row => isDifferenceRow(row.kind)).length
  const willRestart = restart && changeCount > 0

  const doApply = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null || diff === null || applyingRef.current) return
    if (seedBusy || restartBusy || remoteRemoveBusy || undoBusy) return
    const sel = diff.rows.filter(row => checked.has(row.name))
    const materializeRows = sel.filter(row => row.kind === 'materialize')
    const add = sel
      .filter(row => row.kind === 'missing' || row.kind === 'update')
      .map(rowAddArg)
    const remove = sel.filter(row => row.kind === 'extra').map(row => row.name)
    applyingRef.current = true
    setPhase('applying')
    setResult(null)
    setResultError(null)
    try {
      // Materialize rows: pack-and-transfer via the desktop IPC — per-row
      // isolation (one failed entity must not block the rest).
      const failed: PluginApplyFailure[] = []
      let applied = 0
      for (const row of materializeRows) {
        const res = await pluginMaterializeAddPick(sshSpec.id)
        if ('error' in res) failed.push({ spec: row.name, error: res.error })
        else if ('cancelled' in res) { /* user dismissed the confirmation: skipped, never counted as applied */ }
        else applied += 1
      }

      // Registry rows + removes ride the existing pluginApply orchestration
      // (remove-first, serial, restart unless deferred, assert, ready recheck).
      if (add.length > 0 || remove.length > 0) {
        const res = await pluginApply(sshSpec.id, { add, remove, restart })
        if ('cancelled' in res) {
          setResult({ applied, failed, skipped: add.length + remove.length, restarted: false, deferred: true, verified: failed.length === 0, ready: null })
        } else if ('error' in res) {
          setResultError(res.error)
          setResult({ applied, failed, skipped: 0, restarted: false, deferred: true, verified: failed.length === 0, ready: null })
        } else {
          setResult({
            applied: applied + res.result.applied,
            failed: [...failed, ...res.result.failed],
            skipped: res.result.skipped,
            restarted: res.result.restarted,
            deferred: res.result.deferred,
            verified: res.result.verified,
            ready: res.result.ready,
          })
        }
      } else {
        setResult({ applied, failed, skipped: 0, restarted: false, deferred: true, verified: failed.length === 0, ready: null })
      }
    } catch (err) {
      setResultError(errorMessage(err))
    } finally {
      applyingRef.current = false
      setRestart(true)
      setPhase('done')
    }
  }, [isSsh, sshSpec, diff, checked, restart, seedBusy, restartBusy, remoteRemoveBusy, undoBusy, t])

  const onApplyClick = useCallback((): void => {
    if (applyingRef.current) return
    if (removeRows.length > 0) { setConfirmRemove(true); return }
    if (willRestart) { setConfirmApply(true); return }
    void doApply()
  }, [removeRows.length, willRestart, doApply])

  const onRemoveConfirm = useCallback((): void => {
    setConfirmRemove(false)
    if (willRestart) { setConfirmApply(true); return }
    void doApply()
  }, [willRestart, doApply])

  const onApplyConfirm = useCallback((): void => {
    setConfirmApply(false)
    void doApply()
  }, [doApply])

  const close = useCallback((): void => {
    if (applyingRef.current) return
    if (confirmRemove || confirmApply || localRemoveTarget !== null || remoteRemoveTarget !== null) return
    if (removeTarget !== null || removeBusy) return
    onClose()
  }, [onClose, confirmRemove, confirmApply, localRemoveTarget, remoteRemoveTarget, removeTarget, removeBusy])

  const label = isLocal ? t('localTitle') : isSsh && sshSpec !== null ? sshSpec.label : target.kind === 'gateway' || target.kind === 'http' ? target.label : ''
  const title = `${t('pluginsTitle')} · ${label}`
  const applying = phase === 'applying'

  // ---- ① diagnostic banner (bannerProjection de-dup) ----
  const diagnosticBanner = diagnostic !== undefined && diagnostic.state !== 'ok'
    ? bannerProjection(diagnostic, t)
    : null

  // ---- ② chamber built-in table ----
  /** The ssh local-side chamber facts (the sync load fills localManifest). */
  const sshLocalChamber = isSsh ? (localManifest === null ? undefined : localManifest.chamber) : undefined
  const sshRemoteChamber = isSsh ? (remoteManifest === null ? undefined : remoteManifest.chamber) : undefined
  const sshHostGraphRemote = sshRemoteChamber === undefined ? undefined : sshRemoteChamber.ok ? sshRemoteChamber.hostGraph : null
  const sshGitRemote = sshRemoteChamber === undefined ? undefined : sshRemoteChamber.ok ? sshRemoteChamber.gitWorktree : null
  // BOTH boot rows must be present for the chamber host layer to be complete.
  const remoteNeedsSeed = isSsh && sshRemoteChamber !== undefined
    && (!sshRemoteChamber.ok
      || !(sshRemoteChamber.hostGraph.installed && sshRemoteChamber.hostGraph.patched)
      || !(sshRemoteChamber.gitWorktree.installed && sshRemoteChamber.gitWorktree.patched))
  const remoteInjectedNotLive = isSsh && sshRemoteChamber?.ok === true
    && sshRemoteChamber.hostGraph.installed && sshRemoteChamber.hostGraph.patched && sshRemoteChamber.hostGraph.live === false
  const remoteGitNotLive = isSsh && sshRemoteChamber?.ok === true
    && sshRemoteChamber.gitWorktree.installed && sshRemoteChamber.gitWorktree.patched && sshRemoteChamber.gitWorktree.live === false
  const restartPending = remoteInjectedNotLive || remoteGitNotLive || pendingRestart

  // Gateway seed-cache drift (local manifest vs gateway cache); http-direct
  // and non-gateway backends have no /chamber surface → null.
  const driftStates = isGateway && seedCache !== null && localVersion !== null
    ? chamberSeedDrift(localVersion, seedCache)
    : null
  const bothAbsent = seedCache !== null
    && (seedCache[HOST_GRAPH_PACKAGE] ?? null) === null
    && (seedCache[GIT_WORKTREE_PACKAGE] ?? null) === null

  /** One gateway row's version cell: local version + the cached gateway
   *  version with a drift marker when it differs (the「重新同步」gap) — `· 未
   *  同步` when the cache lacks the package (suppressed while the whole
   *  cache is absent). */
  const gatewayVersionCell = (packageName: string, driftState: ChamberSeedDriftState | null): ReactNode => {
    const localFor = packageName === HOST_GRAPH_PACKAGE
      ? (localVersion?.hostGraph ?? null)
      : (localVersion?.gitWorktree ?? null)
    const cachedVersion = seedCache === null ? null : (seedCache[packageName] ?? null)
    return (
      <span className={css.chamberCell}>
        {localFor !== null ? <span className={css.dim}>v{localFor}</span> : <span className={css.dim}>—</span>}
        {seedCache === null
          ? null
          : cachedVersion === null
            ? (!bothAbsent ? <span className={css.dim}> · {t('chamberNotSynced')}</span> : null)
            : (
              <>
                <span className={css.dim}> · gateway v{cachedVersion}</span>
                {driftState === 'drift'
                  ? (
                    <span
                      className={css.pluginWarn}
                      title={`${t('chamberVersionDrift')}: v${localFor ?? '?'} ≠ gateway v${cachedVersion}`}
                    >
                      {t('chamberVersionDrift')}
                    </span>
                  )
                  : null}
              </>
            )}
      </span>
    )
  }

  /** The chamber rows for the current backend (plan 24 B1.5): package |
   *  local badge | remote/gateway badge | version; mobile for gateway only. */
  const chamberRows: ChamberRowView[] = ((): ChamberRowView[] => {
    if (isLocal) {
      const ch = localList?.chamber
      const injectedOf = (pkg: 'hostGraph' | 'gitWorktree'): boolean | null =>
        ch === undefined ? null : ch.ok ? ch[pkg].installed && ch[pkg].patched : false
      return [
        {
          key: 'host-graph',
          nameCell: <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>,
          localBadge: localChamberBadge(injectedOf('hostGraph'), false),
          remoteBadge: null,
          versionCell: ch?.ok === true
            ? <span className={css.dim}>v{ch.hostGraph.version}</span>
            : <span className={css.dim}>—</span>,
        },
        {
          key: 'git-worktree',
          nameCell: <code className={css.pluginName}>{GIT_WORKTREE_PACKAGE}</code>,
          localBadge: localChamberBadge(injectedOf('gitWorktree'), false),
          remoteBadge: null,
          versionCell: ch?.ok === true
            ? <span className={css.dim}>v{ch.gitWorktree.version}</span>
            : <span className={css.dim}>—</span>,
        },
      ]
    }
    if (isSsh) {
      const ch = sshLocalChamber
      const injectedOf = (pkg: 'hostGraph' | 'gitWorktree'): boolean | null =>
        ch === undefined ? null : ch.ok ? ch[pkg].installed && ch[pkg].patched : false
      const versionOf = (pkg: 'hostGraph' | 'gitWorktree'): string | null =>
        ch?.ok === true ? ch[pkg].version : sshRemoteChamber?.ok === true ? sshRemoteChamber[pkg].version : null
      return [
        {
          key: 'host-graph',
          nameCell: <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>,
          localBadge: localChamberBadge(injectedOf('hostGraph'), localFailed),
          remoteBadge: sshRemoteBadge(sshHostGraphRemote),
          versionCell: versionOf('hostGraph') !== null
            ? <span className={css.dim}>v{versionOf('hostGraph')}</span>
            : <span className={css.dim}>—</span>,
        },
        {
          key: 'git-worktree',
          nameCell: <code className={css.pluginName}>{GIT_WORKTREE_PACKAGE}</code>,
          localBadge: localChamberBadge(injectedOf('gitWorktree'), localFailed),
          remoteBadge: sshRemoteBadge(sshGitRemote),
          versionCell: versionOf('gitWorktree') !== null
            ? <span className={css.dim}>v{versionOf('gitWorktree')}</span>
            : <span className={css.dim}>—</span>,
        },
      ]
    }
    // gateway / http-direct: the Loader inventory answers the remote badges;
    // only gateway has the seed-cache drift surface.
    const entries = snapshot?.entries ?? []
    const rows: ChamberRowView[] = [
      {
        key: 'host-graph',
        nameCell: <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>,
        localBadge: localChamberBadge(localInjected?.hostGraph ?? null, localSideFailed),
        remoteBadge: remoteChamberBadge(entries, HOST_GRAPH_PACKAGE),
        versionCell: isGateway
          ? gatewayVersionCell(HOST_GRAPH_PACKAGE, driftStates?.hostGraph ?? null)
          : localVersion?.hostGraph != null
            ? <span className={css.dim}>v{localVersion.hostGraph}</span>
            : <span className={css.dim}>—</span>,
      },
      {
        key: 'git-worktree',
        nameCell: <code className={css.pluginName}>{GIT_WORKTREE_PACKAGE}</code>,
        localBadge: localChamberBadge(localInjected?.gitWorktree ?? null, localSideFailed),
        remoteBadge: remoteChamberBadge(entries, GIT_WORKTREE_PACKAGE),
        versionCell: isGateway
          ? gatewayVersionCell(GIT_WORKTREE_PACKAGE, driftStates?.gitWorktree ?? null)
          : localVersion?.gitWorktree != null
            ? <span className={css.dim}>v{localVersion.gitWorktree}</span>
            : <span className={css.dim}>—</span>,
      },
    ]
    if (isGateway) {
      rows.push({
        key: 'mobile',
        nameCell: (
          <span className={css.chamberCell}>
            {t('chamberMobileRow')}
            <code className={css.pluginName}>{MOBILE_PACKAGE}</code>
          </span>
        ),
        localBadge: null,
        remoteBadge: remoteChamberBadge(entries, MOBILE_PACKAGE),
        versionCell: <span className={css.dim}>{t('chamberMobileHint')}</span>,
      })
    }
    return rows
  })()

  const chamberZone = (
    <div className={css.pluginChamber}>
      <p className={css.pluginChamberTitle}>
        {t('chamberInjectedTitle')}
        <span className={css.dim}> · {t('chamberInjectedHint')}</span>
        {/* chamber 区降级标签：seed-cache 读失败 = 该区数据源不可达（实例停机
            / 代理拒绝）——区标题如实标注，不静默。 */}
        {isGateway && seedCacheError !== null
          ? <span className={css.error}> · {t('instanceNotReadyZone')}</span>
          : null}
      </p>
      {isGateway && seedCacheError !== null ? <p className={css.error} role="alert">{seedCacheError}</p> : null}
      {isGateway && bothAbsent ? <p className={css.hint} role="status">{t('chamberSeedCacheAbsent')}</p> : null}
      <div className={css.chamberTable}>
        <div className={clsx(css.chamberTableRow, css.chamberTableHead)}>
          <span>{t('pluginsColName')}</span>
          <span>{t('pluginsLocalCol')}</span>
          <span>{t('pluginsRemoteCol')}</span>
          <span>{t('pluginsColVersion')}</span>
        </div>
        {chamberRows.map(row => (
          <div key={row.key} className={css.chamberTableRow}>
            <span className={css.chamberCell}>{row.nameCell}</span>
            <span className={css.chamberCell}>
              {row.localBadge !== null
                ? <span className={chamberBadgeClass(row.localBadge.tone)}>{t(row.localBadge.labelKey)}</span>
                : <span className={css.dim}>—</span>}
            </span>
            <span className={css.chamberCell}>
              {row.remoteBadge !== null
                ? <span className={chamberBadgeClass(row.remoteBadge.tone)}>{t(row.remoteBadge.labelKey)}</span>
                : <span className={css.dim}>—</span>}
            </span>
            {row.versionCell}
          </div>
        ))}
      </div>
      {isGateway
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
      {isGateway && syncError !== null
        ? <p className={css.error} role="alert">{t('chamberSyncFailed')}{syncError}</p>
        : null}
      {isGateway && syncNote !== null ? <p className={css.hint} role="status">{syncNote}</p> : null}
      {isSsh && remoteNeedsSeed
        ? (
          <button
            type="button"
            className={css.chamberSeedButton}
            disabled={seedBusy}
            onClick={() => { void doSeedHostGraph() }}
          >
            {seedBusy ? t('chamberSeeding') : t('chamberSeed')}
          </button>
        )
        : isSsh && restartPending
          ? (
            <button
              type="button"
              className={css.chamberSeedButton}
              disabled={restartBusy || seedBusy}
              onClick={() => { void doRestartNow() }}
            >
              {restartBusy ? t('restartManagedDshBusy') : t('restartApplyInPanel')}
            </button>
          )
          : null}
      {isSsh && seedError !== null ? <p className={css.error} role="alert">{t('chamberSeedFailed')}{seedError}</p> : null}
      {isSsh && restartError !== null ? <p className={css.error} role="alert">{t('chamberRestartFailed')}{restartError}</p> : null}
      {isSsh && sshRemoteChamber !== undefined && !sshRemoteChamber.ok
        ? <p className={css.error} role="alert">{sshRemoteChamber.error}</p>
        : null}
      {(isGateway || isHttp) && localSideFailed ? <p className={css.hint}>{t('pluginsStartLocalFirst')}</p> : null}
    </div>
  )

  // ---- ③ third-party zone ----
  /** The add section (spec + npm search + folder import) for the three
   *  writable backends; http-direct renders no add surface (design 21 §3). */
  const addSection = isHttp
    ? null
    : (
      <div className={css.pluginAdd}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('pluginsAddSpec')}</span>
          <input
            className={css.input}
            value={draft}
            spellCheck={false}
            disabled={installing}
            placeholder={t('pluginsAddSpecPlaceholder')}
            onChange={event => { setDraft(event.target.value); setDraftError(null) }}
            onKeyDown={event => { if (event.key === 'Enter' && !installing) void installSpec(draft) }}
          />
          {draftError !== null ? <span className={css.error} role="alert">{draftError}</span> : null}
          {addResult !== null && draftError === null ? <span className={css.hint}>{addResult}</span> : null}
        </label>
        <div className={css.pluginAddActions}>
          {/* installing 态按钮文案原样继承旧 PluginAddView.tsx:151（合并前基线：
              busyTasks=「正在执行变更…」作安装中按钮文案，语义偏宽但属既有
              继承，非本轮新引入——保留不动）。 */}
          <Button variant="primary" size="sm" disabled={installing} onClick={() => { void installSpec(draft) }}>
            {installing ? t('busyTasks') : t('pluginsAddInstall')}
          </Button>
        </div>

        <div className={css.pluginSearch}>
          <span className={css.fieldLabel}>{t('pluginsAddSearch')}</span>
          <div className={css.pluginSearchRow}>
            <input
              className={css.input}
              value={searchQuery}
              spellCheck={false}
              disabled={searching}
              placeholder={t('pluginsAddSearchPlaceholder')}
              onChange={event => { setSearchQuery(event.target.value) }}
              onKeyDown={event => { if (event.key === 'Enter' && !searching) void runSearch() }}
            />
            <Button variant="outline" size="sm" disabled={searching || searchQuery.trim() === ''} onClick={() => { void runSearch() }}>
              {searching ? t('loading') : t('pluginsAddSearch')}
            </Button>
          </div>
          <p className={css.dim}>{t('pluginsAddSearchHint')}</p>
          {searchError !== null ? <p className={css.error} role="alert">{searchError}</p> : null}
          {hits.length > 0
            ? (
              <ul className={css.pluginHits}>
                {hits.map(hit => (
                  <li key={hit.name} className={css.pluginHit}>
                    <code className={css.mono}>{hit.name}</code>
                    <span className={css.pluginHitVersion}>{hit.version}</span>
                    {hit.description !== undefined && hit.description !== '' ? <span className={css.dim}>{hit.description}</span> : null}
                    <span className={css.footSpacer} />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={installing}
                      onClick={() => { void installSpec(`${hit.name}@${hit.version}`) }}
                    >
                      {t('pluginsAddInstall')}
                    </Button>
                  </li>
                ))}
              </ul>
            )
            : null}
        </div>

        <div className={css.pluginFolder}>
          <Button variant="ghost" size="sm" disabled={installing} onClick={() => { void importFolder() }}>
            {t('pluginsAddFolder')}
          </Button>
        </div>
      </div>
    )

  /** Local installed list + add (the converged local region, plan 24 B1.1:
   *  the former list tab and add tab stacked in one zone). */
  const localZone = isLocal
    ? ((): ReactNode => {
      if (localLoading) return <p className={css.dim}>{t('loading')}</p>
      if (localListError !== null) {
        return (
          <div className={css.pluginStack}>
            <p className={css.error} role="alert">{localListError}</p>
            <div>
              <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadLocalList() }}>{t('pluginsRetry')}</Button>
            </div>
          </div>
        )
      }
      if (localList === null) return null
      const deps = Object.entries(localList.dependencies)
      return (
        <div className={css.pluginStack}>
          <p className={css.pluginChamberTitle}>{t('installedTab')}</p>
          {localRemoveError !== null ? <p className={css.error} role="alert">{localRemoveError}</p> : null}
          {deps.length === 0 && localList.unsyncable.length === 0
            ? <p className={css.dim}>{t('pluginsNoLocalPlugins')}</p>
            : (
              <div className={css.pluginRows}>
                <div className={clsx(css.pluginRow, css.pluginRowLocal, css.pluginRowHead)}>
                  <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                  <span className={css.pluginCellCat}>{t('pluginsColCategory')}</span>
                  <span className={css.pluginCellSpec}>{t('pluginsLocalCol')}</span>
                  <span className={css.pluginCellCat} />
                </div>
                {deps.map(([name, spec]) => {
                  const rowCategory = localList.bundles.includes(name) ? 'bundle' : localList.clientLines.includes(name) ? 'client' : 'plain'
                  const unsync = localList.unsyncable.find(item => item.name === name)
                  return (
                    <div key={name} className={clsx(css.pluginRow, css.pluginRowLocal, unsync !== undefined && css.pluginRowGray)}>
                      <label className={clsx(css.pluginCell, css.pluginCellName)}>
                        <code className={css.pluginName}>{name}</code>
                      </label>
                      <span className={clsx(css.pluginCell, css.pluginCellCat)}>
                        <span className={clsx(css.pluginKindBadge, rowCategory === 'bundle' && css.pluginKindBundle, rowCategory === 'client' && css.pluginKindClient, rowCategory === 'plain' && css.pluginKindPlain)}>
                          {t(categoryLabel(rowCategory))}
                        </span>
                      </span>
                      <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                        <code className={css.pluginSpec} title={unsync?.reason}>{spec}</code>
                        {unsync !== undefined ? <span className={css.pluginKindUnsync}> · {t('pluginsRowUnsyncable')}</span> : null}
                      </span>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={localRemoveBusy || applying}
                        data-tip={t('pluginsRemoveRow')}
                        aria-label={`${t('pluginsRemoveRow')}: ${name}`}
                        onClick={() => { setLocalRemoveTarget(name); setLocalRemoveError(null) }}
                      >
                        <IconTrashOutline16 />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          {addSection}
        </div>
      )
    })()
    : null

  /** The gateway third-party zone (installed list + per-row remove + add). */
  const gatewayZone = isGateway
    ? ((): ReactNode => {
      const opsBlocked = removeBusy || restarting || syncing
      const installedRows = installed !== null && installed.ok === true
        ? filterDeniedRows(Object.entries(installed.dependencies).map(([name, spec]) => ({ name, spec }))).allowed
        : []
      const statusTone = manageStatus?.tone
      return (
        <div className={css.pluginStack}>
          <p className={css.pluginChamberTitle}>{t('installedTab')}</p>
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
                      ? (
                        <>
                          <p className={css.dim}>{t('installedEmpty')}</p>
                          <p className={css.dim}>{t('installedAddHint')}</p>
                        </>
                      )
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
          {addSection}
        </div>
      )
    })()
    : null

  /** http-direct: read-only Loader third-party entries (no /chamber
   *  surface, no add surface — design 21 §3 backend matrix). The
   *  third-party projection is the shared pure function (mobile + official
   *  + chamber rows excluded). */
  const httpZone = isHttp
    ? ((): ReactNode => {
      if (viewPhase === 'loading') return <p className={css.dim}>{t('pluginsLoading')}</p>
      if (viewPhase === 'error') {
        return <p className={css.error} role="alert">{viewError !== null ? viewError : t('inventoryError')}</p>
      }
      if (snapshot === null) return <p className={css.dim}>{t('inventoryError')}</p>
      const thirdParty = thirdPartyEntries(snapshot)
      if (thirdParty.length === 0) return <p className={css.dim}>{t('inventoryNoThirdParty')}</p>
      return (
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
      )
    })()
    : null

  // ---- ④ recovery row (gateway only, runtimeDown-gated) ----
  /** The recovery undo affordance (plan 24 B1.6): only while the managed dsh
   *  is down (stopped/error/restart-exhausted, as the card projects it) AND
   *  the task journal's newest ok op is undoable (undoForLatest). The tasks
   *  read is the ONLY journal consumer — no task rows render (D4-A). */
  const recoveryUndo = useMemo(() => {
    if (!isGateway || runtimeDown !== true || taskRows === null) return null
    const undo = undoForLatest(taskRows)
    return undo.action === null ? null : undo.action
  }, [isGateway, runtimeDown, taskRows])

  const recoveryZone = isGateway && runtimeDown === true
    ? ((): ReactNode => {
      // Journal unreadable while the instance is down: say so — the undo
      // affordance must never silently vanish (proxy honesty).
      if (recoveryUndo === null) {
        return taskRows === null && tasksError !== null
          ? <p className={css.error} role="alert">{tasksError}</p>
          : null
      }
      return (
        <div className={css.recoveryBanner} role="status">
          <span>{t('recoveryUndoBanner')}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={removeBusy || restarting || syncing}
            onClick={() => { setManageStatus(null); setRemoveTarget(recoveryUndo.name); setRemoveOrigin('undo') }}
          >
            {t('recoveryUninstallRestart')}
          </Button>
        </div>
      )
    })()
    : null

  // ---- ssh views (byte-preserved from the sync modal) ----
  function renderSyncView(): ReactNode {
    if (phase === 'loading') {
      return <p className={css.dim}>{t('pluginsLoading')}</p>
    }
    if (phase === 'error') {
      return (
        <div className={css.pluginStack}>
          {localFailed ? <p className={css.hint}>{t('pluginsStartLocalFirst')}</p> : null}
          {loadError !== null ? <p className={css.error} role="alert">{loadError}</p> : null}
        </div>
      )
    }
    if (phase === 'applying') {
      return (
        <div className={css.pluginStack}>
          <p className={css.dim}>{t('busyTasks')}</p>
          <p className={css.hint}>{t('pluginsApply')} {changeCount}</p>
        </div>
      )
    }
    if (phase === 'done') {
      return renderResult()
    }
    // ready
    return renderTable()
  }

  function renderTable(): ReactNode {
    if (diff === null) return null
    const total = diff.rows.length
    const differenceCount = diff.rows.filter(row => isDifferenceRow(row.kind)).length
    const hasLocal = Object.keys(localManifest?.dependencies ?? {}).length > 0
    const visibleRows = diff.rows.filter(row => {
      if (query !== '' && !row.name.toLowerCase().includes(query.trim().toLowerCase())) return false
      if (category !== 'all' && row.category !== category) return false
      if (status === 'diff' && !isDifferenceRow(row.kind)) return false
      return true
    })
    return (
      <div className={css.pluginStack}>
        {profileNotInit ? <p className={css.pluginBanner} role="status">{t('pluginsProfileNotInitialized')}</p> : null}
        {total === 0
          ? <p className={css.dim}>{t('pluginsNoThirdParty')}</p>
          : (
            <>
              {!hasLocal ? <p className={css.hint}>{t('pluginsNoLocalPlugins')}</p> : null}
              {differenceCount === 0 ? <p className={css.dim}>{t('pluginsNoDiff')}</p> : null}

              <div className={css.pluginToolbar}>
                <input
                  className={clsx(css.input, css.pluginSearchInput)}
                  value={query}
                  spellCheck={false}
                  placeholder={t('pluginsSearchPlaceholder')}
                  onChange={event => { setQuery(event.target.value) }}
                />
                <div className={css.pluginFilterGroup}>
                  <span className={css.pluginFilterLabel}>{t('pluginsCatAll')}</span>
                  {(['all', 'bundle', 'plain', 'client'] as const).map(c => (
                    <button
                      key={c}
                      type="button"
                      className={clsx(css.pluginPill, category === c && css.pluginPillActive)}
                      onClick={() => { setCategory(c) }}
                    >
                      {c === 'all' ? t('pluginsFilterAll') : t(categoryLabel(c))}
                    </button>
                  ))}
                </div>
                <div className={css.pluginFilterGroup}>
                  <span className={css.pluginFilterLabel}>{t('pluginsFilterDiff')}</span>
                  {(['diff', 'all'] as const).map(s => (
                    <button
                      key={s}
                      type="button"
                      className={clsx(css.pluginPill, status === s && css.pluginPillActive)}
                      onClick={() => { setStatus(s) }}
                    >
                      {t(s === 'diff' ? 'pluginsFilterDiff' : 'pluginsFilterAll')}
                    </button>
                  ))}
                </div>
              </div>

              {visibleRows.length === 0
                ? <p className={css.dim}>{t('pluginsNoMatch')}</p>
                : (
                  <div className={css.pluginRows}>
                    <div className={clsx(css.pluginRow, css.pluginRowHead)}>
                      <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                      <span className={css.pluginCellCat}>{t('pluginsColCategory')}</span>
                      <span className={css.pluginCellKind}>{t('pluginsColStatus')}</span>
                      <span className={css.pluginCellSpec}>{t('pluginsLocalCol')}</span>
                      <span className={css.pluginCellSpec}>{t('pluginsRemoteCol')}</span>
                    </div>
                    {visibleRows.map(row => renderRow(row))}
                  </div>
                )}
            </>
          )}
      </div>
    )
  }

  function renderRow(row: PluginRow): ReactNode {
    const actionable = isActionable(row.kind)
    const isExtra = row.kind === 'extra'
    const isUnsync = row.kind === 'unsyncable'
    const isChecked = checked.has(row.name)
    const isUpdate = row.kind === 'update'

    return (
      <div
        key={row.name}
        className={clsx(css.pluginRow, isUnsync && css.pluginRowGray)}
      >
        <label className={clsx(css.pluginCell, css.pluginCellName)}>
          {actionable
            ? <input type="checkbox" className={css.pluginCheckbox} checked={isChecked} disabled={applying} onChange={() => { toggleRow(row.name) }} />
            : null}
          <code className={css.pluginName} title={row.reason ?? row.name}>{row.name}</code>
        </label>
        <span className={clsx(css.pluginCell, css.pluginCellCat)}>
          <span className={clsx(css.pluginKindBadge, row.category === 'bundle' && css.pluginKindBundle, row.category === 'client' && css.pluginKindClient, row.category === 'plain' && css.pluginKindPlain)}>
            {t(categoryLabel(row.category))}
          </span>
        </span>
        <span className={clsx(css.pluginCell, css.pluginCellKind)}>
          <span className={clsx(css.pluginKind, isUnsync && css.pluginKindUnsync)}>{t(kindLabel(row.kind))}</span>
        </span>
        <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
          <code className={css.pluginSpec}>{row.localSpec ?? '—'}</code>
          {row.unlocked ? <span className={css.dim}> {t('pluginsUnlockedLatest')}</span> : null}
        </span>
        <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
          {isUpdate ? <span className={css.pluginArrow}>→</span> : null}
          <code className={css.pluginSpec}>{row.remoteSpec ?? '—'}</code>
          {row.kind === 'materialize' ? <span className={css.dim}> · {t('pluginsRowMaterialize')}</span> : null}
        </span>
        {isExtra && isChecked ? <p className={css.pluginRisk}>{t('pluginsRemoveRisk')}</p> : null}
      </div>
    )
  }

  function renderResult(): ReactNode {
    const r = result
    return (
      <div className={css.pluginStack}>
        {resultError !== null ? <p className={css.error} role="alert">{resultError}</p> : null}
        {r === null
          ? null
          : (
            <>
              <p className={css.pluginSummary}>
                {t('pluginsApplied')} {r.applied} · {t('pluginsFailed')} {r.failed.length} · {t('pluginsSkipped')} {r.skipped}
              </p>
              {r.failed.length > 0
                ? (
                  <ul className={css.pluginFailedList}>
                    {r.failed.map(item => (
                      <li key={item.spec} className={css.pluginFailedItem}>
                        <code className={css.mono}>{item.spec}</code>
                        <span className={css.error}>{item.error}</span>
                      </li>
                    ))}
                  </ul>
                )
                : null}
              {r.restarted ? <p className={css.hint}>{t('pluginsRestarted')}</p> : null}
              {r.deferred ? <p className={css.hint}>{t('pluginsDeferred')}</p> : null}
              {!r.deferred && !r.restarted && r.applied > 0
                ? (
                  <p className={css.pluginWarn}>
                    {sshSpec !== null && sshSpec.serviceName === null ? t('pluginsRestartUnconfigured') : t('pluginsRestartFailed')}
                  </p>
                )
                : null}
              {!r.verified ? <p className={css.error} role="alert">{t('pluginsVerifyFailed')}</p> : null}
              {r.ready === false ? <p className={css.error} role="alert">{t('pluginsReadyFailed')}</p> : null}
              {r.restarted && r.ready === null && r.readyNote !== undefined
                ? <p className={css.hint}>{r.readyNote}</p>
                : null}
            </>
          )}
      </div>
    )
  }

  /** The ssh installed-plugins list (design 21 §6.6 list tab, byte-preserved:
   *  per-row remove + the「撤销最近变更」toolbar entry). */
  function renderRemoteList(): ReactNode {
    if (phase === 'loading' || phase === 'error') return renderSyncView()
    if (remoteManifest === null) return <p className={css.dim}>{t('pluginsLoading')}</p>
    const deps = Object.entries(remoteManifest.dependencies)
      .filter(([name]) => !isDeniedPluginName(name))
    const opBusy = remoteRemoveBusy || undoBusy
    const opsBlocked = opBusy || applying || seedBusy || restartBusy
    const statusTone = remoteListStatus?.tone
    return (
      <div className={css.pluginStack}>
        {profileNotInit ? <p className={css.pluginBanner} role="status">{t('pluginsProfileNotInitialized')}</p> : null}
        <div className={css.pluginToolbar}>
          <Button variant="ghost" size="sm" disabled={opsBlocked} onClick={() => { void doUndo() }}>
            {t('undoAvailable')}
          </Button>
        </div>
        {remoteListStatus !== null
          ? (
            <p className={remoteStatusClass(statusTone ?? 'ok')} role={statusTone === 'error' ? 'alert' : 'status'}>
              {remoteListStatus.text}
            </p>
          )
          : null}
        {profileNotInit
          ? null
          : deps.length === 0
            ? <p className={css.dim}>{t('installedEmpty')}</p>
            : (
              <div className={css.pluginRows}>
                <div className={clsx(css.pluginRow, css.pluginRowRemote, css.pluginRowHead)}>
                  <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                  <span className={css.pluginCellSpec}>{t('pluginsRemoteCol')}</span>
                  <span className={css.pluginCellCat} />
                </div>
                {deps.map(([name, spec]) => (
                  <Fragment key={name}>
                    <div className={clsx(css.pluginRow, css.pluginRowRemote)}>
                      <label className={clsx(css.pluginCell, css.pluginCellName)}>
                        <code className={css.pluginName}>{name}</code>
                      </label>
                      <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                        {spec.startsWith('file:')
                          ? <span className={clsx(css.pluginKindBadge, css.pluginKindPlain)}>{t('installedFromMask')}</span>
                          : <code className={css.pluginSpec}>{spec}</code>}
                      </span>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={opsBlocked}
                        data-tip={t('pluginsRemoveRow')}
                        aria-label={`${t('pluginsRemoveRow')}: ${name}`}
                        onClick={() => { setRemoteRemoveTarget(name) }}
                      >
                        <IconTrashOutline16 />
                      </button>
                    </div>
                    {remoteRowErrors[name] !== undefined
                      ? <p className={css.error} role="alert">{remoteRowErrors[name]}</p>
                      : null}
                  </Fragment>
                ))}
              </div>
            )}
      </div>
    )
  }

  const footer = ((): ReactNode => {
    if (isLocal) return undefined
    if (isSsh) {
      if (phase === 'loading') return undefined
      if (phase === 'error') {
        return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync(); onRecheckDiagnostic?.() }}>{t('pluginsRetry')}</Button>
      }
      if (phase === 'applying') {
        return <Button variant="outline" disabled>{t('busyTasks')}</Button>
      }
      if (phase === 'done') {
        return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync(); onRecheckDiagnostic?.() }}>{t('pluginsRefresh')}</Button>
      }
      return (
        <>
          <Button variant="outline" onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={changeCount === 0 || seedBusy || restartBusy} onClick={onApplyClick}>
            {t('pluginsApply')} {changeCount > 0 ? `${changeCount}` : ''}
          </Button>
        </>
      )
    }
    // gateway / http-direct
    if (viewPhase === 'loading') return undefined
    return (
      <>
        <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { setReloadNonce(n => n + 1) }}>
          {viewPhase === 'error' ? t('pluginsRetry') : t('pluginsRefresh')}
        </Button>
        {isGateway
          ? (
            <Button variant="outline" disabled={restarting || syncing || removeBusy} onClick={() => { void restartManagedDsh() }}>
              {restarting ? t('restartManagedDshBusy') : t('restartApplyInPanel')}
            </Button>
          )
          : null}
      </>
    )
  })()

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
        {diagnosticBanner !== null
          ? (
            <p
              className={clsx(
                css.pluginDiagnostic,
                css.pluginDiagnosticDetail,
                diagnostic !== undefined && pluginDiagnosticTone(diagnostic.state) === 'problem' ? css.pluginDiagnosticProblem : css.pluginDiagnosticInfo,
              )}
              role="status"
            >
              <strong>{diagnosticBanner.title}</strong>
              {diagnosticBanner.detail !== null ? <span>：{diagnosticBanner.detail}</span> : null}
            </p>
          )
          : null}
        {(isGateway || isHttp) && restartNote !== null
          ? restartNote.tone === 'error'
            ? <p className={css.error} role="alert">{restartNote.text}</p>
            : <p className={css.hint} role="status">{restartNote.text}</p>
          : null}

        <div className={css.pluginManageSections}>
          {chamberZone}

          {isSsh
            ? (
              <div className={css.pluginStack}>
                <div className={css.pluginTabs}>
                  {(['sync', 'add', 'list'] as const).map(id => (
                    <button
                      key={id}
                      type="button"
                      className={clsx(css.pluginTab, tab === id && css.pluginTabActive)}
                      disabled={applying}
                      onClick={() => { setTab(id) }}
                    >
                      {t(id === 'sync' ? 'pluginsSyncTab' : id === 'add' ? 'pluginsAddTab' : 'installedTab')}
                    </button>
                  ))}
                </div>
                {tab === 'add'
                  ? addSection
                  : tab === 'list'
                    ? renderRemoteList()
                    : renderSyncView()}
              </div>
            )
            : null}

          {isLocal ? localZone : null}
          {isGateway ? gatewayZone : null}
          {isHttp ? httpZone : null}

          {recoveryZone}
        </div>
      </Modal>

      <Modal
        open={confirmRemove}
        onClose={() => { setConfirmRemove(false) }}
        title={t('pluginsApplyTitle')}
        closeLabel={t('close')}
        description={t('pluginsRemoveRisk')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</Button>
            <Button variant="outline" className={css.deleteConfirm} onClick={onRemoveConfirm}>{t('deleteConfirm')}</Button>
          </>
        )}
      />

      <Modal
        open={confirmApply}
        onClose={() => { setConfirmApply(false) }}
        title={t('pluginsApplyTitle')}
        closeLabel={t('close')}
        description={t('pluginsRestartWarning')}
        className={css.dialog}
        footer={(
          <>
            <Button variant="outline" autoFocus onClick={() => { setConfirmApply(false) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={onApplyConfirm}>{t('pluginsApply')}</Button>
          </>
        )}
      >
        <label className={css.pluginDeferRow}>
          <input type="checkbox" checked={!restart} onChange={event => { setRestart(!event.target.checked) }} />
          <span>{t('pluginsDeferRestart')}</span>
        </label>
      </Modal>

      <Modal
        open={localRemoveTarget !== null}
        onClose={() => { if (!localRemoveBusy) setLocalRemoveTarget(null) }}
        title={t('pluginsLocalRemoveTitle')}
        closeLabel={t('close')}
        description={t('pluginsLocalRemoveDescription')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={localRemoveBusy} onClick={() => { setLocalRemoveTarget(null) }}>{t('cancel')}</Button>
            <Button variant="outline" className={css.deleteConfirm} disabled={localRemoveBusy} onClick={() => { void confirmLocalRemove() }}>
              {localRemoveBusy ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      />

      {/* Per-row remove confirm on the ssh installed list (design 21 §6.6):
          mirrors the local-remove pattern; the same 重启生效 checkbox state
          the sync apply flow uses governs the restart. */}
      <Modal
        open={remoteRemoveTarget !== null}
        onClose={() => { if (!remoteRemoveBusy) setRemoteRemoveTarget(null) }}
        title={t('removeRowConfirmTitle')}
        closeLabel={t('close')}
        description={t('removeRowConfirmDescription').replace('{name}', remoteRemoveTarget ?? '')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={remoteRemoveBusy} onClick={() => { setRemoteRemoveTarget(null) }}>{t('cancel')}</Button>
            <Button variant="outline" className={css.deleteConfirm} disabled={remoteRemoveBusy} onClick={() => { void confirmRemoteRemove() }}>
              {remoteRemoveBusy ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      >
        <label className={css.pluginDeferRow}>
          <input type="checkbox" checked={!restart} disabled={remoteRemoveBusy} onChange={event => { setRestart(!event.target.checked) }} />
          <span>{t('pluginsDeferRestart')}</span>
        </label>
      </Modal>

      {/* Row-remove / undo confirm (gateway, Phase 5 ③): shared by both
          origins — the undo confirm mirrors the ssh list's remove confirm
          copy (removing the name the undo derives IS a removal). */}
      {isGateway
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
        : null}
    </>
  )
}
