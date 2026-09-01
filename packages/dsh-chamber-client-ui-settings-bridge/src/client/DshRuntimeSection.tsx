/**
 * Per-server dsh runtime section (design 18 §3.6, 2026-09 per-server 修订 +
 * dsh 直连不挂载修订): registered as `settings.section` id `dsh-runtime`
 * (order 31, right after agent-presets) for every source with a chamber
 * runtime management surface: local = full management surface; gateway =
 * full per-server segment proxied through `/chamber/runtime`
 * (status/versions/select/apply/rollback/restore-builtin/retry-apply/
 * retry-restore/registry/restart, design 18 §9.3 + design 17 §3). Direct dsh
 * targets (ssh or http) mount no section — the remote runtime is
 * systemd-deployed and no management surface exists. Every mounted source
 * gets the「重启 dsh」
 * action (design 18 §3.6 项 8) to refresh mounted plugins.
 *
 * Runtime facts and mutations remain main-process/gateway-authoritative. The
 * local view consumes the shared renderer projection so its action gates,
 * status copy, SemVer ordering and subscription lifecycle stay aligned with
 * the connections local-start gate; the gateway view consumes the gateway's
 * own `/chamber/runtime` projection through the same-origin instance proxy
 * (no token ever leaves the main process, design 17 §7.2/§12).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'
import {
  compareSemver,
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
import {
  fetchRemoteRuntimeStatus,
  fetchRemoteRuntimeVersions,
  pollRemoteRuntimeUntilSettled,
  remoteRuntimeAction,
  remoteRuntimeActionGates,
  remoteRuntimeSetRegistry,
  remoteRuntimeStatusView,
  resetRemoteRuntimeActivityOwners,
  type RemoteRuntimeStatus,
  type RemoteVersions,
} from './gateway-runtime-api.ts'
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
  /** The canonical per-instance id (local | gateway-<id>). */
  chamberInstanceId?: string
}

/**
 * Full per-server「dsh 运行时」segment for a GATEWAY connection (design 18
 * §3.6/§9.3, design 17 §3): every fact and action goes through the instance's
 * same-origin `/api/i/gateway-<id>/chamber/runtime/*` proxy — the gateway's
 * own status is the authority, the desktop never touches the token. The
 * restart action (design 18 §3.6 项 8) stays the shared transactional flow
 * (POST /restart 202 + pollGatewayReady) owned by the parent so the local and
 * gateway branches keep identical semantics.
 *
 * Remote status is polled every ~3s (the /chamber/runtime controller stays
 * mounted while dsh is down — applying/restart windows keep progress
 * pollable); versions are pulled on entry and re-pulled after a status change
 * that may have altered the cached-tree list (an install finishing). Action
 * errors (409 refusals and failures) surface on the shared actionError row
 * with the server's own `error` copy passed through verbatim.
 */
