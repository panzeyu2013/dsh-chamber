/**
 * Per-server dsh runtime section, `settings.section` id `dsh-runtime`
 * (order 31, design 18 §3.6): local = full management surface; gateway = the
 * same segment proxied through the same-origin `/chamber/runtime`. Facts and
 * mutations stay main-process/gateway-authoritative — no token ever leaves the
 * main process. Direct dsh targets mount no section; every mounted source gets
 * the「重启 dsh」action to refresh mounted plugins.
 *
 * Every action capsule is the shared ui-primitives `Button`; every confirmation is
 * ONE in-app `Modal`: native chrome cannot ride the panel's `--dsw-alias-*` tokens
 * or its dismiss/focus discipline in a multi-shell document, and the gateway shape
 * has no native dialog.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
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
  type RuntimeBadgeView,
  type RuntimeMetadataComponent,
  type RuntimeVersionEntry,
} from '@dsh-chamber/dsh-chamber-client-core/runtime-management'
import { applySettingsPatch, getSettingsStatus, subscribeSettings } from './settings-store.ts'
// The pure gateway runtime core (parsers/fetchers/action gates/errors/settle
// poll + restart-readiness poll) is the sidebar package's shared face; only the
// local view mappings stay here — the SettingsBridgeKey-keyed
// remoteRuntimeStatusView and the renderer-vocabulary projectRemoteRuntimeBadge.
import {
  fetchRemoteRuntimeStatus,
  fetchRemoteRuntimeVersions,
  pollGatewayReady,
  pollRemoteRuntimeUntilSettled,
  remoteRuntimeAction,
  REMOTE_STATUS_POLL_TIMEOUT_MS,
  remoteRuntimeSetRegistry,
  resetRemoteRuntimeActivityOwners,
  type RemoteRuntimeStatus,
  type RemoteVersions,
} from '@dsh-chamber/dsh-chamber-client-core'
import { projectRemoteRuntimeBadge, remoteRuntimeStatusView } from './gateway-runtime-api.ts'
// Page-owned restart→reload completion, shared with the connections package's
// restart entry points.
import {
  RESTART_RELOAD_BUDGET_MS,
  armLocalDshRestartCompletion,
  armWindowReloadWhenServed,
} from '@dsh-chamber/dsh-chamber-client-core'
import {
  acceptConfirm as acceptConfirmStep, armConfirm, cancelConfirm as cancelConfirmStep,
  IDLE_CONFIRM, type ConfirmState,
} from './confirm-machine.ts'
import {
  applyNowStillValid,
  cleanupVersionStillValid,
  gatewayConfirmGates,
  preRollbackOfferable,
  recoverMetadataStillValid,
  restoreBuiltinStillValid,
  restorePreRollbackStillValid,
  retryApplyStillValid,
  retryRestoreStillValid,
  type GatewayConfirmFacts,
} from './runtime-confirm-guards.ts'
import { errorMessage } from '@dsh-chamber/dsh-chamber-client-core'
import { bridgeRestartRefusalText } from './restart-refusal.ts'
import { RUNTIME_BADGE_KEYS, RUNTIME_BADGE_TONE_CLASS, formatTimestamp, localizeRegistryError, metadataComponentText, type RuntimeTranslate } from './runtime-display.ts'
import css from './SettingsShell.module.css'

const NPMJS = 'https://registry.npmjs.org'
const NPMMIRROR = 'https://registry.npmmirror.com'
const CUSTOM_REGISTRY = '__custom__'

/**
 * Wall-clock ceiling of ONE gateway action.
 *
 * WHY a bound: while the confirmed action runs the dialog is a progress surface and
 * cancel / Escape / mask / close are deliberate no-ops, so an action that never
 * settles would trap the section; the runner's own AbortController is the one place
 * to bound it. WHY this number: the longest legitimate action is a select/apply-now
 * whose settle poll may consume the shared core's `REMOTE_STATUS_POLL_TIMEOUT_MS`
 * (11 min); the ceiling adds the same one-minute margin for the hops around it.
 */
const REMOTE_ACTION_TIMEOUT_MS = REMOTE_STATUS_POLL_TIMEOUT_MS + 60_000

/* One coloured status badge vocabulary shared by both branches — label keys +
   dsw tone classes; it names the machine state, never a registry verdict. */
function RuntimeBadge({ view, t }: { view: RuntimeBadgeView; t: RuntimeTranslate }) {
  return (
    <span className={clsx(css.runtimeBadge, RUNTIME_BADGE_TONE_CLASS[view.tone])} role="status">
      {t(RUNTIME_BADGE_KEYS[view.label])}
    </span>
  )
}

/** Localize a projected ISO timestamp before it reaches user copy. The ctx-free
 *  read resolves the PAGE language, owned by the renderer's page-language owner
 *  and following the source ON SCREEN — not necessarily the instance this panel
 *  is editing. An unset lang falls back to zh-CN (the served default), not the OS locale. */
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
 * One armed destructive-action confirmation. WHY in-app: native chrome cannot ride
 * the panel's `--dsw-alias-*` tokens or its dismiss/focus discipline, it is
 * document-global (several shells mount at once), and the gateway shape has no native
 * dialog. A cancel performs nothing: the request is dropped before its runner is called.
 */
interface RuntimeConfirmRequest {
  title: string
  /** Supporting sentence — verbatim server copy. */
  description: string
  confirmLabel: string
  pendingLabel: string
  /**
   * Re-validation of the armed action, consulted immediately before the runner would
   * launch: it reads the LIVE facts of its action (./runtime-confirm-guards.ts), never
   * the render snapshot the request was armed in, so an action whose gates closed while
   * the dialog was open is dropped and reported. Required for every arm site.
   */
  stillValid: () => boolean
  /** The confirmed action; it owns its own failure reporting and never runs before the user confirms. */
  run: () => Promise<void>
}

