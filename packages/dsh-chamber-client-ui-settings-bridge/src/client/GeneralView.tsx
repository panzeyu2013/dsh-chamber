/**
 * Chamber-global「通用」section (design 14 D7 / design 15 v1 flat form) — the
 * settings shell's `__general` fixed entry content.
 *
 * Rows (all chamber-GLOBAL, owned by the main process chamber-settings.json,
 * never any instance's dsh home — 01 §2 P2):
 * - 关闭窗口行为 (windowCloseBehavior): hide-to-tray (dsh keeps running) / quit;
 * - 登录自启 (launchAtLogin): mac/linux; disabled with a note on win (v1 gate);
 * - 保持唤醒 (keepAwake): prevent-app-suspension, default off;
 * - 退出确认: read-only hint (design 14 D2 — active tunnels / local instance).
 *
 * Every mutation goes through the main-process settings IPC (settings-store);
 * failures surface LOUDLY (never a silent fake success). The closeToTray gate
 * (dev without tray) disables the hide-to-tray option — hiding a window the
 * user could not recover would strand the app.
 */
import { useCallback, useId, useState, useSyncExternalStore } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'
import type { ChamberSettingsStatus } from '../ambient/settings-bridge.d.ts'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
import css from './SettingsShell.module.css'

/** The shell's bound translate (params supported). */
type GeneralTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

/**
 * One checkbox-style toggle row: a native checkbox (accent-color token, no
 * custom widget — low-key per the shell's no-emphasis convention), disabled
 * with an explanatory hint when the platform gate denies the capability.
 */
function ToggleRow({
  label, hint, checked, disabled, onChange, busy, t,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  busy: boolean
  t: GeneralTranslate
}) {
  return (
    <div className={css.generalBlock}>
      <label className={`${css.generalToggle} ${disabled === true ? css.generalDisabled : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled === true || busy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint !== undefined && <p className={css.generalHint}>{hint}</p>}
      {disabled === true && t !== undefined && (
        <p className={css.generalHint}>{t('generalUnavailable')}</p>
      )}
    </div>
  )
}

/** The section content (rendered inside the settings options column). */
export function GeneralView({ t }: { t: GeneralTranslate }) {
  const status = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Per-instance radio group name + labelledby (useId): N-ctx shells mount one
  // settings panel each in the SAME document — a static name would make panels
  // share a radio group; useId keeps the group scoped to this component.
  const closeBehaviorGroup = useId()
  const closeBehaviorLabel = useId()

  const save = useCallback((patch: Parameters<typeof applySettingsPatch>[0]) => {
    setBusy(true)
    setSaveError(null)
    void applySettingsPatch(patch)
      .then((result) => {
        if (!result.ok) setSaveError(result.error)
      })
      .finally(() => setBusy(false))
  }, [])

  // No bridge yet (or the main process does not expose settings): render the
  // skeleton rows with placeholder values — never a fake "off". Controls stay
  // disabled until hydrated (a click before hydration would save a value the
  // UI never showed).
  const settings = status?.settings
  const supported = status?.supported
  const hydrated = status !== null

  return (
    <div className={css.generalSection}>
      <div className={css.generalBlock}>
        <p className={css.generalLabel} id={closeBehaviorLabel}>{t('generalCloseBehavior')}</p>
        <div className={css.generalOptions} role="group" aria-labelledby={closeBehaviorLabel}>
          <label className={`${css.generalOption} ${supported?.closeToTray === false ? css.generalDisabled : ''}`}>
            <input
              type="radio"
              name={closeBehaviorGroup}
              checked={settings?.windowCloseBehavior === 'hide-to-tray'}
              disabled={!hydrated || supported?.closeToTray === false || busy}
              onChange={() => save({ windowCloseBehavior: 'hide-to-tray' })}
            />
            <span>{t('generalCloseBehaviorHide')}</span>
          </label>
          <label className={css.generalOption}>
            <input
              type="radio"
              name={closeBehaviorGroup}
              checked={settings?.windowCloseBehavior === 'quit'}
              disabled={!hydrated || busy}
              onChange={() => save({ windowCloseBehavior: 'quit' })}
            />
            <span>{t('generalCloseBehaviorQuit')}</span>
          </label>
        </div>
        {supported?.closeToTray === false && (
          <p className={css.generalHint}>{t('generalCloseBehaviorUnavailable')}</p>
        )}
      </div>

      <ToggleRow
        t={t}
        label={t('generalLaunchAtLogin')}
        checked={settings?.launchAtLogin === true}
        disabled={!hydrated || supported?.launchAtLogin === false}
        busy={busy}
        onChange={(next) => save({ launchAtLogin: next })}
      />

      <ToggleRow
        t={t}
        label={t('generalKeepAwake')}
        checked={settings?.keepAwake === true}
        disabled={!hydrated}
        busy={busy}
        onChange={(next) => save({ keepAwake: next })}
      />

      <div className={css.generalBlock}>
        <p className={css.generalLabel}>{t('generalQuitConfirm')}</p>
        <p className={css.generalHint}>{t('generalQuitConfirmHint')}</p>
      </div>

      {saveError !== null && (
        <p className={css.generalError} aria-live="polite">{t('generalSaveFailed', { error: saveError })}</p>
      )}
    </div>
  )
}

/** Re-export for tests: keep the status type visible. */
export type { ChamberSettingsStatus }
