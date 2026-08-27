/**
 * Per-server dsh runtime section (design 18 §3.6, 2026-09 per-server 修订):
 * registered as `settings.section` id `dsh-runtime` (order 31, right after
 * agent-presets) in every instance context. Local = full management surface;
 * gateway = proxied `/chamber/runtime` restart (version read-only line);
 * ssh = `restart_service` systemd restart (版本只读行属后续阶段，当前 ssh
 * 分支只渲染重启动作与提示)。Every source gets the「重启 dsh」
 * action (design 18 §3.6 项 8) to refresh mounted plugins.
 *
 * STAGED DEVIATION (registered in STATUS.md M7): the gateway branch currently
 * renders a REDUCED view — the remote version line (or fallback hint) + the
 * restart button + status polling. The full per-server section content
 * (version selector / registry source / status·failure·snapshot rows /
 * mutations) routed through `/api/i/<id>/chamber/runtime/*` is a later stage;
 * the route surface (status/versions/select/apply/rollback/restore-builtin/
 * retry-apply/retry-restore/restart/registry) is already complete server-side.
 *
 * Runtime facts and mutations remain main-process authoritative. The local
 * view consumes the shared renderer projection so its action gates, status
 * copy, SemVer ordering and subscription lifecycle stay aligned with the
 * connections local-start gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'
import {
  currentRuntimeSurface,
  formatRuntimeBytes,
  getRuntimeState,
  preferredRuntimeVersion,
  projectRuntimeSnapshot,
  projectRuntimeStatus,
  runtimeAllowedActions,
  runtimeRestartAllowed,
  runtimeSelectionDirection,
  subscribeRuntimeState,
  type RuntimeMetadataComponent,
  type RuntimeVersionEntry,
} from '../../../../packages/renderer/src/runtime-management.ts'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
import { pollGatewayReady } from './gateway-runtime-poll.ts'
import css from './SettingsShell.module.css'

type RuntimeTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

const NPMJS = 'https://registry.npmjs.org'
const NPMMIRROR = 'https://registry.npmmirror.com'
const CUSTOM_REGISTRY = '__custom__'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Localize a projected ISO timestamp before it reaches user copy. The locale
 *  service keeps `<html lang>` in sync at activation and on every locale
 *  change (dsh-client-locale syncDocumentLanguage); the served markup defaults
 *  to zh-CN, so an unset lang falls back to zh-CN rather than the OS locale. */
function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const locale = typeof document !== 'undefined' && document.documentElement.lang !== ''
    ? document.documentElement.lang
    : 'zh-CN'
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  } catch {
    return value
  }
}

/** Map the main-process registry patch failures to localized copy by their
 *  stable machine-readable `code` (never by display-text matching — the main
 *  process may reword `error` without notice). Known codes become dictionary
 *  keys; anything unknown stays honest and raw. */
function localizeRegistryError(code: string | undefined, error: string, t: RuntimeTranslate): string {
  if (code === 'invalid-registry-origin') {
    return t('dshRuntimeRegistryInvalidOrigin')
  }
  return error
}

function metadataComponentText(component: RuntimeMetadataComponent, t: RuntimeTranslate): string {
  switch (component) {
    case 'current': return t('dshRuntimeMetadataComponentCurrent')
    case 'override': return t('dshRuntimeMetadataComponentOverride')
    case 'activation-journal': return t('dshRuntimeMetadataComponentJournal')
    case 'recovery-marker': return t('dshRuntimeMetadataComponentRecoveryMarker')
    case 'retained-evidence': return t('dshRuntimeMetadataComponentEvidence')
  }
}

export type { DshRuntimeSource } from './runtime-source.ts'
import type { DshRuntimeSource } from './runtime-source.ts'

export interface DshRuntimeSectionProps {
  t: RuntimeTranslate
  /** Source kind derived from the instance context's canonical chamber id. */
  instanceSource?: DshRuntimeSource
  /** The canonical per-instance id (local | ssh-<id> | gateway-<id>). */
  chamberInstanceId?: string
}

