/**
 * runtime-startup-host.ts —— 运行时启动事务宿主。
 *
 * 本模块是 Electron main 与 Swift sidecar 装配共用的运行时生命周期宿主：
 * DshRuntimeController 构造、证据刷新（coalescer）、快照维护、元数据恢复事务、
 * runRuntimeStartup 启动事务、restart-exhausted 回滚、known-good 晋升与
 * APPLY_NOW 门输入。
 * flavor 差异全部经 RuntimeStartupHostDeps 注入：plane 访问器（含晚绑定
 * connectionState/localProcessAlive/seededProbeDomains 惰性读）、模块级事务槽
 * （state）、路径/版本/启动事实、日志 tag 与宿主叶（rendererPush、
 * windowAlive、isQuitting、pnpm 执行器、store prune、runtimeController 回填）。
 *
 * 不在本模块内的（有意保留在各自装配侧）：启动前导 bootstrap 事实计算
 * （stale writer 回收 / metadata health / shell-update 回落持久化，见
 * runtimeBootstrapFailure 与 bootstrapMetadataCorrupt 注入）与
 * cp.onLocalStateChange 订阅（sidecar 的 plane 晚绑定位置不同）。
 */

import { describeError } from './describe-error.ts';
import { call, isLegacyHostProbeValue } from './control-plane-module.ts';
import { DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES, DshRuntimeController } from './dsh-runtime-controller.ts';
import type { RuntimeMetadataComponent, RuntimeMetadataHealthProjection } from './dsh-runtime-controller.ts';
import { activationProbeNamesForDomains, fetchRegistryMetadata, installRuntimeVersion } from '@dsh-chamber/dsh-runtime';
import { sanitizeErrorText } from './sanitize-error.ts';
import { metadataProbeFailureMessage, probeFailureMessage } from './runtime-probe-detail.ts';
import type { ApplyNowGateInput } from './apply-now-gate.ts';
import { shouldSkipDiskRefresh } from './disk-evidence-gate.ts';
import { cleanupStaleInstalls, clearActivationJournal, clearCurrentPointer, clearRuntimeFailure, clearStorePruneRequest, createCoalescedRefresher, deleteOverride, evictVersions, listExplicitlyInstalledVersions, listKnownGoodVersionsState, listValidVersionTrees, pruneRuntimeStore, readActivationJournalState, readCurrentPointerState, readOverrideState, readStorePruneRequest, recordExplicitInstall, recordRuntimeFailure, runtimeDiskSummaryAsync, runtimeFailureSummary, validateVersionTree, writeActivationIntent, writeActivationJournal, writeCurrentPointer, writeOverride } from '@dsh-chamber/dsh-runtime';
import type { ActivationJournalState } from '@dsh-chamber/dsh-runtime';
import { completeInterruptedRestore, prepareManualRollbackData, pruneRuntimeSnapshots, resolveSnapshotName, restoreMarkerAuthorityStatus, restoreSnapshot, snapshotDshHome, snapshotSummary } from '@dsh-chamber/dsh-runtime';
import { noteBoot, promoteDueCandidates, recordProbePass, removeKnownGoodCandidate, resetCandidateHealthWindow } from '@dsh-chamber/dsh-runtime';
import { effectivePending } from '@dsh-chamber/dsh-runtime';
import { FATAL_STARTUP_BLOCK_REASONS, runDelayedRollback, runStartupPhase, shouldProbeEnvWithDormantCorruptSelection, type StartupDeps, type StartupResult } from '@dsh-chamber/dsh-runtime';
import { planRestartExhaustedRollback } from '@dsh-chamber/dsh-runtime';
import { RuntimeOperationFence, type OperationLease } from '@dsh-chamber/dsh-runtime';
import { runRuntimeActivationProbes } from '@dsh-chamber/dsh-runtime';
import { detectRuntimeMetadataHealth, inspectCorruptMetadataRecoveryMarker, projectMetadataHealthFacts, recoverRuntimeMetadata, rescueCorruptMetadataRecoveryMarker, type RuntimeMetadataHealth } from '@dsh-chamber/dsh-runtime';
import { allowedActions } from '@dsh-chamber/dsh-runtime';
import { isSafeVersion } from '@dsh-chamber/dsh-runtime';
import { IPC_CHANNELS } from './ipc-events.ts';
import { RUNTIME_ABORT_REASON, readDshVersion, resolveActiveRuntime, runRuntimeCheckCycle } from './shell-core.ts';
export interface RuntimeStartupHostState {
  startBlocked: boolean
  startBlockedReason: string
  internalStart: boolean
  transactionWorkspace: string | null
  operation: Promise<StartupResult | null> | null
  operationAbort: AbortController | null
}

export interface RuntimeStartupHostPlane {
  connectionState(): string | null
  localWritersQuiescent(): boolean
  localProcessAlive(): boolean
  localDshPort(): number | null
  /** Lazy read: the actual seeded host domains of the live plane. */
  seededProbeDomains(): readonly string[]
  startLocal(): Promise<void> | undefined
  stopLocal(): Promise<void>
  refreshLocalExposure(): void
}

export interface RuntimeStartupHostDeps {
  logTag: string
  rendererPush(channel: string, payload: unknown): boolean
  windowAlive(): boolean
  isQuitting(): boolean
  settings: { registryOrigin: string }
  plane: RuntimeStartupHostPlane
  state: RuntimeStartupHostState
  writerFence: RuntimeOperationFence
  runtimeBaseDir: string
  localDshHome: string
  builtinDshWorkspace: string | null
  shellVersion: string
  bundledVersion: string | null
  envOverrideActive: boolean
  runtimeManagementSupported: boolean
  runtimeBootstrapFailure: string | null
  runtimeBootstrapWriterUnsafe: boolean
  bootstrapMetadataCorrupt: boolean
  pnpmEntry: string
  runtimeNodeExecutor: () => { file: string; args: string[]; env: Record<string, string> }
  runStorePruneIfNeeded: () => Promise<void>
  onRuntimeInstance?(instance: DshRuntimeController): void
}

/**
 * Flavor slice for createRuntimeHostDeps: the fields main.ts's `whenReady`
 * assembly and sidecar-ctx.ts's `buildHeadlessCtx` genuinely differ on. The
 * invariant tail of RuntimeStartupHostDeps (the Electron-as-node pnpm executor
 * and the single-flight store-prune leaf) is generated by the factory below so
 * the two flavors cannot drift (4.4b).
 */
export interface RuntimeHostDepsAdapter {
  logTag: string
  rendererPush(channel: string, payload: unknown): boolean
  windowAlive(): boolean
  isQuitting(): boolean
  settings: { registryOrigin: string }
  plane: RuntimeStartupHostPlane
  state: RuntimeStartupHostState
  writerFence: RuntimeOperationFence
  runtimeBaseDir: string
  localDshHome: string
  builtinDshWorkspace: string | null
  shellVersion: string
  bundledVersion: string | null
  envOverrideActive: boolean
  runtimeManagementSupported: boolean
  runtimeBootstrapFailure: string | null
  runtimeBootstrapWriterUnsafe: boolean
  bootstrapMetadataCorrupt: boolean
  pnpmEntry: string
  onRuntimeInstance?(instance: DshRuntimeController): void
}

/**
 * Build the full RuntimeStartupHostDeps from a flavor adapter. The returned
 * object's `runStorePruneIfNeeded` is the SAME leaf callers also hand to
 * ShellAssemblyCtx.runStorePruneIfNeeded (one single-flight slot per factory
 * call; the prune-request marker semantics are unchanged).
 */
