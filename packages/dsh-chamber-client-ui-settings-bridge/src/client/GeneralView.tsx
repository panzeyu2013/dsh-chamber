/**
 * Chamber-global「通用」section (design 14 D7 / design 15 v1 flat form) — the
 * settings shell's `__general` fixed entry content. Organized in OpenChamber-
 * style control groups (group headings + flat rows), styled with the settings
 * panel's design language (`--dsw-alias-*` tokens).
 *
 * Layout (2026-11 横向化修订): the row paradigm is unified to「text left,
 * control right」— short toggle groups (启动与关闭 / 运行) become a two-column
 * card grid (.generalGrid + .generalCard), the two radio pairs (关闭窗口时 /
 * 通知时机) become slider-style segmented controls (SegmentedControl, 2026-11
 * 滑块化: brand thumb + 反白选中文字), and the three notification-event
 * toggles share one line of mini cards (.generalEventGrid). Every control
 * stays a native checkbox/radio underneath (no custom widgets); narrow panels
 * auto-collapse the columns via auto-fit.
 *
 * Groups (all chamber-GLOBAL, owned by the main process chamber-settings.json,
 * never any instance's dsh home — 01 §2 P2):
 * - 启动与关闭: 关闭窗口行为 (windowCloseBehavior: hide-to-tray / quit);
 *   登录自启 (launchAtLogin, mac/linux; win gated off);
 * - 运行: 保持唤醒 (keepAwake, default off); 退出确认 (quitConfirmation,
 *   2026-08: confirm only while the LOCAL instance runs — remote tunnels
 *   never prompt; update-downloaded exempt);
 * - 通知 (design 19, merged into General — no new nav entry): 主开关 + 通知
 *   时机 (hidden-only / always) + 事件开关 (complete / ask / request) +
 *   「发送测试通知」;
 * - 更新 (design 11, merged into General): current version +「检查更新」+
 *   low-key status (UpdateSection).
 *
 * （design 18 §3.6：dsh 运行时块已自本视图迁出——per-server「dsh 运行时」
 *  settings.section，见 runtime-section-plugin.ts。）
 *
 * Every mutation goes through the main-process settings IPC (settings-store);
 * failures surface LOUDLY (never a silent fake success). The closeToTray gate
 * (dev without tray) disables the hide-to-tray option — hiding a window the
 * user could not recover would strand the app.
 */
import { useCallback, useId, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { SettingsBridgeKey } from '../locales.ts'
import type { ChamberSettingsStatus, NotificationSurface } from '../ambient/settings-bridge.d.ts'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
import { notificationsOf, notificationsPatch } from './notifications-settings.ts'
import { SegmentedControl } from './SegmentedControl.tsx'
import { UpdateSection } from './UpdateSection.tsx'
import css from './SettingsShell.module.css'

/** The shell's bound translate (params supported). */
type GeneralTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

/** One checkbox toggle in a card (grid): title + hint left, native checkbox
 *  right; the WHOLE card is the label so the hit target is the card. */
function ToggleCard({
  label, hint, checked, disabled, onChange, busy,
}: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  busy: boolean
}) {
  return (
    <label className={clsx(css.generalCard, disabled === true ? css.generalDisabled : undefined)}>
      <div className={css.generalCardHead}>
        <div className={css.generalCardText}>
          <span className={css.generalFieldLabel}>{label}</span>
          <p className={css.generalHint}>{hint}</p>
        </div>
        <input
          type="checkbox"
          className={css.generalCardCheck}
          checked={checked}
          disabled={disabled === true || busy}
          onChange={(event) => onChange(event.target.checked)}
        />
      </div>
    </label>
  )
}

/** One notification-event mini toggle (one line of three): short title left,
 *  checkbox right. Disabled (un-hydrated skeleton) dims like ToggleCard. */
