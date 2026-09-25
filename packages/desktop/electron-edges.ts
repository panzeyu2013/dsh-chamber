/**
 * Electron HostEdges flavor (design 25 §4.1) — a face-B file: it imports
 * electron (Notification / powerMonitor / app) and sits on the
 * electron-free-gate whitelist. `createElectronEdges(host)` takes the main
 * process's host back-references and returns the HostEdges seam core business
 * code calls for every Electron side effect; the returned Pick type is the
 * exact implemented set, so core/main.ts cannot touch an unimplemented member
 * at compile time (node-edges.ts is the Swift flavor of the same seam).
 * Retained HostEdges members with no core consumer (setKeepAwake / tray /
 * focus / launchApp / login item / isPackaged) are declared on the contract
 * but NOT implemented here — their Electron actions live in main.ts.
 */
import { Notification, app, dialog, powerMonitor, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { rendererPushDelivered, type HostEdges, type HostMessageOptions } from './shell-core.ts';
import { describeUnknownError } from './deep-link.ts';
import {
  BoundedActiveNotifications,
  MAX_ACTIVE_NATIVE_NOTIFICATIONS,
  describeNativeNotificationFailure,
  showNativeNotificationHonestly,
} from './notifications.ts';

/** Host back-references: the single main-window identity, click activation and
 *  the 'show' subscription (both main-window state owned by the assembly side). */
export interface ElectronEdgesHost {
  /** 当前主窗口（可能为 null：托盘/无窗常驻态）。 */
  mainWindow: () => BrowserWindow | null;
  /** 通知 click 激活腿 = main.ts showMainWindow：restore/show/focus，无窗按控制面 origin 重建；成功返回 true。 */
  showMainWindow(): boolean;
  /** 主窗口 'show' 事件订阅面，返回退订函数（mainWindow===win 身份守卫在装配侧）。 */
  onMainWindowShown(cb: () => void): () => void;
}

/** Electron 边沿对象：实现成员集合 = 实际引用最小集（Pick 收窄，core/main.ts
 *  无法触碰未实现成员）。 */
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
  | 'openExternal'
  | 'openPath'
  | 'showItemInFolder'
  | 'showError'
  | 'showMessage'
> {
  // 活跃原生通知登记：持有存活引用防 GC 吞 click（macOS 已知坑）；'close' 注销；
  // 满员按插入序淘汰最旧（由调用方 close 退役），来源退役由
  // retireNotificationsForSources 驱逐。
  const activeNotifications = new BoundedActiveNotifications<Notification>();
  // OS 唤醒订阅槽（单装配 = 单槽；core 在 installIpcHandlers 注册）。
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

  /** webContents 是否存活（非 crashed/destroyed）：rendererPush 与 webViewContentAlive 共用同一判据。 */
  const webContentsAlive = (win: BrowserWindow): boolean => {
    try {
      return !win.webContents.isCrashed() && !win.isDestroyed();
    } catch {
      return false;
    }
  };

  return {
    /** 单窗身份 send 叶：主窗存在且未销毁才 send 并返回 true，否则 false
     *  （叶本身不 throw；调用侧把 false 折算为 push 失败）。交付门 = 共享
     *  rendererPushDelivered（mainWindowAlive && webViewContentAlive，后者含
     *  isCrashed）——crashed 渲染器上的 send 绝不冒充已投递。 */
    rendererPush(channel: string, payload: unknown): boolean {
      const win = host.mainWindow();
      if (win === null) return false;
      let windowAlive = true;
      try {
        windowAlive = !win.isDestroyed();
      } catch {
        windowAlive = false;
      }
      if (!rendererPushDelivered(windowAlive, webContentsAlive(win))) return false;
      win.webContents.send(channel, payload);
      return true;
    },

    /** NOTIFY 宿主腿：构造 + 有界登记/淘汰 + click/close 监听 + honest-show
     *  结算全在本实现内。click 腿顺序 = 先 activate/restore/focus 主窗口
     *  （无窗则重建），成功才回调 core 的 clickRoute.onActivated（owns+入队在
     *  core）——focus 先于代际 owns 校验：来源已退役时窗口仍激活，只跳过入队。
     *  返回 {shown, dispose}；本实现不 throw：失败一律结算为 shown:false。 */
    showNativeNotification(spec, clickRoute) {
      // macOS 系统提示音 Glass 属实现侧（OpenChamber 同款），其余平台交给系统默认；spec.silent 缺省 false。
      const created = new Notification({
        title: spec.title,
        body: spec.body,
        silent: spec.silent ?? false,
        ...(process.platform === 'darwin' ? { sound: spec.sound ?? 'Glass' } : {}),
      });
      let route = clickRoute;
      // 有界登记持有存活引用防 GC 吞 click。满员不拒发：macOS 横幅进入通知中心
      // 后不触发 close，拒发会让存量横幅永久卡死通知流——淘汰最旧一条，由调用
      // 方 close 退役后新通知照常显示。
      const evicted = activeNotifications.add(created, route?.token ?? null);
      if (evicted !== null) {
        console.warn(`[dsh-chamber] 活跃原生通知已达上限 ${MAX_ACTIVE_NATIVE_NOTIFICATIONS} 条，淘汰最旧一条以继续显示`);
        try { evicted.close(); } catch { /* best-effort host cleanup */ }
      }
      created.on('click', () => {
        try {
          // 先激活/恢复/聚焦主窗口（无窗则重建），成功才回调 core 的 onActivated 入队闭包。
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
      // Electron 主进程没有 macOS 通知授权查询/申请 API；唯一可得的诚实面在
      // 这里接线：OS 拒绝投递（failed）或限时无回执（timeout）时显式说明
      // 「可能未授权 / 可能被系统抑制」并保留 OS 原文——Swift 腿的 denied→fail、
      // notDetermined→申请一次是同一「拒绝/未确认必诚实回错」的语义。
      const honestShow = showNativeNotificationHonestly(created);
      const shown = honestShow.then((outcome) => {
        if (outcome.shown) return outcome;
        return {
          shown: false as const,
          error: describeNativeNotificationFailure(process.platform, outcome.reason, outcome.error),
        };
      });
      void shown.then((outcome) => {
        // failed/早 close 结算后不再持有（超时路径由 honest-show 内部 close，
        // 'close' 监听同样注销；此处幂等兜底 failed 后未 close 的死条目）。
        if (!outcome.shown) activeNotifications.delete(created);
      });
      return {
        dispose: () => { route = null; },
        shown,
      };
    },

    /** Notification.isSupported 平台探测（异常安全；探测失败与不支持同值）。 */
    notificationSupported(): boolean {
      try {
        return Notification.isSupported() === true;
      } catch {
        return false;
      }
    },

    /** BADGE_COUNT 宿主腿 apply 叶：异常安全绝不 throw；平台门与裁决留 core（badge.ts）。 */
    setBadge(count: number) {
      try {
        app.setBadgeCount(count);
        return { applied: true } as const;
      } catch (error) {
        return { applied: false as const, reason: describeUnknownError(error) };
      }
    },

    /** app.setBadgeCount API 可用性事实（Electron 构建差异，win32 未接线由 core 平台门区分）。 */
    badgeCountApiAvailable(): boolean {
      return typeof app.setBadgeCount === 'function';
    },

    /** 单窗口焦点复查（通知裁决的权威事实）：窗口必须存在、可见且聚焦——
     *  隐藏到托盘/后台不算；异常安全。 */
    isFocused(): boolean {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) return false;
      try {
        return win.isVisible() && win.isFocused();
      } catch {
        return false;
      }
    },

    /** OS 唤醒事件订阅：powerMonitor 'resume' → core 回调（held lastResume
     *  补发语义在 core）。传输层重探由 main 装配侧另挂监听。 */
    onSystemResume(cb: (timestamp: number) => void): void {
      systemResumeCallback = cb;
    },

    /** 主窗口 'show' 事件订阅（held-resume/通知补发点）；装配侧 glue 每窗挂接。 */
    onMainWindowShown(cb: () => void): void {
      host.onMainWindowShown(cb);
    },

    /** 渲染器可用性门：webContents 是否仍在加载（无主窗/已销毁视同「加载中」）。 */
    webViewLoading(): boolean {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) return true;
      try {
        return win.webContents.isLoading();
      } catch {
        return true;
      }
    },

    /** 渲染器可用性门：webContents 是否存活（非 crashed/destroyed）。 */
    webViewContentAlive(): boolean {
      const win = host.mainWindow();
      if (win === null) return false;
      return webContentsAlive(win);
    },

    /** 主窗口存在性门：win!=null 且未销毁（隐藏到托盘仍为 true）。 */
    mainWindowAlive(): boolean {
      const win = host.mainWindow();
      if (win === null) return false;
      try {
        return !win.isDestroyed();
      } catch {
        return false;
      }
    },

    /** 来源退役驱逐：把 sourceId 已退役的活跃原生通知关闭并注销
     *  （click 回执随对象消亡），返回驱逐数。 */
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

    /** shell.openExternal 叶：reject（OS 打开失败）原样透传——本叶不做
     *  白名单/规范化/预算/冷却（留 core 调用点折算 loud）。 */
    openExternal(url: string): Promise<void> {
      return shell.openExternal(url);
    },

    /** shell.openPath 叶：resolve 的错误串（非空 = OS 打开失败）与
     *  win32/linux 的 reject 路径统一 loud（throw）；core 的 invokeOpenPath
     *  归一原始错误文本（成功 '' → null）。 */
    async openPath(p: string): Promise<void> {
      const error = await shell.openPath(p);
      if (error !== '') throw new Error(error);
    },

    /** shell.showItemInFolder 叶（Finder 揭示）；异常由调用侧兜底。 */
    showItemInFolder(p: string): void {
      shell.showItemInFolder(p);
    },

    /** dialog.showErrorBox 包装（core deep-link OS 启动消费循环的错误框腿）。 */
    showError(title: string, detail: string): void {
      dialog.showErrorBox(title, detail);
    },

    /** 确认对话框叶：dialog.showMessageBox 包装，父窗 = 当前主窗（macOS 挂为
     *  窗 sheet），返回按钮序号。无存活主窗抛 'native confirmation unavailable'；
     *  预检与调用间窗口销毁的竞态抛出，由调用侧 catch 折算 loud error。 */
    async showMessage(opts: HostMessageOptions): Promise<number> {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) throw new Error('native confirmation unavailable');
      const { response } = await dialog.showMessageBox(win, opts);
      return response;
    },

  };
}
