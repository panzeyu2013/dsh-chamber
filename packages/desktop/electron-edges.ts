/**
 * Electron HostEdges flavor (design 25 §4.1; W-10 S0 assembly / S2 batch).
 *
 * The Electron main process hands its host back-references to
 * createElectronEdges and receives the HostEdges seam object (interface in
 * shell-core.ts) that core business code calls for every Electron side
 * effect. A later Swift-native flavor (node-edges.ts) implements the same
 * seam over the B bridge. This is a face-B file by design: it imports
 * electron (runtime imports since S2 — Notification / powerMonitor / app)
 * and therefore sits on the electron-free-gate whitelist.
 *
 * Implemented member sets per batch (the returned object's Pick type = the
 * exact implemented set, so core/main.ts cannot touch a not-yet-implemented
 * member at compile time):
 *   - S0: rendererPush — the single-main-window send leaf. The four
 *     committed state pushes (SSH_STATUS_CHANGED / SSH_INSTANCES_CHANGED /
 *     UPDATE_STATE_CHANGED / RUNTIME_STATE_CHANGED) leave main.ts through it.
 *   - S2 (notify/badge/ready + renderer delivery batch): the NOTIFY host leg
 *     (showNativeNotification with the private B4 notification-object
 *     registry/eviction, notificationSupported, retireNotificationsForSources
 *     for the registry-retire path), the BADGE_COUNT host leg (setBadge apply
 *     leaf + badgeCountApiAvailable fact — the platform gate stays in core
 *     badge.ts, E5), the renderer-delivery window facts (mainWindowAlive /
 *     webViewLoading / webViewContentAlive / isFocused) and the resume/show
 *     event subscriptions (onSystemResume / onMainWindowShown) whose core
 *     callbacks register in installIpcHandlers. The window 'show' glue and
 *     the click activation leg live behind the host back-refs added below.
 *   - S6 (ssh plugin batch): the dialog legs — showMessage (dialog
 *     .showMessageBox wrapper, main.ts confirmPluginAction's box shape) and
 *     pickPluginSource (the module-level main.ts picker moved VERBATIM —
 *     folder|.tgz dual mode with the darwin one-dialog semantics; the
 *     host mainWindow back-ref is the parent, so Electron attaches the box/
 *     panel to the current window as a sheet on macOS). classifyPluginPick
 *     stays in core (plugin-tarball.ts).
 *
 * TODO (W-10 later batches): the remaining HostEdges v2 members are declared
 * on the shell-core interface but not yet implemented here — each batch moves
 * the corresponding main.ts leaf body VERBATIM into the returned object and
 * widens its Pick:
 *   - keep-awake: powerSaveBlocker start/stop + blocker-id host state
 *     (main.ts setKeepAwakeActive ~:871).
 *   - dialogs: showError (dialog.showErrorBox wrapper) — the ssh-plugin
 *     handlers that migrated in S6 did not need it (their failures are loud
 *     {error} projections, never error boxes); it moves with its first core
 *     consumer.
 *   - tray/window: trayAvailable, focusMainWindow (D3 — the per-member
 *     activate/restore/focus leg; notification clicks already activate via
 *     host.showMainWindow), notifyClicked (design 25 §4.5 E4 Swift face).
 *   - open/open-in: shell.openExternal / openPath / showItemInFolder +
 *     launchApp (B11 — budget/cooldown/normalization stay in core).
 *   - system/resources: setLoginItem / trayAvailable / resolveResource /
 *     isPackaged (B1).
 */
import { Notification, app, dialog, powerMonitor } from 'electron';
import type { BrowserWindow } from 'electron';
import type { HostEdges, HostMessageOptions } from './shell-core.ts';
import { describeUnknownError } from './deep-link.ts';
import {
  BoundedActiveNotifications,
  MAX_ACTIVE_NATIVE_NOTIFICATIONS,
  showNativeNotificationHonestly,
} from './notifications.ts';

