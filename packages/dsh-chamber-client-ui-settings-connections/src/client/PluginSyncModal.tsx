/**
 * Plugin management dialog (design 13 §5): the per-instance plugin surface.
 *
 * Remote instances get a three-view sync flow (loading → error ⇄ ready →
 * applying → done) plus an "add" tab; the local instance is the source, so it
 * gets a list (local_plugin_list + local remove) plus the "add" tab. The sync
 * view is a pure projection: plugin-diff.ts computes the rows; registry rows
 * (missing/update) and removes forward through pluginApply, materialize rows
 * (local path specs) forward through pluginMaterializeAdd — the main process
 * re-validates every spec, execs serially (remove before add), restarts
 * (unless deferred), asserts, and re-checks readiness (§4.5). No host frames,
 * no execution here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutline16, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberHostGraphState, LocalPluginManifest, PluginApplyFailure, PluginApplyResult, RemotePluginManifest, SshInstanceSpec } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { localPluginList, localPluginRemove, pluginApply, pluginList, pluginMaterializeAdd, restartService, seedHostGraph } from './control-plane.ts'
import {
  computePluginDiff, defaultChecked, isDifferenceRow, rowAddArg,
  type PluginDiff, type PluginRow, type PluginRowKind,
} from './plugin-diff.ts'
import { PluginAddView } from './PluginAddView.tsx'
import { pluginDiagnosticText, pluginDiagnosticTone, type PluginDiagnostic } from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

type PluginPhase = 'loading' | 'error' | 'ready' | 'applying' | 'done'
type PluginTab = 'sync' | 'list' | 'add'
type CategoryFilter = 'all' | 'bundle' | 'plain' | 'client'
type StatusFilter = 'diff' | 'all'

/** The chamber-injected host package surfaced as a non-actionable info row
 *  (design 09 方案 A, module A) — the single source of truth for the name is
 *  plugin-sync.ts CLIENT_GRAPH_PACKAGE_NAME. */
const HOST_GRAPH_PACKAGE = '@dsh-chamber/dsh-host-client-graph'
const GIT_WORKTREE_PACKAGE = '@dsh-chamber/dsh-host-git-worktree'

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

/**
 * The plugin management modal.
 * @param props.t - bound translate.
 * @param props.spec - remote instance spec, or null for the local instance.
 * @param props.diagnostic - this instance's client-plugin runtime diagnostic
 *   (design 09 §3.5): the modal is the detail surface — status, plugin id and
 *   reason — that instance cards deliberately keep short.
 * @param props.onClose - close (ignored while applying, §5.7).
 */
