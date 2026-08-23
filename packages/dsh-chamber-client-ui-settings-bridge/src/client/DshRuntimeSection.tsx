/**
 * dsh runtime version-management block (design 16 §3.6 A) — the interactive
 * M4 replacement for the M0 read-only version line. Renders the version
 * overview + selector + actions + status/failure rows by reading the
 * `window.dshChamber.runtime` surface (main-process controller projection).
 *
 * No registry-source row yet (that is a cross-cutting chamber-settings change,
 * deferred); this block covers version selection / update / rollback / reset
 * and the honest status + failure copy.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore, useState } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'
import type { RuntimeState, RuntimeVersionEntry } from '../../../../packages/renderer/src/global.d.ts'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
import css from './SettingsShell.module.css'

type RuntimeTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

/** Numeric-aware semver compare (renderer-side; the main process owns the
 *  authoritative compare, but the UI must not label update/rollback via string
 *  `>` — `'0.1.10' > '0.1.9'` is false). Versions are EXACT_SEMVER upstream. */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = b.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === y) continue
    // Release vs prerelease (same core): a release (no prerelease part) is
    // GREATER than a prerelease, so `1.0.0 > 1.0.0-rc.1` must be true.
    if (x === undefined) return typeof y === 'string'
    if (y === undefined) return typeof x === 'number'
    if (typeof x === 'number' && typeof y === 'number') return x > y
    if (typeof x === 'number') return true // numeric > prerelease string
    if (typeof y === 'number') return false
    return x > y
  }
  return false
}

/** Module-level cache so every mounted block shares one subscription. */
let cachedState: RuntimeState | null = null
const listeners = new Set<() => void>()

function subscribeRuntime(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    const runtime = typeof window !== 'undefined' ? window.dshChamber?.runtime : undefined
    if (runtime !== undefined) {
      void runtime.state().then((s) => { cachedState = s; emit() })
      runtime.onChanged((s) => { cachedState = s; emit() })
    }
  }
  return () => { listeners.delete(cb) }
}

function emit() {
  for (const cb of listeners) cb()
}

function getRuntimeState(): RuntimeState | null {
  return cachedState
}