function ToggleEvent({
  label, checked, disabled, onChange, busy,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  busy: boolean
}) {
  return (
    <label className={clsx(css.generalEventCard, disabled === true ? css.generalDisabled : undefined)}>
      <span>{label}</span>
      <input
        type="checkbox"
        className={css.generalCardCheck}
        checked={checked}
        disabled={disabled === true || busy}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

/** The live notify surface, or null while the bridge is absent (button gate).
 *  The ambient `window.dshChamber` type carries the notifications surface
 *  (renderer global.d.ts, re-exported via ambient/settings-bridge.d.ts). */
function testNotifySurface(): NotificationSurface | null {
  const notifications = typeof window !== 'undefined' ? window.dshChamber?.notifications : undefined
  return notifications !== undefined && notifications.notify !== undefined ? notifications : null
}

/** The section content (rendered inside the settings options column). */
export function GeneralView({ t }: { t: GeneralTranslate }) {
  const status = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Per-instance labelledby (useId): N-ctx shells mount one settings panel
  // each in the SAME document — a static id would alias across panels. The
  // radio group name itself is generated inside SegmentedControl (also useId,
  // same scoping reason).
  const closeBehaviorLabel = useId()
  // Same scoping for the notifications-mode field label.
  const notifyModeLabel = useId()
  const [notifyBusy, setNotifyBusy] = useState(false)
  const [notifyResult, setNotifyResult] = useState<'sent' | 'failed' | null>(null)

  const save = useCallback((patch: Parameters<typeof applySettingsPatch>[0]) => {
    setBusy(true)
    setSaveError(null)
    void applySettingsPatch(patch)
      .then((result) => {
        if (!result.ok) setSaveError(result.error)
      })
      .finally(() => setBusy(false))
  }, [])

  /** 「发送测试通知」— bypasses the settings gates in the main process (design
       19 §3.3: kind 'test' skips the enabled/kind/mode checks). Inline feedback,
       never a silent fake success. */
  const sendTestNotification = useCallback(() => {
    const surface = testNotifySurface()
    if (surface === null) return
    setNotifyBusy(true)
    setNotifyResult(null)
    void surface.notify({
      sourceId: 'local',
      sourceFingerprint: 'local',
      sessionId: '',
      kind: 'test',
      title: t('generalNotificationsTestTitle'),
      body: t('generalNotificationsTestBody'),
      requireHidden: false,
    })
      .then((shown) => setNotifyResult(shown ? 'sent' : 'failed'))
      .catch(() => setNotifyResult('failed'))
      .finally(() => setNotifyBusy(false))
  }, [t])

  // No bridge yet (or the main process does not expose settings): render the
  // skeleton rows with placeholder values — never a fake "off". Controls stay
  // disabled until hydrated (a click before hydration would save a value the
  // UI never showed).
  const settings = status?.settings
  const supported = status?.supported
  const hydrated = status !== null
  // Notifications block (design 19 §3.4): design defaults while absent — never
  // a fake off (unknown/future keys filtered in notificationsOf).
  const notifications = notificationsOf(settings)

  // The dsh runtime block moved to the per-server「dsh 运行时」settings.section
  // (design 18 §3.6, 2026-09 修订): GeneralView keeps only the design-15
  // control groups (startup/shutdown / runtime / update).

  return (
    <div className={css.generalSection}>
      <h2 className={css.generalTitle}>{t('generalTitle')}</h2>

      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupLifecycle')}</h3>

        <div className={css.generalGrid}>
          {/* 关闭窗口时: 滑块式分段单选（SegmentedControl），一行两个选项；
              无托盘时禁用「隐藏到托盘」并改提示文案。hint 随选中值切换（选中
              「退出应用」时不再描述后台运行）。 */}
          <div className={css.generalCard}>
            <div className={css.generalCardText}>
              <span className={css.generalFieldLabel} id={closeBehaviorLabel}>{t('generalCloseBehavior')}</span>
              <p className={css.generalHint}>
                {supported?.closeToTray === false
                  ? t('generalCloseBehaviorUnavailable')
                  : settings?.windowCloseBehavior === 'quit'
                    ? t('generalCloseBehaviorQuitDesc')
                    : t('generalCloseBehaviorDesc')}
              </p>
            </div>
            <SegmentedControl
              ariaLabelledBy={closeBehaviorLabel}
              disabled={busy}
              value={settings?.windowCloseBehavior ?? null}
              onChange={(next) => save({ windowCloseBehavior: next })}
              options={[
                {
                  value: 'hide-to-tray',
                  label: t('generalCloseBehaviorHide'),
                  disabled: !hydrated || supported?.closeToTray === false,
                },
                { value: 'quit', label: t('generalCloseBehaviorQuit'), disabled: !hydrated },
              ]}
            />
          </div>

          <ToggleCard
            label={t('generalLaunchAtLogin')}
            hint={supported?.launchAtLogin === false ? t('generalUnavailable') : t('generalLaunchAtLoginDesc')}
            checked={settings?.launchAtLogin === true}
            disabled={!hydrated || supported?.launchAtLogin === false}
            busy={busy}
            onChange={(next) => save({ launchAtLogin: next })}
          />
        </div>
      </div>

      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupRuntime')}</h3>

        <div className={css.generalGrid}>
          <ToggleCard
            label={t('generalKeepAwake')}
            hint={t('generalKeepAwakeDesc')}
            checked={settings?.keepAwake === true}
            disabled={!hydrated}
            busy={busy}
            onChange={(next) => save({ keepAwake: next })}
          />

          {/* 退出确认（2026-08 修订）：可设置开关；仅本地实例运行中时确认，
              远程连接不影响关闭；更新已下载时豁免。未水合时按默认值 true
              渲染（`!== false`），与「绝不假 off」的占位纪律一致。 */}
          <ToggleCard
            label={t('generalQuitConfirm')}
            hint={t('generalQuitConfirmDesc')}
            checked={settings?.quitConfirmation !== false}
            disabled={!hydrated}
            busy={busy}
            onChange={(next) => save({ quitConfirmation: next })}
          />
        </div>
      </div>

      {/* 通知 (design 19, merged into General — no new nav entry): 主开关 +
          通知时机 (hidden-only / always) + 事件开关 (complete / ask / request)
          +「发送测试通知」。事件开关在主开关关闭时仍可预配置（OpenChamber
          语义——保持可交互，不加说明）。 */}
      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupNotifications')}</h3>

        {/* 主开关: 整行即 label（可访问名称 + 整行可点）；未水合骨架态整行
            变淡，与 ToggleCard 的占位纪律一致。 */}
        <label className={clsx(css.generalLine, !hydrated && css.generalDisabled)}>
          <div className={css.generalCardText}>
            <span className={css.generalFieldLabel}>{t('generalNotificationsEnabled')}</span>
          </div>
          <input
            type="checkbox"
            className={css.generalCardCheck}
            checked={notifications.enabled === true}
            disabled={!hydrated || busy}
            onChange={(event) => save(notificationsPatch({ enabled: event.target.checked }))}
          />
        </label>

        <div className={css.generalLine}>
          <div className={css.generalCardText}>
            <span className={css.generalFieldLabel} id={notifyModeLabel}>{t('generalNotificationsMode')}</span>
            <p className={css.generalHint}>{t('generalNotificationsModeDesc')}</p>
          </div>
          <SegmentedControl
            ariaLabelledBy={notifyModeLabel}
            disabled={busy}
            value={notifications.mode === 'always' ? 'always' : 'hidden-only'}
            onChange={(next) => save(notificationsPatch({ mode: next }))}
            options={[
              { value: 'hidden-only', label: t('generalNotificationsModeHidden'), disabled: !hydrated },
              { value: 'always', label: t('generalNotificationsModeAlways'), disabled: !hydrated },
            ]}
          />
        </div>

        <div className={css.generalEventGrid}>
          <ToggleEvent
            label={t('generalNotifyOnComplete')}
            checked={notifications.onComplete !== false}
            disabled={!hydrated}
            busy={busy}
            onChange={(next) => save(notificationsPatch({ onComplete: next }))}
          />
          <ToggleEvent
            label={t('generalNotifyOnAsk')}
            checked={notifications.onAsk !== false}
            disabled={!hydrated}
            busy={busy}
            onChange={(next) => save(notificationsPatch({ onAsk: next }))}
          />
          <ToggleEvent
            label={t('generalNotifyOnRequest')}
            checked={notifications.onRequest !== false}
            disabled={!hydrated}
            busy={busy}
            onChange={(next) => save(notificationsPatch({ onRequest: next }))}
          />
        </div>

        <div className={css.generalTestRow}>
          <button
            type="button"
            className={css.updateButton}
            onClick={sendTestNotification}
            disabled={testNotifySurface() === null || notifyBusy}
          >
            {t('generalNotificationsTest')}
          </button>
          {notifyResult !== null && (
            <p
              className={notifyResult === 'sent' ? css.generalNotifyOk : css.generalError}
              aria-live="polite"
            >
              {notifyResult === 'sent' ? t('generalNotificationsTestSent') : t('generalNotificationsTestFailed')}
            </p>
          )}
        </div>
      </div>

      {/* Chamber-global update status (design 11): merged into the General
          section — the dedicated __update nav entry was folded in here. */}
      <UpdateSection t={t} />

      {saveError !== null && (
        <p className={css.generalError} aria-live="polite">{t('generalSaveFailed', { error: saveError })}</p>
      )}
    </div>
  )
}

/** Re-export for tests: keep the status type visible. */
export type { ChamberSettingsStatus }
