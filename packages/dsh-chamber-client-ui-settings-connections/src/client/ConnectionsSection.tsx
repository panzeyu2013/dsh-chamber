/**
 * Connections settings section (design 05 §5): the local instance card —
 * /health status, the /api/connections row, graceful stop behind a confirm,
 * and the host rolling log — beside the remote host roster: registry CRUD
 * (non-secret metadata only), connect/disconnect over the tunnel IPC, and
 * on-demand systemd control plus the ring-buffer logs.
 *
 * Everything rides page-level surfaces: window.dshChamber.desktopSsh (IPC,
 * 05 §7.4) and the control-plane REST client (05 §7.2). No host frames and
 * no dsh runtime objects are consumed. SSH authentication defaults to the
 * system ssh-agent and default keys; an optional per-host password (design
 * 05 §8) is forwarded to the main process, which holds it in memory and
 * mirrors it to an owner-readable file (plaintext-file fallback, user
 * decision 2026-08) so auto-connect works after restart — the form itself
 * never logs it, and the field is never prefilled (the stored value never
 * returns to the renderer).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconChecklistOutline14,
  IconChevronDownOutline14,
  IconCloseOutline16,
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
  DesktopSshSurface, SshConfigDiscovery, SshConfigHost, SshInstanceInput, SshInstanceSpec, SshLogEntry, SshPhase, SshStatusProjection,
} from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { cp, type ConnectionSummary, type HealthResponse, type HostLogsResponse } from './control-plane.ts'
import { PluginSyncModal } from './PluginSyncModal.tsx'
import css from './ConnectionsSection.module.css'

/** Registration-side business face for the connections section. */
export interface ConnectionsSectionInjected {
  /** Bound translate over the section's own dictionary namespace. */
  t: (key: SettingsConnectionsKey) => string
}

/** Full component props. */
export type ConnectionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dsh-chamber.settings.connections'>
  & InjectFace<ConnectionsSectionInjected>

/** Host-log page size (04 §3.3: default 200, cap 1000). */
const HOST_LOG_LIMIT = 200

/** Local-card connection-row poll cadence: 状态由 /api/host/health-events
 * 推送（05 §3），此处只兜底行字段（label/dshPort）与流异常收敛。 */
const LOCAL_ROW_POLL_MS = 30_000

/**
 * The add/edit form draft; every field starts as text (ports validated on
 * save). sshPort empty = ssh default (port 22 or the host's ~/.ssh/config
 * Port); remotePort is the remote dsh web profile port on 127.0.0.1.
 * `password` (design 05 §8) is NEVER sent to the registry (instances_set is
 * metadata-only) — it is forwarded to the main process over set_password,
 * held in memory there, and never prefilled on edit.
 */
interface HostDraft {
  id: string
  label: string
  host: string
  user: string
  sshPort: string
  remotePort: string
  serviceName: string
  remoteDshHome: string
  password: string
}

const EMPTY_DRAFT: HostDraft = { id: '', label: '', host: '', user: '', sshPort: '', remotePort: '30800', serviceName: '', remoteDshHome: '', password: '' }

