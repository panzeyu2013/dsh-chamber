/**
 * Chamber-global「客户端」section: the settings shell's `__general` content.
 * Groups are all chamber-GLOBAL (main-process chamber-settings.json, never an
 * instance's dsh home): 启动与关闭 / 运行 / 会话待办区 / 通知 / 更新
 * (UpdateSection). Notification sub-settings stay COLLAPSED while the master
 * switch is off (config unchanged, just hidden) in one bordered card, that switch
 * itself a borderless disclosure row. Mutations go through the settings IPC
 * (settings-store), which overlays OPTIMISTICALLY (no disabled/dimmed flash) and
 * rolls back on failure with the error surfaced loudly; the closeToTray gate
 * (dev without tray) disables hide-to-tray to avoid stranding a window.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsBridgeKey } from '../locales.ts'
import type { ChamberSettingsStatus, NotificationSurface } from '../ambient/settings-bridge.d.ts'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
import { notificationsOf, notificationsPatch } from './notifications-settings.ts'
import { testNotifyRejected, testNotifyResult, type TestNotifyResult } from './notify-test-result.ts'
import { sessionTodoOf, sessionTodoPatch } from './session-todo-settings.ts'
import { SegmentedControl } from './SegmentedControl.tsx'
import { UpdateSection } from './UpdateSection.tsx'
import { applyDisclosureAttributes } from './disclosure-attrs.ts'
import css from './SettingsShell.module.css'

/** The shell's bound translate (params supported). */
type GeneralTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

/**
 * The platform-capability projection: `badgeSupported` is read as OPTIONAL — an older
 * main process omits it, so absent means "assume supported" (backward compatible) and
 * only an explicit false disables the control.
 */
type SupportedGates = ChamberSettingsStatus['supported'] & { badgeSupported?: boolean }

/** One checkbox toggle in a card (grid): title + optional hint left, native checkbox
 *  right; the WHOLE card is the label. Saves are optimistic (settings-store), so no
 *  disabled/dimmed flash while the IPC round-trip is in flight. */
