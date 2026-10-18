/** shell-ipc-update — domain IPC registrations. */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { attemptCommittedRegistryPush } from './transport-manager.ts'
import { describeError } from './describe-error.ts'
import { openReleasePage, type UpdateState } from './updater.ts'
import { INVALID_CONFIRMATION_ERROR, parseConfirmationRevision } from './update-confirmation.ts'

/** Loud, honest refusal of a malformed confirmation (never {ok:true}). */
function refuseInvalidConfirmation(): { ok: false; error: string } {
  try { console.warn(`[dsh-chamber] ${INVALID_CONFIRMATION_ERROR}`) } catch { /* callback boundary */ }
  return { ok: false, error: INVALID_CONFIRMATION_ERROR }
}

export function registerUpdateHandlers(ctx: ShellIpcCtx): void {
  const { deps, MACOS_NOTIFICATION_SETTINGS_URL } = ctx
  const { updateController: updater, disarmUpdaterQuit, hostFacts } = ctx.deps.ctx
  // Update controller: the state projection is non-secret only (versions / channel /
  // release URL / short error text) and every failure is silent (main-process log), never
  // blocking startup. The controller instance is constructed on the assembly side
  // (electron-updater lifecycle, autoDownload=false, quitAndInstall quit leg) and injected
  // via ctx.updateController; this registers the state-push subscription and the 4 UPDATE
  // handlers + OPEN_RELEASE.
  // State push (UPDATE_STATE_CHANGED send source): no live main window → silently skip;
  // push failure is loud (the renderer re-pull is the fallback). Extracted so a refused
  // confirmation can re-push the current state (renderer missed the intervening push →
  // resync in place instead of staying on the snapshot the refusal just invalidated).
  const pushState = (updateState: UpdateState): void => {
    if (!deps.edges.mainWindowAlive()) return;
    const pushed = attemptCommittedRegistryPush(() => {
      if (!deps.edges.rendererPush(IPC_CHANNELS.UPDATE_STATE_CHANGED, updateState)) {
        throw new Error('updater renderer push failed');
      }
    });
    if (!pushed.sent) {
      try { console.warn(`[dsh-chamber] updater 状态 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* callback boundary */ }
    }
  };
  updater.subscribe((updateState) => {
    // Before quitAndInstall the assembly arms the updater quit leg (close does not hide).
    // While armed the only pushes are a one-shot restart failure (restartFailureText; phase stays
    // downloaded) or a phase leaving downloaded — both prove the quit leg did not happen → ctx.disarmUpdaterQuit
    // withdraws it (the assembly leaf pulls the window back so settings shows the failure and
    // lets retry). The core holds no armed flag; the Swift flavor never arms. The real fallback
    // is the settings page UPDATE_STATE pull on mount.
    if (updateState.restartFailureText !== undefined || updateState.phase !== 'downloaded') {
      disarmUpdaterQuit?.(updateState.restartFailureText !== undefined ? 'restart failed' : `phase=${updateState.phase}`);
    }
    pushState(updateState);
  });
  deps.ipc.handle(IPC_CHANNELS.UPDATE_STATE, () => updater.state());
  // Discovery has one source: the page check button enters through this handler; the
  // controller routes it to the native leg when present, else to this flavor own feed.
  deps.ipc.handle(IPC_CHANNELS.UPDATE_CHECK, () => updater.checkNow());
  // Confirmation actions echo the revision the renderer answered from (design 11 §4): a
  // stale revision (or a malformed payload) is refused loudly instead of acting on a
  // snapshot that no longer exists. The refusal also re-pushes the current state so a
  // renderer that missed the intervening push resyncs without a reload.
  deps.ipc.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async (payload: unknown) => {
    const revision = parseConfirmationRevision(payload);
    // A malformed payload is a protocol error (fail-closed) AND a resync trigger.
    if (revision === null) {
      pushState(updater.state());
      return refuseInvalidConfirmation();
    }
    const result = await updater.download(revision);
    if (!result.ok) pushState(updater.state());
    return result;
  });
  // The settings「重启并安装」button: a completed download restarts into the install
  // (quitAndInstall); controller-side gates mirror the rendered state (phase downloaded +
  // no install block). The native Sparkle async variant is preferred when provided, else
  // Electron synchronous implementation.
  deps.ipc.handle(IPC_CHANNELS.UPDATE_RESTART, async (payload: unknown) => {
    const revision = parseConfirmationRevision(payload);
    if (revision === null) {
      pushState(updater.state());
      return refuseInvalidConfirmation();
    }
    const result = await (updater.restartAndInstallAsync?.(revision) ?? updater.restartAndInstall(revision));
    if (!result.ok) pushState(updater.state());
    return result;
  });
  // The「前往下载页」link: popups are denied and navigation is pinned to the control-plane
  // origin, so opening a release page goes through the main process with a strict allowlist
  // (parsed, not prefix-matched: only this repo GitHub pages, never a subdomain/userinfo trick).
  deps.ipc.handle(IPC_CHANNELS.OPEN_RELEASE, (payload: unknown) => {
    const { url } = payload as { url: unknown };
    return openReleasePage(url, value => deps.edges.openExternal(value));
  });

  // 通知权限被拒时的恢复入口：打开「系统设置 → 通知」。URL 是本侧常量（renderer 不传）；
  // 非 darwin 无该面板 → 诚实 false，打开失败 loud 且回 false，绝不假成功。
  deps.ipc.handle(IPC_CHANNELS.OPEN_NOTIFICATION_SETTINGS, async () => {
    if (hostFacts.platform !== 'darwin') return false;
    try {
      await deps.edges.openExternal(MACOS_NOTIFICATION_SETTINGS_URL);
      return true;
    } catch (error) {
      console.error(
        `[dsh-chamber] 打开通知设置失败：${describeError(error)}`,
      );
      return false;
    }
  });
}