export function DshRuntimeSection({ t, instanceSource = 'local', chamberInstanceId }: DshRuntimeSectionProps) {
  const state = useSyncExternalStore(subscribeRuntimeState, getRuntimeState)
  const settingsStatus = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartNote, setRestartNote] = useState<string | null>(null)
  const restartPollAbort = useRef<AbortController | null>(null)
  // Synchronous re-entry gate: the async state update cannot stop a double
  // click in the same frame (V2 review M3).
  const restartingRef = useRef(false)
  useEffect(() => () => { restartPollAbort.current?.abort() }, [])
  const [selected, setSelected] = useState<string | null>(null)
  const selectionExplicit = useRef(false)
  const [customOrigin, setCustomOrigin] = useState('')
  const [registrySelection, setRegistrySelection] = useState(NPMJS)
  const [actionError, setActionError] = useState<string | null>(null)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [originError, setOriginError] = useState<string | null>(null)
  const [registryReachable, setRegistryReachable] = useState(false)
  const [testingRegistry, setTestingRegistry] = useState(false)
  const [applyingRegistry, setApplyingRegistry] = useState(false)

  const runtime = currentRuntimeSurface()
  const hydrated = state !== null
  const active = state?.active ?? null
  const bundled = state?.bundled ?? null
  const pending = state?.pending ?? null
  const phase = state?.phase ?? 'idle'
  const versions = state?.versions ?? []
  const source = state?.source ?? 'bundled'
  const envGated = source === 'env'
  const managementGated = state?.managementSupported === false
  const actions = useMemo(() => new Set(runtimeAllowedActions(state)), [state])

  const registryOrigin = settingsStatus?.settings.registryOrigin ?? NPMJS
  const registryMode = registryOrigin === NPMJS || registryOrigin === NPMMIRROR
    ? registryOrigin
    : CUSTOM_REGISTRY

  useEffect(() => {
    setRegistrySelection(registryMode)
    if (registryMode === CUSTOM_REGISTRY) setCustomOrigin(registryOrigin)
  }, [registryMode, registryOrigin])

  // Preserve an explicit choice across pushes. Before the user chooses, the
  // registry recommendation wins over the active/list-order fallbacks.
  useEffect(() => {
    if (!hydrated) return
    setSelected((current) => {
      const currentStillExplicit = selectionExplicit.current
        && current !== null
        && versions.some((entry) => entry.version === current)
      if (!currentStillExplicit) selectionExplicit.current = false
      return preferredRuntimeVersion(currentStillExplicit ? current : null, versions, state?.latest ?? null, active)
    })
  }, [active, hydrated, state?.latest, versions])

  const chosen = preferredRuntimeVersion(
    selectionExplicit.current ? selected : null,
    versions,
    state?.latest ?? null,
    active,
  )
  const isActive = chosen !== null && chosen === active
  const cleanupEligible = chosen !== null
    && !isActive
    && (state?.explicitlyInstalledVersions ?? []).includes(chosen)
  const selectionDirection = runtimeSelectionDirection(chosen, active)
  const sourceTag = active === null
    ? null
    : source === 'env'
      ? t('dshRuntimeEnvTag')
      : source === 'user'
        ? t('dshRuntimeUserTag')
        : t('dshRuntimeBuiltinTag')

  const runRuntimeAction = useCallback(async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await task()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [])

  // 重启 dsh（design 18 §3.6 项 8）：受控进程重启刷新插件挂载；指针/版本树
  // 不动。local = 事务化 control-plane restartLocal()；gateway = 该 server 的
  // /chamber/runtime/restart（202 + status 轮询）；ssh = restart_service systemd。
  const canRestartDsh = runtimeRestartAllowed(state)
  const onRestartDsh = useCallback(async (): Promise<void> => {
    if (restartingRef.current) return
    if (window.confirm(t('dshRuntimeRestartConfirm'))) {
      restartingRef.current = true
      setRestarting(true)
      setActionError(null)
      setRestartNote(null)
      try {
        if (instanceSource === 'local') {
          const surface = currentRuntimeSurface()
          if (surface !== null) {
            await surface.restart()
          } else {
            // Bridge torn down between render and click: never claim a
            // restart that cannot run (review fix).
            throw new Error('runtime surface unavailable')
          }
        } else if (instanceSource === 'gateway' && chamberInstanceId !== undefined) {
          const response = await fetch(`/api/i/${chamberInstanceId}/chamber/runtime/restart`, { method: 'POST' })
          if (response.status !== 202) {
            // Surface the server's own reason (round-3 fix): the route answers
            // 409 with a specific error ('managed dsh is not running (stopped)…',
            // 'runtime activation in progress…', 'a restart is already in flight')
            // that must reach the user instead of a bare status code.
            let serverReason = ''
            try {
              const body = await response.json() as { error?: unknown }
              if (typeof body.error === 'string' && body.error !== '') serverReason = body.error
            } catch { /* non-JSON body — fall back to the status */ }
            throw new Error(serverReason !== '' ? `restart refused: ${serverReason}` : `restart refused (${response.status})`)
          }
          restartPollAbort.current?.abort()
          const pollController = new AbortController()
          restartPollAbort.current = pollController
          await pollGatewayReady(chamberInstanceId, pollController.signal)
        } else if (instanceSource === 'ssh' && chamberInstanceId !== undefined) {
          const hostId = chamberInstanceId.slice('ssh-'.length)
          const desktopSsh = window.dshChamber?.desktopSsh
          if (desktopSsh === undefined) throw new Error('desktop ssh surface unavailable')
          const result = await desktopSsh.restart_service(hostId)
          if (result !== null && typeof result === 'object' && 'error' in result) {
            throw new Error(String((result as { error: unknown }).error))
          }
        } else {
          // Defensive (review fix): a source/id mismatch must never fall
          // through to the success note for a restart that cannot run.
          throw new Error('runtime restart unavailable for this source')
        }
        setRestartNote(t('dshRuntimeRestarted'))
      } catch (error) {
        setActionError(errorMessage(error))
      } finally {
        restartingRef.current = false
        setRestarting(false)
      }
    }
  }, [t, instanceSource, chamberInstanceId])

  const onInstall = useCallback(() => {
    if (runtime === null || chosen === null || isActive || envGated || !actions.has('install')) return
    void runRuntimeAction(() => runtime.install(chosen))
  }, [runtime, chosen, isActive, envGated, actions, runRuntimeAction])

  const onReset = useCallback(() => {
    if (runtime === null || envGated || !actions.has('reset-builtin')) return
    void runRuntimeAction(() => runtime.resetBuiltin())
  }, [runtime, envGated, actions, runRuntimeAction])

  const onRetryApply = useCallback(() => {
    if (runtime === null || envGated || state?.canRetryApply !== true || !actions.has('retry-apply')) return
    void runRuntimeAction(() => runtime.retryApply())
  }, [runtime, envGated, state, actions, runRuntimeAction])

  const onRetryRestore = useCallback(() => {
    if (runtime === null || state?.canRetryRestore !== true || !actions.has('retry-restore')) return
    void runRuntimeAction(() => runtime.retryRestore())
  }, [runtime, state, actions, runRuntimeAction])

  const onRecoverMetadata = useCallback(() => {
    if (runtime === null || !actions.has('recover-metadata')) return
    void runRuntimeAction(() => runtime.recoverMetadata())
  }, [runtime, actions, runRuntimeAction])

  const onRestorePreRollback = useCallback(() => {
    if (runtime === null || !actions.has('restore-pre-rollback')) return
    void runRuntimeAction(() => runtime.restorePreRollback(state?.preRollbackLatestName ?? ''))
  }, [runtime, actions, state, runRuntimeAction])

  const onCleanupVersion = useCallback(() => {
    if (runtime === null || chosen === null || !cleanupEligible || !actions.has('cleanup-version')) return
    void runRuntimeAction(() => runtime.cleanupVersion(chosen))
  }, [runtime, chosen, cleanupEligible, actions, runRuntimeAction])

  const onApplyRegistry = useCallback(async (
    origin: string,
    inline: boolean,
  ): Promise<{ ok: boolean; cancelled: boolean }> => {
    if (envGated || !actions.has('check')) return { ok: false, cancelled: false }
    setBusy(true)
    setApplyingRegistry(true)
    setRegistryError(null)
    setOriginError(null)
    setRegistryReachable(false)
    try {
      const result = await applySettingsPatch({ registryOrigin: origin })
      if (!result.ok) {
        // The confirm dialog was declined — not an error; the caller reverts
        // the dropdown so it never claims an origin that was not applied.
        if (result.code === 'cancelled') return { ok: false, cancelled: true }
        // A validation failure is an inline field error on the custom origin;
        // any other apply failure surfaces on the general registry line.
        const error = localizeRegistryError(result.code, result.error, t)
        if (inline) setOriginError(error)
        else setRegistryError(error)
        return { ok: false, cancelled: false }
      }
      return { ok: true, cancelled: false }
    } catch (error) {
      const message = errorMessage(error)
      if (inline) setOriginError(message)
      else setRegistryError(message)
      return { ok: false, cancelled: false }
    } finally {
      setApplyingRegistry(false)
      setBusy(false)
    }
  }, [envGated, actions, t])

  const onTestRegistry = useCallback(async (): Promise<void> => {
    if (runtime === null || !actions.has('check')) return
    setTestingRegistry(true)
    setRegistryError(null)
    setRegistryReachable(false)
    try {
      const result = await runtime.check()
      if (result.phase === 'error') {
        setRegistryError(result.error ?? t('dshRuntimeRegistryUnreachable'))
      } else {
        setRegistryReachable(true)
      }
    } catch (error) {
      setRegistryError(errorMessage(error))
    } finally {
      setTestingRegistry(false)
    }
  }, [runtime, actions, t])

  const status = useMemo(() => projectRuntimeStatus(state, chosen), [state, chosen])
  const snapshot = useMemo(() => projectRuntimeSnapshot(state), [state])

  const statusText = useMemo(() => {
    const version = status.version ?? '—'
    const detail = status.detail ?? '—'
    switch (status.kind) {
      case 'not-checked': return t('dshRuntimeStatusNotChecked')
      case 'idle': return t('dshRuntimeStatusIdle')
      case 'checking': return t('dshRuntimeStatusChecking')
      case 'available': return t('dshRuntimeStatusAvailable', { version })
      case 'downloading': return t('dshRuntimeStatusDownloading', { version })
      case 'installing': return t('dshRuntimeStatusInstalling', { version })
      case 'pending': return t('dshRuntimeStatusPending', { version })
      case 'applying': return t('dshRuntimeStatusApplying', { version })
      case 'applied': return t('dshRuntimeStatusApplied', { version })
      case 'rollback': return t('dshRuntimeStatusRollback', { version, error: detail })
      case 'rollback-complete': return t('dshRuntimeStatusRollbackComplete', { version })
      case 'rollback-half': return t('dshRuntimeStatusRollbackHalf', { version, error: detail })
      case 'restore-incomplete': return t('dshRuntimeStatusRestoreIncomplete', { error: detail })
      case 'swap-attempted': return t('dshRuntimeStatusSwapAttempted', { version, error: detail })
      case 'snapshot-failed': return t('dshRuntimeStatusSnapshotFailed', { error: detail })
      case 'failed': return t('dshRuntimeStatusFailed', { version, error: detail })
      case 'error': return t('dshRuntimeStatusError', { error: detail })
    }
  }, [status, t])

  const snapshotText = useMemo(() => {
    switch (snapshot.kind) {
      case 'unknown': return t('dshRuntimeSnapshotUnknown')
      case 'ready': return t('dshRuntimeSnapshotSummary', {
        count: snapshot.count ?? 0,
        at: snapshot.latestAt != null ? formatTimestamp(snapshot.latestAt) : t('dshRuntimeSnapshotNever'),
      })
      case 'failed': return t('dshRuntimeSnapshotFailed', { error: snapshot.detail ?? '—' })
      case 'restore-half': return t('dshRuntimeSnapshotRestoreHalf')
      case 'restore-incomplete': return t('dshRuntimeSnapshotRestoreIncomplete')
    }
  }, [snapshot, t])

  const canSelect = actions.has('select-version')
  const canInstall = actions.has('install')
  const canReset = actions.has('reset-builtin')
  const canRetryApply = actions.has('retry-apply') && state?.canRetryApply === true
  const canRetryRestore = actions.has('retry-restore') && state?.canRetryRestore === true
  const canRecoverMetadata = actions.has('recover-metadata') && state?.canRecoverMetadata === true
  const canCleanup = actions.has('cleanup-version') && cleanupEligible
  const canCheck = actions.has('check')
  const canRestorePreRollback = actions.has('restore-pre-rollback')
    && (state?.preRollbackCount ?? 0) > 0
  const operationDisabled = !hydrated || busy || testingRegistry
  const mutationDisabled = operationDisabled || envGated || managementGated
  const registryDisabled = settingsStatus === null || mutationDisabled || !canCheck
  const metadataComponents = (state?.metadataComponents ?? [])
    .map(component => metadataComponentText(component, t))
    .join(t('dshRuntimeMetadataComponentSeparator')) || t('dshRuntimeMetadataComponentUnknown')

  // Live install progress (design 18 M4): byte-percent while downloading
  // with a declared content-length, stage labels otherwise, and an
  // indeterminate bar during the phase-only windows (installing/applying).
  const progress = state?.progress ?? null
  const installingPhase = phase === 'downloading' || phase === 'installing' || phase === 'applying'
  const showProgress = progress !== null || installingPhase
  const progressPercent = progress?.stage === 'download' && typeof progress.total === 'number' && progress.total > 0
    ? Math.min(100, Math.max(0, Math.round(((progress.received ?? 0) / progress.total) * 100)))
    : null
  const progressLabel = useMemo(() => {
    if (progress?.stage === 'download') {
      return progressPercent !== null
        ? t('dshRuntimeProgressDownloading', { percent: progressPercent })
        : t('dshRuntimeProgressDownloadingIndeterminate')
    }
    switch (progress?.stage) {
      case 'install': return t('dshRuntimeProgressInstalling')
      case 'prune': return t('dshRuntimeProgressPruning')
      case 'smoke': return t('dshRuntimeProgressSmoke')
      case 'publish': return t('dshRuntimeProgressPublishing')
      default: return phase === 'applying'
        ? t('dshRuntimeProgressApplying')
        : phase === 'installing' || phase === 'downloading'
          ? t('dshRuntimeProgressInstalling')
          : t('dshRuntimeProgressDownloadingIndeterminate')
    }
  }, [progress, progressPercent, phase, t])

  // Remote gateway facts (design 18 §3.6): the gateway branch projects the
  // server's own runtime status through its /chamber/runtime surface.
  const [remoteRuntime, setRemoteRuntime] = useState<{ activeVersion?: unknown; connectionState?: unknown } | null>(null)
  useEffect(() => {
    if (instanceSource !== 'gateway' || chamberInstanceId === undefined) return
    // Never show the previous server's version while the new one loads (M4).
    setRemoteRuntime(null)
    let cancelled = false
    fetch(`/api/i/${chamberInstanceId}/chamber/runtime/status`, { credentials: 'same-origin' })
      .then(async response => (response.status === 200 ? response.json() : null))
      .then((payload) => {
        if (!cancelled && payload !== null) setRemoteRuntime(payload as { activeVersion?: unknown; connectionState?: unknown })
      })
      .catch(() => { /* unavailable surface renders the honest hint row */ })
    return () => { cancelled = true }
  }, [instanceSource, chamberInstanceId])

  // Remote sources (design 18 §3.6 分支): version read-only + 重启 dsh.
  if (instanceSource !== 'local') {
    return (
      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>
        {instanceSource === 'ssh' && (
          <p className={css.generalHint}>{t('dshRuntimeRemoteSshNote')}</p>
        )}
        {instanceSource === 'gateway' && (
          <p className={css.generalHint}>
            {remoteRuntime?.activeVersion !== undefined
              ? `${t('dshRuntimeRemoteVersion')} v${String(remoteRuntime.activeVersion)}`
              : t('dshRuntimeRemoteGatewayNote')}
          </p>
        )}
        {instanceSource === 'gateway' && remoteRuntime?.connectionState !== undefined
          && remoteRuntime.connectionState !== 'ready' && (
          <p className={css.generalHint} role="status">
            {t('dshRuntimeRemoteConnState', { state: String(remoteRuntime.connectionState) })}
          </p>
        )}
        <div className={css.updateStatusLine}>
          <button
            type="button"
            className={css.updateButton}
            onClick={() => { void onRestartDsh() }}
            disabled={restarting}
          >
            {restarting
              ? t('dshRuntimeRestarting')
              : instanceSource === 'ssh'
                ? t('dshRuntimeRestartRemoteAction')
                : t('dshRuntimeRestartAction')}
          </button>
        </div>
        {restartNote !== null && <p className={css.generalHint} role="status">{restartNote}</p>}
        {actionError !== null && <p className={css.generalError} role="alert">{actionError}</p>}
      </div>
    )
  }

  return (
    <div className={css.generalGroup}>
      <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>

      <h4 className={css.generalGroupTitle}>{t('dshRuntimeGroupStatus')}</h4>

      <div className={css.updateVersionRow}>
        <p className={css.updateRow}>
          {t('updateCurrentVersion', {
            version: active === null ? t('dshRuntimeVersionUnknown') : active,
          })}
          {active !== null && sourceTag !== null ? `（${sourceTag}）` : ''}
        </p>
      </div>
      <div className={css.updateStatus} aria-live="polite">
        <p className={css.updateStatusText}>{statusText}</p>
      </div>
      {showProgress && (
        <div className={css.runtimeProgressBlock} role="status" aria-live="polite">
          <span className={css.runtimeProgressLabel}>{progressLabel}</span>
          <div className={css.runtimeProgressTrack}>
            <div
              className={progressPercent === null ? css.runtimeProgressBarIndeterminate : css.runtimeProgressBar}
              style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}
      {active !== null && bundled !== null && active !== bundled && (
        <p className={css.generalHint}>{t('dshRuntimeBundledRow')} v{bundled}</p>
      )}
      {envGated && <p className={css.generalHint}>{t('dshRuntimeEnvHint')}</p>}
      {managementGated && state?.managementUnsupportedReason != null && (
        <p className={css.generalHint} role="status">{state.managementUnsupportedReason}</p>
      )}
      {state?.runtimeBlocked === true
        && (state.metadataHealth === 'selection-corrupt' || state.metadataHealth === 'recovery-in-progress') && (
        <>
          <p className={css.generalError} role="alert">
            {t(
              state.metadataHealth === 'recovery-in-progress'
                ? 'dshRuntimeMetadataRecoveryInProgress'
                : 'dshRuntimeMetadataBlocked',
              { components: metadataComponents },
            )}
          </p>
          <p className={css.generalHint}>{t('dshRuntimeMetadataEvidenceHint')}</p>
        </>
      )}
      {state?.runtimeBlocked === true && state.metadataHealth === 'recovery-marker-corrupt' && (
        <>
          <p className={css.generalError} role="alert">
            {t('dshRuntimeMetadataMarkerCorrupt', { components: metadataComponents })}
          </p>
          {state.canRecoverMetadata === true && (
            <p className={css.generalHint}>{t('dshRuntimeMetadataMarkerRescueHint')}</p>
          )}
        </>
      )}
      {state?.invalidationNotice != null && (
        <p className={css.generalHint} role="status">
          {t(
            state.invalidationNotice.recovered
              ? 'dshRuntimeInvalidationRecovered'
              : 'dshRuntimeInvalidationFallback',
            {
              version: state.invalidationNotice.fromVersion ?? '—',
              at: formatTimestamp(state.invalidationNotice.at),
            },
          )}
        </p>
      )}

      <h4 className={css.generalGroupTitle}>{t('dshRuntimeGroupActions')}</h4>

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeSelectVersion')}</span>
        <div className={css.runtimeSelectRow}>
          <select
            className={css.updateButton}
            value={chosen ?? ''}
            disabled={mutationDisabled || !canSelect}
            onChange={(event) => {
              selectionExplicit.current = true
              setSelected(event.target.value)
            }}
          >
            {versions.length === 0
              ? <option value="" disabled>{t('dshRuntimeNoVersions')}</option>
              : versions.map((entry: RuntimeVersionEntry) => (
                <option key={entry.version} value={entry.version}>
                  v{entry.version}
                  {entry.version === active ? ` · ${t('current')}` : ''}
                  {entry.latest ? ` · ${t('dshRuntimeLatestTag')}` : ''}
                  {entry.cached ? ` · ${t('dshRuntimeCachedTag')}` : ''}
                  {entry.belowBaseline ? ` · ${t('dshRuntimeBelowBaselineTag')}` : ''}
                </option>
              ))}
          </select>
          {canInstall && (
            <button
              type="button"
              className={css.updatePrimaryButton}
              onClick={onInstall}
              disabled={mutationDisabled || isActive || chosen === null}
            >
              {selectionDirection === 'rollback' ? t('dshRuntimeActionRollback') : t('dshRuntimeActionUpdate')} v{chosen ?? '—'}
            </button>
          )}
          {canCleanup && chosen !== null && (
            <button type="button" className={css.updateButton} onClick={onCleanupVersion} disabled={mutationDisabled}>
              {t('dshRuntimeCleanupVersion')} v{chosen}
            </button>
          )}
        </div>
      </label>

      <p className={css.generalHint}>{snapshotText}</p>
      {pending !== null && phase !== 'pending' && phase !== 'applying' && (
        <p className={css.generalHint}>{t('dshRuntimePendingRecord', { version: pending })}</p>
      )}

      <div className={css.updateStatusLine}>
        <button
          type="button"
          className={css.updateButton}
          onClick={() => { void onRestartDsh() }}
          disabled={restarting || !canRestartDsh}
        >
          {restarting ? t('dshRuntimeRestarting') : t('dshRuntimeRestartAction')}
        </button>
      </div>
      {restartNote !== null && (
        <p className={css.generalHint} role="status">{restartNote}</p>
      )}

      {(canRetryApply || canRetryRestore || canRestorePreRollback || canRecoverMetadata || canReset) && (
        <div className={css.updateStatusLine}>
          {canRetryApply && (
            <button type="button" className={css.updateButton} onClick={onRetryApply} disabled={mutationDisabled}>
              {t('dshRuntimeRetryApply')}
            </button>
          )}
          {canRetryRestore && (
            <button type="button" className={css.updateButton} onClick={onRetryRestore} disabled={operationDisabled}>
              {t('dshRuntimeRetryRestore')}
            </button>
          )}
          {canRestorePreRollback && (
            <button type="button" className={css.updateButton} onClick={onRestorePreRollback} disabled={mutationDisabled}>
              {t('dshRuntimeRestorePreRollback')}
            </button>
          )}
          {canRecoverMetadata && (
            <button
              type="button"
              className={css.updateButton}
              onClick={onRecoverMetadata}
              disabled={mutationDisabled}
            >
              {t('dshRuntimeRecoverMetadata')}
            </button>
          )}
          {canReset && (
            <button type="button" className={css.updateButton} onClick={onReset} disabled={mutationDisabled}>
              {t('dshRuntimeResetBuiltin')}
            </button>
          )}
        </div>
      )}

      {state?.failure != null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeFailureRecord', {
            version: state.failure.version,
            at: formatTimestamp(state.failure.at),
            reason: state.failure.reason,
          })}
        </p>
      )}
      {actionError !== null && <p className={css.generalError} role="alert">{actionError}</p>}

      <h4 className={css.generalGroupTitle}>{t('dshRuntimeGroupSource')}</h4>

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeRegistryLabel')}</span>
        <div className={css.runtimeSelectRow}>
          <select
            className={css.updateButton}
            value={registrySelection}
            disabled={registryDisabled}
            onChange={(event) => {
              const value = event.target.value
              setRegistrySelection(value)
              if (value !== CUSTOM_REGISTRY) {
                void onApplyRegistry(value, false).then((result) => {
                  // Any failed/declined apply reverts the dropdown: it must
                  // never claim an origin that was not applied. The error text
                  // (originError) stays visible; a custom origin is handled by
                  // its own input below and keeps its editable value.
                  if (!result.ok) setRegistrySelection(registryMode)
                })
              }
            }}
          >
            <option value={NPMJS}>{t('dshRuntimeRegistryNpmjs')}</option>
            <option value={NPMMIRROR}>{t('dshRuntimeRegistryNpmmirror')}</option>
            <option value={CUSTOM_REGISTRY}>{t('dshRuntimeRegistryCustomLabel')}</option>
          </select>
          {canCheck && (
            <button
              type="button"
              className={css.updateButton}
              disabled={!canCheck || testingRegistry || busy}
              onClick={() => { void onTestRegistry() }}
            >
              {testingRegistry ? t('dshRuntimeRegistryChecking') : t('dshRuntimeRegistryCheck')}
            </button>
          )}
        </div>
        <span className={css.generalHint}>
          {t('dshRuntimeRegistryHint')}
          {' '}
          {t('dshRuntimeRegistryCurrent', { origin: registryOrigin })}
        </span>
      </label>

      {registrySelection === CUSTOM_REGISTRY && (
        <label className={css.generalRow}>
          <span className={css.generalFieldLabel}>{t('dshRuntimeRegistryCustomLabel')}</span>
          <input
            type="url"
            className={css.updateButton}
            value={customOrigin}
            placeholder="https://registry.example.com"
            disabled={registryDisabled}
            onChange={(event) => setCustomOrigin(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && customOrigin.trim() !== '') {
                void onApplyRegistry(customOrigin.trim(), true)
              }
            }}
          />
          <button
            type="button"
            className={css.updateButton}
            disabled={registryDisabled || customOrigin.trim() === ''}
            onClick={() => { void onApplyRegistry(customOrigin.trim(), true) }}
          >
            {applyingRegistry ? t('dshRuntimeRegistryApplying') : t('dshRuntimeRegistryApply')}
          </button>
          {originError !== null && <p className={css.generalError} role="alert">{originError}</p>}
        </label>
      )}

      {registryError !== null && <p className={css.generalError} role="alert">{registryError}</p>}
      {registryReachable && <p className={css.generalHint} role="status">{t('dshRuntimeRegistryReachable')}</p>}

      {state?.diskUsage != null && (
        <p className={css.generalHint}>
          {t('dshRuntimeDiskSummary', {
            total: formatRuntimeBytes(state.diskUsage.totalBytes),
            trees: state.diskUsage.versionTrees,
            treeBytes: formatRuntimeBytes(state.diskUsage.versionTreeBytes),
            storeBytes: formatRuntimeBytes(state.diskUsage.storeBytes),
            cacheBytes: formatRuntimeBytes(
              state.diskUsage.cacheBytes
              + state.diskUsage.installHomeBytes
              + state.diskUsage.xdgCacheBytes
              + state.diskUsage.workBytes,
            ),
            snapshotBytes: formatRuntimeBytes(state.diskUsage.snapshotBytes),
            recoveryBytes: formatRuntimeBytes(
              state.diskUsage.preRollbackBytes
              + state.diskUsage.restoreBackupBytes
              + state.diskUsage.failureBytes,
            ),
          })}
        </p>
      )}
      {state?.diskError != null && (
        <p className={css.generalError} role="alert">{t('dshRuntimeDiskError', { error: state.diskError })}</p>
      )}
      {state?.diskLimitExceeded === true && state.diskLimitBytes !== undefined && (
        <p className={css.generalError} role="status">
          {t('dshRuntimeDiskQuotaWarning', { limit: formatRuntimeBytes(state.diskLimitBytes) })}
        </p>
      )}
    </div>
  )
}
