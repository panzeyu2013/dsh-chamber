/**
 * VS Code deep-link wiring (design 16 §4/§5, split from main.ts — A1): the
 * OS-level deep-link intake (macOS open-url / Win+Linux second-instance argv
 * / cold-start argv), the pendingIntents queue + seenDeepLinkUrls dedupe and
 * the unified drain (runs runVscodeLaunch through the shared vscodeCtx from
 * ipc-open-in.ts). Parsing/validation/URL building stay in deep-link.ts
 * (pure); the queue state and the electron side effects live here.
 *
 * TIMING: enqueueDeepLink must work BEFORE whenReady (a macOS cold-start
 * open-url event can arrive early), so the queue and the intake functions are
 * module-scope and import-time ready; register() (whenReady) only binds the
 * quit gate and the drain closure (which needs the vscodeCtx built by
 * registerOpenIn).
 */

import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { VscodeLaunchContext, VscodeLaunchRequest } from './deep-link.ts'
import { parseOpenVscodeIntent, runVscodeLaunch } from './deep-link.ts'
import { DRAIN_QUEUE_LIMIT, enqueueBounded, recordDeepLinkSeen } from './wiring.ts'

/** Dependencies injected by main.ts (register called in whenReady, after
 *  registerOpenIn built the vscodeCtx). */
export interface DeepLinkWiringCtx {
  /** Quit-in-progress gate (intake ignored while quitting). */
  quitRequested: () => boolean
  mainWindow: () => BrowserWindow | null
  /** The shared vscode host bundle from ipc-open-in.ts. */
  vscodeCtx: VscodeLaunchContext
}

/** The handle main.ts keeps: intake + the startup-end drain. */
export interface DeepLinkWiring {
  /** Scan argv for dsh-chamber:// deep links (defensive: no side effects,
   *  never throws on non-deep-link argv). */
  scan(argv: readonly string[]): string[]
  /** Intake one raw deep link (dedupe + parse + enqueue + immediate drain). */
  enqueue(rawUrl: string): void
  /** Consume pendingIntents (startup complete). */
  drainIntents(): void
}

// VS Code 深链（design 16 §4.2）：OS 级深链（macOS open-url / Win+Linux
// second-instance argv / 冷启动 argv）统一入 pendingIntents 队列，startup 完成
// （transportManager 装载 + 主窗口就绪）后统一 drain。seenDeepLinkUrls 去重
// （macOS open-url 与 argv 双触发同一 URL）；超过 64 条整体清空防无限增长
// （非 LRU——清空后同 URL 可重放，打开 VS Code 幂等，无害；security-review
// P2-4 注释与实现语义对齐）。
let pendingIntents: VscodeLaunchRequest[] = []
const seenDeepLinkUrls = new Set<string>()
// The quit gate and the drain closure are bound by register() (whenReady);
// before that the intake defaults to "not quitting" and "no drain yet" — a
// cold-start open-url can arrive before startup, and quit cannot be in
// progress before whenReady anyway.
let isQuitting: () => boolean = () => false
let drain: (() => void) | null = null

/** 扫描 argv 中的 dsh-chamber:// 深链（防御式：非深链 argv 零副作用、绝不 throw）。 */
export function scanDeepLinkUrls(argv: readonly string[]): string[] {
  const urls: string[] = []
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('dsh-chamber://')) urls.push(arg)
  }
  return urls
}

/** 深链入队：quit 在途 ignore（不启动 VS Code）；同 URL 去重；解析失败 loud。 */
export function enqueueDeepLink(rawUrl: string): void {
  if (isQuitting()) return
  if (!recordDeepLinkSeen(seenDeepLinkUrls, rawUrl, DRAIN_QUEUE_LIMIT)) return
  const parsed = parseOpenVscodeIntent(rawUrl)
  if (!parsed.ok) {
    console.error(`[dsh-chamber] 深链解析失败：${parsed.error}`)
    return
  }
  // The seen-set cap bounds dedupe memory, not the cold-start work queue.
  // Bound the queue independently so repeated external protocol launches
  // before whenReady cannot grow main-process memory without limit.
  pendingIntents = enqueueBounded(pendingIntents, parsed.intent, DRAIN_QUEUE_LIMIT)
  drain?.()
}

/**
 * 深链协议注册（design 16 §4.3）：`app.isPackaged` 门控——开发态注册会把裸
 * Electron 注册成 scheme handler，污染 LaunchServices，与打包版 bundle id
 * （com.dshchamber.desktop）冲突（镜像托盘先例）。win32 首版门控（暂缓一致性，
 * 镜像 ssh 密码 askpass 门控）；打包 Linux/macOS 直接注册当前应用。Electron
 * 文档里的 execPath + argv[1] 仅用于 process.defaultApp 开发态，不能带进
 * 打包 Linux。macOS 的 electron-builder `protocols` 仍生成 CFBundleURLTypes，
 * 此处 setAsDefaultProtocolClient 兜底。失败 loud，绝不打断启动。
 */
function registerDeepLinkProtocol(): void {
  if (!app.isPackaged || process.platform === 'win32') return
  try {
    const registered = app.setAsDefaultProtocolClient('dsh-chamber')
    if (!registered) console.error('[dsh-chamber] 深链协议注册失败：平台拒绝了注册请求')
  } catch (error) {
    console.error('[dsh-chamber] 深链协议注册失败：', error)
  }
}

export function registerDeepLink(ctx: DeepLinkWiringCtx): DeepLinkWiring {
  const { quitRequested, mainWindow, vscodeCtx } = ctx
  isQuitting = quitRequested

  // 深链统一 drain（design 16 §4.2）：startup 完成（transportManager 装载 +
  // 主窗口就绪）后消费 pendingIntents。深链执行（VS Code 启动）不阻塞窗口；
  // 成功后 best-effort 推送 intent（窗口未就绪/销毁则跳过）；失败 loud
  // （对话框 + 日志）。quit 在途的深链已在 enqueueDeepLink 被 ignore。
  drain = () => {
    const intents = pendingIntents
    pendingIntents = []
    for (const intent of intents) {
      if (quitRequested()) return
      void (async () => {
        const result = await runVscodeLaunch(intent, vscodeCtx)
        if (result.ok) {
          const win = mainWindow()
          if (win !== null && !win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.DEEP_LINK_INTENT, intent)
          }
        } else {
          console.error(`[dsh-chamber] 深链执行失败：${result.error}`)
          dialog.showErrorBox('打开 VS Code 失败', result.error)
        }
      })().catch((error) => {
        // runVscodeLaunch 内部已兜底，此处只防意外 rejection 成为
        // unhandled（security-review：drain 的 async IIFE 无 catch）。
        console.error('[dsh-chamber] 深链执行异常：', error)
      })
    }
  }

  registerDeepLinkProtocol()

  return {
    scan: scanDeepLinkUrls,
    enqueue: enqueueDeepLink,
    drainIntents: () => drain?.(),
  }
}
