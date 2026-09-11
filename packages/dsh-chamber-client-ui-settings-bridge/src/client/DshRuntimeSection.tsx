/**
 * Per-server dsh runtime section (design 18 §3.6, 2026-09 per-server 修订 +
 * dsh 直连不挂载修订): registered as `settings.section` id `dsh-runtime`
 * (order 31, right after agent-presets) for every source with a chamber
 * runtime management surface: local = full management surface; gateway =
 * full per-server segment proxied through `/chamber/runtime`
 * (status/versions/select/apply/rollback/restore-builtin/retry-apply/
 * retry-restore/registry/restart, design 18 §9.3 + design 17 §3). Direct dsh
 * targets (ssh or http) mount no section — the remote runtime is
 * systemd-deployed and no management surface exists. Every mounted source
 * gets the「重启 dsh」
 * action (design 18 §3.6 项 8) to refresh mounted plugins.
 *
 * Runtime facts and mutations remain main-process/gateway-authoritative. The
 * local view consumes the shared renderer projection so its action gates,
 * status copy, SemVer ordering and subscription lifecycle stay aligned with
 * the connections local-start gate; the gateway view consumes the gateway's
 * own `/chamber/runtime` projection through the same-origin instance proxy
 * (no token ever leaves the main process, design 17 §7.2/§12).
 *
 * 2026-09-11 upstream-alignment T9: every action capsule in this file is the
 * shared ui-primitives `Button` (`variant="outline|primary" size="sm"`), the
 * exact recipe the hand-rolled `.updateButton` / `.updatePrimaryButton` rules
 * copied — the local rules are gone.
 *
 * 2026-09-11 upstream-alignment T2: every confirmation this section performs is
 * ONE in-app dialog (RuntimeConfirmDialog, the official ui-primitives `Modal`),
 * in both shapes. The previous split — native confirm on the desktop shape,
 * `window.confirm` on the gateway shape — is gone: native chrome cannot ride the
 * panel's `--dsw-alias-*` tokens, its dismiss/focus discipline or a multi-shell
 * document, and the gateway-hosted shape has no native dialog at all.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsBridgeKey } from '../locales.ts'
import {
  compareSemver,
  currentRuntimeSurface,
  formatRuntimeBytes,
  getRuntimeState,
  preferredRuntimeVersion,
  projectRuntimeBadge,
  projectRuntimeSnapshot,
  projectRuntimeStatus,
  runtimeAllowedActions,
  runtimeRestartAllowed,
  runtimeSelectionDirection,
  subscribeRuntimeState,
  type RuntimeBadgeLabel,
  type RuntimeBadgeTone,
  type RuntimeBadgeView,
  type RuntimeMetadataComponent,
  type RuntimeVersionEntry,
} from '../../../../packages/renderer/src/runtime-management.ts'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
// Pure gateway runtime core (design 21 §5.2 split): parsers/fetchers/action
// gates/errors/settle poll + the restart-readiness poll moved to the sidebar
// package's shared face; only the local view mappings stay here — the
// SettingsBridgeKey-keyed remoteRuntimeStatusView and the renderer-vocabulary
// projectRemoteRuntimeBadge (both carry the bridge's UI keys/renderer types).
import {
  fetchRemoteRuntimeStatus,
  fetchRemoteRuntimeVersions,
  pollGatewayReady,
  pollRemoteRuntimeUntilSettled,
  remoteRuntimeAction,
  remoteRuntimeActionGates,
  remoteRuntimeSetRegistry,
  resetRemoteRuntimeActivityOwners,
  type RemoteRuntimeStatus,
  type RemoteVersions,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { projectRemoteRuntimeBadge, remoteRuntimeStatusView } from './gateway-runtime-api.ts'
import {
  acceptConfirm as acceptConfirmStep, armConfirm, cancelConfirm as cancelConfirmStep,
  IDLE_CONFIRM, type ConfirmState,
} from './confirm-machine.ts'
import css from './SettingsShell.module.css'

type RuntimeTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

const NPMJS = 'https://registry.npmjs.org'
const NPMMIRROR = 'https://registry.npmmirror.com'
const CUSTOM_REGISTRY = '__custom__'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* Unified coloured status badge (2026-12): one pill vocabulary shared by the
   local and gateway branches — label keys + dsw tone classes. The badge
   names the machine state; registry verdicts were removed from the copy. */
const RUNTIME_BADGE_KEYS: Record<RuntimeBadgeLabel, SettingsBridgeKey> = {
  ok: 'dshRuntimeBadgeOk',
  checking: 'dshRuntimeBadgeChecking',
  downloading: 'dshRuntimeBadgeDownloading',
  installing: 'dshRuntimeBadgeInstalling',
  pending: 'dshRuntimeBadgePending',
  applying: 'dshRuntimeBadgeApplying',
  'rolling-back': 'dshRuntimeBadgeRollingBack',
  restarting: 'dshRuntimeBadgeRestarting',
  'swap-attempted': 'dshRuntimeBadgeSwapAttempted',
  'snapshot-failed': 'dshRuntimeBadgeSnapshotFailed',
  'restore-blocked': 'dshRuntimeBadgeRestoreBlocked',
  blocked: 'dshRuntimeBadgeBlocked',
  failed: 'dshRuntimeBadgeFailed',
  error: 'dshRuntimeBadgeError',
  metadata: 'dshRuntimeBadgeMetadata',
}

const RUNTIME_BADGE_TONE_CLASS: Record<RuntimeBadgeTone, string> = {
  ok: css.runtimeBadgeOk,
  busy: css.runtimeBadgeBusy,
  warn: css.runtimeBadgeWarn,
  danger: css.runtimeBadgeDanger,
}

function RuntimeBadge({ view, t }: { view: RuntimeBadgeView; t: RuntimeTranslate }) {
  return (
    <span className={clsx(css.runtimeBadge, RUNTIME_BADGE_TONE_CLASS[view.tone])} role="status">
      {t(RUNTIME_BADGE_KEYS[view.label])}
    </span>
  )
}

/** Localize a projected ISO timestamp before it reaches user copy. The locale
 *  service keeps `<html lang>` in sync at activation and on every locale
 *  change (dsh-client-locale syncDocumentLanguage); the served markup defaults
 *  to zh-CN, so an unset lang falls back to zh-CN rather than the OS locale. */
function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const locale = typeof document !== 'undefined' && document.documentElement.lang !== ''
    ? document.documentElement.lang
    : 'zh-CN'
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  } catch {
    return value
  }
}

/** Map the main-process registry patch failures to localized copy by their
 *  stable machine-readable `code` (never by display-text matching — the main
 *  process may reword `error` without notice). Known codes become dictionary
 *  keys; anything unknown stays honest and raw. */
function localizeRegistryError(code: string | undefined, error: string, t: RuntimeTranslate): string {
  if (code === 'invalid-registry-origin') {
    return t('dshRuntimeRegistryInvalidOrigin')
  }
  return error
}

function metadataComponentText(component: RuntimeMetadataComponent, t: RuntimeTranslate): string {
  switch (component) {
    case 'current': return t('dshRuntimeMetadataComponentCurrent')
    case 'override': return t('dshRuntimeMetadataComponentOverride')
    case 'activation-journal': return t('dshRuntimeMetadataComponentJournal')
    case 'recovery-marker': return t('dshRuntimeMetadataComponentRecoveryMarker')
    case 'retained-evidence': return t('dshRuntimeMetadataComponentEvidence')
  }
}

export type { DshRuntimeSource } from './runtime-source.ts'
import type { DshRuntimeSource } from './runtime-source.ts'

export interface DshRuntimeSectionProps {
  t: RuntimeTranslate
  /** Source kind derived from the instance context's canonical chamber id. */
  instanceSource?: DshRuntimeSource
  /** The canonical per-instance id (local | gateway-<id>). */
  chamberInstanceId?: string
}

/**
 * One armed destructive-action confirmation (2026-09-11 upstream-alignment T2).
 *
 * WHY this section confirms in-app instead of with a native browser dialog (the
 * module header records the removed native call sites): native chrome cannot
 * ride the panel's `--dsw-alias-*` design tokens or its dismiss/focus
 * discipline, it is document-global (this page mounts several instance shells at
 * once), and one of the section's two shapes — a gateway-hosted instance — has
 * no native dialog at all. So the SAME dialog serves every shape, and a cancel
 * performs nothing: the request is dropped before its runner is ever called.
 */
interface RuntimeConfirmRequest {
  /** Dialog heading (localized when the action is armed). */
  title: string
  /** Supporting sentence — the copy the native confirm used to show, verbatim. */
  description: string
  /** Confirm-button copy while idle. */
  confirmLabel: string
  /** Copy for the pending row and the busy confirm button while the action runs. */
  pendingLabel: string
  /** The confirmed action; it owns its own failure reporting and never runs before the user confirms. */
  run: () => Promise<void>
}

/**
 * The section's ONE confirmation dialog: the official ui-primitives `Modal`
 * (title + description + outline Cancel + outline destructive Confirm), with a
 * `role="status"` row while the action runs. Cancel, mask click and Escape all
 * route through `onCancel`, which no-ops while pending — the dialog is a
 * progress surface then, and dismissing it must not imply a cancellation that
 * does not exist (the connections section's restart confirm keeps the same
 * rule).
 * @param props.request - the armed request, or null while nothing is armed.
 * @param props.pending - whether the confirmed action is still in flight.
 * @param props.onCancel - dismiss without acting (ignored while pending).
 * @param props.onConfirm - run the armed action.
 * @param props.t - the section's bound translate.
 * @returns the dialog, or nothing while no request is armed.
 */
function RuntimeConfirmDialog({
  request, pending, onCancel, onConfirm, t,
}: {
  request: RuntimeConfirmRequest | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
  t: RuntimeTranslate
}) {
  if (request === null) return null
  return (
    <Modal
      open
      onClose={onCancel}
      title={request.title}
      closeLabel={t('close')}
      description={request.description}
      className={css.deleteDialog}
      footer={(
        <>
          <Button variant="outline" autoFocus disabled={pending} onClick={onCancel}>
            {t('dshRuntimeRegistryCancel')}
          </Button>
          <Button variant="outline" className={css.deleteConfirm} disabled={pending} onClick={onConfirm}>
            {pending ? request.pendingLabel : request.confirmLabel}
          </Button>
        </>
      )}
    >
      {pending && (
        <p className={css.generalHint} role="status" aria-live="polite">{request.pendingLabel}</p>
      )}
    </Modal>
  )
}

/**
 * Full per-server「dsh 运行时」segment for a GATEWAY connection (design 18
 * §3.6/§9.3, design 17 §3): every fact and action goes through the instance's
 * same-origin `/api/i/gateway-<id>/chamber/runtime/*` proxy — the gateway's
 * own status is the authority, the desktop never touches the token. The
 * restart action (design 18 §3.6 项 8) stays the shared transactional flow
 * (POST /restart 202 + pollGatewayReady) owned by the parent so the local and
 * gateway branches keep identical semantics.
 *
 * Remote status is polled every ~3s (the /chamber/runtime controller stays
 * mounted while dsh is down — applying/restart windows keep progress
 * pollable); versions are pulled on entry and re-pulled after a status change
 * that may have altered the cached-tree list (an install finishing). Action
 * errors (409 refusals and failures) surface on the shared actionError row
 * with the server's own `error` copy passed through verbatim.
 */
