/**
 * Connections settings section (design 05 §5): the local instance card (/health
 * status, /api/connections row, graceful stop behind a confirm, host rolling log)
 * beside the remote connection roster: registry CRUD (non-secret metadata only),
 * connect/disconnect over the transport IPC, SSH-only systemd control and logs.
 * Everything rides page-level surfaces (window.dshChamber.desktopSsh IPC and the
 * control-plane REST client); no host frames, no dsh runtime objects.
 * Credentials are write-only and main-process-owned: an optional per-host SSH
 * password, the gateway shared token and login password live in main memory and an
 * owner-readable mirror (plaintext fallback) so auto-connect works after restart —
 * the form never logs or prefills them, they never enter the registry and never
 * return to the renderer.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconChecklistOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  IconDataOutlineRegular,
  IconEditOutlineRegular,
  IconLinkOutlineRegular,
  IconPlayOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconStopFillRegular,
  IconTrashOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Page-owned restart→reload completion: a restarted source's client-plugin set only
// changes on a window boot, so every restart-to-apply entry point arms it.
import {
  RESTART_RELOAD_BUDGET_MS,
  armLocalDshRestartCompletion,
  armWindowReloadWhenServed,
  pollGatewayReady,
  waitForSourceServing,
} from '@dsh-chamber/dsh-chamber-client-core'
import type {
  DesktopSshSurface, SshConfigDiscovery, SshConfigHost, SshInstanceSpec, SshLogEntry, SshStatusProjection,
} from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import type { LocalWriterDiagnosisWire } from '@dsh-chamber/dsh-chamber-client-core'
import { writerNotice, writerReasonKey } from './writer-diagnosis.ts'
import { ConnectionFormModal } from './ConnectionFormModal.tsx'
import { PluginManageIcon16 } from './ConnectionAuthFields.tsx'
import { credentialReentryEdit, formatTime, gatewayUrlErrorText, localStatusKey, phaseKey, slugifyAlias } from './connection-helpers.ts'
import { errorMessage } from './error-text.ts'
import { CLEAR_GATEWAY_PASSWORD, CLEAR_GATEWAY_TOKEN, CLEAR_SSH_PASSWORD, clearCredential } from './clear-credential.ts'
import { runManagedRestart } from './restart-action.ts'
// The desktop-gate mirrors (and their byte-parity test) are the ONE copy of these
// patterns/limits: the form validates with them, never weaker inline regexes.
import {
  INSTANCE_ID_PATTERN,
  MAX_INSTANCE_LABEL_CHARS,
  MAX_REMOTE_DSH_HOME_CHARS,
  MAX_SERVICE_NAME_CHARS,
  MAX_SSH_HOST_CHARS,
  MAX_SSH_PASSWORD_CHARS,
  MAX_SSH_USER_CHARS,
  REMOTE_DSH_HOME_PATTERN,
  SSH_HOST_PATTERN,
  SSH_USER_PATTERN,
} from './host-validation.ts'
import { localSpawnGate } from './local-spawn-gate.ts'
import { cp, type ConnectionSummary, type HealthResponse, type HostLogsResponse } from './control-plane.ts'
import {
  applyRuntimeProbe,
  classifyRestartError,
  runtimeBlocksRestart,
  runtimeRefusalText,
  type RuntimeRefusalKey,
} from './managed-restart.ts'
import { PluginDialog, type PluginDialogTarget } from './PluginDialog.tsx'
import { PluginDiagnosticLine } from './plugin-diagnostic.tsx'
import type { PluginDiagnostic, ServerBootGap } from './plugin-diagnostic.ts'
import { formatGatewayUrl, parseGatewayUrl } from './gateway-url.ts'
import { actionHintKey } from './action-hint.ts'
import {
  draftFromSpec,
  draftToInput,
  EMPTY_DRAFT,
  SERVICE_NAME_PATTERN,
  spkiPinEligible,
  spkiPinValidationError,
  transportFormSchema,
  type HostDraft,
} from './connection-form.ts'
import {
  gatewayPasswordValidationError,
  saveHostWithConnectionCredentials,
} from './save-host.ts'
import {
  currentRuntimeSurface,
  getRuntimeState,
  runtimeBlocksLocalStart,
  subscribeRuntimeState,
} from '@dsh-chamber/dsh-chamber-client-core/runtime-management'
import css from './ConnectionsSection.module.css'

/** Registration-side business face for the connections section. */
export interface ConnectionsSectionInjected {
  /** Bound translate over the section's own dictionary namespace. */
  t: (key: SettingsConnectionsKey) => string
}
export type { PluginDiagnostic } from './plugin-diagnostic.ts'

export type ConnectionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dsh-chamber.settings.connections'>
  & InjectFace<ConnectionsSectionInjected>
  & {
    /** Per-instance diagnostics keyed by source id ('local' | '<kind>-<id>'); optional outside the chamber shell. */
    pluginDiagnostics?: Readonly<Record<string, PluginDiagnostic | undefined>>
    /** Per-instance settled-boot gaps keyed EXACTLY like `pluginDiagnostics`. A
     *  separate fact from the plugin diagnostic: the graph channel may answer `ok`
     *  while the page's own surfaces never registered. Absent outside the chamber shell. */
    bootGaps?: Readonly<Record<string, ServerBootGap | undefined>>
    /** Self-heal recheck for CHANNEL-class diagnostics: the host owns the shared
     *  plugin-diagnostic store, so the write-back comes from the host — this section
     *  only asks. Absent outside the chamber shell. */
    onRecheckDiagnostic?: (sourceId: string) => void
  }

/** Host-log page size (04 §3.3: default 200, cap 1000). */
const HOST_LOG_LIMIT = 200
const MIN_GATEWAY_TOKEN_CHARS = 32

/** Gateway-card runtime-probe cadence: while the section is mounted, connected gateway
 *  cards re-read /chamber/runtime/status at this interval so the「启动实例」action tracks
 *  the managed dsh's own state (a host-side crash needs no user action here). */
