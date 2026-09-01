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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconChecklistOutline14,
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconDataOutline16,
  IconEditOutline16,
  IconLinkOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconStopFill16,
  IconTrashOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  DesktopSshSurface, SshConfigDiscovery, SshConfigHost, SshInstanceSpec, SshLogEntry, SshPhase, SshStatusProjection, TransportKind, TransportMethod,
} from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { cp, type ConnectionSummary, type HealthResponse, type HostLogsResponse } from './control-plane.ts'
import { PluginSyncModal } from './PluginSyncModal.tsx'
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
/**
 * Client-plugin runtime-loading diagnostic for one instance (design 09),
 * projected from the renderer chamberBridge aggregate. The connections page
 * owns this display — it is a chamber runtime fact, not an official dsh
 * plugin-setting fact.
 */
export interface PluginDiagnostic {
  state: 'ok' | 'not-injected' | 'graph-unreachable' | 'bundle-load-failed' | 'restart-required' | 'instance-version-conflict'
  message?: string
  pluginId?: string
}

/** Full component props. */
export type ConnectionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dsh-chamber.settings.connections'>
  & InjectFace<ConnectionsSectionInjected>
  & {
    /** Per-instance diagnostics keyed by source id ('local' | '<kind>-<id>'); optional outside the chamber shell. */
    pluginDiagnostics?: Readonly<Record<string, PluginDiagnostic | undefined>>
  }

/** Host-log page size (04 §3.3: default 200, cap 1000). */
const HOST_LOG_LIMIT = 200
const MIN_GATEWAY_TOKEN_CHARS = 32

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

/** Localized text for a client-plugin diagnostic state (design 09). */
function pluginDiagnosticText(state: PluginDiagnostic['state'], t: (key: SettingsConnectionsKey) => string): string {
  switch (state) {
    case 'ok': return t('pluginDiagnosticOk')
    case 'not-injected': return t('pluginDiagnosticNotInjected')
    case 'graph-unreachable': return t('pluginDiagnosticGraphUnreachable')
    case 'bundle-load-failed': return t('pluginDiagnosticBundleFailed')
    case 'instance-version-conflict': return t('pluginDiagnosticInstanceVersionConflict')
    default: return t('pluginDiagnosticRestartRequired')
  }
}

/**
 * One instance's client-plugin runtime diagnostic line. The diagnostic is a
 * chamber-owned fact (design 09) surfaced on the chamber-global connections
 * page — never on top of the official dsh「插件」settings section.
 */