function GatewayRuntimeSection({
  t,
  chamberInstanceId,
  restarting,
  onRestartDsh,
  restartNote,
  actionError,
  setActionError,
}: {
  t: RuntimeTranslate
  chamberInstanceId: string
  restarting: boolean
  onRestartDsh: () => Promise<void>
  restartNote: string | null
  actionError: string | null
  setActionError: (error: string | null) => void
}) {
  const STATUS_POLL_MS = 3_000
  const [remoteStatus, setRemoteStatus] = useState<RemoteRuntimeStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [remoteVersions, setRemoteVersions] = useState<RemoteVersions | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [versionsEpoch, setVersionsEpoch] = useState(0)
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null)
  const selectionExplicit = useRef(false)
  const [actionBusy, setActionBusy] = useState(false)
  const actionInFlight = useRef(false)
  const actionController = useRef<AbortController | null>(null)
  const componentActive = useRef(true)
  const lastPhaseRef = useRef<string | null>(null)
  const [registrySelection, setRegistrySelection] = useState(NPMJS)
  const [customOrigin, setCustomOrigin] = useState('')
  const [registryEditing, setRegistryEditing] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [registryBusy, setRegistryBusy] = useState(false)
  const registryInFlight = useRef(false)
  const registryController = useRef<AbortController | null>(null)

  useEffect(() => {
    const idle = resetRemoteRuntimeActivityOwners({
      actionController,
      actionInFlight,
      registryController,
      registryInFlight,
    })
    componentActive.current = true
    // Cleanup clears controller ownership before the stale promise reaches its
    // identity-fenced finally block. Reset the visible busy flags here for the
    // newly selected instance; the old promise must never publish into it.
    setActionBusy(idle.actionBusy)
    setRegistryBusy(idle.registryBusy)
    return () => {
      componentActive.current = false
      resetRemoteRuntimeActivityOwners({
        actionController,
        actionInFlight,
        registryController,
        registryInFlight,
      })
    }
  }, [chamberInstanceId])

  // Remote status poll (design 18 §9.3 mounting discipline): the section stays
  // live through dsh-down windows. A transient fetch failure keeps the last
  // status beside an honest error line; a phase transition out of installing
  // re-pulls the version list (the install may have added a cached tree).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const tick = async (): Promise<void> => {
      try {
        const status = await fetchRemoteRuntimeStatus(chamberInstanceId, { signal: controller.signal })
        if (!cancelled) {
          if ((lastPhaseRef.current === 'installing' || lastPhaseRef.current === 'applying')
            && status.phase !== 'installing' && status.phase !== 'applying') {
            setVersionsEpoch((epoch) => epoch + 1)
          }
          lastPhaseRef.current = status.phase
          setRemoteStatus(status)
          setStatusError(null)
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setStatusError(errorMessage(error))
      } finally {
        if (!cancelled) timer = setTimeout(() => { void tick() }, STATUS_POLL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chamberInstanceId])

  // Version list: pulled once on entry and re-pulled after a status change
  // (versionsEpoch bumps on an install/apply→settled transition or after select).
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetchRemoteRuntimeVersions(chamberInstanceId, { signal: controller.signal })
      .then((versions) => {
        if (!cancelled) {
          setRemoteVersions(versions)
          setVersionsError(null)
        }
      })
      .catch((error) => {
        if (!cancelled && !controller.signal.aborted) setVersionsError(errorMessage(error))
      })
    return () => { cancelled = true; controller.abort() }
  }, [chamberInstanceId, versionsEpoch])

  // Descending semver order (newest first); entries that do not parse as
  // exact semver keep their server-relative order at the tail.
  const sortedVersions = useMemo(() => {
    const list = remoteVersions?.versions ?? []
    return [...list].sort((a, b) => compareSemver(b.version, a.version) ?? 0)
  }, [remoteVersions])

  const remoteActive = remoteStatus?.activeVersion ?? null
  const latestTag = useMemo(
    () => sortedVersions.find(entry => entry.latest)?.version ?? null,
    [sortedVersions],
  )

  // Preserve an explicit choice across status pushes / version re-pulls;
  // before the user chooses, the recommendation wins, then the active version
  // (same policy as the local branch's preferredRuntimeVersion).
  useEffect(() => {
    if (remoteStatus === null) return
    setSelectedRemote((current) => {
      const stillExplicit = selectionExplicit.current
        && current !== null
        && sortedVersions.some(entry => entry.version === current)
      if (!stillExplicit) selectionExplicit.current = false
      return preferredRuntimeVersion(stillExplicit ? current : null, sortedVersions, latestTag, remoteActive)
    })
  }, [remoteStatus, sortedVersions, latestTag, remoteActive])

  const chosenRemote = preferredRuntimeVersion(
    selectionExplicit.current ? selectedRemote : null,
    sortedVersions,
    latestTag,
    remoteActive,
  )
  const isActiveRemote = chosenRemote !== null && chosenRemote === remoteActive

  const envGatedRemote = remoteStatus?.source === 'env'
  // Pure mirror of the server fences: pending permits only restore-builtin;
  // install/apply/restart-in-flight permit no action. Registry editing is a
  // version mutation; restart stays source-independent (including env).
  const remoteGates = remoteRuntimeActionGates(remoteStatus, actionBusy || registryBusy || restarting)
  const mutationDisabled = remoteGates.mutationDisabled
  const restoreBuiltinDisabled = remoteGates.restoreBuiltinDisabled
  const retryApplyDisabled = remoteGates.retryApplyDisabled
  const retryRestoreDisabled = remoteGates.retryRestoreDisabled

  const runRemoteAction = useCallback(async (task: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    // React state is not a synchronous mutex: two clicks in the same render
    // can both observe actionBusy=false. Fence before the first await and keep
    // one abort owner for instance switches/unmount.
    if (actionInFlight.current) return
    actionInFlight.current = true
    const controller = new AbortController()
    actionController.current = controller
    setActionBusy(true)
    setActionError(null)
    try {
      await task(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted && componentActive.current) setActionError(errorMessage(error))
    } finally {
      if (actionController.current === controller) {
        actionController.current = null
        actionInFlight.current = false
        if (componentActive.current) setActionBusy(false)
      }
    }
  }, [setActionError])

  const onApplySelected = useCallback(() => {
    if (chosenRemote === null || isActiveRemote || mutationDisabled) return
    void runRemoteAction(async (signal) => {
      // select = async install job (202, progress via status).phase; after it
      // settles, apply() arms the next-startup switch — the gateway analog of
      // the local branch's「更新到 vY」install→pending flow (design 18 §3.6
      // 项 3 + §9.3 route table: select records the choice WITHOUT pending,
      // apply is the separate action that arms it).
      const result = await remoteRuntimeAction(chamberInstanceId, { kind: 'select', version: chosenRemote }, { signal })
      if (result.status === 202) {
        const status = await pollRemoteRuntimeUntilSettled(chamberInstanceId, 'select', { signal })
        if (!signal.aborted) setRemoteStatus(status)
      }
      if (chosenRemote !== remoteActive) {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'apply' }, { signal })
      }
      // The install may have added a cached tree — refresh the selector.
      setVersionsEpoch((epoch) => epoch + 1)
    })
  }, [chamberInstanceId, chosenRemote, isActiveRemote, mutationDisabled, remoteActive, runRemoteAction])

  const onRollback = useCallback(() => {
    if (chosenRemote === null || isActiveRemote || mutationDisabled) return
    void runRemoteAction(async (signal) => {
      // rollback arms the pending switch itself (pre-rollback stash + snapshot
      // semantics, design 18 §3.7/§9.3); the switch lands on the next gateway
      // restart.
      await remoteRuntimeAction(chamberInstanceId, { kind: 'rollback', version: chosenRemote }, { signal })
    })
  }, [chamberInstanceId, chosenRemote, isActiveRemote, mutationDisabled, runRemoteAction])

  const onRestoreBuiltin = useCallback(() => {
    if (restoreBuiltinDisabled) return
    void runRemoteAction(async (signal) => {
      await remoteRuntimeAction(chamberInstanceId, { kind: 'restore-builtin' }, { signal })
    })
  }, [chamberInstanceId, restoreBuiltinDisabled, runRemoteAction])

  const onRetryApply = useCallback(() => {
    if (retryApplyDisabled) return
    void runRemoteAction(async (signal) => {
      await remoteRuntimeAction(chamberInstanceId, { kind: 'retry-apply' }, { signal })
    })
  }, [chamberInstanceId, retryApplyDisabled, runRemoteAction])

  const onRetryRestore = useCallback(() => {
    if (retryRestoreDisabled) return
    void runRemoteAction(async (signal) => {
      await remoteRuntimeAction(chamberInstanceId, { kind: 'retry-restore' }, { signal })
    })
  }, [chamberInstanceId, retryRestoreDisabled, runRemoteAction])

  // Apply now on the gateway (design 18 addendum §5.1/§6.3): the pending
  // immediate-switch action goes through the 202 route, polls the applying
  // window to settlement, then refreshes the version list — mirroring
  // onApplySelected. The UI owns the second confirmation here (the gateway
  // has no native dialog): title + body in one confirm message.
  const onApplyNowRemote = useCallback(() => {
    const target = remoteStatus?.pending
    if (remoteStatus === null || target === null || remoteGates.applyNowDisabled) return
    const message = `${t('dshRuntimeApplyNowConfirmTitle', { version: target })}\n\n${t('dshRuntimeApplyNowConfirmBody', { version: target })}`
    if (!window.confirm(message)) return
    void runRemoteAction(async (signal) => {
      const result = await remoteRuntimeAction(chamberInstanceId, { kind: 'apply-now' }, { signal })
      if (result.status === 202) {
        const status = await pollRemoteRuntimeUntilSettled(chamberInstanceId, 'apply-now', { signal })
        if (!signal.aborted) setRemoteStatus(status)
      }
      // The applied version may have changed the cached-tree list.
      setVersionsEpoch((epoch) => epoch + 1)
    })
  }, [chamberInstanceId, remoteStatus, remoteGates.applyNowDisabled, t, runRemoteAction])

  const registryOrigin = remoteStatus?.registry ?? ''
  const registryMode = registryOrigin === NPMJS || registryOrigin === NPMMIRROR
    ? registryOrigin
    : CUSTOM_REGISTRY

  useEffect(() => {
    setRegistrySelection(registryMode)
    if (registryMode === CUSTOM_REGISTRY) setCustomOrigin(registryOrigin)
  }, [registryMode, registryOrigin])

  const onApplyRegistry = useCallback(async (origin: string): Promise<void> => {
    if (registryInFlight.current) return
    registryInFlight.current = true
    const controller = new AbortController()
    registryController.current = controller
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      await remoteRuntimeSetRegistry(chamberInstanceId, origin, { signal: controller.signal })
      if (!controller.signal.aborted && componentActive.current) setRegistryEditing(false)
    } catch (error) {
      if (!controller.signal.aborted && componentActive.current) setRegistryError(errorMessage(error))
    } finally {
      if (registryController.current === controller) {
        registryController.current = null
        registryInFlight.current = false
        if (componentActive.current) setRegistryBusy(false)
      }
    }
  }, [chamberInstanceId])

  // Retryability derives from the server's own phase projection (the routes
  // refuse with 409 no_retry_target otherwise): retry-apply resumes an
  // interrupted pointer switch / snapshot failure; retry-restore resumes an
  // interrupted data restore.
  const canRetryApplyRemote = remoteStatus !== null
    && (remoteStatus.phase === 'swap-attempted' || remoteStatus.phase === 'snapshot-failed')
  const canRetryRestoreRemote = remoteStatus !== null
    && remoteStatus.phase === 'restore-blocked'

  const view = remoteStatus === null ? null : remoteRuntimeStatusView(remoteStatus)
  const phaseBadgeKey = remoteStatus === null
    ? null
    : remoteStatus.phase === 'installing'
      ? 'dshRuntimeRemotePhaseInstalling'
      : remoteStatus.phase === 'pending'
        ? 'dshRuntimeRemotePhasePending'
        : remoteStatus.phase === 'applying'
          ? 'dshRuntimeRemotePhaseApplying'
      : remoteStatus.phase === 'snapshot-failed'
        ? 'dshRuntimeRemotePhaseSnapshotFailed'
        : remoteStatus.phase === 'swap-attempted'
          ? 'dshRuntimeRemotePhaseSwapAttempted'
          : remoteStatus.phase === 'restore-blocked'
            ? 'dshRuntimeRemotePhaseRestoreBlocked'
            : 'dshRuntimeRemotePhaseIdle'
  const sourceTag = remoteStatus === null || remoteStatus.source === null
    ? null
    : remoteStatus.source === 'env'
      ? t('dshRuntimeEnvTag')
      : remoteStatus.source === 'user-selected'
        ? t('dshRuntimeUserTag')
        : t('dshRuntimeRemoteAnchorTag')

  const statusText = useMemo(() => {
    if (view === null) return null
    const title = t(view.titleKey, view.params)
    return view.detail !== null && view.detail !== ''
      ? `${title}：${view.detail}`
      : title
  }, [view, t])

  const remoteProgress = remoteStatus?.progress ?? null
  const remoteShowProgress = remoteProgress !== null
    || remoteStatus?.phase === 'installing' || remoteStatus?.phase === 'applying'
  const remoteProgressPercent = remoteProgress?.stage === 'download'
    && typeof remoteProgress.total === 'number' && remoteProgress.total > 0
    ? Math.min(100, Math.max(0, Math.round(((remoteProgress.received ?? 0) / remoteProgress.total) * 100)))
    : null
  const remoteProgressLabel = useMemo(() => {
    if (remoteProgress?.stage === 'download') {
      return remoteProgressPercent !== null
        ? t('dshRuntimeProgressDownloading', { percent: remoteProgressPercent })
        : t('dshRuntimeProgressDownloadingIndeterminate')
    }
    switch (remoteProgress?.stage) {
      case 'install': return t('dshRuntimeProgressInstalling')
      case 'prune': return t('dshRuntimeProgressPruning')
      case 'smoke': return t('dshRuntimeProgressSmoke')
      case 'publish': return t('dshRuntimeProgressPublishing')
      default: return t('dshRuntimeProgressApplying')
    }
  }, [remoteProgress, remoteProgressPercent, t])

  const remoteSnapshotText = remoteStatus === null
    ? null
    : remoteStatus.snapshotError !== null
      ? t('dshRuntimeSnapshotFailed', { error: remoteStatus.snapshotError })
      : remoteStatus.restoreOutcome === 'half'
        ? t('dshRuntimeSnapshotRestoreHalf')
        : remoteStatus.restoreOutcome === 'incomplete' || remoteStatus.restoreInProgress === true
          ? t('dshRuntimeSnapshotRestoreIncomplete')
          : remoteStatus.snapshotCount === null
            ? t('dshRuntimeSnapshotUnknown')
            : t('dshRuntimeSnapshotSummary', {
                count: remoteStatus.snapshotCount,
                at: remoteStatus.latestSnapshotAt !== null
                  ? formatTimestamp(remoteStatus.latestSnapshotAt)
                  : t('dshRuntimeSnapshotNever'),
              })

  const remoteRestartDisabled = remoteGates.restartDisabled

  const restartActions = (
    <>
      <div className={css.updateStatusLine}>
        <button
          type="button"
          className={css.updateButton}
          onClick={() => { void onRestartDsh() }}
          disabled={remoteRestartDisabled}
        >
          {restarting ? t('dshRuntimeRestarting') : t('dshRuntimeRestartAction')}
        </button>
      </div>
      {restartNote !== null && <p className={css.generalHint} role="status">{restartNote}</p>}
      {actionError !== null && <p className={css.generalError} role="alert">{actionError}</p>}
    </>
  )

  if (remoteStatus === null) {
    return (
      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>
        {statusError !== null ? (
          <>
            <p className={css.generalError} role="alert">{t('dshRuntimeRemoteUnavailable')}</p>
            <p className={css.generalError} role="alert">{statusError}</p>
          </>
        ) : (
          <p className={css.generalHint} role="status">{t('dshRuntimeRemoteLoading')}</p>
        )}
        {restartActions}
      </div>
    )
  }

  return (
    <div className={css.generalGroup}>
      <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>

      <h4 className={css.generalGroupTitle}>{t('dshRuntimeGroupStatus')}</h4>

      <div className={css.updateVersionRow}>
        <p className={css.updateRow}>
          {t('updateCurrentVersion', { version: remoteStatus.activeVersion ?? t('dshRuntimeVersionUnknown') })}
          {sourceTag !== null ? `（${sourceTag}）` : ''}
          {' '}
          {/* A FATAL metadata block projects phase idle while
              startupBlockedReason is set — an idle badge next to a blocked
              status line would be contradictory, so suppress it there. */}
          {phaseBadgeKey !== null
            && !(view !== null && view.kind === 'blocked' && remoteStatus.phase === 'idle') && (
            <span className={css.runtimeBadge} role="status">{t(phaseBadgeKey)}</span>
          )}
        </p>
      </div>
      <div className={css.updateStatus} aria-live="polite">
        <p className={css.updateStatusText}>{statusText}</p>
      </div>
      {remoteShowProgress && (
        <div className={css.runtimeProgressBlock} role="status" aria-live="polite">
          <span className={css.runtimeProgressLabel}>{remoteProgressLabel}</span>
          <div className={css.runtimeProgressTrack}>
            <div
              className={remoteProgressPercent === null ? css.runtimeProgressBarIndeterminate : css.runtimeProgressBar}
              style={remoteProgressPercent === null ? undefined : { width: `${remoteProgressPercent}%` }}
            />
          </div>
        </div>
      )}
      {remoteStatus.activeVersion !== null && remoteStatus.builtinVersion !== null
        && remoteStatus.activeVersion !== remoteStatus.builtinVersion && (
        <p className={css.generalHint}>{t('dshRuntimeBundledRow')} v{remoteStatus.builtinVersion}</p>
      )}

      {statusError !== null && <p className={css.generalHint} role="status">{statusError}</p>}
      {remoteStatus.connectionState !== null && remoteStatus.connectionState !== 'ready' && (
        <p className={css.generalHint} role="status">
          {t('dshRuntimeRemoteConnState', { state: remoteStatus.connectionState })}
        </p>
      )}
      {envGatedRemote && <p className={css.generalHint}>{t('dshRuntimeRemoteEnvHint')}</p>}
      {remoteStatus.pending !== null && remoteStatus.phase !== 'applying' && (
        <p className={css.generalHint}>{t('dshRuntimePendingRecord', { version: remoteStatus.pending })}</p>
      )}
      {remoteSnapshotText !== null && <p className={css.generalHint}>{remoteSnapshotText}</p>}
      {/* Failure rows stay honest and separate when the status line does not
          already carry them (a failed view renders operationError in its
          title; a blocked view renders startupBlockedReason in its detail). */}
      {view !== null && view.kind !== 'failed' && remoteStatus.operationError !== null
        && remoteStatus.operationError !== '' && (
        <p className={css.generalError} role="alert">{remoteStatus.operationError}</p>
      )}
      {view !== null && view.kind !== 'blocked' && remoteStatus.startupBlockedReason !== null
        && remoteStatus.startupBlockedReason !== '' && (
        <p className={css.generalError} role="alert">{remoteStatus.startupBlockedReason}</p>
      )}

      <h4 className={css.generalGroupTitle}>{t('dshRuntimeGroupActions')}</h4>

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeSelectVersion')}</span>
        <div className={css.runtimeSelectRow}>
          <select
            className={css.runtimeField}
            value={chosenRemote ?? ''}
            disabled={mutationDisabled}
            onChange={(event) => {
              selectionExplicit.current = true
              setSelectedRemote(event.target.value)
            }}
          >
            {sortedVersions.length === 0
              ? <option value="" disabled>{t('dshRuntimeNoVersions')}</option>
              : sortedVersions.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  v{entry.version}
                  {entry.version === remoteActive ? ` · ${t('current')}` : ''}
                  {entry.latest ? ` · ${t('dshRuntimeLatestTag')}` : ''}
                  {entry.cached ? ` · ${t('dshRuntimeCachedTag')}` : ''}
                  {entry.belowBaseline ? ` · ${t('dshRuntimeBelowBaselineTag')}` : ''}
                </option>
              ))}
          </select>
          <button
            type="button"
            className={css.updatePrimaryButton}
            onClick={() => { void onApplySelected() }}
            disabled={mutationDisabled || isActiveRemote || chosenRemote === null}
          >
            {actionBusy ? t('dshRuntimeRemoteApplying') : t('dshRuntimeApplyNextLaunchOnly')}
          </button>
        </div>
      </label>

      {versionsError !== null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeRemoteVersionsUnavailable', { error: versionsError })}
        </p>
      )}

      <div className={css.updateStatusLine}>
        {/* Pending = the gateway's apply-now window (design 18 addendum
            §5.1/§6.1): the immediate-switch primary action appears only while
            the server-side gates are open (not busy/recovery/env/read-only
            and the managed dsh live). */}
        {remoteStatus.phase === 'pending' && remoteStatus.pending !== null && !remoteGates.applyNowDisabled && (
          <button
            type="button"
            className={css.updatePrimaryButton}
            onClick={() => { void onApplyNowRemote() }}
            disabled={remoteGates.applyNowDisabled}
          >
            {t('dshRuntimeApplyNowAction')}
          </button>
        )}
        {!isActiveRemote && chosenRemote !== null && (
          <button
            type="button"
            className={css.updateButton}
            onClick={() => { void onRollback() }}
            disabled={mutationDisabled}
          >
            {t('dshRuntimeActionRollback')} v{chosenRemote}
          </button>
        )}
        <button
          type="button"
          className={css.updateButton}
          onClick={() => { void onRestoreBuiltin() }}
          disabled={restoreBuiltinDisabled || !remoteStatus.hasOverride}
        >
          {t('dshRuntimeResetBuiltin')}
        </button>
        {canRetryApplyRemote && (
          <button type="button" className={css.updateButton} onClick={() => { void onRetryApply() }} disabled={retryApplyDisabled}>
            {t('dshRuntimeRetryApply')}
          </button>
        )}
        {canRetryRestoreRemote && (
          <button type="button" className={css.updateButton} onClick={() => { void onRetryRestore() }} disabled={retryRestoreDisabled}>
            {t('dshRuntimeRetryRestore')}
          </button>
        )}
      </div>

      {restartActions}

      {remoteStatus.failure !== null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeFailureRecord', {
            version: remoteStatus.failure.version,
            at: formatTimestamp(remoteStatus.failure.at),
            reason: remoteStatus.failure.reason,
          })}
        </p>
      )}

      <h4 className={css.generalGroupTitle}>{t('dshRuntimeGroupSource')}</h4>

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeRegistryLabel')}</span>
        {registryEditing ? (
          <div className={css.runtimeSelectRow}>
            <select
              className={css.runtimeField}
              value={registrySelection}
              disabled={mutationDisabled}
              onChange={(event) => {
                const value = event.target.value
                setRegistrySelection(value)
                if (value !== CUSTOM_REGISTRY) setCustomOrigin('')
              }}
            >
              <option value={NPMJS}>{t('dshRuntimeRegistryNpmjs')}</option>
              <option value={NPMMIRROR}>{t('dshRuntimeRegistryNpmmirror')}</option>
              <option value={CUSTOM_REGISTRY}>{t('dshRuntimeRegistryCustomLabel')}</option>
            </select>
            {registrySelection === CUSTOM_REGISTRY && (
              <input
                type="url"
                className={css.runtimeField}
                value={customOrigin}
                placeholder="https://registry.example.com"
                disabled={mutationDisabled}
                onChange={(event) => setCustomOrigin(event.target.value)}
              />
            )}
            <button
              type="button"
              className={css.updateButton}
              disabled={mutationDisabled
                || (registrySelection === CUSTOM_REGISTRY && customOrigin.trim() === '')}
              onClick={() => {
                void onApplyRegistry(
                  registrySelection === CUSTOM_REGISTRY ? customOrigin.trim() : registrySelection,
                )
              }}
            >
              {registryBusy ? t('dshRuntimeRegistryApplying') : t('dshRuntimeRegistryApply')}
            </button>
            <button
              type="button"
              className={css.updateButton}
              disabled={registryBusy}
              onClick={() => setRegistryEditing(false)}
            >
              {t('dshRuntimeRegistryCancel')}
            </button>
          </div>
        ) : (
          <div className={css.updateStatusLine}>
            <span className={css.generalHint}>
              {t('dshRuntimeRegistryCurrent', { origin: registryOrigin !== '' ? registryOrigin : '—' })}
            </span>
            <button
              type="button"
              className={css.updateButton}
              disabled={mutationDisabled}
              onClick={() => setRegistryEditing(true)}
            >
              {t('dshRuntimeRegistryEdit')}
            </button>
          </div>
        )}
      </label>

      {registryError !== null && <p className={css.generalError} role="alert">{registryError}</p>}
      {remoteStatus.registryError !== null && (
        <p className={css.generalError} role="alert">{remoteStatus.registryError}</p>
      )}
      {remoteStatus.diskUsage !== null && (
        <p className={css.generalHint}>
          {t('dshRuntimeDiskSummary', {
            total: formatRuntimeBytes(remoteStatus.diskUsage.totalBytes),
            trees: remoteStatus.diskUsage.versionTrees,
            treeBytes: formatRuntimeBytes(remoteStatus.diskUsage.versionTreeBytes),
            storeBytes: formatRuntimeBytes(remoteStatus.diskUsage.storeBytes),
            cacheBytes: formatRuntimeBytes(
              remoteStatus.diskUsage.cacheBytes
              + remoteStatus.diskUsage.installHomeBytes
              + remoteStatus.diskUsage.xdgCacheBytes
              + remoteStatus.diskUsage.workBytes,
            ),
            snapshotBytes: formatRuntimeBytes(remoteStatus.diskUsage.snapshotBytes),
            recoveryBytes: formatRuntimeBytes(
              remoteStatus.diskUsage.preRollbackBytes
              + remoteStatus.diskUsage.restoreBackupBytes
              + remoteStatus.diskUsage.failureBytes,
            ),
          })}
        </p>
      )}
      {remoteStatus.diskError !== null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeDiskError', { error: remoteStatus.diskError })}
        </p>
      )}
      {remoteStatus.diskLimitExceeded === true && remoteStatus.diskLimitBytes !== null && (
        <p className={css.generalError} role="status">
          {t('dshRuntimeDiskQuotaWarning', { limit: formatRuntimeBytes(remoteStatus.diskLimitBytes) })}
        </p>
      )}
    </div>
  )
}