const GATEWAY_RUNTIME_PROBE_INTERVAL_MS = 20_000

/** Runtime connection states the「启动实例」action applies to (the /chamber/runtime/start
 *  route's own gate in runtime-routes.ts). */
const STARTABLE_RUNTIME_STATES = new Set(['stopped', 'error', 'restart-exhausted'])

/** 启动 409 拒绝的本地化键：启动只有一族（当前状态不可启动或运行时正忙）；重启那一族
 *  在 restart-action.ts（MANAGED_RESTART_REFUSAL_KEYS），两个入口共用。 */
const START_REFUSAL_KEYS: { notRunning: RuntimeRefusalKey; busy: RuntimeRefusalKey } = {
  notRunning: 'startManagedDshRefused',
  busy: 'startManagedDshRefused',
}

/** 每卡受控重启/启动的结果行：'error' 以 css.error + role="alert" 渲染，'ok' 以
 *  css.hint + role="status"（接受/完成 = ok，拒绝/失败/超时 = error）。 */
type RestartNote = { tone: 'ok' | 'error'; text: string }

/** Local-card connection-row poll cadence: 状态由 /api/host/health-events 推送，此处只兜底行字段与流异常收敛。 */
const LOCAL_ROW_POLL_MS = 30_000

/** Slugify a ~/.ssh/config alias into the id whitelist (^[a-zA-Z0-9_-]+$). */
function ssh(): DesktopSshSurface | null {
  return window.dshChamber?.desktopSsh ?? null
}