function PluginDiagnosticLine({ diagnostic, t }: {
  diagnostic: PluginDiagnostic | undefined
  t: (key: SettingsConnectionsKey) => string
}): ReactNode {
  if (diagnostic === undefined) return null
  const problem = diagnostic.state !== 'ok'
  return (
    <p
      className={clsx(css.pluginDiagnostic, problem ? css.pluginDiagnosticProblem : css.pluginDiagnosticOk)}
      role="status"
    >
      <strong>{t('pluginDiagnosticLabel')}：{pluginDiagnosticText(diagnostic.state, t)}</strong>
      {diagnostic.pluginId !== undefined && <span>{diagnostic.pluginId}</span>}
      {diagnostic.message !== undefined && <span>{diagnostic.message}</span>}
    </p>
  )
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
function GatewayAuthFields({ draft, onChange, fieldErrors, editing, targetChanged, onClearToken, onClearPassword, t }: {
  draft: HostDraft
  onChange: (patch: Partial<HostDraft>) => void
  fieldErrors: Partial<Record<keyof HostDraft, string>>
  editing: SshInstanceSpec | 'new' | null
  /** True while editing a row whose transport target changed (P2/P3-1). */
  targetChanged: boolean
  onClearToken: () => void
  onClearPassword: () => void
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
      <label className={css.field}>
        <span className={css.fieldLabelRow}>
          <span className={css.fieldLabel}>{t('fieldGatewayToken')}</span>
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
      </label>
      <label className={css.field}>
        <span className={css.fieldLabelRow}>
          <span className={css.fieldLabel}>{t('fieldGatewayPassword')}</span>
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
      </label>
      <span className={clsx(css.dim, css.spanAll)}>{hint}</span>
    </>
  )
}

/** Optional S23 certificate pin. Unlike credentials this is non-secret
 * registry metadata, so edit prefill and ordinary input binding are required
 * to preserve it. The caller renders this only for gateway+http+https. */
function GatewaySpkiField({ draft, onChange, fieldError, t }: {
  draft: HostDraft
  onChange: (spkiPin: string) => void
  fieldError: string | undefined
  t: (key: SettingsConnectionsKey) => string
}): ReactNode {
  return (
    <label className={css.field}>
      <span className={css.fieldLabelRow}>
        <span className={css.fieldLabel}>{t('fieldSpkiPin')}</span>
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
    </label>
  )
}

/**
 * Render the connections section content column.
 * @param props - composed slot props.
 * @returns the section.
 */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode {
  const { t, pluginDiagnostics } = props
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
  /** 插件管理对话框：'local' = 本地实例，否则为远程主机 spec。 */
  const [pluginFor, setPluginFor] = useState<SshInstanceSpec | 'local' | null>(null)

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
        setOpError(prev => ({ ...prev, [pendingDelete.id]: '删除未生效：主进程拒绝了该变更（连接状态变化或状态目录不可写？）' }))
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

  const dsh = health?.dsh
  const healthy = dsh?.status === 'ready' || dsh?.status === 'degraded'
  const starting = dsh?.status === 'starting' || dsh?.status === 'restarting'

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
                onClick={() => { setPluginFor('local') }}
              >
                <IconChecklistOutline14 />
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
                const serviceActive = status?.serviceActive
                // systemd control rides the ssh transport (dsh or gateway
                // over a tunnel both exec systemctl over ssh); http direct
                // endpoints have no service channel.
                const serviceConfigured = spec.transport === 'ssh' && spec.serviceName !== null
                // 终态失败提示按类别选择（action-hint.ts）：endpoint 类意味着
                // SSH 隧道本身正常、问题在远端 dsh 实例——绝不展示 SSH 认证失败
                // 提示（误导性信息修复）。
                const hintKey = actionHintKey(spec, status, phase)
                return (
                  <li key={spec.id} className={css.card}>
                    <div className={css.cardHead}>
                      <span className={css.cardName} title={spec.label}>{spec.label}</span>
                      <span className={css.kindBadge}>{spec.kind === 'gateway' ? t('kindGateway') : t('kindDsh')}</span>
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
                          §9.1, desktop gateway-secrets task). */}
                      {spec.insecureHttp
                        ? <span className={clsx(css.badge, css.badgeBad)}>{t('badgeHttpPlaintext')}</span>
                        : null}
                      {spec.kind === 'gateway' && spec.tokenSet === false
                        && spec.passwordSet === false
                        ? <span className={css.badge}>{t('badgeNoAuth')}</span>
                        : null}
                      {spec.kind === 'gateway' && spec.transport === 'http'
                        && !spec.insecureHttp && spec.spkiPin !== undefined
                        ? <span className={clsx(css.badge, css.badgeOk)}>{t('badgeSpkiPinned')}</span>
                        : null}
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
                    {spec.transport === 'ssh' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className={css.restartTip}
                        disabled={specBusy || !serviceConfigured}
                        data-tip={!serviceConfigured ? t('serviceUnconfigured') : undefined}
                        onClick={() => { void runServiceOp(spec.id, 'restart_service') }}
                      >
                        {t('restartInstance')}
                      </Button>
                    )}
                    <div className={css.cardFoot}>
                      {spec.transport === 'ssh'
                        ? (
                          <button
                            type="button"
                            className={css.iconButton}
                            disabled={specBusy}
                            data-tip={t('pluginsOpen')}
                            aria-label={`${t('pluginsOpen')}: ${spec.label}`}
                            onClick={() => { setPluginFor(spec) }}
                          >
                            <IconChecklistOutline14 />
                          </button>
                        )
                        : null}
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
                            data-tip={t('hostLogs')}
                            aria-label={`${t('hostLogs')}: ${spec.label}`}
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
                        <IconChecklistOutline14 />
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
                <select
                  className={css.input}
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
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('transportLabel')}</span>
                <select
                  className={css.input}
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
                        field AND the GatewayAuthFields below. */}
                    <label className={clsx(css.field, css.spanAll)}>
                      <span className={css.fieldLabelRow}>
                        <span className={css.fieldLabel}>{t('fieldPassword')}</span>
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
                    </label>
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
        title={gatewayLogsFor === null ? '' : `${t('hostLogs')} · ${gatewayLogsFor.label}`}
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

      {pluginFor !== null
        ? <PluginSyncModal
            t={t}
            spec={pluginFor === 'local' ? null : pluginFor}
            onClose={() => { setPluginFor(null) }}
          />
        : null}
    </div>
  )
}
