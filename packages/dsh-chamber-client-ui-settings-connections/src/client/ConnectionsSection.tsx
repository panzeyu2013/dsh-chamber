/**
 * Connections settings section (design 05 §5): the local instance card —
 * /health status, the /api/connections row, graceful stop behind a confirm,
 * and the host rolling log — beside the remote connection roster: registry
 * CRUD (non-secret metadata only), connect/disconnect over the transport IPC,
 * and SSH-only systemd control plus the ring-buffer logs.
 *
 * Everything rides page-level surfaces: window.dshChamber.desktopSsh (IPC,
 * 05 §7.4) and the control-plane REST client (05 §7.2). No host frames and
 * no dsh runtime objects are consumed. SSH authentication defaults to the
 * system ssh-agent and default keys; an optional per-host password (design
 * 05 §8) is forwarded to the main process, which holds it in memory and
 * mirrors it to an owner-readable file (plaintext-file fallback, user
 * decision 2026-08) so auto-connect works after restart — the form itself
 * never logs it, and the field is never prefilled (the stored value never
 * returns to the renderer). Gateway credentials follow the same write-only
 * renderer contract — the shared token (design 17 §7.2) and the login
 * password (§7.1) — stored in a separate owner-readable main-process mirror;
 * they are never placed in the registry or returned by IPC.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconChecklistOutline14,
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconDataOutline16,
  IconEditOutline16,
  IconFolderOpenOutline16,
  IconLinkOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconStopFill16,
  IconTrashOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { pollGatewayReady } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import type {
  DesktopSshSurface, SshConfigDiscovery, SshConfigHost, SshInstanceSpec, SshLogEntry, SshPhase, SshStatusProjection, TransportKind, TransportMethod,
} from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { cp, type ConnectionSummary, type HealthResponse, type HostLogsResponse } from './control-plane.ts'
import { classifyRestartError, serverRefusalText } from './managed-restart.ts'
import { PluginDialog, type PluginDialogTarget } from './PluginDialog.tsx'
import { PluginDiagnosticLine } from './plugin-diagnostic.tsx'
import type { PluginDiagnostic } from './plugin-diagnostic.ts'
import { formatGatewayUrl, parseGatewayUrl } from './gateway-url.ts'
import { actionHintKey } from './action-hint.ts'
import {
  changeDraftEndpointUrl,
  changeDraftKind,
  changeDraftTransport,
  draftFromSpec,
  draftToInput,
  EMPTY_DRAFT,
  SERVICE_NAME_PATTERN,
  spkiPinEligible,
  spkiPinValidationError,
  TRANSPORT_FORM_OPTIONS,
  transportFormSchema,
  type HostDraft,
} from './connection-form.ts'
import {
  credentialReentryFor,
  gatewayPasswordValidationError,
  saveHostWithConnectionCredentials,
} from './save-host.ts'
import {
  currentRuntimeSurface,
  getRuntimeState,
  runtimeBlocksLocalStart,
  subscribeRuntimeState,
} from '../../../../packages/renderer/src/runtime-management.ts'
import css from './ConnectionsSection.module.css'

/** Registration-side business face for the connections section. */
export interface ConnectionsSectionInjected {
  /** Bound translate over the section's own dictionary namespace. */
  t: (key: SettingsConnectionsKey) => string
}
export type { PluginDiagnostic } from './plugin-diagnostic.ts'

/** Full component props. */
export type ConnectionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dsh-chamber.settings.connections'>
  & InjectFace<ConnectionsSectionInjected>
  & {
    /** Per-instance diagnostics keyed by source id ('local' | '<kind>-<id>'); optional outside the chamber shell. */
    pluginDiagnostics?: Readonly<Record<string, PluginDiagnostic | undefined>>
    /** Self-heal recheck for CHANNEL-class diagnostics (design 09 §3.5):
     *  the host owns the shared plugin-diagnostic store, so the write-back
     *  comes from the host (settings-bridge) — this section only asks.
     *  Absent outside the chamber shell. */
    onRecheckDiagnostic?: (sourceId: string) => void
  }

/** Host-log page size (04 §3.3: default 200, cap 1000). */
const HOST_LOG_LIMIT = 200
const MIN_GATEWAY_TOKEN_CHARS = 32

/** Gateway-card runtime-probe cadence (design 21 §6.8 r1): while the section
 *  is mounted, connected gateway cards re-read /chamber/runtime/status at
 *  this interval so the「启动实例」action appears/disappears with the managed
 *  dsh's own state (a host-side crash/restart-exhausted needs no user action
 *  on this desktop to surface). */
const GATEWAY_RUNTIME_PROBE_INTERVAL_MS = 20_000

/** Runtime connection states the「启动实例」action applies to (design 21
 *  §6.8 r1 / decision 12 — the /chamber/runtime/start route's own gate,
 *  runtime-routes.ts). */
const STARTABLE_RUNTIME_STATES = new Set(['stopped', 'error', 'restart-exhausted'])

/** 每卡受控重启/启动的结果行（design 21 §5.1/§6.8）：tone 'error' 以
 *  css.error + role="alert" 渲染（opError 同款红字），'ok' 以 css.hint +
 *  role="status"（P2-1：结果行必须带语气渲染，接受/完成 = ok，拒绝/失败/
 *  超时 = error）。 */
type RestartNote = { tone: 'ok' | 'error'; text: string }

/** Local-card connection-row poll cadence: 状态由 /api/host/health-events
 * 推送（05 §3），此处只兜底行字段（label/dshPort）与流异常收敛。 */
const LOCAL_ROW_POLL_MS = 30_000

