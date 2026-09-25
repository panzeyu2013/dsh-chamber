/**
 * HostEdges — the host side-effect seam (design 25 §4.1), extracted from
 * shell-core.ts (R4 P7 type-cycle break). Leaf module: it must never import
 * shell-core.ts or a shell-ipc-* registrar.
 */
import type { NotificationOpenIntent, NotificationSourceToken } from './notifications.ts';

// HostEdges — the host side-effect seam (design 25 §4.1).
// Core business code reaches every Electron/host side effect ONLY through
// this injected interface. The Electron main process implements it in
// electron-edges.ts (createElectronEdges — the rendererPush
// leaf); the Swift-native
// flavor will implement the same seam over the B bridge (node-edges.ts).
// Electron-free by construction: member types are strings/numbers/booleans/
// Promises/local structural types — never electron types,
// and no IPC registration or bare channel literals live here. Member-level
// deviations from the design 25 §4.1 draft are annotated per member (v2
// field set per design 25 §0.1 rows A10/B1/B3/B4/B9/B11/D3).

/** 原生通知 open intent / 来源代际 token（design 19 §3.3）——re-export 自纯逻辑
 *  模块 notifications.ts（electron-free，结构类型可直接跨 core/edges 使用）。 */
export type { NotificationOpenIntent, NotificationSourceToken };

/** 原生通知构造规格（§4.1 NativeNotificationSpec 的最小结构形态：通知叶
 *  new Notification({title, body, silent, sound…}) 所需字段；平台分支
 *  （macOS sound 等）属实现侧）。 */
export interface NativeNotificationSpec {
  title: string
  body: string
  silent?: boolean
  sound?: string
}

/** dialog.showMessageBox 选项（最小结构形态：按现用调用点
 *  type/title/message/detail/buttons/defaultId/cancelId/noLink 收口）。 */
export interface HostMessageOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title?: string
  message: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  noLink?: boolean
}

/** badge 应用结果。与 §4.1 草案 setBadge(count): boolean 的偏差：v2 用判别
 *  形态区分「已应用」与「未应用 + 原因」（reason 取 string）。 */
export type HostSetBadgeResult =
  | { applied: true }
  | { applied: false; reason: string };

/** HostEdges — core 侧唯一可见的宿主边沿契约（design 25 §4.1 v2 字段集）。
 *  notifyClicked 与 resolveResource 两个**零消费者**成员不在契约内——Swift
 *  宿主对 notifyClicked（经 notify 到达）判为
 *  unexpected 并 loud 忽略、resolveResource 在两侧都恒不可达（core Pick 不含、
 *  无调用方），保留它们等于保留一条语义不同、无法锁步的死面。hostFacts 的
 *  resources 推送不被消费（Swift 侧可继续推送，未知事实键按前向兼容
 *  忽略）。
 *  electron-edges.ts 头注释列出已实现集合；每个成员标注其设计行来源，
 *  未实现前 core/main.ts 不得调用（Pick 收窄在编译期保证）。 */