function ToggleCard({
  label, hint, checked, disabled, onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className={clsx(css.generalCard, disabled === true ? css.generalDisabled : undefined)}>
      <div className={css.generalCardHead}>
        <div className={css.generalCardText}>
          <span className={css.generalFieldLabel}>{label}</span>
          {hint !== undefined && (
            <p className={css.generalHint}>{hint}</p>
          )}
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

/** One notification-event toggle (one line of three): short title left, checkbox right.
 *  Disabled (un-hydrated skeleton) dims like ToggleCard; borderless row. */
function ToggleEvent({
  label, checked, disabled, onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className={clsx(css.generalEventRow, disabled === true ? css.generalDisabled : undefined)}>
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

/**
 * Disclosure switch row control: the shared `Switch` primitive plus the disclosure
 * relationship the row carries (this switch unfolds the sub-settings card below it).
 * The wrapper stays a pure layout box: `aria-expanded` / `aria-controls` are written
 * onto the primitive's OWN control node through `applyDisclosureAttributes` (no wrapper
 * role can carry them, and a widget around the switch would nest two interactive
 * controls), so the primitive keeps `role="switch"`, `aria-checked` and the accessible
 * name, and the row stays a `<label>`.
 */
function DisclosureSwitch({
  label, checked, disabled, expanded, controls, onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  expanded: boolean
  controls: string | undefined
  onChange: (next: boolean) => void
}) {
  const box = useRef<HTMLSpanElement | null>(null)
  // Applied before paint (and whenever the disclosure state or card id changes),
  // so the control never renders a frame in which the relationship is missing.
  useLayoutEffect(() => {
    const control = box.current?.querySelector<HTMLElement>('[role="switch"]') ?? null
    applyDisclosureAttributes(control, expanded, controls)
  }, [expanded, controls])
  return (
    <span ref={box} className={css.generalSwitchBox}>
      <Switch checked={checked} label={label} disabled={disabled === true} onChange={onChange} />
    </span>
  )
}

/** The live notify surface, or null while the bridge is absent (button gate);
 *  the ambient `window.dshChamber` type carries the notifications surface. */
function testNotifySurface(): NotificationSurface | null {
  const notifications = typeof window !== 'undefined' ? window.dshChamber?.notifications : undefined
  return notifications !== undefined && notifications.notify !== undefined ? notifications : null
}

/** 当前是否 macOS（只有它需要「系统设置 → 通知」的恢复入口；平台事实来自桥）。 */
function isMacPlatform(): boolean {
  return typeof window !== 'undefined' && window.dshChamber?.platform === 'darwin'
}

export function GeneralView({ t }: { t: GeneralTranslate }) {
  const status = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Per-instance labelledby (useId): N-ctx shells mount one settings panel each in the
  // SAME document — a static id would alias. The radio group name is generated inside
  // SegmentedControl (also useId).
  const closeBehaviorLabel = useId()
  // Same scoping for the notifications-mode field label.
  const notifyModeLabel = useId()
  const notifyBodyId = useId()
  const todoBodyId = useId()
  const [notifyBusy, setNotifyBusy] = useState(false)
  const [notifyResult, setNotifyResult] = useState<TestNotifyResult | null>(null)
  /** 「打开系统设置」的结果：失败必须可见（绝不静默什么也没发生）。 */
  const [openSettingsFailed, setOpenSettingsFailed] = useState(false)

  // Serial save queue: settings-store overlays each patch optimistically, so the queue
  // only has to keep rapid successive saves from overlapping at the bridge; the main
  // process applies them in order and a newer overlay wins.
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const save = useCallback((patch: Parameters<typeof applySettingsPatch>[0]) => {
    setSaveError(null)
    saveQueue.current = saveQueue.current
      .then(() => applySettingsPatch(patch))
      .then((result) => {
        if (!result.ok) setSaveError(result.error)
      })
  }, [])

  /** 「发送测试通知」— bypasses the settings gates in the main process (kind 'test'
   *  skips the enabled/kind/mode checks); inline feedback, never a fake success. */
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
      // 诚实结果必须带原因：失败时把宿主/OS 原文交给下面的提示区，用户才知道要去系统设置打开通知权限。
      .then((outcome) => setNotifyResult(testNotifyResult(outcome)))
      .catch((error: unknown) => setNotifyResult(testNotifyRejected(error)))
      .finally(() => setNotifyBusy(false))
  }, [t])

  /** 权限被拒后的恢复入口：macOS 不再允许 App 主动弹授权框，只能在「系统设置 →
   *  通知」打开；目标 URL 固定在主进程侧（无载荷）。 */
  const openNotificationSettings = useCallback(() => {
    const surface = testNotifySurface()
    if (surface === null) return
    setOpenSettingsFailed(false)
    void surface.openSystemSettings()
      .then((opened) => { if (!opened) setOpenSettingsFailed(true) })
      .catch(() => setOpenSettingsFailed(true))
  }, [])

  // No bridge yet (or no settings surface): render skeleton rows with placeholder
  // values — never a fake "off". Controls stay disabled until hydrated (a click
  // before hydration would save a value the UI never showed).
  const settings = status?.settings
  const supported: SupportedGates | undefined = status?.supported
  const hydrated = status !== null
  // 未读徽标平台能力：win32 的任务栏 overlay v1 未接线，主进程能力事实为 false——
  // 开关禁用并显示短原因；字段缺失（旧主进程）按支持渲染，保持向后兼容。
  const badgeSupported = supported?.badgeSupported !== false
  // Notifications block: design defaults while absent — never a fake off (unknown/future keys filtered in notificationsOf).
  const notifications = notificationsOf(settings)
  // Session-todo block: design defaults (ALL ON) while absent — never a fake off.
  const sessionTodo = sessionTodoOf(settings)
  // 平台事实来自桥（design 25）：仅 macOS 需要「系统设置 → 通知」恢复入口。
  const isDarwin = isMacPlatform()

  // The dsh runtime block is the per-server「dsh 运行时」settings.section; the full
  // group set rendered below is enumerated in this file's top doc block.

  return (
    <div className={css.generalSection}>
      <h2 className={css.generalTitle}>{t('clientNav')}</h2>

      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupLifecycle')}</h3>

        <div className={css.generalGrid}>
          {/* 关闭窗口时: 滑块式分段单选（SegmentedControl），一行两个选项；无托盘时
              禁用「隐藏到托盘」并改提示文案。hint 随选中值切换（不描述后台运行）。 */}
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

        {/* 三列网格（.generalGridTriple）：保持唤醒 / 退出确认 / VS Code 新窗口固定同一行。 */}
        <div className={clsx(css.generalGrid, css.generalGridTriple)}>
          <ToggleCard
            label={t('generalKeepAwake')}
            hint={t('generalKeepAwakeDesc')}
            checked={settings?.keepAwake === true}
            disabled={!hydrated}
            onChange={(next) => save({ keepAwake: next })}
          />

          {/* 退出确认：仅本地实例运行中时确认，远程连接不影响关闭，更新已下载时豁免；
              未水合时按默认 true 渲染（`!== false`），与「绝不假 off」一致。 */}
          <ToggleCard
            label={t('generalQuitConfirm')}
            hint={t('generalQuitConfirmDesc')}
            checked={settings?.quitConfirmation !== false}
            disabled={!hydrated}
            onChange={(next) => save({ quitConfirmation: next })}
          />

          {/* VS Code 会话目录打开策略：chamber 设置 vscodeOpenInNewWindow 默认 ON
              ——会话头按钮与 OS 深链（dsh-chamber://open-vscode）共用同一管线，新窗口
              打开（URL 追加 ?windowId=_blank，运行中也先聚焦同一文件夹）；关闭则交还
              VS Code 自身策略（可能复用并替换最近活动窗口）。 */}
          <ToggleCard
            label={t('generalVscodeNewWindow')}
            checked={settings?.vscodeOpenInNewWindow !== false}
            disabled={!hydrated}
            onChange={(next) => save({ vscodeOpenInNewWindow: next })}
          />
        </div>
      </div>

      {/* 会话待办区：主开关（默认开）是无边框披露行，开启后展开子设置（三类事件
          开关收入唯一一张卡片，与通知组同节奏）；默认全开，待办区仅在有条目时出现。 */}
      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupSessionTodo')}</h3>

        <label className={clsx(css.generalSwitchRow, !hydrated && css.generalDisabled)}>
          <div className={css.generalCardText}>
            <span className={css.generalFieldLabel}>{t('generalSessionTodoEnabled')}</span>
          </div>
          <DisclosureSwitch
            label={t('generalSessionTodoEnabled')}
            checked={sessionTodo.enabled === true}
            disabled={!hydrated}
            expanded={sessionTodo.enabled === true}
            controls={sessionTodo.enabled === true ? todoBodyId : undefined}
            onChange={(next) => save(sessionTodoPatch({ enabled: next }))}
          />
        </label>

        {sessionTodo.enabled === true && (
          <div id={todoBodyId} className={css.generalNotifyCard}>
            <div className={css.generalEventGrid}>
              <ToggleEvent
                label={t('generalNotifyOnComplete')}
                checked={sessionTodo.onComplete !== false}
                disabled={!hydrated}
                onChange={(next) => save(sessionTodoPatch({ onComplete: next }))}
              />
              <ToggleEvent
                label={t('generalNotifyOnAsk')}
                checked={sessionTodo.onAsk !== false}
                disabled={!hydrated}
                onChange={(next) => save(sessionTodoPatch({ onAsk: next }))}
              />
              <ToggleEvent
                label={t('generalNotifyOnRequest')}
                checked={sessionTodo.onRequest !== false}
                disabled={!hydrated}
                onChange={(next) => save(sessionTodoPatch({ onRequest: next }))}
              />
            </div>
          </div>
        )}
      </div>

      {/* 通知（no new nav entry）：主开关 + 启用后才展开的子设置（通知时机
          hidden-only/always + 事件开关 complete/ask/request + 发送测试通知）；
          主开关关闭时子设置收起，配置项仍在。主开关是无边框披露行，子设置是唯一
          一张卡片——通知组只有一层边框。 */}
      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('generalGroupNotifications')}</h3>

        {/* 主开关: 官方 Switch 原语（role=switch / aria-checked / 必需可访问名称），
            整行即 label；未水合骨架态整行变淡。aria-expanded/aria-controls 由
            DisclosureSwitch 写到原语自己的 role=switch 按钮上（无 role 包装上这两个
            属性对辅助技术无效），指向展开的子设置卡。 */}
        <label className={clsx(css.generalSwitchRow, !hydrated && css.generalDisabled)}>
          <div className={css.generalCardText}>
            <span className={css.generalFieldLabel}>{t('generalNotificationsEnabled')}</span>
          </div>
          <DisclosureSwitch
            label={t('generalNotificationsEnabled')}
            checked={notifications.enabled === true}
            disabled={!hydrated}
            expanded={notifications.enabled === true}
            controls={notifications.enabled === true ? notifyBodyId : undefined}
            onChange={(next) => save(notificationsPatch({ enabled: next }))}
          />
        </label>

        {/* 未读徽标：被动指示，独立于横幅主开关——默认开启，Dock/任务栏图标上的
            红色数字气泡（未读会话数）；关闭时主进程裁决强制清零。用无边框披露行，
            本行不展开子设置，故用原语本身（无披露属性）。平台能力门：
            badgeSupported===false（win32 overlay 未接线）时禁用并给出短原因。 */}
        <label className={clsx(css.generalSwitchRow, (!hydrated || !badgeSupported) && css.generalDisabled)}>
          <div className={css.generalCardText}>
            <span className={css.generalFieldLabel}>{t('generalNotificationsBadge')}</span>
            {!badgeSupported && (
              <p className={css.generalHint}>{t('generalNotificationsBadgeUnsupported')}</p>
            )}
          </div>
          <span className={css.generalSwitchBox}>
            <Switch
              checked={notifications.badgeEnabled !== false}
              label={t('generalNotificationsBadge')}
              disabled={!hydrated || !badgeSupported}
              onChange={(next) => save(notificationsPatch({ badgeEnabled: next }))}
            />
          </span>
        </label>

        {notifications.enabled === true && (
          <div id={notifyBodyId} className={css.generalNotifyCard}>
            <div className={css.generalLinePlain}>
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
              <Button variant="outline" size="sm"
                onClick={sendTestNotification}
                disabled={testNotifySurface() === null || notifyBusy}>
                {t('generalNotificationsTest')}
              </Button>
              {notifyResult !== null && (
                <p
                  className={notifyResult.kind === 'sent' ? css.generalNotifyOk : css.generalError}
                  aria-live="polite"
                >
                  {notifyResult.kind === 'sent' ? t('generalNotificationsTestSent') : t('generalNotificationsTestFailed')}
                </p>
              )}
            </div>

            {/* 失败原因 + 恢复入口：macOS 通知权限被拒后 App 不能再弹授权框，只显示
                「发送失败」会把用户留在黑箱里。原因原文如实展示（宿主/OS 文案不
                翻译），并给出「系统设置 → 通知」直达入口；非 darwin 平台只展示原因。 */}
            {notifyResult?.kind === 'failed' && (
              <div className={css.generalNotifyHint} data-testid="notify-permission-hint">
                {notifyResult.error !== undefined && (
                  <p className={css.generalNotifyDetail}>
                    {t('generalNotificationsTestReason')}{notifyResult.error}
                  </p>
                )}
                {isDarwin && (
                  <>
                    <p className={css.generalNotifyHintText}>
                      {t('generalNotificationsPermissionHint')}
                    </p>
                    <Button variant="outline" size="sm"
                      onClick={openNotificationSettings}
                      disabled={testNotifySurface() === null}>
                      {t('generalNotificationsOpenSettings')}
                    </Button>
                    {openSettingsFailed && (
                      <p className={css.generalError} aria-live="polite">
                        {t('generalNotificationsOpenSettingsFailed')}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chamber-global update status: merged into the General section (no dedicated nav entry). */}
      <UpdateSection t={t} />

      {saveError !== null && (
        <p className={css.generalError} aria-live="polite">{t('generalSaveFailed', { error: saveError })}</p>
      )}
    </div>
  )
}

/** Re-export for tests: keep the status type visible. */
export type { ChamberSettingsStatus }