export function DshRuntimeSection({ t }: { t: RuntimeTranslate }) {
  const state = useSyncExternalStore(subscribeRuntime, getRuntimeState)
  const settingsStatus = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [testingRegistry, setTestingRegistry] = useState(false)

  const runtime = typeof window !== 'undefined' ? window.dshChamber?.runtime : undefined
  const hydrated = state !== null

  const registryOrigin = settingsStatus?.settings.registryOrigin ?? 'https://registry.npmjs.org'

  const active = state?.active ?? null
  const bundled = state?.bundled ?? null
  const pending = state?.pending ?? null
  const phase = state?.phase ?? 'idle'
  const error = state?.error ?? null
  const versions = state?.versions ?? []

  const chosen = selected ?? (versions[0]?.version ?? null)
  const isActive = chosen !== null && chosen === active
  const isNewer = chosen !== null && active !== null && semverGt(chosen, active)
  const terminalGate = phase === 'pending' || phase === 'installing'
  const source = state?.source ?? 'bundled'
  // F6 env 来源：DSH_CHAMBER_DSH_PATH 设定时 active 由 env 决定，选择器/动作必须
  // 门控（选了也无效），并显式标记 (env)。
  const envGated = source === 'env'

  const sourceTag = active === null ? null : source === 'env' ? t('dshRuntimeEnvTag') : source === 'user' ? t('dshRuntimeUserTag') : t('dshRuntimeBuiltinTag')

  useEffect(() => {
    if (hydrated && selected === null && versions.length > 0) {
      setSelected(versions[0]!.version)
    }
  }, [hydrated, selected, versions])

  const onInstall = useCallback(() => {
    if (runtime === undefined || chosen === null || isActive || terminalGate) return
    setBusy(true)
    void runtime.install(chosen).finally(() => setBusy(false))
  }, [runtime, chosen, isActive, terminalGate])

  const onReset = useCallback(() => {
    if (runtime === undefined) return
    setBusy(true)
    void runtime.resetBuiltin().finally(() => setBusy(false))
  }, [runtime])

  const onApplyRegistry = useCallback(async (origin: string) => {
    setRegistryError(null)
    const result = await applySettingsPatch({ registryOrigin: origin })
    if (result !== null && typeof result === 'object' && 'error' in result) {
      setRegistryError(String((result as { error: unknown }).error))
    }
  }, [])

  const onTestRegistry = useCallback(async () => {
    if (runtime === undefined) return
    setTestingRegistry(true)
    setRegistryError(null)
    try {
      // check() fetches metadata from the selected origin; a non-error phase
      // means the origin answers (connectivity probe, §3.6 A.4 [测试连通]).
      const s = await runtime.check()
      if (s.phase === 'error') setRegistryError(s.error ?? 'registry 不可达')
    } finally {
      setTestingRegistry(false)
    }
  }, [runtime])

  const statusText = useMemo(() => {
    if (!hydrated) return t('dshRuntimeStatusNotChecked') // never a fake「已是最新」before hydration
    switch (phase) {
      case 'checking': return t('dshRuntimeStatusChecking')
      case 'available': return t('dshRuntimeStatusAvailable', { version: state?.latest ?? '—' })
      case 'installing': return t('dshRuntimeStatusInstalling', { version: chosen ?? '—' })
      case 'pending': return t('dshRuntimeStatusPending', { version: pending ?? '—' })
      case 'error': return t('dshRuntimeStatusError', { error: error ?? '—' })
      case 'idle':
        return versions.length > 0 ? t('dshRuntimeStatusIdle') : t('dshRuntimeStatusNotChecked')
      default: return t('dshRuntimeStatusIdle')
    }
  }, [hydrated, phase, state, chosen, pending, error, versions, t])

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
      {envGated && (
        <p className={css.generalHint}>{t('dshRuntimeEnvHint')}</p>
      )}

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeSelectVersion')}</span>
        <select
          className={css.updateButton}
          value={chosen ?? ''}
          disabled={!hydrated || busy || terminalGate || envGated}
          onChange={(e) => setSelected(e.target.value)}
        >
          {versions.map((v: RuntimeVersionEntry) => (
            <option key={v.version} value={v.version}>
              v{v.version}
              {v.latest ? ` · ${t('dshRuntimeLatestTag')}` : ''}
              {v.cached ? ` · ${t('dshRuntimeCachedTag')}` : ''}
              {v.belowBaseline ? ` · ${t('dshRuntimeBelowBaselineTag')}` : ''}
            </option>
          ))}
        </select>
      </label>

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeRegistryLabel')}</span>
        <select
          className={css.updateButton}
          value={registryOrigin}
          disabled={settingsStatus === null || busy}
          onChange={(e) => { void onApplyRegistry(e.target.value) }}
        >
          <option value="https://registry.npmjs.org">{t('dshRuntimeRegistryNpmjs')}</option>
          <option value="https://registry.npmmirror.com">{t('dshRuntimeRegistryNpmmirror')}</option>
        </select>
        <span className={css.generalHint}>{t('dshRuntimeRegistryHint')}</span>
      </label>

      <label className={css.generalRow}>
        <span className={css.generalFieldLabel}>{t('dshRuntimeRegistryCustomLabel')}</span>
        <input
          type="text"
          className={css.updateButton}
          placeholder="https://registry.example.com"
          disabled={settingsStatus === null || busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onApplyRegistry((e.target as HTMLInputElement).value)
          }}
        />
        <button type="button" className={css.updateButton} disabled={busy} onClick={() => {
          const input = document.querySelector<HTMLInputElement>('input[placeholder="https://registry.example.com"]')
          if (input !== null) void onApplyRegistry(input.value)
        }}>
          {t('dshRuntimeRegistryApply')}
        </button>
      </label>

      <div className={css.updateStatusLine}>
        <button type="button" className={css.updateButton} disabled={testingRegistry || busy} onClick={() => { void onTestRegistry() }}>
          {t('dshRuntimeRegistryTest')}
        </button>
      </div>

      {registryError !== null && (
        <p className={css.generalError} role="alert">{registryError}</p>
      )}

      <div className={css.updateStatusLine}>
        <button
          type="button"
          className={css.updatePrimaryButton}
          onClick={onInstall}
          disabled={!hydrated || busy || isActive || terminalGate || chosen === null || envGated}
        >
          {isNewer ? t('dshRuntimeActionUpdate') : t('dshRuntimeActionRollback')} v{chosen ?? '—'}
        </button>
        <button
          type="button"
          className={css.updateButton}
          onClick={onReset}
          disabled={!hydrated || busy || envGated}
        >
          {t('dshRuntimeResetBuiltin')}
        </button>
      </div>

      <div className={css.updateStatus} aria-live="polite">
        <p className={css.updateStatusText}>{statusText}</p>
      </div>

      {error !== null && phase === 'error' && (
        <p className={css.generalError} role="alert">{error}</p>
      )}
    </div>
  )
}