export interface HostEdges {
  /** 主窗口渲染器 push 叶：channel 为 opaque
   *  通道名（Electron 侧恒为 IPC_CHANNELS 常量值），payload 为纯非秘密投影；
   *  返回 false = 当前无存活主窗（单窗身份），调用侧自行折算失败语义。 */
  rendererPush(channel: string, payload: unknown): boolean
  // —— 原生显示/系统集成 ——
  /** 构造并显示原生通知（B4：宿主对象登记/淘汰/evict 全留实现侧私有）。clickRoute
   *  携带 click 回灌路由——null = 'test'
   *  通知（无会话上下文，原生 click 只恢复窗口）；否则宿主 click 腿在宿主内先
   *  activate/restore/focus 主窗口（无窗则重建，showMainWindow 语义），成功后才
   *  回调 onActivated（core 的 owns+入队闭包——来源代际校验在 core）。honest-show
   *  结算（showNativeNotificationHonestly 语义）在实现侧内部执行；返回句柄的
   *  shown 暴露结算结果（NOTIFY IPC 返回值与 claim 释放依赖它），dispose 注销
   *  click 回执（注销后该通知的后续 click 只恢复窗口）。实现侧不 throw——构造/
   *  登记/监听失败一律结算为 shown:false 且登记清理内部完成。
   *  macOS 授权在 Electron 侧无可查询/可申请 API，实现
   *  侧只能把 OS 拒绝投递（failed）与限时无回执（timeout）如实映成带原因文本
   *  的 shown:false（notifications.describeNativeNotificationFailure）；预检
   *  查询/申请面的缺失登记为精确残余（见 electron-edges showNativeNotification），
   *  绝不冒充「已授权但普通失败」。 */
  showNativeNotification(
    spec: NativeNotificationSpec,
    clickRoute: { token: NotificationSourceToken; onActivated(): void } | null,
  ): { dispose(): void; shown: Promise<{ shown: true } | { shown: false; error: string; failureClass?: 'retryable' | 'permanent' }> }
  /** Notification.isSupported 平台探测（异常安全由实现侧保证）。 */
  notificationSupported(): boolean
  /** 未读徽标 apply 叶（design 19 §3.7；E5——平台门与 badgeEnabled 裁决留 core
   *  badge.ts：core 以 badgePlatformGate(platform, badgeCountApiAvailable())
   *  先裁决、supported 后才调用本叶）：异常安全，绝不 throw。 */
  setBadge(count: number): HostSetBadgeResult
  /** app.setBadgeCount API 可用性事实（badgePlatformGate 第二参；win32 的平台
   *  原因由 core 侧平台门区分）。 */
  badgeCountApiAvailable(): boolean
  /** 托盘可用性（design 14 D1 恢复入口判定）。 */
  trayAvailable(): boolean
  /** keep-awake（design 14 D5）：powerSaveBlocker prevent-app-suspension
   *  start/stop（blocker id 属实现侧宿主态）。 */
  setKeepAwake(on: boolean): void
  /** 系统 resume 事件订阅（design 14 D4；held-resume 补发点在 core）。 */
  onSystemResume(cb: (timestamp: number) => void): void
  /** 主窗口 'show' 事件订阅（B9：held-resume/通知补发点）。 */
  onMainWindowShown(cb: () => void): void
  /** 任一窗口是否聚焦（通知裁决的窗口焦点事实）。 */
  isFocused(): boolean
  /** 通知 click 激活腿（D3）：restore+focus，无窗则重建，完成后 resolve。 */
  focusMainWindow(): Promise<void>
  /** 渲染器可用性门（B3）：webContents 是否仍在加载。实现侧窗口守卫：无主窗/
   *  已销毁视同加载中（投递门恒不通过）。 */
  webViewLoading(): boolean
  /** 渲染器可用性门（B3）：webContents 是否存活（非 crashed/destroyed）。 */
  webViewContentAlive(): boolean
  /** 主窗口存在性门（B3 族）：win!=null 且未销毁——隐藏到
   *  托盘/后台的窗口仍为 true（与 loading/alive 区分：窗口在但不一定可用）。
   *  rendererPush 返回 false 与 mainWindowAlive() 为 false 语义等价。 */
  mainWindowAlive(): boolean
  /** 来源退役驱逐（B4 registry 私有）：注册表退役路径把
   *  sourceId ∈ retiredSourceIds 的活跃原生通知关闭并注销（click 回执随对象
   *  消亡），返回驱逐数。 */
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  // —— 打开/拉起 ——
  /** shell.openExternal 叶（B11：URL 白名单判定/预算/冷却/规范化留 core）。 */
  openExternal(url: string): Promise<void>
  /** shell.openPath 叶（打开本地路径，失败 loud）。 */
  openPath(p: string): Promise<void>
  /** shell.showItemInFolder 叶（Finder 揭示）。 */
  showItemInFolder(p: string): void
  /** open-in 原生拉起（design 25 §5 E12）。 */
  launchApp(appId: string, path: string): Promise<boolean>
  // —— 对话框 ——（2026-09 C 分层：插件源 picker 随插件写面整族移除）
  /** dialog.showErrorBox 包装。 */
  showError(title: string, detail: string): void
  /** dialog.showMessageBox 包装（与草案 Promise<buttonId> 的偏差：buttonId
   *  收敛为 number = showMessageBox response）。 */
  showMessage(opts: HostMessageOptions): Promise<number>
  // —— 系统/身份/资源 ——
  /** 登录项开关（setLoginItemSettings）。 */
  setLoginItem(enabled: boolean): void
  /** app.isPackaged 能力位（B1）。 */
  isPackaged: boolean
}
