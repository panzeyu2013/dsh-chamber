/**
 * open-in registry wiring (designs 16/17, split from main.ts — A1): builds
 * the shared host dependency bundle (vscodeCtx = VscodeLaunchContext, reused
 * by the OS deep-link drain in ipc-deep-link.ts) plus the open-in execution
 * context (stat/openPath/showItemInFolder wrappers) and registers the
 * dsh-chamber:open-in-apps / dsh-chamber:open-in handlers. The validation and
 * pipeline logic lives in open-in.ts / deep-link.ts (pure); the electron
 * shell/fs wrappers and the IPC handlers live here.
 */

import { ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { TrustedIpc } from './renderer-trust.ts'
import type { TransportManager } from './transport-manager.ts'
import { detectVscodeAvailability } from './deep-link.ts'
import type { VscodeLaunchContext } from './deep-link.ts'
import { listOpenInApps, normalizeOpenPathError, runOpenInLaunch } from './open-in.ts'
import type { OpenInLaunchContext, OpenInRequest } from './open-in.ts'

/** Dependencies injected by main.ts at startup (whenReady assembly). */
export interface OpenInWiringCtx {
  trustedIpc: TrustedIpc
  transportManager: () => TransportManager | null
  mainWindow: () => BrowserWindow | null
}

/** The handle main.ts keeps: the vscode context shared with the deep-link drain. */
export interface OpenInWiring {
  vscodeCtx: VscodeLaunchContext
}

export function registerOpenIn(ctx: OpenInWiringCtx): OpenInWiring {
  const { trustedIpc, transportManager, mainWindow } = ctx

  // VS Code 深链（design 16 §4/§5）+ open-in 注册表（open-in.ts）的共享宿主
  // 依赖束：vscodeCtx 同时供 OS 深链 drain（runVscodeLaunch）与 open-in 执行
  // 管线复用。lookupInstance 查 transportManager 实查；vscodeAvailable 每次
  // 实探（getter 惰性、无缓存陈旧）；openVscodeUrl 包装 shell.openExternal
  // （catch → loud error，返回 {error} 由调用方处理）。
  const vscodeCtx: VscodeLaunchContext = {
    lookupInstance: (id) => {
      const sm = transportManager()
      if (sm === null) return null
      const instance = sm.listInstances().find(entry => entry.id === id)
      if (instance === undefined) return null
      return { id: instance.id, host: instance.host, user: instance.user, sshPort: instance.sshPort, kind: instance.kind }
    },
    vscodeAvailable: () => detectVscodeAvailability(process.platform).available,
    openVscodeUrl: async (url) => {
      // Injection-point scheme re-verification (security-review P2-1, mirror
      // of isAllowedReleaseUrl's discipline): only our constructed targets
      // may ever reach shell.openExternal — the ssh-remote URL for remote
      // sources and the file URL for the local source (user decision
      // 2026-08: local workspaces open as local folders).
      if (typeof url !== 'string' || !(url.startsWith('vscode://vscode-remote/') || url.startsWith('vscode://file/'))) {
        const message = 'refused to open a non-vscode URL'
        console.error(`[dsh-chamber] ${message}:`, url)
        return { ok: false, error: message }
      }
      try {
        await shell.openExternal(url)
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-chamber] 打开 vscode URL 失败：', error)
        return { ok: false, error: `open vscode url failed: ${message}` }
      }
    },
  }

  // open-in 注册表（open-in.ts）：apps() 能力协商 + 统一执行管线。wiredCtx
  // 复用 registry/availability/openVscodeUrl 依赖，补 shell 文件系统面
  // （stat/openPath/showItemInFolder 均为主进程包装）。原 design 16 的两个
  // vscode IPC（vscode-availability / open-vscode）随旧插件删除而移除——渲染
  // 层唯一入口收敛为 open-in 两个通道（复核 2026-08）。
  const openInCtx: OpenInLaunchContext = {
    lookupInstance: vscodeCtx.lookupInstance,
    vscodeAvailable: vscodeCtx.vscodeAvailable,
    openVscodeUrl: vscodeCtx.openVscodeUrl,
    stat: async (p) => {
      try {
        const s = await fsp.stat(p)
        return s.isDirectory() ? { kind: 'dir' } : { kind: 'file' }
      } catch { return null }
    },
    openPath: async (p) => {
      // shell.openPath 部分失败模式（win32/linux）存在 reject 路径——与
      // openVscodeUrl 封装同款纪律：reject 归一为错误串（loud），绝不落
      // transport rejection。
      try {
        return normalizeOpenPathError(await shell.openPath(p))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-chamber] 打开路径失败：', error)
        return `open path failed: ${message}`
      }
    },
    showItemInFolder: (p) => shell.showItemInFolder(p),
  }

  ipcMain.handle(IPC_CHANNELS.OPEN_IN_APPS, trustedIpc(() => ({ apps: listOpenInApps(process.platform) })))
  ipcMain.handle(IPC_CHANNELS.OPEN_IN, trustedIpc(async (payload: unknown) => {
    // 载荷形状守卫（复核 P2）：不可信渲染载荷直接解构会以 TypeError 落到
    // transport rejection——统一为 loud {error}，与其余失败面一致。
    const req = payload as Partial<OpenInRequest> | null
    if (req === null || typeof req !== 'object' || typeof req.appId !== 'string' || typeof req.instanceId !== 'string' || typeof req.path !== 'string') {
      return { ok: false, error: 'invalid open-in payload' }
    }
    const result = await runOpenInLaunch({ appId: req.appId, instanceId: req.instanceId, path: req.path }, openInCtx)
    // vscode 启动成功后 best-effort 推送 intent 激活渲染层对应来源（与 OS
    // 深链路径对齐，维持「vscode 启动→激活源」不变量；finder 无对应激活
    // 语义不推送；窗口未就绪/销毁则跳过，不阻塞启动）。
    if (result.ok && req.appId === 'vscode') {
      const win = mainWindow()
      if (win !== null && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.DEEP_LINK_INTENT, { instanceId: req.instanceId, path: req.path })
      }
    }
    return result
  }))

  return { vscodeCtx }
}
