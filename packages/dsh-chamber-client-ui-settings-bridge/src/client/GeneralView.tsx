/**
 * Chamber-global「通用」section (design 14 D7 / design 15 v1 flat form) — the
 * settings shell's `__general` fixed entry content. Organized in OpenChamber-
 * style control groups (group headings + flat rows), styled with the settings
 * panel's design language (`--dsw-alias-*` tokens).
 *
 * Groups (all chamber-GLOBAL, owned by the main process chamber-settings.json,
 * never any instance's dsh home — 01 §2 P2):
 * - 启动与关闭: 关闭窗口行为 (windowCloseBehavior: hide-to-tray / quit);
 *   登录自启 (launchAtLogin, mac/linux; win gated off);
 * - 运行: 保持唤醒 (keepAwake, default off); 退出确认 (quitConfirmation,
 *   2026-08: confirm only while the LOCAL instance runs — remote tunnels
 *   never prompt; update-downloaded exempt);
 * - 更新 (design 11, merged into General): current version +「检查更新」+
 *   low-key status (UpdateSection);
 * - dsh 运行时 (design 17 M4): active/bundled versions, registry source,
 *   version selection, guarded actions, failure and snapshot projections.
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
import { UpdateSection } from './UpdateSection.tsx'
import { DshRuntimeSection } from './DshRuntimeSection.tsx'
import css from './SettingsShell.module.css'

/** The shell's bound translate (params supported). */
type GeneralTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

/**
 * One checkbox-style toggle row (OpenChamber SettingsCheckboxRow pattern): a
 * native checkbox (accent-color token, no custom widget), the label beside it;
 * disabled with a hint when a platform gate denies the capability.
 */
function ToggleRow({
  label, checked, disabled, onChange, busy, t,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  busy: boolean
  t: GeneralTranslate
}) {
  return (
    <div className={css.generalRow}>
      <label className={`${css.generalToggle} ${disabled === true ? css.generalDisabled : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled === true || busy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
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

  // The active dsh runtime version block (design 16 M4) is rendered by
  // DshRuntimeSection below — it reads the runtime surface directly.

  return (
    <div className={css.generalSection}>
      <h2 className={css.generalTitle}>{t('generalTitle')}</h2>

      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupLifecycle')}</h3>

        <div className={css.generalRow}>
          <span className={css.generalFieldLabel} id={closeBehaviorLabel}>{t('generalCloseBehavior')}</span>
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
      </div>

      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupRuntime')}</h3>

        <ToggleRow
          t={t}
          label={t('generalKeepAwake')}
          checked={settings?.keepAwake === true}
          disabled={!hydrated}
          busy={busy}
          onChange={(next) => save({ keepAwake: next })}
        />

        {/* 退出确认（2026-08 修订）：可设置开关；仅本地实例运行中时确认，
            远程连接不影响关闭；更新已下载时豁免。未水合时按默认值 true
            渲染（`!== false`），与「绝不假 off」的占位纪律一致。 */}
        <ToggleRow
          t={t}
          label={t('generalQuitConfirm')}
          checked={settings?.quitConfirmation !== false}
          disabled={!hydrated}
          busy={busy}
          onChange={(next) => save({ quitConfirmation: next })}
        />
      </div>

      {/* Chamber-global update status (design 11): merged into the General
          section — the dedicated __update nav entry was folded in here. */}
      <UpdateSection t={t} />

      {/* Chamber-global「dsh 运行时」group (design 17 M4), immediately after
          the app-update group: full authoritative state/action projection.
          Before bridge hydration it shows an unknown version and disables
          mutations — never a fabricated version or fake success. */}
      <DshRuntimeSection t={t} />

      {saveError !== null && (
        <p className={css.generalError} aria-live="polite">{t('generalSaveFailed', { error: saveError })}</p>
      )}
    </div>
  )
}

/** Re-export for tests: keep the status type visible. */
export type { ChamberSettingsStatus }