/** Back-references the Electron main process hands to the edge object. The
 *  S0 leaf needed only the single main-window identity; the S2 batch adds the
 *  click activation leg and the window-'show' subscription face (both are
 *  main-window state owned by the assembly side). */
export interface ElectronEdgesHost {
  /** 当前主窗口（可能为 null：托盘/无窗常驻态）。 */
  mainWindow: () => BrowserWindow | null;
  /** W-10 S2：通知 click 激活腿 = main.ts showMainWindow 语义——restore/show/
   *  focus，无窗则按控制面 origin 重建；成功返回 true。 */
  showMainWindow(): boolean;
  /** W-10 S2：主窗口 'show' 事件订阅面（createMainWindow glue 对每窗挂接、
   *  mainWindow===win 身份守卫在装配侧），返回退订函数。 */
  onMainWindowShown(cb: () => void): () => void;
}

/** S2 装配批的 Electron 边沿对象（实现成员集合 = S0+S2 实际引用最小集；类型由
 *  shell-core.ts 的 HostEdges 契约经 Pick 收窄，core/main.ts 因此无法触碰尚未
 *  实现的成员）。 */
export function createElectronEdges(host: ElectronEdgesHost): Pick<
  HostEdges,
  | 'rendererPush'
  | 'showNativeNotification'
  | 'notificationSupported'
  | 'setBadge'
  | 'badgeCountApiAvailable'
  | 'isFocused'
  | 'onSystemResume'
  | 'onMainWindowShown'
  | 'webViewLoading'
  | 'webViewContentAlive'
  | 'mainWindowAlive'
  | 'retireNotificationsForSources'
  | 'showMessage'
  | 'pickPluginSource'
