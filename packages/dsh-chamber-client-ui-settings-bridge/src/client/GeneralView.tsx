/**
 * Chamber-global「通用」section (design 14 D7 / design 15 v1 flat form) — the
 * settings shell's `__general` fixed entry content. Organized in OpenChamber-
 * style control groups (group headings + flat rows), styled with the settings
 * panel's design language (`--dsw-alias-*` tokens).
 *
 * Layout: compact cards —「text left/top, control right/bottom」. Short
 * toggle groups (启动与关闭 / 运行) are a two-column card grid
 * (.generalGrid + .generalCard, auto-fit collapses on narrow panels), the
 * two radio pairs (关闭窗口时 / 通知时机) render as slider-style segmented
 * controls (SegmentedControl: OFFICIAL business-blue thumb + inverted
 * selected text), the notification master toggle as the official switch
 * (36x20 track + round thumb, native checkbox with role=switch underneath),
 * and the three notification-event toggles share one line of mini cards
 * (.generalEventGrid). The notifications SUB-SETTINGS (通知时机 / 事件开关 /
 * 测试通知) stay COLLAPSED while the master switch is off — they unfold in a
 * transparent container (.generalNotifyBody) only while notifications are
 * enabled (the configuration itself is unchanged, just hidden). Every
 * control stays a native checkbox/radio underneath (no custom widgets).
 *
 * Groups (all chamber-GLOBAL, owned by the main process chamber-settings.json,
 * never any instance's dsh home — 01 §2 P2):
 * - 启动与关闭: 关闭窗口行为 (windowCloseBehavior: hide-to-tray / quit);
 *   登录自启 (launchAtLogin, mac/linux; win gated off);
 * - 运行: 保持唤醒 (keepAwake, default off); 退出确认 (quitConfirmation,
 *   2026-08: confirm only while the LOCAL instance runs — remote tunnels
 *   never prompt; update-downloaded exempt);
 * - 通知 (design 19, merged into General — no new nav entry): 主开关 + 启用后
 *   展开的子设置 (通知时机 hidden-only / always + 事件开关 complete / ask /
 *   request + 「发送测试通知」);
 * - 更新 (design 11, merged into General): current version +「检查更新」+
 *   low-key status (UpdateSection).
 *
 * （design 18 §3.6：dsh 运行时块已自本视图迁出——per-server「dsh 运行时」
 *  settings.section，见 runtime-section-plugin.ts。）
 *
 * Every mutation goes through the main-process settings IPC (settings-store),
 * which overlays the patch OPTIMISTICALLY — the control reflects the click in
 * the same frame and never flashes a disabled/dimmed state while the IPC
 * round-trip is in flight (闪烁修复); failures surface LOUDLY (never a
 * silent fake success) and roll the overlay back. The closeToTray gate
 * (dev without tray) disables the hide-to-tray option — hiding a window the
 * user could not recover would strand the app.
 */
import { useCallback, useId, useRef, useState, useSyncExternalStore } from 'react'
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
 *  right; the WHOLE card is the label so the hit target is the card. Saves
 *  are optimistic (settings-store): the checkbox reflects the click in the
 *  same frame — no disabled/dimmed flash while the IPC round-trip is in
 *  flight. */
function ToggleCard({
  label, hint, checked, disabled, onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
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
          disabled={disabled === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      </div>
    </label>
  )
}

/** One notification-event mini toggle (one line of three): short title left,
 *  checkbox right. Disabled (un-hydrated skeleton) dims like ToggleCard. */
function ToggleEvent({
  label, checked, disabled, onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className={clsx(css.generalEventCard, disabled === true ? css.generalDisabled : undefined)}>
      <span>{label}</span>
      <input
        type="checkbox"
        className={css.generalCardCheck}
        checked={checked}
        disabled={disabled === true}
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
  const [saveError, setSaveError] = useState<string | null>(null)
  // Per-instance labelledby (useId): N-ctx shells mount one settings panel
  // each in the SAME document — a static id would alias across panels. The
  // radio group name itself is generated inside SegmentedControl (also useId,
  // same scoping reason).
  const closeBehaviorLabel = useId()
  // Same scoping for the notifications-mode field label.
  const notifyModeLabel = useId()
  // Same scoping for the unfolded notifications sub-settings (the master
  // switch's aria-controls target).
  const notifyBodyId = useId()
  const [notifyBusy, setNotifyBusy] = useState(false)
  const [notifyResult, setNotifyResult] = useState<'sent' | 'failed' | null>(null)

  // Serial save queue: settings-store overlays each patch optimistically (the
  // control reflects the click immediately — no busy/disabled flash), so the
  // queue only has to keep rapid successive saves from overlapping at the
  // bridge; the main process applies them in order (atomic write + sequential
  // IPC handling), and the store's save sequence lets a newer overlay win.
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const save = useCallback((patch: Parameters<typeof applySettingsPatch>[0]) => {
    setSaveError(null)
    saveQueue.current = saveQueue.current
      .then(() => applySettingsPatch(patch))
      .then((result) => {
        if (!result.ok) setSaveError(result.error)
      })
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
            onChange={(next) => save({ quitConfirmation: next })}
          />
        </div>
      </div>

      {/* 通知 (design 19, merged into General — no new nav entry): 主开关 +
          启用后才展开的子设置（通知时机 hidden-only / always + 事件开关
          complete / ask / request +「发送测试通知」）。主开关关闭时子设置
          收起（不全部展开）——配置项仍在，启用后按原始布局展开显示。 */}
      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupNotifications')}</h3>

        {/* 主开关: 官方 switch（原生 checkbox + role=switch），整行即 label
            （可访问名称 + 整行可点）；未水合骨架态整行变淡。aria-controls
            指向展开的子设置。 */}
        <label className={clsx(css.generalLine, !hydrated && css.generalDisabled)}>
          <div className={css.generalCardText}>
            <span className={css.generalFieldLabel}>{t('generalNotificationsEnabled')}</span>
          </div>
          <span className={css.generalSwitchBox}>
            <input
              type="checkbox"
              role="switch"
              className={css.generalSwitchInput}
              checked={notifications.enabled === true}
              disabled={!hydrated}
              aria-expanded={notifications.enabled === true}
              aria-controls={notifications.enabled === true ? notifyBodyId : undefined}
              onChange={(event) => save(notificationsPatch({ enabled: event.target.checked }))}
            />
            <span className={css.generalSwitch} aria-hidden="true">
              <span className={css.generalSwitchThumb} />
            </span>
          </span>
        </label>

        {notifications.enabled === true && (
          <div id={notifyBodyId} className={css.generalNotifyBody}>
            <div className={css.generalLine}>
              <div className={css.generalCardText}>
                <span className={css.generalFieldLabel} id={notifyModeLabel}>{t('generalNotificationsMode')}</span>
                <p className={css.generalHint}>{t('generalNotificationsModeDesc')}</p>
              </div>
              <SegmentedControl
                ariaLabelledBy={notifyModeLabel}
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
                onChange={(next) => save(notificationsPatch({ onComplete: next }))}
              />
              <ToggleEvent
                label={t('generalNotifyOnAsk')}
                checked={notifications.onAsk !== false}
                disabled={!hydrated}
                onChange={(next) => save(notificationsPatch({ onAsk: next }))}
              />
              <ToggleEvent
                label={t('generalNotifyOnRequest')}
                checked={notifications.onRequest !== false}
                disabled={!hydrated}
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
        )}
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
