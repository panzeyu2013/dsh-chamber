/**
 * Desktop notification wiring (design 19 §3.3, split from main.ts — A1): the
 * main-process notification chain (payload whitelist → dedupe claim → platform
 * support → settings decision → native Notification), the notification-click
 * open queue (pendingNotificationOpens + drain, mirroring the deep-link
 * pendingIntents pattern) and the renderer readiness flag. The decision logic
 * lives in notifications.ts (pure); the electron side effects (Notification,
 * window focus) and the IPC handlers live here.
 *
 * main.ts keeps two handles for the window lifecycle: resetDrainReady()
 * (render-process-gone / did-start-loading: the renderer's onOpen listener is
 * gone or about to reload) and drainOpens() (did-start-loading / startup end).
 */

import { ipcMain, Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { TrustedIpc } from './renderer-trust.ts'
import { DEFAULT_CHAMBER_SETTINGS } from './chamber-settings.ts'
import type { ChamberNotificationSettings } from './chamber-settings.ts'
import { claimNotification, decideNotification, validateNotificationRequest } from './notifications.ts'
import type { NotificationSettingsLike } from './notifications.ts'
import { DRAIN_QUEUE_LIMIT, enqueueBounded, shouldDrainNotificationOpen } from './wiring.ts'

/** Dependencies injected by main.ts at startup (whenReady assembly). */
export interface NotificationsWiringCtx {
  trustedIpc: TrustedIpc
  mainWindow: () => BrowserWindow | null
  /** Quit-in-progress gate: click enqueues are ignored while quitting. */
  quitRequested: () => boolean
  /** Click → focus/rebuild the window (main.ts's single window path). */
  showMainWindow: () => void
  /** The chamber settings holder's notifications sub-object (settings wiring
   *  owns the holder; the decision merges over DEFAULT on top of it). */
  getChamberNotificationSettings: () => ChamberNotificationSettings
}

/** The handle main.ts keeps for the window-lifecycle reset points. */
export interface NotificationsWiring {
  /** render-process-gone / did-start-loading: the renderer's onOpen listener
   *  is gone (crash) or about to reload — the drain-ready flag is invalid. */
  resetDrainReady(): void
  /** did-start-loading / startup end: re-attempt the pending open pushes
   *  (the window may now be ready to receive them). */
  drainOpens(): void
}

export function registerNotifications(ctx: NotificationsWiringCtx): NotificationsWiring {
  const { trustedIpc, mainWindow, quitRequested, showMainWindow, getChamberNotificationSettings } = ctx

  // 桌面通知（design 19 §3.3）：pendingNotificationOpens 照搬 pendingIntents 的
  // 队列 + drain 模式——点击通知时窗口可能正在重建/加载，事件不能丢；active
  // Notifications Set 持有存活引用防 GC 吞 click（macOS 已知坑，OpenChamber 同款）。
  let pendingNotificationOpens: Array<{ sourceId: string; sessionId: string }> = []
  /** Renderer 就绪标志（design 19 §3.3）：renderer 注册 onOpen 监听后 invoke
   *  dsh-chamber:notifications-ready 置位——did-finish-load 早于监听注册，推送
   *  必须在就绪后才放行，否则窗口重建路径的点击事件会被 IPC 丢弃。 */
  let notificationOpenDrainReady = false
  const activeNotifications = new Set<Notification>()

  /** 单窗口聚焦判定（通知裁决的权威复查，design 19 §3.3）：渲染端 document.hasFocus
   *  与主进程复查等价（单窗口），主进程再查一次作为权威。窗口必须存在、可见且聚焦
   *  ——隐藏到托盘/后台的窗口不算聚焦。 */
  function isAnyWindowFocused(): boolean {
    const win = mainWindow()
    return win !== null && !win.isDestroyed() && win.isVisible() && win.isFocused()
  }

  /** 通知点击入队（design 19 §3.3）：quit 在途 ignore；入队后立即 drain（窗口
   *  已加载则直接推送，重建/加载中由 did-finish-load 补发——窗口关闭期间点击
   *  通知不丢事件，照搬 pendingIntents 模式）。有界队列（64 条上限，与
   *  seenDeepLinkUrls 同款防御）：窗口长期无法加载时超限丢弃最旧，绝不无限增长。 */
  function enqueueNotificationOpen(sourceId: string, sessionId: string): void {
    if (quitRequested()) return
    pendingNotificationOpens = enqueueBounded(pendingNotificationOpens, { sourceId, sessionId }, DRAIN_QUEUE_LIMIT)
    drainPendingNotificationOpens()
  }

  /**
   * 桌面原生通知主链路（design 19 §3.3）：payload 白名单 → 去重 claim → 平台
   * 支持 → 设置裁决 → 显示。返回是否实际显示（IPC 调用方/渲染端可据此判断）。
   * 'test' 绕过 claim 与全部设置门禁（设置页「发送测试通知」）；通知失败静默
   * 降级不误报——会话业务不受影响，侧边栏蓝点照常。
   */
  function maybeShowNativeNotification(payload: unknown): boolean {
    const validated = validateNotificationRequest(payload)
    if (!validated.ok) {
      console.warn(`[dsh-chamber] 拒绝非法通知 payload：${validated.error}`)
      return false
    }
    const request = validated.request
    if (!Notification.isSupported()) {
      console.warn('[dsh-chamber] 通知裁决跳过：平台不支持原生通知')
      return false
    }
    // 设置权威在主进程内存（chamberSettings.notifications，settings-set 即时更新）；
    // 旧文件缺字段时用 DEFAULT 兜底（normalizeSettings 已归一，此处仅防御）。
    const settings: NotificationSettingsLike = {
      ...DEFAULT_CHAMBER_SETTINGS.notifications,
      ...(getChamberNotificationSettings() ?? {}),
    }
    const decision = decideNotification({
      request,
      settings,
      anyWindowFocused: isAnyWindowFocused(),
    })
    if (decision.action === 'skip') return false
    // 去重 claim（5s TTL）：防同一事件双路径/重放双发；'test' 不走 claim。
    // 顺序在裁决之后：被设置/焦点跳过的请求不消费去重槽（design 19 §3.3）。
    if (request.kind !== 'test' && !claimNotification(request)) {
      return false
    }
    try {
      const notification = new Notification({
        title: request.title,
        body: request.body,
        silent: false,
        // macOS 系统提示音（OpenChamber 同款）；其余平台交给系统默认。
        ...(process.platform === 'darwin' ? { sound: 'Glass' } : {}),
      })
      // activeNotifications 持有存活引用防 GC 吞 click（macOS 已知坑）。
      activeNotifications.add(notification)
      notification.on('click', () => {
        // 聚焦/显示窗口（存在则 restore+focus，无窗则重建）+ 打开对应会话：先把
        // 打开意图入队并 drain，窗口未就绪时由 did-finish-load 补发。'test'
        // 通知（设置页测试按钮）没有会话上下文，click 只聚焦不打开。
        showMainWindow()
        if (request.kind !== 'test') enqueueNotificationOpen(request.sourceId, request.sessionId)
      })
      notification.on('close', () => {
        activeNotifications.delete(notification)
      })
      notification.on('failed', (_event, error) => {
        console.warn('[dsh-chamber] 原生通知显示失败：', error)
        activeNotifications.delete(notification)
      })
      notification.show()
      return true
    } catch (error) {
      console.warn('[dsh-chamber] 创建原生通知失败：', error)
      return false
    }
  }

  // 通知打开事件统一 drain（design 19 §3.3，照搬 pendingIntents 模式）：窗口
  // 存在、已完成加载且 renderer 已就绪（onOpen 监听注册后经
  // dsh-chamber:notifications-ready 置位）→ 直接推送；任一条件不满足 → 重新
  // 入队，did-finish-load / ready IPC 后再补发（窗口关闭期间点击通知不丢事件）。
  function drainPendingNotificationOpens(): void {
    const opens = pendingNotificationOpens
    pendingNotificationOpens = []
    for (const open of opens) {
      if (quitRequested()) return
      const win = mainWindow()
      if (shouldDrainNotificationOpen({
        windowAlive: win !== null && !win.isDestroyed(),
        isLoading: win !== null ? win.webContents.isLoading() : false,
        isCrashed: win !== null ? win.webContents.isCrashed() : false,
        rendererReady: notificationOpenDrainReady,
      })) {
        win!.webContents.send(IPC_CHANNELS.NOTIFICATION_OPEN, open)
      } else {
        pendingNotificationOpens.push(open)
      }
    }
  }

  // 桌面通知（design 19 §3.3）：渲染端检测会话边沿并组装 payload → notify
  // （invoke，返回是否实际显示）→ 主进程白名单/去重/裁决 + 原生通知。click →
  // notification-open 推送 → 渲染端 openSession（既有路径）。
  ipcMain.handle(IPC_CHANNELS.NOTIFY, trustedIpc(({ payload }) => maybeShowNativeNotification(payload)))
  // Renderer 通知就绪信号（design 19 §3.3）：onOpen 监听注册后调用——通知点击
  // 的推送只在就绪后放行（did-finish-load 早于监听注册，见 drain 条件）。
  // 返回 true 与 preload 的 Promise<boolean> 声明一致（成功置位信号）。
  ipcMain.handle(IPC_CHANNELS.NOTIFICATIONS_READY, trustedIpc(() => {
    notificationOpenDrainReady = true
    drainPendingNotificationOpens()
    return true
  }))

  return {
    resetDrainReady() {
      notificationOpenDrainReady = false
    },
    drainOpens: drainPendingNotificationOpens,
  }
}
