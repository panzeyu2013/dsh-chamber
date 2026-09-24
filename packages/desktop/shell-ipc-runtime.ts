/**
 * shell-ipc-runtime — domain IPC registrations
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { StartupResult } from '@dsh-chamber/dsh-runtime'
import { IPC_CHANNELS } from './ipc-events.ts'
import { cleanupExplicitRuntimeVersion, clearRuntimeFailure, isSafeVersion, listExplicitlyInstalledVersions, listPreRollbackStashes, listRuntimeFailures, queueActivationIntent, readActivationJournalState, readOverrideState, restoreMarkerAuthorityStatus, restorePreRollback, writeActivationIntent, writeOverride } from '@dsh-chamber/dsh-runtime'
import { describeError } from './describe-error.ts'
import { evaluateApplyNowGate } from './apply-now-gate.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export function registerRuntimeHandlersA(ctx: ShellIpcCtx): void {
  const { deps } = ctx
  const { runtimeController: runtimeInstance, runtimeOperationBusy, runtimeWriterFence, restartLocalDsh } = ctx.deps.ctx
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_STATE, () => runtimeInstance.getState());
  // Transactional managed-dsh restart (design 18 §3.6 项 8): refreshes mounted
  // plugins. Not a version mutation — the pointer/tree is untouched, so no
  // snapshot/probe gate; the control-plane restartLocal() is single-flight,
  // serialized with health restarts, and respects canStartLocal.
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RESTART, async () => {
    const state = runtimeInstance.getState();
    // RESTART-GATE RULING: core allowedActions offers
    // restart-dsh in idle/available/applied/rollback/failed/error only;
    // this refusal = busy set (the five no-restart phases) + explicit
    // snapshot-failed/runtimeBlocked + single-flight gates. NOT a pure
    // allowedActions gate: failed/error allow restart-dsh there yet are
    // refused here while runtimeBlocked — do not substitute one expression
    // for the other before ruling. Gateway route gate checks only
    // applying/installing for its REST restart surface.
    const busyPhase = state.phase === 'checking' || state.phase === 'downloading'
      || state.phase === 'installing' || state.phase === 'applying' || state.phase === 'pending';
    if (runtimeOperationBusy() || runtimeWriterFence.busy || busyPhase
      || state.runtimeBlocked === true
      || state.phase === 'snapshot-failed') {
      // Honest refusal: a busy runtime must not resolve into a
      // silent no-op "success" — the renderer shows the failure line.
      // env 来源与只读平台（managementSupported=false）不拒绝
      // 重启——「重启 dsh」是来源/平台无关动作（design 18 §3.6 项 8，
      // 与 gateway 行为一致）。
      const reason = state.runtimeBlocked === true
        ? state.runtimeBlockedReason ?? 'runtime blocked'
        : 'dsh runtime is busy (another runtime operation is in progress)'
      throw new Error(sanitizeErrorText(reason));
    }
    // Hold the shared writer fence for the transaction: other runtime
    // actions (retry-apply / restore-pre-rollback / reset-builtin) acquire
    // the same fence, so a restart cannot interleave with a stopLocal()
    // from a concurrent mutation.
    const restartLease = runtimeWriterFence.tryAcquire('runtime:restart');
    if (restartLease === null) {
      throw new Error('dsh runtime is busy (another writer holds the fence)');
    }
    try {
      // PlaneHandle 宿主腿 = ctx.restartLocalDsh（controlPlane null
      // 门 + restartLocal() + resolve 后实时 connectionState 读——封装在 main 装
      // 配侧叶）。
      const connectionState = await restartLocalDsh();
      // CONTRACT (design 18 §9.3): resolve ≠ success — a restart that
      // exhausted the shared window settles into restart-exhausted (or
      // error) and RESOLVES; project that honestly instead of a silent
      // "healthy" runtime state.
      // Whitelist: restartLocal() also resolves from
      // restart-exhausted / error / stopped and can bail on an epoch bump
      // while 'restarting' is still live — only ready/degraded (process
      // alive) is a success; resolve ≠ success, strictly.
      if (connectionState !== 'ready' && connectionState !== 'degraded') {
        throw new Error(`dsh restart did not reach ready (${connectionState})`);
      }
      return runtimeInstance.getState();
    } catch (error) {
      const message = sanitizeErrorText(describeError(error));
      console.warn('[dsh-chamber] restart dsh failed:', message);
      // Honest failure (design 18 §3.6 项 8): reject so the renderer shows
      // the failure line instead of silently resolving.
      throw new Error(message);
    } finally {
      restartLease.release();
    }
  });
}

export function registerRuntimeHandlersB(ctx: ShellIpcCtx): void {
  const { deps, confirmRuntimeMutation, runRuntimeCheck } = ctx
  const { refreshRuntimeEvidence, runStorePruneIfNeeded, runtimeActionAllowed, runtimeBaseDir, runtimeController: runtimeInstance, runtimeOperationBusy, runtimeWriterFence, settingsIO } = ctx.deps.ctx
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_CHECK, runRuntimeCheck);
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_INSTALL, async (args) => {
    const v = args !== null && typeof args === 'object' ? (args as Record<string, unknown>).version : undefined;
    if (typeof v !== 'string' || v.length > 128 || !isSafeVersion(v)) return runtimeInstance.getState();
    const requestedVersion = v.trim();
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy() || before.source === 'env' || !runtimeActionAllowed('install')) {
      return before;
    }
    if (!await confirmRuntimeMutation(
      `安装 dsh 运行时 ${requestedVersion}？`,
      // registry origin 经 settingsIO.current() 读（live holder——确认框展示
      // 当前源）。
      `将从 ${settingsIO.current().registryOrigin} 下载并执行白名单依赖的安装脚本；切换将在下次启动应用。`,
      '安装',
    )) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy() || current.source === 'env' || !runtimeActionAllowed('install')) {
      return current;
    }
    const lease = runtimeWriterFence.tryAcquire('runtime:install');
    if (lease === null) return runtimeInstance.getState();
    try {
      await runtimeInstance.install(requestedVersion);
      await refreshRuntimeEvidence();
      return runtimeInstance.getState();
    } finally {
      lease.release();
    }
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_CLEANUP_VERSION, async (args) => {
    const rawVersion = args !== null && typeof args === 'object'
      ? (args as Record<string, unknown>).version
      : undefined;
    if (typeof rawVersion !== 'string' || rawVersion.length > 128 || !isSafeVersion(rawVersion)) {
      return runtimeInstance.getState();
    }
    const requestedVersion = rawVersion.trim();
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || before.source === 'env'
      || before.active === requestedVersion
      || !runtimeActionAllowed('cleanup-version')
      || !listExplicitlyInstalledVersions(runtimeBaseDir).includes(requestedVersion)) {
      return before;
    }
    if (!await confirmRuntimeMutation(
      `清理 dsh 运行时 ${requestedVersion}？`,
      '仅删除该不可变版本树并回收 pnpm store；当前、待应用、回退、known-good 与失败现场保护版本不会被删除。',
      '清理版本',
    )) return runtimeInstance.getState();

    // Re-read eligibility after confirmation. cleanupExplicitRuntimeVersion
    // re-reads the complete protection set again while the writer fence is
    // held, so a new recovery/pending reference always wins the TOCTOU race.
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || current.source === 'env'
      || current.active === requestedVersion
      || !runtimeActionAllowed('cleanup-version')
      || !listExplicitlyInstalledVersions(runtimeBaseDir).includes(requestedVersion)) {
      return current;
    }
    const lease = runtimeWriterFence.tryAcquire('runtime:cleanup-version');
    if (lease === null) return runtimeInstance.getState();
    try {
      const locked = runtimeInstance.getState();
      if (locked.source === 'env'
        || locked.active === requestedVersion
        || !listExplicitlyInstalledVersions(runtimeBaseDir).includes(requestedVersion)) {
        return locked;
      }
      const result = cleanupExplicitRuntimeVersion(runtimeBaseDir, requestedVersion);
      if (result.stillProtected) {
        throw new Error(`dsh ${requestedVersion} 仍被当前/回退/恢复/失败证据保护，拒绝清理`);
      }
      await runStorePruneIfNeeded();
      await refreshRuntimeEvidence();
      const refreshed = runtimeInstance.getState();
      const clearedDiskGate = locked.phase === 'error'
        && (locked.diskLimitExceeded === true || locked.diskError != null)
        && refreshed.diskLimitExceeded === false
        && refreshed.diskError === null;
      if (clearedDiskGate) runtimeInstance.setLifecycle({ phase: 'idle', error: null });
      return runtimeInstance.getState();
    } finally {
      lease.release();
    }
  });
  // 失败现场清除：仅本地入口（gateway 无现成路由，
  // 登记偏差）。版本必须真实存在于失败记录名集（主进程 re-read，绝不信任
  // renderer），且不得有在飞运行时事务；只删除 failures/*.json 记录本身，
  // 不动任何版本树/快照/回滚现场。清除后刷新磁盘与失败投影并返回最新 state。
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_CLEAR_FAILURE, async (args) => {
    const rawVersion = args !== null && typeof args === 'object'
      ? (args as Record<string, unknown>).version
      : undefined;
    if (typeof rawVersion !== 'string' || rawVersion.length > 128 || !isSafeVersion(rawVersion)) {
      return runtimeInstance.getState();
    }
    const requestedVersion = rawVersion.trim();
    if (runtimeOperationBusy()
      || !listRuntimeFailures(runtimeBaseDir).some((failure) => failure.version === requestedVersion)) {
      return runtimeInstance.getState();
    }
    try {
      clearRuntimeFailure(runtimeBaseDir, requestedVersion);
    } catch (error) {
      const message = sanitizeErrorText(describeError(error));
      console.warn('[dsh-chamber] clear runtime failure scene failed:', message);
      throw new Error(message);
    }
    await refreshRuntimeEvidence();
    return runtimeInstance.getState();
  });
}

export function registerRuntimeHandlersC(ctx: ShellIpcCtx): void {
  const { deps, confirmRuntimeMutation, quittingLeaf } = ctx
  const { authoritativeMetadataRecoveryStatus, bundledRuntimeVersion: bundledVersion, localDshHome, publishBlockedStartup, readApplyNowGateInput, refreshRuntimeEvidence, runRuntimeStartup, runUserMetadataRecovery, runtimeActionAllowed, runtimeBaseDir, runtimeController: runtimeInstance, runtimeOperationBusy, runtimeOperationSlot, runtimeWriterFence, selectedJournalIntent, setRuntimeGate, stopLocalDsh } = ctx.deps.ctx
  // runtime 6 注册体（RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN /
  // RUNTIME_RETRY_APPLY / RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE /
  // RUNTIME_RESTORE_PRE_ROLLBACK；trustedIpc 围栏由装配侧注入 registrar 包装）。
  //  - 确认对话框 = confirmRuntimeMutation 助手（按钮序/取消默认；无窗 →
  //    false = 'native confirmation unavailable' 不确认语义同向）。
  //  - 运行时启动事务宿主 = ctx 宿主叶 runRuntimeStartup（装配侧事务本体——内部
  //    gate/fence/事务槽/abort 管理与 executeMetadataRecovery 等恢复事务腿归装配
  //    侧；槽忙守卫「返回在飞事务」）；宿主启动门与阻塞发布叶 =
  //    ctx.setRuntimeGate / ctx.publishBlockedStartup（RESET_BUILTIN / RETRY_APPLY /
  //    RESTORE_PRE_ROLLBACK 的 blocked 发布与 gate 写与启动路径同一实现）。
  //  - 元数据恢复资格投影/事务宿主 = ctx 宿主叶 authoritativeMetadataRecoveryStatus /
  //    runUserMetadataRecovery（RECOVER_METADATA 注册体与恢复事务启动共用同一实现，
  //    语义不分叉——executeMetadataRecovery 与槽/abort 写留装配侧）。
  //  - APPLY_NOW 门：evaluateApplyNowGate = apply-now-gate.ts 纯逻辑直接 import
  //    （纯门矩阵，无宿主依赖）；门输入构造 readApplyNowGateInput 经 ctx 注入
  //    （装配侧构造——controlPlane.connectionState / envOverrideActive / 事务槽等
  //    宿主读在叶内；pending ?? journalTarget ?? overridePending 三源解析与目标树
  //    preflight）。quit 在途门 = quittingLeaf()（ctx.isQuitting 快照）。
  //  - runtime 事务槽：注册体经 runtimeOperationBusy() 读装配侧模块级槽（live
  //    读，同一事实源）；RESET_BUILTIN 的 queue-behind-applying 需 await 在飞事务
  //    本体（runtimeOperationSlot.inFlight()）；RESTORE_PRE_ROLLBACK 经
  //    runtimeOperationSlot.begin/end 登记/清槽在飞事务——槽本体（模块级
  //    runtimeOperation）单写者归装配侧（启动事务/自动回滚经同一槽串行化，语义
  //    不分叉）。
  //  - dsh-runtime 纯逻辑直接 import（queueActivationIntent / writeActivationIntent /
  //    restoreMarkerAuthorityStatus / readActivationJournalState / writeOverride /
  //    listPreRollbackStashes / restorePreRollback——electron-free 共享核）；
  //    selectedJournalIntent 经 ctx（装配侧启动路径 readActivationFacts 共用同一
  //    实现）；bundledVersion = ctx.bundledRuntimeVersion 装配期值（解构改名）；
  //    本机宿主停止腿 = ctx.stopLocalDsh（PlaneHandle 宿主不进入 core，同
  //    restartLocalDsh 先例）。
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RECOVER_METADATA, async () => {
    const before = runtimeInstance.getState();
    const expectedStatus = authoritativeMetadataRecoveryStatus();
    // First authority read occurs before showing a destructive native
    // confirmation. A forged renderer action cannot manufacture eligibility.
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('recover-metadata')
      || expectedStatus === null) return before;
    if (!await confirmRuntimeMutation(
      '保留数据并恢复内建 dsh？',
      expectedStatus === 'recovery-marker-corrupt'
        ? '将停止本地实例，另存一份完整 DSH_HOME，把损坏的恢复标记按原始字节归档且不修改既有恢复数据，再用内建 dsh 执行完整只读探针。只有探针全部通过才会恢复本地访问。'
        : '将停止本地实例，先保留 DSH_HOME 完整数据副本和原始选择元数据证据，再用内建 dsh 执行完整只读探针。只有探针全部通过才会恢复本地访问。',
      '保留数据并恢复内建',
    )) return runtimeInstance.getState();
    // Re-read after the modal. A restore marker, env override, platform
    // change, writer, or another recovery transaction always wins the race.
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('recover-metadata')
      || authoritativeMetadataRecoveryStatus() !== expectedStatus) return runtimeInstance.getState();
    const operation = runUserMetadataRecovery(expectedStatus);
    if (operation === null) return runtimeInstance.getState();
    await operation;
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RESET_BUILTIN, async () => {
    const before = runtimeInstance.getState();
    const queueBehindApplying = runtimeOperationBusy() && before.phase === 'applying';
    if ((!queueBehindApplying && runtimeOperationBusy()) || before.source === 'env' || before.hasOverride !== true
      || !runtimeActionAllowed('reset-builtin')) return before;
    if (!queueBehindApplying && restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
      setRuntimeGate(true, '数据恢复未完成；恢复内建前须先重试恢复');
      return refreshRuntimeEvidence({
        phase: 'failed', canRetryRestore: true, restoreOutcome: 'incomplete',
        error: '数据恢复未完成；恢复内建前须先重试恢复',
        runtimeBlocked: true,
        runtimeBlockedReason: '数据恢复未完成；恢复内建前须先重试恢复',
      }).then(() => runtimeInstance.getState());
    }
    if (!await confirmRuntimeMutation('恢复内建 dsh 运行时？', '将停止本地实例并清除用户运行时指针；版本树与快照仍保留。', '恢复内建')) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    const inFlight = runtimeOperationSlot.inFlight();
    const stillQueueing = inFlight !== null && current.phase === 'applying';
    if ((!stillQueueing && runtimeOperationBusy()) || current.source === 'env' || current.hasOverride !== true
      || !runtimeActionAllowed('reset-builtin')) return current;
    if (stillQueueing) {
      try {
        if (bundledVersion === null || !isSafeVersion(bundledVersion)) throw new Error('无法确认内建 dsh 运行时版本');
        queueActivationIntent(runtimeBaseDir, {
          targetVersion: bundledVersion,
          targetIsBuiltin: true,
          manualRollback: false,
          intentKind: 'reset-builtin',
        });
      } catch (error) {
        runtimeInstance.setLifecycle({
          error: sanitizeErrorText(`无法排队恢复内建事务：${describeError(error)}`),
        });
        return runtimeInstance.getState();
      }
      await inFlight.catch(() => null);
      await runRuntimeStartup();
      return runtimeInstance.getState();
    }
    if (restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
      setRuntimeGate(true, '数据恢复未完成；恢复内建前须先重试恢复');
      return refreshRuntimeEvidence({
        phase: 'failed', canRetryRestore: true, restoreOutcome: 'incomplete',
        error: '数据恢复未完成；恢复内建前须先重试恢复',
        runtimeBlocked: true,
        runtimeBlockedReason: '数据恢复未完成；恢复内建前须先重试恢复',
      }).then(() => runtimeInstance.getState());
    }
    try {
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        throw new Error('无法确认内建 dsh 运行时版本');
      }
      writeActivationIntent(runtimeBaseDir, {
        targetVersion: bundledVersion,
        targetIsBuiltin: true,
        manualRollback: false,
        intentKind: 'reset-builtin',
      });
    } catch (error) {
      await publishBlockedStartup(`无法持久化恢复内建事务：${describeError(error)}`);
      return runtimeInstance.getState();
    }
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RETRY_APPLY, async () => {
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy() || before.source === 'env'
      || !runtimeActionAllowed('retry-apply')) return before;
    const overrideState = readOverrideState(runtimeBaseDir);
    const journalState = readActivationJournalState(runtimeBaseDir);
    const retryTarget = selectedJournalIntent(journalState)?.targetVersion
      ?? (overrideState.kind === 'valid' ? overrideState.record.pending : null);
    if (retryTarget === null) return runtimeInstance.getState();
    if (!await confirmRuntimeMutation(`重试应用 dsh ${retryTarget}？`, '将停止本地实例并从持久化事务安全续作。', '重试应用')) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy() || current.source === 'env'
      || !runtimeActionAllowed('retry-apply')) return current;
    const latestOverride = readOverrideState(runtimeBaseDir);
    if (latestOverride.kind === 'valid') {
      writeOverride(runtimeBaseDir, {
        ...latestOverride.record,
        swapAttempted: false,
        lastOutcome: null,
        lastError: null,
      });
    }
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  // Apply-now 入口语义（本文件只挂注册体；完整注记见 main 装配侧
  // readApplyNowGateInput 与段头注释）。
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_APPLY_NOW, async () => {
    const before = runtimeInstance.getState();
    // Quit is in flight: never start a transaction that the quit path will
    // immediately abort (same gate as runRuntimeCheck).
    if (quittingLeaf()) return before;
    const gate = evaluateApplyNowGate(readApplyNowGateInput());
    // Without a durable pending transaction a startup would only stop
    // and respawn the instance pointlessly. A snapshot-failed override must
    // be retried through the dedicated retry-apply path instead; a corrupt
    // target tree is rejected before any stopLocal is attempted.
    if (!gate.ok) return before;
    if (!await confirmRuntimeMutation(
      `立即切换到 dsh ${gate.target}？`,
      'dsh 将立即重启并切换到该版本（约 30–90 秒）。进行中的会话会中断，你的数据不受影响；若切换失败，dsh 会自动回滚并保留现场。',
      '立即应用并重启',
    )) return runtimeInstance.getState();
    // TOCTOU: re-read the full gate after the modal, exactly like retry-apply.
    // The input builder is identical to the first gate, so the second gate
    // covers the override.pending fallback and tree preflight too.
    const current = runtimeInstance.getState();
    const secondGate = evaluateApplyNowGate(readApplyNowGateInput());
    // The confirm dialog named gate.target: a re-read that resolves a
    // different target must not start a transaction for a version the user
    // never confirmed.
    if (!secondGate.ok || secondGate.target !== gate.target) return current;
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RETRY_RESTORE, async () => {
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('retry-restore')) return before;
    if (!await confirmRuntimeMutation('重试恢复 dsh 数据？', '将停止本地实例并从已记录的快照事务继续恢复。', '重试恢复')) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('retry-restore')) return current;
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RESTORE_PRE_ROLLBACK, async (args) => {
    // Only a stash-shaped basename is accepted; the main process re-validates
    // it against its own private pre-rollback listing before any mutation.
    const stashName = args !== null && typeof args === 'object'
      ? (args as Record<string, unknown>).stashName
      : undefined;
    if (typeof stashName !== 'string' || !/^\d{13}-[0-9a-f]{8}$/.test(stashName)) {
      return runtimeInstance.getState();
    }
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('restore-pre-rollback')) return before;
    if (!await confirmRuntimeMutation(
      '恢复回滚前数据？',
      '将停止本地实例，把当前 DSH_HOME 保留为 dsh-home.old，再用最近一次手动回滚前保存的数据覆盖恢复。恢复事务崩溃安全，可在下次启动续作。',
      '恢复回滚前数据',
    )) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('restore-pre-rollback')) return current;

    const restoreResult: {
      outcome: 'complete' | 'half' | 'incomplete' | 'blocked'
      error: string | null
    } = { outcome: 'blocked', error: null };
    const operation = (async (): Promise<StartupResult | null> => {
      const lease = runtimeWriterFence.tryAcquire('runtime:restore-pre-rollback');
      if (lease === null) return null;
      try {
        const stashes = await listPreRollbackStashes(runtimeBaseDir);
        if (!stashes.includes(stashName)) {
          throw new Error('回滚前数据暂存已不存在或不可信');
        }
        await stopLocalDsh();
        restoreResult.outcome = await restorePreRollback(runtimeBaseDir, localDshHome, stashName);
      } finally {
        lease.release();
      }
      return null;
    })().catch(async (error) => {
      await stopLocalDsh().catch(() => undefined);
      // Recorded, not hard-blocked: the startup transaction below restarts
      // the instance (a thrown transaction leaves a resumeable marker).
      // B1 §2.6: a real restore failure throws with its RestoreReport attached
      // (cause io-error/copy-failed/unexpected) and requireOutcome embeds that
      // cause in the thrown message, which describeError preserves verbatim —
      // so the diagnostic below carries WHY the restore stopped.
      restoreResult.error = sanitizeErrorText(describeError(error));
      return null;
    }).finally(() => {
      runtimeOperationSlot.end();
    });
    runtimeOperationSlot.begin(operation);
    await operation;
    // Only a fence-refused no-op (nothing recorded) may resolve silently. A
    // thrown restore leaves outcome at 'blocked' while recording its cause;
    // that MUST reach the error branch below instead of being swallowed here
    // (B1 §2.6 restoring no longer folds failures into 'incomplete').
    if (restoreResult.outcome === 'blocked' && restoreResult.error === null) return runtimeInstance.getState();
    // A 'half' restore leaves the durable marker for retry-restore to resume
    // (the standard restore-half convention).
    if (restoreResult.outcome === 'half') {
      await publishBlockedStartup('恢复回滚前数据未完成（现场已保留），请重试恢复', {
        restoreOutcome: 'half',
        canRetryRestore: true,
      });
      return runtimeInstance.getState();
    }
    if (restoreResult.outcome === 'incomplete') {
      // The stash was missing/untrustworthy, so DSH_HOME was never touched.
      // Restart the instance (never a hard block), then THROW so the
      // renderer surfaces the failure in its persistent action-error slot —
      // a silent restart would hide the rejection from the user.
      await runRuntimeStartup();
      throw new Error('回滚前数据暂存缺失或不可信；拒绝恢复');
    }
    if (restoreResult.error !== null) {
      await runRuntimeStartup();
      throw new Error(`恢复回滚前数据失败：${restoreResult.error}`);
    }
    // 'complete': restart the local instance against the restored data.
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
}