/** Render the connections section content column. */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode {
  const { t, pluginDiagnostics, bootGaps, onRecheckDiagnostic } = props
  // 本组件只消费上图三个 prop：设置面不再二次装载插件，没有"装不上"可报，每来源
  // 「设置组装诊断」块不在此渲染；仍然真实的诊断留在该来源卡片的「客户端插件状态」。
  // Per-instance input ids (useId): the dialog renders inside N-ctx panels in the SAME
  // document — static ids would alias; one id per credential/pin field.
  const gatewayTokenFieldId = useId()
  const gatewayPasswordFieldId = useId()
  const spkiFieldId = useId()
  const sshPasswordFieldId = useId()
  const runtimeState = useSyncExternalStore(subscribeRuntimeState, getRuntimeState)
  const runtimeSurfacePresent = currentRuntimeSurface() !== null
  // Fail closed while the desktop runtime bridge hydrates; once hydrated, applying
  // forbids every local spawn entry. The local card's TWO spawn entries (「启动」and
  // 「清理并接管」, which clears stale writers and then STARTS) read ONE verdict from
  // ./local-spawn-gate.ts and render the same reason row.
  const spawnGate = localSpawnGate({
    blocked: runtimeBlocksLocalStart(runtimeState, runtimeSurfacePresent),
    hydrating: runtimeState === null,
    phase: runtimeState?.phase,
    runtimeBlockedReason: runtimeState?.runtimeBlockedReason,
  })

  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [connection, setConnection] = useState<ConnectionSummary | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  // 写者静默诊断：本地实例为何起不来 + 显式接管动作。
  const [writerDiagnosis, setWriterDiagnosis] = useState<LocalWriterDiagnosisWire | null>(null)
  const [reclaiming, setReclaiming] = useState(false)
  const [reclaimError, setReclaimError] = useState<string | null>(null)
  const [reclaimOk, setReclaimOk] = useState(false)
  const [stopConfirm, setStopConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [hostLogs, setHostLogs] = useState<HostLogsResponse | null>(null)
  const [hostLogsError, setHostLogsError] = useState<string | null>(null)
  /** 主机日志默认折叠；首次展开时才拉取（避免无谓 REST 调用）。 */
  const [hostLogsOpen, setHostLogsOpen] = useState(false)

  const [instances, setInstances] = useState<SshInstanceSpec[]>([])
  const [statuses, setStatuses] = useState<Record<string, SshStatusProjection>>({})
  const [rosterError, setRosterError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [opError, setOpError] = useState<Record<string, string>>({})

  const [editing, setEditing] = useState<SshInstanceSpec | 'new' | null>(null)
  const [draft, setDraft] = useState<HostDraft | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof HostDraft, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // ---- ~/.ssh/config discovery (add-host form only) ----
  const [configHosts, setConfigHosts] = useState<SshConfigHost[] | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  // The preload bridge is exposed asynchronously after dsh-chamber:info; while absent
  // the SSH surface is inert — track its arrival so the mount-time loads retry once.
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
  // Gateway 主机日志 Modal：经实例代理读 gateway 自身控制面的 /api/host/logs（与本地卡同款响应形状）。
  const [gatewayLogsFor, setGatewayLogsFor] = useState<SshInstanceSpec | null>(null)
  const [gatewayHostLogs, setGatewayHostLogs] = useState<HostLogsResponse | null>(null)
  const [gatewayHostLogsError, setGatewayHostLogsError] = useState<string | null>(null)
  const [gatewayHostLogsBusy, setGatewayHostLogsBusy] = useState(false)
  /** 插件对话框：四类卡片统一开 PluginDialog —— 分叉仅在 target 描述符（本地 /
   *  ssh+dsh spec / gateway 源 / http 直连只读）；对话框只读，无写面。 */
  const [pluginDialogFor, setPluginDialogFor] = useState<PluginDialogTarget | null>(null)

  /** 哪个 gateway 卡的「重启 dsh」确认 Modal 开着。 */
  const [restartConfirmFor, setRestartConfirmFor] = useState<SshInstanceSpec | null>(null)
  /** 每卡独立单飞：正在重启的 gateway 卡 id 集。A 卡在飞不影响 B 卡；收尾只清自己的 id。 */
  const [restartingIds, setRestartingIds] = useState<Record<string, boolean>>({})
  /** 每卡重启/启动结果行（成功/失败/超时/拒绝），按卡片 id 落独立行；tone 决定渲染
   *  （'error' = 红字 alert，'ok' = 灰字 status）。 */
  const [restartNotes, setRestartNotes] = useState<Record<string, RestartNote | null>>({})
  /** 正在启动的 gateway 卡 id 集（与 restartingIds 同款每卡单飞；同卡重启/启动互斥 ——
   *  二者写同一 runtime）。 */
  const [startBusyIds, setStartBusyIds] = useState<Record<string, boolean>>({})
  /** 每卡在飞启动的 AbortController。 */
  const startAbortRefs = useRef<Record<string, AbortController>>({})
  /** 每卡托管 dsh runtime connectionState：「启动实例」仅在 ∈ {stopped, error,
   *  restart-exhausted} 时出现。隧道 phase 只证明 gateway 宿主可达 —— 托管 dsh 是否在跑
   *  由 /chamber/runtime/status 回答；卡条目只在宿主答 200 后写入。 */
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
    try {
      setWriterDiagnosis(await cp.localWriters())
    } catch (err) {
      // 诊断读取失败不是本地实例的错误：只清空该块（启动/停止的报错另有出处）。
      setWriterDiagnosis(null)
    }
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
    if (spawnGate.blocked) return
    setLocalBusy(true)
    try {
      setConnection(await cp.createLocal())
      setLocalError(null)
      // Starting the instance is a new host process: a plugin installed while it was stopped only shows on a window boot.
      void armLocalDshRestartCompletion()
    } catch (err) {
      setLocalError(errorMessage(err))
    } finally {
      setLocalBusy(false)
    }
    void loadLocal()
  }, [loadLocal, spawnGate.blocked])

  /** 清理并接管（POST /api/connections/local/reclaim）：清除本状态目录自己的陈旧/孤儿
   *  托管写者记录，然后启动本地实例。其它运行中的应用实例不受影响（控制面拒绝）；失败时
   *  原样呈现控制面给出的阻塞原因。 */
  const reclaimLocal = useCallback(async (): Promise<void> => {
    // Same gate as startLocal: this route also ends in a spawn, and the gate covers every spawn entry.
    if (spawnGate.blocked) return
    setReclaiming(true)
    setReclaimError(null)
    try {
      const outcome = await cp.reclaimLocal()
      setConnection(outcome.connection)
      setReclaimOk(true)
      setLocalError(null)
      // The reclaim starts the instance (new host process): same completion as the start button.
      void armLocalDshRestartCompletion()
    } catch (err) {
      setReclaimError(errorMessage(err))
    } finally {
      setReclaiming(false)
    }
    void loadLocal()
  }, [loadLocal, spawnGate.blocked])

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
      // 背景刷新只更新投影，不清除行内错误——并发用户操作刚设置的错误不能被背景成功误清。
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

  /** systemd 起停/查询：结果投影合并进 statuses（serviceActive 随卡片显示）。Returns
   *  whether the op succeeded — the restart leg arms the page-owned completion only on real success. */
  const runServiceOp = useCallback(async (id: string, op: 'start_service' | 'stop_service' | 'restart_service' | 'is_active'): Promise<boolean> => {
    const bridge = ssh()
    if (bridge === null) return false
    setBusy(prev => ({ ...prev, [id]: true }))
    try {
      const result = await bridge[op](id)
      if ('error' in result) {
        setOpError(prev => ({ ...prev, [id]: result.error }))
        return false
      }
      setStatuses(prev => ({ ...prev, [id]: result }))
      clearOpError(id)
      return true
    } catch (err) {
      setOpError(prev => ({ ...prev, [id]: errorMessage(err) }))
      return false
    } finally {
      setBusy(prev => ({ ...prev, [id]: false }))
    }
  }, [clearOpError])

  /**
   * systemd restart of a dsh source: a new host process = a new plugin set for that
   * source, so the page-owned completion reloads the window once the source serves again.
   * Gateway sources are deliberately NOT armed — 「重启网关服务」 does not restart the
   * instance's plugin set.
   */
  const restartSourceService = useCallback(async (spec: SshInstanceSpec): Promise<void> => {
    const restarted = await runServiceOp(spec.id, 'restart_service')
    if (!restarted || spec.kind !== 'dsh') return
    const sourceId = `dsh-${spec.id}`
    void armWindowReloadWhenServed(
      sourceId,
      () => waitForSourceServing(sourceId, { timeoutMs: 120_000 }),
      { budgetMs: RESTART_RELOAD_BUDGET_MS },
    )
  }, [runServiceOp])

  /**
   * 受控重启 gateway 托管的 dsh：POST …/chamber/runtime/restart —— 仅 202 接受。409 拒绝按
   * managed-restart.ts 映射为本地化文案（未在运行 → 指向「启动实例」；其余 = 忙碌/恢复中），
   * 非 409 维持 serverRefusalText 的逐字投影。202 后按 shared pollGatewayReady 语义轮询
   * （1s/120s；终态/401/403/404 快失败；超时诚实投影）。结果落该卡独立结果行，成功刷新卡片状态。
   */
  const restartManagedDsh = useCallback(async (spec: SshInstanceSpec): Promise<void> => {
    // 每卡独立单飞：同卡重复确认被门挡住；他卡在飞不受影响。
    if (restartingIds[spec.id] === true) return
    setRestartingIds(prev => ({ ...prev, [spec.id]: true }))
    setRestartNotes(prev => ({ ...prev, [spec.id]: null }))
    const note = (value: RestartNote | null): void => {
      setRestartNotes(prev => ({ ...prev, [spec.id]: value }))
    }
    try {
      // 传输 + 202 门 + page-owned 就绪轮询只有一份实现（restart-action.ts）：409 走同一族
      // 本地化文案，超时/失败按 outcome 落到本卡结果行；POST 不自带 controller。
      const outcome = await runManagedRestart(`gateway-${spec.id}`, t)
      if (outcome.kind === 'reloaded') {
        note({ tone: 'ok', text: t('restartManagedDshOk') })
        // 成功刷新卡片状态投影：registry 不变，只重读各实例 phase/service 激活态。
        void loadRemote()
      } else if (outcome.kind === 'accepted-timeout') {
        // 重启已接受、仍在恢复 → 本地化说明（ok 语气）。
        note({ tone: 'ok', text: t('restartManagedDshAccepted') })
      } else {
        note({ tone: 'error', text: outcome.kind === 'refused' ? outcome.text : outcome.detail })
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
    }
  }, [restartingIds, t, loadRemote])

  /**
   * 托管 dsh runtime 探针：GET …/chamber/runtime/status —— 只投影 connectionState（重启/启动
   * 动作的门控输入）。/chamber 管理面挂宿主、非 ready-gated：隧道 'ready' 与 runtime 'stopped'
   * 可以并存，二者都如实呈现。探针失败（非 200 / 缺字段 / 传输错误）= 状态不可知：删除该来源的
   * 运行期条目（applyRuntimeProbe(…, null)）——保留陈旧 'stopped' 会让「启动实例」常驻而每次点击
   * 注定 409。缺条目 ≠ 停机：探针缺失绝不隐藏健康来源，只是「启动实例」不凭空出现；200 且值未变
   * 时不重写条目。
   */
  const probeGatewayRuntime = useCallback(async (specId: string): Promise<void> => {
    let connectionState: string | null = null
    try {
      const response = await fetch(`/api/i/gateway-${specId}/chamber/runtime/status`)
      if (response.status === 200) {
        const payload = await response.json() as { connectionState?: unknown } | null
        connectionState = typeof payload?.connectionState === 'string' ? payload.connectionState : null
      }
    } catch {
      connectionState = null
    }
    setRuntimeConnectionById(prev => applyRuntimeProbe(prev, specId, connectionState))
  }, [])

  /** 「启动实例」：POST …/chamber/runtime/start —— 与 restart 同一 202 + 轮询语义，但轮询按
   *  start 动作（停机态不会像 restart 那样被当作终态失败）。仅 stopped/error/restart-exhausted
   *  可启动，其余 409 按 classifyRuntimeRefusal 本地化；start:'failed'/终态快失败/超时 = 已接受
   *  仍在恢复（ok 语气）。每卡独立单飞 + 与重启互斥，结果落同一 restartNotes 槽位；成功刷新投影
   *  并立即重探 runtime。 */
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
        note({ tone: 'error', text: runtimeRefusalText(body, response.status, START_REFUSAL_KEYS, t) })
        return
      }
      // Same page-owned completion as the restart leg: a started managed dsh boots a new plugin set.
      let pollFailure: unknown = null
      const outcome = await armWindowReloadWhenServed(
        id,
        async signal => {
          try {
            await pollGatewayReady(id, signal, { action: 'start' })
            return true
          } catch (err) {
            pollFailure = err
            return false
          }
        },
        { budgetMs: RESTART_RELOAD_BUDGET_MS },
      )
      if (outcome === 'reloaded') {
        note({ tone: 'ok', text: t('startManagedDshOk') })
        void loadRemote()
        void probeGatewayRuntime(spec.id)
      } else {
        const cls = classifyRestartError(pollFailure
          ?? new Error('start completion aborted before the readiness poll settled'))
        // accepted-timeout = 启动已接受、仍在恢复（标记与 restart 共用）→ 本地化说明，ok 语气；
        // 其余 = 启动失败 + 轮询的英文 detail（error 语气，未本地化）。
        note(cls.kind === 'accepted-timeout'
          ? { tone: 'ok', text: t('startManagedDshAccepted') }
          : { tone: 'error', text: t('startManagedDshFailed').replace('{error}', cls.detail) })
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

  /** Gateway 主机日志：经实例代理读 gateway 自身控制面 /api/host/logs；响应形状与本地卡一致，直接复用 HostLogsResponse。 */
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
      // Exact id-addressed main transaction: never send a roster snapshot — a stale
      // read-modify-write could delete a connection added concurrently after this dialog opened.
      const saved = await bridge.delete_connection(pendingDelete.id)
      setInstances(saved)
      setPendingDelete(null)
      setStatuses(prev => {
        const copy = { ...prev }
        delete copy[pendingDelete.id]
        return copy
      })
      // Loud-failure invariant: delete_connection returns the authoritative current
      // registry — if the deletion did not land, say so instead of a silent no-op.
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

  /** Load the ~/.ssh/config host projections (non-secret metadata only; keys/proxies/
   *  credentials never reach the renderer). A missing config is an empty list; a read failure is loud. */
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

  /** Apply a discovered config host to the draft (the alias stays so the ssh config block
   *  applies as with plain ssh). Only empty fields are filled — manual input is never
   *  overwritten — and only the errors of fields actually filled are cleared. */
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
    // Pure normalization covers all four target/transport combinations and preserves the
    // non-secret SPKI pin; credential fields remain empty by construction (they never cross IPC).
    setDraft(draftFromSpec(spec))
    setFieldErrors({})
    setFormError(null)
    setConfigHosts(null)
    setConfigError(null)
  }, [])

  /** 清除该主机在主进程内存与 owner-only 镜像中的密码（改用密钥/ssh-agent）。 */
  const clearPassword = useCallback(
    (): Promise<void> => clearCredential(CLEAR_SSH_PASSWORD, { bridge: ssh(), editing, setDraft, setInstances, setEditing, setFormError }),
    [editing],
  )

  /** Clear a stored gateway token without ever reading it into the renderer. */
  const clearGatewayToken = useCallback(
    (): Promise<void> => clearCredential(CLEAR_GATEWAY_TOKEN, { bridge: ssh(), editing, setDraft, setInstances, setEditing, setFormError }),
    [editing],
  )

  /** Clear a stored gateway login password without ever reading it into the renderer. */
  const clearGatewayPassword = useCallback(
    (): Promise<void> => clearCredential(CLEAR_GATEWAY_PASSWORD, { bridge: ssh(), editing, setDraft, setInstances, setEditing, setFormError }),
    [editing],
  )

  const closeForm = useCallback((): void => {
    if (saving) return
    setEditing(null)
    setDraft(null)
    setFieldErrors({})
    setFormError(null)
  }, [saving])

  /**
   * 表单只收非秘密元数据；id 格式 ^[a-zA-Z0-9_-]+$（新增查重、'local' 为本地来源保留字）、
   * 端口十进制 1–65535、host/user 与主进程同源白名单（首字符不得为 '-'，防 ssh 选项注入）、
   * serviceName 白名单 ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$（首字符必须为字母或数字）。
   */
  const validate = useCallback((value: HostDraft): Partial<Record<keyof HostDraft, string>> => {
    const errors: Partial<Record<keyof HostDraft, string>> = {}
    const id = value.id.trim()
    if (id === '') errors.id = t('validationIdRequired')
    else if (id === 'local') errors.id = t('validationIdReserved')
    // The authoritative pattern already reserves 'local' (own message) and caps the length at 64.
    else if (!INSTANCE_ID_PATTERN.test(id)) errors.id = t('validationIdInvalid')
    else if (editing === 'new' && instances.some(instance => instance.id === id)) errors.id = t('validationIdDuplicate')
    if (value.label.trim() === '') errors.label = t('validationLabelRequired')
    else if (value.label.length > MAX_INSTANCE_LABEL_CHARS) errors.label = t('validationLabelTooLong')
    // Credential dimensions are independent. Re-entry is driven by the main process's
    // non-secret existence projections plus the retarget rule (gateway+ssh may need both layers).
    if (editing !== null && editing !== 'new') {
      const reentry = credentialReentryEdit(editing, value)
      if (reentry.gatewayToken && value.gatewayToken === '') errors.gatewayToken = t('validationGatewayCredentialsRequired')
      if (reentry.gatewayPassword && value.gatewayPassword === '') errors.gatewayPassword = t('validationGatewayCredentialsRequired')
      if (reentry.sshPassword && value.password === '') {
        errors.password = t('validationPasswordRequired')
      }
    }
    if (value.kind === 'gateway') {
      // The token is OPTIONAL (auth is never a mode; an empty token sends no auth header).
      // ASCII/length checks apply only when a value is present.
      if (value.gatewayToken !== '' && !/^[\x20-\x7e]+$/.test(value.gatewayToken)) {
        // Mirror the main-process gate (gatewayTokenValidationError): non-visible-ASCII bytes
        // would pass the renderer but be rejected by the main process with a vague write failure.
        errors.gatewayToken = t('validationGatewayTokenAscii')
      } else if (value.gatewayToken !== '' && value.gatewayToken.length < MIN_GATEWAY_TOKEN_CHARS) {
        errors.gatewayToken = t('validationGatewayTokenLength')
      }
      // The login password is likewise optional; when present it mirrors the server config
      // gate — 12–1024 JS characters including Unicode; the shared helper returns a machine code.
      const passwordError = gatewayPasswordValidationError(value.gatewayPassword)
      if (passwordError === 'length') errors.gatewayPassword = t('validationGatewayPasswordLength')
    }
    if (transportFormSchema(value.transport).fieldGroup === 'url') {
      // transport='http' validates/derives the URL for EVERY kind: a defensive dsh+http row
      // must not silently skip the URL gate nor fall through to host validation for unrendered fields.
      const parsed = parseGatewayUrl(value.gatewayUrl)
      if (!parsed.ok) errors.gatewayUrl = gatewayUrlErrorText(parsed, t)
      if (spkiPinEligible(value) && spkiPinValidationError(value.spkiPin) !== null) {
        errors.spkiPin = t('validationSpkiPinFormat')
      }
      return errors
    }
    const host = value.host.trim()
    if (host === '') errors.host = t('validationHostRequired')
    else if (host.length > MAX_SSH_HOST_CHARS || !SSH_HOST_PATTERN.test(host)) errors.host = t('validationHostInvalid')
    if (value.user.trim() !== '') {
      const user = value.user.trim()
      if (user.length > MAX_SSH_USER_CHARS || !SSH_USER_PATTERN.test(user)) errors.user = t('validationUserInvalid')
    }
    // The ssh password is transient and write-only, but an over-long value would still be rejected by main.
    if (value.password.length > MAX_SSH_PASSWORD_CHARS) errors.password = t('validationPasswordTooLong')
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
    if (serviceName !== '' && (serviceName.length > MAX_SERVICE_NAME_CHARS || !SERVICE_NAME_PATTERN.test(serviceName))) {
      errors.serviceName = t('validationServiceNameInvalid')
    }
    const remoteDshHome = value.remoteDshHome.trim()
    // The authoritative mirror rejects '..', empty segments and a trailing slash — never a
    // weaker inline regex that accepts /srv/../tmp or /srv//dsh.
    if (remoteDshHome !== ''
      && (remoteDshHome.length > MAX_REMOTE_DSH_HOME_CHARS || !REMOTE_DSH_HOME_PATTERN.test(remoteDshHome))) {
      errors.remoteDshHome = t('validationRemoteDshHomeInvalid')
    }
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
      // transport='http' derives the target from the URL for EVERY kind: validate() already
      // rejected a malformed URL loudly, and this re-check turns a parse failure at save time
      // into an explicit field error instead of a silent no-op.
      if (draft.transport === 'http') {
        const parsed = parseGatewayUrl(draft.gatewayUrl)
        if (!parsed.ok) {
          setFieldErrors(prev => ({ ...prev, gatewayUrl: gatewayUrlErrorText(parsed, t) }))
          return
        }
      }
      // One main-owned transaction receives the replacement metadata and all applicable NEW
      // write-only values; old credentials never return to the renderer (main snapshots and
      // restores them on any failure). Empty fields leave their stored dimensions untouched.
      const result = await saveHostWithConnectionCredentials(
        bridge,
        editing === 'new' ? null : editing.id,
        editing === 'new' ? input : { ...input, id: editing.id },
        // The save helper filters these values through the independent capability matrix:
        // gateway+ssh can commit both credential layers; dsh+http commits none.
        {
          sshPassword: draft.password,
          token: draft.gatewayToken,
          password: draft.gatewayPassword,
        },
      )
      setInstances(result.instances)
      if (!result.ok) {
        setFormError(result.error)
        // If rollback genuinely failed, turn a newly-created row into an edit target so retry
        // cannot submit a duplicate id; the password field stays for an explicit retry.
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

  // 挂载：装载本地卡 / 注册表；订阅隧道状态推送（实时更新徽标）。主机日志默认折叠、首次
  // 展开懒加载。bridgeUp 触发重跑：preload 的 dshChamber 暴露是异步的，桥出现后重载一次，
  // 避免 SSH 面永久静默失效。
  useEffect(() => {
    if (!bridgeUp) return
    void loadLocal()
    void loadRemote()
    // 本地卡状态由推送流驱动：迁移即时可见；30s 轮询只兜底连接行字段与流异常收敛（远程卡走 live pushes）。
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
    // 注册表变更推送：设置页之外的增删改即刻重拉 roster——否则外部编辑要等重挂载才可见。
    const unsubscribeInstances = bridge.onInstancesChanged(() => {
      void loadRemote()
    })
    return () => {
      unsubscribe()
      unsubscribeInstances()
    }
  }, [bridgeUp, clearOpError, loadRemote])

  // Poll for the bridge while it is absent (preload exposes it after the async dsh-chamber:info round-trip).
  useEffect(() => {
    if (bridgeUp) return
    const timer = setInterval(() => {
      if (ssh() !== null) setBridgeUp(true)
    }, 500)
    return () => { clearInterval(timer) }
  }, [bridgeUp])

  // 卸载即中止在飞的「启动实例」POST（它自带 controller）。重启腿没有 controller：就绪轮询的
  // signal 属于 page-owned completion，关闭面板不取消它。
  useEffect(() => {
    return () => {
      for (const controller of Object.values(startAbortRefs.current)) controller.abort()
    }
  }, [])

  // Gateway 卡 runtime 探针：注册表/状态变化时立即探一次已连接 gateway 卡，此后按固定间隔
  // 维持（宿主侧自发停机/恢复无桌面事件可依赖）；transport 断开的卡不探 —— 启动动作本身以
  // connected 门控。探测依赖 CONNECTED gateway id SET，绝不依赖整个 statuses map：每次
  // per-source 推送都会重写该 map，整 map 依赖会在每次推送时对所有 gateway 卡立即重探
  // （O(cards × pushes)）。
  const connectedGatewayKey = useMemo(
    () => instances
      .filter(spec => spec.kind === 'gateway'
        && statuses[spec.id]?.kind === 'gateway'
        && (statuses[spec.id]?.phase === 'ready' || statuses[spec.id]?.phase === 'degraded'))
      .map(spec => spec.id)
      .sort()
      .join(','),
    [instances, statuses],
  )

  // Gateway 卡 runtime 探针：连接集合变化时立即探一次，此后按固定间隔维持（宿主侧自发
  // 停机/恢复无桌面事件可依赖）；transport 断开的卡不探 —— 启动动作以 connected 门控。
  useEffect(() => {
    if (!bridgeUp) return
    const ids = connectedGatewayKey === '' ? [] : connectedGatewayKey.split(',')
    const probe = (): void => {
      for (const id of ids) void probeGatewayRuntime(id)
    }
    probe()
    const timer = setInterval(probe, GATEWAY_RUNTIME_PROBE_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [bridgeUp, connectedGatewayKey, probeGatewayRuntime])

  const dsh = health?.dsh
  const healthy = dsh?.status === 'ready' || dsh?.status === 'degraded'
  const starting = dsh?.status === 'starting' || dsh?.status === 'restarting'
  // 写者静默通知：诊断非静默时在本地卡片上点名阻塞写者并给出「清理并接管」；判定在 writer-diagnosis.ts。
  const notice = writerNotice(writerDiagnosis)
  /** 确认 Modal 的目标卡是否正处「本卡重启」忙碌态（他卡在飞不影响本 Modal）。 */
  const restartConfirmBusy = restartConfirmFor !== null && restartingIds[restartConfirmFor.id] === true

  // dsh 运行时版本：优先读同一个 runtime state；其完整状态缺失时回退 info 投影，null/空串时不编造 chip。
  const dshVersion = runtimeState?.active
    ?? (typeof window !== 'undefined' ? (window.dshChamber?.dshVersion ?? null) : null)

  /** 虚线添加入口：有卡片时作为网格的最后一个单元格；空名单时独立通栏显示。 */
  const creatorButton = (
    <button type="button" className={css.creatorButton} onClick={openAdd}>
      <IconPlusOutlineRegular size={14} />
      {t('addHost')}
    </button>
  )

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      {/* Plaintext-fallback visibility: when the OS keychain is unavailable main mirrors
          gateway credentials as the documented 0600 plaintext fallback (read-only projection merged onto every instances_get row). */}
      {instances.some(spec => spec.secretStorage === 'plaintext')
        ? <p className={css.hint} role="status">{t('secretStoragePlaintextHint')}</p>
        : null}
      {/* Cross-flavor credential residual: secretStorageUnreadable is per-row (mirror bytes
          another flavor wrote), so this hint renders exactly when at least one row carries it. It is NOT corruption: the user must re-enter those credentials. */}
      {instances.some(spec => spec.secretStorageUnreadable === true)
        ? <p className={css.hint} role="status">{t('secretStorageUnreadableHint')}</p>
        : null}
      {ssh() === null ? <p className={css.error} role="alert">{t('desktopOnly')}</p> : null}

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('localTitle')}</h3>
        <div className={css.localCard}>
          {/* 横向布局: 名称+状态+meta 在左，操作在右。 */}
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
                disabled={healthy || starting || localBusy || stopping || spawnGate.blocked}
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
                <PluginManageIcon16 />
              </button>
              <button
                type="button"
                className={css.iconButton}
                data-tip={t('localRefresh')}
                aria-label={t('localRefresh')}
                onClick={() => { void loadLocal() }}
              >
                <IconRefreshOutlineRegular />
              </button>
            </div>
          </div>
          {dsh?.error != null && dsh.error !== '' ? <p className={css.error}>{dsh.error}</p> : null}
          {localError !== null ? <p className={css.error} role="alert">{localError}</p> : null}
          {notice !== null ? (
            <div className={css.writerBlocked} role="status">
              <p className={css.writerBlockedTitle}>{t('writerBlockedTitle')}</p>
              <p className={css.warnHint}>
                {notice.restartRequired
                  ? t('writerBlockedSticky')
                  : t('writerBlockedBody').replace('{detail}', notice.blockers
                    .map(blocker => `pid ${blocker.pid ?? '—'} (${blocker.reason})`)
                    .join(', '))}
              </p>
              {notice.blockers.length > 0 ? (
                <ul className={css.writerBlockedList}>
                  {notice.blockers.map(blocker => (
                    <li key={`${String(blocker.pid)}:${blocker.reason}`}>
                      <span className={css.mono}>pid {blocker.pid ?? '—'}</span>
                      {' · '}{t(writerReasonKey(blocker.reason))}
                      {' '}<span className={css.mono}>({blocker.reason})</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {notice.errors.length > 0 ? (
                <ul className={css.writerBlockedList}>
                  {notice.errors.map(line => <li key={line}><span className={css.mono}>{line}</span></li>)}
                </ul>
              ) : null}
              {notice.canTakeOver ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={reclaiming || spawnGate.blocked}
                  onClick={() => { void reclaimLocal() }}
                >
                  {reclaiming ? t('writerReclaimBusy') : t('writerReclaim')}
                </Button>
              ) : null}
              {reclaimError !== null ? <p className={css.error} role="alert">{reclaimError}</p> : null}
              {reclaimOk ? <p className={css.writerReclaimOk}>{t('writerReclaimOk')}</p> : null}
            </div>
          ) : null}
          {/* The one visible reason for BOTH gated spawn entries (start and 「清理并接管」):
              local-spawn-gate.ts guarantees every blocked verdict names itself. */}
          {spawnGate.reasonKey !== null ? (
            <p className={css.hint}>{spawnGate.reasonDetail ?? t(spawnGate.reasonKey)}</p>
          ) : null}
          <PluginDiagnosticLine diagnostic={pluginDiagnostics?.['local']} bootGap={bootGaps?.['local']} t={t} />
          <div className={css.logArea}>
            <div className={css.logHead}>
              <button
                type="button"
                className={css.logToggle}
                aria-expanded={hostLogsOpen}
                onClick={toggleHostLogs}
              >
                <IconChevronDownOutlineRegular className={clsx(css.logChevron, hostLogsOpen && css.logChevronOpen)} />
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
                <IconRefreshOutlineRegular />
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
                // Registry and status pushes are independent. Suppress a stale old-provider
                // projection during a kind switch instead of showing the replacement as falsely ready.
                const projectedStatus = statuses[spec.id]
                const status = projectedStatus?.kind === spec.kind ? projectedStatus : undefined
                const phase = status?.phase
                const connected = phase === 'ready' || phase === 'degraded'
                const specBusy = busy[spec.id] === true
                // Gateway runtime startability: the tunnel phase proves the gateway HOST answers;
                // the managed dsh's own state comes from the runtime probe (startBusy keeps the button rendered).
                const runtimeConnectionState = runtimeConnectionById[spec.id]
                const runtimeStartable = runtimeConnectionState !== undefined
                  && STARTABLE_RUNTIME_STATES.has(runtimeConnectionState)
                // 重启门：核心路由只接受 ready/degraded，探针已给出其它终态时点击必然 409（停机态
                // 的恢复面是「启动实例」）——按钮提前禁用，而不是放行注定被拒的请求。探针无答案
                // （未探/已清条目）不禁用：缺探针不得隐藏健康来源。
                const restartBlocked = runtimeBlocksRestart(runtimeConnectionState)
                const startBusy = startBusyIds[spec.id] === true
                const serviceActive = status?.serviceActive
                // systemd control rides the ssh transport (dsh or gateway over a tunnel both
                // exec systemctl over ssh); http direct endpoints have no service channel.
                const serviceConfigured = spec.transport === 'ssh' && spec.serviceName !== null
                // 终态失败提示按类别选择（action-hint.ts）：endpoint 类意味着隧道正常、问题在
                // 远端实例——绝不展示 SSH 认证失败提示。
                const hintKey = actionHintKey(spec, status, phase)
                // 本卡重启/启动结果行（null = 无）；tone 分流渲染（见下）。
                const restartNote = restartNotes[spec.id]
                return (
                  <li key={spec.id} className={css.card}>
                    <div className={css.cardHead}>
                      {/* 两行布局：身份行与徽标行分开——单行 flex-wrap 在 268px 网格底线处换行不可预测，名称会被挤压成省略号。 */}
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
                        {/* 诚实状态: the plaintext and no-auth postures stay visible after
                            configuring. 「无认证」 only when NEITHER gateway credential is stored
                            (passwordSet is authoritative). 配色：姿态徽标统一描边+彩色文字，与状态徽标填充区分。 */}
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
                          <IconChecklistOutlineRegular />
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
                    {spec.transport === 'ssh' && spec.serviceName === null && spec.kind === 'dsh'
                      ? <p className={css.hint}>{t('serviceUnconfiguredHint')}</p>
                      : null}
                    <PluginDiagnosticLine
                      diagnostic={pluginDiagnostics?.[`${spec.kind}-${spec.id}`]}
                      bootGap={bootGaps?.[`${spec.kind}-${spec.id}`]}
                      t={t}
                    />
                    <Button
                      variant={connected ? 'outline' : 'primary'}
                      size="sm"
                      className={css.connectButton}
                      icon={connected ? <IconCloseOutlineRegular /> : <IconLinkOutlineRegular />}
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
                          // 此按钮不带 data-tip；aria-label 保留——busy/未连接/未运行时携带禁用原因，常态回退可见标签。
                          aria-label={restartingIds[spec.id] === true
                            ? t('restartManagedDshBusy')
                            : !connected
                              ? t('restartNotConnected')
                              : restartBlocked
                                ? t('restartNotRunning')
                                : t('restartManagedDsh')}
                          disabled={specBusy || !connected || restartBlocked || restartingIds[spec.id] === true || startBusyIds[spec.id] === true}
                          onClick={() => { setRestartConfirmFor(spec) }}
                        >
                          {restartingIds[spec.id] === true ? t('restartManagedDshBusy') : t('restartManagedDsh')}
                        </Button>
                        {/* 「启动实例」：托管 dsh 处于 stopped/error/restart-exhausted（runtime
                            探针投影）且传输已连接时出现；在飞期间保持渲染（busy 标签）。 */}
                        {(runtimeStartable || startBusy) && (
                          <Button
                            variant="outline"
                            size="sm"
                            className={css.restartTip}
                            // aria 配对：tip 存在（禁用原因）即为 aria-label，否则回退可见标签。
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
                        // aria 配对：tip 存在（未配置原因 / gateway 的 systemd 重启说明）即为 aria-label，否则回退可见标签。
                        data-tip={!serviceConfigured ? t('serviceUnconfigured') : spec.kind === 'gateway' ? t('restartServiceTip') : undefined}
                        aria-label={!serviceConfigured ? t('serviceUnconfigured') : spec.kind === 'gateway' ? t('restartServiceTip') : t('restartInstance')}
                        onClick={() => { void restartSourceService(spec) }}
                      >
                        {spec.kind === 'gateway' ? t('restartGatewayService') : t('restartInstance')}
                      </Button>
                      )}
                    <div className={css.cardFoot}>
                      {/* 插件入口对每个连接渲染，统一开 PluginDialog：SSH 通道的 dsh 目标走 ssh
                          后端；gateway（任意传输）走 gateway 后端；http 直连无执行表面，只读 Loader 清单。 */}
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
                        <PluginManageIcon16 />
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
                              {serviceActive === true ? <IconStopFillRegular /> : <IconPlayOutlineRegular />}
                            </button>
                            <button
                              type="button"
                              className={css.iconButton}
                              disabled={!serviceConfigured || specBusy}
                              data-tip={t('serviceCheck')}
                              aria-label={`${t('serviceCheck')}: ${spec.label}`}
                              onClick={() => { void runServiceOp(spec.id, 'is_active') }}
                            >
                              <IconRefreshOutlineRegular />
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
                            <IconDataOutlineRegular />
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
                        <IconSearchOutlineRegular />
                      </button>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={specBusy}
                        data-tip={t('edit')}
                        aria-label={`${t('edit')}: ${spec.label}`}
                        onClick={() => { openEdit(spec) }}
                      >
                        <IconEditOutlineRegular />
                      </button>
                      <button
                        type="button"
                        className={`${css.iconButton} ${css.iconDanger}`}
                        disabled={specBusy}
                        data-tip={t('delete')}
                        aria-label={`${t('delete')}: ${spec.label}`}
                        onClick={() => { setPendingDelete(spec) }}
                      >
                        <IconTrashOutlineRegular />
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

      {/* 受控重启 gateway 托管的 dsh：确认含多用户中断文案；运行期间保持弹窗 + busy 标签。
          忙碌判定只看本 Modal 的目标卡（restartConfirmBusy）——每卡独立单飞。 */}
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

      <ConnectionFormModal
        t={t}
        editing={editing}
        draft={draft}
        setDraft={setDraft}
        fieldErrors={fieldErrors}
        setFieldErrors={setFieldErrors}
        formError={formError}
        setFormError={setFormError}
        saving={saving}
        closeForm={closeForm}
        saveDraft={saveDraft}
        clearPassword={clearPassword}
        clearGatewayToken={clearGatewayToken}
        clearGatewayPassword={clearGatewayPassword}
        configHosts={configHosts}
        configLoading={configLoading}
        configError={configError}
        loadConfigHosts={loadConfigHosts}
        applyConfigHost={applyConfigHost}
        gatewayTokenFieldId={gatewayTokenFieldId}
        gatewayPasswordFieldId={gatewayPasswordFieldId}
        spkiFieldId={spkiFieldId}
        sshPasswordFieldId={sshPasswordFieldId}
      />

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
            <Button variant="ghost" icon={<IconRefreshOutlineRegular />} disabled={logsBusy} onClick={() => { void refreshLogs() }}>
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
            <Button variant="ghost" icon={<IconRefreshOutlineRegular />} disabled={gatewayHostLogsBusy} onClick={() => { void refreshGatewayHostLogs() }}>
              {t('logsRefresh')}
            </Button>
            {/* Footer close clears the stale-guard ref exactly like onClose — a late gatewayHostLogs response must never repaint a closed modal. */}
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
          // Diagnostic key: 'local' | '<kind>-<id>'; for ssh targets the registry key is the SPEC
          // kind ('dsh'), not the dialog target kind; for gateway/http sourceId IS '<kind>-<id>' already.
          const sourceKey = pluginDialogFor.kind === 'local'
            ? 'local'
            : pluginDialogFor.kind === 'ssh'
              ? `${pluginDialogFor.spec.kind}-${pluginDialogFor.spec.id}`
              : pluginDialogFor.sourceId
          return (
            <PluginDialog
              t={t}
              target={pluginDialogFor}
              diagnostic={pluginDiagnostics?.[sourceKey]}
              bootGap={bootGaps?.[sourceKey]}
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
