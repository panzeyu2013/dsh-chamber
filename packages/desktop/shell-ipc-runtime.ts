/** shell-ipc-runtime — domain IPC registrations. */
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
  // Transactional managed-dsh restart (refreshes mounted plugins; not a version
  // mutation, so no snapshot/probe gate): restartLocal() is single-flight,
  // serialized with health restarts, and respects canStartLocal.
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RESTART, async () => {
    const state = runtimeInstance.getState();
    // RESTART-GATE: refuse the five no-restart phases (checking / downloading /
    // installing / applying / pending), snapshot-failed, runtimeBlocked, or a
    // held runtime-operation/writer fence. This is deliberately NOT the pure
    // allowedActions gate — failed/error allow restart-dsh there yet are refused
    // here while runtimeBlocked; keep the two expressions distinct.
    const busyPhase = state.phase === 'checking' || state.phase === 'downloading'
      || state.phase === 'installing' || state.phase === 'applying' || state.phase === 'pending';
    if (runtimeOperationBusy() || runtimeWriterFence.busy || busyPhase
      || state.runtimeBlocked === true
      || state.phase === 'snapshot-failed') {
      // Honest refusal: a busy runtime must not resolve into a silent no-op
      // "success". env sources and read-only platforms (managementSupported=false)
      // are NOT refused — "restart dsh" is source/platform independent.
      const reason = state.runtimeBlocked === true
        ? state.runtimeBlockedReason ?? 'runtime blocked'
        : 'dsh runtime is busy (another runtime operation is in progress)'
      throw new Error(sanitizeErrorText(reason));
    }
    // Hold the shared writer fence for the transaction so a restart cannot
    // interleave with a concurrent mutation's stopLocal() (retry-apply /
    // restore-pre-rollback / reset-builtin acquire the same fence).
    const restartLease = runtimeWriterFence.tryAcquire('runtime:restart');
    if (restartLease === null) {
      throw new Error('dsh runtime is busy (another writer holds the fence)');
    }
    try {
      // PlaneHandle 宿主腿 = ctx.restartLocalDsh（main 装配侧叶：null 门 +
      // restartLocal() + resolve 后实时 connectionState 读）。
      const connectionState = await restartLocalDsh();
      // resolve ≠ success: restartLocal() also resolves from
      // restart-exhausted / error / stopped and can bail on an epoch bump while
      // 'restarting' is still live — only ready/degraded (process alive) is
      // success; project anything else as a loud failure, never "healthy".
      if (connectionState !== 'ready' && connectionState !== 'degraded') {
        throw new Error(`dsh restart did not reach ready (${connectionState})`);
      }
      return runtimeInstance.getState();
    } catch (error) {
      const message = sanitizeErrorText(describeError(error));
      console.warn('[dsh-chamber] restart dsh failed:', message);
      // Reject so the renderer shows the failure line instead of silently resolving.
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
      // registry origin 经 settingsIO.current() 读（live holder——确认框展示当前源）。
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

    // Re-read eligibility after confirmation; the fence-held cleanup re-reads
    // the full protection set again, so a new reference wins the TOCTOU race.
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
  // 失败现场清除：仅本地入口（gateway 无路由）。版本必须真实存在于失败记录名集
  // （主进程 re-read，绝不信任 renderer），且不得有在飞运行时事务；只删
  // failures/*.json 记录本身，不动任何版本树/快照/回滚现场；随后刷新投影。
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
  // runtime 6 注册体（RECOVER_METADATA / RESET_BUILTIN / RETRY_APPLY / APPLY_NOW /
  // RETRY_RESTORE / RESTORE_PRE_ROLLBACK；trustedIpc 围栏由装配侧 registrar 注入）。
  // 确认框 = confirmRuntimeMutation（无窗 → false = 不确认）；启动事务宿主 =
  // ctx.runRuntimeStartup，宿主门/阻塞发布叶 = ctx.setRuntimeGate / publishBlockedStartup。
  // 恢复资格投影/事务 = ctx.authoritativeMetadataRecoveryStatus / runUserMetadataRecovery
  // （与恢复事务共用同一实现）；APPLY_NOW 纯门 = evaluateApplyNowGate，输入
  // readApplyNowGateInput 经 ctx 注入，quit 在途门 = quittingLeaf()。
  // 事务槽：runtimeOperationBusy() 为 live 读；RESET_BUILTIN queue-behind-applying
  // await 在飞事务；RESTORE_PRE_ROLLBACK 经 runtimeOperationSlot.begin/end 登记，
  // 槽本体单写者归装配侧。dsh-runtime 纯逻辑直接 import（electron-free）；
  // selectedJournalIntent / bundledVersion 经 ctx；本机停止腿 = ctx.stopLocalDsh。
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RECOVER_METADATA, async () => {
    const before = runtimeInstance.getState();
    const expectedStatus = authoritativeMetadataRecoveryStatus();
    // First authority read before any destructive confirmation: a forged renderer action cannot manufacture eligibility.
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
    // Re-read after the modal: a restore marker, env override, platform change, writer, or another recovery wins.
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
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_APPLY_NOW, async () => {
    const before = runtimeInstance.getState();
    // Quit in flight: never start a transaction the quit path will immediately abort.
    if (quittingLeaf()) return before;
    const gate = evaluateApplyNowGate(readApplyNowGateInput());
    // Without a durable pending transaction, startup would only stop/respawn
    // pointlessly; snapshot-failed must go through retry-apply, bad trees rejected.
    if (!gate.ok) return before;
    if (!await confirmRuntimeMutation(
      `立即切换到 dsh ${gate.target}？`,
      'dsh 将立即重启并切换到该版本（约 30–90 秒）。进行中的会话会中断，你的数据不受影响；若切换失败，dsh 会自动回滚并保留现场。',
      '立即应用并重启',
    )) return runtimeInstance.getState();
    // TOCTOU: re-read the full gate (same input builder) after the modal, exactly like retry-apply.
    const current = runtimeInstance.getState();
    const secondGate = evaluateApplyNowGate(readApplyNowGateInput());
    // The dialog named gate.target: never start a transaction for a version the user did not confirm.
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
    // Only a stash-shaped basename is accepted; main re-validates it against its private listing before mutating.
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
      // Recorded, not hard-blocked: the startup transaction below restarts the
      // instance (a thrown transaction leaves a resumeable marker). A real
      // restore failure throws with its cause preserved verbatim by describeError.
      restoreResult.error = sanitizeErrorText(describeError(error));
      return null;
    }).finally(() => {
      runtimeOperationSlot.end();
    });
    runtimeOperationSlot.begin(operation);
    await operation;
    // Only a fence-refused no-op (nothing recorded) may resolve silently; a
    // thrown restore records its cause and MUST reach the error branch below.
    if (restoreResult.outcome === 'blocked' && restoreResult.error === null) return runtimeInstance.getState();
    // 'half' leaves the durable marker for retry-restore to resume.
    if (restoreResult.outcome === 'half') {
      await publishBlockedStartup('恢复回滚前数据未完成（现场已保留），请重试恢复', {
        restoreOutcome: 'half',
        canRetryRestore: true,
      });
      return runtimeInstance.getState();
    }
    if (restoreResult.outcome === 'incomplete') {
      // Stash missing/untrustworthy, DSH_HOME untouched: restart (never a hard
      // block) then THROW so the renderer surfaces it in the persistent error slot.
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