export function createRuntimeHostDeps(adapter: RuntimeHostDepsAdapter): RuntimeStartupHostDeps {
  let storePruneOperation: Promise<void> | null = null
  // The shared core's default node executor is plain node (design 18 §9.1);
  // the desktop injects its Electron-as-node branch for EVERY pnpm child —
  // installs AND store-prune — so dev and packaged modes run pnpm with the
  // same deliberate process semantics (ELECTRON_RUN_AS_NODE + --expose-internals).
  const runtimeNodeExecutor = (): { file: string; args: string[]; env: Record<string, string> } =>
    process.versions.electron !== undefined
      ? { file: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { file: process.execPath, args: [], env: {} }
  const runStorePruneIfNeeded = (): Promise<void> => {
    if (storePruneOperation !== null) return storePruneOperation
    if (adapter.isQuitting() || readStorePruneRequest(adapter.runtimeBaseDir) === null) return Promise.resolve()
    const operation = pruneRuntimeStore({ baseDir: adapter.runtimeBaseDir, pnpmEntry: adapter.pnpmEntry, deps: { node: runtimeNodeExecutor } })
      .then(() => { clearStorePruneRequest(adapter.runtimeBaseDir) })
      .catch((error) => {
        // Retain the marker: the next safe startup/operation retries. Prune
        // failure is disk hygiene, not permission to block a verified tree.
        console.error(`[${adapter.logTag}] dsh runtime store prune failed:`, sanitizeErrorText(describeError(error)))
      })
      .finally(() => {
        if (storePruneOperation === operation) storePruneOperation = null
      })
    storePruneOperation = operation
    return operation
  }
  return {
    logTag: adapter.logTag,
    rendererPush: adapter.rendererPush,
    windowAlive: adapter.windowAlive,
    isQuitting: adapter.isQuitting,
    settings: adapter.settings,
    plane: adapter.plane,
    state: adapter.state,
    writerFence: adapter.writerFence,
    runtimeBaseDir: adapter.runtimeBaseDir,
    localDshHome: adapter.localDshHome,
    builtinDshWorkspace: adapter.builtinDshWorkspace,
    shellVersion: adapter.shellVersion,
    bundledVersion: adapter.bundledVersion,
    envOverrideActive: adapter.envOverrideActive,
    runtimeManagementSupported: adapter.runtimeManagementSupported,
    runtimeBootstrapFailure: adapter.runtimeBootstrapFailure,
    runtimeBootstrapWriterUnsafe: adapter.runtimeBootstrapWriterUnsafe,
    bootstrapMetadataCorrupt: adapter.bootstrapMetadataCorrupt,
    pnpmEntry: adapter.pnpmEntry,
    runtimeNodeExecutor,
    runStorePruneIfNeeded,
    ...(adapter.onRuntimeInstance === undefined ? {} : { onRuntimeInstance: adapter.onRuntimeInstance }),
  }
}

export function createRuntimeStartupHost(host: RuntimeStartupHostDeps) {
  const {
    logTag,
    rendererPush,
    windowAlive,
    isQuitting,
    settings,
    plane,
    state: hostState,
    writerFence,
    runtimeBaseDir,
    localDshHome,
    builtinDshWorkspace,
    shellVersion,
    bundledVersion,
    envOverrideActive,
    runtimeManagementSupported,
    runtimeBootstrapFailure,
    runtimeBootstrapWriterUnsafe,
    bootstrapMetadataCorrupt,
    pnpmEntry,
    runtimeNodeExecutor,
    runStorePruneIfNeeded,
    onRuntimeInstance,
  } = host;

    const runtimeInstance = new DshRuntimeController({
      baseDir: runtimeBaseDir,
      bundledVersion,
      packageName: '@deepseek-ai/dsh',
      registryOrigin: settings.registryOrigin,
      getRegistryOrigin: () => settings.registryOrigin,
      envVersion: process.env.DSH_CHAMBER_DSH_PATH
        ? readDshVersion(process.env.DSH_CHAMBER_DSH_PATH)
        : null,
      envOverrideActive,
      managementSupported: runtimeManagementSupported,
      managementUnsupportedReason: runtimeManagementSupported
        ? null
        : '当前版本仅在 macOS/Linux 验证了运行时切换与数据恢复；Windows 暂为只读',
      pnpmEntry,
      compatibilityBaseline: bundledVersion,
      deps: {
        fetchMetadata: (pkg, origin) => fetchRegistryMetadata(pkg, { origin }),
        install: async (opts) => {
          await runStorePruneIfNeeded();
          // Merge, never replace: a future caller-supplied deps member (e.g.
          // deps.run) must survive the desktop's node-executor injection.
          return installRuntimeVersion({
            ...opts,
            deps: { ...opts.deps, node: runtimeNodeExecutor },
          });
        },
        store: {
          writeOverride: (b, record) => writeOverride(b, record),
          // 2.2（2026-12 审计）：控制器消费三态材质；D5a 起兼容投影已删除，
          // 真实现必须注入（否则安装门/activeVersion 仍可退化成 bundled/
          // 无 override）。
          readOverrideState: (b) => readOverrideState(b),
          readCurrentPointerState: (b) => readCurrentPointerState(b),
          listVersionTrees: (b) => listValidVersionTrees(b),
          validateVersionTree: (b, runtimeVersion) => validateVersionTree(b, runtimeVersion),
          deleteOverride: (b) => deleteOverride(b),
          clearCurrentPointer: (b) => clearCurrentPointer(b),
          recordExplicitInstall: (b, runtimeVersion) => recordExplicitInstall(b, runtimeVersion),
          // 闸口走异步单遍遍历——等待同一段墙钟时间但
          // 主进程保持响应（大 store 下同步遍历会冻结整个应用）。
          // 此 DI 回调由 controller install() 直接
          // await（安装闸口，见 dsh-runtime-controller.ts），绕过下方
          // refreshDiskUsage coalescer——与证据刷新并发时可能出现两遍全树
          // 遍历（罕见窗口、多一遍墙钟时间，无正确性影响；"绝不重复并发"
          // 不变量只对 coalescer 内的调用点成立）。
          runtimeDiskSummary: (b) => runtimeDiskSummaryAsync(b),
          writeActivationIntent: (b, input) => { writeActivationIntent(b, input); },
          clearActivationJournal: (b) => clearActivationJournal(b),
          recordFailure: (b, failure) => {
            recordRuntimeFailure(b, {
              version: failure.version,
              phase: 'installing',
              error: failure.reason,
              restoreOutcome: 'none',
            });
          },
        },
        shellVersion: shellVersion,
        // Live control-plane connection state projected to the renderer so it
        // can mirror the apply-now gate (ready/degraded only). controlPlane may
        // still be null here — the closure re-evaluates at every getState.
        connectionState: () => (plane.connectionState() ?? 'unknown'),
      },
    });
    onRuntimeInstance?.(runtimeInstance);
    runtimeInstance.onChanged((state) => {
      if (windowAlive()) {
        rendererPush(IPC_CHANNELS.RUNTIME_STATE_CHANGED, state);
      }
    });
    const projectMetadataHealth = (
      phase: Parameters<typeof runtimeInstance.setLifecycle>[0]['phase'],
      canRetryRestore: boolean,
      restoreOutcome: 'none' | 'complete' | 'half' | 'incomplete',
    ): {
      metadataHealth: RuntimeMetadataHealthProjection
      metadataComponents: RuntimeMetadataComponent[]
      canRecoverMetadata: boolean
    } => {
      let health: RuntimeMetadataHealth;
      try {
        health = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion);
      } catch {
        return { metadataHealth: 'unknown', metadataComponents: [], canRecoverMetadata: false };
      }
      const effectivePhase = phase ?? runtimeInstance.getState().phase;
      // The component set and needsRecovery are the shared projection
      // (dsh-runtime/src/metadata-health-projection.ts); the marker rescue
      // stays here because it inspects THIS host's base directory.
      const metadataFacts = projectMetadataHealthFacts(health, {
        markerRescueAvailable: health.status === 'recovery-marker-corrupt'
          && inspectCorruptMetadataRecoveryMarker(runtimeBaseDir).recoverable,
      });
      const needsRecovery = metadataFacts.needsRecovery;
      // 'incomplete' is a permanent restore outcome: the journaled snapshot is
      // missing or untrustworthy, so retry-restore can never succeed and the
      // recover-metadata escape must stay eligible (including when a stale
      // restore marker from the abandoned transaction is still present). A
      // 'half' outcome is transient and retryable, so it keeps the retry gate
      // and the marker gate fully closed.
      const permanentIncomplete = restoreOutcome === 'incomplete';
      const canRecoverMetadata = needsRecovery
        && (effectivePhase === 'idle' || effectivePhase === 'failed')
        && (permanentIncomplete || !canRetryRestore)
        && runtimeManagementSupported
        && !envOverrideActive
        && !runtimeBootstrapWriterUnsafe
        && plane.localWritersQuiescent()
        && bundledVersion !== null
        && isSafeVersion(bundledVersion)
        && (permanentIncomplete || restoreMarkerAuthorityStatus(runtimeBaseDir) === 'missing');
      return {
        metadataHealth: health.status,
        metadataComponents: metadataFacts.components,
        canRecoverMetadata,
      };
    };
    // 磁盘统计"节流/单飞/终态一次"——版本事务的
    // 15 个 refresh 调用点与 UI/事件驱动的刷新突发共享遍历：单飞合并并发
    // 请求，运行期间到达者补跑一遍（终态一次）。"全树统计绝不重复并发"
    // 不变量仅对经本 coalescer 的 refresh 调用点成立——安装闸口经 controller
    // DI 直接 await runtimeDiskSummaryAsync、绕过本 coalescer（见上方
    // deps.store.runtimeDiskSummary 映射旁注）。runtimeDiskSummaryAsync
    // 本身按批让渡事件循环，主进程全程不被冻结。
    const refreshDiskUsage = createCoalescedRefresher(() => runtimeDiskSummaryAsync(runtimeBaseDir));
    // 最近一次完成的全树磁盘投影（含错误投影）。进度跳过复用其值——
    // 终态/content 相位永远现场重走，绝不因复用而把陈旧终态交给 UI。
    let lastDiskEvidence: { usage: Awaited<ReturnType<typeof runtimeDiskSummaryAsync>> | null; error: string | null } | null = null;
    // 进度跳过的 skip 集与判定在 ./disk-evidence-gate.ts（纯模块 + 单测；
    // 判定经 shouldSkipDiskRefresh 注入下方调用）。
    const refreshRuntimeEvidence = async (patch: Parameters<typeof runtimeInstance.setLifecycle>[0] = {}) => {
      const effectivePhase = patch.phase ?? runtimeInstance.getState().phase;
      const effectiveCanRetryRestore = patch.canRetryRestore
        ?? (runtimeInstance.getState().canRetryRestore === true);
      const effectiveRestoreOutcome = patch.restoreOutcome
        ?? runtimeInstance.getState().restoreOutcome
        ?? 'none';
      const showFailure = effectivePhase === 'failed' || effectivePhase === 'rollback'
        || effectivePhase === 'snapshot-failed' || effectivePhase === 'error';
      // The failure ledger is read outside the snapshot try: a summary failure
      // still projects the unknown material, and a snapshot read failure can
      // never mask it (2.2/2.3 审计：unknown 不得折成 failure null/0)。
      const failures = runtimeFailureSummary(runtimeBaseDir);
      const failureError = failures.kind === 'unknown'
        ? sanitizeErrorText(failures.detail ?? 'runtime failures 元数据不可读')
        : null;
      let snapshotProjection: Parameters<typeof runtimeInstance.setLifecycle>[0];
      try {
        const snapshots = await snapshotSummary(runtimeBaseDir);
        snapshotProjection = {
          snapshotCount: snapshots.count,
          latestSnapshotAt: snapshots.latestAt,
          preRollbackCount: snapshots.preRollbackCount,
          preRollbackLatestName: snapshots.latestStashName,
          snapshotError: null,
          // kind === 'ok' only: an unknowable set has no latest fact, so the
          // row stays null while failureError carries the read reason.
          failure: !showFailure || failures.kind !== 'ok' || failures.latest === null ? null : {
            version: failures.latest.version,
            at: failures.latest.lastFailedAt,
            reason: failures.latest.error,
          },
          failureError,
        };
      } catch (error) {
        snapshotProjection = {
          snapshotError: sanitizeErrorText(describeError(error)),
          failureError,
        };
      }
      let diskProjection: Parameters<typeof runtimeInstance.setLifecycle>[0];
      const skipDisk = shouldSkipDiskRefresh(effectivePhase);
      if (skipDisk && lastDiskEvidence !== null) {
        // 进度相位：复用最近一次完整投影（无新遍历）——复用的是最近一次
        // **成功或失败**投影：error 投影（如磁盘统计失败）在
        // 长下载事务中会持续展示，直到终态 patch 现场重走才自愈（取舍：
        // 进度相位优先低延迟展示，而非阻塞在重试统计上）；快照/版本清单等
        // 轻量面照常现场刷新。diskLimitExceeded 等派生字段随复用值同步给出。
        diskProjection = {
          diskUsage: lastDiskEvidence.usage,
          diskError: lastDiskEvidence.error,
          diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
          diskLimitExceeded: lastDiskEvidence.usage === null
            ? null
            : lastDiskEvidence.usage.totalBytes >= DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
          explicitlyInstalledVersions: listExplicitlyInstalledVersions(runtimeBaseDir),
        };
      } else {
        try {
          const diskUsage = await refreshDiskUsage();
          lastDiskEvidence = { usage: diskUsage, error: null };
          diskProjection = {
            diskUsage,
            diskError: null,
            diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
            diskLimitExceeded: diskUsage.totalBytes >= DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
            explicitlyInstalledVersions: listExplicitlyInstalledVersions(runtimeBaseDir),
          };
        } catch (error) {
          lastDiskEvidence = {
            usage: null,
            error: sanitizeErrorText(describeError(error)),
          };
          diskProjection = {
            diskUsage: null,
            diskError: lastDiskEvidence.error,
            diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
            diskLimitExceeded: null,
            explicitlyInstalledVersions: [],
          };
        }
      }
      runtimeInstance.setLifecycle({
        ...snapshotProjection,
        ...diskProjection,
        ...patch,
        // These fields are an authoritative main-process projection. A stale
        // lifecycle patch must never manufacture metadata-recovery authority.
        ...projectMetadataHealth(effectivePhase, effectiveCanRetryRestore, effectiveRestoreOutcome),
      });
    };

    const setRuntimeGate = (blocked: boolean, reason: string | null = null) => {
      hostState.startBlocked = blocked;
      hostState.startBlockedReason = blocked
        ? reason ?? 'dsh 运行时尚未通过安全确认'
        : '';
      plane.refreshLocalExposure();
    };

    const probesPassed = (probes: Awaited<ReturnType<typeof runRuntimeActivationProbes>>) =>
      probes.length > 0 && probes.every(probe => probe.ok);

    // 探针失败诊断（`probeFailureDetail` 的 600 字符清单 + 前缀文案）位于
    // electron-free 的 runtime-probe-detail.ts，与 Swift 装配（sidecar-ctx）
    // 共用同一实现。
    const startAndProbeWorkspace = async (workspace: string, signal?: AbortSignal) => {
      if (isQuitting()) throw new Error(RUNTIME_ABORT_REASON);
      signal?.throwIfAborted();
      hostState.transactionWorkspace = workspace;
      hostState.internalStart = true;
      try {
        await plane.startLocal();
      } finally {
        hostState.internalStart = false;
      }
      try {
        const port = plane.localDshPort();
        if (port === null) throw new Error('local dsh did not publish a probe port');
        return await runRuntimeActivationProbes({
          baseUrl: `http://127.0.0.1:${port}`,
          dshHome: localDshHome,
          call,
          signal,
          // 期望集按**实际 seed 的宿主域**派生（host 包缺失时
          // 不按「全 3 域」裁决，否则 exact-set 必失败并回滚激活）。
          hostDomainNames: plane.seededProbeDomains(),
          // 2.1（2026-12 审计）：legacy session/list 回退此前在生产全静默
          // （warn 可选、无调用点注入）；同时用 control-plane 的 canonical
          // 谓词判定旧树形状（dsh-runtime 不依赖 control plane，谓词经它
          // 自己的 legacyShape seam 注入）。
          warn: line => console.warn(`[${logTag}] ${line}`),
          legacyShape: isLegacyHostProbeValue,
        });
      } finally {
        hostState.transactionWorkspace = null;
      }
    };

    const resolveExactRuntimeWorkspace = (runtimeVersion: string, isBuiltin: boolean): string => {
      if (isBuiltin) {
        if (builtinDshWorkspace === null || bundledVersion !== runtimeVersion) {
          throw new Error('内建 dsh 运行时清单与激活目标不一致');
        }
        return builtinDshWorkspace;
      }
      const tree = validateVersionTree(runtimeBaseDir, runtimeVersion);
      if (!tree.ok) throw new Error(`dsh runtime ${runtimeVersion} tree invalid: ${tree.error}`);
      return tree.path;
    };

    const startAndProbeRuntime = async (runtimeVersion: string, isBuiltin: boolean, signal?: AbortSignal) =>
      startAndProbeWorkspace(resolveExactRuntimeWorkspace(runtimeVersion, isBuiltin), signal);

    const startAndProbeCurrent = async (signal?: AbortSignal) => {
      const active = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace);
      if (active.path === null) throw new Error(active.blockedReason ?? 'dsh workspace not found');
      return {
        active,
        probes: await startAndProbeWorkspace(active.path, signal),
      };
    };

    const selectedJournalIntent = (state: ActivationJournalState) => {
      if (state.kind !== 'valid') return null;
      if (state.journal.phase === 'applied-monitoring' && state.journal.nextIntent !== null) {
        return state.journal.nextIntent;
      }
      return state.journal;
    };

    const readActivationFacts = () => {
      // ACTIVATION-FACTS DIVERGENCE: the gateway twin
      // (runtime-manager.ts activationFacts) excludes the current POINTER
      // from the known-good candidate scan and short-circuits win32 (knownGoodVersion
      // null); this side excludes journalIntent.targetVersion ??
      // override.pending and validates the tree. Unification needs one core
      // helper + one exclusion rule (deferred: requires a new dsh-runtime
      // public export, dist locked).
      const pointer = readCurrentPointerState(runtimeBaseDir);
      if (pointer.kind === 'corrupt' || pointer.kind === 'unknown') {
        throw new Error(pointer.kind === 'corrupt'
          ? 'current pointer metadata 损坏'
          : `current pointer metadata 不可读：${pointer.detail}`);
      }
      const overrideState = readOverrideState(runtimeBaseDir);
      if (overrideState.kind === 'corrupt' || overrideState.kind === 'unknown') {
        throw new Error(overrideState.kind === 'corrupt'
          ? 'override metadata 损坏'
          : `override metadata 不可读：${overrideState.detail}`);
      }
      // 未知/损坏的 known-good 账本不是「没有可信版本」（B1 §2.3；gateway
      // activationFacts 同款拒绝）。State 读一次即本事务的权威快照。
      const knownGoodState = listKnownGoodVersionsState(runtimeBaseDir);
      if (knownGoodState.kind !== 'ok') {
        throw new Error(knownGoodState.kind === 'corrupt'
          ? 'known-good metadata 损坏'
          : `known-good metadata 不可读：${knownGoodState.detail}`);
      }
      const journalIntent = selectedJournalIntent(readActivationJournalState(runtimeBaseDir));
      const excludedVersion = journalIntent?.targetVersion
        ?? (overrideState.kind === 'valid' ? overrideState.record.pending : null);
      // 兼容投影会二次读账本并把 unknown 折成空；这里从同一次 State 读中做
      // 同一排序/有效树选择（时间倒序首个有效树）。
      const latestKnownGoodVersion = knownGoodState.versions
        .find(version => version !== excludedVersion && validateVersionTree(runtimeBaseDir, version).ok) ?? null;
      if (pointer.kind === 'valid') {
        const tree = validateVersionTree(runtimeBaseDir, pointer.version);
        if (!tree.ok) throw new Error(`current runtime tree invalid: ${tree.error}`);
        const record = overrideState.kind === 'valid' ? overrideState.record : null;
        return {
          sourceVersion: pointer.version,
          sourceIsBuiltin: false,
          sourceWasKnownGood: knownGoodState.versions.includes(pointer.version)
            || (record?.lastOutcome === 'applied' && record.resolvedVersion === pointer.version),
          knownGoodVersion: latestKnownGoodVersion,
        };
      }
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        throw new Error('无法确认内建 dsh 运行时版本');
      }
      return {
        sourceVersion: bundledVersion,
        sourceIsBuiltin: true,
        sourceWasKnownGood: true,
        knownGoodVersion: latestKnownGoodVersion,
      };
    };

    const buildStartupDeps = (): StartupDeps => {
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        throw new Error('无法确认内建 dsh 运行时版本');
      }
      return {
        // 激活裁决的期望集必须与探针结果集**同源同快照**（design 18 §3.4；
        // gateway runtime-manager.ts:989 同款）。shared core 在探针 run 返回后
        // 调用本函数（ApplyDeps.probeExpectedNames 惰性求值）
        // → 此时本事务的 seed 已完成（plane.startLocal() 内），与
        // startAndProbeRuntime 传入的 hostDomainNames 完全一致。缺此字段时
        // gate 默认「全 7 探针」，部分/空 seed 必 exact-set 失配并回滚
        // 若在构造 deps 时就把域表取成值，冷启动带 pending 的事务会在 spawn 前
        // 冻结空域表 → 同样失配并回滚健康候选。
        probeExpectedNames: () => activationProbeNamesForDomains(plane.seededProbeDomains()),
        cleanupStaleInstalls: () => cleanupStaleInstalls(runtimeBaseDir),
        evict: () => evictVersions(runtimeBaseDir),
        completeInterruptedRestore: () => completeInterruptedRestore(runtimeBaseDir, localDshHome),
        readOverrideState: () => readOverrideState(runtimeBaseDir),
        writeOverride: record => writeOverride(runtimeBaseDir, record),
        deleteOverride: () => deleteOverride(runtimeBaseDir),
        readCurrentPointerState: () => readCurrentPointerState(runtimeBaseDir),
        readActivationJournal: () => readActivationJournalState(runtimeBaseDir),
        writeActivationJournal: journal => writeActivationJournal(runtimeBaseDir, journal),
        clearActivationJournal: () => clearActivationJournal(runtimeBaseDir),
        envOverrideActive: () => envOverrideActive,
        shellVersion: shellVersion,
        builtinVersion: bundledVersion,
        activationFacts: readActivationFacts,
        snapshot: sourceVersion => snapshotDshHome(runtimeBaseDir, localDshHome, sourceVersion),
        resolveSnapshotName: snapshotName => resolveSnapshotName(runtimeBaseDir, snapshotName),
        prepareManualRollback: targetVersion => prepareManualRollbackData(runtimeBaseDir, localDshHome, targetVersion),
        validateTarget: (runtimeVersion, isBuiltin) => {
          if (isBuiltin) {
            return builtinDshWorkspace !== null && runtimeVersion === bundledVersion
              ? { ok: true as const }
              : { ok: false as const, error: '内建运行时清单与目标版本不一致' };
          }
          const tree = validateVersionTree(runtimeBaseDir, runtimeVersion);
          return tree.ok ? { ok: true as const } : { ok: false as const, error: tree.error };
        },
        switchPointer: runtimeVersion => {
          if (runtimeVersion === null) clearCurrentPointer(runtimeBaseDir);
          else writeCurrentPointer(runtimeBaseDir, runtimeVersion);
        },
        // The transaction-level signal flows through spawnAndProbe from
        // runStartupPhase/runDelayedRollback. Never fall back
        // to a module-level aborted signal here: that would re-inject an
        // aborted signal into rollback verification probes, forging a
        // "candidate + fallback + builtin all failed" terminal state when the
        // abort lands inside the apply-now rollback window.
        spawnAndProbe: (runtimeVersion, isBuiltin, signal) => startAndProbeRuntime(
          runtimeVersion,
          isBuiltin,
          signal,
        ),
        stopHost: () => plane.stopLocal(),
        restore: snapshotPath => restoreSnapshot(runtimeBaseDir, localDshHome, snapshotPath),
        recordProbePass: runtimeVersion => {
          if (validateVersionTree(runtimeBaseDir, runtimeVersion).ok) recordProbePass(runtimeBaseDir, runtimeVersion);
        },
        recordFailure: input => { recordRuntimeFailure(runtimeBaseDir, input); },
      };
    };

    const runSnapshotMaintenance = async () => {
      // Retention evidence and deletion must be one transaction. Otherwise a
      // new activation can publish a journal/snapshot after this function
      // reads the protected set but before it deletes the old tail. The
      // maintenance routine itself is the shared dsh-runtime composite
      // `pruneRuntimeSnapshots` (cleanupSnapshotArtifacts → retention state →
      // pruneSnapshots), the same implementation the gateway runtime manager
      // runs at its own transaction tails — snapshot bounding can never
      // drift between owners.
      const lease = await writerFence.acquire('maintenance:snapshot-prune');
      try {
        const maintenance = await pruneRuntimeSnapshots(runtimeBaseDir, localDshHome, 3);
        if (maintenance.artifactCleanup.removedTemporaryEntries.length > 0
          || maintenance.artifactCleanup.removedRestoreBackups.length > 0) {
          console.log(
            `[${logTag}] runtime snapshot cleanup removed ${maintenance.artifactCleanup.removedTemporaryEntries.length} temporary entr${maintenance.artifactCleanup.removedTemporaryEntries.length === 1 ? 'y' : 'ies'} and ${maintenance.artifactCleanup.removedRestoreBackups.length} completed restore backup(s)`,
          );
        }
        if (maintenance.artifactCleanup.restoreBackupCleanup !== 'completed') {
          console.warn(`[${logTag}] runtime restore-backup cleanup skipped: ${maintenance.artifactCleanup.restoreBackupCleanup}`);
        }
        if (maintenance.skippedReason === 'retention-corrupt') {
          console.warn(`[${logTag}] runtime snapshot retention metadata is corrupt; snapshots preserved (fail closed)`);
        }
      } finally {
        lease.release();
      }
    };

    const publishApplyOutcome = async (
      outcome: NonNullable<StartupResult['applyOutcome']>,
      targetVersion: string | null,
      targetIsBuiltin: boolean,
      sourceVersion: string | null,
    ) => {
      let blocked = outcome.runtimeBlocked;
      let error = outcome.error;
      if (targetVersion !== null && !targetIsBuiltin && outcome.status !== 'applied') {
        try { removeKnownGoodCandidate(runtimeBaseDir, targetVersion); } catch { /* diagnostic retention only */ }
      }
      // Snapshot/validation/initial-pointer failures leave the old pointer
      // authoritative but the transaction stopped its host. Re-open the gate
      // only after that exact current tree passes the full probe set again.
      if (!blocked && (outcome.status === 'snapshot-failed' || !plane.localProcessAlive())) {
        try {
          const resumed = await startAndProbeCurrent(hostState.operationAbort?.signal);
          if (!probesPassed(resumed.probes)) throw new Error(probeFailureMessage('原运行时兼容性探针失败', resumed.probes));
        } catch (resumeError) {
          await plane.stopLocal().catch(() => undefined);
          blocked = true;
          error = `${error === null ? '' : `${error}; `}无法安全恢复当前运行时：${sanitizeErrorText(resumeError instanceof Error ? resumeError.message : String(resumeError))}`;
        }
      }
      if (outcome.status === 'applied' && targetVersion !== null && !targetIsBuiltin) {
        try { clearRuntimeFailure(runtimeBaseDir, targetVersion); } catch { /* diagnostic cleanup only */ }
        noteBoot(runtimeBaseDir, targetVersion);
        promoteDueCandidates(runtimeBaseDir);
      }
      const blockedReason = blocked ? error ?? 'dsh 运行时恢复尚未完成' : null;
      setRuntimeGate(blocked, blockedReason);
      const override = readOverrideState(runtimeBaseDir);
      const shellFallback = targetIsBuiltin
        && override.kind === 'valid'
        && override.record.invalidatedAt != null;
      await refreshRuntimeEvidence({
        // A rolled-back outcome stays in the retryable 'rollback' phase; an
        // 'incomplete' data restore is permanent (missing/untrustworthy
        // snapshot — no retry can succeed), so it is a terminal 'failed'
        // phase where the recover-metadata escape stays eligible.
        phase: outcome.status === 'rolled-back' && outcome.restoreOutcome !== 'incomplete'
          ? 'rollback'
          : outcome.status === 'rolled-back'
            ? 'failed'
            : outcome.status === 'applied' && targetIsBuiltin
              ? shellFallback ? 'rollback' : 'idle'
              : outcome.status,
        error,
        targetVersion,
        sourceVersion,
        rollbackTarget: outcome.rollbackTarget,
        restoreOutcome: outcome.restoreOutcome,
        snapshotError: outcome.status === 'snapshot-failed' ? error : null,
        canRetryApply: outcome.retryAction === 'apply',
        canRetryRestore: outcome.retryAction === 'restore',
        runtimeBlocked: blocked,
        runtimeBlockedReason: blockedReason,
        swapAttempted: outcome.swapAttempted,
      });
    };

    /** Snapshot-failure diagnostic copy from the authoritative override
     *  State: a valid record's lastError wins, while corrupt/unreadable bytes
     *  carry their own reason instead of silently degrading to the generic
     *  copy (2.2 审计诊断投影). */
    const overrideSnapshotDiagnostic = (fallback: string): string => {
      const state = readOverrideState(runtimeBaseDir);
      if (state.kind === 'valid') return state.record.lastError ?? fallback;
      if (state.kind === 'unknown') {
        return sanitizeErrorText(`override 元数据不可读（${state.detail}）；${fallback}`);
      }
      if (state.kind === 'corrupt') return `override 元数据损坏；${fallback}`;
      return fallback;
    };

    const publishBlockedStartup = async (
      reason: string,
      patch: Parameters<typeof runtimeInstance.setLifecycle>[0] = {},
    ) => {
      const safeReason = sanitizeErrorText(reason);
      setRuntimeGate(true, safeReason);
      await refreshRuntimeEvidence({
        phase: 'failed',
        error: safeReason,
        canRetryApply: false,
        canRetryRestore: false,
        runtimeBlocked: true,
        runtimeBlockedReason: safeReason,
        ...patch,
      });
    };

    const metadataProbeError = (
      probes: Awaited<ReturnType<typeof runRuntimeActivationProbes>>,
    ): string => {
      return metadataProbeFailureMessage(probes);
    };

    /** Execute inside hostState.operation + writerFence. The public gate
     * remains closed until the exact bundled tree passes the full probe set
     * and the durable recovery marker is finalized. */
    type RecoverableMetadataStatus = 'selection-corrupt' | 'recovery-in-progress' | 'recovery-marker-corrupt';
    const executeMetadataRecovery = async (
      signal: AbortSignal,
      expectedStatus: RecoverableMetadataStatus,
      markerRescueConfirmed: boolean,
    ): Promise<boolean> => {
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        await publishBlockedStartup('无法确认内建 dsh 运行时版本；拒绝恢复元数据');
        return false;
      }
      const initialHealth = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion);
      if (initialHealth.status !== expectedStatus) {
        await publishBlockedStartup('元数据恢复状态已变更；必须重新确认后才能继续');
        return false;
      }
      if (initialHealth.status === 'recovery-marker-corrupt' && !markerRescueConfirmed) {
        await publishBlockedStartup('元数据恢复标记已损坏；自动续作已停止，必须由用户显式确认二阶恢复');
        return false;
      }
      setRuntimeGate(true, '正在保留 DSH_HOME 与元数据证据，并恢复内建 dsh');
      await refreshRuntimeEvidence({
        phase: 'applying',
        error: null,
        targetVersion: bundledVersion,
        canRetryApply: false,
        canRetryRestore: false,
        canRecoverMetadata: false,
        runtimeBlocked: true,
        runtimeBlockedReason: '正在保留 DSH_HOME 与元数据证据，并恢复内建 dsh',
      });
      try {
        const recoveryOptions = {
          baseDir: runtimeBaseDir,
          dshHome: localDshHome,
          builtinVersion: bundledVersion,
          shellVersion: shellVersion,
          stopHost: () => plane.stopLocal(),
          completeRestore: () => completeInterruptedRestore(runtimeBaseDir, localDshHome),
          probeBuiltin: async () => {
            const probes = await startAndProbeRuntime(bundledVersion, true, signal);
            return probesPassed(probes)
              ? { ok: true as const }
              : { ok: false as const, error: metadataProbeError(probes) };
          },
        };
        const health = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion);
        if (health.status !== expectedStatus) {
          await publishBlockedStartup('元数据恢复状态在执行前发生变化；本地实例继续隔离');
          return false;
        }
        const result = health.status === 'recovery-marker-corrupt'
          ? await rescueCorruptMetadataRecoveryMarker(recoveryOptions)
          : await recoverRuntimeMetadata(recoveryOptions);
        if (result.status === 'finalized') {
          setRuntimeGate(false);
          await refreshRuntimeEvidence({
            phase: 'idle',
            error: null,
            targetVersion: null,
            sourceVersion: null,
            rollbackTarget: null,
            // A finalized recovery resolved any interrupted DSH_HOME restore
            // (the stale marker, if any, was archived as evidence). Do not let
            // an 'incomplete' outcome linger and keep blocking local start.
            restoreOutcome: result.restoreOutcome === 'incomplete' ? 'none' : result.restoreOutcome,
            canRetryApply: false,
            canRetryRestore: false,
            canRecoverMetadata: false,
            runtimeBlocked: false,
            runtimeBlockedReason: null,
          });
          return true;
        }
        if (result.status === 'restore-blocked') {
          await publishBlockedStartup(
            result.restoreOutcome === 'half'
              ? '数据恢复只完成一部分；已保留现场，必须先重试恢复'
              : '数据恢复未完成；已保留现场，必须先重试恢复',
            {
              restoreOutcome: result.restoreOutcome,
              canRetryRestore: true,
              canRecoverMetadata: false,
            },
          );
          return false;
        }
        if (result.status === 'probe-failed') {
          await publishBlockedStartup(result.error, {
            restoreOutcome: result.restoreOutcome,
            canRecoverMetadata: true,
          });
          return false;
        }
        // A user/startup eligibility re-read guarantees an unfinished
        // transaction. A no-op/finalized result here means the authority
        // changed underneath us; never open exposure without a fresh probe.
        await publishBlockedStartup('元数据恢复状态已变更；未经新的内建运行时探针，本地实例继续隔离');
        return false;
      } catch (error) {
        await plane.stopLocal().catch(() => undefined);
        await publishBlockedStartup(`元数据恢复失败：${describeError(error)}`);
        return false;
      }
    };

    /** Probe an explicit env tree without reading, archiving, or changing any
     * dormant chamber selection metadata. Restore completion remains the only
     * permitted metadata-adjacent operation before the env probe. */
    const runEnvOverrideStartup = async (signal: AbortSignal): Promise<void> => {
      try {
        await plane.stopLocal();
        const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
        if (restored === 'half' || restored === 'incomplete') {
          await publishBlockedStartup('数据恢复未完成（现场已保留），请重试恢复', {
            restoreOutcome: restored,
            canRetryRestore: true,
          });
          return;
        }
        const current = await startAndProbeCurrent(signal);
        if (current.active.source !== 'env' || !probesPassed(current.probes)) {
          throw new Error(probeFailureMessage('env runtime compatibility probes failed', current.probes));
        }
        setRuntimeGate(false);
        await refreshRuntimeEvidence({
          phase: 'idle', error: null, runtimeBlocked: false, runtimeBlockedReason: null,
          canRetryApply: false, canRetryRestore: false,
        });
      } catch (error) {
        await plane.stopLocal().catch(() => undefined);
        await publishBlockedStartup(describeError(error));
      }
    };

    const runRuntimeStartup = (): Promise<StartupResult | null> => {
      if (hostState.operation !== null) return hostState.operation;
      let operationLease: OperationLease | null = null;
      const operation = (async (): Promise<StartupResult | null> => {
        hostState.operationAbort = new AbortController();
        setRuntimeGate(true, '正在确认 dsh 运行时与数据恢复状态');
        operationLease = await writerFence.acquire('runtime:startup', hostState.operationAbort.signal);

        // A persisted wall clock is not uptime. Close every candidate health
        // window before the first probe of this transaction; a successful
        // full compatibility probe/boot below opens a fresh window.
        resetCandidateHealthWindow(runtimeBaseDir);

                if (runtimeBootstrapFailure !== null && runtimeBootstrapWriterUnsafe) {
          await publishBlockedStartup(runtimeBootstrapFailure);
          return null;
        }
        if (!plane.localWritersQuiescent()) {
          await publishBlockedStartup('无法确认旧 dsh 写进程已完全回收；为保护 DSH_HOME，已阻止本地实例启动与版本切换');
          return null;
        }

        let metadataHealth: RuntimeMetadataHealth;
        try {
          metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion);
        } catch (error) {
          await publishBlockedStartup(`无法检查 dsh 运行时选择元数据：${describeError(error)}`);
          return null;
        }
        if (metadataHealth.status === 'recovery-in-progress') {
          if (!runtimeManagementSupported || envOverrideActive) {
            await publishBlockedStartup('元数据恢复事务未完成；当前平台或 env 运行时不允许续作管理事务');
            return null;
          }
          await executeMetadataRecovery(
            hostState.operationAbort.signal,
            'recovery-in-progress',
            false,
          );
          return null;
        }
        // A valid env workspace has highest selection priority. Corrupt
        // dormant current/override/journal bytes remain untouched evidence;
        // only an independently authoritative restore may finish first.
        if (shouldProbeEnvWithDormantCorruptSelection(metadataHealth.status, envOverrideActive)) {
          await runEnvOverrideStartup(hostState.operationAbort.signal);
          return null;
        }
        if (metadataHealth.status === 'selection-corrupt') {
          // A crash-interrupted DSH_HOME restore outranks metadata archival.
          // Complete/retry it first so the stash never captures a half restore.
          if (restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
            await plane.stopLocal();
            const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
            if (restored === 'half' || restored === 'incomplete') {
              await publishBlockedStartup('数据恢复未完成；必须先重试恢复，再处理运行时元数据', {
                restoreOutcome: restored,
                canRetryRestore: true,
                canRecoverMetadata: false,
              });
              return null;
            }
            metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion);
          }
          if (metadataHealth.status === 'selection-corrupt') {
            await publishBlockedStartup('运行时选择元数据损坏；已保留证据并等待用户确认“保留数据并恢复内建”', {
              canRecoverMetadata: runtimeManagementSupported && !envOverrideActive,
            });
            return null;
          }
        }
        if (metadataHealth.status === 'recovery-marker-corrupt') {
          // A snapshot restore marker is independently authoritative. Finish
          // it before offering second-order metadata recovery so the new stash
          // can never capture a half-restored DSH_HOME.
          if (restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
            await plane.stopLocal();
            const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
            if (restored === 'half' || restored === 'incomplete') {
              await publishBlockedStartup('数据恢复未完成；必须先重试恢复，再处理损坏的元数据恢复标记', {
                restoreOutcome: restored,
                canRetryRestore: true,
                canRecoverMetadata: false,
              });
              return null;
            }
            metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion);
          }
          if (metadataHealth.status === 'recovery-marker-corrupt') {
            const capability = inspectCorruptMetadataRecoveryMarker(runtimeBaseDir);
            await publishBlockedStartup(
              capability.recoverable
                ? '元数据恢复标记损坏；已保留现场并等待用户确认二阶恢复'
                : '元数据恢复标记不是可安全归档的普通文件；已保留现场并拒绝自动修复',
              { canRecoverMetadata: capability.recoverable && runtimeManagementSupported && !envOverrideActive },
            );
            return null;
          }
        }
        if (runtimeBootstrapFailure !== null && !bootstrapMetadataCorrupt) {
          const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
          if (restored === 'half' || restored === 'incomplete') {
            await publishBlockedStartup('数据恢复未完成（现场已保留），请重试恢复', {
              restoreOutcome: restored,
              canRetryRestore: true,
            });
            return null;
          }
          await publishBlockedStartup(runtimeBootstrapFailure);
          return null;
        }
        if (!runtimeManagementSupported) {
          try {
            const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
            if (restored === 'half' || restored === 'incomplete') {
              await publishBlockedStartup('未完成的数据恢复仍需人工重试；Windows 运行时版本管理保持只读', {
                restoreOutcome: restored,
                canRetryRestore: true,
              });
              return null;
            }
            const current = await startAndProbeCurrent(hostState.operationAbort.signal);
            if (!probesPassed(current.probes)) throw new Error(probeFailureMessage('runtime compatibility probes failed', current.probes));
            setRuntimeGate(false);
            await refreshRuntimeEvidence({
              phase: 'idle', error: null, runtimeBlocked: false, runtimeBlockedReason: null,
              canRetryApply: false, canRetryRestore: false,
            });
          } catch (error) {
            await plane.stopLocal().catch(() => undefined);
            await publishBlockedStartup(describeError(error));
          }
          return null;
        }

        // An explicit env workspace is independent of the chamber-managed
        // builtin and selection metadata. It still waits for writer
        // quiescence and completes a crash-interrupted DSH_HOME restore, but
        // it must not require a readable bundled manifest or mutate dormant
        // current/override/journal state before probing the env tree.
        if (envOverrideActive) {
          await runEnvOverrideStartup(hostState.operationAbort.signal);
          return null;
        }

        const journalBefore = readActivationJournalState(runtimeBaseDir);
        const intentBefore = selectedJournalIntent(journalBefore);
        const overrideBefore = readOverrideState(runtimeBaseDir);
        // Pending replay projection before the startup transaction: use the
        // shared core effectivePending so a pending whose override is
        // invalidated OR written by an older shell shellVersion never resolves a
        // target here (matches the core startup replay decision).
        const pendingBefore = overrideBefore.kind === 'valid'
          ? effectivePending(overrideBefore.record, shellVersion)
          : null;
        // Env is authoritative over dormant chamber selection metadata. The
        // startup module must first complete any restore and then return its
        // env-override verdict; reading corrupt current/override facts here
        // would incorrectly make that safe path unreachable.
        let sourceFacts: ReturnType<typeof readActivationFacts> | null = null;
        if (!envOverrideActive) {
          try {
            sourceFacts = readActivationFacts();
          } catch (error) {
            await publishBlockedStartup(describeError(error));
            return null;
          }
        }

        // Stop unconditionally: restart backoff can own a future spawn even
        // while no child is alive. stopLocal cancels that epoch before any
        // snapshot/restore touches the shared DSH_HOME.
        await plane.stopLocal();
        if (!envOverrideActive
          && (intentBefore !== null || pendingBefore !== null
            || restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing')) {
          await refreshRuntimeEvidence({
            phase: 'applying',
            error: null,
            targetVersion: intentBefore?.targetVersion ?? pendingBefore,
            sourceVersion: sourceFacts?.sourceVersion ?? null,
            canRetryApply: false,
            canRetryRestore: false,
            runtimeBlocked: true,
            runtimeBlockedReason: '正在执行 dsh 运行时激活或数据恢复事务',
          });
        }

        const deps = buildStartupDeps();
        const result = await runStartupPhase(deps, hostState.operationAbort?.signal);
        const outcomeTarget = intentBefore?.targetVersion
          ?? result.monitoringJournal?.targetVersion
          ?? pendingBefore;
        const targetIsBuiltin = intentBefore?.targetIsBuiltin
          ?? result.monitoringJournal?.targetIsBuiltin
          ?? false;
        const durableJournal = readActivationJournalState(runtimeBaseDir);
        const durableSource = durableJournal.kind === 'valid' && durableJournal.journal.sourceVersion !== null
          ? durableJournal.journal.sourceVersion
          : sourceFacts?.sourceVersion ?? null;

        if (result.applyOutcome !== null) {
          await publishApplyOutcome(
            result.applyOutcome,
            outcomeTarget,
            targetIsBuiltin,
            durableSource,
          );
          return result;
        }

        if (result.blockedReason === 'restore-half' || result.blockedReason === 'restore-incomplete') {
          await publishBlockedStartup(
            result.blockedReason === 'restore-half'
              ? '数据恢复失败（现场已保留），请重试恢复'
              : '数据恢复未完成（现场已保留），请重试恢复',
            {
              restoreOutcome: result.restored === 'half' ? 'half' : 'incomplete',
              canRetryRestore: true,
            },
          );
          return result;
        }

        // FATAL metadata-corruption set — shared single source with the
        // gateway composition boundary (dsh-runtime FATAL_STARTUP_BLOCK_REASONS).
        const hardBlockedReasons = new Set<string>(FATAL_STARTUP_BLOCK_REASONS);
        if (result.blockedReason !== null && hardBlockedReasons.has(result.blockedReason)) {
          await publishBlockedStartup(`运行时恢复元数据异常（${result.blockedReason}）；拒绝启动以保护 DSH_HOME`);
          return result;
        }
        if (result.blockedReason === 'swap-attempted') {
          await publishBlockedStartup('上次运行时指针切换未完成；请显式重试应用', {
            canRetryApply: true,
            swapAttempted: true,
          });
          return result;
        }

        try {
          const current = await startAndProbeCurrent(hostState.operationAbort.signal);
          if (!probesPassed(current.probes)) throw new Error(probeFailureMessage('runtime compatibility probes failed', current.probes));
          if (current.active.source === 'user' && current.active.version !== null) {
            noteBoot(runtimeBaseDir, current.active.version);
            promoteDueCandidates(runtimeBaseDir);
          }
          setRuntimeGate(false);
          await refreshRuntimeEvidence({
            phase: result.blockedReason === 'snapshot-failed' ? 'snapshot-failed' : 'idle',
            error: result.blockedReason === 'snapshot-failed'
              ? overrideSnapshotDiagnostic('快照失败；当前运行时仍可安全使用')
              : null,
            canRetryApply: result.blockedReason === 'snapshot-failed',
            canRetryRestore: false,
            runtimeBlocked: false,
            runtimeBlockedReason: null,
            snapshotError: result.blockedReason === 'snapshot-failed'
              ? overrideSnapshotDiagnostic('快照失败')
              : null,
          });
        } catch (error) {
          await plane.stopLocal().catch(() => undefined);
          const monitoring = result.monitoringJournal;
          if (monitoring !== null && monitoring.targetIsBuiltin === false && !envOverrideActive) {
            try {
              removeKnownGoodCandidate(runtimeBaseDir, monitoring.targetVersion);
              const rollbackOutcome = await runDelayedRollback(deps, monitoring, hostState.operationAbort?.signal);
              await publishApplyOutcome(
                rollbackOutcome,
                monitoring.targetVersion,
                false,
                monitoring.sourceVersion,
              );
              return result;
            } catch (rollbackError) {
              await publishBlockedStartup(`运行时探针失败且自动回退未完成：${describeError(rollbackError)}`);
              return result;
            }
          }
          await publishBlockedStartup(describeError(error));
        }
        return result;
      })().catch(async (error) => {
        await plane.stopLocal().catch(() => undefined);
        await publishBlockedStartup(describeError(error));
        return null;
      }).finally(() => {
        hostState.internalStart = false;
        hostState.transactionWorkspace = null;
        operationLease?.release();
        hostState.operationAbort = null;
        hostState.operation = null;
        void runStorePruneIfNeeded();
        void runSnapshotMaintenance().catch(error => {
          console.error(`[${logTag}] dsh runtime snapshot maintenance failed:`, sanitizeErrorText(describeError(error)));
        });
      });
      hostState.operation = operation;
      return operation;
    };

    const runRestartExhaustedRollback = (): Promise<StartupResult | null> | null => {
      if (isQuitting() || hostState.operation !== null || envOverrideActive || !runtimeManagementSupported) return null;
      let operationLease: OperationLease | null = null;
      const operation = (async (): Promise<StartupResult | null> => {
        hostState.operationAbort = new AbortController();
        setRuntimeGate(true, 'dsh 运行时连续重启失败，正在自动回退');
        operationLease = await writerFence.acquire('runtime:restart-exhausted', hostState.operationAbort.signal);
        // Re-read after the shared fence. An install may have been in flight
        // when restart-exhausted fired and may have durably queued nextIntent.
        const state = runtimeInstance.getState();
        const failedVersion = state.source === 'user' ? state.active : null;
        if (failedVersion === null) return null;
        const plan = planRestartExhaustedRollback({
          restartExhausted: true,
          activeIsOverride: state.source === 'user',
          failedVersion,
          journalState: readActivationJournalState(runtimeBaseDir),
        });
        if (plan.status === 'not-triggered') return null;
        if (plan.status === 'planned') {
          // Exactly-once latch: rollback-needed reaches disk before candidate
          // mutation, host stop, pointer switch, or DSH_HOME restore.
          writeActivationJournal(runtimeBaseDir, {
            ...plan.journal,
            nextIntent: plan.deferredIntent,
          });
        }
        const rollbackTarget = plan.rollbackTarget;
        const sourceVersion = plan.journal.sourceVersion;
        await refreshRuntimeEvidence({
          phase: 'applying',
          error: 'dsh 运行时连续重启失败，正在自动回退',
          targetVersion: failedVersion,
          rollbackTarget,
          runtimeBlocked: true,
          runtimeBlockedReason: 'dsh 运行时连续重启失败，正在自动回退',
          canRetryApply: false,
          canRetryRestore: false,
        });
        removeKnownGoodCandidate(runtimeBaseDir, failedVersion);
        const result = await runStartupPhase(buildStartupDeps(), hostState.operationAbort?.signal);
        if (result.applyOutcome === null) {
          await publishBlockedStartup(`restart-exhausted 回退未完成${result.blockedReason === null ? '' : `：${result.blockedReason}`}`);
          return result;
        }
        await publishApplyOutcome(
          result.applyOutcome,
          failedVersion,
          false,
          sourceVersion,
        );
        return result;
      })().catch(async (error) => {
        await plane.stopLocal().catch(() => undefined);
        await publishBlockedStartup(`restart-exhausted 回退失败：${describeError(error)}`);
        return null;
      }).finally(() => {
        hostState.internalStart = false;
        hostState.transactionWorkspace = null;
        operationLease?.release();
        hostState.operationAbort = null;
        hostState.operation = null;
        void runStorePruneIfNeeded();
        void runSnapshotMaintenance().catch(error => {
          console.error(`[${logTag}] dsh runtime snapshot maintenance failed:`, sanitizeErrorText(describeError(error)));
        });
      });
      hostState.operation = operation;
      return operation;
    };

    const authoritativeMetadataRecoveryStatus = (): RecoverableMetadataStatus | null => {
      const state = runtimeInstance.getState();
      // 'incomplete' is a permanent restore outcome (the journaled snapshot is
      // missing or untrustworthy): retry-restore can never succeed, so the
      // recover-metadata escape stays eligible even while canRetryRestore is
      // still advertised and even when a stale restore marker from the
      // abandoned transaction is still present. 'half' remains transient and
      // retryable, so it keeps every gate closed.
      const permanentIncomplete = state.restoreOutcome === 'incomplete';
      if (isQuitting()
        || state.runtimeBlocked !== true
        || (state.phase !== 'idle' && state.phase !== 'failed')
        || (state.canRetryRestore === true && !permanentIncomplete)
        || state.restoreOutcome === 'half'
        || state.source === 'env'
        || state.managementSupported === false
        || runtimeBootstrapWriterUnsafe
        || !plane.localWritersQuiescent()
        || bundledVersion === null
        || !isSafeVersion(bundledVersion)
        || (!permanentIncomplete && restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing')) return null;
      try {
        const health = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion);
        if (state.metadataHealth !== health.status) return null;
        if (health.status === 'selection-corrupt' || health.status === 'recovery-in-progress') {
          return health.status;
        }
        if (health.status === 'recovery-marker-corrupt'
          && inspectCorruptMetadataRecoveryMarker(runtimeBaseDir).recoverable) {
          return health.status;
        }
        return null;
      } catch (error) {
        // Returning null means "nothing recoverable", so a failed detection
        // read must stay visible instead of silently closing the recovery
        // escape. The success path is unchanged.
        console.warn(
          `[${logTag}] 运行时元数据健康探测失败（按无可恢复状态处理）：${sanitizeErrorText(describeError(error))}`,
        );
        return null;
      }
    };

    const runUserMetadataRecovery = (
      expectedStatus: RecoverableMetadataStatus,
    ): Promise<StartupResult | null> | null => {
      if (hostState.operation !== null || authoritativeMetadataRecoveryStatus() !== expectedStatus) return null;
      let operationLease: OperationLease | null = null;
      const operation = (async (): Promise<StartupResult | null> => {
        hostState.operationAbort = new AbortController();
        operationLease = writerFence.tryAcquire('runtime:metadata-recovery');
        if (operationLease === null || authoritativeMetadataRecoveryStatus() !== expectedStatus) return null;
        await executeMetadataRecovery(
          hostState.operationAbort.signal,
          expectedStatus,
          expectedStatus === 'recovery-marker-corrupt',
        );
        return null;
      })().catch(async (error) => {
        await plane.stopLocal().catch(() => undefined);
        await publishBlockedStartup(`元数据恢复事务失败：${describeError(error)}`);
        return null;
      }).finally(() => {
        hostState.internalStart = false;
        hostState.transactionWorkspace = null;
        operationLease?.release();
        hostState.operationAbort = null;
        hostState.operation = null;
        void runStorePruneIfNeeded();
      });
      hostState.operation = operation;
      return operation;
    };

    // 六注册体在 shell-core installIpcHandlers ② J 组段（RUNTIME_STATE /
    // RUNTIME_RESTART / RUNTIME_CHECK / RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION /
    // RUNTIME_CLEAR_FAILURE）。
    // 确认对话框 → core 内
    // confirmRuntimeMutation 助手（edges.showMessage 宿主腿——按钮序/取消
    // 默认/文案逐字一致；无窗 → 'native confirmation unavailable' 不确认语义）；
    // DshRuntimeController 控制器
    // 现实例经 ctx.runtimeController 注入
    // （本作用域 runtimeInstance——实例态留本文件，core 只做类型面）；
    // hostState.operation 槽在飞读门 / writerFence / runtimeActionAllowed /
    // runtimeBaseDir / refreshRuntimeEvidence / runStorePruneIfNeeded 均经 ctx 注入
    // 同一现实例/闭包（K 组与启动路径共用，语义不分叉）；restartLocal 类宿主叶 =
    // ctx.restartLocalDsh（PlaneHandle 在 main，controlPlane null 门 + restartLocal()
    // + resolve 后实时 connectionState 读封装在 shellCtx 装配叶内）。
    const runtimeActionAllowed = (action: Parameters<typeof allowedActions>[0] extends never ? never : ReturnType<typeof allowedActions>[number]) => {
      const state = runtimeInstance.getState();
      if (state.managementSupported === false && action !== 'retry-restore') return false;
      if (action === 'recover-metadata' && state.source === 'env') return false;
      const applyingReset = action === 'reset-builtin'
        && state.phase === 'applying'
        && state.source !== 'env'
        && state.hasOverride === true;
      if (writerFence.busy && !applyingReset) return false;
      if (state.runtimeBlocked === true) {
        if (action === 'retry-restore') return state.canRetryRestore === true
          && (state.phase === 'rollback' || state.phase === 'failed');
        if (action === 'recover-metadata') return (state.canRetryRestore !== true
            || state.restoreOutcome === 'incomplete')
          && state.canRecoverMetadata === true
          && (state.metadataHealth === 'selection-corrupt'
            || state.metadataHealth === 'recovery-in-progress'
            || state.metadataHealth === 'recovery-marker-corrupt')
          && (state.phase === 'idle' || state.phase === 'failed');
        if (action === 'retry-apply') return state.canRetryApply === true
          && (state.phase === 'snapshot-failed' || state.phase === 'failed');
        if (applyingReset) return true;
        return false;
      }
      return allowedActions(state.phase, {
        canRetryApply: state.canRetryApply,
        canRetryRestore: state.canRetryRestore,
        canRecoverMetadata: state.canRecoverMetadata,
      }).includes(action);
    };
    // RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN / RUNTIME_RETRY_APPLY /
    // RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE / RUNTIME_RESTORE_PRE_ROLLBACK 在
    // shell-core installIpcHandlers ② K 组段（紧接 J 组；注册体
    // trustedIpc 围栏由装配侧注入 registrar 包装）。
    // 确认对话框 → core 内 J 组段
    // confirmRuntimeMutation 助手；
    // 运行时启动事务宿主与共享闭包族留本文件、
    // 经 ctx 注入 core（runRuntimeStartup / publishBlockedStartup / setRuntimeGate /
    // authoritativeMetadataRecoveryStatus / runUserMetadataRecovery /
    // readApplyNowGateInput / selectedJournalIntent / stopLocalDsh（cp.stopLocal 叶）/
    // runtimeOperationSlot（事务槽 begin/end/inFlight——槽本体仍为本文件模块级
    // hostState.operation）/ bundledRuntimeVersion——K 组注册体与启动/证据路径共用同一
    // 实现/同一事务槽，语义不分叉）；dsh-runtime 纯逻辑（queueActivationIntent /
    // writeActivationIntent / restoreMarkerAuthorityStatus / readActivationJournalState /
    // writeOverride / listPreRollbackStashes / restorePreRollback）与 apply-now-gate.ts
    // 的 evaluateApplyNowGate 由 core 直接 import（本文件仅剩
    // ApplyNowGateInput 类型 import 供下方 readApplyNowGateInput 输入构造叶使用）。
    // 本文件没有 ipcMain.handle(IPC_CHANNELS…
    // 注册点，也没有 webContents.send 调用（Electron 注册面唯一收口 = 下方装配侧 registrar
    // 包装 `ipcMain.handle(channel, trustedIpc(handler))`——trustedIpc 围栏注入
    // 点，installIpcHandlers 每 channel 恰经它注册一次；
    // 见文件头职责清单）。
    // Apply-now (design 18 addendum §4.1): run the existing activation
    // transaction in the CURRENT session instead of waiting for the next
    // launch. Entry pattern mirrors RUNTIME_RETRY_APPLY: no outer
    // writer-fence lease is held across the transaction — runRuntimeStartup
    // acquires 'runtime:startup' itself, and an outer lease would deadlock
    // with it. The transaction window is the existing applying projection;
    // publishApplyOutcome settles the terminal state.
    // The gate is the pure evaluateApplyNowGate (apply-now-gate.ts), evaluated
    // BEFORE and AFTER the native confirm dialog from the SAME input builder
    // (TOCTOU parity). Both gates resolve the target identically —
    // pending ?? journalTarget ?? overridePending — and preflight the target
    // tree, so the second gate can never accept something the first would
    // reject, and a corrupt tree never starts a doomed stop/respawn cycle.
    const readApplyNowGateInput = (): ApplyNowGateInput => {
      const state = runtimeInstance.getState();
      const journalState = readActivationJournalState(runtimeBaseDir);
      const overrideState = readOverrideState(runtimeBaseDir);
      const journalTarget = selectedJournalIntent(journalState)?.targetVersion ?? null;
      // Same predicate as state.pending's projection (dsh-runtime-controller):
      // an invalidated or old-shell override's raw pending must not resolve a
      // durable target for apply-now.
      const overridePending = overrideState.kind === 'valid' && !envOverrideActive
        ? effectivePending(overrideState.record, shellVersion)
        : null;
      const target = state.pending ?? journalTarget ?? overridePending;
      // Corrupt/unreadable override bytes are never read as "no snapshot
      // failure": an unknowable question must not resolve to the clean
      // answer. The controller publishes the same leaf as runtimeBlocked
      // (checked before snapshotFailed by evaluateApplyNowGate), and this
      // input stays fail-closed even if that lock is bypassed.
      const overrideSnapshotFailed = overrideState.kind === 'corrupt'
        || overrideState.kind === 'unknown'
        || (overrideState.kind === 'valid' && overrideState.record.lastOutcome === 'snapshot-failed');
      return {
        phase: state.phase,
        source: state.source,
        runtimeBlocked: state.runtimeBlocked === true,
        managementSupported: state.managementSupported !== false,
        hasOverride: state.hasOverride === true,
        pending: state.pending,
        journalTarget,
        overridePending,
        connectionState: (plane.connectionState() ?? 'none'),
        operationBusy: hostState.operation !== null,
        fenceBusy: writerFence.busy,
        snapshotFailed: overrideSnapshotFailed,
        treeValid: target === null || validateVersionTree(runtimeBaseDir, target).ok,
      };
    };
    // Startup refresh plus a real periodic cycle. Both share the same core
    // gate, so apply/restore suspends checks and the next cycle resumes them.
    // maybeCheckRuntime/runRuntimeCheck 实现位于 shell-core installIpcHandlers ②
    // J 组段——计时器仍为本文件宿主调度（首检 15s
    // + 周期 6h，unref 语义不变），每次 tick 经 core 导出入口 runRuntimeCheckCycle
    // 走与 IPC 注册体同一实现与门（quit/事务在飞/动作不允许时 no-op——装配槽在
    // installIpcHandlers J 组段尾部赋值，先于任何 tick）。
    const startupRuntimeCheck = setTimeout(() => { runRuntimeCheckCycle(); }, 15_000);
    startupRuntimeCheck.unref();
    const periodicRuntimeCheck = setInterval(() => { runRuntimeCheckCycle(); }, 6 * 60 * 60 * 1_000);
    periodicRuntimeCheck.unref();
    // Promotion needs a real in-process health interval. The state listener
    // above closes the window on any unhealthy transition; this timer merely
    // commits candidates whose still-open window has actually elapsed.
    const knownGoodPromotionTimer = setInterval(() => {
      if (isQuitting() || hostState.operation !== null || !plane.localProcessAlive()) return;
      try { promoteDueCandidates(runtimeBaseDir); } catch (error) {
        console.error(`[${logTag}] known-good 晋升检查失败：`, sanitizeErrorText(describeError(error)));
      }
    }, 60 * 60 * 1_000);
    knownGoodPromotionTimer.unref();
  return {
    runtimeInstance,
    refreshRuntimeEvidence,
    setRuntimeGate,
    publishBlockedStartup,
    runRuntimeStartup,
    runRestartExhaustedRollback,
    authoritativeMetadataRecoveryStatus,
    runUserMetadataRecovery,
    runtimeActionAllowed,
    readApplyNowGateInput,
    selectedJournalIntent,
  };
}
