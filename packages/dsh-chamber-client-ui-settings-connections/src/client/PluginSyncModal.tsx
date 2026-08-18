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
import type { LocalPluginManifest, PluginApplyFailure, PluginApplyResult, RemotePluginManifest, SshInstanceSpec } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { localPluginList, localPluginRemove, pluginApply, pluginList, pluginMaterializeAdd, seedHostGraph } from './control-plane.ts'
import {
  computePluginDiff, defaultChecked, isDifferenceRow, materializeLocalDir, rowAddArg,
  type PluginDiff, type PluginRow, type PluginRowKind,
} from './plugin-diff.ts'
import { PluginAddView } from './PluginAddView.tsx'
import css from './ConnectionsSection.module.css'

type PluginPhase = 'loading' | 'error' | 'ready' | 'applying' | 'done'
type PluginTab = 'sync' | 'list' | 'add'
type CategoryFilter = 'all' | 'bundle' | 'plain' | 'client'
type StatusFilter = 'diff' | 'all'

/** The chamber-injected host package surfaced as a non-actionable info row
 *  (design 09 方案 A, module A) — the single source of truth for the name is
 *  plugin-sync.ts CLIENT_GRAPH_PACKAGE_NAME. */
const HOST_GRAPH_PACKAGE = '@dsh-chamber/dsh-host-client-graph'

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
 * @param props.onClose - close (ignored while applying, §5.7).
 */
export function PluginSyncModal({ t, spec, onClose }: {
  t: (key: SettingsConnectionsKey) => string
  spec: SshInstanceSpec | null
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
        await loadLocalList()
      }
    } catch (err) {
      setLocalRemoveError(errorMessage(err))
    } finally {
      setLocalRemoveBusy(false)
    }
  }, [localRemoveTarget, localRemoveBusy, loadLocalList])

  const loadSync = useCallback(async (): Promise<void> => {
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
      setChecked(new Set(d.rows.filter(row => defaultChecked(row.kind)).map(row => row.name)))
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
   *  injection is never a silent modification. */
  const doSeedHostGraph = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null || seedBusy) return
    setSeedBusy(true)
    setSeedError(null)
    try {
      const res = await seedHostGraph(spec.id)
      if (!res.ok) setSeedError(res.error)
    } catch (err) {
      setSeedError(errorMessage(err))
    } finally {
      setSeedBusy(false)
      await loadSync()
    }
  }, [isRemote, spec, seedBusy, loadSync])

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
        const dir = row.localSpec === null ? null : materializeLocalDir(row.localSpec)
        if (dir === null) {
          failed.push({ spec: row.name, error: t('pluginsMaterializeNoDir') })
          continue
        }
        const res = await pluginMaterializeAdd(spec.id, dir)
        if ('error' in res) failed.push({ spec: row.name, error: res.error })
        else applied += 1
      }

      // Registry rows + removes ride the existing pluginApply orchestration
      // (remove-first, serial, restart unless deferred, assert, ready recheck).
      if (add.length > 0 || remove.length > 0) {
        const res = await pluginApply(spec.id, { add, remove, restart })
        if ('error' in res) {
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
  }, [isRemote, spec, diff, checked, restart, t])

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
    onClose()
  }, [onClose])

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
      return <Button variant="outline" disabled onClick={close}>{t('close')}</Button>
    }
    if (phase === 'error') {
      return (
        <>
          <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync() }}>{t('pluginsRetry')}</Button>
          <Button variant="outline" onClick={close}>{t('close')}</Button>
        </>
      )
    }
    if (phase === 'applying') {
      return <Button variant="outline" disabled>{t('saving')}</Button>
    }
    if (phase === 'done') {
      return (
        <>
          <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync() }}>{t('pluginsRefresh')}</Button>
          <Button variant="outline" onClick={close}>{t('close')}</Button>
        </>
      )
    }
    // ready
    return (
      <>
        <Button variant="outline" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={changeCount === 0} onClick={onApplyClick}>
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
    let remoteLabel: ReactNode
    let remoteOk = true
    if (remoteCh === undefined) {
      remoteLabel = '—'
    } else if (!remoteCh.ok) {
      remoteOk = false
      remoteLabel = <span className={css.error}>{t('chamberRemoteUnknown')}</span>
    } else if (remoteCh.hostGraph.installed && remoteCh.hostGraph.patched) {
      remoteLabel = t('chamberRemoteInjected')
    } else if (remoteCh.hostGraph.installed) {
      remoteLabel = t('chamberRemotePartial')
    } else {
      remoteLabel = t('chamberRemoteNotInjected')
    }
    const remoteNeedsSeed = isRemote && remoteCh !== undefined && (!remoteCh.ok || !(remoteCh.hostGraph.installed && remoteCh.hostGraph.patched))
    return (
      <div className={css.pluginChamber}>
        <p className={css.pluginChamberTitle}>
          {t('chamberInjectedTitle')}
          <span className={css.dim}> · {t('chamberInjectedHint')}</span>
        </p>
        <div className={css.pluginChamberRow}>
          <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>
          <span className={css.pluginCellSpec}>
            {localInjected ? t('chamberLocalInjected') : t('chamberLocalNotInjected')}
            {isRemote ? <span> · {remoteLabel}</span> : null}
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
            : null}
        </div>
        {seedError !== null ? <p className={css.error} role="alert">{t('chamberSeedFailed')}{seedError}</p> : null}
        {!remoteOk && remoteCh !== undefined && !remoteCh.ok ? <p className={css.error} role="alert">{remoteCh.error}</p> : null}
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
    if (localListError !== null) return <p className={css.error} role="alert">{localListError}</p>
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