export function DshRuntimeSection({
  t,
  instanceSource = 'local',
  chamberInstanceId,
}: DshRuntimeSectionProps) {
  const state = useSyncExternalStore(subscribeRuntimeState, getRuntimeState)
  const settingsStatus = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartNote, setRestartNote] = useState<string | null>(null)
  // True only while a user-triggered apply-now transaction is in flight — the
  // honest window copy for the applying phase (design 18 addendum §6.2/§6.3).
  const [applyNowInFlight, setApplyNowInFlight] = useState(false)
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
  // /chamber/runtime/restart（202 + status 轮询）。
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

  // Apply now (design 18 addendum §2.1/§4.1): run the pending activation
  // transaction in the current session. The desktop main owns the native
  // second confirmation (confirmRuntimeMutation) and the whole transaction
  // window (phase 'applying' + runtimeBlocked), so no renderer confirm is
  // shown here — a UI confirm on top of the native dialog would double-prompt
  // (§6.3: desktop = native dialog, gateway = UI window.confirm). The native
  // dialog is async, so a synchronous ref gate prevents a same-frame
  // double-click from stacking a second IPC/confirm (design 18 addendum §6.2).
  const applyNowRef = useRef(false)
  const onApplyNow = useCallback(() => {
    if (applyNowRef.current) return
    // Re-resolve the surface at click time: a bridge torn down between render
    // and click must never claim an apply that cannot run.
    const surface = currentRuntimeSurface()
    if (surface === null || envGated || !actions.has('apply-now') || pending === null) return
    applyNowRef.current = true
    setApplyNowInFlight(true)
    void runRuntimeAction(() => surface.applyNow()).finally(() => {
      setApplyNowInFlight(false)
      applyNowRef.current = false
    })
  }, [envGated, actions, pending, runRuntimeAction])

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
      // Honest window copy (design 18 addendum §6.2): while a user-triggered
      // apply-now transaction runs, the status line names the immediate
      // restart instead of the next-launch applying wording; terminal states
      // (applied/rollback/failed) always take over through their own kinds.
      case 'applying': return applyNowInFlight
        ? t('dshRuntimeStatusApplyingNow', { version })
        : t('dshRuntimeStatusApplying', { version })
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
  }, [status, t, applyNowInFlight])

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
  // Immediate-apply (design 18 addendum §6.1): visible only in the pending
  // phase; env/runtimeBlocked/managementSupported gates are already folded
  // into the action set by runtimeAllowedActions.
  const canApplyNow = actions.has('apply-now')
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

  // Remote source (design 18 §3.6): gateway = full per-server segment
  // proxied through /chamber/runtime (§9.3).
  if (instanceSource === 'gateway') {
    if (chamberInstanceId === undefined) {
      // Defensive: never render the management surface without a canonical
      // id — a render-time mismatch falls back to the honest unavailable hint.
      return (
        <div className={css.generalGroup}>
          <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>
          <p className={css.generalHint}>{t('dshRuntimeRemoteUnavailable')}</p>
        </div>
      )
    }
    // keyed per server: switching the selected server remounts a fresh section
    // (never the previous server's status/versions/selection).
    return (
      <GatewayRuntimeSection
        key={chamberInstanceId}
        t={t}
        chamberInstanceId={chamberInstanceId}
        restarting={restarting}
        onRestartDsh={onRestartDsh}
        restartNote={restartNote}
        actionError={actionError}
        setActionError={setActionError}
      />
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
            className={css.runtimeField}
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
      {/* Pending = the apply-now window (design 18 addendum §6.1): the main
          [立即应用 v{version}] action plus the hint that the alternative is
          next launch; [恢复内建] stays in the recovery row below. */}
      {phase === 'pending' && pending !== null && canApplyNow && (
        <>
          <div className={css.updateStatusLine}>
            <button
              type="button"
              className={css.updatePrimaryButton}
              onClick={onApplyNow}
              disabled={mutationDisabled}
            >
              {t('dshRuntimeApplyNowActionWithVersion', { version: pending })}
            </button>
          </div>
          <p className={css.generalHint}>{t('dshRuntimeApplyNowHint')}</p>
        </>
      )}
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
            className={css.runtimeField}
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
            className={css.runtimeField}
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
