/**
 * shell-ipc-update — domain IPC registrations split out of shell-core.ts
 */
import type { ShellIpcCtx } from './shell-core.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { attemptCommittedRegistryPush } from './transport-manager.ts'
import { describeError } from './describe-error.ts'
import { openReleasePage } from './updater.ts'

export function registerUpdateHandlers(ctx: ShellIpcCtx): void {
  const { deps, MACOS_NOTIFICATION_SETTINGS_URL } = ctx
  const { updateController: updater, disarmUpdaterQuit, hostFacts } = ctx.deps.ctx
  // Update controller (design 11): the state projection is non-secret only
  // (versions / channel / release URL / short error text) and every failure is
  // silent (main-process log), never blocking startup — the settings section
  // renders the honest state. W-10 S9：控制器现实例仍在 main 装配侧构造
  // （createUpdateController——electron-updater 生命周期、autoDownload=false /
  // autoInstallOnAppQuit 语义、quitAndInstall 的 quit 腿均归装配侧实例），经
  // ctx.updateController 注入；本段注册状态 push 订阅与 4 个 UPDATE 注册体 +
  // OPEN_RELEASE（按原 main.ts 顺序）。
  updater.subscribe((updateState) => {
    // 2026-12 合并（main 的更新退出腿回收）：装配侧在 quitAndInstall 前武装
    // 「更新退出腿」（关窗不 hide），武装期间唯一可能出现的 push 就是重启失败
    // （一次性 restartFailureText；phase 保持 downloaded，见 updater.ts 的
    // 'error' 分支）或相位离开 downloaded——两者都证明退出腿没有发生，经
    // ctx.disarmUpdaterQuit 撤回武装（恢复正常关窗语义；窗口已被更新退出腿关掉
    // 时装配叶负责把主窗口拉回，让设置页如实呈现失败文案与就地重试）。
    // 核心不持有武装位：装配叶自身幂等（未武装 no-op）；Swift flavor v1
    // blocked-available 从不武装且不提供该叶（可选字段）⇒ 只做下方状态 push。
    // 该帧的落点不是「唯一诚实呈现面」：装配叶可能刚重建主窗口，新 renderer 尚
    // 未挂监听——真正的兜底是 settings 面挂载时的 UPDATE_STATE pull（下方注册体）。
    if (updateState.restartFailureText !== undefined || updateState.phase !== 'downloaded') {
      disarmUpdaterQuit?.(updateState.restartFailureText !== undefined ? 'restart failed' : `phase=${updateState.phase}`);
    }
    // 状态 push（UPDATE_STATE_CHANGED send 源；主窗身份折算见组注释——S2 同款
    // committed-push 包装 + rendererPush 叶）：无存活主窗（原 updateWindow ===
    // null）静默跳过；push 失败 loud（等待 renderer 重拉兜底）。
    if (!deps.edges.mainWindowAlive()) return;
    const pushed = attemptCommittedRegistryPush(() => {
      if (!deps.edges.rendererPush(IPC_CHANNELS.UPDATE_STATE_CHANGED, updateState)) {
        throw new Error('updater renderer push failed');
      }
    });
    if (!pushed.sent) {
      try { console.warn(`[dsh-chamber] updater 状态 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* callback boundary */ }
    }
  });
  deps.ipc.handle(IPC_CHANNELS.UPDATE_STATE, () => updater.state());
  // S-21 发现单源：页面「检查更新」只经本注册体进控制器；控制器在原生腿在场时把
  // 它转成冻结边 updateNativeAction kind=check（壳内 Sparkle appcast），否则才走
  // 该 flavor 自己的 feed。页面从不自跑发现，注册体也不分支 flavor。
  deps.ipc.handle(IPC_CHANNELS.UPDATE_CHECK, () => updater.checkNow());
  deps.ipc.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, () => updater.download());
  // The settings update section's「重启并安装」button (2026-12 user
  // decision): a completed download restarts the app into the install
  // (quitAndInstall) — the user controls when the update applies instead of
  // relying on the quit-install leg alone. Controller-side gates mirror the
  // rendered state (phase downloaded + no install block) — not just UI
  // hiding; quitAndInstall then quits through before-quit (the
  // update-downloaded exemption) and will-quit (cleanup first).
  // 重启并安装：原生更新器（Swift/Sparkle）提供异步变体时优先走它（结果跨进程），
  // 否则用 Electron 的同步实现（S-01 / 裁决 D-1 选 B）。
  deps.ipc.handle(IPC_CHANNELS.UPDATE_RESTART,
    () => updater.restartAndInstallAsync?.() ?? updater.restartAndInstall());
  // The settings update section's「前往下载页」link: popups are denied and
  // navigation is pinned to the control-plane origin, so opening a release
  // page must go through the main process. Strict allowlist — parsed, not
  // prefix-string matched: only this repo's GitHub pages can ever be opened
  // (never an arbitrary URL, subdomain, userinfo or path-root trick).
  // W-10 S9：宿主打开叶 = deps.edges.openExternal（原直包 shell.openExternal）。
  deps.ipc.handle(IPC_CHANNELS.OPEN_RELEASE, (payload: unknown) => {
    const { url } = payload as { url: unknown };
    return openReleasePage(url, value => deps.edges.openExternal(value));
  });

  // 通知权限被拒时的恢复入口（design 19 §3.3/§4）：打开「系统设置 → 通知」。
  // 目标 URL 是本侧常量（renderer 不传 URL）；非 darwin 无该面板 → 诚实 false
  // （设置页只在 darwin 显示该入口），打开失败 loud 且回 false，绝不假成功。
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
