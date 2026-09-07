/**
 * Electron HostEdges flavor (design 25 §4.1; W-10 S0 assembly batch).
 *
 * The Electron main process hands its host back-references to
 * createElectronEdges and receives the HostEdges seam object (interface in
 * shell-core.ts) that core business code calls for every Electron side
 * effect. A later Swift-native flavor (node-edges.ts) implements the same
 * seam over the B bridge. This is a face-B file by design: it imports
 * electron and therefore sits on the electron-free-gate whitelist.
 *
 * W-10 S0 implements ONLY the members main.ts actually references in this
 * batch (the 「leaf replacement」 minimum set):
 *   - rendererPush — the single-main-window send leaf. The four committed
 *     state pushes (SSH_STATUS_CHANGED / SSH_INSTANCES_CHANGED /
 *     UPDATE_STATE_CHANGED / RUNTIME_STATE_CHANGED) now leave main.ts through
 *     it; the drain sends (deep-link intent / notification-open) stay on
 *     webContents.send in main.ts until their own batch.
 *
 * TODO (W-10 later batches): the remaining HostEdges v2 members are declared
 * on the shell-core interface but not yet implemented here — each batch moves
 * the corresponding main.ts leaf body VERBATIM into the returned object and
 * widens its Pick:
 *   - notifications: new Notification construction + Notification.isSupported
 *     probe + click → activate/restore/focus + evicted.close() retirement
 *     (main.ts maybeShowNativeNotification ~:772; B4 — the host-object
 *     registry/eviction stays here, core keeps the bounded ACK queue).
 *   - badge: platform gate + app.setBadgeCount (main.ts applyNativeBadgeCount
 *     ~:433 / reconcileBadgeCount ~:455 / quit-time clear ~:428).
 *   - keep-awake: powerSaveBlocker start/stop + blocker-id host state
 *     (main.ts setKeepAwakeActive ~:891).
 *   - dialogs: dialog.showErrorBox / showMessageBox / showOpenDialog wrappers
 *     (main.ts pickPluginSource ~:310 + the showError/showMessage call sites).
 *   - tray/window: tray availability, isFocused / focusMainWindow /
 *     onMainWindowShown, webViewLoading / webViewContentAlive (B3/B9/D3).
 *   - open/open-in: shell.openExternal / openPath / showItemInFolder +
 *     launchApp (B11 — budget/cooldown/normalization stay in core).
 *   - system/resources: setLoginItem / onSystemResume / resolveResource /
 *     isPackaged (B1).
 */
import type { BrowserWindow } from 'electron';
import type { HostEdges } from './shell-core.ts';

/** Back-references the Electron main process hands to the edge object. The
 *  rendererPush leaf needs only the single main-window identity; later W-10
 *  batches extend this face (controlPlaneOrigin, …) as their leaves arrive. */
export interface ElectronEdgesHost {
  /** 当前主窗口（可能为 null：托盘/无窗常驻态）。 */
  mainWindow: () => BrowserWindow | null;
}

/** W-10 S0 装配批的 Electron 边沿对象（实现成员集合 = 本批 main.ts 实际引用
 *  的最小集；类型由 shell-core.ts 的 HostEdges 契约经 Pick 收窄，main.ts 因此
 *  在编译期无法触碰尚未实现的成员）。 */
export function createElectronEdges(host: ElectronEdgesHost): Pick<HostEdges, 'rendererPush'> {
  return {
    /** 单窗身份 send 叶：主窗存在且未销毁则 webContents.send 并返回 true，
     *  否则返回 false（叶本身不 throw）。committed-push 包装
     *  （attemptCommittedRegistryPush）在调用侧把 false 折算为 push 失败，
     *  与搬迁前 throw 语义等价（transport-manager.ts）。 */
    rendererPush(channel: string, payload: unknown): boolean {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) return false;
      win.webContents.send(channel, payload);
      return true;
    },
  };
}
