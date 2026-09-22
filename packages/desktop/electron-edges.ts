/**
 * Electron HostEdges flavor (design 25 §4.1).
 *
 * The Electron main process hands its host back-references to
 * createElectronEdges and receives the HostEdges seam object (interface in
 * shell-core.ts) that core business code calls for every Electron side
 * effect. A later Swift-native flavor (node-edges.ts) implements the same
 * seam over the B bridge. This is a face-B file by design: it imports
 * electron (runtime imports — Notification / powerMonitor / app)
 * and therefore sits on the electron-free-gate whitelist.
 *
 * Implemented member set (the returned object's Pick type = the exact
 * implemented set, so core/main.ts cannot touch a not-yet-implemented member
 * at compile time):
 *   - rendererPush — the single-main-window send leaf. The four
 *     committed state pushes (SSH_STATUS_CHANGED / SSH_INSTANCES_CHANGED /
 *     UPDATE_STATE_CHANGED / RUNTIME_STATE_CHANGED) leave through it; the
 *     UPDATE_STATE_CHANGED caller (updater.subscribe push) lives in
 *     shell-core's installIpcHandlers, the others remain assembly-side.
 *   - notify/badge/ready + renderer delivery: the NOTIFY host leg
 *     (showNativeNotification with the private B4 notification-object
 *     registry/eviction, notificationSupported, retireNotificationsForSources
 *     for the registry-retire path), the BADGE_COUNT host leg (setBadge apply
 *     leaf + badgeCountApiAvailable fact — the platform gate stays in core
 *     badge.ts, E5), the renderer-delivery window facts (mainWindowAlive /
 *     webViewLoading / webViewContentAlive / isFocused) and the resume/show
 *     event subscriptions (onSystemResume / onMainWindowShown) whose core
 *     callbacks register in installIpcHandlers. The window 'show' glue and
 *     the click activation leg live behind the host back-refs defined below.
 *   - ssh plugin dialog legs — showMessage (dialog.showMessageBox wrapper,
 *     main.ts confirmPluginAction's box shape) and pickPluginSource (folder|.tgz
 *     dual mode with the darwin one-dialog semantics; the host mainWindow
 *     back-ref is the parent, so Electron attaches the box/panel to the
 *     current window as a sheet on macOS). classifyPluginPick stays in core
 *     (plugin-tarball.ts).
 *   - open-in + update host leaves — openExternal (shell.openExternal; URL
 *     whitelist/normalization/budget/cooldown stay in core — B11), openPath /
 *     showItemInFolder (E11 — shell.openPath's resolved error string and the
 *     win32/linux rejection paths fold into a loud throw, core's invokeOpenPath
 *     adapter keeps the original error text) and showError (dialog.showErrorBox
 *     wrapper; its first core consumer is the deep-link OS launch drain in core).
 *
 * Retained HostEdges members with no core Pick consumer:
 * keep-awake (setKeepAwake), tray (trayAvailable), the click focus leg
 * (focusMainWindow), open-in (launchApp) and system/identity (setLoginItem /
 * isPackaged) are still declared on the shell-core contract, but core's
 * installer Pick does not consume them and this Electron flavor does NOT
 * implement them — the Electron-side actions live directly in main.ts
 * (setKeepAwakeActive / applyLaunchAtLogin / Tray / showMainWindow), while
 * node-edges.ts implements the members for the Swift host. notifyClicked and
 * resolveResource are not part of the shared contract (zero consumers; the
 * Swift-side semantics differed) — see the shell-core.ts HostEdges head note.
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

/** Back-references the Electron main process hands to the edge object: the
 *  single main-window identity, the click activation leg and the window-'show'
 *  subscription face (both are main-window state owned by the assembly side). */
export interface ElectronEdgesHost {
  /** 当前主窗口（可能为 null：托盘/无窗常驻态）。 */
  mainWindow: () => BrowserWindow | null;
  /** 通知 click 激活腿 = main.ts showMainWindow 语义——restore/show/
   *  focus，无窗则按控制面 origin 重建；成功返回 true。 */
  showMainWindow(): boolean;
  /** 主窗口 'show' 事件订阅面（createMainWindow glue 对每窗挂接、
   *  mainWindow===win 身份守卫在装配侧），返回退订函数。 */
  onMainWindowShown(cb: () => void): () => void;
}