function GatewayRuntimeSection({
  t,
  chamberInstanceId,
  restarting,
  onRestartDsh,
  restartNote,
  actionError,
  setActionError,
  askConfirm,
}: {
  t: RuntimeTranslate
  chamberInstanceId: string
  restarting: boolean
  onRestartDsh: () => void
  restartNote: string | null
  actionError: string | null
  setActionError: (error: string | null) => void
  /** Arm the section's ONE in-app confirmation (2026-09-11 upstream-alignment T2). */
  askConfirm: (request: RuntimeConfirmRequest) => void
}) {
  const STATUS_POLL_MS = 3_000
  // Per-instance labelledby ids (useId): N-ctx shells mount one settings panel
  // each in the SAME document — a static id would alias across panels.
  const selectVersionId = useId()
  const [remoteStatus, setRemoteStatus] = useState<RemoteRuntimeStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [remoteVersions, setRemoteVersions] = useState<RemoteVersions | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [versionsEpoch, setVersionsEpoch] = useState(0)
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null)
  const selectionExplicit = useRef(false)
  const [actionBusy, setActionBusy] = useState(false)
  const actionInFlight = useRef(false)
  const actionController = useRef<AbortController | null>(null)
  const componentActive = useRef(true)
  const lastPhaseRef = useRef<string | null>(null)
  const [registrySelection, setRegistrySelection] = useState(NPMJS)
  const [customOrigin, setCustomOrigin] = useState('')
  const [registryEditing, setRegistryEditing] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [registryBusy, setRegistryBusy] = useState(false)
  const registryInFlight = useRef(false)
  const registryController = useRef<AbortController | null>(null)
  /** 用户点击「检查更新」忙碌态（与 local 分支 testingRegistry 同语义）：
   *  仅在用户点击后置位，并保持到该次检查真正 settle；后台拉取（entry
   *  首拉、安装/应用结束后的自动重拉）不点亮——与 local 分支一致，避免
   *  打开本段或自动刷新时按钮无谓地显示「正在检查更新…」。 */
  const [checkingVersions, setCheckingVersions] = useState(false)
  /** 一次用户检查意图（true = 点击在途，等待下一次版本拉取 settle 清除）。 */
  const checkIntent = useRef(false)
  /** 当前版本拉取请求的 identity 所有者（与 action/registry 同一围栏模式）。 */
  const versionsController = useRef<AbortController | null>(null)
  /** 最新绑定 t（versions effect 的超时/失败文案使用）：effect 依赖刻意不含
   *  t，避免语言切换触发版本重拉；用 ref 承接保证超时文案按当前语言渲染。 */
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    const idle = resetRemoteRuntimeActivityOwners({
      actionController,
      actionInFlight,
      registryController,
      registryInFlight,
    })
    componentActive.current = true
    // Cleanup clears controller ownership before the stale promise reaches its
    // identity-fenced finally block. Reset the visible busy flags here for the
    // newly selected instance; the old promise must never publish into it.
    setActionBusy(idle.actionBusy)
    setRegistryBusy(idle.registryBusy)
    return () => {
      componentActive.current = false
      resetRemoteRuntimeActivityOwners({
        actionController,
        actionInFlight,
        registryController,
        registryInFlight,
      })
    }
  }, [chamberInstanceId])

  // Remote status poll (design 18 §9.3 mounting discipline): the section stays
  // live through dsh-down windows. A transient fetch failure keeps the last
  // status beside an honest error line; a phase transition out of installing
  // re-pulls the version list (the install may have added a cached tree).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const tick = async (): Promise<void> => {
      try {
        const status = await fetchRemoteRuntimeStatus(chamberInstanceId, { signal: controller.signal })
        if (!cancelled) {
          if ((lastPhaseRef.current === 'installing' || lastPhaseRef.current === 'applying')
            && status.phase !== 'installing' && status.phase !== 'applying') {
            setVersionsEpoch((epoch) => epoch + 1)
          }
          lastPhaseRef.current = status.phase
          setRemoteStatus(status)
          setStatusError(null)
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setStatusError(errorMessage(error))
      } finally {
        if (!cancelled) timer = setTimeout(() => { void tick() }, STATUS_POLL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chamberInstanceId])

  // Version list: pulled once on entry and re-pulled after a status change
  // (versionsEpoch bumps on an install/apply→settled transition or after
  // select/cleanup/apply-now completions) or an explicit「检查更新」
  // (checkIntent). BACKGROUND pulls stay silent — exactly like the local
  // branch, where only the user-initiated check owns the
  //「正在检查更新…」state. A user click stays busy until the list ACTUALLY
  // settles (even when a background bump superseded the exact request). A
  // bounded transport timeout (the gateway's own metadata fetch is capped at
  // 15s server-side; the local equivalent lives in the main process) converts
  // a wedged hop into an honest error row instead of a stuck busy button.
  useEffect(() => {
    let cancelled = false
    let timedOut = false
    const controller = new AbortController()
    versionsController.current = controller
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 30_000)
    fetchRemoteRuntimeVersions(chamberInstanceId, { signal: controller.signal })
      .then((versions) => {
        if (!cancelled) {
          setRemoteVersions(versions)
          setVersionsError(null)
        }
      })
      .catch((error) => {
        if (cancelled) return
        if (controller.signal.aborted && timedOut) {
          setVersionsError(tRef.current('dshRuntimeVersionsRefreshTimeout'))
        } else if (!controller.signal.aborted) {
          setVersionsError(errorMessage(error))
        }
      })
      .finally(() => {
        // Identity fence: only the CURRENT request settles visible state; a
        // superseded (aborted) request never clears the successor's.
        if (versionsController.current === controller && !cancelled) {
          versionsController.current = null
          // A user check stays busy until the list actually settles — even
          // when a background bump superseded this exact request.
          if (checkIntent.current) {
            checkIntent.current = false
            setCheckingVersions(false)
          }
        }
      })
    return () => {
      cancelled = true
      clearTimeout(timeout)
      controller.abort()
    }
  }, [chamberInstanceId, versionsEpoch])

  // Descending semver order (newest first); entries that do not parse as
  // exact semver keep their server-relative order at the tail.
  const sortedVersions = useMemo(() => {
    const list = remoteVersions?.versions ?? []
    return [...list].sort((a, b) => compareSemver(b.version, a.version) ?? 0)
  }, [remoteVersions])

  const remoteActive = remoteStatus?.activeVersion ?? null
  const latestTag = useMemo(
    () => sortedVersions.find(entry => entry.latest)?.version ?? null,
    [sortedVersions],
  )

  // Preserve an explicit choice across status pushes / version re-pulls;
  // before the user chooses, the active version wins (in the default no-override
  // state the active version IS the builtin anchor), then the builtin anchor,
  // then the recommendation (same policy as the local branch's
  // preferredRuntimeVersion).
  useEffect(() => {
    if (remoteStatus === null) return
    setSelectedRemote((current) => {
      const stillExplicit = selectionExplicit.current
        && current !== null
        && sortedVersions.some(entry => entry.version === current)
      if (!stillExplicit) selectionExplicit.current = false
      return preferredRuntimeVersion(
        stillExplicit ? current : null,
        sortedVersions,
        latestTag,
        remoteActive,
        remoteStatus.builtinVersion,
      )
    })
  }, [remoteStatus, sortedVersions, latestTag, remoteActive])

  const chosenRemote = preferredRuntimeVersion(
    selectionExplicit.current ? selectedRemote : null,
    sortedVersions,
    latestTag,
    remoteActive,
    remoteStatus?.builtinVersion ?? null,
  )
  const isActiveRemote = chosenRemote !== null && chosenRemote === remoteActive
  // Direction-aware merged primary action (design 18 §3.6 项 3, gateway
  // branch): a single button covers both directions — select+apply arms the
  // next-launch switch and the server's apply route computes the manualRollback
  // semantics itself for a downgrade target (runtime-manager apply), so the
  // gateway UI no longer fires the separate rollback route. A null active
  // version is an install/forward action, never a rollback.
  const gatewayDirection = runtimeSelectionDirection(chosenRemote, remoteActive)

  const envGatedRemote = remoteStatus?.source === 'env'
  // Pure mirror of the server fences: pending permits only restore-builtin;
  // install/apply/restart-in-flight permit no action. Registry editing is a
  // version mutation; restart stays source-independent (including env).
  // checkingVersions freezes the mutation controls during a USER check — the
  // local branch does the same (its main-process check pushes the checking
  // phase with an empty action set): both sources disable select/edit/
  // primary/restart/registry while a check is in flight. Row VISIBILITY is
  // matched too: the local action set emptying unmounts the cleanup row and
  // the restore-builtin secondary row, so the gateway hides the same rows
  // while checkingVersions (see restoreBuiltinVisible / the cleanup row
  // condition). The check button itself shows the busy copy and is disabled.
  const remoteGates = remoteRuntimeActionGates(
    remoteStatus,
    actionBusy || registryBusy || restarting || checkingVersions,
  )
  const mutationDisabled = remoteGates.mutationDisabled
  const restoreBuiltinDisabled = remoteGates.restoreBuiltinDisabled
  const retryApplyDisabled = remoteGates.retryApplyDisabled
  const retryRestoreDisabled = remoteGates.retryRestoreDisabled
  // Recover-metadata is the ONLY action a FATAL metadata block leaves open —
  // its enablement must come from the dedicated gate (never mutationDisabled,
  // which is true in exactly the states this row exists for; R4 F2).
  const recoverMetadataDisabled = remoteGates.recoverMetadataDisabled
  // 「检查更新」机器相位可用性 —— 显式镜像 local 分支动作矩阵（renderer
  // runtimeAllowedActions/BASE_ACTIONS）中含 check 的状态集，不借用
  // mutationDisabled（env 会误伤：local 的 env 分支保留 check）：
  //   禁用 = 忙碌相位（installing/applying/重启窗口）、pending、恢复相位
  //   （snapshot-failed/swap-attempted/restore-blocked）、启动受阻（含
  //   env-probe-failed 等无相位受阻）、只读平台；
  //   可用 = idle/applied/失败带操作错误（local failed/error 相位保留 check）。
  // restart 窗口两侧一致禁用（local 侧把 restarting 计入本地按钮禁用）。
  // 2026-12 review P2-2 落实：restarting prop（父层 POST /restart 202 →
  // pollGatewayReady settle 的全窗口）一并计入——仅依赖服务端 restart
  // 轮询相位会留下「点击后首个轮询前 ≤~3s」与「相位离开 running 但
  // ready 轮询未完成」两个解禁窗口。
  // 按钮常驻显示、相位禁用而非隐藏，与 local 分支本次统一后的策略一致。
  const checkMachineBusy = restarting || (remoteStatus !== null && (
    remoteStatus.phase === 'installing'
    || remoteStatus.phase === 'applying'
    || remoteStatus.phase === 'pending'
    || remoteStatus.phase === 'snapshot-failed'
    || remoteStatus.phase === 'swap-attempted'
    || remoteStatus.phase === 'restore-blocked'
    || remoteStatus.restart === 'running'
    || (remoteStatus.startupBlockedReason !== null && remoteStatus.startupBlockedReason !== '')
    || remoteStatus.mutationsAllowed === false
  ))

  const runRemoteAction = useCallback(async (task: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    // React state is not a synchronous mutex: two clicks in the same render
    // can both observe actionBusy=false. Fence before the first await and keep
    // one abort owner for instance switches/unmount.
    // 同帧检查围栏（2026-12 review P2-1 落实）：checkIntent 在用户点击
    // 「检查更新」当帧置位、要到版本列表真正 settle 才清——mutation 入口
    // 必须与 checkingVersions 的渲染级冻结同语义，否则「检查在途冻结变更
    // 控件与重启」要到下一渲染才生效、同帧可双放行。ref 围栏是唯一的
    // 同步防线（React state 非同步互斥）。
    if (actionInFlight.current || checkIntent.current) return
    actionInFlight.current = true
    const controller = new AbortController()
    actionController.current = controller
    setActionBusy(true)
    setActionError(null)
    try {
      await task(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted && componentActive.current) setActionError(errorMessage(error))
    } finally {
      if (actionController.current === controller) {
        actionController.current = null
        actionInFlight.current = false
        if (componentActive.current) setActionBusy(false)
      }
    }
  }, [setActionError])

  const onApplySelected = useCallback(() => {
    if (chosenRemote === null || isActiveRemote || mutationDisabled) return
    void runRemoteAction(async (signal) => {
      // select = async install job (202, progress via status).phase; after it
      // settles, apply() arms the next-startup switch — the gateway analog of
      // the local branch's「更新到 vY」install→pending flow (design 18 §3.6
      // 项 3 + §9.3 route table: select records the choice WITHOUT pending,
      // apply is the separate action that arms it).
      const result = await remoteRuntimeAction(chamberInstanceId, { kind: 'select', version: chosenRemote }, { signal })
      if (result.status === 202) {
        const status = await pollRemoteRuntimeUntilSettled(chamberInstanceId, 'select', { signal })
        if (!signal.aborted) setRemoteStatus(status)
      }
      if (chosenRemote !== remoteActive) {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'apply' }, { signal })
      }
      // The install may have added a cached tree — refresh the selector.
      setVersionsEpoch((epoch) => epoch + 1)
    })
  }, [chamberInstanceId, chosenRemote, isActiveRemote, mutationDisabled, remoteActive, runRemoteAction])

  // 确认改走应用内对话框（2026-09-11 upstream-alignment T2）：文案键不变，
  // 原来的 confirm(message) 正文成为对话框描述；取消 = 什么都不做。
  const onRestoreBuiltin = useCallback(() => {
    if (restoreBuiltinDisabled) return
    askConfirm({
      title: t('dshRuntimeRestoreBuiltinConfirmTitle'),
      description: t('dshRuntimeRestoreBuiltinConfirmBody'),
      confirmLabel: t('dshRuntimeResetBuiltin'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'restore-builtin' }, { signal })
      }),
    })
  }, [chamberInstanceId, restoreBuiltinDisabled, t, runRemoteAction, askConfirm])

  const onRetryApply = useCallback(() => {
    if (retryApplyDisabled) return
    askConfirm({
      title: t('dshRuntimeRetryApplyConfirmTitle'),
      description: t('dshRuntimeRetryApplyConfirmBody'),
      confirmLabel: t('dshRuntimeRetryApply'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'retry-apply' }, { signal })
      }),
    })
  }, [chamberInstanceId, retryApplyDisabled, t, runRemoteAction, askConfirm])

  const onRetryRestore = useCallback(() => {
    if (retryRestoreDisabled) return
    askConfirm({
      title: t('dshRuntimeRetryRestoreConfirmTitle'),
      description: t('dshRuntimeRetryRestoreConfirmBody'),
      confirmLabel: t('dshRuntimeRetryRestore'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'retry-restore' }, { signal })
      }),
    })
  }, [chamberInstanceId, retryRestoreDisabled, t, runRemoteAction, askConfirm])

  // 清理已安装版本（2026-12 desktop 对齐）：候选来自服务端 removableVersions
  // 投影；确认走应用内对话框（2026-09-11 T2）。
  const onCleanupRemote = useCallback((version: string) => {
    if (mutationDisabled) return
    askConfirm({
      title: t('dshRuntimeCleanupConfirmTitle', { version }),
      description: t('dshRuntimeCleanupConfirmBody'),
      confirmLabel: t('dshRuntimeCleanupVersion'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'cleanup-version', version }, { signal })
        // The removed tree leaves the version list and the candidate list.
        setVersionsEpoch((epoch) => epoch + 1)
      }),
    })
  }, [chamberInstanceId, mutationDisabled, t, runRemoteAction, askConfirm])

  // 恢复回滚前数据（2026-12 desktop 对齐）：row 在 idle 且存在暂存时出现，
  // 恢复 half 会进入 restore-blocked 由 retry-restore 续作。
  const canRestorePreRollbackRemote = remoteStatus !== null
    && !envGatedRemote
    && remoteStatus.phase === 'idle'
    && remoteStatus.startupBlockedReason === null
    && (remoteStatus.preRollbackCount ?? 0) > 0
    && remoteStatus.preRollbackLatestName !== null
  const onRestorePreRollbackRemote = useCallback(() => {
    const stashName = remoteStatus?.preRollbackLatestName ?? null
    if (remoteStatus === null || stashName === null || !canRestorePreRollbackRemote || mutationDisabled) return
    askConfirm({
      title: t('dshRuntimeRestorePreRollbackConfirmTitle'),
      description: t('dshRuntimeRestorePreRollbackConfirmBody'),
      confirmLabel: t('dshRuntimeRestorePreRollback'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'restore-pre-rollback', stashName }, { signal })
      }),
    })
  }, [remoteStatus, canRestorePreRollbackRemote, mutationDisabled, t, chamberInstanceId, runRemoteAction, askConfirm])

  // 元数据救援（2026-12 desktop 对齐）：状态投影给出可救援能力时才显示。
  const canRecoverMetadataRemote = remoteStatus?.canRecoverMetadata === true
  const onRecoverMetadataRemote = useCallback(() => {
    if (!canRecoverMetadataRemote || mutationDisabled) return
    askConfirm({
      title: t('dshRuntimeRecoverMetadataConfirmTitle'),
      description: t('dshRuntimeRecoverMetadataConfirmBody'),
      confirmLabel: t('dshRuntimeRecoverMetadata'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'recover-metadata' }, { signal })
      }),
    })
  }, [canRecoverMetadataRemote, mutationDisabled, t, chamberInstanceId, runRemoteAction, askConfirm])

  // Metadata corruption notice rows (mirror the local branch copy; the fields
  // are absent on pre-recovery servers, so the block simply never renders).
  const metadataComponentsText = (remoteStatus?.metadataComponents ?? []).length > 0
    ? (remoteStatus?.metadataComponents ?? []).map(component => metadataComponentText(component as RuntimeMetadataComponent, t))
      .join(t('dshRuntimeMetadataComponentSeparator'))
    : t('dshRuntimeMetadataComponentUnknown')
  const remoteMetadataBlocked = remoteStatus !== null
    && (remoteStatus.metadataHealth === 'selection-corrupt'
      || remoteStatus.metadataHealth === 'recovery-in-progress'
      || remoteStatus.metadataHealth === 'recovery-marker-corrupt')

  // Apply now on the gateway (design 18 addendum §5.1/§6.3): the pending
  // immediate-switch action goes through the 202 route, polls the applying
  // window to settlement, then refreshes the version list — mirroring
  // onApplySelected. 2026-09-11 upstream-alignment T2: this confirmation is the
  // section's own in-app dialog like every other one (it used to be
  // a native browser confirm, which no shape of this panel can style or scope).
  const onApplyNowRemote = useCallback(() => {
    const target = remoteStatus?.pending
    if (remoteStatus === null || target === null || remoteGates.applyNowDisabled) return
    askConfirm({
      title: t('dshRuntimeApplyNowConfirmTitle', { version: target }),
      description: t('dshRuntimeApplyNowConfirmBody', { version: target }),
      confirmLabel: t('dshRuntimeApplyNowAction'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      run: () => runRemoteAction(async (signal) => {
        const result = await remoteRuntimeAction(chamberInstanceId, { kind: 'apply-now' }, { signal })
        if (result.status === 202) {
          const status = await pollRemoteRuntimeUntilSettled(chamberInstanceId, 'apply-now', { signal })
          if (!signal.aborted) setRemoteStatus(status)
        }
        // The applied version may have changed the cached-tree list.
        setVersionsEpoch((epoch) => epoch + 1)
      }),
    })
  }, [chamberInstanceId, remoteStatus, remoteGates.applyNowDisabled, t, runRemoteAction, askConfirm])

  const registryOrigin = remoteStatus?.registry ?? ''
  const registryMode = registryOrigin === NPMJS || registryOrigin === NPMMIRROR
    ? registryOrigin
    : CUSTOM_REGISTRY

  useEffect(() => {
    setRegistrySelection(registryMode)
    if (registryMode === CUSTOM_REGISTRY) setCustomOrigin(registryOrigin)
  }, [registryMode, registryOrigin])

  const onApplyRegistry = useCallback(async (origin: string): Promise<void> => {
    // checkIntent 同帧围栏：registry PUT 属「检查在途冻结」的变更面（同
    // runRemoteAction 纪律，2026-12 review P2-1 落实）。
    if (registryInFlight.current || checkIntent.current) return
    registryInFlight.current = true
    const controller = new AbortController()
    registryController.current = controller
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      const result = await remoteRuntimeSetRegistry(chamberInstanceId, origin, { signal: controller.signal })
      if (!controller.signal.aborted && componentActive.current) {
        setRegistryEditing(false)
        // The server's own echo (the canonical origin) is authoritative:
        // reflect it IMMEDIATELY instead of waiting for the next ~3s status
        // poll tick — same instant feedback the local branch gets from its
        // optimistic settings overlay. The poll keeps asserting the truth.
        // Known benign race (accepted): a poll GET that snapshot the OLD
        // origin before the PUT may land AFTER this echo and revert the row
        // for at most one poll interval (~3s); the next tick re-asserts the
        // applied origin. Same self-healing class as the local optimistic
        // overlay racing a main push.
        setRemoteStatus((current) => current === null
          ? current
          : { ...current, registry: result.origin, registryError: null })
      }
    } catch (error) {
      if (!controller.signal.aborted && componentActive.current) setRegistryError(errorMessage(error))
    } finally {
      if (registryController.current === controller) {
        registryController.current = null
        registryInFlight.current = false
        if (componentActive.current) setRegistryBusy(false)
      }
    }
  }, [chamberInstanceId])

  // 「检查更新」(2026-12 统一)：gateway 侧 = 从 registry 重拉版本列表（与
  // local 的主进程 registry 检查同观感；服务端无周期出网）。同步 ref 围栏
  // 防同帧双击（React state 非同步互斥，与 runRemoteAction 同纪律）；忙碌
  // 态「正在检查更新…」保持到列表真正 settle（见 versions effect）。
  const onRefreshVersions = useCallback((): void => {
    if (checkIntent.current) return
    checkIntent.current = true
    setCheckingVersions(true)
    // 新检查起始即清上次失败行（2026-12 review P2-3 落实）：否则旧超时/
    // 错误文案与「正在检查更新…」在整个新检查期间并存，直到新 fetch
    // settle（local 侧 onTestRegistry 点击即清 registryError 的同语义）。
    setVersionsError(null)
    setVersionsEpoch((epoch) => epoch + 1)
  }, [])

  // Retryability derives from the server's own phase projection (the routes
  // refuse with 409 no_retry_target otherwise): retry-apply resumes an
  // interrupted pointer switch / snapshot failure; retry-restore resumes an
  // interrupted data restore.
  const canRetryApplyRemote = remoteStatus !== null
    && (remoteStatus.phase === 'swap-attempted' || remoteStatus.phase === 'snapshot-failed')
  const canRetryRestoreRemote = remoteStatus !== null
    && remoteStatus.phase === 'restore-blocked'

  // 「恢复内建」可见性（2026-12 修订 + 2026 audit R2 收窄）：版本一致
  // （active == builtin）时恢复是 no-op，按钮不显示；仅普通 pending（待应用
  // 切换等待下次启动）保留逃生口（中止待应用切换语义）——snapshot-failed/
  // swap-attempted/restore-blocked 等 recovery 相位与一切 startupBlocked 状态
  // 不显示（server 恢复门只开放各自 retry/recover-metadata；armed reset 在
  // 持久恢复标记下会被核心复阻并残留、劫持后续 retry 语义）；installing/
  // applying 忙碌窗仍渲染（忙碌时随行禁用，与其余动作同口径——2026 audit R4
  // 注，勿与 recovery 相位混同）。
  // active/builtin 任一未知时保守显示（无法判断一致性，宁显不藏）。
  // 注：gateway server 的 restore-builtin 路由现检查 hasOverride
  // （runtime_no_override）并收窄恢复期矩阵（2026 audit R2），此处 hasOverride
  // 要求与 server 同口径——常态下 hasOverride === false ⟺ active === builtin，
  // 仅异常态可能触及，与 local 侧 main 的 hasOverride !== true 一律拒绝同口径。
  // 2026 audit R3: the visibility predicate itself must exclude recovery
  // phases and any projected startup block (phase-less FATAL /
  // env-probe-failed / resolution failure) — the server's recovery gate
  // refuses restore-builtin there, so offering the button would be a 409
  // dead end. Healthy idle with an override (or an unknown active/builtin)
  // and the plain-pending escape keep the button.
  const remoteRecoveryPhase = remoteStatus !== null
    && (remoteStatus.phase === 'swap-attempted'
      || remoteStatus.phase === 'snapshot-failed'
      || remoteStatus.phase === 'restore-blocked')
  const remoteStartupBlocked = remoteStatus !== null
    && remoteStatus.startupBlockedReason !== null
    && remoteStatus.startupBlockedReason !== ''
  const remoteResetEscapeHatch = remoteStatus !== null
    && remoteStatus.phase === 'pending'
  const restoreBuiltinVisible = remoteStatus !== null
    && remoteStatus.hasOverride
    && !remoteRecoveryPhase
    && !remoteStartupBlocked
    && !checkingVersions
    && (remoteResetEscapeHatch
      || remoteStatus.activeVersion === null
      || remoteStatus.builtinVersion === null
      || remoteStatus.activeVersion !== remoteStatus.builtinVersion)
  // 「内建版本」行引导（方案 2 gateway 镜像，2026-12 用户决策：与 local 分支
  // 全面统一）：下拉选中与服务器内建锚同版本的行、存在用户选择（hasOverride）
  // 且该版本尚未装成受管树时，主按钮引导「恢复内建」（restore-builtin = 清
  // 指针回内建锚的事务，零下载）——把同版本下载并另装受管树降级为显式次要
  // 动作；该版本已缓存（曾装树）时保持普通切换。
  const remoteBuiltinGuide = chosenRemote !== null
    && !isActiveRemote
    && remoteStatus !== null
    && remoteStatus.builtinVersion !== null
    && chosenRemote === remoteStatus.builtinVersion
    && remoteStatus.hasOverride === true
    && !restoreBuiltinDisabled
    && !sortedVersions.some((entry) => entry.version === chosenRemote && entry.cached)

  const view = remoteStatus === null ? null : remoteRuntimeStatusView(remoteStatus)
  // Unified status badge (2026-12): same pill vocabulary as the local branch.
  // The projection suppresses the ok badge for blocked/failed states, so no
  // extra view-kind guard is needed here. While a USER check is in flight the
  // badge shows the checking pill AND the status line is suppressed (see the
  // render condition below) — exactly the presentation the local branch shows
  // while its main-process check runs (phase 'checking' → checking badge,
  // status copy null). Display-only overlay tied to the in-flight pull; the
  // server-side machine state itself stays idle. It cannot mask blocked/
  // failed states: the check button is machine-phase disabled there
  // (checkMachineBusy), so a check cannot start from those states.
  const badge: RuntimeBadgeView | null = checkingVersions
    ? { label: 'checking', tone: 'busy' }
    : projectRemoteRuntimeBadge(remoteStatus)
  const statusText = useMemo(() => {
    if (view === null) return null
    const title = t(view.titleKey, view.params)
    return view.detail !== null && view.detail !== ''
      ? `${title}：${view.detail}`
      : title
  }, [view, t])
  // Idle has no claim line (已是最新/可用 verdicts removed, 2026-12): the
  // healthy state is carried by the badge alone. Pending keeps its detail
  // line ("将于下次启动切换到 vX") like the local branch. While a USER check
  // is in flight the status line is suppressed together with the checking
  // badge — mirroring the local branch's checking-phase presentation (its
  // status copy is null while the main-process check runs).
  const statusTextVisible = view !== null
    && !checkingVersions
    && (view.kind !== 'idle' || remoteStatus?.phase === 'pending')

  const remoteProgress = remoteStatus?.progress ?? null
  const remoteShowProgress = remoteProgress !== null
    || remoteStatus?.phase === 'installing' || remoteStatus?.phase === 'applying'
  const remoteProgressPercent = remoteProgress?.stage === 'download'
    && typeof remoteProgress.total === 'number' && remoteProgress.total > 0
    ? Math.min(100, Math.max(0, Math.round(((remoteProgress.received ?? 0) / remoteProgress.total) * 100)))
    : null
  const remoteProgressLabel = useMemo(() => {
    if (remoteProgress?.stage === 'download') {
      return remoteProgressPercent !== null
        ? t('dshRuntimeProgressDownloading', { percent: remoteProgressPercent })
        : t('dshRuntimeProgressDownloadingIndeterminate')
    }
    switch (remoteProgress?.stage) {
      case 'install': return t('dshRuntimeProgressInstalling')
      case 'prune': return t('dshRuntimeProgressPruning')
      case 'smoke': return t('dshRuntimeProgressSmoke')
      case 'publish': return t('dshRuntimeProgressPublishing')
      default: return t('dshRuntimeProgressApplying')
    }
  }, [remoteProgress, remoteProgressPercent, t])

  const remoteSnapshotText = remoteStatus === null
    ? null
    : remoteStatus.snapshotError !== null
      ? t('dshRuntimeSnapshotFailed', { error: remoteStatus.snapshotError })
      : remoteStatus.restoreOutcome === 'half'
        ? t('dshRuntimeSnapshotRestoreHalf')
        : remoteStatus.restoreOutcome === 'incomplete' || remoteStatus.restoreInProgress === true
          ? t('dshRuntimeSnapshotRestoreIncomplete')
          : remoteStatus.snapshotCount === null
            ? t('dshRuntimeSnapshotUnknown')
            : t('dshRuntimeSnapshotSummary', {
                count: remoteStatus.snapshotCount,
                at: remoteStatus.latestSnapshotAt !== null
                  ? formatTimestamp(remoteStatus.latestSnapshotAt)
                  : t('dshRuntimeSnapshotNever'),
              })

  // D1-A 未分类残留桶：shared 面已含必填 unclassifiedBytes（parseDiskUsage
  // 对旧服务器缺省 0）；diskUsage 本身仍可为 null，故保留可选链与 ?? 0。
  const remoteUnclassifiedBytes = remoteStatus?.diskUsage?.unclassifiedBytes ?? 0

  const remoteRestartDisabled = remoteGates.restartDisabled

  // 重启 dsh（2026-12 布局修订）：按钮移入版本选择行（与 select 同一行高
  // 基线）；加载/不可达分支仍单独展示。反馈行（note/error）跟随按钮位置。
  const restartButton = (
    <Button variant="outline" size="sm"
      onClick={() => { void onRestartDsh() }}
      disabled={remoteRestartDisabled}
    >
      {restarting ? t('dshRuntimeRestarting') : t('dshRuntimeRestartAction')}
    </Button>
  )
  const restartFeedback = (
    <>
      {restartNote !== null && <p className={css.generalHint} role="status">{restartNote}</p>}
      {actionError !== null && <p className={css.generalError} role="alert">{actionError}</p>}
    </>
  )

  if (remoteStatus === null) {
    return (
      <div className={css.generalGroup}>
        <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>
        {statusError !== null ? (
          <>
            <p className={css.generalError} role="alert">{t('dshRuntimeRemoteUnavailable')}</p>
            <p className={css.generalError} role="alert">{statusError}</p>
          </>
        ) : (
          <p className={css.generalHint} role="status">{t('dshRuntimeRemoteLoading')}</p>
        )}
        {restartButton}
        {restartFeedback}
      </div>
    )
  }

  return (
    <div className={css.generalGroup}>
      <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>

      <div className={css.updateVersionRow}>
        <p className={css.updateRow}>
          {t('updateCurrentVersion', { version: remoteStatus.activeVersion ?? t('dshRuntimeVersionUnknown') })}
          {/* Unified coloured status badge (2026-12): replaces the plain phase
              chip; blocked/failed states project their own danger badge. */}
          {badge !== null && <RuntimeBadge view={badge} t={t} />}
        </p>
      </div>
      {statusTextVisible && (
        <div className={css.updateStatus} aria-live="polite">
          <p className={css.updateStatusText}>{statusText}</p>
        </div>
      )}
      {remoteShowProgress && (
        <div className={css.runtimeProgressBlock} role="status" aria-live="polite">
          <span className={css.runtimeProgressLabel}>{remoteProgressLabel}</span>
          <div className={css.runtimeProgressTrack}>
            <div
              className={remoteProgressPercent === null ? css.runtimeProgressBarIndeterminate : css.runtimeProgressBar}
              style={remoteProgressPercent === null ? undefined : { width: `${remoteProgressPercent}%` }}
            />
          </div>
        </div>
      )}
      {remoteStatus.activeVersion !== null && remoteStatus.builtinVersion !== null
        && remoteStatus.activeVersion !== remoteStatus.builtinVersion && (
        /* 部署锚口径（2026-12 修正，design 18 §3.6 A1）：gateway 的"内建"是
           部署者经 --dsh-path 提供的锚，不是随包版本——不再复用 local 的
           「随应用内建」文案。 */
        <p className={css.generalHint}>{t('dshRuntimeDeployAnchorRow')} v{remoteStatus.builtinVersion}</p>
      )}
      {remoteStatus.diskError !== null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeDiskError', { error: remoteStatus.diskError })}
        </p>
      )}
      {remoteStatus.diskLimitExceeded === true && remoteStatus.diskLimitBytes !== null && (
        <p className={css.generalError} role="status">
          {t('dshRuntimeDiskQuotaWarning', { limit: formatRuntimeBytes(remoteStatus.diskLimitBytes) })}
        </p>
      )}

      {statusError !== null && <p className={css.generalHint} role="status">{statusError}</p>}
      {remoteStatus.connectionState !== null && remoteStatus.connectionState !== 'ready' && (
        <p className={css.generalHint} role="status">
          {t('dshRuntimeRemoteConnState', { state: remoteStatus.connectionState })}
        </p>
      )}
      {envGatedRemote && <p className={css.generalHint}>{t('dshRuntimeRemoteEnvHint')}</p>}
      {/* 元数据损坏提示行（2026-12 recover-metadata 对齐，与 local 分支同构
          文案；旧服务器不投影字段 → 不渲染）。 */}
      {remoteMetadataBlocked && (
        <>
          <p className={css.generalError} role="alert">
            {t(
              remoteStatus.metadataHealth === 'recovery-marker-corrupt'
                ? 'dshRuntimeMetadataMarkerCorrupt'
                : remoteStatus.metadataHealth === 'recovery-in-progress'
                  ? 'dshRuntimeMetadataRecoveryInProgress'
                  : 'dshRuntimeMetadataBlocked',
              { components: metadataComponentsText },
            )}
          </p>
          <p className={css.generalHint}>{t('dshRuntimeMetadataEvidenceHint')}</p>
          {remoteStatus.metadataHealth === 'recovery-marker-corrupt' && canRecoverMetadataRemote && (
            <p className={css.generalHint}>{t('dshRuntimeMetadataMarkerRescueHint')}</p>
          )}
        </>
      )}
      {/* Failure rows stay honest and separate when the status line does not
          already carry them (a failed view renders operationError in its
          title; a blocked view renders startupBlockedReason in its detail). */}
      {view !== null && view.kind !== 'failed' && remoteStatus.operationError !== null
        && remoteStatus.operationError !== '' && (
        <p className={css.generalError} role="alert">{remoteStatus.operationError}</p>
      )}
      {view !== null && view.kind !== 'blocked' && remoteStatus.startupBlockedReason !== null
        && remoteStatus.startupBlockedReason !== '' && (
        <p className={css.generalError} role="alert">{remoteStatus.startupBlockedReason}</p>
      )}

      <h4 className={clsx(css.generalGroupTitle, css.generalGroupTitleBlock)}>{t('dshRuntimeGroupActions')}</h4>

      {/* 2026-12 D 小项②：「选择版本」字段 label 删除（select 以
          aria-label 保持可访问名称）。 */}
      <div className={css.generalRow}>
        <div className={css.runtimeSelectRow}>
          <span className={css.runtimeSelectWrap}>
            <select
              id={selectVersionId}
              className={clsx(css.runtimeField, css.runtimeSelect)}
              aria-label={t('dshRuntimeSelectVersion')}
              value={chosenRemote ?? ''}
              disabled={mutationDisabled}
              onChange={(event) => {
                selectionExplicit.current = true
                setSelectedRemote(event.target.value)
              }}
            >
              {sortedVersions.length === 0
                ? <option value="" disabled>{t('dshRuntimeNoVersions')}</option>
                : sortedVersions.map((entry) => (
                  <option key={entry.version} value={entry.version}>
                    v{entry.version}
                    {entry.version === remoteActive ? ` · ${t('current')}` : ''}
                    {entry.version === remoteStatus?.builtinVersion ? ` · ${t('dshRuntimeBuiltinTag')}` : ''}
                    {entry.cached ? ` · ${t('dshRuntimeCachedTag')}` : ''}
                  </option>
                ))}
            </select>
            <IconChevronDownOutline14 className={css.runtimeSelectChevron} aria-hidden="true" />
          </span>
          {/* 更新/切换到 vX 仅在选择版本 ≠ 当前版本时显示（2026-12 修订：
              与当前版本一致时按钮是必然 no-op，不常驻）。忙碌期间选中版本
              仍 ≠ 当前版本，按钮保持可见（带「正在应用…」文案）仅禁用。
              方案 2 镜像：选中「内建版本」行且未装受管树时主按钮为
              「恢复内建」（回到内建锚，零下载）。 */}
          {!isActiveRemote && chosenRemote !== null && (
            <Button variant="primary" size="sm"
              onClick={() => { void (remoteBuiltinGuide ? onRestoreBuiltin() : onApplySelected()) }}
              disabled={remoteBuiltinGuide
                ? (mutationDisabled || restoreBuiltinDisabled)
                : mutationDisabled}
            >
              {remoteBuiltinGuide
                ? t('dshRuntimeResetBuiltin')
                : actionBusy
                  ? t('dshRuntimeRemoteApplying')
                  : `${gatewayDirection === 'rollback' ? t('dshRuntimeActionSwitch') : t('dshRuntimeActionUpdate')} v${chosenRemote}`}
            </Button>
          )}
          {restartButton}
        </div>
        {/* 方案 2 引导行（gateway 镜像，与 local 分支统一）：说明内建锚已存在
            （恢复内建零下载），并把「仍下载并安装为受管版本」保留为显式次要
            动作。 */}
        {remoteBuiltinGuide && (
          <div className={css.updateStatusLine}>
            <span className={css.generalHint} role="status">
              {t('dshRuntimeAnchorGuideHint', { version: chosenRemote ?? '' })}
            </span>
            <Button variant="outline" size="sm"
              onClick={() => { void onApplySelected() }}
              disabled={mutationDisabled}
            >
              {t('dshRuntimeInstallBuiltinTree', { version: chosenRemote ?? '' })}
            </Button>
          </div>
        )}
        {restartFeedback}
      </div>

      {/* The merged primary action installs (if needed) and arms the switch —
          the next-launch semantics the button label no longer spells out.
          2026-12 复审：hint 随按钮可见性渲染（按钮隐藏时无对象）；方案 2
          引导态下由引导行文案取代。 */}
      {!isActiveRemote && chosenRemote !== null && !remoteBuiltinGuide && (
        <p className={css.generalHint}>{t('dshRuntimeApplyNextLaunchHint')}</p>
      )}

      {/* 登记偏差（审查 F1）：gateway 的「检查更新」是只读拉取，失败不进入
          机器 error 相位——错误只在此行呈现、徽标仍反映服务端真实状态；而
          local 的检查是主进程状态机事务，失败会推入 error 相位（红徽标 +
          状态行 + 版本源错误行，主进程原文）。此为数据路径语义差异：gateway
          的 /chamber/runtime 无 checking/error 相位机，故意保持机器状态不
          变（读取失败不改变运行状态），UI 以本行诚实呈现失败。 */}
      {versionsError !== null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeRemoteVersionsUnavailable', { error: versionsError })}
        </p>
      )}
      {/* 2026-12 (review fix): a 200 response with an embedded registry error
          (server fell back to the cached list) must be visible, never a
          silent stale list. */}
      {versionsError === null && remoteVersions?.error != null && (
        <p className={css.generalHint} role="status">
          {t('dshRuntimeRemoteVersionsUnavailable', { error: remoteVersions.error })}
        </p>
      )}

      {/* Pending = the gateway's apply-now window (design 18 addendum
          §5.1/§6.1): the immediate-switch primary action appears only while
          the server-side gates are open (not busy/recovery/env/read-only
          and the managed dsh live). 2026-12 unified with the local branch:
          its own block, then the pending record line with local semantics. */}
      {remoteStatus.phase === 'pending' && remoteStatus.pending !== null && !remoteGates.applyNowDisabled && (
        <div className={css.updateStatusLine}>
          <Button variant="primary" size="sm"
            onClick={() => { void onApplyNowRemote() }}
          >
            {t('dshRuntimeApplyNowAction')}
          </Button>
        </div>
      )}
      {remoteStatus.pending !== null && remoteStatus.phase !== 'pending' && remoteStatus.phase !== 'applying' && (
        <p className={css.generalHint}>{t('dshRuntimePendingRecord', { version: remoteStatus.pending })}</p>
      )}

      <div className={css.updateStatusLine}>
        {canRestorePreRollbackRemote && (
          <Button variant="outline" size="sm"
            onClick={() => { void onRestorePreRollbackRemote() }}
            disabled={mutationDisabled}
          >
            {t('dshRuntimeRestorePreRollback')}
          </Button>
        )}
        {canRecoverMetadataRemote && (
          <Button variant="outline" size="sm"
            onClick={() => { void onRecoverMetadataRemote() }}
            disabled={recoverMetadataDisabled}
          >
            {t('dshRuntimeRecoverMetadata')}
          </Button>
        )}
        {/* 恢复内建仅在与内建版本不一致（或普通 pending 逃生口）时显示（2026-12 修订 + 2026 audit R2 收窄：recovery 相位/忙碌窗不显示）。 */}
        {restoreBuiltinVisible && !remoteBuiltinGuide && (
          <Button variant="outline" size="sm"
            onClick={() => { void onRestoreBuiltin() }}
            disabled={restoreBuiltinDisabled}
          >
            {t('dshRuntimeResetBuiltin')}
          </Button>
        )}
        {canRetryApplyRemote && (
          <Button variant="outline" size="sm" onClick={() => { void onRetryApply() }} disabled={retryApplyDisabled}>
            {t('dshRuntimeRetryApply')}
          </Button>
        )}
        {canRetryRestoreRemote && (
          <Button variant="outline" size="sm" onClick={() => { void onRetryRestore() }} disabled={retryRestoreDisabled}>
            {t('dshRuntimeRetryRestore')}
          </Button>
        )}
      </div>

      {/* 常驻「清理已安装版本」入口（2026-12 统一，与 local 分支同构）：
          候选 = 服务端 removableVersions；旧服务器不投影该字段 → 行隐藏。
          用户检查期间隐藏（local 分支的该行随动作集清空卸载——两侧同口径，
          见 remoteGates 注释）。 */}
      {(remoteVersions?.removableVersions ?? []).length > 0 && !checkingVersions && (
        <div className={css.updateStatusLine}>
          <span className={css.generalHint}>{t('dshRuntimeCleanupCandidatesLabel')}</span>
          {(remoteVersions?.removableVersions ?? []).map((version) => (
            <Button variant="outline" size="sm"
              key={version}
              disabled={mutationDisabled}
              title={t('dshRuntimeCleanupConfirmTitle', { version })}
              onClick={() => { onCleanupRemote(version) }}
            >
              {t('dshRuntimeCleanupVersion')} v{version}
            </Button>
          ))}
        </div>
      )}

      {remoteStatus.failure !== null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeFailureRecord', {
            version: remoteStatus.failure.version,
            at: formatTimestamp(remoteStatus.failure.at),
            reason: remoteStatus.failure.reason,
          })}
        </p>
      )}

      <h4 className={clsx(css.generalGroupTitle, css.generalGroupTitleBlock)}>{t('dshRuntimeGroupSource')}</h4>

      {/* 2026-12 修订：h4 块标题即「版本源」，内联字段标签删除（select 用
          aria-label 保持可访问名称）；外层 label 改为 div——select 与按钮
          不可同处一个 label（HTML 规范：labeled control 之外不得含其他
          labelable 元素，按钮点击会触发 label 隐式激活转发）。 */}
      <div className={css.generalRow}>
        {registryEditing ? (
          <div className={css.runtimeSelectRow}>
            <span className={css.runtimeSelectWrap}>
              <select
                className={clsx(css.runtimeField, css.runtimeSelect)}
                aria-label={t('dshRuntimeRegistryLabel')}
                value={registrySelection}
                disabled={mutationDisabled}
                onChange={(event) => {
                  const value = event.target.value
                  setRegistrySelection(value)
                  if (value !== CUSTOM_REGISTRY) setCustomOrigin('')
                }}
              >
                <option value={NPMJS}>{t('dshRuntimeRegistryNpmjs')}</option>
                <option value={NPMMIRROR}>{t('dshRuntimeRegistryNpmmirror')}</option>
                <option value={CUSTOM_REGISTRY}>{t('dshRuntimeRegistryCustomLabel')}</option>
              </select>
              <IconChevronDownOutline14 className={css.runtimeSelectChevron} aria-hidden="true" />
            </span>
            {registrySelection === CUSTOM_REGISTRY && (
              <input
                type="url"
                className={css.runtimeField}
                aria-label={t('dshRuntimeRegistryCustomLabel')}
                value={customOrigin}
                placeholder="https://registry.example.com"
                disabled={mutationDisabled}
                onChange={(event) => setCustomOrigin(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && customOrigin.trim() !== '') {
                    void onApplyRegistry(customOrigin.trim())
                  }
                }}
              />
            )}
            <Button variant="outline" size="sm"
              disabled={mutationDisabled
                || (registrySelection === CUSTOM_REGISTRY && customOrigin.trim() === '')}
              onClick={() => {
                void onApplyRegistry(
                  registrySelection === CUSTOM_REGISTRY ? customOrigin.trim() : registrySelection,
                )
              }}
            >
              {registryBusy ? t('dshRuntimeRegistryApplying') : t('dshRuntimeRegistryApply')}
            </Button>
            <Button variant="outline" size="sm"
              disabled={registryBusy}
              onClick={() => {
                // 2026-12 (review fix): cancel resets the controls to the
                // still-effective origin — a stale unapplied choice must not
                // survive reopening the edit form.
                setRegistryEditing(false)
                setRegistrySelection(registryMode)
                if (registryMode === CUSTOM_REGISTRY) setCustomOrigin(registryOrigin)
                else setCustomOrigin('')
              }}
            >
              {t('dshRuntimeRegistryCancel')}
            </Button>
          </div>
        ) : (
          <div className={css.updateStatusLine}>
            <span className={css.generalHint}>
              {t('dshRuntimeRegistryCurrent', { origin: registryOrigin !== '' ? registryOrigin : '—' })}
            </span>
            <Button variant="outline" size="sm"
              disabled={registryBusy || checkingVersions || checkMachineBusy}
              onClick={onRefreshVersions}>
              {checkingVersions ? t('dshRuntimeRegistryChecking') : t('dshRuntimeRegistryCheck')}
            </Button>
            <Button variant="outline" size="sm"
              disabled={mutationDisabled}
              onClick={() => setRegistryEditing(true)}
            >
              {t('dshRuntimeRegistryEdit')}
            </Button>
          </div>
        )}
      </div>

      {registryError !== null && <p className={css.generalError} role="alert">{registryError}</p>}
      {remoteStatus.registryError !== null && (
        <p className={css.generalError} role="alert">{remoteStatus.registryError}</p>
      )}

      {/* 数据快照 + 运行时占用（D6-A，2026-12 用户拍板）：紧凑事实块移出
          「当前状态」，置于「版本源」块内容之后、段尾（与版本源错误行同
          区域，发丝线分隔）；快照行 = 标签 + 值，磁盘行文案带头
          「运行时占用 {total}」，unclassifiedBytes>0 时追加未分类残留。 */}
      {(remoteSnapshotText !== null || remoteStatus.diskUsage !== null) && (
        <div className={clsx(css.generalGroupTitleBlock, css.runtimeDiskFacts)}>
          {remoteSnapshotText !== null && (
            <div className={css.runtimeFactRow}>
              <span className={css.runtimeFactLabel}>{t('dshRuntimeSnapshotLabel')}</span>
              <span className={css.runtimeFactValue}>{remoteSnapshotText}</span>
            </div>
          )}
          {remoteStatus.diskUsage !== null && (
            <div className={css.runtimeFactRow}>
              <span className={css.runtimeFactValue}>
                {t('dshRuntimeDiskSummary', {
                  total: formatRuntimeBytes(remoteStatus.diskUsage.totalBytes),
                  trees: remoteStatus.diskUsage.versionTrees,
                  treeBytes: formatRuntimeBytes(remoteStatus.diskUsage.versionTreeBytes),
                  storeBytes: formatRuntimeBytes(remoteStatus.diskUsage.storeBytes),
                  cacheBytes: formatRuntimeBytes(
                    remoteStatus.diskUsage.cacheBytes
                    + remoteStatus.diskUsage.installHomeBytes
                    + remoteStatus.diskUsage.xdgCacheBytes
                    + remoteStatus.diskUsage.workBytes,
                  ),
                  snapshotBytes: formatRuntimeBytes(remoteStatus.diskUsage.snapshotBytes),
                  recoveryBytes: formatRuntimeBytes(
                    remoteStatus.diskUsage.preRollbackBytes
                    + remoteStatus.diskUsage.restoreBackupBytes
                    + remoteStatus.diskUsage.failureBytes,
                  ),
                })}
                {remoteUnclassifiedBytes > 0
                  && t('dshRuntimeDiskUnclassified', { unclassifiedBytes: formatRuntimeBytes(remoteUnclassifiedBytes) })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function DshRuntimeSection({
  t,
  instanceSource = 'local',
  chamberInstanceId,
}: DshRuntimeSectionProps) {
  // Per-instance labelledby ids (useId): N-ctx shells mount one settings panel
  // each in the SAME document — a static id would alias across panels.
  const selectVersionId = useId()
  const state = useSyncExternalStore(subscribeRuntimeState, getRuntimeState)
  const settingsStatus = useSyncExternalStore(subscribeSettings, getSettingsStatus)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartNote, setRestartNote] = useState<string | null>(null)
  // True only while a user-triggered apply-now transaction is in flight — the
  // honest window copy for the applying phase (design 18 addendum §6.2/§6.3).
  const [applyNowInFlight, setApplyNowInFlight] = useState(false)
  const restartPollAbort = useRef<AbortController | null>(null)
  // Synchronous re-entry gate: the async state update cannot stop a double
  // click in the same frame (V2 review M3).
  const restartingRef = useRef(false)
  useEffect(() => () => { restartPollAbort.current?.abort() }, [])
  const [selected, setSelected] = useState<string | null>(null)
  const selectionExplicit = useRef(false)
  const [customOrigin, setCustomOrigin] = useState('')
  const [registrySelection, setRegistrySelection] = useState(NPMJS)
  const [registryEditing, setRegistryEditing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [originError, setOriginError] = useState<string | null>(null)
  const [testingRegistry, setTestingRegistry] = useState(false)
  const testInFlight = useRef(false)
  const [applyingRegistry, setApplyingRegistry] = useState(false)

  // ---- the section's ONE in-app confirmation (2026-09-11 upstream-alignment T2) ----
  //
  // The armed request and its pending flag live above the shape branch, so the
  // local restart and every gateway mutation share one dialog, one cancel path
  // and one pending discipline. The transitions are the pure machine in
  // ./confirm-machine.ts: arming runs nothing, a cancel drops the request before
  // its runner is ever called, and an accept launches exactly one runner (the
  // synchronous ref mirrors the rest of this section's same-frame fences — React
  // state is not a synchronous mutex).
  const [confirmState, setConfirmState] = useState<ConfirmState<RuntimeConfirmRequest>>(IDLE_CONFIRM)
  const confirmLaunchRef = useRef(false)
  const askConfirm = useCallback((request: RuntimeConfirmRequest) => {
    setConfirmState(armConfirm(request))
  }, [])
  const cancelConfirm = useCallback(() => {
    setConfirmState(cancelConfirmStep)
  }, [])
  const acceptConfirm = useCallback(() => {
    if (confirmLaunchRef.current) return
    const launched = acceptConfirmStep(confirmState, (run) => {
      confirmLaunchRef.current = true
      // The runners own their own failure reporting (the gateway ones through
      // runRemoteAction, the restart through its own catch); the defensive catch
      // keeps a runner that breaks that contract from vanishing as an unhandled
      // rejection while the dialog is armed.
      void run()
        .catch((error: unknown) => { setActionError(errorMessage(error)) })
        .finally(() => {
          confirmLaunchRef.current = false
          setConfirmState(IDLE_CONFIRM)
        })
    })
    setConfirmState(launched)
  }, [confirmState])

  const runtime = currentRuntimeSurface()
  const hydrated = state !== null
  const active = state?.active ?? null
  const bundled = state?.bundled ?? null
  const pending = state?.pending ?? null
  const phase = state?.phase ?? 'idle'
  const versions = state?.versions ?? []
  const source = state?.source ?? 'bundled'
  const envGated = source === 'env'
  const managementGated = state?.managementSupported === false
  const actions = useMemo(() => new Set(runtimeAllowedActions(state)), [state])

  const registryOrigin = settingsStatus?.settings.registryOrigin ?? NPMJS
  const registryMode = registryOrigin === NPMJS || registryOrigin === NPMMIRROR
    ? registryOrigin
    : CUSTOM_REGISTRY

  useEffect(() => {
    setRegistrySelection(registryMode)
    if (registryMode === CUSTOM_REGISTRY) setCustomOrigin(registryOrigin)
  }, [registryMode, registryOrigin])

  // Preserve an explicit choice across pushes. Before the user chooses, the
  // picker preselects the active version (the default no-override state's
  // active version IS the bundled one — "default follows the built-in"); the
  // bundled version is the safe default only when no active version exists.
  useEffect(() => {
    if (!hydrated) return
    setSelected((current) => {
      const currentStillExplicit = selectionExplicit.current
        && current !== null
        && versions.some((entry) => entry.version === current)
      if (!currentStillExplicit) selectionExplicit.current = false
      return preferredRuntimeVersion(
        currentStillExplicit ? current : null,
        versions,
        state?.latest ?? null,
        active,
        bundled,
      )
    })
  }, [active, bundled, hydrated, state?.latest, versions])

  const chosen = preferredRuntimeVersion(
    selectionExplicit.current ? selected : null,
    versions,
    state?.latest ?? null,
    active,
    bundled,
  )
  const isActive = chosen !== null && chosen === active
  const selectionDirection = runtimeSelectionDirection(chosen, active)
  // 常驻「清理已安装版本」候选（2026-12 统一）：显式安装台账中非当前激活、
  // 非待应用的版本；受保护项（known-good/失败现场/回退目标等）由主进程在
  // 删除点权威裁决并如实报错。
  const cleanupCandidates = useMemo(() => {
    if (envGated) return []
    return (state?.explicitlyInstalledVersions ?? [])
      .filter((version) => version !== active && version !== pending)
      .sort((a, b) => compareSemver(b, a) ?? 0)
  }, [envGated, state, active, pending])

  const runRuntimeAction = useCallback(async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await task()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [])

  // 重启 dsh（design 18 §3.6 项 8）：受控进程重启刷新插件挂载；指针/版本树
  // 不动。local = 事务化 control-plane restartLocal()；gateway = 该 server 的
  // /chamber/runtime/restart（202 + status 轮询）。
  // 确认（多用户中断）走本段唯一的应用内对话框（2026-09-11 upstream-alignment
  // T2；原先是浏览器原生确认框）：两种形态同一个 Modal，因为原生 chrome 既套不上
  // 面板的 --dsw-alias-* 词汇，也不属于这个多壳文档。文案按形态分键：
  // gateway 源使用 dshRuntimeRestartGatewayConfirm（含「其他用户的会话将短暂
  // 断开」，与 connections 卡片受控重启确认
  // settings-connections locales restartManagedDshConfirmDescription 同语义；
  // CS 卡文案为准，两处改语义先改 CS 卡）；local 源用简短键
  // dshRuntimeRestartConfirm（本机实例无多用户影响）。
  const canRestartDsh = runtimeRestartAllowed(state)
  /** The confirmed restart itself: runs only after the dialog's confirm click. */
  const runRestartDsh = useCallback(async (): Promise<void> => {
    if (restartingRef.current) return
    restartingRef.current = true
    setRestarting(true)
    setActionError(null)
    setRestartNote(null)
    try {
      if (instanceSource === 'local') {
        const surface = currentRuntimeSurface()
        if (surface !== null) {
          await surface.restart()
        } else {
          // Bridge torn down between render and click: never claim a
          // restart that cannot run (review fix).
          throw new Error('runtime surface unavailable')
        }
      } else if (instanceSource === 'gateway' && chamberInstanceId !== undefined) {
        const response = await fetch(`/api/i/${chamberInstanceId}/chamber/runtime/restart`, { method: 'POST' })
        if (response.status !== 202) {
          // Surface the server's own reason (round-3 fix): the route answers
          // 409 with a specific error ('managed dsh is not running (stopped)…',
          // 'runtime activation in progress…', 'a restart is already in flight')
          // that must reach the user instead of a bare status code.
          let serverReason = ''
          try {
            const body = await response.json() as { error?: unknown }
            if (typeof body.error === 'string' && body.error !== '') serverReason = body.error
          } catch { /* non-JSON body — fall back to the status */ }
          throw new Error(serverReason !== '' ? `restart refused: ${serverReason}` : `restart refused (${response.status})`)
        }
        restartPollAbort.current?.abort()
        const pollController = new AbortController()
        restartPollAbort.current = pollController
        await pollGatewayReady(chamberInstanceId, pollController.signal)
      } else {
        // Defensive (review fix): a source/id mismatch must never fall
        // through to the success note for a restart that cannot run.
        throw new Error('runtime restart unavailable for this source')
      }
      setRestartNote(t('dshRuntimeRestarted'))
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      restartingRef.current = false
      setRestarting(false)
    }
  }, [t, instanceSource, chamberInstanceId])
  const onRestartDsh = useCallback((): void => {
    if (restartingRef.current) return
    askConfirm({
      title: t('dshRuntimeRestartAction'),
      description: t(instanceSource === 'gateway'
        ? 'dshRuntimeRestartGatewayConfirm'
        : 'dshRuntimeRestartConfirm'),
      confirmLabel: t('dshRuntimeRestartAction'),
      pendingLabel: t('dshRuntimeRestarting'),
      run: runRestartDsh,
    })
  }, [askConfirm, t, instanceSource, runRestartDsh])

  const onInstall = useCallback(() => {
    if (runtime === null || chosen === null || isActive || envGated || !actions.has('install')) return
    void runRuntimeAction(() => runtime.install(chosen))
  }, [runtime, chosen, isActive, envGated, actions, runRuntimeAction])

  const onReset = useCallback(() => {
    if (runtime === null || envGated || !actions.has('reset-builtin')) return
    void runRuntimeAction(() => runtime.resetBuiltin())
  }, [runtime, envGated, actions, runRuntimeAction])

  // Apply now (design 18 addendum §2.1/§4.1): run the pending activation
  // transaction in the current session. 2026-09-11 upstream-alignment T2: the
  // local runtime surface (desktop main) still owns its own confirmation for
  // this transaction — it is resolved INSIDE the surface call, never in this
  // panel — so the section deliberately adds none on top of it: a second prompt
  // here would double-ask for one action. Every confirmation the SECTION itself
  // performs is the one in-app dialog above; which layer confirms an action is
  // unchanged by T2 (the gateway shape's confirmations moved from
  // a native browser confirm to that dialog). The surface confirmation is async, so a
  // synchronous ref gate prevents a same-frame double-click from stacking a
  // second IPC/confirm (design 18 addendum §6.2).
  const applyNowRef = useRef(false)
  const onApplyNow = useCallback(() => {
    if (applyNowRef.current) return
    // Re-resolve the surface at click time: a bridge torn down between render
    // and click must never claim an apply that cannot run.
    const surface = currentRuntimeSurface()
    if (surface === null || envGated || !actions.has('apply-now') || pending === null) return
    applyNowRef.current = true
    setApplyNowInFlight(true)
    void runRuntimeAction(() => surface.applyNow()).finally(() => {
      setApplyNowInFlight(false)
      applyNowRef.current = false
    })
  }, [envGated, actions, pending, runRuntimeAction])

  const onRetryApply = useCallback(() => {
    if (runtime === null || envGated || state?.canRetryApply !== true || !actions.has('retry-apply')) return
    void runRuntimeAction(() => runtime.retryApply())
  }, [runtime, envGated, state, actions, runRuntimeAction])

  const onRetryRestore = useCallback(() => {
    if (runtime === null || state?.canRetryRestore !== true || !actions.has('retry-restore')) return
    void runRuntimeAction(() => runtime.retryRestore())
  }, [runtime, state, actions, runRuntimeAction])

  const onRecoverMetadata = useCallback(() => {
    if (runtime === null || !actions.has('recover-metadata')) return
    void runRuntimeAction(() => runtime.recoverMetadata())
  }, [runtime, actions, runRuntimeAction])

  const onRestorePreRollback = useCallback(() => {
    if (runtime === null || !actions.has('restore-pre-rollback')) return
    void runRuntimeAction(() => runtime.restorePreRollback(state?.preRollbackLatestName ?? ''))
  }, [runtime, actions, state, runRuntimeAction])

  const onCleanupVersionDirect = useCallback((version: string) => {
    if (runtime === null || envGated || !actions.has('cleanup-version')) return
    void runRuntimeAction(() => runtime.cleanupVersion(version))
  }, [runtime, envGated, actions, runRuntimeAction])

  // 失败现场显式清除（D3-A，2026-12 用户拍板）：主进程权威删除该版本的
  // failures/*.json 记录；surface 在点击时刻重取——桥接在渲染与点击之间
  // 拆除时绝不能谎报清除成功（与 apply-now 同纪律）。clearFailure 已是真实
  // RuntimeSurface 成员（renderer/preload/main 并行落地，2026-12）。
  const onClearFailure = useCallback(() => {
    const failure = state?.failure
    if (failure == null) return
    const surface = currentRuntimeSurface()
    if (surface === null) return
    void runRuntimeAction(() => surface.clearFailure(failure.version))
  }, [state, runRuntimeAction])

  const onApplyRegistry = useCallback(async (
    origin: string,
    inline: boolean,
  ): Promise<{ ok: boolean; cancelled: boolean }> => {
    if (envGated || !actions.has('check')) return { ok: false, cancelled: false }
    setBusy(true)
    setApplyingRegistry(true)
    setRegistryError(null)
    setOriginError(null)
    try {
      const result = await applySettingsPatch({ registryOrigin: origin })
      if (!result.ok) {
        // The confirm dialog was declined — not an error; the caller reverts
        // the edit form so it never claims an origin that was not applied.
        if (result.code === 'cancelled') {
          // 2026-12 (review fix): the native confirm was declined — close the
          // edit form and reset the controls to the still-effective origin so
          // a stale unapplied choice never survives.
          setRegistryEditing(false)
          setRegistrySelection(registryMode)
          if (registryMode === CUSTOM_REGISTRY) setCustomOrigin(registryOrigin)
          else setCustomOrigin('')
          return { ok: false, cancelled: true }
        }
        // A validation failure is an inline field error on the custom origin;
        // any other apply failure surfaces on the general registry line.
        const error = localizeRegistryError(result.code, result.error, t)
        if (inline) setOriginError(error)
        else setRegistryError(error)
        return { ok: false, cancelled: false }
      }
      // Success closes the edit form (2026-12 unified edit-mode registry row).
      setRegistryEditing(false)
      return { ok: true, cancelled: false }
    } catch (error) {
      const message = errorMessage(error)
      if (inline) setOriginError(message)
      else setRegistryError(message)
      return { ok: false, cancelled: false }
    } finally {
      setApplyingRegistry(false)
      setBusy(false)
    }
  }, [envGated, actions, t, registryMode, registryOrigin])

  const onTestRegistry = useCallback(async (): Promise<void> => {
    if (runtime === null || !actions.has('check')) return
    // 同步 ref 围栏防同帧双击（与 gateway 分支 checkIntent 同一纪律；React
    // state 非同步互斥）。
    if (testInFlight.current) return
    testInFlight.current = true
    setTestingRegistry(true)
    setRegistryError(null)
    try {
      const result = await runtime.check()
      if (result.phase === 'error') {
        setRegistryError(result.error ?? t('dshRuntimeRegistryUnreachable'))
      }
      // Success needs no verdict line (2026-12: registry-verdict copy removed;
      // the refreshed version list is the feedback).
    } catch (error) {
      setRegistryError(errorMessage(error))
    } finally {
      testInFlight.current = false
      setTestingRegistry(false)
    }
  }, [runtime, actions, t])

  const status = useMemo(() => projectRuntimeStatus(state, chosen), [state, chosen])
  const snapshot = useMemo(() => projectRuntimeSnapshot(state), [state])

  const statusText = useMemo(() => {
    const version = status.version ?? '—'
    const detail = status.detail ?? '—'
    switch (status.kind) {
      // 2026-12：registry 结论行全部移除（已是最新/尚未检查/有可用更新/
      // 检查中）——空闲状态只由徽标表达；详情行仅承载真实状态/操作/失败。
      case 'not-checked':
      case 'idle':
      case 'checking':
      case 'available':
        return null
      case 'downloading': return t('dshRuntimeStatusDownloading', { version })
      case 'installing': return t('dshRuntimeStatusInstalling', { version })
      case 'pending': return t('dshRuntimeStatusPending', { version })
      // Honest window copy (design 18 addendum §6.2): while a user-triggered
      // apply-now transaction runs, the status line names the immediate
      // restart instead of the next-launch applying wording; terminal states
      // (applied/rollback/failed) always take over through their own kinds.
      case 'applying': return applyNowInFlight
        ? t('dshRuntimeStatusApplyingNow', { version })
        : t('dshRuntimeStatusApplying', { version })
      case 'applied': return t('dshRuntimeStatusApplied', { version })
      case 'rollback': return t('dshRuntimeStatusRollback', { version, error: detail })
      case 'rollback-complete': return t('dshRuntimeStatusRollbackComplete', { version })
      case 'rollback-half': return t('dshRuntimeStatusRollbackHalf', { version, error: detail })
      case 'restore-incomplete': return t('dshRuntimeStatusRestoreIncomplete', { error: detail })
      case 'swap-attempted': return t('dshRuntimeStatusSwapAttempted', { version, error: detail })
      case 'snapshot-failed': return t('dshRuntimeStatusSnapshotFailed', { error: detail })
      case 'failed': return t('dshRuntimeStatusFailed', { version, error: detail })
      case 'error': return t('dshRuntimeStatusError', { error: detail })
    }
  }, [status, t, applyNowInFlight])

  // 统一彩色状态徽标（2026-12）：local/gateway 同一词汇；blocked/failed 由
  // 投影抑制 ok 徽标。
  const badge = projectRuntimeBadge(state)
  const detailStatusVisible = statusText !== null

  const snapshotText = useMemo(() => {
    switch (snapshot.kind) {
      case 'unknown': return t('dshRuntimeSnapshotUnknown')
      case 'ready': return t('dshRuntimeSnapshotSummary', {
        count: snapshot.count ?? 0,
        at: snapshot.latestAt != null ? formatTimestamp(snapshot.latestAt) : t('dshRuntimeSnapshotNever'),
      })
      case 'failed': return t('dshRuntimeSnapshotFailed', { error: snapshot.detail ?? '—' })
      case 'restore-half': return t('dshRuntimeSnapshotRestoreHalf')
      case 'restore-incomplete': return t('dshRuntimeSnapshotRestoreIncomplete')
    }
  }, [snapshot, t])

  // D1-A 未分类残留桶：渲染层 RuntimeDiskUsage 已含必填 unclassifiedBytes
  // （真实接口落地，2026-12）；diskUsage 本身仍可为 null，保留 ?? 0。
  const diskUnclassifiedBytes = state?.diskUsage?.unclassifiedBytes ?? 0

  const canSelect = actions.has('select-version')
  const canInstall = actions.has('install')
  const canReset = actions.has('reset-builtin')
  // 「恢复内建」可见性（2026-12 修订）：版本一致（active == bundled）时恢复
  // 是 no-op，按钮不显示；pending/applying/snapshot-failed 是持久化事务的
  // 逃生口（可能 active == bundled 但 reset 仍有意——中止待应用切换），保留。
  // active/bundled 任一未知时保守显示（无法判断一致性，宁显不藏）。
  const resetEscapeHatch = phase === 'pending' || phase === 'applying' || phase === 'snapshot-failed'
  const canResetVisible = canReset
    && (resetEscapeHatch || active === null || bundled === null || active !== bundled)
  // 「内建版本」行引导（方案 2，2026-12 用户决策）：下拉选中与随应用内建
  // 同版本的行、存在用户选择（hasOverride）且该版本尚未装成受管树时，主
  // 按钮引导「恢复内建」（回到随应用副本，零下载）——把同版本下载并另装
  // 受管树降级为显式次要动作；该版本已缓存（曾装树）时保持普通切换。
  const builtinGuide = chosen !== null
    && !isActive
    && bundled !== null
    && chosen === bundled
    && state?.hasOverride === true
    && canReset
    && !(versions.some((entry) => entry.version === chosen && entry.cached))
  // Immediate-apply (design 18 addendum §6.1): visible only in the pending
  // phase; env/runtimeBlocked/managementSupported gates are already folded
  // into the action set by runtimeAllowedActions.
  const canApplyNow = actions.has('apply-now')
  const canRetryApply = actions.has('retry-apply') && state?.canRetryApply === true
  const canRetryRestore = actions.has('retry-restore') && state?.canRetryRestore === true
  const canRecoverMetadata = actions.has('recover-metadata') && state?.canRecoverMetadata === true
  const canCheck = actions.has('check')
  const canRestorePreRollback = actions.has('restore-pre-rollback')
    && (state?.preRollbackCount ?? 0) > 0
  const operationDisabled = !hydrated || busy || testingRegistry
  const mutationDisabled = operationDisabled || envGated || managementGated
  const registryDisabled = settingsStatus === null || mutationDisabled || !canCheck
  const metadataComponents = (state?.metadataComponents ?? [])
    .map(component => metadataComponentText(component, t))
    .join(t('dshRuntimeMetadataComponentSeparator')) || t('dshRuntimeMetadataComponentUnknown')

  // Live install progress (design 18 M4): byte-percent while downloading
  // with a declared content-length, stage labels otherwise, and an
  // indeterminate bar during the phase-only windows (installing/applying).
  const progress = state?.progress ?? null
  const installingPhase = phase === 'downloading' || phase === 'installing' || phase === 'applying'
  const showProgress = progress !== null || installingPhase
  const progressPercent = progress?.stage === 'download' && typeof progress.total === 'number' && progress.total > 0
    ? Math.min(100, Math.max(0, Math.round(((progress.received ?? 0) / progress.total) * 100)))
    : null
  const progressLabel = useMemo(() => {
    if (progress?.stage === 'download') {
      return progressPercent !== null
        ? t('dshRuntimeProgressDownloading', { percent: progressPercent })
        : t('dshRuntimeProgressDownloadingIndeterminate')
    }
    switch (progress?.stage) {
      case 'install': return t('dshRuntimeProgressInstalling')
      case 'prune': return t('dshRuntimeProgressPruning')
      case 'smoke': return t('dshRuntimeProgressSmoke')
      case 'publish': return t('dshRuntimeProgressPublishing')
      default: return phase === 'applying'
        ? t('dshRuntimeProgressApplying')
        : phase === 'installing' || phase === 'downloading'
          ? t('dshRuntimeProgressInstalling')
          : t('dshRuntimeProgressDownloadingIndeterminate')
    }
  }, [progress, progressPercent, phase, t])

  // Remote source (design 18 §3.6): gateway = full per-server segment
  // proxied through /chamber/runtime (§9.3).
  if (instanceSource === 'gateway') {
    if (chamberInstanceId === undefined) {
      // Defensive: never render the management surface without a canonical
      // id — a render-time mismatch falls back to the honest unavailable hint.
      return (
        <div className={css.generalGroup}>
          <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>
          <p className={css.generalHint}>{t('dshRuntimeRemoteUnavailable')}</p>
        </div>
      )
    }
    // keyed per server: switching the selected server remounts a fresh section
    // (never the previous server's status/versions/selection).
    return (
      <>
        <GatewayRuntimeSection
          key={chamberInstanceId}
          t={t}
          chamberInstanceId={chamberInstanceId}
          restarting={restarting}
          onRestartDsh={onRestartDsh}
          restartNote={restartNote}
          actionError={actionError}
          setActionError={setActionError}
          askConfirm={askConfirm}
        />
        <RuntimeConfirmDialog
          request={confirmState.request}
          pending={confirmState.pending}
          onCancel={cancelConfirm}
          onConfirm={acceptConfirm}
          t={t}
        />
      </>
    )
  }

  return (
    <div className={css.generalGroup}>
      <h3 className={css.generalGroupTitle}>{t('dshRuntimeTitle')}</h3>

      {!hydrated && (
        <p className={css.generalHint} role="status">{t('dshRuntimeRemoteLoading')}</p>
      )}
      <div className={css.updateVersionRow}>
        <p className={css.updateRow}>
          {t('updateCurrentVersion', {
            version: active === null ? t('dshRuntimeVersionUnknown') : active,
          })}
          {/* 统一彩色状态徽标（2026-12）：与 gateway 分支同一词汇；空闲即
              「运行时正常」，claim 文案（已是最新/尚未检查/有可用更新）已移除。 */}
          {badge !== null && <RuntimeBadge view={badge} t={t} />}
        </p>
      </div>
      {detailStatusVisible && (
        <div className={css.updateStatus} aria-live="polite">
          <p className={css.updateStatusText}>{statusText}</p>
        </div>
      )}
      {showProgress && (
        <div className={css.runtimeProgressBlock} role="status" aria-live="polite">
          <span className={css.runtimeProgressLabel}>{progressLabel}</span>
          <div className={css.runtimeProgressTrack}>
            <div
              className={progressPercent === null ? css.runtimeProgressBarIndeterminate : css.runtimeProgressBar}
              style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}
      {active !== null && bundled !== null && active !== bundled && (
        <p className={css.generalHint}>{t('dshRuntimeBundledRow')} v{bundled}</p>
      )}
      {state?.diskError != null && (
        <p className={css.generalError} role="alert">{t('dshRuntimeDiskError', { error: state.diskError })}</p>
      )}
      {state?.diskLimitExceeded === true && state.diskLimitBytes !== undefined && (
        <p className={css.generalError} role="status">
          {t('dshRuntimeDiskQuotaWarning', { limit: formatRuntimeBytes(state.diskLimitBytes) })}
        </p>
      )}
      {envGated && <p className={css.generalHint}>{t('dshRuntimeEnvHint')}</p>}
      {managementGated && state?.managementUnsupportedReason != null && (
        <p className={css.generalHint} role="status">{state.managementUnsupportedReason}</p>
      )}
      {state?.runtimeBlocked === true
        && (state.metadataHealth === 'selection-corrupt' || state.metadataHealth === 'recovery-in-progress') && (
        <>
          <p className={css.generalError} role="alert">
            {t(
              state.metadataHealth === 'recovery-in-progress'
                ? 'dshRuntimeMetadataRecoveryInProgress'
                : 'dshRuntimeMetadataBlocked',
              { components: metadataComponents },
            )}
          </p>
          <p className={css.generalHint}>{t('dshRuntimeMetadataEvidenceHint')}</p>
        </>
      )}
      {state?.runtimeBlocked === true && state.metadataHealth === 'recovery-marker-corrupt' && (
        <>
          <p className={css.generalError} role="alert">
            {t('dshRuntimeMetadataMarkerCorrupt', { components: metadataComponents })}
          </p>
          {state.canRecoverMetadata === true && (
            <p className={css.generalHint}>{t('dshRuntimeMetadataMarkerRescueHint')}</p>
          )}
        </>
      )}
      {/* 2026-12 (review fix): a blocked projection without a metadata-copy
          row (generic runtimeBlockedReason) must still explain itself — never
          only a red badge with everything disabled. */}
      {state?.runtimeBlocked === true
        && state.runtimeBlockedReason != null
        && state.metadataHealth !== 'selection-corrupt'
        && state.metadataHealth !== 'recovery-in-progress'
        && state.metadataHealth !== 'recovery-marker-corrupt' && (
        <p className={css.generalError} role="alert">{state.runtimeBlockedReason}</p>
      )}
      {state?.invalidationNotice != null && (
        <p className={css.generalHint} role="status">
          {t(
            state.invalidationNotice.recovered
              ? 'dshRuntimeInvalidationRecovered'
              : 'dshRuntimeInvalidationFallback',
            {
              version: state.invalidationNotice.fromVersion ?? '—',
              at: formatTimestamp(state.invalidationNotice.at),
            },
          )}
        </p>
      )}

      <h4 className={clsx(css.generalGroupTitle, css.generalGroupTitleBlock)}>{t('dshRuntimeGroupActions')}</h4>

      {/* 2026-12 修订 + D 小项②：「选择版本」字段 label 删除（select 以
          aria-label 保持可访问名称）；外层仍是 div——select 与按钮不可同处
          一个 label（HTML 规范：labeled control 之外不得含其他 labelable
          元素，按钮点击会触发 label 隐式激活转发到 select）。重启 dsh
          按钮移入本行（与 select 同一 28px 行高基线）。 */}
      <div className={css.generalRow}>
        <div className={css.runtimeSelectRow}>
          <span className={css.runtimeSelectWrap}>
            <select
              id={selectVersionId}
              className={clsx(css.runtimeField, css.runtimeSelect)}
              aria-label={t('dshRuntimeSelectVersion')}
              value={chosen ?? ''}
              disabled={mutationDisabled || !canSelect}
              onChange={(event) => {
                selectionExplicit.current = true
                setSelected(event.target.value)
              }}
            >
              {versions.length === 0
                ? <option value="" disabled>{t('dshRuntimeNoVersions')}</option>
                : versions.map((entry: RuntimeVersionEntry) => (
                  <option key={entry.version} value={entry.version}>
                    v{entry.version}
                    {entry.version === active ? ` · ${t('current')}` : ''}
                    {entry.version === bundled ? ` · ${t('dshRuntimeBuiltinTag')}` : ''}
                    {entry.cached ? ` · ${t('dshRuntimeCachedTag')}` : ''}
                  </option>
                ))}
            </select>
            <IconChevronDownOutline14 className={css.runtimeSelectChevron} aria-hidden="true" />
          </span>
          {/* 更新/切换到 vX 仅在选择版本 ≠ 当前版本时显示（2026-12 修订：
              与当前版本一致时按钮是必然 no-op，不常驻）。相位门控期间
              （downloading/installing/applying 等）canInstall 从动作集消失
              ——按钮保留显示但禁用（与 gateway 分支对齐），忙碌副本「正在
              安装…」与进度条共同呈现操作中状态。 */}
          {!isActive && chosen !== null && (
            <Button variant="primary" size="sm"
              onClick={builtinGuide ? onReset : onInstall}
              disabled={builtinGuide
                ? (mutationDisabled || !canReset)
                : (mutationDisabled || !canInstall)}>
              {/* 方案 2（2026-12 用户决策）：选中「内建版本」行且未装受管树时，
                  主按钮是「恢复内建」（回到随应用副本，零下载）。 */}
              {builtinGuide
                ? t('dshRuntimeResetBuiltin')
                : busy && (phase === 'downloading' || phase === 'installing')
                  ? t('dshRuntimeInstalling')
                  // Unified direction-aware copy (2026-11 review): the downgrade
                  // action is a version SWITCH like any other — 切换到/更新到,
                  // never 回滚到 (the data-restore semantics are decided
                  // server-side by the direction formula, not by the label).
                  : `${selectionDirection === 'rollback' ? t('dshRuntimeActionSwitch') : t('dshRuntimeActionUpdate')} v${chosen}`}
            </Button>
          )}
          {/* 重启 dsh（design 18 §3.6 项 8）：暂态不可用（busy/pending/
              applying 等）时禁用而非隐藏——重启能力本身常驻可见。 */}
          <Button variant="outline" size="sm"
            onClick={() => { void onRestartDsh() }}
            disabled={restarting || !canRestartDsh}
          >
            {restarting ? t('dshRuntimeRestarting') : t('dshRuntimeRestartAction')}
          </Button>
        </div>
        {/* 方案 2 引导行：说明随应用副本已存在（恢复内建零下载），并把「仍
            下载并安装为受管版本」保留为显式次要动作（受管树语义：回滚/
            快照/清理台账的一部分，独立于随应用版本）。 */}
        {builtinGuide && (
          <div className={css.updateStatusLine}>
            <span className={css.generalHint} role="status">
              {t('dshRuntimeBuiltinGuideHint', { version: chosen ?? '' })}
            </span>
            <Button variant="outline" size="sm"
              onClick={onInstall}
              disabled={mutationDisabled || !canInstall}>
              {t('dshRuntimeInstallBuiltinTree', { version: chosen ?? '' })}
            </Button>
          </div>
        )}
        {restartNote !== null && (
          <p className={css.generalHint} role="status">{restartNote}</p>
        )}
        {actionError !== null && <p className={css.generalError} role="alert">{actionError}</p>}
      </div>

      {/* Pending = the apply-now window (design 18 addendum §6.1): the main
          [立即应用 v{version}] action plus the hint that the alternative is
          next launch; [恢复内建] stays in the recovery row below. */}
      {phase === 'pending' && pending !== null && canApplyNow && (
        <>
          <div className={css.updateStatusLine}>
            <Button variant="primary" size="sm"
              onClick={onApplyNow}
              disabled={mutationDisabled}>
              {t('dshRuntimeApplyNowActionWithVersion', { version: pending })}
            </Button>
          </div>
          <p className={css.generalHint}>{t('dshRuntimeApplyNowHint')}</p>
        </>
      )}
      {pending !== null && phase !== 'pending' && phase !== 'applying' && (
        <p className={css.generalHint}>{t('dshRuntimePendingRecord', { version: pending })}</p>
      )}

      {/* 恢复/清理行动行（2026-12 修订）：清理版本独立为下方常驻入口——
          恢复行保持 retry/恢复内建/元数据救援语义连贯。 */}
      {(canRetryApply || canRetryRestore || canRestorePreRollback || canRecoverMetadata || canResetVisible) && (
        <div className={css.updateStatusLine}>
          {canRetryApply && (
            <Button variant="outline" size="sm" onClick={onRetryApply} disabled={mutationDisabled}>
              {t('dshRuntimeRetryApply')}
            </Button>
          )}
          {canRetryRestore && (
            <Button variant="outline" size="sm" onClick={onRetryRestore} disabled={operationDisabled}>
              {t('dshRuntimeRetryRestore')}
            </Button>
          )}
          {canRestorePreRollback && (
            <Button variant="outline" size="sm" onClick={onRestorePreRollback} disabled={mutationDisabled}>
              {t('dshRuntimeRestorePreRollback')}
            </Button>
          )}
          {canRecoverMetadata && (
            <Button variant="outline" size="sm"
              onClick={onRecoverMetadata}
              disabled={mutationDisabled}>
              {t('dshRuntimeRecoverMetadata')}
            </Button>
          )}
          {/* 恢复内建仅在与内建版本不一致（或普通 pending 逃生口）时显示（2026-12 修订 + 2026 audit R2 收窄：recovery 相位/忙碌窗不显示）。 */}
          {canResetVisible && !builtinGuide && (
            <Button variant="outline" size="sm" onClick={onReset} disabled={mutationDisabled}>
              {t('dshRuntimeResetBuiltin')}
            </Button>
          )}
        </div>
      )}

      {/* 常驻「清理已安装版本」入口（2026-12 统一）：不再要求先在下拉选中
          某个版本；每颗胶囊对应一个可清理版本，确认由主进程原生对话框把关，
          受保护项的拒绝以错误行如实呈现。忙碌相位（安装/应用/pending 等）
          动作集不包含 cleanup-version，整行随之隐藏。 */}
      {cleanupCandidates.length > 0 && actions.has('cleanup-version') && (
        <div className={css.updateStatusLine}>
          <span className={css.generalHint}>{t('dshRuntimeCleanupCandidatesLabel')}</span>
          {cleanupCandidates.map((version) => (
            <Button variant="outline" size="sm"
              key={version}
              disabled={mutationDisabled}
              title={t('dshRuntimeCleanupConfirmTitle', { version })}
              onClick={() => { onCleanupVersionDirect(version) }}
            >
              {t('dshRuntimeCleanupVersion')} v{version}
            </Button>
          ))}
        </div>
      )}

      {/* 失败现场保留展示 + 显式清除入口（D3-A，2026-12 用户拍板）：清除
          走主进程权威 clearFailure；gateway 分支不加清除按钮（如无现成
          清除路由，登记偏差）。 */}
      {state?.failure != null && (
        <div className={css.updateStatusLine}>
          <p className={css.generalError} role="alert">
            {t('dshRuntimeFailureRecord', {
              version: state.failure.version,
              at: formatTimestamp(state.failure.at),
              reason: state.failure.reason,
            })}
          </p>
          <Button variant="outline" size="sm"
            disabled={operationDisabled}
            onClick={onClearFailure}>
            {t('dshRuntimeClearFailure')}
          </Button>
        </div>
      )}

      <h4 className={clsx(css.generalGroupTitle, css.generalGroupTitleBlock)}>{t('dshRuntimeGroupSource')}</h4>

      {/* 2026-12 修订 + 统一：registry 行与 gateway 分支同构——只读行
          （当前源 + [检查更新] + [编辑]）⇄ 编辑态（select + 自定义输入 +
          [应用][取消]）；切换源即切换信任边界，桌面侧应用仍走主进程原生
          确认。提示性说明文字（dshRuntimeRegistryHint）已删除。 */}
      <div className={css.generalRow}>
        {registryEditing ? (
          <div className={css.runtimeSelectRow}>
            <span className={css.runtimeSelectWrap}>
              <select
                className={clsx(css.runtimeField, css.runtimeSelect)}
                aria-label={t('dshRuntimeRegistryLabel')}
                value={registrySelection}
                disabled={registryDisabled}
                onChange={(event) => {
                  const value = event.target.value
                  setRegistrySelection(value)
                  if (value !== CUSTOM_REGISTRY) setCustomOrigin('')
                }}
              >
                <option value={NPMJS}>{t('dshRuntimeRegistryNpmjs')}</option>
                <option value={NPMMIRROR}>{t('dshRuntimeRegistryNpmmirror')}</option>
                <option value={CUSTOM_REGISTRY}>{t('dshRuntimeRegistryCustomLabel')}</option>
              </select>
              <IconChevronDownOutline14 className={css.runtimeSelectChevron} aria-hidden="true" />
            </span>
            {registrySelection === CUSTOM_REGISTRY && (
              <input
                type="url"
                className={css.runtimeField}
                aria-label={t('dshRuntimeRegistryCustomLabel')}
                value={customOrigin}
                placeholder="https://registry.example.com"
                disabled={registryDisabled}
                onChange={(event) => setCustomOrigin(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && customOrigin.trim() !== '') {
                    void onApplyRegistry(customOrigin.trim(), true)
                  }
                }}
              />
            )}
            <Button variant="outline" size="sm"
              disabled={registryDisabled
                || (registrySelection === CUSTOM_REGISTRY && customOrigin.trim() === '')}
              onClick={() => {
                void onApplyRegistry(
                  registrySelection === CUSTOM_REGISTRY ? customOrigin.trim() : registrySelection,
                  true,
                )
              }}
            >
              {applyingRegistry ? t('dshRuntimeRegistryApplying') : t('dshRuntimeRegistryApply')}
            </Button>
            <Button variant="outline" size="sm"
              disabled={applyingRegistry}
              onClick={() => setRegistryEditing(false)}
            >
              {t('dshRuntimeRegistryCancel')}
            </Button>
            {originError !== null && <p className={css.generalError} role="alert">{originError}</p>}
          </div>
        ) : (
          <div className={css.updateStatusLine}>
            <span className={css.generalHint}>
              {t('dshRuntimeRegistryCurrent', { origin: registryOrigin !== '' ? registryOrigin : '—' })}
            </span>
            {/* 「检查更新」常驻显示、相位禁用而非隐藏（2026-12 忙碌窗口政策；
                与 gateway 分支同一可见策略——gateway 以 checkMachineBusy 镜像
                本处 canCheck 缺失的机器相位；restarting 计入禁用与 gateway
                重启窗口同口径）。 */}
            <Button variant="outline" size="sm"
              disabled={!canCheck || busy || testingRegistry || restarting}
              onClick={() => { void onTestRegistry() }}
            >
              {testingRegistry ? t('dshRuntimeRegistryChecking') : t('dshRuntimeRegistryCheck')}
            </Button>
            <Button variant="outline" size="sm"
              disabled={registryDisabled}
              onClick={() => setRegistryEditing(true)}
            >
              {t('dshRuntimeRegistryEdit')}
            </Button>
          </div>
        )}
      </div>

      {registryError !== null && <p className={css.generalError} role="alert">{registryError}</p>}

      {/* 数据快照 + 运行时占用（D6-A，2026-12 用户拍板）：紧凑事实块移出
          「当前状态」，置于「版本源」块内容之后、段尾（与版本源错误行同
          区域，发丝线分隔）；快照行 = 标签 + 值，磁盘行文案带头
          「运行时占用 {total}」，unclassifiedBytes>0 时追加未分类残留。 */}
      {hydrated && (
        <div className={clsx(css.generalGroupTitleBlock, css.runtimeDiskFacts)}>
          <div className={css.runtimeFactRow}>
            <span className={css.runtimeFactLabel}>{t('dshRuntimeSnapshotLabel')}</span>
            <span className={css.runtimeFactValue}>{snapshotText}</span>
          </div>
          {state?.diskUsage != null && (
            <div className={css.runtimeFactRow}>
              <span className={css.runtimeFactValue}>
                {t('dshRuntimeDiskSummary', {
                  total: formatRuntimeBytes(state.diskUsage.totalBytes),
                  trees: state.diskUsage.versionTrees,
                  treeBytes: formatRuntimeBytes(state.diskUsage.versionTreeBytes),
                  storeBytes: formatRuntimeBytes(state.diskUsage.storeBytes),
                  cacheBytes: formatRuntimeBytes(
                    state.diskUsage.cacheBytes
                    + state.diskUsage.installHomeBytes
                    + state.diskUsage.xdgCacheBytes
                    + state.diskUsage.workBytes,
                  ),
                  snapshotBytes: formatRuntimeBytes(state.diskUsage.snapshotBytes),
                  recoveryBytes: formatRuntimeBytes(
                    state.diskUsage.preRollbackBytes
                    + state.diskUsage.restoreBackupBytes
                    + state.diskUsage.failureBytes,
                  ),
                })}
                {diskUnclassifiedBytes > 0
                  && t('dshRuntimeDiskUnclassified', { unclassifiedBytes: formatRuntimeBytes(diskUnclassifiedBytes) })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* The local shape's confirmations (restart among them) render through the
          same armed dialog as the gateway shape: ONE path, both shapes. The
          Modal portals to the body, so its tree position is irrelevant. */}
      <RuntimeConfirmDialog
        request={confirmState.request}
        pending={confirmState.pending}
        onCancel={cancelConfirm}
        onConfirm={acceptConfirm}
        t={t}
      />
    </div>
  )
}