/** Slugify a ~/.ssh/config alias into the id whitelist (^[a-zA-Z0-9_-]+$). */
function slugifyAlias(alias: string): string {
  return alias.toLowerCase().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function credentialReentryEdit(editing: SshInstanceSpec | 'new' | null, value: HostDraft): { sshPassword: boolean; gatewayToken: boolean; gatewayPassword: boolean } {
  if (editing === null || editing === 'new') return { sshPassword: false, gatewayToken: false, gatewayPassword: false }
  if (value.transport === 'http' && !parseGatewayUrl(value.gatewayUrl).ok) {
    return { sshPassword: false, gatewayToken: false, gatewayPassword: false }
  }
  return credentialReentryFor(editing, draftToInput(value))
}

/** Localize a URL-parse failure — shared by validation and the defensive
 *  save-time re-check (P3-3) so both report the same loud error. */
function gatewayUrlErrorText(parsed: Extract<ReturnType<typeof parseGatewayUrl>, { ok: false }>, t: (key: SettingsConnectionsKey) => string): string {
  return parsed.error === 'required'
    ? t('validationDirectUrlRequired')
    : parsed.error === 'https'
      ? t('validationDirectUrlHttps')
      : parsed.error === 'host'
        ? t('validationDirectUrlHost')
        : t('validationDirectUrlOrigin')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ssh(): DesktopSshSurface | null {
  return window.dshChamber?.desktopSsh ?? null
}

/** /health dsh 状态 → 本地化徽标键（03 七态）。 */
function localStatusKey(status: string): SettingsConnectionsKey {
  switch (status) {
    case 'ready': return 'statusReady'
    case 'starting': return 'statusStarting'
    case 'degraded': return 'statusDegraded'
    case 'restarting': return 'statusRestarting'
    case 'restart-exhausted': return 'statusRestartExhausted'
    case 'stopped': return 'statusStopped'
    case 'error': return 'statusError'
    default: return 'statusUnknown'
  }
}

/** 隧道 phase → 本地化徽标键（非秘密投影，05 §7.4）。 */
function phaseKey(phase: SshPhase | undefined): SettingsConnectionsKey {
  switch (phase) {
    case 'idle': return 'phaseIdle'
    case 'connecting': return 'phaseConnecting'
    case 'ready': return 'phaseReady'
    case 'degraded': return 'phaseDegraded'
    case 'error': return 'phaseError'
    default: return 'phaseUnknown'
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/**
 * The gateway authentication area (design 17 §7): BOTH write-only credentials
 * — the shared token (§7.2) and the login password (§7.1) — each optional and
 * independently committable. The hint copy distinguishes the three states
 * (P3-1): NEW = "both empty sends the request without auth"; plain EDIT =
 * "leave empty keeps the stored credential"; TARGET-CHANGED edit = "the old
 * credential is cleared, re-enter" — the last also carries the top-of-form
 * warning and a required-credential validation (P2). The explicit clear
 * button is the wipe path for plain edits. Rendered once for every gateway
 * transport (http direct and ssh tunnel).
 */
function GatewayAuthFields({ draft, onChange, fieldErrors, editing, targetChanged, onClearToken, onClearPassword, tokenFieldId, passwordFieldId, t }: {
  draft: HostDraft
  onChange: (patch: Partial<HostDraft>) => void
  fieldErrors: Partial<Record<keyof HostDraft, string>>
  editing: SshInstanceSpec | 'new' | null
  /** True while editing a row whose transport target changed (P2/P3-1). */
  targetChanged: boolean
  onClearToken: () => void
  onClearPassword: () => void
  /** Per-instance input ids (useId): the dialog can render in N-ctx panels in
   *  the same document — static ids would alias across panels. */
  tokenFieldId: string
  passwordFieldId: string
  t: (key: SettingsConnectionsKey) => string
}): ReactNode {
  // Stored credentials never return to the renderer — clearing goes straight
  // to the main process. The button only exists while EDITING a registry
  // gateway row (a new row has nothing stored yet).
  const canClear = editing !== null && editing !== 'new' && editing.kind === 'gateway'
  const hint = editing === null || editing === 'new'
    ? t('gatewayCredentialsHintAdd')
    : targetChanged
      ? t('gatewayCredentialsHintRetarget')
      : t('gatewayCredentialsHintEdit')
  return (
    <>
      {/* 2026-12 复审（HTML 规范）：label 不得含 labeled control 之外的
          labelable 元素——「清除」按钮与输入框同处 label 会污染输入框的
          可访问名称。外层改 div，字段名改 label htmlFor 关联。 */}
      <div className={css.field}>
        <span className={css.fieldLabelRow}>
          <label className={css.fieldLabel} htmlFor={tokenFieldId}>{t('fieldGatewayToken')}</label>
          {canClear
            ? (
              <button
                type="button"
                className={css.clearPassword}
                onClick={() => { void onClearToken() }}
              >
                {t('gatewayTokenClear')}
              </button>
            )
            : null}
        </span>
        <input
          id={tokenFieldId}
          className={css.input}
          type="password"
          value={draft.gatewayToken}
          maxLength={4096}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={t('fieldGatewayTokenPlaceholder')}
          onChange={event => { onChange({ gatewayToken: event.target.value }) }}
        />
        {fieldErrors.gatewayToken === undefined ? null : <span className={css.error} role="alert">{fieldErrors.gatewayToken}</span>}
      </div>
      <div className={css.field}>
        <span className={css.fieldLabelRow}>
          <label className={css.fieldLabel} htmlFor={passwordFieldId}>{t('fieldGatewayPassword')}</label>
          {canClear
            ? (
              <button
                type="button"
                className={css.clearPassword}
                onClick={() => { void onClearPassword() }}
              >
                {t('gatewayPasswordClear')}
              </button>
            )
            : null}
        </span>
        <input
          id={passwordFieldId}
          className={css.input}
          type="password"
          value={draft.gatewayPassword}
          maxLength={1024}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={t('fieldGatewayPasswordPlaceholder')}
          onChange={event => { onChange({ gatewayPassword: event.target.value }) }}
        />
        {fieldErrors.gatewayPassword === undefined ? null : <span className={css.error} role="alert">{fieldErrors.gatewayPassword}</span>}
      </div>
      <span className={clsx(css.dim, css.spanAll)}>{hint}</span>
    </>
  )
}

/** Optional S23 certificate pin. Unlike credentials this is non-secret
 * registry metadata, so edit prefill and ordinary input binding are required
 * to preserve it. The caller renders this only for gateway+http+https. */
function GatewaySpkiField({ draft, onChange, fieldError, fieldId, t }: {
  draft: HostDraft
  onChange: (spkiPin: string) => void
  fieldError: string | undefined
  /** Per-instance input id (useId), same N-ctx scoping as GatewayAuthFields. */
  fieldId: string
  t: (key: SettingsConnectionsKey) => string
}): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabelRow}>
        <label className={css.fieldLabel} htmlFor={fieldId}>{t('fieldSpkiPin')}</label>
        {draft.spkiPin === ''
          ? null
          : (
            <button
              type="button"
              className={css.clearPassword}
              onClick={() => { onChange('') }}
            >
              {t('spkiPinClear')}
            </button>
          )}
      </span>
      <input
        id={fieldId}
        className={css.input}
        value={draft.spkiPin}
        maxLength={64}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={t('fieldSpkiPinPlaceholder')}
        onChange={event => { onChange(event.target.value) }}
      />
      {fieldError === undefined ? null : <span className={css.error} role="alert">{fieldError}</span>}
      <span className={css.dim}>{t('spkiPinHint')}</span>
    </div>
  )
}

/**
 * Render the connections section content column.
 * @param props - composed slot props.
 * @returns the section.
 */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode {
  const { t, pluginDiagnostics, onRecheckDiagnostic } = props
  // Per-instance input ids (useId): the dialog renders inside N-ctx panels in
  // the SAME document — static ids would alias across panels. One id per
  // credential/pin field; the transport branches render one set at a time.
  const gatewayTokenFieldId = useId()
  const gatewayPasswordFieldId = useId()
  const spkiFieldId = useId()
  const sshPasswordFieldId = useId()
  const runtimeState = useSyncExternalStore(subscribeRuntimeState, getRuntimeState)
  const runtimeSurfacePresent = currentRuntimeSurface() !== null
  // Fail closed while the desktop runtime bridge hydrates; once hydrated,
  // applying is the one design-18 phase that forbids every local spawn entry.
  const runtimeStartBlocked = runtimeBlocksLocalStart(runtimeState, runtimeSurfacePresent)

  // ---- local instance card ----
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [connection, setConnection] = useState<ConnectionSummary | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [stopConfirm, setStopConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [hostLogs, setHostLogs] = useState<HostLogsResponse | null>(null)
  const [hostLogsError, setHostLogsError] = useState<string | null>(null)
  /** 主机日志默认折叠；首次展开时才拉取（避免无谓 REST 调用）。 */
  const [hostLogsOpen, setHostLogsOpen] = useState(false)

  // ---- remote host roster ----
  const [instances, setInstances] = useState<SshInstanceSpec[]>([])
  const [statuses, setStatuses] = useState<Record<string, SshStatusProjection>>({})
  const [rosterError, setRosterError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [opError, setOpError] = useState<Record<string, string>>({})

  // ---- dialogs ----
  const [editing, setEditing] = useState<SshInstanceSpec | 'new' | null>(null)
  const [draft, setDraft] = useState<HostDraft | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof HostDraft, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // ---- ~/.ssh/config discovery (add-host form only) ----
  const [configHosts, setConfigHosts] = useState<SshConfigHost[] | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  // The preload bridge is exposed asynchronously after dsh-chamber:info;
  // while it is absent the SSH surface is inert — track its arrival so the
  // mount-time loads retry once it appears (no permanent silent no-op).
  const [bridgeUp, setBridgeUp] = useState<boolean>(() => ssh() !== null)
  // Which instance the logs modal is currently loading (stale-response guard).
  const logsTargetRef = useRef<string | null>(null)
  // Same guard for the gateway host-logs modal (independent of the ring-buffer modal).
  const gatewayLogsTargetRef = useRef<string | null>(null)
  // Whether the remote roster is mid-load (first paint / refresh).
  const [rosterLoading, setRosterLoading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SshInstanceSpec | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [logsFor, setLogsFor] = useState<SshInstanceSpec | null>(null)
  const [remoteLogs, setRemoteLogs] = useState<SshLogEntry[]>([])
  const [remoteLogsError, setRemoteLogsError] = useState<string | null>(null)
  const [logsBusy, setLogsBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  // Gateway 主机日志 Modal（design 17 §9.3）：经实例代理读 gateway 自身
  // 控制面的 /api/host/logs（与本地卡同款 {port, lines, truncated} 形状）。
  const [gatewayLogsFor, setGatewayLogsFor] = useState<SshInstanceSpec | null>(null)
  const [gatewayHostLogs, setGatewayHostLogs] = useState<HostLogsResponse | null>(null)
  const [gatewayHostLogsError, setGatewayHostLogsError] = useState<string | null>(null)
  const [gatewayHostLogsBusy, setGatewayHostLogsBusy] = useState(false)
  /** 插件管理对话框（plan 24 D5-A / design 21 §6.6 勘误⑥ 收敛）：四类卡片
   *  统一开 PluginDialog —— 分叉仅在 target 描述符（本地 / ssh+dsh spec /
   *  gateway 源 / http 直连只读）；gateway 卡在托管 dsh 处于
   *  stopped/error/restart-exhausted 时传 runtimeDown（恢复撤销面门控）。 */
  const [pluginDialogFor, setPluginDialogFor] = useState<PluginDialogTarget | null>(null)

  // ---- gateway 托管 dsh 受控重启（design 21 §5.1）----
  /** 哪个 gateway 卡的「重启 dsh」确认 Modal 开着。 */
  const [restartConfirmFor, setRestartConfirmFor] = useState<SshInstanceSpec | null>(null)
  /** 每卡独立单飞（与 busy[id] 同款模型）：正在重启的 gateway 卡 id 集。
   *  A 卡在飞不影响 B 卡按钮/Modal；收尾只清自己的 id，绝不静默关闭他卡。 */
  const [restartingIds, setRestartingIds] = useState<Record<string, boolean>>({})
  /** 每卡重启/启动结果行（成功/失败/超时/拒绝），按卡片 id 落独立行；tone
   *  决定渲染：'error' = css.error + role="alert"（opError 同款红字），
   *  'ok' = css.hint + role="status"。 */
  const [restartNotes, setRestartNotes] = useState<Record<string, RestartNote | null>>({})
  /** 每卡在飞重启的 AbortController（同卡新尝试先中止旧的；卸载时全部中止）。 */
  const restartAbortRefs = useRef<Record<string, AbortController>>({})

  // ---- gateway 托管 dsh 启动（design 21 §6.8 r1 / decision 12）----
  /** 正在启动的 gateway 卡 id 集（与 restartingIds 同款每卡单飞；同卡
   *  重启/启动互斥 —— 二者写同一 runtime）。 */
  const [startBusyIds, setStartBusyIds] = useState<Record<string, boolean>>({})
  /** 每卡在飞启动的 AbortController。 */
  const startAbortRefs = useRef<Record<string, AbortController>>({})
  /** 每卡托管 dsh runtime connectionState（design 21 §6.8 r1 启动门控）：
   *  隧道 phase 只证明 gateway 宿主可达 —— 托管 dsh 是否在跑由
   *  /chamber/runtime/status 的 connectionState 投影回答；「启动实例」
   *  仅在该状态 ∈ {stopped, error, restart-exhausted} 时出现。卡条目只在
   *  宿主答 200 后写入。 */
  const [runtimeConnectionById, setRuntimeConnectionById] = useState<Record<string, string | undefined>>({})

  const clearOpError = useCallback((id: string): void => {
    setOpError(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  /** 本地卡：/health + 连接行（各自容错，任一失败都显式落 error）。 */
  const loadLocal = useCallback(async (): Promise<void> => {
    let failed: unknown = null
    try {
      setHealth(await cp.health())
    } catch (err) { failed ??= err }
    try {
      setConnection(await cp.connectionsList())
    } catch (err) { failed ??= err }
    setLocalError(failed === null ? null : errorMessage(failed))
  }, [])

  const loadHostLogs = useCallback(async (): Promise<void> => {
    try {
      setHostLogs(await cp.hostLogs(HOST_LOG_LIMIT, 0))
      setHostLogsError(null)
    } catch (err) {
      setHostLogsError(errorMessage(err))
    }
  }, [])

  const toggleHostLogs = useCallback((): void => {
    const next = !hostLogsOpen
    setHostLogsOpen(next)
    if (next && hostLogs === null && hostLogsError === null) void loadHostLogs()
  }, [hostLogsOpen, hostLogs, hostLogsError, loadHostLogs])

  /** 幂等启动本地实例（POST /api/connections；启动后立即回读 /health）。 */
  const startLocal = useCallback(async (): Promise<void> => {
    if (runtimeStartBlocked) return
    setLocalBusy(true)
    try {
      setConnection(await cp.createLocal())
      setLocalError(null)
    } catch (err) {
      setLocalError(errorMessage(err))
    } finally {
      setLocalBusy(false)
    }
    void loadLocal()
  }, [loadLocal, runtimeStartBlocked])

  /** 优雅停止本地实例（DELETE /api/connections/local）。 */
  const stopLocal = useCallback(async (): Promise<void> => {
    setStopping(true)
    try {
      await cp.removeLocal('local')
      setStopConfirm(false)
      setLocalError(null)
    } catch (err) {
      setLocalError(errorMessage(err))
    } finally {
      setStopping(false)
    }
    void loadLocal()
  }, [loadLocal])

  /** 装载注册表实例；每个实例回读一次隧道 phase 与（配置了服务时的）systemd 激活态。 */
  const loadRemote = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null) return
    setRosterLoading(true)
    try {
      const specs = await bridge.instances_get()
      setInstances(specs)
      setRosterError(null)
      // 背景刷新只更新投影，不清除行内错误（clearOpError 留给用户显式操作
      // 与状态推送）——并发用户操作刚设置的错误不能被背景成功误清。
      for (const spec of specs) {
        void bridge.status(spec.id)
          .then(projection => {
            if (projection !== null) {
              setStatuses(prev => ({ ...prev, [spec.id]: projection }))
            }
          })
          .catch((err: unknown) => {
            setOpError(prev => ({ ...prev, [spec.id]: errorMessage(err) }))
          })
        if (spec.serviceName === null) continue
        void bridge.is_active(spec.id)
          .then(result => {
            if ('error' in result) setOpError(prev => ({ ...prev, [spec.id]: result.error }))
            else {
              setStatuses(prev => ({ ...prev, [spec.id]: result }))
            }
          })
          .catch((err: unknown) => {
            setOpError(prev => ({ ...prev, [spec.id]: errorMessage(err) }))
          })
      }
    } catch (err) {
      setRosterError(errorMessage(err))
    } finally {
      setRosterLoading(false)
    }
  }, [])

  /** 隧道连接/断开：成功即落投影（phase 徽标随之更新），失败行内红字。 */
  const runTunnelOp = useCallback(async (id: string, op: 'connect' | 'disconnect'): Promise<void> => {
    const bridge = ssh()
    if (bridge === null) return
    setBusy(prev => ({ ...prev, [id]: true }))
    try {
      const projection = await bridge[op](id)
      if (projection !== null) setStatuses(prev => ({ ...prev, [id]: projection }))
      clearOpError(id)
    } catch (err) {
      setOpError(prev => ({ ...prev, [id]: errorMessage(err) }))
    } finally {
      setBusy(prev => ({ ...prev, [id]: false }))
    }
  }, [clearOpError])

  /** systemd 起停/查询：结果投影合并进 statuses（serviceActive 随卡片显示）。 */
  const runServiceOp = useCallback(async (id: string, op: 'start_service' | 'stop_service' | 'restart_service' | 'is_active'): Promise<void> => {
    const bridge = ssh()
    if (bridge === null) return
    setBusy(prev => ({ ...prev, [id]: true }))
    try {
      const result = await bridge[op](id)
      if ('error' in result) setOpError(prev => ({ ...prev, [id]: result.error }))
      else {
        setStatuses(prev => ({ ...prev, [id]: result }))
        clearOpError(id)
      }
    } catch (err) {
      setOpError(prev => ({ ...prev, [id]: errorMessage(err) }))
    } finally {
      setBusy(prev => ({ ...prev, [id]: false }))
    }
  }, [clearOpError])

  /**
   * 受控重启 gateway 托管的 dsh（design 21 §5.1）：POST
   * /api/i/gateway-<id>/chamber/runtime/restart —— 仅 202 接受；409/400 拒绝
   * 逐字投影 body.error（serverRefusalText）。202 后按 shared pollGatewayReady
   * 语义轮询 /chamber/runtime/status（1s/120s；restart failed / 终态 / 401/403/
   * 404 快失败；超时诚实投影）。结果落在该卡独立结果行（restartNotes：
   * tone 分流渲染，error = 红字 alert、ok = 灰字 status），
   * 成功顺带刷新卡片状态投影。桌面零改动：写走既有反代（auth 主进程注入）。
   */
  const restartManagedDsh = useCallback(async (spec: SshInstanceSpec): Promise<void> => {
    // 每卡独立单飞：同卡重复确认被门挡住；他卡在飞不受影响。
    if (restartingIds[spec.id] === true) return
    const id = `gateway-${spec.id}`
    // 同卡新尝试（防御性，单飞门已挡并发）先中止上一轮，互不串扰。
    restartAbortRefs.current[spec.id]?.abort()
    const controller = new AbortController()
    restartAbortRefs.current[spec.id] = controller
    setRestartingIds(prev => ({ ...prev, [spec.id]: true }))
    setRestartNotes(prev => ({ ...prev, [spec.id]: null }))
    const note = (value: RestartNote | null): void => {
      setRestartNotes(prev => ({ ...prev, [spec.id]: value }))
    }
    try {
      let response: Response
      try {
        response = await fetch(`/api/i/${id}/chamber/runtime/restart`, { method: 'POST' })
      } catch (err) {
        if (controller.signal.aborted) return
        note({ tone: 'error', text: errorMessage(err) })
        return
      }
      if (response.status !== 202) {
        let body: unknown = null
        try { body = await response.json() } catch { body = null }
        note({ tone: 'error', text: serverRefusalText(body, response.status) })
        return
      }
      try {
        await pollGatewayReady(id, controller.signal)
        note({ tone: 'ok', text: t('restartManagedDshOk') })
        // 成功/失败刷新卡片状态投影（design 21 §5.1）：registry 不变，只重读
        // 各实例 phase/service 激活态。
        void loadRemote()
      } catch (err) {
        if (controller.signal.aborted) return
        const cls = classifyRestartError(err)
        // accepted-timeout = 重启已接受、仍在恢复 → 本地化说明（ok 语气：动作
        // 已被接受，仅提示仍在恢复）；其余 = 轮询/服务的英文错误串原样透出
        // （error 语气；未本地化文案登记接受，design 21 §5.2）。
        note(cls.kind === 'accepted-timeout'
          ? { tone: 'ok', text: t('restartManagedDshAccepted') }
          : { tone: 'error', text: cls.detail })
      }
    } finally {
      // 收尾只清自己的 id：A 卡完成绝不静默关闭/解锁 B 卡的在飞状态。
      setRestartingIds(prev => {
        if (prev[spec.id] !== true) return prev
        const next = { ...prev }
        delete next[spec.id]
        return next
      })
      // 只关闭「正在收尾这张卡」的确认 Modal；他卡 Modal 保持原样。
      setRestartConfirmFor(prev => (prev !== null && prev.id === spec.id ? null : prev))
      if (restartAbortRefs.current[spec.id] === controller) delete restartAbortRefs.current[spec.id]
    }
  }, [restartingIds, t, loadRemote])

  /**
   * 托管 dsh runtime 探针（design 21 §6.8 r1）：GET /api/i/gateway-<id>/
   *  chamber/runtime/status —— 只投影 connectionState（启动动作的门控输入）。
   *  /chamber 管理面挂宿主、非 ready-gated：托管 dsh 停机时宿主仍答 200，
   *  所以隧道 'ready' 与 runtime 'stopped' 可以并存，二者都必须诚实呈现。
   *  失败/非 200 = 状态未知 —— 不写条目（启动按钮随之不渲染）；200 只更新
   *  change 的卡（同值不重写，避免无谓渲染）。
   */
  const probeGatewayRuntime = useCallback(async (specId: string): Promise<void> => {
    let connectionState: string | null = null
    try {
      const response = await fetch(`/api/i/gateway-${specId}/chamber/runtime/status`)
      if (response.status !== 200) return
      const payload = await response.json() as { connectionState?: unknown } | null
      connectionState = typeof payload?.connectionState === 'string' ? payload.connectionState : null
    } catch {
      return
    }
    if (connectionState === null) return
    setRuntimeConnectionById(prev => prev[specId] === connectionState ? prev : { ...prev, [specId]: connectionState })
  }, [])

  /** 「启动实例」（design 21 §6.8 r1 / decision 12, start 原语）：POST
   *  /api/i/gateway-<id>/chamber/runtime/start —— 与 restart 同一 202 +
   *  pollGatewayReady 语义（仅 stopped/error/restart-exhausted 可启动，
   *  其余 409 body.error 逐字经 serverRefusalText；202 后共享轮询按
   *  connectionState 收敛，start:'failed'/终态快失败、超时诚实投影）。
   *  每卡独立单飞（startBusyIds）+ 与重启互斥；结果落 restartNotes 槽位
   *  （同一张卡同一时刻只允许一个 runtime 动作在飞）。成功刷新卡片投影并
   *  立即重探 runtime（按钮随 connectionState 收敛而消失）。
   */
  const startManagedDsh = useCallback(async (spec: SshInstanceSpec): Promise<void> => {
    if (startBusyIds[spec.id] === true) return
    if (restartingIds[spec.id] === true) return
    const id = `gateway-${spec.id}`
    startAbortRefs.current[spec.id]?.abort()
    const controller = new AbortController()
    startAbortRefs.current[spec.id] = controller
    setStartBusyIds(prev => ({ ...prev, [spec.id]: true }))
    setRestartNotes(prev => ({ ...prev, [spec.id]: null }))
    const note = (value: RestartNote | null): void => {
      setRestartNotes(prev => ({ ...prev, [spec.id]: value }))
    }
    try {
      let response: Response
      try {
        response = await fetch(`/api/i/${id}/chamber/runtime/start`, { method: 'POST', signal: controller.signal })
      } catch (err) {
        if (controller.signal.aborted) return
        note({ tone: 'error', text: errorMessage(err) })
        return
      }
      if (response.status !== 202) {
        let body: unknown = null
        try { body = await response.json() } catch { body = null }
        note({ tone: 'error', text: serverRefusalText(body, response.status) })
        return
      }
      try {
        await pollGatewayReady(id, controller.signal)
        note({ tone: 'ok', text: t('startManagedDshOk') })
        void loadRemote()
        void probeGatewayRuntime(spec.id)
      } catch (err) {
        if (controller.signal.aborted) return
        const cls = classifyRestartError(err)
        // accepted-timeout = 启动已接受、仍在恢复：轮询的英文超时串原样透出
        // （error 语气；无 start 专用 zh 超时键；restartManagedDshAccepted 的
        // 「重启」措辞对启动不准确，未借用 —— 未本地化文案登记接受，design 21
        // §5.2）；其余 = 启动失败 + 逐字 detail（error 语气）。
        note({ tone: 'error', text: cls.kind === 'accepted-timeout'
          ? errorMessage(err)
          : t('startManagedDshFailed').replace('{error}', cls.detail) })
      }
    } finally {
      setStartBusyIds(prev => {
        if (prev[spec.id] !== true) return prev
        const next = { ...prev }
        delete next[spec.id]
        return next
      })
      if (startAbortRefs.current[spec.id] === controller) delete startAbortRefs.current[spec.id]
    }
  }, [startBusyIds, restartingIds, t, loadRemote, probeGatewayRuntime])

  const openLogs = useCallback(async (spec: SshInstanceSpec): Promise<void> => {
    logsTargetRef.current = spec.id
    setLogsFor(spec)
    setRemoteLogs([])
    setRemoteLogsError(null)
    setConfirmClear(false)
    const bridge = ssh()
    if (bridge === null) {
      // The desktop bridge is absent: never open a silently-empty modal.
      setRemoteLogsError(t('desktopOnly'))
      return
    }
    setLogsBusy(true)
    try {
      const loaded = await bridge.logs(spec.id)
      // Stale-response guard: a newer modal target (or a close) supersedes.
      if (logsTargetRef.current !== spec.id) return
      setRemoteLogs(loaded)
    } catch (err) {
      if (logsTargetRef.current !== spec.id) return
      setRemoteLogsError(errorMessage(err))
    } finally {
      setLogsBusy(false)
    }
  }, [t])

  const refreshLogs = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (logsFor === null || bridge === null) return
    setLogsBusy(true)
    try {
      const loaded = await bridge.logs(logsFor.id)
      if (logsTargetRef.current !== logsFor.id) return
      setRemoteLogs(loaded)
      setRemoteLogsError(null)
    } catch (err) {
      if (logsTargetRef.current !== logsFor.id) return
      setRemoteLogsError(errorMessage(err))
    } finally {
      setLogsBusy(false)
    }
  }, [logsFor])

  /** 清空环形缓冲：两步确认（按钮文字切换，不引入嵌套 Modal）。 */
  const clearLogs = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (logsFor === null || bridge === null) return
    setLogsBusy(true)
    try {
      await bridge.logs_clear(logsFor.id)
      if (logsTargetRef.current !== logsFor.id) return
      setRemoteLogs([])
      setRemoteLogsError(null)
      setConfirmClear(false)
    } catch (err) {
      if (logsTargetRef.current !== logsFor.id) return
      setRemoteLogsError(errorMessage(err))
    } finally {
      setLogsBusy(false)
    }
  }, [logsFor])

  /** Gateway 主机日志（design 17 §9.3）：经实例代理读 gateway 自身控制面
   *  /api/host/logs；响应形状与本地卡一致，直接复用 HostLogsResponse 渲染。 */
  const openGatewayHostLogs = useCallback(async (spec: SshInstanceSpec): Promise<void> => {
    gatewayLogsTargetRef.current = spec.id
    setGatewayLogsFor(spec)
    setGatewayHostLogs(null)
    setGatewayHostLogsError(null)
    setGatewayHostLogsBusy(true)
    try {
      const loaded = await cp.gatewayHostLogs(spec.id, HOST_LOG_LIMIT, 0)
      if (gatewayLogsTargetRef.current !== spec.id) return
      setGatewayHostLogs(loaded)
    } catch (err) {
      if (gatewayLogsTargetRef.current !== spec.id) return
      setGatewayHostLogsError(errorMessage(err))
    } finally {
      setGatewayHostLogsBusy(false)
    }
  }, [])

  const refreshGatewayHostLogs = useCallback(async (): Promise<void> => {
    if (gatewayLogsFor === null) return
    setGatewayHostLogsBusy(true)
    try {
      const loaded = await cp.gatewayHostLogs(gatewayLogsFor.id, HOST_LOG_LIMIT, 0)
      if (gatewayLogsTargetRef.current !== gatewayLogsFor.id) return
      setGatewayHostLogs(loaded)
      setGatewayHostLogsError(null)
    } catch (err) {
      if (gatewayLogsTargetRef.current !== gatewayLogsFor.id) return
      setGatewayHostLogsError(errorMessage(err))
    } finally {
      setGatewayHostLogsBusy(false)
    }
  }, [gatewayLogsFor])

  const removeInstance = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || pendingDelete === null) return
    setDeleting(true)
    try {
      // Exact id-addressed main transaction: never send a roster snapshot.
      // A stale read-modify-write could otherwise delete a connection added
      // concurrently after this dialog opened.
      const saved = await bridge.delete_connection(pendingDelete.id)
      setInstances(saved)
      setPendingDelete(null)
      setStatuses(prev => {
        const copy = { ...prev }
        delete copy[pendingDelete.id]
        return copy
      })
      // Loud-failure invariant: delete_connection returns the authoritative
      // current registry. If the
      // deletion did not land, say so instead of a silent no-op.
      if (saved.some(instance => instance.id === pendingDelete.id)) {
        setOpError(prev => ({ ...prev, [pendingDelete.id]: t('deleteNotEffective') }))
      } else {
        clearOpError(pendingDelete.id)
      }
    } catch (err) {
      // 删除失败：卡片保留，错误留在卡片与弹窗内
      setOpError(prev => ({ ...prev, [pendingDelete.id]: errorMessage(err) }))
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, clearOpError])

  /**
   * Load the ~/.ssh/config host projections (non-secret metadata only; the
   * main process never exposes keys/proxies/credentials). A missing config
   * is an empty list; a read failure is a loud error.
   */
  const loadConfigHosts = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null) return
    setConfigLoading(true)
    try {
      const result: SshConfigDiscovery = await bridge.config_list()
      if ('error' in result) {
        setConfigHosts(null)
        setConfigError(result.error)
      } else {
        setConfigHosts(result.hosts)
        setConfigError(null)
      }
    } catch (err) {
      setConfigHosts(null)
      setConfigError(errorMessage(err))
    } finally {
      setConfigLoading(false)
    }
  }, [])

  /**
   * Apply a discovered config host to the draft (host keeps the alias so the
   * ssh config block — port, identity, proxy — applies as with plain ssh).
   * Only empty fields are filled: a user's manual input is never overwritten,
   * and only the errors of the fields that were actually filled are cleared.
   */
  const applyConfigHost = useCallback((host: SshConfigHost): void => {
    const filled: (keyof HostDraft)[] = []
    setDraft(prev => {
      if (prev === null) return prev
      const next = { ...prev }
      if (next.id.trim() === '') {
        const slug = slugifyAlias(host.alias)
        next.id = slug !== '' ? slug : slugifyAlias(host.hostName)
        filled.push('id')
      }
      if (next.label.trim() === '') {
        next.label = host.alias
        filled.push('label')
      }
      if (next.host.trim() === '') {
        next.host = host.alias
        filled.push('host')
      }
      if (next.user.trim() === '') {
        next.user = host.user ?? ''
        filled.push('user')
      }
      if (next.sshPort.trim() === '') {
        next.sshPort = host.port === null ? '' : String(host.port)
        filled.push('sshPort')
      }
      return next
    })
    setFormError(null)
    setFieldErrors(prev => {
      if (filled.length === 0) return prev
      const next = { ...prev }
      for (const key of filled) next[key] = undefined
      return next
    })
  }, [])

  const openAdd = useCallback((): void => {
    setEditing('new')
    setDraft({ ...EMPTY_DRAFT })
    setFieldErrors({})
    setFormError(null)
    setConfigHosts(null)
    setConfigError(null)
    void loadConfigHosts()
  }, [loadConfigHosts])

  const openEdit = useCallback((spec: SshInstanceSpec): void => {
    setEditing(spec)
    // Pure normalization covers all four target/transport combinations and
    // preserves the non-secret SPKI pin. Credential fields remain empty by
    // construction because their values never cross the IPC boundary.
    setDraft(draftFromSpec(spec))
    setFieldErrors({})
    setFormError(null)
    setConfigHosts(null)
    setConfigError(null)
  }, [])

  /** 清除该主机在主进程内存与 owner-only 镜像中的密码（改用密钥/ssh-agent）。 */
  const clearPassword = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || editing === null || editing === 'new') return
    const result = await bridge.set_password(editing.id, null)
    if ('error' in result) {
      setFormError(result.error)
    } else {
      setDraft(prev => (prev === null ? prev : { ...prev, password: '' }))
      setInstances(prev => prev.map(instance => instance.id === editing.id
        ? { ...instance, sshPasswordSet: false }
        : instance))
      setEditing(prev => prev === null || prev === 'new'
        ? prev
        : { ...prev, sshPasswordSet: false })
      setFormError(null)
    }
  }, [editing])

  /** Clear a stored gateway token without ever reading it into the renderer. */
  const clearGatewayToken = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || editing === null || editing === 'new') return
    const result = await bridge.set_gateway_token(editing.id, null)
    if ('error' in result) {
      setFormError(result.error)
    } else {
      setDraft(prev => (prev === null ? prev : { ...prev, gatewayToken: '' }))
      setInstances(prev => prev.map(instance => instance.id === editing.id
        ? { ...instance, tokenSet: false }
        : instance))
      setEditing(prev => prev === null || prev === 'new'
        ? prev
        : { ...prev, tokenSet: false })
      setFormError(null)
    }
  }, [editing])

  /** Clear a stored gateway login password (design 17 §7.1) without ever
   *  reading it into the renderer. */
  const clearGatewayPassword = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || editing === null || editing === 'new') return
    // set_gateway_password is on the authoritative DesktopSshSurface (design
    // 17 §7.1, desktop gateway-secrets task).
    const result = await bridge.set_gateway_password(editing.id, null)
    if ('error' in result) {
      setFormError(result.error)
    } else {
      setDraft(prev => (prev === null ? prev : { ...prev, gatewayPassword: '' }))
      setInstances(prev => prev.map(instance => instance.id === editing.id
        ? { ...instance, passwordSet: false }
        : instance))
      setEditing(prev => prev === null || prev === 'new'
        ? prev
        : { ...prev, passwordSet: false })
      setFormError(null)
    }
  }, [editing])

  const closeForm = useCallback((): void => {
    if (saving) return
    setEditing(null)
    setDraft(null)
    setFieldErrors({})
    setFormError(null)
  }, [saving])

  /**
   * 表单只收非秘密元数据；id 格式 ^[a-zA-Z0-9_-]+$（新增时查重、'local'
   * 为本地来源保留字）、端口十进制 1–65535、host/user 与主进程同源白名单
   * （首字符不得为 '-'，防 ssh 选项注入）、serviceName 白名单
   * ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$（首字符必须为字母或数字）。
   */
  const validate = useCallback((value: HostDraft): Partial<Record<keyof HostDraft, string>> => {
    const errors: Partial<Record<keyof HostDraft, string>> = {}
    const id = value.id.trim()
    if (id === '') errors.id = t('validationIdRequired')
    else if (id === 'local') errors.id = t('validationIdReserved')
    else if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) errors.id = t('validationIdInvalid')
    else if (editing === 'new' && instances.some(instance => instance.id === id)) errors.id = t('validationIdDuplicate')
    if (value.label.trim() === '') errors.label = t('validationLabelRequired')
    else if (value.label.length > 128) errors.label = t('validationLabelTooLong')
    // Credential dimensions are independent. Re-entry is driven by the main
    // process's non-secret existence projections plus the exact retarget rule:
    // gateway+ssh may require both its tunnel password and gateway auth, while
    // key/agent and --no-auth rows remain unblocked.
    if (editing !== null && editing !== 'new') {
      const reentry = credentialReentryEdit(editing, value)
      if (reentry.gatewayToken && value.gatewayToken === '') errors.gatewayToken = t('validationGatewayCredentialsRequired')
      if (reentry.gatewayPassword && value.gatewayPassword === '') errors.gatewayPassword = t('validationGatewayCredentialsRequired')
      if (reentry.sshPassword && value.password === '') {
        errors.password = t('validationPasswordRequired')
      }
    }
    if (value.kind === 'gateway') {
      // The token is OPTIONAL (design 17 §2.3 — auth is never a mode; an
      // empty token sends no auth header and the gateway decides, §7.3).
      // ASCII/length checks apply only when a value is present.
      if (value.gatewayToken !== '' && !/^[\x20-\x7e]+$/.test(value.gatewayToken)) {
        // Mirror the main-process gate (gatewayTokenValidationError): a
        // token with non-visible-ASCII bytes would pass the renderer but be
        // rejected by the main process with a vague write failure.
        errors.gatewayToken = t('validationGatewayTokenAscii')
      } else if (value.gatewayToken !== '' && value.gatewayToken.length < MIN_GATEWAY_TOKEN_CHARS) {
        errors.gatewayToken = t('validationGatewayTokenLength')
      }
      // The login password (design 17 §7.1) is likewise optional; when a
      // value IS present it mirrors the server config gate — 12–1024 JS
      // characters, including Unicode. The shared helper returns a machine
      // code that the dictionary localizes.
      const passwordError = gatewayPasswordValidationError(value.gatewayPassword)
      if (passwordError === 'length') errors.gatewayPassword = t('validationGatewayPasswordLength')
    }
    if (transportFormSchema(value.transport).fieldGroup === 'url') {
      // transport='http' validates/derives the URL for EVERY kind (P3-3): a
      // defensive dsh+http row must not silently skip the URL gate (the
      // target is URL-derived for http) nor fall through to host validation
      // for fields the form does not render. A dsh+http draft has no auth
      // surface (design 17 §2.1), but its URL is still validated loudly.
      const parsed = parseGatewayUrl(value.gatewayUrl)
      if (!parsed.ok) errors.gatewayUrl = gatewayUrlErrorText(parsed, t)
      if (spkiPinEligible(value) && spkiPinValidationError(value.spkiPin) !== null) {
        errors.spkiPin = t('validationSpkiPinFormat')
      }
      return errors
    }
    const host = value.host.trim()
    if (host === '') errors.host = t('validationHostRequired')
    else if (!/^[a-zA-Z0-9.:\[][a-zA-Z0-9._:[\]-]*$/.test(host)) errors.host = t('validationHostInvalid')
    if (value.user.trim() !== '') {
      const user = value.user.trim()
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(user)) errors.user = t('validationUserInvalid')
    }
    const parsePort = (raw: string): number | null => {
      const trimmed = raw.trim()
      if (trimmed === '') return null
      if (!/^\d+$/.test(trimmed)) return NaN
      return Number(trimmed)
    }
    const port = parsePort(value.remotePort)
    if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) errors.remotePort = t('validationPortRange')
    const sshPort = parsePort(value.sshPort)
    if (sshPort !== null && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) errors.sshPort = t('validationPortRange')
    const serviceName = value.serviceName.trim()
    if (serviceName !== '' && !SERVICE_NAME_PATTERN.test(serviceName)) errors.serviceName = t('validationServiceNameInvalid')
    const remoteDshHome = value.remoteDshHome.trim()
    if (remoteDshHome !== '' && !/^~?\/[a-zA-Z0-9._/-]+$/.test(remoteDshHome)) errors.remoteDshHome = t('validationRemoteDshHomeInvalid')
    return errors
  }, [editing, instances, t])

  /** 新增/编辑走主进程的 save_connection 事务；编辑时 id 不可改。 */
  const saveDraft = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || draft === null || editing === null) return
    const errors = validate(draft)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    try {
      const input = draftToInput(draft)
      // transport='http' derives the target from the URL for EVERY kind
      // (P3-3 — defensive dsh+http rows included): validate() already
      // rejected a malformed URL loudly; this re-check turns a parse failure
      // at save time (draft mutated after validation) into an explicit field
      // error instead of a silent no-op.
      if (draft.transport === 'http') {
        const parsed = parseGatewayUrl(draft.gatewayUrl)
        if (!parsed.ok) {
          setFieldErrors(prev => ({ ...prev, gatewayUrl: gatewayUrlErrorText(parsed, t) }))
          return
        }
      }
      // One main-owned transaction receives the replacement metadata and all
      // applicable NEW write-only values. Old credentials never return to
      // renderer; main snapshots and restores them on any registry/store
      // failure. Empty fields leave their stored dimensions untouched.
      const result = await saveHostWithConnectionCredentials(
        bridge,
        editing === 'new' ? null : editing.id,
        editing === 'new' ? input : { ...input, id: editing.id },
        // The save helper filters these values through the independent
        // capability matrix. gateway+ssh can commit both credential layers;
        // dsh+http commits none, even if stale component state were injected.
        {
          sshPassword: draft.password,
          token: draft.gatewayToken,
          password: draft.gatewayPassword,
        },
      )
      setInstances(result.instances)
      if (!result.ok) {
        setFormError(result.error)
        // If rollback genuinely failed, turn a newly-created row into an edit
        // target so retry cannot submit a duplicate id. The password field
        // remains in the current draft for an explicit retry.
        if (result.metadataCommitted && editing === 'new') {
          const committed = result.instances.find(instance => instance.id === input.id)
          if (committed !== undefined) setEditing(committed)
        }
        return
      }
      setEditing(null)
      setDraft(null)
      setFormError(null)
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [draft, editing, instances, validate])

  // 挂载：装载本地卡 / 注册表；订阅隧道状态推送（实时更新徽标）。
  // 主机日志默认折叠，首次展开时懒加载，挂载不拉取。
  // bridgeUp 触发重跑：preload 的 dshChamber 暴露是异步的，桥出现后重载一次，
  // 避免 SSH 面永久静默失效。
  useEffect(() => {
    if (!bridgeUp) return
    void loadLocal()
    void loadRemote()
    // 本地卡状态由推送流驱动（05 §3）：迁移即时可见；30s 行轮询只兜底
    // 连接行字段（label/dshPort）与流异常收敛（远程卡走 live pushes）。
    const timer = setInterval(() => { void loadLocal() }, LOCAL_ROW_POLL_MS)
    const events = cp.healthEvents()
    events.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { ok?: boolean; dsh?: unknown }
        if (payload?.ok === true && payload?.dsh !== undefined) {
          setHealth(payload as HealthResponse)
          setLocalError(null)
        }
      } catch {
        // 畸形帧忽略
      }
    }
    events.onerror = () => {
      // 流中断（控制面重启/网络抖动）：一次性回读，EventSource 会自行重连
      void loadLocal()
    }
    return () => {
      clearInterval(timer)
      events.close()
    }
  }, [bridgeUp, loadLocal, loadRemote])

  useEffect(() => {
    if (!bridgeUp) return
    const bridge = ssh()
    if (bridge === null) return
    const unsubscribe = bridge.onStatusChanged(payload => {
      setStatuses(prev => ({ ...prev, [payload.id]: payload.status }))
      // A live status push is authoritative: clear the stale inline error.
      clearOpError(payload.id)
    })
    // 注册表变更推送：设置页之外的增删改（renderer App 已订阅、本页曾缺失）
    // 即刻重拉 roster——否则外部编辑要等重挂载才可见（roster 新鲜度修复）。
    const unsubscribeInstances = bridge.onInstancesChanged(() => {
      void loadRemote()
    })
    return () => {
      unsubscribe()
      unsubscribeInstances()
    }
  }, [bridgeUp, clearOpError, loadRemote])

  // Poll for the bridge while it is absent (preload exposes it after the
  // async dsh-chamber:info round-trip).
  useEffect(() => {
    if (bridgeUp) return
    const timer = setInterval(() => {
      if (ssh() !== null) setBridgeUp(true)
    }, 500)
    return () => { clearInterval(timer) }
  }, [bridgeUp])

  // 卸载即中止全部在飞的重启/启动轮询（pollGatewayReady 对 AbortSignal
  // 敏感）：迟到的响应绝不能改写已卸载页面的状态。
  useEffect(() => {
    return () => {
      for (const controller of Object.values(restartAbortRefs.current)) controller.abort()
      for (const controller of Object.values(startAbortRefs.current)) controller.abort()
    }
  }, [])

  // Gateway 卡 runtime 探针节奏（design 21 §6.8 r1）：注册表/状态变化时立即
  // 探一次已连接 gateway 卡，此后按固定间隔维持（宿主侧自发停机/恢复无桌面
  // 事件可依赖）；transport 断开（phase 非 ready/degraded）的卡不探 ——
  // 启动动作本身以 connected 门控，未知/断连时绝不渲染。
  useEffect(() => {
    if (!bridgeUp) return
    const connectedGatewaySpecs = (): SshInstanceSpec[] => instances.filter(spec =>
      spec.kind === 'gateway'
      // Kind guard mirrors the card's stale-projection suppression: a kind
      // switch keeps the id, so a status pushed for the OLD kind must never
      // drive the runtime probe.
      && statuses[spec.id]?.kind === 'gateway'
      && (statuses[spec.id]?.phase === 'ready' || statuses[spec.id]?.phase === 'degraded'))
    const probe = (): void => {
      for (const spec of connectedGatewaySpecs()) void probeGatewayRuntime(spec.id)
    }
    probe()
    const timer = setInterval(probe, GATEWAY_RUNTIME_PROBE_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [bridgeUp, instances, statuses, probeGatewayRuntime])

  const dsh = health?.dsh
  const healthy = dsh?.status === 'ready' || dsh?.status === 'degraded'
  const starting = dsh?.status === 'starting' || dsh?.status === 'restarting'
  /** 确认 Modal 的目标卡是否正处「本卡重启」忙碌态（他卡在飞不影响本 Modal）。 */
  const restartConfirmBusy = restartConfirmFor !== null && restartingIds[restartConfirmFor.id] === true

  // dsh 运行时版本（design 18 §3.6 B）：优先读同一个 runtime state；旧壳
  // 尚未提供完整状态时才回退 M0 的 info 投影，null/空串时不编造 chip。
  const dshVersion = runtimeState?.active
    ?? (typeof window !== 'undefined' ? (window.dshChamber?.dshVersion ?? null) : null)

  /** 虚线添加入口（2026-11）：有卡片时作为网格的最后一个单元格，与卡片
   *  同宽；空名单时独立通栏显示。 */
  const creatorButton = (
    <button type="button" className={css.creatorButton} onClick={openAdd}>
      <IconPlusOutline16 size={14} />
      {t('addHost')}
    </button>
  )

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      {/* S22 fallback visibility (design 17 §13.4.1): when the OS keychain is
          unavailable the main process mirrors gateway credentials as the
          documented 0600 plaintext fallback — the fallback path must be
          visible on the settings page. The main process merges the
          read-only secretStorage projection onto every instances_get row
          (global per store), so any plaintext row shows the hint line. */}
      {instances.some(spec => spec.secretStorage === 'plaintext')
        ? <p className={css.hint} role="status">{t('secretStoragePlaintextHint')}</p>
        : null}
      {ssh() === null ? <p className={css.error} role="alert">{t('desktopOnly')}</p> : null}

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('localTitle')}</h3>
        <div className={css.localCard}>
          {/* 2026-11 横向化: 名称+状态+meta 在左，操作在右。 */}
          <div className={css.localHeadRow}>
            <div className={css.localHeadText}>
              <div className={css.localHead}>
                <span className={css.localName}>{t('localTitle')}</span>
                <span className={clsx(
                  css.badge,
                  dsh?.status === 'error' || dsh?.status === 'degraded' ? css.badgeBad : healthy ? css.badgeOk : undefined,
                )}>
                  {t(localStatusKey(dsh?.status ?? ''))}
                </span>
              </div>
              <div className={css.localMeta}>
                <span>{t('localPort')}：<span className={css.mono}>{dsh?.port ?? '—'}</span></span>
                {connection?.label !== undefined && connection.label !== '' ? <span>{connection.label}</span> : null}
                {dshVersion != null && dshVersion !== '' ? <span className={css.mono}>dsh v{dshVersion}</span> : null}
              </div>
            </div>
            <div className={css.localActions}>
              <Button
                variant="primary"
                size="sm"
                disabled={healthy || starting || localBusy || stopping || runtimeStartBlocked}
                onClick={() => { void startLocal() }}
              >
                {t('localStart')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!healthy || localBusy || stopping}
                onClick={() => { setStopConfirm(true) }}
              >
                {t('localStop')}
              </Button>
              <button
                type="button"
                className={css.iconButton}
                data-tip={t('pluginsOpen')}
                aria-label={t('pluginsOpen')}
                onClick={() => { setPluginDialogFor({ kind: 'local' }) }}
              >
                <IconFolderOpenOutline16 />
              </button>
              <button
                type="button"
                className={css.iconButton}
                data-tip={t('localRefresh')}
                aria-label={t('localRefresh')}
                onClick={() => { void loadLocal() }}
              >
                <IconRefreshOutline16 />
              </button>
            </div>
          </div>
          {dsh?.error != null && dsh.error !== '' ? <p className={css.error}>{dsh.error}</p> : null}
          {localError !== null ? <p className={css.error} role="alert">{localError}</p> : null}
          {runtimeState?.phase === 'applying'
            ? <p className={css.hint}>{t('localRuntimeApplying')}</p>
            : runtimeSurfacePresent && runtimeState === null
              ? <p className={css.hint}>{t('localRuntimeHydrating')}</p>
              : runtimeState?.runtimeBlocked === true
                ? <p className={css.hint}>{runtimeState.runtimeBlockedReason ?? t('localRuntimeBlocked')}</p>
                : null}
          <PluginDiagnosticLine diagnostic={pluginDiagnostics?.['local']} t={t} />
          <div className={css.logArea}>
            <div className={css.logHead}>
              <button
                type="button"
                className={css.logToggle}
                aria-expanded={hostLogsOpen}
                onClick={toggleHostLogs}
              >
                <IconChevronDownOutline14 className={clsx(css.logChevron, hostLogsOpen && css.logChevronOpen)} />
                <span className={css.logTitle}>{t('hostLogs')}</span>
                {hostLogs?.truncated === true ? <span className={css.logHint}>{t('logsTruncated')}</span> : null}
              </button>
              <button
                type="button"
                className={css.iconButton}
                data-tip={t('logsRefresh')}
                aria-label={t('logsRefresh')}
                onClick={() => { void loadHostLogs() }}
              >
                <IconRefreshOutline16 />
              </button>
            </div>
            {hostLogsOpen
              ? (hostLogsError !== null
                  ? <p className={css.error} role="alert">{hostLogsError}</p>
                  : hostLogs === null
                    ? <p className={css.dim}>{t('loading')}</p>
                    : hostLogs.lines.length === 0
                      ? <p className={css.dim}>{t('logsEmpty')}</p>
                      : (
                      <div className={css.logBox}>
                        {hostLogs.lines.map((entry, index) => (
                          <div key={index} className={css.logLine}>
                            <span className={css.logTs}>{formatTime(entry.ts)}</span>
                            <span className={clsx(css.logText, entry.stream === 'stderr' && css.logStderr)}>{entry.line}</span>
                          </div>
                        ))}
                      </div>
                    ))
              : null}
          </div>
        </div>
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('remoteTitle')}</h3>
        {rosterError !== null ? <p className={css.error} role="alert">{rosterError}</p> : null}
        {instances.length === 0
          ? (
            <>
              {rosterLoading
                ? <p className={css.dim}>{t('loading')}</p>
                : <p className={css.dim}>{t('hostsEmpty')}</p>}
              {creatorButton}
            </>
          )
          : (
            <ul className={css.cards}>
              {instances.map(spec => {
                // Registry and status pushes are independent. Suppress a
                // stale old-provider projection during a kind switch instead
                // of showing the replacement connection as falsely ready.
                const projectedStatus = statuses[spec.id]
                const status = projectedStatus?.kind === spec.kind ? projectedStatus : undefined
                const phase = status?.phase
                const connected = phase === 'ready' || phase === 'degraded'
                const specBusy = busy[spec.id] === true
                // Gateway runtime startability (design 21 §6.8 r1): the
                // tunnel phase proves the gateway HOST answers — the managed
                // dsh's own state comes from the runtime probe
                // (runtimeConnectionById). startBusy keeps the button
                // rendered while the per-card start is in flight.
                const runtimeConnectionState = runtimeConnectionById[spec.id]
                const runtimeStartable = runtimeConnectionState !== undefined
                  && STARTABLE_RUNTIME_STATES.has(runtimeConnectionState)
                const startBusy = startBusyIds[spec.id] === true
                const serviceActive = status?.serviceActive
                // systemd control rides the ssh transport (dsh or gateway
                // over a tunnel both exec systemctl over ssh); http direct
                // endpoints have no service channel.
                const serviceConfigured = spec.transport === 'ssh' && spec.serviceName !== null
                // 终态失败提示按类别选择（action-hint.ts）：endpoint 类意味着
                // SSH 隧道本身正常、问题在远端 dsh 实例——绝不展示 SSH 认证失败
                // 提示（误导性信息修复）。
                const hintKey = actionHintKey(spec, status, phase)
                // 本卡重启/启动结果行（null = 无）；tone 分流渲染（见下）。
                const restartNote = restartNotes[spec.id]
                return (
                  <li key={spec.id} className={css.card}>
                    <div className={css.cardHead}>
                      {/* 2026-12 两行化：身份行（名称 + 类型）与徽标行（状态 +
                          安全姿态）分开——单行 flex-wrap 在 268px 网格底线处
                          换行不可预测，名称会被挤压成省略号。 */}
                      <div className={css.cardHeadIdentity}>
                        <span className={css.cardName} title={spec.label}>{spec.label}</span>
                        <span className={css.kindBadge}>{spec.kind === 'gateway' ? t('kindGateway') : t('kindDsh')}</span>
                      </div>
                      <div className={css.cardHeadBadges}>
                        <span className={clsx(
                          css.badge,
                          (phase === 'error' || phase === 'degraded') && css.badgeBad,
                          phase === 'ready' && css.badgeOk,
                        )}>
                          {t(phaseKey(phase))}
                        </span>
                        {/* 诚实状态 (design 17 §13.1): the plaintext and no-auth
                            postures stay visible on the card after configuring.
                            「无认证」 only when NEITHER gateway credential is
                            stored — the passwordSet projection is the
                            authoritative SshInstanceSpec member (design 17
                            §9.1, desktop gateway-secrets task).
                            2026-12 配色修订：姿态徽标统一为「描边 + 彩色文字」
                            家族（.badgeWarn / .badgeSuccess），与状态徽标的
                            填充区分——同类姿态同族同色，不再按主观严重度分层；
                            顺序按维度：传输层（HTTP 明文）→ 认证层（无认证）
                            → 信任层（SPKI 已固定）。 */}
                        {spec.insecureHttp
                          ? <span className={clsx(css.badge, css.badgeWarn)}>{t('badgeHttpPlaintext')}</span>
                          : null}
                        {spec.kind === 'gateway' && spec.tokenSet === false
                          && spec.passwordSet === false
                          ? <span className={clsx(css.badge, css.badgeWarn)}>{t('badgeNoAuth')}</span>
                          : null}
                        {spec.kind === 'gateway' && spec.transport === 'http'
                          && !spec.insecureHttp && spec.spkiPin !== undefined
                          ? <span className={clsx(css.badge, css.badgeSuccess)}>{t('badgeSpkiPinned')}</span>
                          : null}
                      </div>
                    </div>
                    <div className={css.cardMeta}>
                      <code className={css.cardHost}>{spec.transport === 'http'
                        ? formatGatewayUrl(spec.host, spec.remotePort, spec.insecureHttp)
                        : `${spec.user !== null && spec.user !== '' ? `${spec.user}@` : ''}${spec.host}${spec.sshPort !== null ? `:${spec.sshPort}` : ''}`}</code>
                      {spec.transport === 'ssh'
                        ? <span className={css.mono}>{spec.kind === 'gateway' ? t('gatewayPort') : t('dshPort')}：{spec.remotePort}</span>
                        : null}
                      {status?.localPort !== null && status?.localPort !== undefined
                        ? <span className={css.mono}>{t('tunnelPort')}：{status.localPort}</span>
                        : null}
                    </div>
                    <code className={css.cardId}>{spec.id}</code>
                    {serviceConfigured
                      ? (
                        <span className={css.serviceLine}>
                          <IconChecklistOutline14 />
                          {spec.serviceName} · {serviceActive === true ? t('serviceOn') : serviceActive === false ? t('serviceOff') : t('serviceNone')}
                        </span>
                      )
                      : null}
                    {status?.logSummary !== '' ? <p className={css.hint}>{status?.logSummary}</p> : null}
                    {hintKey !== null ? <p className={css.hint}>{t(hintKey)}</p> : null}
                    {opError[spec.id] !== undefined ? <p className={css.error} role="alert">{opError[spec.id]}</p> : null}
                    {restartNote !== undefined && restartNote !== null
                      ? restartNote.tone === 'error'
                        ? <p className={css.error} role="alert">{restartNote.text}</p>
                        : <p className={css.hint} role="status">{restartNote.text}</p>
                      : null}
                    <PluginDiagnosticLine diagnostic={pluginDiagnostics?.[`${spec.kind}-${spec.id}`]} t={t} />
                    <Button
                      variant={connected ? 'outline' : 'primary'}
                      size="sm"
                      className={css.connectButton}
                      icon={connected ? <IconCloseOutline16 /> : <IconLinkOutline16 />}
                      disabled={specBusy || phase === 'connecting'}
                      onClick={() => { void runTunnelOp(spec.id, connected ? 'disconnect' : 'connect') }}
                    >
                      {connected ? t('disconnect') : phase === 'connecting' ? t('phaseConnecting') : t('connect')}
                    </Button>
                    {spec.kind === 'gateway' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className={css.restartTip}
                          // D8（plan 24）：删除 data-tip（restartManagedDshTip
                          // 用法移除）；aria-label 保留——busy/未连接时携带
                          // 禁用原因，常态回退可见标签（restartManagedDsh）。
                          aria-label={restartingIds[spec.id] === true ? t('restartManagedDshBusy') : !connected ? t('restartNotConnected') : t('restartManagedDsh')}
                          disabled={specBusy || !connected || restartingIds[spec.id] === true || startBusyIds[spec.id] === true}
                          onClick={() => { setRestartConfirmFor(spec) }}
                        >
                          {restartingIds[spec.id] === true ? t('restartManagedDshBusy') : t('restartManagedDsh')}
                        </Button>
                        {/* 「启动实例」（design 21 §6.8 r1）：托管 dsh 处于
                            stopped/error/restart-exhausted（runtime 探针投影）
                            且传输已连接时出现；在飞期间保持渲染（busy 标签）。 */}
                        {(runtimeStartable || startBusy) && (
                          <Button
                            variant="outline"
                            size="sm"
                            className={css.restartTip}
                            // aria 配对（P3）：同款规则——tip 存在（禁用原因）即
                            // 为 aria-label，否则回退可见标签（busy/常态）。
                            data-tip={!connected ? t('restartNotConnected') : undefined}
                            aria-label={!connected ? t('restartNotConnected') : startBusy ? t('startManagedDshBusy') : t('startManagedDsh')}
                            disabled={specBusy || !connected || startBusy || restartingIds[spec.id] === true}
                            onClick={() => { void startManagedDsh(spec) }}
                          >
                            {startBusy ? t('startManagedDshBusy') : t('startManagedDsh')}
                          </Button>
                        )}
                      </>
                    )}
                    {spec.transport === 'ssh' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className={css.restartTip}
                        disabled={specBusy || !serviceConfigured}
                        // aria 配对（P3）：同款规则——tip 存在（未配置原因 /
                        // gateway 的 systemd 重启说明）即为 aria-label，否则回退
                        // 可见标签（dsh 实例的「重启实例」）。
                        data-tip={!serviceConfigured ? t('serviceUnconfigured') : spec.kind === 'gateway' ? t('restartServiceTip') : undefined}
                        aria-label={!serviceConfigured ? t('serviceUnconfigured') : spec.kind === 'gateway' ? t('restartServiceTip') : t('restartInstance')}
                        onClick={() => { void runServiceOp(spec.id, 'restart_service') }}
                      >
                        {spec.kind === 'gateway' ? t('restartGatewayService') : t('restartInstance')}
                      </Button>
                      )}
                    <div className={css.cardFoot}>
                      {/* 插件入口对每个连接渲染，统一开 PluginDialog（plan 24
                          D5-A）：SSH 通道的 dsh 目标走 ssh 后端（desktopSsh 插
                          件表面）；gateway（任意传输）走 gateway 后端（/chamber
                          读面 + gateway IPC 写面，runtimeDown 门控恢复撤销面）；
                          http 直连 dsh 目标无执行表面，只读 Loader 清单。 */}
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={specBusy}
                        data-tip={t('pluginsOpen')}
                        aria-label={`${t('pluginsOpen')}: ${spec.label}`}
                        onClick={() => {
                          if (spec.transport === 'ssh' && spec.kind === 'dsh') {
                            setPluginDialogFor({ kind: 'ssh', spec })
                          } else if (spec.kind === 'gateway') {
                            setPluginDialogFor({ kind: 'gateway', sourceId: `${spec.kind}-${spec.id}`, label: spec.label })
                          } else {
                            setPluginDialogFor({ kind: 'http', sourceId: `${spec.kind}-${spec.id}`, label: spec.label })
                          }
                        }}
                      >
                        <IconFolderOpenOutline16 />
                      </button>
                      <span className={css.footSpacer} />
                      {spec.transport === 'ssh'
                        ? (
                          <>
                            <button
                              type="button"
                              className={css.iconButton}
                              disabled={!serviceConfigured || specBusy}
                              data-tip={!serviceConfigured ? t('serviceUnconfigured') : serviceActive === true ? t('serviceStop') : t('serviceStart')}
                              aria-label={!serviceConfigured ? t('serviceUnconfigured') : serviceActive === true ? t('serviceStop') : t('serviceStart')}
                              onClick={() => { void runServiceOp(spec.id, serviceActive === true ? 'stop_service' : 'start_service') }}
                            >
                              {serviceActive === true ? <IconStopFill16 /> : <IconPlayOutline16 />}
                            </button>
                            <button
                              type="button"
                              className={css.iconButton}
                              disabled={!serviceConfigured || specBusy}
                              data-tip={t('serviceCheck')}
                              aria-label={`${t('serviceCheck')}: ${spec.label}`}
                              onClick={() => { void runServiceOp(spec.id, 'is_active') }}
                            >
                              <IconRefreshOutline16 />
                            </button>
                          </>
                        )
                        : null}
                      {spec.kind === 'gateway'
                        ? (
                          <button
                            type="button"
                            className={css.iconButton}
                            disabled={specBusy}
                            data-tip={t('gatewayHostLogs')}
                            aria-label={`${t('gatewayHostLogs')}: ${spec.label}`}
                            onClick={() => { void openGatewayHostLogs(spec) }}
                          >
                            <IconDataOutline16 />
                          </button>
                        )
                        : null}
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={specBusy}
                        data-tip={t('logs')}
                        aria-label={`${t('logs')}: ${spec.label}`}
                        onClick={() => { void openLogs(spec) }}
                      >
                        <IconSearchOutline16 />
                      </button>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={specBusy}
                        data-tip={t('edit')}
                        aria-label={`${t('edit')}: ${spec.label}`}
                        onClick={() => { openEdit(spec) }}
                      >
                        <IconEditOutline16 />
                      </button>
                      <button
                        type="button"
                        className={`${css.iconButton} ${css.iconDanger}`}
                        disabled={specBusy}
                        data-tip={t('delete')}
                        aria-label={`${t('delete')}: ${spec.label}`}
                        onClick={() => { setPendingDelete(spec) }}
                      >
                        <IconTrashOutline16 />
                      </button>
                    </div>
                  </li>
                )
              })}
              {/* 虚线添加入口：网格的最后一个单元格（与卡片同宽）。 */}
              <li className={css.creatorCell}>{creatorButton}</li>
            </ul>
          )}
      </section>

      <Modal
        open={stopConfirm}
        onClose={() => { if (!stopping) setStopConfirm(false) }}
        title={t('localStopTitle')}
        closeLabel={t('close')}
        description={t('localStopDescription')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={stopping} onClick={() => { setStopConfirm(false) }}>
              {t('cancel')}
            </Button>
            <Button variant="outline" className={css.deleteConfirm} disabled={stopping} onClick={() => { void stopLocal() }}>
              {stopping ? t('stopping') : t('stopConfirm')}
            </Button>
          </>
        )}
      />

      {/* 受控重启 gateway 托管的 dsh（design 21 §5.1）：确认含多用户中断文案；
          运行期间保持弹窗 + busy 标签（与 stopConfirm 同款模态纪律）。忙碌判定
          只看本 Modal 的目标卡（restartConfirmBusy）：他卡在飞不锁本卡确认，
          本卡收尾也只关本卡 Modal —— 每卡独立单飞。 */}
      <Modal
        open={restartConfirmFor !== null}
        onClose={() => { if (!restartConfirmBusy) setRestartConfirmFor(null) }}
        title={t('restartManagedDshConfirmTitle')}
        closeLabel={t('close')}
        description={t('restartManagedDshConfirmDescription')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={restartConfirmBusy} onClick={() => { setRestartConfirmFor(null) }}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={restartConfirmBusy}
              onClick={() => { if (restartConfirmFor !== null) void restartManagedDsh(restartConfirmFor) }}
            >
              {restartConfirmBusy ? t('restartManagedDshBusy') : t('restartManagedDsh')}
            </Button>
          </>
        )}
      />

      <Modal
        open={editing !== null}
        onClose={closeForm}
        title={editing === 'new' ? t('formAddTitle') : t('formEditTitle')}
        closeLabel={t('close')}
        className={css.dialog}
        contentClassName={css.dialogContent}
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={closeForm}>
              {t('cancel')}
            </Button>
            <Button variant="outline" disabled={saving} onClick={() => { void saveDraft() }}>
              {saving ? t('saving') : t('save')}
            </Button>
          </>
        )}
      >
        {draft === null
          ? null
          : (
            <div className={css.dialogFields}>
              {/* Target edit: the main-owned transaction refuses credential
                  reuse and requires each stored dimension independently;
                  warn before save (see validation). */}
              {(() => {
                const reentry = credentialReentryEdit(editing, draft)
                return reentry.sshPassword || reentry.gatewayToken || reentry.gatewayPassword
              })()
                ? <p className={clsx(css.warnHint, css.spanAll)} role="alert">{t('targetChangedHint')}</p>
                : null}
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('kindLabel')}</span>
                {/* 统一下拉箭头（2026-12）：与设置壳/运行时段同一图标词汇。 */}
                <span className={css.selectWrap}>
                  <select
                    className={clsx(css.input, css.selectArrow)}
                    value={draft.kind}
                    onChange={event => {
                      // Target and transport are independent dimensions. The
                      // pure helper preserves the selected transport, adjusts
                      // only still-defaulted ports, and clears transient values
                      // that belong to the old target.
                      setDraft(changeDraftKind(draft, event.target.value as TransportKind))
                      setFieldErrors({})
                      setFormError(null)
                    }}
                  >
                    <option value="dsh">{t('kindDsh')}</option>
                    <option value="gateway">{t('kindGateway')}</option>
                  </select>
                  <IconChevronDownOutline14 className={css.selectChevron} aria-hidden="true" />
                </span>
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('transportLabel')}</span>
                <span className={css.selectWrap}>
                  <select
                    className={clsx(css.input, css.selectArrow)}
                    value={draft.transport}
                    onChange={event => {
                      setDraft(changeDraftTransport(draft, event.target.value as TransportMethod))
                      setFieldErrors({})
                      setFormError(null)
                    }}
                  >
                    {TRANSPORT_FORM_OPTIONS
                      .filter(schema => schema.targetKinds.includes(draft.kind))
                      .map(schema => (
                        <option key={schema.method} value={schema.method}>
                          {t(schema.method === 'ssh' ? 'transportSsh' : 'transportHttp')}
                        </option>
                      ))}
                  </select>
                  <IconChevronDownOutline14 className={css.selectChevron} aria-hidden="true" />
                </span>
              </label>
              {editing === 'new' && draft.transport === 'ssh'
                ? (
                  <div className={clsx(css.configPicker, css.spanAll)}>
                    <div className={css.configHead}>
                      <span className={css.fieldLabel}>{t('configTitle')}</span>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={configLoading}
                        data-tip={t('logsRefresh')}
                        aria-label={t('logsRefresh')}
                        onClick={() => { void loadConfigHosts() }}
                      >
                        <IconRefreshOutline16 />
                      </button>
                    </div>
                    {configError !== null
                      ? <p className={css.error} role="alert">{configError}</p>
                      : configHosts === null
                        ? (configLoading ? <p className={css.dim}>{t('configLoading')}</p> : null)
                        : configHosts.length === 0
                          ? <p className={css.dim}>{t('configEmpty')}</p>
                          : (
                            <ul className={css.configList}>
                              {configHosts.map(host => (
                                <li key={host.alias}>
                                  <button
                                    type="button"
                                    className={css.configItem}
                                    onClick={() => { applyConfigHost(host) }}
                                  >
                                    <code className={css.configAlias}>{host.alias}</code>
                                    <span className={css.configMeta}>
                                      {host.user !== null ? `${host.user}@` : ''}{host.hostName}
                                      {host.port !== null ? ` · ${t('sshPort')} ${host.port}` : ''}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                  </div>
                )
                : null}
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('fieldId')}</span>
                <input
                  className={css.input}
                  value={draft.id}
                  disabled={editing !== 'new'}
                  autoFocus
                  maxLength={64}
                  spellCheck={false}
                  placeholder={t('fieldIdPlaceholder')}
                  onChange={event => { setDraft({ ...draft, id: event.target.value }) }}
                />
                {fieldErrors.id === undefined ? null : <span className={css.error} role="alert">{fieldErrors.id}</span>}
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('fieldLabel')}</span>
                <input
                  className={css.input}
                  value={draft.label}
                  maxLength={128}
                  spellCheck={false}
                  placeholder={t('fieldLabelPlaceholder')}
                  onChange={event => { setDraft({ ...draft, label: event.target.value }) }}
                />
                {fieldErrors.label === undefined ? null : <span className={css.error} role="alert">{fieldErrors.label}</span>}
              </label>
              {transportFormSchema(draft.transport).fieldGroup === 'url'
                ? (
                  <>
                    <label className={clsx(css.field, css.spanAll)}>
                      <span className={css.fieldLabel}>{t('fieldDirectUrl')}</span>
                      <input
                        className={css.input}
                        value={draft.gatewayUrl}
                        inputMode="url"
                        autoComplete="url"
                        spellCheck={false}
                        placeholder={t(draft.kind === 'gateway' ? 'fieldGatewayUrlPlaceholder' : 'fieldDshUrlPlaceholder')}
                        onChange={event => { setDraft(changeDraftEndpointUrl(draft, event.target.value)) }}
                      />
                      {fieldErrors.gatewayUrl === undefined ? null : <span className={css.error} role="alert">{fieldErrors.gatewayUrl}</span>}
                      {/* 非拦截安全姿态提示 (design 17 §13.1 S21)：http 明文是
                          显式用户决策，如实注明、绝不前置拦截。 */}
                      {/^http:\/\//i.test(draft.gatewayUrl.trim())
                        ? <span className={css.warnHint}>{t('gatewayUrlHttpHint')}</span>
                        : null}
                    </label>
                    {spkiPinEligible(draft)
                      ? (
                        <div className={css.spanAll}>
                          <GatewaySpkiField
                            draft={draft}
                            fieldError={fieldErrors.spkiPin}
                            fieldId={spkiFieldId}
                            onChange={spkiPin => { setDraft({ ...draft, spkiPin }) }}
                            t={t}
                          />
                        </div>
                      )
                      : null}
                    {/* Gateway authentication is target-owned and works over
                        both transports. dsh+http deliberately has no auth or
                        SPKI surface. */}
                    {draft.kind === 'gateway'
                      ? (
                        <div className={css.spanContents}>
                          <GatewayAuthFields
                            draft={draft}
                            onChange={patch => { setDraft(prev => (prev === null ? prev : { ...prev, ...patch })) }}
                            fieldErrors={fieldErrors}
                            editing={editing}
                            targetChanged={credentialReentryEdit(editing, draft).gatewayToken || credentialReentryEdit(editing, draft).gatewayPassword}
                            onClearToken={() => { void clearGatewayToken() }}
                            onClearPassword={() => { void clearGatewayPassword() }}
                            tokenFieldId={gatewayTokenFieldId}
                            passwordFieldId={gatewayPasswordFieldId}
                            t={t}
                          />
                        </div>
                      )
                      : null}
                  </>
                )
                : (
                  <>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldHost')}</span>
                      <input
                        className={css.input}
                        value={draft.host}
                        spellCheck={false}
                        placeholder={t('fieldHostPlaceholder')}
                        onChange={event => { setDraft({ ...draft, host: event.target.value }) }}
                      />
                      {fieldErrors.host === undefined ? null : <span className={css.error} role="alert">{fieldErrors.host}</span>}
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldUser')}</span>
                      <input
                        className={css.input}
                        value={draft.user}
                        spellCheck={false}
                        placeholder={t('fieldUserPlaceholder')}
                        onChange={event => { setDraft({ ...draft, user: event.target.value }) }}
                      />
                      {fieldErrors.user === undefined ? null : <span className={css.error} role="alert">{fieldErrors.user}</span>}
                    </label>
                    {/* SSH transport authentication is independent of target
                        authentication. gateway+ssh therefore renders this
                        field AND the GatewayAuthFields below.
                        2026-12 复审（HTML 规范）：清除按钮与输入框同处
                        label 会污染输入框可访问名称——外层改 div。 */}
                    <div className={clsx(css.field, css.spanAll)}>
                      <span className={css.fieldLabelRow}>
                        <label className={css.fieldLabel} htmlFor={sshPasswordFieldId}>{t('fieldPassword')}</label>
                        {editing !== null && editing !== 'new' && editing.transport === 'ssh'
                          ? (
                            <button
                              type="button"
                              className={css.clearPassword}
                              onClick={() => { void clearPassword() }}
                            >
                              {t('passwordClear')}
                            </button>
                          )
                          : null}
                      </span>
                      <input
                        id={sshPasswordFieldId}
                        className={css.input}
                        type="password"
                        value={draft.password}
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={t('fieldPasswordPlaceholder')}
                        onChange={event => { setDraft({ ...draft, password: event.target.value }) }}
                      />
                      {fieldErrors.password === undefined ? null : <span className={css.error} role="alert">{fieldErrors.password}</span>}
                      <span className={css.dim}>{t('passwordHint')}</span>
                    </div>
                    {draft.kind === 'gateway'
                      ? (
                        <div className={css.spanContents}>
                          <GatewayAuthFields
                            draft={draft}
                            onChange={patch => { setDraft(prev => (prev === null ? prev : { ...prev, ...patch })) }}
                            fieldErrors={fieldErrors}
                            editing={editing}
                            targetChanged={credentialReentryEdit(editing, draft).gatewayToken || credentialReentryEdit(editing, draft).gatewayPassword}
                            onClearToken={() => { void clearGatewayToken() }}
                            onClearPassword={() => { void clearGatewayPassword() }}
                            tokenFieldId={gatewayTokenFieldId}
                            passwordFieldId={gatewayPasswordFieldId}
                            t={t}
                          />
                        </div>
                      )
                      : null}
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldSshPort')}</span>
                      <input
                        className={css.input}
                        value={draft.sshPort}
                        inputMode="numeric"
                        spellCheck={false}
                        placeholder={t('fieldSshPortPlaceholder')}
                        onChange={event => { setDraft({ ...draft, sshPort: event.target.value }) }}
                      />
                      {fieldErrors.sshPort === undefined ? null : <span className={css.error} role="alert">{fieldErrors.sshPort}</span>}
                    </label>
                    <label className={css.field}>
                      {/* The ssh remote port label/placeholder follows the
                          TARGET kind (P3-2): dsh listens on 30800, a gateway
                          on 30801 next to it. */}
                      <span className={css.fieldLabel}>{draft.kind === 'gateway' ? t('gatewayPort') : t('fieldRemotePort')}</span>
                      <input
                        className={css.input}
                        value={draft.remotePort}
                        inputMode="numeric"
                        spellCheck={false}
                        placeholder={draft.kind === 'gateway' ? t('fieldGatewayRemotePortPlaceholder') : t('fieldRemotePortPlaceholder')}
                        onChange={event => { setDraft({ ...draft, remotePort: event.target.value }) }}
                      />
                      {fieldErrors.remotePort === undefined ? null : <span className={css.error} role="alert">{fieldErrors.remotePort}</span>}
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldServiceName')}</span>
                      <input
                        className={css.input}
                        value={draft.serviceName}
                        spellCheck={false}
                        placeholder={t('fieldServiceNamePlaceholder')}
                        onChange={event => { setDraft({ ...draft, serviceName: event.target.value }) }}
                      />
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldRemoteDshHome')}</span>
                      <input
                        className={css.input}
                        value={draft.remoteDshHome}
                        spellCheck={false}
                        placeholder={t('fieldRemoteDshHomePlaceholder')}
                        onChange={event => { setDraft({ ...draft, remoteDshHome: event.target.value }) }}
                      />
                      {fieldErrors.remoteDshHome === undefined ? null : <span className={css.error} role="alert">{fieldErrors.remoteDshHome}</span>}
                    </label>
                  </>
                )}
              {formError === null ? null : <p className={clsx(css.error, css.spanAll)} role="alert">{formError}</p>}
            </div>
          )}
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onClose={() => { if (!deleting) setPendingDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={t('deleteDescription')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={() => { setPendingDelete(null) }}>
              {t('cancel')}
            </Button>
            <Button variant="outline" className={css.deleteConfirm} disabled={deleting} onClick={() => { void removeInstance() }}>
              {deleting ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      >
        {pendingDelete !== null && opError[pendingDelete.id] !== undefined
          ? <p className={css.error} role="alert">{opError[pendingDelete.id]}</p>
          : null}
      </Modal>

      <Modal
        open={logsFor !== null}
        onClose={() => { logsTargetRef.current = null; setLogsFor(null) }}
        title={logsFor === null ? '' : `${t('logs')} · ${logsFor.label}`}
        closeLabel={t('close')}
        className={css.dialog}
        footer={(
          <>
            <Button variant="ghost" icon={<IconRefreshOutline16 />} disabled={logsBusy} onClick={() => { void refreshLogs() }}>
              {t('logsRefresh')}
            </Button>
            <Button
              variant="ghost"
              disabled={logsBusy || remoteLogs.length === 0}
              onClick={() => { if (confirmClear) void clearLogs(); else setConfirmClear(true) }}
            >
              {confirmClear ? t('logsClearConfirm') : t('logsClear')}
            </Button>
            <Button variant="outline" onClick={() => { setLogsFor(null) }}>
              {t('close')}
            </Button>
          </>
        )}
      >
        <p className={css.hint}>{t('logsModalHint')}</p>
        {remoteLogsError !== null
          ? <p className={css.error} role="alert">{remoteLogsError}</p>
          : remoteLogs.length === 0
            ? <p className={css.dim}>{t('logsEmpty')}</p>
            : (
              <div className={css.logBox}>
                {remoteLogs.map((entry, index) => (
                  <div key={index} className={css.logLine}>
                    <span className={css.logTs}>{formatTime(entry.ts)}</span>
                    <span className={clsx(css.logText, entry.level === 'error' && css.logStderr, entry.level === 'warn' && css.logWarn)}>
                      {entry.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
      </Modal>

      <Modal
        open={gatewayLogsFor !== null}
        onClose={() => { gatewayLogsTargetRef.current = null; setGatewayLogsFor(null) }}
        title={gatewayLogsFor === null ? '' : `${t('gatewayHostLogs')} · ${gatewayLogsFor.label}`}
        closeLabel={t('close')}
        className={css.dialog}
        footer={(
          <>
            <Button variant="ghost" icon={<IconRefreshOutline16 />} disabled={gatewayHostLogsBusy} onClick={() => { void refreshGatewayHostLogs() }}>
              {t('logsRefresh')}
            </Button>
            {/* Footer close clears the stale-guard ref exactly like onClose —
                a late gatewayHostLogs response must never repaint a closed
                modal (review symmetry fix). */}
            <Button variant="outline" onClick={() => { gatewayLogsTargetRef.current = null; setGatewayLogsFor(null) }}>
              {t('close')}
            </Button>
          </>
        )}
      >
        <p className={css.hint}>{t('gatewayHostLogsModalHint')}</p>
        {gatewayHostLogsError !== null
          ? <p className={css.error} role="alert">{gatewayHostLogsError}</p>
          : gatewayHostLogs === null
            ? <p className={css.dim}>{gatewayHostLogsBusy ? t('loading') : t('logsEmpty')}</p>
            : gatewayHostLogs.lines.length === 0
              ? <p className={css.dim}>{t('logsEmpty')}</p>
              : (
                <div className={css.logBox}>
                  {gatewayHostLogs.lines.map((entry, index) => (
                    <div key={index} className={css.logLine}>
                      <span className={css.logTs}>{formatTime(entry.ts)}</span>
                      <span className={clsx(css.logText, entry.stream === 'stderr' && css.logStderr)}>{entry.line}</span>
                    </div>
                  ))}
                </div>
              )}
      </Modal>

      {pluginDialogFor !== null
        ? (() => {
          // Diagnostic key: 'local' | '<kind>-<id>'; for ssh targets the
          // registry key is the SPEC kind ('dsh'), not the dialog target
          // kind; for gateway/http the target sourceId IS '<kind>-<id>' already.
          const sourceKey = pluginDialogFor.kind === 'local'
            ? 'local'
            : pluginDialogFor.kind === 'ssh'
              ? `${pluginDialogFor.spec.kind}-${pluginDialogFor.spec.id}`
              : pluginDialogFor.sourceId
          // Gateway recovery gate (plan 24 B1.6): the card's existing
          // runtime projection (runtimeConnectionById, stopped/error/
          // restart-exhausted) becomes the dialog's runtimeDown signal.
          const runtimeDown = pluginDialogFor.kind === 'gateway'
            ? (() => {
              const rawId = pluginDialogFor.sourceId.slice('gateway-'.length)
              const state = runtimeConnectionById[rawId]
              return state !== undefined && STARTABLE_RUNTIME_STATES.has(state)
            })()
            : undefined
          return (
            <PluginDialog
              t={t}
              target={pluginDialogFor}
              diagnostic={pluginDiagnostics?.[sourceKey]}
              runtimeDown={runtimeDown}
              onClose={() => { setPluginDialogFor(null) }}
              onRecheckDiagnostic={onRecheckDiagnostic === undefined
                ? undefined
                : () => onRecheckDiagnostic(sourceKey)}
            />
          )
        })()
        : null}
    </div>
  )
}
