/**
 * Chamber-global dsh runtime management block (design 17 §3.6).
 *
 * Runtime facts and mutations remain main-process authoritative. This view
 * consumes the shared renderer projection so its action gates, status copy,
 * SemVer ordering and subscription lifecycle stay aligned with the
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
  runtimeSelectionDirection,
  subscribeRuntimeState,
  type RuntimeMetadataComponent,
  type RuntimeVersionEntry,
} from '../../../../packages/renderer/src/runtime-management.ts'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
import css from './SettingsShell.module.css'

type RuntimeTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

const NPMJS = 'https://registry.npmjs.org'
const NPMMIRROR = 'https://registry.npmmirror.com'
const CUSTOM_REGISTRY = '__custom__'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

export function DshRuntimeSection({ t }: { t: RuntimeTranslate }) {
  const state = useSyncExternalStore(subscribeRuntimeState, getRuntimeState)
  const settingsStatus = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const selectionExplicit = useRef(false)
  const [customOrigin, setCustomOrigin] = useState('')
  const [registrySelection, setRegistrySelection] = useState(NPMJS)
  const [actionError, setActionError] = useState<string | null>(null)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [registryReachable, setRegistryReachable] = useState(false)
  const [testingRegistry, setTestingRegistry] = useState(false)

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

  const onCleanupVersion = useCallback(() => {
    if (runtime === null || chosen === null || !cleanupEligible || !actions.has('cleanup-version')) return
    void runRuntimeAction(() => runtime.cleanupVersion(chosen))
  }, [runtime, chosen, cleanupEligible, actions, runRuntimeAction])

  const onApplyRegistry = useCallback(async (origin: string): Promise<boolean> => {
    if (envGated || !actions.has('check')) return false
    setBusy(true)
    setRegistryError(null)
    setRegistryReachable(false)
    try {
      const result = await applySettingsPatch({ registryOrigin: origin })
      if (!result.ok) {
        setRegistryError(result.error)
        return false
      }
      return true
    } catch (error) {
      setRegistryError(errorMessage(error))
      return false
    } finally {
      setBusy(false)
    }
  }, [envGated, actions])

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
        at: snapshot.latestAt ?? t('dshRuntimeSnapshotNever'),
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
  const hasVisibleRuntimeAction = canInstall || canReset || canRetryApply || canRetryRestore
    || canRecoverMetadata || canCleanup
  const operationDisabled = !hydrated || busy || testingRegistry
  const mutationDisabled = operationDisabled || envGated || managementGated
  const registryDisabled = settingsStatus === null || mutationDisabled || !canCheck
  const metadataComponents = (state?.metadataComponents ?? [])
    .map(component => metadataComponentText(component, t))
    .join(t('dshRuntimeMetadataComponentSeparator')) || t('dshRuntimeMetadataComponentUnknown')

  return (
    <div className={css.generalGroup}>
      <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>

      <div className={css.updateVersionRow}>
        <p className={css.updateRow}>
          {active === null
            ? `${t('dshRuntimeTitle')} ${t('dshRuntimeVersionUnknown')}`
            : `${t('dshRuntimeTitle')} v${active}${sourceTag !== null ? `（${sourceTag}）` : ''}`}
        </p>
      </div>
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
              at: state.invalidationNotice.at,
            },
          )}
        </p>
      )}

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeSelectVersion')}</span>
        <select
          className={css.updateButton}
          value={chosen ?? ''}
          disabled={mutationDisabled || !canSelect}
          onChange={(event) => {
            selectionExplicit.current = true
            setSelected(event.target.value)
          }}
        >
          {versions.map((entry: RuntimeVersionEntry) => (
            <option key={entry.version} value={entry.version}>
              v{entry.version}
              {entry.version === active ? ` · ${t('current')}` : ''}
              {entry.latest ? ` · ${t('dshRuntimeLatestTag')}` : ''}
              {entry.cached ? ` · ${t('dshRuntimeCachedTag')}` : ''}
              {entry.belowBaseline ? ` · ${t('dshRuntimeBelowBaselineTag')}` : ''}
            </option>
          ))}
        </select>
      </label>

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeRegistryLabel')}</span>
        <select
          className={css.updateButton}
          value={registrySelection}
          disabled={registryDisabled}
          onChange={(event) => {
            const value = event.target.value
            setRegistrySelection(value)
            if (value !== CUSTOM_REGISTRY) {
              void onApplyRegistry(value).then((ok) => {
                if (!ok) setRegistrySelection(registryMode)
              })
            }
          }}
        >
          <option value={NPMJS}>{t('dshRuntimeRegistryNpmjs')}</option>
          <option value={NPMMIRROR}>{t('dshRuntimeRegistryNpmmirror')}</option>
          <option value={CUSTOM_REGISTRY}>{t('dshRuntimeRegistryCustomLabel')}</option>
        </select>
        <span className={css.generalHint}>{t('dshRuntimeRegistryHint')}</span>
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
              if (event.key === 'Enter' && customOrigin.trim() !== '') void onApplyRegistry(customOrigin.trim())
            }}
          />
          <button
            type="button"
            className={css.updateButton}
            disabled={registryDisabled || customOrigin.trim() === ''}
            onClick={() => { void onApplyRegistry(customOrigin.trim()) }}
          >
            {t('dshRuntimeRegistryApply')}
          </button>
        </label>
      )}

      <div className={css.updateStatusLine}>
        <button
          type="button"
          className={css.updateButton}
          disabled={!canCheck || testingRegistry || busy}
          onClick={() => { void onTestRegistry() }}
        >
          {t('dshRuntimeRegistryTest')}
        </button>
      </div>

      {registryError !== null && <p className={css.generalError} role="alert">{registryError}</p>}
      {registryReachable && <p className={css.generalHint} role="status">{t('dshRuntimeRegistryReachable')}</p>}

      {hasVisibleRuntimeAction && (
        <div className={css.updateStatusLine}>
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
          {canRetryApply && (
            <button type="button" className={css.updatePrimaryButton} onClick={onRetryApply} disabled={mutationDisabled}>
              {t('dshRuntimeRetryApply')}
            </button>
          )}
          {canRetryRestore && (
            <button type="button" className={css.updatePrimaryButton} onClick={onRetryRestore} disabled={operationDisabled}>
              {t('dshRuntimeRetryRestore')}
            </button>
          )}
          {canRecoverMetadata && (
            <button
              type="button"
              className={css.updatePrimaryButton}
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
          {canCleanup && chosen !== null && (
            <button type="button" className={css.updateButton} onClick={onCleanupVersion} disabled={mutationDisabled}>
              {t('dshRuntimeCleanupVersion')} v{chosen}
            </button>
          )}
        </div>
      )}

      <div className={css.updateStatus} aria-live="polite">
        <p className={css.updateStatusText}>{statusText}</p>
      </div>

      {state?.failure != null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeFailureRecord', {
            version: state.failure.version,
            at: state.failure.at,
            reason: state.failure.reason,
          })}
        </p>
      )}
      {actionError !== null && <p className={css.generalError} role="alert">{actionError}</p>}
      <p className={css.generalHint}>{snapshotText}</p>
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
      {pending !== null && phase !== 'pending' && phase !== 'applying' && (
        <p className={css.generalHint}>{t('dshRuntimePendingRecord', { version: pending })}</p>
      )}
    </div>
  )
}