/** Slugify a ~/.ssh/config alias into the id whitelist (^[a-zA-Z0-9_-]+$). */
function slugifyAlias(alias: string): string {
  return alias.toLowerCase().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
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
 * Render the connections section content column.
 * @param props - composed slot props.
 * @returns the section.
 */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode {
  const { t } = props

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
  // Whether the remote roster is mid-load (first paint / refresh).
  const [rosterLoading, setRosterLoading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SshInstanceSpec | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [logsFor, setLogsFor] = useState<SshInstanceSpec | null>(null)
  const [remoteLogs, setRemoteLogs] = useState<SshLogEntry[]>([])
  const [remoteLogsError, setRemoteLogsError] = useState<string | null>(null)
  const [logsBusy, setLogsBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
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
  }, [loadLocal])

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
  const runServiceOp = useCallback(async (id: string, op: 'start_service' | 'stop_service' | 'is_active'): Promise<void> => {
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

  const removeInstance = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || pendingDelete === null) return
    setDeleting(true)
    try {
      const next = instances.filter(instance => instance.id !== pendingDelete.id)
      // The main process is authoritative (it drops invalid entries loudly);
      // adopt its saved list instead of trusting the local filter.
      const saved = await bridge.instances_set(next)
      setInstances(saved)
      setPendingDelete(null)
      setStatuses(prev => {
        const copy = { ...prev }
        delete copy[pendingDelete.id]
        return copy
      })
      clearOpError(pendingDelete.id)
    } catch (err) {
      // 删除失败：卡片保留，错误留在卡片与弹窗内
      setOpError(prev => ({ ...prev, [pendingDelete.id]: errorMessage(err) }))
    } finally {
      setDeleting(false)
    }
  }, [instances, pendingDelete, clearOpError])

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
    setDraft({
      id: spec.id,
      label: spec.label,
      host: spec.host,
      user: spec.user ?? '',
      sshPort: spec.sshPort === null ? '' : String(spec.sshPort),
      remotePort: String(spec.remotePort),
      serviceName: spec.serviceName ?? '',
      remoteDshHome: spec.remoteDshHome ?? '',
      // The stored password lives in main-process memory only and is never
      // exposed back to the renderer — the field always starts empty.
      password: '',
    })
    setFieldErrors({})
    setFormError(null)
    setConfigHosts(null)
    setConfigError(null)
  }, [])

  /** 清除该主机在主进程内存中的密码（改用密钥/ssh-agent）。 */
  const clearPassword = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || editing === null || editing === 'new') return
    const result = await bridge.set_password(editing.id, null)
    if ('error' in result) {
      setFormError(result.error)
    } else {
      setDraft(prev => (prev === null ? prev : { ...prev, password: '' }))
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
   * ^[a-zA-Z0-9_.-]+$。
   */
  const validate = useCallback((value: HostDraft): Partial<Record<keyof HostDraft, string>> => {
    const errors: Partial<Record<keyof HostDraft, string>> = {}
    const id = value.id.trim()
    if (id === '') errors.id = t('validationIdRequired')
    else if (id === 'local') errors.id = t('validationIdReserved')
    else if (!/^[a-zA-Z0-9_-]+$/.test(id)) errors.id = t('validationIdInvalid')
    else if (editing === 'new' && instances.some(instance => instance.id === id)) errors.id = t('validationIdDuplicate')
    if (value.label.trim() === '') errors.label = t('validationLabelRequired')
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
    if (serviceName !== '' && !/^[a-zA-Z0-9_.-]+$/.test(serviceName)) errors.serviceName = t('validationServiceNameInvalid')
    const remoteDshHome = value.remoteDshHome.trim()
    if (remoteDshHome !== '' && !/^~?\/[a-zA-Z0-9._/-]+$/.test(remoteDshHome)) errors.remoteDshHome = t('validationRemoteDshHomeInvalid')
    return errors
  }, [editing, instances, t])

  /** 新增/编辑走 instances_set；编辑时 id 不可改（其余字段以表单为准）。 */
  const saveDraft = useCallback(async (): Promise<void> => {
    const bridge = ssh()
    if (bridge === null || draft === null || editing === null) return
    const errors = validate(draft)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    try {
      const input: SshInstanceInput = {
        id: draft.id.trim(),
        label: draft.label.trim(),
        host: draft.host.trim(),
        remotePort: Number(draft.remotePort),
      }
      if (draft.user.trim() !== '') input.user = draft.user.trim()
      if (draft.sshPort.trim() !== '') input.sshPort = Number(draft.sshPort)
      if (draft.serviceName.trim() !== '') input.serviceName = draft.serviceName.trim()
      if (draft.remoteDshHome.trim() !== '') input.remoteDshHome = draft.remoteDshHome.trim()
      const next = editing === 'new'
        ? [...instances, input]
        : instances.map(instance => instance.id === editing.id ? { ...input, id: instance.id } : instance)
      const saved = await bridge.instances_set(next)
      setInstances(saved)
      // Password auth (design 05 §8): forward the form's TRANSIENT password
      // to the main process (held there in memory + plaintext mirror for
      // restart auto-connect; never in the registry above, never logged).
      // An empty field leaves any stored password untouched — a blind '' on
      // an unrelated field edit must not wipe a working password (the
      // explicit 清除密码 button is the clear path). A refused password
      // (e.g. unsupported platform) keeps the form open with the error so
      // the user sees why.
      const savedId = editing === 'new' ? input.id : editing.id
      if (draft.password !== '') {
        const passwordResult = await bridge.set_password(savedId, draft.password)
        if ('error' in passwordResult) {
          setFormError(passwordResult.error)
          return
        }
      }
      setEditing(null)
      setDraft(null)
      setFormError(null)
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [draft, editing, instances, t, validate])

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

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      {ssh() === null ? <p className={css.error} role="alert">{t('desktopOnly')}</p> : null}

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('localTitle')}</h3>
        <div className={css.localCard}>
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
          </div>
          {dsh?.error != null && dsh.error !== '' ? <p className={css.error}>{dsh.error}</p> : null}
          {localError !== null ? <p className={css.error} role="alert">{localError}</p> : null}
          <div className={css.localActions}>
            <Button
              variant="primary"
              size="sm"
              disabled={healthy || starting || localBusy || stopping}
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
            <span className={css.footSpacer} />
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
              data-tip={t('logsRefresh')}
              aria-label={t('logsRefresh')}
              onClick={() => { void loadLocal() }}
            >
              <IconRefreshOutline16 />
            </button>
          </div>
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
          ? (rosterLoading
            ? <p className={css.dim}>{t('loading')}</p>
            : <p className={css.dim}>{t('hostsEmpty')}</p>)
          : (
            <ul className={css.cards}>
              {instances.map(spec => {
                const status = statuses[spec.id]
                const phase = status?.phase
                const connected = phase === 'ready' || phase === 'degraded'
                const specBusy = busy[spec.id] === true
                const serviceActive = status?.serviceActive
                const serviceConfigured = spec.serviceName !== null
                return (
                  <li key={spec.id} className={css.card}>
                    <div className={css.cardHead}>
                      <span className={css.cardName} title={spec.label}>{spec.label}</span>
                      <span className={clsx(
                        css.badge,
                        (phase === 'error' || phase === 'degraded') && css.badgeBad,
                        phase === 'ready' && css.badgeOk,
                      )}>
                        {t(phaseKey(phase))}
                      </span>
                    </div>
                    <div className={css.cardMeta}>
                      <code className={css.cardHost}>
                        {spec.user !== null && spec.user !== '' ? `${spec.user}@` : ''}{spec.host}{spec.sshPort !== null ? `:${spec.sshPort}` : ''}
                      </code>
                      <span className={css.mono}>{t('dshPort')}：{spec.remotePort}</span>
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
                    {status?.requiresUserAction === true && (phase === 'error' || phase === 'degraded')
                      ? <p className={css.hint}>{t('authActionHint')}</p>
                      : null}
                    {opError[spec.id] !== undefined ? <p className={css.error} role="alert">{opError[spec.id]}</p> : null}
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
                    <div className={css.cardFoot}>
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
                      <span className={css.footSpacer} />
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
            </ul>
          )}
        <button type="button" className={css.creatorButton} onClick={openAdd}>
          <IconPlusOutline16 size={14} />
          {t('addHost')}
        </button>
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
            <Button disabled={saving} onClick={() => { void saveDraft() }}>
              {saving ? t('saving') : t('save')}
            </Button>
          </>
        )}
      >
        {draft === null
          ? null
          : (
            <div className={css.dialogFields}>
              {editing === 'new'
                ? (
                  <div className={css.configPicker}>
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
                  spellCheck={false}
                  placeholder={t('fieldLabelPlaceholder')}
                  onChange={event => { setDraft({ ...draft, label: event.target.value }) }}
                />
                {fieldErrors.label === undefined ? null : <span className={css.error} role="alert">{fieldErrors.label}</span>}
              </label>
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
              <label className={css.field}>
                <span className={css.fieldLabelRow}>
                  <span className={css.fieldLabel}>{t('fieldPassword')}</span>
                  {editing !== 'new'
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
                <span className={css.dim}>{t('passwordHint')}</span>
              </label>
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
                <span className={css.fieldLabel}>{t('fieldRemotePort')}</span>
                <input
                  className={css.input}
                  value={draft.remotePort}
                  inputMode="numeric"
                  spellCheck={false}
                  placeholder={t('fieldRemotePortPlaceholder')}
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
              {formError === null ? null : <p className={css.error} role="alert">{formError}</p>}
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