> {
  // —— B4 私有宿主态（对象登记/淘汰/evict 全留本文件）——
  // 活跃原生通知登记：持有存活引用防 GC 吞 click（macOS 已知坑，OpenChamber
  // 同款）；'close' 注销；满员按插入序淘汰最旧（退由调用方 close，见
  // showNativeNotification）；来源退役由 retireNotificationsForSources 驱逐。
  const activeNotifications = new BoundedActiveNotifications<Notification>();
  // OS 唤醒订阅槽（core 在 installIpcHandlers 注册回调；单装配 = 单槽）。
  let systemResumeCallback: ((timestamp: number) => void) | null = null;
  powerMonitor.on('resume', () => {
    const callback = systemResumeCallback;
    if (callback === null) return;
    try {
      callback(Date.now());
    } catch (error) {
      try {
        console.warn(`[dsh-chamber] system-resume 订阅回调失败：${describeUnknownError(error)}`);
      } catch {
        /* event boundary must never throw */
      }
    }
  });

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

    /** NOTIFY 宿主腿（W-10 S2）：构造 + 有界登记/淘汰 + click/close 监听 +
     *  honest-show 结算全在本实现内（B4）。click 腿顺序 = 先
     *  activate/restore/focus 主窗口（无窗则重建，host.showMainWindow），成功
     *  才回调 core 的 clickRoute.onActivated（owns+入队在 core）——与搬迁前
     *  「先代际 owns 校验后 focus」的差异（focus 后才发现来源退役时只跳过入队）
     *  为 S2 接缝形状的有意修订。返回句柄：shown = 结算结果（NOTIFY IPC 返回
     *  值与 claim 释放依赖）；dispose = click 回执注销（注销后该通知的后续
     *  click 只恢复窗口）。本实现不 throw：构造/登记/监听失败一律结算为
     *  shown:false 且登记清理内部完成。 */
    showNativeNotification(spec, clickRoute) {
      // 平台分支（macOS 系统提示音 Glass，OpenChamber 同款）属实现侧；
      // 其余平台交给系统默认。spec.silent 缺省 false 与搬迁前一致。
      const created = new Notification({
        title: spec.title,
        body: spec.body,
        silent: spec.silent ?? false,
        ...(process.platform === 'darwin' ? { sound: spec.sound ?? 'Glass' } : {}),
      });
      let route = clickRoute;
      // 有界登记持有存活引用防 GC 吞 click。满员不拒发：macOS 横幅进入通知
      // 中心后不触发 close，拒发会让未清除的存量横幅永久卡死通知流（2026-09
      // 实测 16 条后测试/事件通知全部失败且 OS 无记录）——登记按插入序淘汰最旧
      // 一条，由调用方 close 退役后新通知照常显示。
      const evicted = activeNotifications.add(created, route?.token ?? null);
      if (evicted !== null) {
        console.warn(`[dsh-chamber] 活跃原生通知已达上限 ${MAX_ACTIVE_NATIVE_NOTIFICATIONS} 条，淘汰最旧一条以继续显示`);
        try { evicted.close(); } catch { /* best-effort host cleanup */ }
      }
      created.on('click', () => {
        try {
          // click 腿（W-10 S2）：宿主内先激活/恢复/聚焦主窗口（无窗则重建），
          // 成功才回调 core 的 onActivated 打开意图入队闭包。
          if (!host.showMainWindow()) return;
          route?.onActivated();
        } catch (error) {
          try {
            console.warn(`[dsh-chamber] 原生通知点击处理失败：${describeUnknownError(error)}`);
          } catch { /* event boundary must never throw */ }
        }
      });
      created.on('close', () => {
        activeNotifications.delete(created);
      });
      const shown = showNativeNotificationHonestly(created);
      void shown.then((outcome) => {
        // failed/早 close 结算后不再持有（超时路径由 honest-show 内部 close，
        // 其 'close' 监听同样注销；此处幂等兜底 failed 事件后未 close 的死条目）。
        if (!outcome.shown) activeNotifications.delete(created);
      });
      return {
        dispose: () => { route = null; },
        shown,
      };
    },

    /** Notification.isSupported 平台探测（异常安全；探测失败与不支持同值，
     *  core 侧统一按「平台不支持」loud——与搬迁前区分探测失败消息的有意收敛）。 */
    notificationSupported(): boolean {
      try {
        return Notification.isSupported() === true;
      } catch {
        return false;
      }
    },

    /** BADGE_COUNT 宿主腿（W-10 S2，E5）：apply 叶——异常安全，绝不 throw；
     *  平台门与裁决留 core（badge.ts badgePlatformGate）。 */
    setBadge(count: number) {
      try {
        app.setBadgeCount(count);
        return { applied: true } as const;
      } catch (error) {
        return { applied: false as const, reason: describeUnknownError(error) };
      }
    },

    /** app.setBadgeCount API 可用性事实（Electron 构建差异；win32 的「未接线」
     *  原因由 core 平台门区分）。 */
    badgeCountApiAvailable(): boolean {
      return typeof app.setBadgeCount === 'function';
    },

    /** 单窗口焦点复查（通知裁决的权威事实，design 19 §3.3）：窗口必须存在、
     *  可见且聚焦——隐藏到托盘/后台的窗口不算聚焦。异常安全（不可聚焦即
     *  false；与搬迁前 readNotificationHostBoolean 失败即拒发的差异见
     *  showNativeNotification 注释的有意收敛）。 */
    isFocused(): boolean {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) return false;
      try {
        return win.isVisible() && win.isFocused();
      } catch {
        return false;
      }
    },

    /** OS 唤醒事件订阅（design 14 D4）：powerMonitor 'resume' → core 回调
     *  （handleSystemResume——held lastResume 补发语义在 core）。传输层重探
     *  （reconnectStaleTransports）由 main 装配侧另挂监听，本订阅只管回灌。 */
    onSystemResume(cb: (timestamp: number) => void): void {
      systemResumeCallback = cb;
    },

    /** 主窗口 'show' 事件订阅（B9：held-resume/通知补发点）——装配侧
     *  createMainWindow glue 每窗挂接（mainWindow===win 身份守卫在 glue）。 */
    onMainWindowShown(cb: () => void): void {
      host.onMainWindowShown(cb);
    },

    /** 渲染器可用性门（B3）：webContents 是否仍在加载。无主窗/已销毁视同
     *  「加载中」（投递门恒不通过，与搬迁前 destroyed ? true : isLoading()
     *  同向）。 */
    webViewLoading(): boolean {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) return true;
      try {
        return win.webContents.isLoading();
      } catch {
        return true;
      }
    },

    /** 渲染器可用性门（B3）：webContents 是否存活（非 crashed/destroyed）。 */
    webViewContentAlive(): boolean {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) return false;
      try {
        return !win.webContents.isCrashed() && !win.isDestroyed();
      } catch {
        return false;
      }
    },

    /** 主窗口存在性门（W-10 S2）：win!=null 且未销毁（隐藏到托盘仍为 true）。 */
    mainWindowAlive(): boolean {
      const win = host.mainWindow();
      if (win === null) return false;
      try {
        return !win.isDestroyed();
      } catch {
        return false;
      }
    },

    /** 来源退役驱逐（W-10 S2，B4 registry 私有）：注册表退役路径把 sourceId
     *  已退役的活跃原生通知关闭并注销（click 回执随对象消亡），返回驱逐数。 */
    retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number {
      let retired = 0;
      for (const [notification, token] of activeNotifications.entries()) {
        if (token === null || !retiredSourceIds.has(token.sourceId)) continue;
        activeNotifications.delete(notification);
        retired += 1;
        try { notification.close(); } catch { /* best-effort stale banner retirement */ }
      }
      return retired;
    },

    /** 确认对话框叶（W-10 S6）：dialog.showMessageBox 包装——父窗 = 当前主窗
     *  （host.mainWindow()，macOS 挂为窗 sheet），返回按钮序号 response（复刻
     *  main.ts confirmPluginAction 的按钮序/编号约定由调用侧负责）。无存活主窗
     *  抛错（'native confirmation unavailable'）——调用侧预检
     *  edges.mainWindowAlive() 兜底（与搬迁前 confirmPluginAction 的
     *  win==null||destroyed 预检同语义；窗口在预检与调用间销毁的竞态与搬迁前
     *  showMessageBox(win) 抛出同形，由调用侧 catch 折算 loud error）。 */
    async showMessage(opts: HostMessageOptions): Promise<number> {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) throw new Error('native confirmation unavailable');
      const { response } = await dialog.showMessageBox(win, opts);
      return response;
    },

    /** 插件源一体化 picker 叶（W-10 S6）：main.ts pickPluginSource 函数体逐字
     *  迁入（folder|.tgz 双模式：darwin NSOpenPanel 一体 openFile+openDirectory、
     *  扩展过滤只约束文件选择；非 mac 仅目录）；父窗 = 当前主窗。调用侧预检
     *  mainWindowAlive；预检与调用间窗口销毁的竞态抛出（与搬迁前同形），绝不
     *  折算为取消。分类（classifyPluginPick）留 core（plugin-tarball.ts）。 */
    async pickPluginSource(): Promise<{ status: 'cancelled' } | { status: 'picked'; path: string }> {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) throw new Error('no main window');
      const combined = process.platform === 'darwin';
      const picked = await dialog.showOpenDialog(win, {
        properties: combined ? ['openFile', 'openDirectory'] : ['openDirectory'],
        // The extension filter only governs FILE selection (folders stay
        // selectable) — on macOS it is what makes a non-.tgz file clearly
        // unpickable in the same dialog.
        filters: combined ? [{ name: 'dsh plugin archives', extensions: ['tgz'] }] : undefined,
        buttonLabel: 'Import',
        title: 'Import a dsh plugin — source folder or .tgz archive',
      });
      if (picked.canceled || picked.filePaths.length === 0) return { status: 'cancelled' };
      return { status: 'picked', path: picked.filePaths[0] };
    },
  };
}
