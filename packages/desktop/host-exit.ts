/**
 * Host exit leg: the graceful shutdown order (quitting gate -> abort in-flight
 * transactions -> parallel transport/installer/transaction teardown -> timers and
 * gateway sessions) and the quit-facts projection the frame reads on close.
 * Split out of host-assembly.ts (B4-1); every handle arrives as a dependency, so the
 * module owns no lifecycle of its own.
 */
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import type { ChamberSettings } from './chamber-settings.ts'
import { LOCAL_RUNNING_STATES, RUNTIME_ABORT_REASON } from './shell-core.ts'
import type { RuntimeStartupHostState } from './runtime-startup-host.ts'
import type { TransportManager } from './transport-manager.ts'

export interface HostExitDeps {
  runtimeState: RuntimeStartupHostState
  transportManager: TransportManager | null
  disposeRuntimeInstaller: () => Promise<void>
  sessionRefresh: { dispose: () => void }
  authRecovery: { dispose: () => void }
  authRecoveryContext: { clear: () => void }
  gatewaySessions: { dispose: () => void }
  markQuitting: () => void
  settings: { current: () => ChamberSettings }
  updateQuitExempt: () => boolean
  plane: () => PlaneHandle | null
  logTag: string
}

export function createHostExit(deps: HostExitDeps) {
  const {
    runtimeState, transportManager, disposeRuntimeInstaller, sessionRefresh, authRecovery,
    authRecoveryContext, gatewaySessions, plane, logTag,
  } = deps
  const dispose = async (): Promise<void> => {
    deps.markQuitting()
    runtimeState.startBlocked = true
    // abort 文案单源（shell-core RUNTIME_ABORT_REASON）。
    runtimeState.operationAbort?.abort(new Error(RUNTIME_ABORT_REASON))
    try {
      await Promise.allSettled([
        transportManager?.disposeAsync().catch((err) => console.error(`${logTag} 传输层关闭失败：`, err)),
        disposeRuntimeInstaller().catch((err) => console.error(`${logTag} 运行时安装器关闭失败：`, err)),
        runtimeState.operation?.catch((err) => console.error(`${logTag} 运行时事务关闭失败：`, err)),
      ])
    } finally {
      // 计时器先停：refresh 触发绝不可竞态已 dispose 的 manager。
      sessionRefresh.dispose()
      authRecovery.dispose()
      authRecoveryContext.clear()
      gatewaySessions.dispose()
    }
  }
  // 关窗/退出事实投影：settings 实时 holder + localProcessAlive 判据（state 显示 running 不够，
  // restart backoff 期间会误报）；updateDownloadReady 由 flavor 注入。
  const quitFacts = (): {
    windowCloseBehavior: ChamberSettings['windowCloseBehavior']
    quitConfirmation: boolean
    localRunning: boolean
    updateDownloadReady: boolean
  } => {
    const livePlane = plane()
    const localRunning = livePlane !== null
      && LOCAL_RUNNING_STATES.has(livePlane.connectionState)
      && livePlane.localProcessAlive
    return {
      windowCloseBehavior: deps.settings.current().windowCloseBehavior,
      quitConfirmation: deps.settings.current().quitConfirmation,
      localRunning,
      updateDownloadReady: deps.updateQuitExempt(),
    }
  }


  return { dispose, quitFacts }
}