export function PluginSyncModal({ t, spec, diagnostic, onClose }: {
  t: (key: SettingsConnectionsKey) => string
  spec: SshInstanceSpec | null
  diagnostic?: PluginDiagnostic | undefined
  onClose: () => void
}): ReactNode {
  const isRemote = spec !== null
  const [tab, setTab] = useState<PluginTab>(isRemote ? 'sync' : 'list')

  // ---- remote sync three-view state ----
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
   * Reload the sync projection. `keepChecked` preserves the user's checked
   * rows (a seed 注入 re-probe must not silently reset the selection — the
   * chamber row is not part of the third-party diff, so the checked set stays
   * valid across it; only rows that actually left the diff are dropped).
   */
  const loadSync = useCallback(async (keepChecked = false): Promise<void> => {
    if (!isRemote || spec === null) return
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
      const remoteRes = await pluginList(spec.id)
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
  }, [isRemote, spec])

  /** Manual host-graph seed fallback (design 09 module B): writes module A
   *  onto the remote + ensures the cordis.patch.yml insert, then re-probes.
   *  The ready-time auto-seed normally covers this (main process); the button
   *  is the visible retry path for the failure/half-injected states — the
   *  injection is never a silent modification. Gated against a concurrent
   *  apply (both mutate the remote profile via the main process). */
  const doSeedHostGraph = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null || seedBusy) return
    if (applyingRef.current) return
    setSeedBusy(true)
    setSeedError(null)
    try {
      const res = await seedHostGraph(spec.id)
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
  }, [isRemote, spec, seedBusy, loadSync])

  /**
   * One-click restart (design 08 §11): the chamber host packages are seeded
   * and the cordis.patch.yml insert is in place, but the RUNNING instance has
   * not loaded it — restarting the instance is the step that makes them live.
   * Re-probes afterwards so the live tri-state re-evaluates.
   */
  const doRestartNow = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null || restartBusy || seedBusy) return
    if (applyingRef.current) return
    setRestartBusy(true)
    setRestartError(null)
    try {
      const res = await restartService(spec.id)
      if ('error' in res) {
        setRestartError(res.error)
      } else {
        setPendingRestart(false)
      }
    } catch (err) {
      setRestartError(errorMessage(err))
    } finally {
      setRestartBusy(false)
      await loadSync(true)
    }
  }, [isRemote, spec, restartBusy, seedBusy, loadSync])

  useEffect(() => {
    if (isRemote) void loadSync()
    else void loadLocalList()
  }, [isRemote, loadSync, loadLocalList])

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
    if (!isRemote || spec === null || diff === null || applyingRef.current) return
    // A seed 注入 in flight mutates the same remote profile (module A files +
    // cordis.patch.yml) — never apply while it is mid-write (2026-08 review).
    if (seedBusy || restartBusy) return
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
      // Materialize rows (design 13 §4.6): pack-and-transfer via the desktop IPC —
      // NEVER `dsh plugin add <name>` from the registry (§4.5). Per-row
      // isolation: an unresolvable local dir or a failed transfer fails that
      // row only (AGENTS.md: one failed entity must not block the rest).
      const failed: PluginApplyFailure[] = []
      let applied = 0
      for (const row of materializeRows) {
        const res = await pluginMaterializeAdd(spec.id, row.name)
        if ('error' in res) failed.push({ spec: row.name, error: res.error })
        else if ('cancelled' in res) { /* user dismissed the confirmation: skipped, never counted as applied */ }
        else applied += 1
      }

      // Registry rows + removes ride the existing pluginApply orchestration
      // (remove-first, serial, restart unless deferred, assert, ready recheck).
      if (add.length > 0 || remove.length > 0) {
        const res = await pluginApply(spec.id, { add, remove, restart })
        if ('cancelled' in res) {
          // User dismissed the MAIN-PROCESS confirmation: the registry rows
          // were skipped — frame the materialized installs (if any) as
          // deferred, never as applied.
          setResult({ applied, failed, skipped: add.length + remove.length, restarted: false, deferred: true, verified: failed.length === 0, ready: null })
        } else if ('error' in res) {
          setResultError(res.error)
          // The registry apply was refused outright (e.g. apply in progress):
          // no restart was attempted — the materialized installs (if any) take
          // effect on the next restart, so frame them as deferred, never as a
          // failed restart.
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
        // Materialize-only apply: the desktop materialize path installs but
        // does not restart in v1 — the installs take effect on the next
        // restart (honest, same framing as a deferred registry apply).
        setResult({ applied, failed, skipped: 0, restarted: false, deferred: true, verified: failed.length === 0, ready: null })
      }
    } catch (err) {
      setResultError(errorMessage(err))
    } finally {
      applyingRef.current = false
      setRestart(true)
      setPhase('done')
    }
  }, [isRemote, spec, diff, checked, restart, seedBusy, restartBusy, t])

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
    // While a nested confirm modal (remove / apply / local-remove) is open,
    // the primitives Modal registers its own document-level Escape listener —
    // without this gate one Escape would ALSO close this main modal (its
    // listener runs too), discarding the user's checked selection (2026-08
    // review). The nested modals close themselves via their own onClose.
    if (confirmRemove || confirmApply || localRemoveTarget !== null) return
    onClose()
  }, [onClose, confirmRemove, confirmApply, localRemoveTarget])

  const title = `${t('pluginsTitle')} · ${spec === null ? t('localTitle') : spec.label}`
  const applying = phase === 'applying'

  // ---- filtered rows for the diff table ----
  const visibleRows = (diff?.rows ?? []).filter(row => {
    if (query !== '' && !row.name.toLowerCase().includes(query.trim().toLowerCase())) return false
    if (category !== 'all' && row.category !== category) return false
    if (status === 'diff' && !isDifferenceRow(row.kind)) return false
    return true
  })

  const footer = ((): ReactNode => {
    if (phase === 'loading') {
      // No footer. The primitives Modal always renders a working header close
      // (plus Escape / mask click → onClose), so a footer close would be
      // redundant — and on the LOCAL instance `phase` stays 'loading' forever
      // (loadSync only runs for remote), which previously left a DEAD disabled
      // 「关闭」button. The X closes in every phase.
      return undefined
    }
    if (phase === 'error') {
      return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync() }}>{t('pluginsRetry')}</Button>
    }
    if (phase === 'applying') {
      return <Button variant="outline" disabled>{t('saving')}</Button>
    }
    if (phase === 'done') {
      return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync() }}>{t('pluginsRefresh')}</Button>
    }
    // ready
    return (
      <>
        <Button variant="outline" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={changeCount === 0 || seedBusy || restartBusy} onClick={onApplyClick}>
          {t('pluginsApply')} {changeCount > 0 ? `${changeCount}` : ''}
        </Button>
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
        <div className={css.pluginTabs}>
          {(isRemote ? (['sync', 'add'] as const) : (['list', 'add'] as const)).map(id => (
            <button
              key={id}
              type="button"
              className={clsx(css.pluginTab, tab === id && css.pluginTabActive)}
              disabled={applying}
              onClick={() => { setTab(id) }}
            >
              {t(id === 'sync' ? 'pluginsSyncTab' : id === 'list' ? 'pluginsListTab' : 'pluginsAddTab')}
            </button>
          ))}
        </div>

        {tab === 'add'
          ? <PluginAddView t={t} spec={spec} onInstalled={() => { if (isRemote) void loadSync(); else void loadLocalList() }} />
          : tab === 'list'
            ? renderLocalList()
            : renderSyncView()}
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
    </>
  )

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
          <p className={css.dim}>{t('saving')}</p>
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

  /**
   * The chamber-injected component row (design 09 module A+B): shown in BOTH
   * the sync and the local-list views so the injection is never a silent
   * modification — the local side (auto-seeded by the control plane per
   * spawn) and the remote side (auto-seeded by the desktop at ready; manual
   * 注入 button as the visible retry for failure/half-injected states).
   */
  function renderChamberBlock(): ReactNode {
    // Local side: the sync view (remote) fills localManifest, the local list
    // view fills localList — same LocalPluginManifest shape, one source.
    const localCh = (isRemote ? localManifest : localList)?.chamber
    const remoteCh = isRemote ? remoteManifest?.chamber : undefined
    const localInjected = localCh?.ok === true && localCh.hostGraph.installed && localCh.hostGraph.patched
    // Module A's own version (design 09): the local projection is the source
    // of truth when readable (the seed copies the same packaged module A to
    // both sides); fall back to the remote projection only when the local
    // manifest is unavailable. null → no version chip (never a guessed one).
    const version = localCh?.ok === true
      ? localCh.hostGraph.version
      : remoteCh?.ok === true ? remoteCh.hostGraph.version : null
    const gitVersion = localCh?.ok === true
      ? localCh.gitWorktree.version
      : remoteCh?.ok === true ? remoteCh.gitWorktree.version : null
    const localGitInjected = localCh?.ok === true
      && localCh.gitWorktree.installed && localCh.gitWorktree.patched
    // Per-package remote tri-state (hostGraph and gitWorktree share the
    // installed/patched/live shape). Live-effect (design 09 module A
    // liveness): the desktop's tunnel RPC probe answers whether the RUNNING
    // instance has actually loaded the package — live → 已生效; probed
    // not-loaded → 重启后生效; unprobed/unclassifiable → 生效状态未知.
    // Never a constant claim.
    const remotePackageLabel = (state: ChamberHostGraphState | null | undefined): ReactNode => {
      if (state === undefined) return '—'
      if (state === null) return <span className={css.error}>{t('chamberRemoteUnknown')}</span>
      if (state.installed && state.patched) {
        return state.live === true
          ? t('chamberRemoteLive')
          : state.live === false
            ? t('chamberRemoteInjected')
            : t('chamberRemoteInjectedUnknown')
      }
      if (state.installed) return t('chamberRemotePartial')
      return t('chamberRemoteNotInjected')
    }
    const hostGraphRemote = remoteCh === undefined ? undefined : remoteCh.ok ? remoteCh.hostGraph : null
    const gitWorktreeRemote = remoteCh === undefined ? undefined : remoteCh.ok ? remoteCh.gitWorktree : null
    // BOTH boot rows must be present for the chamber host layer to be
    // complete: the git-worktree insert is its OWN row in the same
    // cordis.patch.yml, and its presence is probed separately (a machine
    // seeded before the git package existed carries only the client-graph
    // row — files present, git RPC still 404).
    const remoteNeedsSeed = isRemote && remoteCh !== undefined
      && (!remoteCh.ok
        || !(remoteCh.hostGraph.installed && remoteCh.hostGraph.patched)
        || !(remoteCh.gitWorktree.installed && remoteCh.gitWorktree.patched))
    // Injected but the RUNNING instance has not loaded a boot insert
    // (probed not-loaded) — restart is the one step that makes it live. A
    // seed that wrote/patched ALSO demands a restart (the running instance
    // only loads the boot layer at start). Each package has its own live
    // tri-state: host-graph live from an older boot does NOT prove the
    // git-worktree row loaded (design 08 §11) — either not-live gates the
    // restart button.
    const remoteInjectedNotLive = isRemote && remoteCh?.ok === true
      && remoteCh.hostGraph.installed && remoteCh.hostGraph.patched && remoteCh.hostGraph.live === false
    const remoteGitNotLive = isRemote && remoteCh?.ok === true
      && remoteCh.gitWorktree.installed && remoteCh.gitWorktree.patched && remoteCh.gitWorktree.live === false
    const restartPending = remoteInjectedNotLive || remoteGitNotLive || pendingRestart
    return (
      <div className={css.pluginChamber}>
        <p className={css.pluginChamberTitle}>
          {t('chamberInjectedTitle')}
          <span className={css.dim}> · {t('chamberInjectedHint')}</span>
        </p>
        <div className={css.pluginChamberRow}>
          <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>
          {version !== null ? <span className={css.dim}> · v{version}</span> : null}
          <span className={css.pluginCellSpec}>
            {localInjected ? t('chamberLocalInjected') : t('chamberLocalNotInjected')}
            {isRemote ? <span> · {remotePackageLabel(hostGraphRemote)}</span> : null}
          </span>
          {remoteNeedsSeed
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
            : restartPending
              ? (
                <button
                  type="button"
                  className={css.chamberSeedButton}
                  disabled={restartBusy || seedBusy}
                  onClick={() => { void doRestartNow() }}
                >
                  {restartBusy ? t('chamberRestarting') : t('chamberRestart')}
                </button>
              )
              : null}
        </div>
        <div className={css.pluginChamberRow}>
          <code className={css.pluginName}>{GIT_WORKTREE_PACKAGE}</code>
          {gitVersion !== null ? <span className={css.dim}> · v{gitVersion}</span> : null}
          <span className={css.pluginCellSpec}>
            {localGitInjected ? t('chamberInstalled') : t('chamberNotInstalled')}
            {isRemote ? <span> · {remotePackageLabel(gitWorktreeRemote)}</span> : null}
          </span>
        </div>
        {seedError !== null ? <p className={css.error} role="alert">{t('chamberSeedFailed')}{seedError}</p> : null}
        {restartError !== null ? <p className={css.error} role="alert">{t('chamberRestartFailed')}{restartError}</p> : null}
        {remoteCh !== undefined && !remoteCh.ok ? <p className={css.error} role="alert">{remoteCh.error}</p> : null}
      </div>
    )
  }

  function renderTable(): ReactNode {
    if (diff === null) return null
    const total = diff.rows.length
    const differenceCount = diff.rows.filter(row => isDifferenceRow(row.kind)).length
    const hasLocal = Object.keys(localManifest?.dependencies ?? {}).length > 0

    return (
      <div className={css.pluginStack}>
        {renderChamberBlock()}
        {profileNotInit ? <p className={css.pluginBanner}>{t('pluginsProfileNotInitialized')}</p> : null}
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
                    {/* No systemd service configured is a config gap, not a
                        failed restart — say so instead of the generic message. */}
                    {spec !== null && spec.serviceName === null ? t('pluginsRestartUnconfigured') : t('pluginsRestartFailed')}
                  </p>
                )
                : null}
              {!r.verified ? <p className={css.error} role="alert">{t('pluginsVerifyFailed')}</p> : null}
              {r.ready === false ? <p className={css.error} role="alert">{t('pluginsReadyFailed')}</p> : null}
              {/* Restart happened but readiness was not re-checked (the instance
                  was not connected before restart) — show the main process's
                  readyNote verbatim instead of claiming success or failure. */}
              {r.restarted && r.ready === null && r.readyNote !== undefined
                ? <p className={css.hint}>{r.readyNote}</p>
                : null}
            </>
          )}
      </div>
    )
  }

  function renderLocalList(): ReactNode {
    if (localLoading) return <p className={css.dim}>{t('loading')}</p>
    if (localListError !== null) {
      // The local list never leaves phase 'loading' (loadSync runs for remote
      // only), so the footer stays empty here — a visible retry is the only
      // recovery short of reopening the modal (2026-08 review).
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
    if (deps.length === 0 && localList.unsyncable.length === 0) {
      return (
        <div className={css.pluginStack}>
          {renderChamberBlock()}
          <p className={css.dim}>{t('pluginsNoLocalPlugins')}</p>
        </div>
      )
    }
    return (
      <div className={css.pluginStack}>
        {renderChamberBlock()}
        {localRemoveError !== null ? <p className={css.error} role="alert">{localRemoveError}</p> : null}
        <div className={css.pluginRows}>
          <div className={clsx(css.pluginRow, css.pluginRowLocal, css.pluginRowHead)}>
            <span className={css.pluginCellName}>{t('pluginsColName')}</span>
            <span className={css.pluginCellCat}>{t('pluginsColCategory')}</span>
            <span className={css.pluginCellSpec}>{t('pluginsLocalCol')}</span>
            <span className={css.pluginCellCat} />
          </div>
          {deps.map(([name, spec]) => {
            const category = localList.bundles.includes(name) ? 'bundle' : localList.clientLines.includes(name) ? 'client' : 'plain'
            const unsync = localList.unsyncable.find(item => item.name === name)
            return (
              <div key={name} className={clsx(css.pluginRow, css.pluginRowLocal, unsync !== undefined && css.pluginRowGray)}>
                <label className={clsx(css.pluginCell, css.pluginCellName)}>
                  <code className={css.pluginName}>{name}</code>
                </label>
                <span className={clsx(css.pluginCell, css.pluginCellCat)}>
                  <span className={clsx(css.pluginKindBadge, category === 'bundle' && css.pluginKindBundle, category === 'client' && css.pluginKindClient, category === 'plain' && css.pluginKindPlain)}>
                    {t(categoryLabel(category))}
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
                  data-tip={t('pluginsLocalRemove')}
                  aria-label={`${t('pluginsLocalRemove')}: ${name}`}
                  onClick={() => { setLocalRemoveTarget(name); setLocalRemoveError(null) }}
                >
                  <IconTrashOutline16 />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}