/** Electron 边沿对象（实现成员集合 = 实际引用最小集；类型由
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
  | 'openExternal'
  | 'openPath'
  | 'showItemInFolder'
  | 'showError'
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

  /** B3 门实现：webContents 是否存活（非 crashed/destroyed）——rendererPush
   *  与 webViewContentAlive 共用同一判据，绝不出现两套。 */
  const webContentsAlive = (win: BrowserWindow): boolean => {
    try {
      return !win.webContents.isCrashed() && !win.isDestroyed();
    } catch {
      return false;
    }
  };

  return {
    /** 单窗身份 send 叶：主窗存在且未销毁则 webContents.send 并返回 true，
     *  否则返回 false（叶本身不 throw）。committed-push 包装
     *  （attemptCommittedRegistryPush）在调用侧把 false 折算为 push 失败
     *  （transport-manager.ts）。
     *  交付门 = 共享 rendererPushDelivered（mainWindowAlive &&
     *  webViewContentAlive，后者含 isCrashed）——crashed 渲染器上的 send
     *  绝不冒充已投递（否则 core 的 hold/rollback/ready 位复位在 Swift 侧
     *  同语义下会与 Electron 分叉）。 */
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

    /** NOTIFY 宿主腿：构造 + 有界登记/淘汰 + click/close 监听 +
     *  honest-show 结算全在本实现内（B4）。click 腿顺序 = 先
     *  activate/restore/focus 主窗口（无窗则重建，host.showMainWindow），成功
     *  才回调 core 的 clickRoute.onActivated（owns+入队在 core）——focus 先于
     *  代际 owns 校验：来源已退役时窗口仍被激活，只跳过打开意图入队。
     *  返回句柄：shown = 结算结果（NOTIFY IPC 返回
     *  值与 claim 释放依赖）；dispose = click 回执注销（注销后该通知的后续
     *  click 只恢复窗口）。本实现不 throw：构造/登记/监听失败一律结算为
     *  shown:false 且登记清理内部完成。 */
    showNativeNotification(spec, clickRoute) {
      // 平台分支（macOS 系统提示音 Glass，OpenChamber 同款）属实现侧；
      // 其余平台交给系统默认。spec.silent 缺省 false。
      const created = new Notification({
        title: spec.title,
        body: spec.body,
        silent: spec.silent ?? false,
        ...(process.platform === 'darwin' ? { sound: spec.sound ?? 'Glass' } : {}),
      });
      let route = clickRoute;
      // 有界登记持有存活引用防 GC 吞 click。满员不拒发：macOS 横幅进入通知
      // 中心后不触发 close，拒发会让未清除的存量横幅永久卡死通知流——登记按
      // 插入序淘汰最旧一条，由调用方 close 退役后新通知照常显示。
      const evicted = activeNotifications.add(created, route?.token ?? null);
      if (evicted !== null) {
        console.warn(`[dsh-chamber] 活跃原生通知已达上限 ${MAX_ACTIVE_NATIVE_NOTIFICATIONS} 条，淘汰最旧一条以继续显示`);
        try { evicted.close(); } catch { /* best-effort host cleanup */ }
      }
      created.on('click', () => {
        try {
          // click 腿：宿主内先激活/恢复/聚焦主窗口（无窗则重建），
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
      // Electron 主进程没有 macOS 通知授权查询/申请
      // API（证据与残余见 notifications.ts describeNativeNotificationFailure
      // 头注）。唯一可得的诚实面在这里接线：OS 拒绝投递（failed 事件）或限时
      // 无回执（timeout）时，错误文本显式说明「可能未授权 / 可能被系统抑制」
      // 并保留 OS 原文——Swift 腿的 denied→fail、notDetermined→申请一次是
      // 同一「拒绝/未确认必诚实回错」的语义；本叶不冒充已授权。
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
        // 其 'close' 监听同样注销；此处幂等兜底 failed 事件后未 close 的死条目）。
        if (!outcome.shown) activeNotifications.delete(created);
      });
      return {
        dispose: () => { route = null; },
        shown,
      };
    },

    /** Notification.isSupported 平台探测（异常安全；探测失败与不支持同值，
     *  core 侧统一按「平台不支持」loud）。 */
    notificationSupported(): boolean {
      try {
        return Notification.isSupported() === true;
      } catch {
        return false;
      }
    },

    /** BADGE_COUNT 宿主腿（E5）：apply 叶——异常安全，绝不 throw；
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
     *  false）。 */
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
     *  「加载中」（投递门恒不通过）。 */
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

    /** 来源退役驱逐（B4 registry 私有）：注册表退役路径把 sourceId
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

    // —— 打开/拉起（B11/E10/E11）——
    /** shell.openExternal 叶（B11/E10）：reject（OS 打开失败）原样透传——core
     *  调用点（openVscodeUrl / openReleasePage / 外链预算器）各自折算 loud 结果，
     *  本叶不做白名单/规范化/预算/冷却（留 core）。 */
    openExternal(url: string): Promise<void> {
      return shell.openExternal(url);
    },

    /** shell.openPath 叶（E11）：失败模式语义照搬——resolve 的错误串（非空 =
     *  OS 打开失败）与 win32/linux 的 reject 路径统一 loud（throw），core 侧
     *  invokeOpenPath 适配把原始错误文本原样归一（成功 '' → null）。 */
    async openPath(p: string): Promise<void> {
      const error = await shell.openPath(p);
      if (error !== '') throw new Error(error);
    },

    /** shell.showItemInFolder 叶（E11：Finder 揭示）。异常由调用侧兜底
     *  （runOpenInLaunch 的 loud {error} 投影）。 */
    showItemInFolder(p: string): void {
      shell.showItemInFolder(p);
    },

    /** dialog.showErrorBox 包装（core 的 deep-link OS 启动消费循环的 loud
     *  错误框腿；其调用点外层 catch 兜底本叶异常）。 */
    showError(title: string, detail: string): void {
      dialog.showErrorBox(title, detail);
    },

    /** 确认对话框叶：dialog.showMessageBox 包装——父窗 = 当前主窗
     *  （host.mainWindow()，macOS 挂为窗 sheet），返回按钮序号 response（按钮
     *  序/编号约定由调用侧负责）。无存活主窗抛错（'native confirmation
     *  unavailable'）——调用侧预检 edges.mainWindowAlive() 兜底；窗口在预检与
     *  调用间销毁的竞态抛出，由调用侧 catch 折算 loud error）。 */
    async showMessage(opts: HostMessageOptions): Promise<number> {
      const win = host.mainWindow();
      if (win === null || win.isDestroyed()) throw new Error('native confirmation unavailable');
      const { response } = await dialog.showMessageBox(win, opts);
      return response;
    },

    /** 插件源一体化 picker 叶（folder|.tgz 双模式：darwin NSOpenPanel 一体
     *  openFile+openDirectory、扩展过滤只约束文件选择；非 mac 仅目录）；
     *  父窗 = 当前主窗。调用侧预检 mainWindowAlive；预检与调用间窗口销毁的
     *  竞态抛出，绝不折算为取消。分类（classifyPluginPick）留 core
     *  （plugin-tarball.ts）。 */
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