/**
 * The section's ONE confirmation dialog: ui-primitives `Modal` with a `role="status"`
 * row while the action runs. Cancel, mask click and Escape all route through
 * `onCancel`, which no-ops while pending: dismissing the progress surface must not
 * imply a cancellation that does not exist.
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
 * Full per-server「dsh 运行时」segment for a GATEWAY connection: every fact and action
 * goes through the instance's same-origin proxy — the gateway's status is the
 * authority and the desktop never touches the token. Restart stays the shared
 * transactional flow owned by the parent.
 *
 * Status is polled every ~3s (the controller stays mounted while dsh is down);
 * versions are re-pulled after a status change that may have altered the cached tree
 * list. 409 refusals and failures surface on the shared actionError row with the
 * server's `error` copy verbatim; the section's own refusals join them there.
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
  askConfirm: (request: RuntimeConfirmRequest) => void
}) {
  const STATUS_POLL_MS = 3_000
  /** Per-request deadline for one status GET (the versions pull's 30s pattern). */
  const STATUS_REQUEST_TIMEOUT_MS = 30_000
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
  // Monotonic write discipline for remoteStatus: the 3s poll, settle poll,
  // apply-now poll and registry echo interleave, so a slow tick must not roll the
  // section back to an older snapshot (nor may a pre-PUT poll GET revert the
  // echoed origin). Each request takes the next number BEFORE it starts; a
  // result is applied only while nothing newer has landed.
  const statusSeq = useRef(0)
  const statusAppliedSeq = useRef(0)
  const nextStatusSeq = (): number => (statusSeq.current += 1)
  const applyRemoteStatus = useCallback((next: RemoteRuntimeStatus, seq: number): boolean => {
    if (seq < statusAppliedSeq.current) return false
    statusAppliedSeq.current = seq
    setRemoteStatus(next)
    return true
  }, [])
  const [registrySelection, setRegistrySelection] = useState(NPMJS)
  const [customOrigin, setCustomOrigin] = useState('')
  const [registryEditing, setRegistryEditing] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [registryBusy, setRegistryBusy] = useState(false)
  const registryInFlight = useRef(false)
  const registryController = useRef<AbortController | null>(null)
  /** 用户点击「检查更新」忙碌态：仅在用户点击后置位，保持到该次检查真正 settle；
   *  后台拉取（entry 首拉、安装/应用后的自动重拉）不点亮，避免无谓显示忙碌。 */
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
    // Clear controller ownership before the stale promise reaches its
    // identity-fenced finally; reset the busy flags for the newly selected
    // instance — the old promise must never publish into it.
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

  // The section stays live through dsh-down windows: a transient fetch failure
  // keeps the last status beside an honest error line, and a transition out of
  // installing re-pulls the version list.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const tick = async (): Promise<void> => {
      const seq = nextStatusSeq()
      // Per-request deadline: without it one wedged hop leaves this await pending
      // forever, so the finally never runs, no further tick is scheduled and the
      // section silently freezes on its last snapshot.
      const request = new AbortController()
      const onUnmount = (): void => { request.abort() }
      controller.signal.addEventListener('abort', onUnmount)
      let timedOut = false
      const deadline = setTimeout(() => { timedOut = true; request.abort() }, STATUS_REQUEST_TIMEOUT_MS)
      try {
        const status = await fetchRemoteRuntimeStatus(chamberInstanceId, { signal: request.signal })
        if (!cancelled && applyRemoteStatus(status, seq)) {
          if ((lastPhaseRef.current === 'installing' || lastPhaseRef.current === 'applying')
            && status.phase !== 'installing' && status.phase !== 'applying') {
            setVersionsEpoch((epoch) => epoch + 1)
          }
          lastPhaseRef.current = status.phase
          setStatusError(null)
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setStatusError(timedOut ? tRef.current('dshRuntimeStatusTimeout') : errorMessage(error))
        }
      } finally {
        clearTimeout(deadline)
        controller.signal.removeEventListener('abort', onUnmount)
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

  // Version list: pulled on entry and re-pulled after a status change
  // (versionsEpoch) or an explicit「检查更新」(checkIntent). BACKGROUND pulls
  // stay silent — only the user-initiated check owns「正在检查更新…」, and it
  // stays busy until the list ACTUALLY settles (even when a background bump
  // superseded the exact request). A bounded transport timeout (15s server-side)
  // turns a wedged hop into an honest error row instead of a stuck bus button.
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

  // Preserve an explicit choice across pushes / re-pulls; before the user
  // chooses: the active version wins (default no-override: the active version IS
  // the builtin anchor), then the builtin anchor, then the recommendation
  // (same policy as the local branch's preferredRuntimeVersion).
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
  // Direction-aware merged primary action: one button covers both directions —
  // select+apply arms the next-launch switch and the server itself computes the
  // manualRollback semantics for a downgrade target (no separate rollback route
  // exists in the gateway UI). A null active version is install/forward, never rollback.
  const gatewayDirection = runtimeSelectionDirection(chosenRemote, remoteActive)

  const envGatedRemote = remoteStatus?.source === 'env'
  // ---- live facts for accept-time re-validation ----
  // WHY a ref mirror: an arm site hands the dialog a request whose runner launches on
  // the CONFIRM click — possibly several ~3s polls later — so a guard read from the
  // render scope could fire an action the CURRENT facts refuse (e.g. restore-builtin
  // armed at `phase=idle` while the poll flips to `installing`). `liveFacts` is
  // reassigned every render and `remoteGates` is derived FROM it, so arm-time guards
  // and accept-time re-validation are one projection of the same facts.
  const liveFacts = useRef<GatewayConfirmFacts>({ status: null, busy: true, removableVersions: [] })
  liveFacts.current = {
    status: remoteStatus,
    busy: actionBusy || registryBusy || restarting || checkingVersions,
    removableVersions: remoteVersions?.removableVersions ?? [],
  }
  // Pure mirror of the server fences: pending permits only restore-builtin;
  // install/apply/restart-in-flight permit no action. Registry editing is a version
  // mutation; restart stays source-independent. checkingVersions freezes the mutation
  // controls and hides the cleanup and restore-builtin rows, matching the local branch;
  // the check button shows busy copy and is disabled.
  const remoteGates = gatewayConfirmGates(liveFacts.current)
  const mutationDisabled = remoteGates.mutationDisabled
  const restoreBuiltinDisabled = remoteGates.restoreBuiltinDisabled
  const retryApplyDisabled = remoteGates.retryApplyDisabled
  const retryRestoreDisabled = remoteGates.retryRestoreDisabled
  // Recover-metadata is the ONLY action a FATAL metadata block leaves open —
  // its enablement must come from the dedicated gate, never mutationDisabled
  // (which is true in exactly the states this row exists for).
  const recoverMetadataDisabled = remoteGates.recoverMetadataDisabled
  // 「检查更新」机器相位可用性 —— 显式镜像 local 分支动作矩阵中含 check 的状态集，
  // 不借用 mutationDisabled（env 会误伤：local 的 env 分支保留 check）：
  //   禁用 = 忙碌相位、pending、恢复相位、启动受阻、只读平台；可用 = idle/applied/失败带操作错误。
  // restarting prop（父层 POST /restart 202 → pollGatewayReady settle 全窗口）一并计入——
  // 只依赖服务端 restart 轮询相位会留下两个解禁窗口。按钮常驻显示、相位禁用而非隐藏。
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
    // React state is not a synchronous mutex: two clicks in one render can both
    // observe actionBusy=false, so fence before the first await and keep one abort
    // owner for instance switches/unmount.
    // 同帧检查围栏：checkIntent 在点击当帧置位、到版本列表 settle 才清——mutation
    // 入口必须与其渲染级冻结同语义，否则同帧可双放行（ref 是唯一同步防线）。
    if (actionInFlight.current || checkIntent.current) return
    actionInFlight.current = true
    const controller = new AbortController()
    actionController.current = controller
    // Bound the WHOLE action (its hops and any settle poll run on this
    // controller's signal) with REMOTE_ACTION_TIMEOUT_MS: a wedged hop would
    // otherwise leave the dialog pending forever — and it deliberately ignores
    // cancel, Escape, mask click and header close while pending.
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REMOTE_ACTION_TIMEOUT_MS)
    setActionBusy(true)
    setActionError(null)
    try {
      await task(controller.signal)
    } catch (error) {
      // The abort of a SUPERSEDED action (instance switch / unmount) stays
      // silent; OUR deadline reports itself with localized copy.
      if (timedOut) {
        if (componentActive.current) setActionError(tRef.current('dshRuntimeActionTimeout'))
      } else if (!controller.signal.aborted && componentActive.current) {
        setActionError(errorMessage(error))
      }
    } finally {
      clearTimeout(timeout)
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
      // select = async install job (202, progress via status.phase); after it
      // settles apply() arms the next-startup switch: select records the choice
      // WITHOUT pending, apply is the separate action that arms it.
      const result = await remoteRuntimeAction(chamberInstanceId, { kind: 'select', version: chosenRemote }, { signal })
      if (result.status === 202) {
        const seq = nextStatusSeq()
        const status = await pollRemoteRuntimeUntilSettled(chamberInstanceId, 'select', { signal })
        if (!signal.aborted) applyRemoteStatus(status, seq)
      }
      if (chosenRemote !== remoteActive) {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'apply' }, { signal })
      }
      // The install may have added a cached tree — refresh the selector.
      setVersionsEpoch((epoch) => epoch + 1)
    })
  }, [chamberInstanceId, chosenRemote, isActiveRemote, mutationDisabled, remoteActive, runRemoteAction])

  // 确认走应用内对话框（原 confirm(message) 正文即对话框描述）；取消 = 什么都不做。
  // 每个 request 带 `stillValid` —— 与 ARM 时同一谓词、读 liveFacts 的当前事实，
  // accept 时再验一次。
  const onRestoreBuiltin = useCallback(() => {
    if (!restoreBuiltinStillValid(liveFacts.current)) return
    askConfirm({
      title: t('dshRuntimeRestoreBuiltinConfirmTitle'),
      description: t('dshRuntimeRestoreBuiltinConfirmBody'),
      confirmLabel: t('dshRuntimeResetBuiltin'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      stillValid: () => restoreBuiltinStillValid(liveFacts.current),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'restore-builtin' }, { signal })
      }),
    })
  }, [chamberInstanceId, t, runRemoteAction, askConfirm])

  const onRetryApply = useCallback(() => {
    if (!retryApplyStillValid(liveFacts.current)) return
    askConfirm({
      title: t('dshRuntimeRetryApplyConfirmTitle'),
      description: t('dshRuntimeRetryApplyConfirmBody'),
      confirmLabel: t('dshRuntimeRetryApply'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      stillValid: () => retryApplyStillValid(liveFacts.current),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'retry-apply' }, { signal })
      }),
    })
  }, [chamberInstanceId, t, runRemoteAction, askConfirm])

  const onRetryRestore = useCallback(() => {
    if (!retryRestoreStillValid(liveFacts.current)) return
    askConfirm({
      title: t('dshRuntimeRetryRestoreConfirmTitle'),
      description: t('dshRuntimeRetryRestoreConfirmBody'),
      confirmLabel: t('dshRuntimeRetryRestore'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      stillValid: () => retryRestoreStillValid(liveFacts.current),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'retry-restore' }, { signal })
      }),
    })
  }, [chamberInstanceId, t, runRemoteAction, askConfirm])

  // 清理已安装版本：候选来自服务端 removableVersions；目标版本在 arm 时捕获，
  // accept 时要求它仍在当前候选表里 —— 否则会递出对话框点名之外的版本。
  const onCleanupRemote = useCallback((version: string) => {
    if (!cleanupVersionStillValid(liveFacts.current, version)) return
    askConfirm({
      title: t('dshRuntimeCleanupConfirmTitle', { version }),
      description: t('dshRuntimeCleanupConfirmBody'),
      confirmLabel: t('dshRuntimeCleanupVersion'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      stillValid: () => cleanupVersionStillValid(liveFacts.current, version),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'cleanup-version', version }, { signal })
        setVersionsEpoch((epoch) => epoch + 1)
      }),
    })
  }, [chamberInstanceId, t, runRemoteAction, askConfirm])

  // 恢复回滚前数据：row 在 idle 且存在暂存时出现，恢复 half 会进入
  // restore-blocked 由 retry-restore 续作。暂存名同样在 arm 时捕获，accept 时
  // 要求它仍是当前最新暂存，否则会恢复用户没点名的快照。
  const canRestorePreRollbackRemote = !envGatedRemote && preRollbackOfferable(remoteStatus)
  const onRestorePreRollbackRemote = useCallback(() => {
    const stashName = liveFacts.current.status?.preRollbackLatestName ?? null
    if (stashName === null || !restorePreRollbackStillValid(liveFacts.current, stashName)) return
    askConfirm({
      title: t('dshRuntimeRestorePreRollbackConfirmTitle'),
      description: t('dshRuntimeRestorePreRollbackConfirmBody'),
      confirmLabel: t('dshRuntimeRestorePreRollback'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      stillValid: () => restorePreRollbackStillValid(liveFacts.current, stashName),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'restore-pre-rollback', stashName }, { signal })
      }),
    })
  }, [chamberInstanceId, t, runRemoteAction, askConfirm])

  // 元数据救援：状态投影给出可救援能力时才显示。
  const canRecoverMetadataRemote = remoteStatus?.canRecoverMetadata === true
  const onRecoverMetadataRemote = useCallback(() => {
    if (!recoverMetadataStillValid(liveFacts.current)) return
    askConfirm({
      title: t('dshRuntimeRecoverMetadataConfirmTitle'),
      description: t('dshRuntimeRecoverMetadataConfirmBody'),
      confirmLabel: t('dshRuntimeRecoverMetadata'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      stillValid: () => recoverMetadataStillValid(liveFacts.current),
      run: () => runRemoteAction(async (signal) => {
        await remoteRuntimeAction(chamberInstanceId, { kind: 'recover-metadata' }, { signal })
      }),
    })
  }, [chamberInstanceId, t, runRemoteAction, askConfirm])

  // Metadata corruption notice rows (same copy as the local branch; the fields
  // are absent on pre-recovery servers, so the block never renders).
  const metadataComponentsText = (remoteStatus?.metadataComponents ?? []).length > 0
    ? (remoteStatus?.metadataComponents ?? []).map(component => metadataComponentText(component as RuntimeMetadataComponent, t))
      .join(t('dshRuntimeMetadataComponentSeparator'))
    : t('dshRuntimeMetadataComponentUnknown')
  const remoteMetadataBlocked = remoteStatus !== null
    && (remoteStatus.metadataHealth === 'selection-corrupt'
      || remoteStatus.metadataHealth === 'recovery-in-progress'
      || remoteStatus.metadataHealth === 'recovery-marker-corrupt')

  // Apply now on the gateway: the pending immediate-switch action goes through
  // the 202 route, polls the applying window to settlement, then refreshes the
  // version list (mirrors onApplySelected) — in this section's in-app dialog.
  const onApplyNowRemote = useCallback(() => {
    const target = liveFacts.current.status?.pending ?? null
    if (target === null || !applyNowStillValid(liveFacts.current, target)) return
    askConfirm({
      title: t('dshRuntimeApplyNowConfirmTitle', { version: target }),
      description: t('dshRuntimeApplyNowConfirmBody', { version: target }),
      confirmLabel: t('dshRuntimeApplyNowAction'),
      pendingLabel: t('dshRuntimeRemoteApplying'),
      // The pending version is captured in the copy AND in the request, so the
      // accept re-checks that the server still has THAT pending version
      // (apply-now targets the server's current pending record).
      stillValid: () => applyNowStillValid(liveFacts.current, target),
      run: () => runRemoteAction(async (signal) => {
        const result = await remoteRuntimeAction(chamberInstanceId, { kind: 'apply-now' }, { signal })
        if (result.status === 202) {
          const seq = nextStatusSeq()
          const status = await pollRemoteRuntimeUntilSettled(chamberInstanceId, 'apply-now', { signal })
          if (!signal.aborted) applyRemoteStatus(status, seq)
        }
        setVersionsEpoch((epoch) => epoch + 1)
      }),
    })
  }, [chamberInstanceId, t, runRemoteAction, askConfirm])

  const registryOrigin = remoteStatus?.registry ?? ''
  const registryMode = registryOrigin === NPMJS || registryOrigin === NPMMIRROR
    ? registryOrigin
    : CUSTOM_REGISTRY

  useEffect(() => {
    setRegistrySelection(registryMode)
    if (registryMode === CUSTOM_REGISTRY) setCustomOrigin(registryOrigin)
  }, [registryMode, registryOrigin])

  const onApplyRegistry = useCallback(async (origin: string): Promise<void> => {
    // checkIntent 同帧围栏：registry PUT 属「检查在途冻结」的变更面。
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
        // The server's own echo (canonical origin) is authoritative: reflect it
        // IMMEDIATELY instead of waiting for the next ~3s tick — the instant
        // feedback the local branch gets from its optimistic overlay. The echo
        // also takes a NEWER sequence number, so a poll GET that snapshotted the
        // OLD origin before the PUT and lands afterwards cannot revert the row
        // for one interval.
        statusAppliedSeq.current = nextStatusSeq()
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

  // 「检查更新」：gateway 侧 = 从 registry 重拉版本列表（服务端无周期出网）。
  // 同步 ref 围栏防同帧双击；忙碌态「正在检查更新…」保持到列表真正 settle。
  const onRefreshVersions = useCallback((): void => {
    if (checkIntent.current) return
    checkIntent.current = true
    setCheckingVersions(true)
    // 新检查起始即清上次失败行，否则旧超时/错误文案会与「正在检查更新…」
    // 整个新检查期间并存（local 侧 onTestRegistry 点击即清 registryError 同语义）。
    setVersionsError(null)
    setVersionsEpoch((epoch) => epoch + 1)
  }, [])

  // Retryability derives from the server's own phase projection (the routes
  // refuse with 409 no_retry_target otherwise): retry-apply resumes an
  // interrupted pointer switch / snapshot failure, retry-restore a data restore.
  const canRetryApplyRemote = remoteStatus !== null
    && (remoteStatus.phase === 'swap-attempted' || remoteStatus.phase === 'snapshot-failed')
  const canRetryRestoreRemote = remoteStatus !== null
    && remoteStatus.phase === 'restore-blocked'

  // 「恢复内建」可见性：active == builtin 时恢复是 no-op，不显示；仅普通 pending
  // （中止待应用切换的逃生口）保留。recovery 相位与一切 startupBlocked 状态不显示
  // （server 恢复门只开放各自 retry/recover-metadata，armed reset 会被核心复阻并残留、
  // 劫持后续 retry），否则按钮是 409 死路；installing/applying 忙碌窗仍渲染但随行禁用。
  // active/builtin 未知时保守显示；hasOverride 与 server 路由（runtime_no_override）同口径。
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
  // 「内建版本」行引导（镜像 local 分支）：选中与内建锚同版本、存在 hasOverride
  // 且该版本尚未装成受管树时，主按钮引导「恢复内建」（清指针回内建锚，零下载），
  // 把同版本下载并另装受管树降级为显式次要动作；已缓存时保持普通切换。
  const remoteBuiltinGuide = chosenRemote !== null
    && !isActiveRemote
    && remoteStatus !== null
    && remoteStatus.builtinVersion !== null
    && chosenRemote === remoteStatus.builtinVersion
    && remoteStatus.hasOverride === true
    && !restoreBuiltinDisabled
    && !sortedVersions.some((entry) => entry.version === chosenRemote && entry.cached)

  const view = remoteStatus === null ? null : remoteRuntimeStatusView(remoteStatus)
  // Unified status badge, same pill vocabulary as the local branch; the projection
  // suppresses the ok badge for blocked/failed, so no extra view-kind guard is needed.
  // While a USER check is in flight the badge shows the checking pill and the status
  // line is suppressed — a display-only overlay, the machine state staying idle. It
  // cannot mask blocked/failed: the check button is disabled there.
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
  // Idle has no claim line (no 已是最新/可用 verdict): the healthy state is the
  // badge alone. Pending keeps its detail line ("将于下次启动切换到 vX"). While a
  // USER check is in flight the status line is suppressed together with the
  // checking badge, mirroring the local branch's checking-phase presentation.
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

  // 未分类残留桶：shared 面的 unclassifiedBytes 必填（parseDiskUsage 对旧服务器
  // 缺省 0）；diskUsage 本身仍可为 null，保留可选链与 ?? 0。
  const remoteUnclassifiedBytes = remoteStatus?.diskUsage?.unclassifiedBytes ?? 0

  const remoteRestartDisabled = remoteGates.restartDisabled

  // 重启 dsh：按钮位于版本选择行（与 select 同一行高基线）；加载/不可达分支
  // 仍单独展示，反馈行（note/error）跟随按钮位置。
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
        /* gateway 的「内建」是部署者经 --dsh-path 提供的锚，不是随包版本，故用
           「部署锚」而非 local 的「随应用内建」文案。 */
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
      {/* 元数据损坏提示行（recover-metadata 对齐；旧服务器不投影字段 → 不渲染）。 */}
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
          already carry them (failed → operationError title; blocked → startupBlockedReason detail). */}
      {view !== null && view.kind !== 'failed' && remoteStatus.operationError !== null
        && remoteStatus.operationError !== '' && (
        <p className={css.generalError} role="alert">{remoteStatus.operationError}</p>
      )}
      {view !== null && view.kind !== 'blocked' && remoteStatus.startupBlockedReason !== null
        && remoteStatus.startupBlockedReason !== '' && (
        <p className={css.generalError} role="alert">{remoteStatus.startupBlockedReason}</p>
      )}

      <h4 className={clsx(css.generalGroupTitle, css.generalGroupTitleBlock)}>{t('dshRuntimeGroupActions')}</h4>

      {/* 「选择版本」字段无 label（select 以 aria-label 保持可访问名称）。 */}
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
          {/* 更新/切换到 vX 仅在选择版本 ≠ 当前版本时显示；忙碌期间保持可见但禁用
              （带「正在应用…」文案）。选中「内建版本」行且未装受管树时主按钮为「恢复内建」。 */}
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
        {/* 引导行：说明内建锚已存在（恢复内建零下载），「仍下载并安装为受管
            版本」保留为显式次要动作。 */}
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
          next-launch semantics the label no longer spells out. */}
      {!isActiveRemote && chosenRemote !== null && !remoteBuiltinGuide && (
        <p className={css.generalHint}>{t('dshRuntimeApplyNextLaunchHint')}</p>
      )}

      {/* gateway 的「检查更新」是只读拉取：失败不进入机器 error 相位，只在此行呈现、
          徽标仍反映服务端真实状态（gateway 无 checking/error 相位机，读取失败不改
          变运行状态）；local 的检查是主进程事务，失败会推入 error 相位。 */}
      {versionsError !== null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeRemoteVersionsUnavailable', { error: versionsError })}
        </p>
      )}
      {/* A 200 response with an embedded registry error (server fell back to
          the cached list) must be visible, never a silent stale list. */}
      {versionsError === null && remoteVersions?.error != null && (
        <p className={css.generalHint} role="status">
          {t('dshRuntimeRemoteVersionsUnavailable', { error: remoteVersions.error })}
        </p>
      )}

      {/* Pending = the gateway's apply-now window: the immediate-switch primary
          action appears only while the server gates are open, then the record line. */}
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

      {/* 常驻「清理已安装版本」入口：候选 = 服务端 removableVersions（旧服务器不
          投影 → 行隐藏）；用户检查期间隐藏（与 local 动作集清空同口径）。 */}
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

      {remoteVersions?.removableVersionsError != null && !checkingVersions && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeCleanupCandidatesUnavailable', { error: remoteVersions.removableVersionsError })}
        </p>
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

      {/* 台账读失败（EACCES/EIO 等）时 failure 行为 null，这条独立错误行说明
          「空/不完整」不是「无失败」；与 local 同口径（state?.failureError）。 */}
      {remoteStatus.failureError != null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeFailureLedgerUnreadable', { error: remoteStatus.failureError })}
        </p>
      )}

      <h4 className={clsx(css.generalGroupTitle, css.generalGroupTitleBlock)}>{t('dshRuntimeGroupSource')}</h4>

      {/* 内联字段无标签（select 用 aria-label）；外层是 div——select 与按钮不可同处
          一个 label（labeled control 之外不得含其他 labelable 元素）。 */}
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
                // Cancel resets the controls to the still-effective origin —
                // a stale unapplied choice must not survive reopening the form.
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

      {/* 数据快照 + 运行时占用：紧凑事实块置于「版本源」之后、段尾；快照行 = 标签
          + 值，磁盘行「运行时占用 {total}」，unclassifiedBytes>0 时追加未分类残留。 */}
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
  // click in the same frame.
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

  // ---- the section's ONE in-app confirmation ----
  // The armed request and its pending flag live above the shape branch, so the local
  // restart and every gateway mutation share one dialog, one cancel path and one
  // pending discipline. Transitions are the pure machine in ./confirm-machine.ts:
  // arming runs nothing, cancel drops the request before its runner is called, accept
  // launches exactly one runner after re-validating it.
  const [confirmState, setConfirmState] = useState<ConfirmState<RuntimeConfirmRequest>>(IDLE_CONFIRM)
  // The synchronous mirror of "the accepted action is running". The accept path,
  // its re-entry fence and the ARM path all read this ref, never the state: an arm
  // landing while an action is pending must NOT replace the pending request with a
  // non-pending one (that would silently downgrade the dialog: the following
  // Confirm becomes a no-op and `Modal` has no focus trap to hint it).
  const confirmLaunchRef = useRef(false)
  const askConfirm = useCallback((request: RuntimeConfirmRequest) => {
    if (confirmLaunchRef.current) return
    setConfirmState(armConfirm(request))
  }, [])
  const cancelConfirm = useCallback(() => {
    setConfirmState(cancelConfirmStep)
  }, [])
  const acceptConfirm = useCallback(() => {
    if (confirmLaunchRef.current) return
    const result = acceptConfirmStep(confirmState, (run) => {
      confirmLaunchRef.current = true
      // The runners own their failure reporting; the defensive catch keeps a
      // runner that breaks that contract from vanishing as an unhandled
      // rejection while the dialog is armed.
      void run()
        .catch((error: unknown) => { setActionError(errorMessage(error)) })
        .finally(() => {
          confirmLaunchRef.current = false
          setConfirmState(IDLE_CONFIRM)
        })
    })
    // The armed request re-validated itself before the runner launched and
    // failed — the confirm ends in an honest refusal, never in silence.
    if (result.outcome === 'dropped') setActionError(t('dshRuntimeConfirmStale'))
    if (result.outcome !== 'ignored') setConfirmState(result.state)
  }, [confirmState, t])

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

  // Preserve an explicit choice across pushes. Before the user chooses, the picker
  // preselects the active version (default no-override: the active version IS the
  // bundled one); the bundled version is the safe default only when none exists.
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
  // 常驻「清理已安装版本」候选：台账中非当前激活、非待应用的版本；受保护项
  // （known-good/失败现场/回退目标等）由主进程在删除点权威裁决并如实报错。
  const cleanupCandidates = useMemo(() => {
    if (envGated) return []
    return (state?.explicitlyInstalledVersions ?? [])
      .filter((version) => version !== active && version !== pending)
      .sort((a, b) => compareSemver(b, a) ?? 0)
  }, [envGated, state, active, pending])

  /** Run one local runtime action; reports whether it succeeded — the
   *  restarting transactions (apply-now / retry-apply / retry-restore) end with
   *  the page-owned completion. */
  const runRuntimeAction = useCallback(async (task: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setActionError(null)
    try {
      await task()
      return true
    } catch (error) {
      setActionError(errorMessage(error))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  // 重启 dsh：受控进程重启刷新插件挂载；指针/版本树不动。local = 事务化
  // control-plane restartLocal()；gateway = /chamber/runtime/restart（202 + status 轮询）。
  // 确认走本段唯一的应用内对话框，文案按形态分键：gateway 用含「其他用户的会话将
  // 短暂断开」的键（与 settings-connections 的 restartManagedDshConfirmDescription
  // 同语义，两处改语义先改 CS 卡）；local 用简短键 dshRuntimeRestartConfirm。
  const canRestartDsh = runtimeRestartAllowed(state)
  const runRestartDsh = useCallback(async (): Promise<void> => {
    if (restartingRef.current) return
    restartingRef.current = true
    setRestarting(true)
    setActionError(null)
    setRestartNote(null)
    try {
      if (instanceSource === 'local') {
        const surface = currentRuntimeSurface()
        if (surface === null) {
          // Bridge torn down between render and click: never claim a
          // restart that cannot run.
          throw new Error('runtime surface unavailable')
        }
        await surface.restart()
        // The restart refreshes the HOST side only — this window's client-plugin set
        // is fixed at boot, so a rebuilt `dsh.client` contribution cannot appear until
        // the page boots again. The action completes only with one reload after the
        // instance serves; a restart that never reaches ready stays here with an honest
        // note (never reload onto a dead instance). The completion is PAGE-owned.
        if (await armLocalDshRestartCompletion() === 'not-served') {
          throw new Error(t('dshRuntimeRestartNotServed'))
        }
      } else if (instanceSource === 'gateway' && chamberInstanceId !== undefined) {
        // The POST stays bounded by this panel's controller (a wedged hop must not
        // leave the dialog pending forever). The readiness poll does NOT share it: it
        // belongs to the PAGE-owned completion below, which keeps its own inner budget
        // (pollGatewayReady, 120s) inside the page-level net — unmount must not cancel it.
        restartPollAbort.current?.abort()
        const restartController = new AbortController()
        restartPollAbort.current = restartController
        let postTimedOut = false
        const restartTimeout = setTimeout(() => {
          postTimedOut = true
          restartController.abort()
        }, REMOTE_ACTION_TIMEOUT_MS)
        try {
          const response = await fetch(`/api/i/${chamberInstanceId}/chamber/runtime/restart`, {
            method: 'POST',
            signal: restartController.signal,
          })
          if (response.status !== 202) {
            // The route's 409 families get the SAME localized copy the
            // connections card/dialog render (restart-refusal.ts); other
            // statuses keep the server's verbatim reason, never a bare code.
            let body: unknown = null
            try { body = await response.json() } catch { body = null }
            throw new Error(bridgeRestartRefusalText(body, response.status, t))
          }
        } catch (error) {
          // Our own POST deadline reports itself in the section's copy; every
          // other failure (including the refusal above) keeps its own message.
          if (postTimedOut) throw new Error(t('dshRuntimeActionTimeout'))
          throw error
        } finally {
          clearTimeout(restartTimeout)
        }
        // Same completion as the local leg, armed on the PAGE: the managed dsh
        // becomes ready again, but this window still runs the pre-restart plugin
        // set, so the action ends with one reload; the poll's classified failure
        // is kept for the panel's copy.
        let pollFailure: unknown = null
        const outcome = await armWindowReloadWhenServed(
          `gateway-${chamberInstanceId}`,
          async signal => {
            try {
              await pollGatewayReady(chamberInstanceId, signal, { action: 'restart' })
              return true
            } catch (error) {
              pollFailure = error
              return false
            }
          },
          { budgetMs: RESTART_RELOAD_BUDGET_MS },
        )
        if (outcome === 'not-served') {
          throw pollFailure ?? new Error(t('dshRuntimeRestartNotServed'))
        }
        setRestartNote(t('dshRuntimeRestarted'))
        return
      } else {
        // Defensive: a source/id mismatch must never fall
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
      // The restart runner's OWN inside-check (runRestartDsh re-reads
      // restartingRef) is mirrored at accept time so a restart that began while
      // this dialog was open is refused, not silently re-entered.
      stillValid: () => !restartingRef.current,
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

  // Apply now: run the pending activation transaction in the current session. The
  // local runtime surface owns its own confirmation for it (resolved INSIDE the
  // surface call), so the section deliberately adds none — a second prompt would
  // double-ask. The surface confirmation is async, so the synchronous ref gate
  // below prevents a same-frame double-click from stacking a second IPC/confirm.
  const applyNowRef = useRef(false)
  const onApplyNow = useCallback(() => {
    if (applyNowRef.current) return
    // Re-resolve the surface at click time: a bridge torn down between render
    // and click must never claim an apply that cannot run.
    const surface = currentRuntimeSurface()
    if (surface === null || envGated || !actions.has('apply-now') || pending === null) return
    applyNowRef.current = true
    setApplyNowInFlight(true)
    void runRuntimeAction(() => surface.applyNow()).then((ran) => {
      // Apply-now is the local activation transaction: it stops and respawns the
      // instance, so a plugin set change rides the same window-boot rule.
      if (ran) void armLocalDshRestartCompletion()
    }).finally(() => {
      setApplyNowInFlight(false)
      applyNowRef.current = false
    })
  }, [envGated, actions, pending, runRuntimeAction])

  const onRetryApply = useCallback(() => {
    if (runtime === null || envGated || state?.canRetryApply !== true || !actions.has('retry-apply')) return
    // Retrying a pending activation resumes the same stop→apply→respawn
    // transaction: arm the page-owned completion on success.
    void runRuntimeAction(() => runtime.retryApply()).then((ran) => {
      if (ran) void armLocalDshRestartCompletion()
    })
  }, [runtime, envGated, state, actions, runRuntimeAction])

  const onRetryRestore = useCallback(() => {
    if (runtime === null || state?.canRetryRestore !== true || !actions.has('retry-restore')) return
    // Restore likewise respawns the instance before it can report readiness.
    void runRuntimeAction(() => runtime.retryRestore()).then((ran) => {
      if (ran) void armLocalDshRestartCompletion()
    })
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

  // 失败现场显式清除：主进程权威删除该版本的 failures/*.json 记录；surface 在
  // 点击时刻重取——桥接拆除时绝不能谎报清除成功（与 apply-now 同纪律）。
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
        // The confirm dialog was declined — not an error; the caller reverts the
        // edit form so it never claims an origin that was not applied.
        if (result.code === 'cancelled') {
          // Declined — close the edit form and reset the controls to the
          // still-effective origin so a stale unapplied choice never survives.
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
      // Success closes the edit form.
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
      // Success needs no verdict line: the refreshed version list is the
      // feedback.
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
      // registry 无结论行（已是最新/尚未检查/有可用更新/检查中）——空闲状态只
      // 由徽标表达；详情行仅承载真实状态/操作/失败。
      case 'not-checked':
      case 'idle':
      case 'checking':
      case 'available':
        return null
      case 'downloading': return t('dshRuntimeStatusDownloading', { version })
      case 'installing': return t('dshRuntimeStatusInstalling', { version })
      case 'pending': return t('dshRuntimeStatusPending', { version })
      // Honest window copy: while a user-triggered apply-now transaction runs the
      // status line names the immediate restart instead of next-launch applying
      // wording; terminal states always take over through their own kinds.
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

  // 统一彩色状态徽标：local/gateway 同一词汇；blocked/failed 由投影抑制 ok 徽标。
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

  // 未分类残留桶：RuntimeDiskUsage 含必填 unclassifiedBytes；diskUsage 可为
  // null，保留 ?? 0。
  const diskUnclassifiedBytes = state?.diskUsage?.unclassifiedBytes ?? 0

  const canSelect = actions.has('select-version')
  const canInstall = actions.has('install')
  const canReset = actions.has('reset-builtin')
  // 「恢复内建」可见性：active == bundled 时恢复是 no-op，不显示；
  // pending/applying/snapshot-failed 是持久化事务的逃生口（可能 active == bundled
  // 但 reset 仍有意——中止待应用切换）保留。任一未知时保守显示（宁显不藏）。
  const resetEscapeHatch = phase === 'pending' || phase === 'applying' || phase === 'snapshot-failed'
  const canResetVisible = canReset
    && (resetEscapeHatch || active === null || bundled === null || active !== bundled)
  // 「内建版本」行引导：选中与随应用内建同版本、存在 hasOverride 且该版本尚未
  // 装成受管树时，主按钮引导「恢复内建」（回随应用副本，零下载）；已缓存时保持
  // 普通切换，同版本下载另装降级为显式次要动作。
  const builtinGuide = chosen !== null
    && !isActive
    && bundled !== null
    && chosen === bundled
    && state?.hasOverride === true
    && canReset
    && !(versions.some((entry) => entry.version === chosen && entry.cached))
  // Immediate-apply: visible only in the pending phase; env/runtimeBlocked/
  // managementSupported are already folded into the action set by runtimeAllowedActions.
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

  // Live install progress: byte-percent while downloading with a declared
  // content-length, stage labels otherwise, indeterminate during phase-only
  // windows (installing/applying).
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
      {/* A blocked projection without a metadata-copy row (generic
          runtimeBlockedReason) must still explain itself — never only a red
          badge with everything disabled. */}
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

      {/* 「选择版本」字段无 label（select 以 aria-label 保持可访问名称）；外层是
          div——select 与按钮不可同处一个 label（labeled control 之外不得含其他
          labelable 元素，按钮点击会触发 label 隐式激活转发）。重启 dsh 按钮在
          本行（与 select 同一 28px 行高基线）。 */}
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
          {/* 更新/切换到 vX 仅在选择版本 ≠ 当前版本时显示；相位门控期间
              canInstall 从动作集消失——按钮保留但禁用（忙碌副本「正在安装…」+
              进度条），与 gateway 分支对齐。 */}
          {!isActive && chosen !== null && (
            <Button variant="primary" size="sm"
              onClick={builtinGuide ? onReset : onInstall}
              disabled={builtinGuide
                ? (mutationDisabled || !canReset)
                : (mutationDisabled || !canInstall)}>
              {builtinGuide
                ? t('dshRuntimeResetBuiltin')
                : busy && (phase === 'downloading' || phase === 'installing')
                  ? t('dshRuntimeInstalling')
                  // Unified direction-aware copy: the downgrade action is a
                  // version SWITCH like any other — never 回滚到 (data-restore
                  // semantics are decided server-side by the direction formula).
                  : `${selectionDirection === 'rollback' ? t('dshRuntimeActionSwitch') : t('dshRuntimeActionUpdate')} v${chosen}`}
            </Button>
          )}
          {/* 重启 dsh：暂态不可用（busy/pending/applying 等）时禁用而非隐藏——能力常驻可见。 */}
          <Button variant="outline" size="sm"
            onClick={() => { void onRestartDsh() }}
            disabled={restarting || !canRestartDsh}
          >
            {restarting ? t('dshRuntimeRestarting') : t('dshRuntimeRestartAction')}
          </Button>
        </div>
        {/* 引导行：说明随应用副本已存在（恢复内建零下载），「仍下载并安装为受管
            版本」保留为显式次要动作（受管树 = 回滚/快照/清理台账的一部分）。 */}
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

      {/* Pending = the apply-now window: the main [立即应用 v{version}] action plus
          the hint that the alternative is next launch; [恢复内建] stays below. */}
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
          {canResetVisible && !builtinGuide && (
            <Button variant="outline" size="sm" onClick={onReset} disabled={mutationDisabled}>
              {t('dshRuntimeResetBuiltin')}
            </Button>
          )}
        </div>
      )}

      {/* 常驻「清理已安装版本」入口：无需先在下拉选中；每颗胶囊对应一个可清理
          版本，确认由主进程原生对话框把关，受保护项的拒绝以错误行如实呈现。
          忙碌相位动作集不含 cleanup-version，整行随之隐藏。 */}
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

      {/* 失败现场保留展示 + 显式清除入口（主进程权威 clearFailure）；gateway
          分支无清除路由，不加按钮。 */}
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

      {state?.failureError != null && (
        <p className={css.generalError} role="alert">
          {t('dshRuntimeFailureLedgerUnreadable', { error: state.failureError })}
        </p>
      )}

      <h4 className={clsx(css.generalGroupTitle, css.generalGroupTitleBlock)}>{t('dshRuntimeGroupSource')}</h4>

      {/* registry 行与 gateway 分支同构——只读行（当前源 + [检查更新] + [编辑]）
          ⇄ 编辑态（select + 自定义输入 + [应用][取消]）；桌面侧应用走主进程原生确认。 */}
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
            {/* 「检查更新」常驻显示、相位禁用而非隐藏（与 gateway 分支同一策略，
                restarting 计入禁用）。 */}
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

      {/* 数据快照 + 运行时占用：紧凑事实块置于「版本源」之后、段尾；快照行 = 标签
          + 值，磁盘行「运行时占用 {total}」，unclassifiedBytes>0 时追加未分类残留。 */}
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

      {/* The local shape's confirmations render through the same armed dialog as
          the gateway shape: ONE path, both shapes. */}
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
