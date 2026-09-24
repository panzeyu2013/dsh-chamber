/**
 * dsh-chamber desktop shell core: electron-free business logic shared by the
 * Electron main process and the Swift-native flavor.
 *
 * Hard invariants:
 * - Never import electron; installIpcHandlers is the sole IPC registration
 *   point and every seam (registrar / edges / ctx) is injected.
 * - Host state is parameterized (userData paths, runtime base dir, argv); the only
 *   module-scope state is the renderer-delivery state machine, shared by reference
 *   with the assembly side (single-assembly: installIpcHandlers runs exactly once
 *   per process, before any window/renderer event).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChamberHostPackageDescriptor } from './control-plane-module.ts';
import { findFreePort } from './free-port.ts';
import { computeSupported } from './chamber-settings.ts';
import { createKeyedMemo, lockfileIdentityKey } from './lockfile-facts-memo.ts';
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';
import { attemptCommittedRegistryPush, type TransportManager } from './transport-manager.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
// Domain registrars (order of the calls below is the registration order).
import { registerConnectionHandlers } from './shell-ipc-connections.ts';
import { registerOpenInHandlers } from './shell-ipc-open-in.ts';
import { registerGatewayPluginHandlers } from './shell-ipc-plugins-gateway.ts';
import { registerLocalPluginHandlers } from './shell-ipc-plugins-local.ts';
import { registerSshPluginHandlers } from './shell-ipc-plugins-ssh.ts';
import { registerRuntimeHandlersA, registerRuntimeHandlersB, registerRuntimeHandlersC } from './shell-ipc-runtime.ts';
import { registerSettingsHandlers } from './shell-ipc-settings.ts';
import { registerUpdateHandlers } from './shell-ipc-update.ts';
import type { NotificationOpenIntent, NotificationSourceToken } from './notifications.ts';
import { type TransportInstanceSpec } from './transport-provider.ts';
import { getSshPassword } from './ssh-provider.ts';
import { gatewaySecretStorageCrossFlavorUnreadable, gatewaySecretStorageMode, getGatewayPassword, getGatewayToken } from './gateway-provider.ts';
import { type GatewaySessionManager } from './gateway-session.ts';
import type { AuditEvent } from './audit-log.ts';
import { adjudicateBadgeCount, badgePlatformGate } from './badge.ts';
import {
  BoundedAckDeliveryQueue,
  BoundedVscodeIntentQueue,
  canDeliverRendererDeepLink,
  describeUnknownError,
  detectVscodeAvailability,
  parseOpenVscodeIntent,
  runVscodeLaunch,
} from './deep-link.ts';
import type { VscodeLaunchContext, VscodeLaunchRequest } from './deep-link.ts';
// 深链 scheme 的单一来源（leaf——避免 shell-core ↔ deep-link 的 ESM 循环）。
import { isDeepLinkUrl } from './deep-link-scheme.ts';
// open-in.ts / updater.ts 为 electron-free 纯模块：宿主叶（stat/openPath/
// showItemInFolder）经 edges 注入；updater 的 electron/electron-updater 经
// createRequire 惰性解析。update 面只做类型 import，实例由 main 装配侧经 ctx 注入。
import type { OpenInLaunchContext } from './open-in.ts';
import type { UpdateController } from './updater.ts';

/** macOS「系统设置 → 通知」面板深链；固定常量、只由 OPEN_NOTIFICATION_SETTINGS
 *  使用——renderer 不能传 URL，避免把 OPEN_RELEASE 的 URL 白名单扩成任意打开面。 */
export const MACOS_NOTIFICATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
import { BoundedRateLimiter, MAX_PENDING_NOTIFICATION_OPENS, NotificationSourceIncarnations, NotificationSourceProofs } from './notifications.ts';
import { readCurrentPointerState, readOverrideState, shouldInvalidate, validateVersionTree } from '@dsh-chamber/dsh-runtime';
// J 组直 import 的 dsh-runtime 纯逻辑（electron-free 共享核）；控制器实例/
// fence/门/宿主叶经 ctx 注入（实例态与单写者归 main 装配侧）。
import type { RuntimeAction, RuntimeOperationFence } from '@dsh-chamber/dsh-runtime';
// K 组直 import 的 dsh-runtime 纯逻辑与类型面（activation intent/journal/override
// 持久化写、pre-rollback stash 只读/恢复、restore marker 权威读）；启动事务宿主与
// 共享闭包经 ctx 注入。
import type { ActivationJournalState, StartupResult } from '@dsh-chamber/dsh-runtime';
// apply-now-gate.ts 纯门直接 import；门输入构造 readApplyNowGateInput 读装配侧
// 状态、经 ctx 注入。
import type { ApplyNowGateInput } from './apply-now-gate.ts';
// dsh-runtime-controller.ts 为 electron-free 纯编排模块：core 只 import 类型面；
// 控制器实例由 main 装配侧构造、经 ctx 注入。
import type { DshRuntimeController, RuntimeLifecycleProjection } from './dsh-runtime-controller.ts';
// F 组编排纯模块（plugin-sync / ssh-apply-rows / plugin-tarball）直接 import；
// ssh-plugin-journal / plugin-sync 的现实例与目标闭包束经 ctx 注入——自动
// seed/撤销路径与 F 组注册体必须共享同一实例（单写者/单飞语义不分叉）。
import { portableChamberHostPackageSeeds, shouldPreferPinnedRuntimeLockfile, WEB_PROFILE } from './plugin-sync.ts';
import type { ChamberHostPackageSeed, ExactOwnershipRegistry, ExecFn, PluginProtectionFacts, RemoteSpec, StatusFn } from './plugin-sync.ts';
// 插件受保护集合判定（design 21 §6.11）：control-plane-module 纯函数直接 import，
// 事实输入经 ctx。localProtectionFacts / verifyLocalProfileFamily 为 core 内助手
// （F/H 组注册体共用同一实现）。
import {
  describeFamilyFindings,
  resolveRuntimeFamily,
  verifyProfileFamilyConsistency,
} from './control-plane-module.ts';
import type { SshPluginJournal } from './ssh-plugin-journal.ts';

// 控制面端口：打包形态默认 17500；dev 从 17520 起在 200 个端口内退避（并行
// worktree 各得端口），DSH_CHAMBER_CP_PORT 固定端口，全占用回退 0（OS 临时
// 端口）。渲染器 origin 由实际绑定端口推导，别处不硬编码地址。
const DEV_CONTROL_PLANE_PORT_BASE = 17520;
const DEV_CONTROL_PLANE_PORT_ATTEMPTS = 200;
export async function resolveControlPlanePort(): Promise<number> {
  const fromEnv = process.env.DSH_CHAMBER_CP_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
    const fallback = process.env.DSH_CHAMBER_ELECTRON_DEV === '1' ? 'dev 自动退避端口' : '默认端口 17500';
    console.error(`[dsh-chamber] 忽略非法 DSH_CHAMBER_CP_PORT="${fromEnv}"（须为 1–65535 整数），使用${fallback}`);
  }
  if (process.env.DSH_CHAMBER_ELECTRON_DEV !== '1') return 17500;
  try {
    return await findFreePort(DEV_CONTROL_PLANE_PORT_BASE, { attempts: DEV_CONTROL_PLANE_PORT_ATTEMPTS });
  } catch {
    console.warn(
      `[dsh-chamber] dev 端口 ${DEV_CONTROL_PLANE_PORT_BASE}..${DEV_CONTROL_PLANE_PORT_BASE + DEV_CONTROL_PLANE_PORT_ATTEMPTS - 1} 均被占用，回退到系统临时端口（0）`,
    );
    return 0;
  }
}

/** 代理当前仅支持与桌面注册表相同的两种 transport；边界保留开放类型，未知
 *  适配器在注册前 loud 失败。 */
export function proxyTransport(transport: TransportInstanceSpec['transport']): 'ssh' | 'http' {
  if (transport === 'ssh') return 'ssh';
  if (transport === 'http') return 'http';
  throw new TypeError(`unsupported proxy transport: ${transport}`);
}

export type ActiveRuntimeSource = 'env' | 'user' | 'bundled';
export interface ActiveRuntimeResolution {
  path: string | null
  version: string | null
  source: ActiveRuntimeSource
  blockedReason: string | null
}

// Shell (dsh-chamber desktop package) version: read from this module's
// sibling package.json — the same file in dev and packaged layouts (the
// resolver compares the override's recorded shellVersion against this
// version fact).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * 同步 spawn 期解析：env > 有效 override/current > builtin。选择元数据损坏与
 * pointer/override 不一致 fail closed，绝不把「用户运行时缺失」与之混同。
 */
export function resolveActiveRuntime(baseDir: string, builtinWorkspace: string | null): ActiveRuntimeResolution {
  const envPath = process.env.DSH_CHAMBER_DSH_PATH;
  if (envPath) return { path: envPath, version: readDshVersion(envPath), source: 'env', blockedReason: null };

  const overrideState = readOverrideState(baseDir);
  const pointerState = readCurrentPointerState(baseDir);
  // 不可读（EACCES/EIO/ESTALE）与损坏同样不可解析：既不证明缺失也不证明损坏，
  // 同样 fail closed。
  if (overrideState.kind === 'corrupt' || overrideState.kind === 'unknown') {
    return {
      path: null,
      version: null,
      source: 'bundled',
      blockedReason: overrideState.kind === 'corrupt'
        ? 'dsh runtime override metadata is corrupt'
        : `dsh runtime override metadata is unreadable: ${overrideState.detail}`,
    };
  }
  if (pointerState.kind === 'corrupt' || pointerState.kind === 'unknown') {
    return {
      path: null,
      version: null,
      source: 'bundled',
      blockedReason: pointerState.kind === 'corrupt'
        ? 'dsh runtime current pointer is corrupt'
        : `dsh runtime current pointer is unreadable: ${pointerState.detail}`,
    };
  }
  const override = overrideState.kind === 'valid' ? overrideState.record : null;
  const pointer = pointerState.kind === 'valid' ? pointerState.version : null;
  // override 有效性由共享 dsh-runtime 谓词 shouldInvalidate 判定（运行时启动与
  // gateway 形态消费同一门）。
  if (
    override !== null
    && !shouldInvalidate(override, version)
  ) {
    if (pointer !== null) {
      const tree = validateVersionTree(baseDir, pointer);
      if (tree.ok) return { path: tree.path, version: pointer, source: 'user', blockedReason: null };
      return {
        path: null,
        version: pointer,
        source: 'user',
        blockedReason: `dsh runtime pointer tree is invalid: ${tree.error}`,
      };
    }
    const builtinIsAuthoritative = override.pending !== null
      || override.chosenVersion === null
      || override.resolvedVersion === null
      || override.lastOutcome === 'rolled-back'
      || override.lastOutcome === 'failed';
    if (!builtinIsAuthoritative) {
      return {
        path: null,
        version: override.resolvedVersion,
        source: 'user',
        blockedReason: 'active user override is missing its authoritative current pointer',
      };
    }
  }
  if (pointer !== null) {
    return {
      path: null,
      version: pointer,
      source: 'user',
      blockedReason: 'dsh runtime pointer has no matching active override',
    };
  }
  return {
    path: builtinWorkspace,
    version: readDshVersion(builtinWorkspace),
    source: 'bundled',
    blockedReason: builtinWorkspace === null ? 'bundled dsh workspace not found' : null,
  };
}

export function readDshVersion(workspace: string | null): string | null {
  if (workspace === null) return null;
  try {
    const manifest = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    return manifest.dependencies?.['@deepseek-ai/dsh'] ?? null;
  } catch {
    return null;
  }
}

// 双 flavor 锁步面：常量与判定共享同一拼写，任一侧漂移即产生语义分叉。

/** 唯一的运行时事务 abort 原因：两侧 flavor 的同一位置都必须引用此常量，不得
 *  各自拼写。 */
export const RUNTIME_ABORT_REASON = 'application is quitting';

/** 唯一的 rendererPush 投递门：两侧 flavor 都要把返回值折进来
 *  （mainWindowAlive && webViewContentAlive）。向崩溃渲染器 send 永不到达页面，
 *  不折算为 false 会让 hold/rollback/ready-reset 语义静默分叉。 */
export function rendererPushDelivered(mainWindowAlive: boolean, webViewContentAlive: boolean): boolean {
  return mainWindowAlive && webViewContentAlive;
}

/** Electron 渲染器恢复策略的纯判定核（参数与 Swift 侧同一策略）：60s 窗口内至多
 *  3 次 reload；首次加载完成前不 reload；clean-exit/退出在途绝不 reload。main.ts
 *  只保留计时器与窗口销毁守卫，每次判定都走这里。 */
export const RENDERER_RECOVERY_WINDOW_MS = 60_000;
/** 单窗口内最大自动 reload 次数（第 4 次停止自愈并弹 loud 错误框）。 */
export const RENDERER_RECOVERY_MAX_RELOADS = 3;
/** 无响应渲染器在 reload 前的最长恢复等待。 */
export const RENDERER_HANG_RELOAD_DELAY_MS = 15_000;
/** render-process-gone 后的 reload 延迟（等崩溃拆除窗口过去）。 */
export const RENDERER_CRASH_RELOAD_DELAY_MS = 500;

/** reload 预算状态（main.ts 每窗口一个实例）。 */
export interface RendererReloadBudgetState {
  /** 当前 60s 窗口起点 ms（0 = 尚无窗口，首次 reload 开启）。 */
  windowStart: number
  /** 当前窗口内已尝试的 reload 次数。 */
  count: number
}

/** 记录一次 reload 尝试并判定是否放行（窗口超过 60s 则重置计数，严格大于比较）；
 *  返回的 attempt 驱动 loud 日志/错误框（attempt 4 = 预算耗尽）。 */
export function noteRendererReload(
  state: RendererReloadBudgetState,
  now: number,
): { allowed: boolean; attempt: number } {
  if (now - state.windowStart > RENDERER_RECOVERY_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count += 1;
  return { allowed: state.count <= RENDERER_RECOVERY_MAX_RELOADS, attempt: state.count };
}

/** 异常渲染器退出是否触发自动 reload：clean-exit 与退出在途绝不触发。 */
export function shouldReloadAfterCrash(reason: string, quitRequested: boolean): boolean {
  return reason !== 'clean-exit' && !quitRequested;
}

/** 首次加载完成前，无响应只记录：dsh 前端启动会合法阻塞主线程，reload 会打断
 *  正常启动。 */
export function shouldScheduleHangReload(loadedOnce: boolean): boolean {
  return loadedOnce;
}

/** dev 形态的仓内 dsh workspace 候选（顺序：<repoRoot>/ref-dsh 再到
 *  <packageDir>/vendor/dsh）。打包形态从不使用（Electron 用 resources/vendor/dsh，
 *  Swift 装配显式传 --dsh-path）。 */
export function devBuiltinDshWorkspaceCandidates(packageDir: string): string[] {
  return [
    path.join(packageDir, '..', '..', 'ref-dsh'),
    path.join(packageDir, 'vendor', 'dsh'),
  ];
}

/** 首个存在的 dev 候选，或 null（exists 谓词可注入）。 */
export function resolveDevBuiltinDshWorkspace(
  packageDir: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  for (const candidate of devBuiltinDshWorkspaceCandidates(packageDir)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Electron-free sidecar 的内建 workspace 解析：显式 --dsh-path 优先；打包形态
 *  绝不探测仓库（探测失败保持 loud blocked 语义）；dev 形态按同一候选顺序回退。 */
export function resolveSidecarBuiltinDshWorkspace(input: {
  explicit: string | null
  packaged: boolean
  packageDir: string
  exists?: (candidate: string) => boolean
}): string | null {
  if (input.explicit !== null) return input.explicit;
  if (input.packaged) return null;
  return resolveDevBuiltinDshWorkspace(input.packageDir, input.exists ?? existsSync);
}

// 本地实例「运行中/在途」状态：退出会中断它们，需确认。状态字符串不是存活
// 事实（restarting 期间可能尚未 spawn；死亡进程可能滞留 ready/degraded），退出
// 确认必须同时要求实际存活进程（localProcessAlive）。starting 时 child 尚未赋值、
// hasLiveProcess() 恒 false，spawn 在途由控制面 epoch/stopping 守卫在 stop() 时终止。
export const LOCAL_RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded', 'restarting']);

/** 扫描 argv 中的 dsh-chamber:// 深链（防御式：非深链零副作用、绝不 throw）；
 *  scheme 判定与大小写规范化单源在 ./deep-link-scheme.ts。 */
export function scanDeepLinkUrls(argv: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    if (typeof arg === 'string' && isDeepLinkUrl(arg)) urls.push(arg);
  }
  return urls;
}

/** 退出清理（transport dispose + 控制面 stop）最长等待 5s；超时强制退出，防
 *  「窗口已关、主进程永久滞留」。正常约 1–2s（子进程短窗口 + 并行化），5s 只为
 *  异常路径兜底。 */
export const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
/** npm search JSON body 上限（256 KiB，约束恶意/异常 registry）。 */
export const NPM_SEARCH_MAX_BODY_BYTES = 256 * 1024;

// userData 作用域路径模板：<userData> 下每个持久文件/state 根只在此拼写一次。
/** <userData>/chamber-settings.json。 */
export function chamberSettingsFilePath(userData: string): string {
  return path.join(userData, 'chamber-settings.json');
}

/** <userData>/ssh-passwords.json（0600 plaintext fallback）。 */
export function sshPasswordsFilePath(userData: string): string {
  return path.join(userData, 'ssh-passwords.json');
}

/** <userData>/gateway-secrets.json（schema v3）。 */
export function gatewaySecretsFilePath(userData: string): string {
  return path.join(userData, 'gateway-secrets.json');
}

/** <userData>/audit-log.jsonl（JSONL append）。 */
export function auditLogFilePath(userData: string): string {
  return path.join(userData, 'audit-log.jsonl');
}

/** <userData>/ssh-instances.json（持久 registry）。 */
export function instancesFilePath(userData: string): string {
  return path.join(userData, 'ssh-instances.json');
}

/** <userData>/state（控制面 stateDir）。 */
export function stateRootDir(userData: string): string {
  return path.join(userData, 'state');
}

/** <userData>/state/dsh-home（本地 dsh 实例 home）。 */
export function localDshHomeDir(userData: string): string {
  return path.join(userData, 'state', 'dsh-home');
}

// HostEdges — 宿主副作用 seam：core 业务代码只能经它触达 Electron/宿主副作用。
// 成员类型只含 string/number/boolean/Promise/本地结构类型，绝不出现 electron
// 类型或裸 channel 字面量。Electron 侧实现在 electron-edges.ts，Swift 侧同形
// 实现经 B 桥。

/** 原生通知 open intent / 来源代际 token（re-export 自 electron-free 的 notifications.ts）。 */
export type { NotificationOpenIntent, NotificationSourceToken };

/** 原生通知构造规格（通知叶所需最小字段集；平台分支属实现侧）。 */
export interface NativeNotificationSpec {
  title: string
  body: string
  silent?: boolean
  sound?: string
}

/** dialog.showMessageBox 选项（按现用调用点收口的最小字段集）。 */
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

/** 插件源 picker 结果：status 判别 cancelled/picked（path 非空即 picked；folder|tgz 归调用侧判定）。 */
export type HostPluginSourcePick =
  | { status: 'cancelled' }
  | { status: 'picked'; path: string };

/** badge 应用结果：判别形态区分「已应用」与「未应用 + 原因」。 */
export type HostSetBadgeResult =
  | { applied: true }
  | { applied: false; reason: string };

/** HostEdges — core 侧唯一可见的宿主边沿契约。零消费者的 notifyClicked /
 *  resolveResource 故意不在契约内（不可达死面无法锁步）；未实现成员不得被
 *  core/main 调用（Pick 收窄在编译期保证）。 */
export interface HostEdges {
  /** 主窗口渲染器 push 叶：channel 为 opaque 通道名，payload 为非秘密投影；
   *  返回 false = 当前无存活主窗，调用侧自行折算失败语义。 */
  rendererPush(channel: string, payload: unknown): boolean
  // —— 原生显示/系统集成 ——
  /** 构造并显示原生通知（对象登记/淘汰全在实现侧私有）。clickRoute 携带 click
   *  回灌路由（null = 'test' 通知，原生 click 只恢复窗口）；有路由时宿主先
   *  restore/focus/重建主窗，成功后才回调 onActivated（core 侧再验来源代际）。
   *  shown 暴露 honest-show 结算（NOTIFY 返回值与 claim 释放依赖它）；dispose
   *  注销 click 回执。实现侧绝不 throw——构造/登记/监听失败一律结算 shown:false。
   *  macOS 授权无查询/申请 API：OS 拒绝与限时无回执如实映成带原因的 shown:false，
   *  绝不冒充「已授权但普通失败」。 */
  showNativeNotification(
    spec: NativeNotificationSpec,
    clickRoute: { token: NotificationSourceToken; onActivated(): void } | null,
  ): { dispose(): void; shown: Promise<{ shown: true } | { shown: false; error: string }> }
  /** Notification.isSupported 平台探测（实现侧保证不 throw）。 */
  notificationSupported(): boolean
  /** 未读徽标 apply 叶（平台门与 badgeEnabled 裁决留 core 的 badge.ts：先
   *  badgePlatformGate 裁决，supported 后才调用本叶）；实现侧绝不 throw。 */
  setBadge(count: number): HostSetBadgeResult
  /** app.setBadgeCount API 可用性事实（平台原因由 core 平台门区分）。 */
  badgeCountApiAvailable(): boolean
  /** 托盘可用性（恢复入口判定）。 */
  trayAvailable(): boolean
  /** keep-awake：powerSaveBlocker prevent-app-suspension 的 start/stop（blocker id 属宿主态）。 */
  setKeepAwake(on: boolean): void
  /** 系统 resume 事件订阅（held-resume 补发点在 core）。 */
  onSystemResume(cb: (timestamp: number) => void): void
  /** 主窗口 'show' 事件订阅（held-resume/通知补发点）。 */
  onMainWindowShown(cb: () => void): void
  /** 任一窗口是否聚焦（通知裁决的焦点事实）。 */
  isFocused(): boolean
  /** 通知 click 激活腿：restore+focus，无窗则重建，完成后 resolve。 */
  focusMainWindow(): Promise<void>
  /** 渲染器可用性门：webContents 是否仍在加载（无主窗/已销毁视同加载中）。 */
  webViewLoading(): boolean
  /** 渲染器可用性门：webContents 是否存活（非 crashed/destroyed）。 */
  webViewContentAlive(): boolean
  /** 主窗口存在性门：win!=null 且未销毁——隐藏到托盘的窗口仍为 true。
   *  rendererPush 返回 false 与 mainWindowAlive() 为 false 语义等价。 */
  mainWindowAlive(): boolean
  /** 来源退役驱逐：关闭并注销 sourceId ∈ retiredSourceIds 的活跃原生通知
   *  （click 回执随对象消亡），返回驱逐数。 */
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  // —— 打开/拉起 ——
  /** shell.openExternal 叶（URL 白名单/预算/冷却/规范化留 core）。 */
  openExternal(url: string): Promise<void>
  /** shell.openPath 叶（打开本地路径，失败 loud）。 */
  openPath(p: string): Promise<void>
  /** shell.showItemInFolder 叶（Finder 揭示）。 */
  showItemInFolder(p: string): void
  /** open-in 原生拉起。 */
  launchApp(appId: string, path: string): Promise<boolean>
  // —— 对话框 ——
  /** 插件源一体化 picker（folder|.tgz）。 */
  pickPluginSource(): Promise<HostPluginSourcePick>
  /** dialog.showErrorBox 包装。 */
  showError(title: string, detail: string): void
  /** dialog.showMessageBox 包装：buttonId 收敛为 number（response）。 */
  showMessage(opts: HostMessageOptions): Promise<number>
  // —— 系统/身份/资源 ——
  /** 登录项开关（setLoginItemSettings）。 */
  setLoginItem(enabled: boolean): void
  /** app.isPackaged 能力位（B1）。 */
  isPackaged: boolean
}

// Renderer delivery state machines：队列/ready 位/来源代际/held resume/badge
// holder 是 core 业务状态（「状态一律参数化」的例外），装配侧 glue/IPC 与
// installIpcHandlers 共享同一实例。单装配不变式：installIpcHandlers 每进程恰一次、
// 先于任何窗口/渲染器事件（whenReady 内、createMainWindow 之前），装配时快照
// deliveryEdges 与 quit 门。send 叶一律 edges.rendererPush、窗口事实一律 edges 门。
// - 两条 ACK 队列（深链 64 条 / 通知打开）retain-until-ACK：ready 位只在投递失败
//   时复位，失败项 rollback 后等下一次握手重发；drain 触发点锚定当前主窗，
//   mid-drain 同步拆除竞态由逐项 edges 门复检兜住。
// - 来源代际：移除或传输身份编辑推进代际，旧 click/held opens 不跨同 id 替换；
//   退役时清队列并驱逐原生通知；held lastResume 在窗口 show 后一次性补发并清空。
// - badge holder：平台门在 core 裁决，quit 兜底清除，loud 日志各压成一次。

/** 投递状态机实际使用的 HostEdges 子集（装配时自 deps.edges 快照）。 */
type DeliveryEdgeSet = Pick<
  HostEdges,
  'rendererPush' | 'mainWindowAlive' | 'webViewLoading' | 'webViewContentAlive'
>;

let deliveryEdges: DeliveryEdgeSet | null = null;
/** quit 在途门（装配侧 ctx.isQuitting——入队/通知投递循环的 ignore 语义）。 */
let quittingLeaf: () => boolean = () => false;

// 来源生命周期权威：移除或传输身份编辑推进代际，原生 click 闭包与 held opens 无法跨同 id 替换。
const notificationSourceIncarnations = new NotificationSourceIncarnations();
// 来源证明 sidecar（非秘密投影；presentation/service/home 编辑后存活，退役轮换）。
const notificationSourceProofs = new NotificationSourceProofs();

// 通知打开队列照搬 pendingIntents 的队列+drain 模式：点击时窗口可能正在重建/加载，事件不能丢。
const pendingNotificationOpens = new BoundedAckDeliveryQueue<NotificationOpenIntent>(MAX_PENDING_NOTIFICATION_OPENS);
let notificationOpenDrainReady = false;
let drainingNotificationOpens = false;

// VS Code 启动与 renderer 来源激活是两条独立链：前者不等待 UI，后者必须等
// deep-link-ready 握手。加载/崩溃会复位 ready；成功 intent 在有界队列 hold/replay，
// 绝不发给 about:blank 或尚未订阅的 renderer。
type RendererVscodeIntent = VscodeLaunchRequest & {
  sourceId: string
  sourceFingerprint: string
  sourceGeneration: number
}
const pendingRendererIntents = new BoundedAckDeliveryQueue<RendererVscodeIntent>(
  64,
  intent => BoundedVscodeIntentQueue.key(intent),
);
let deepLinkRendererReady = false;
let drainingRendererDeepLinkIntents = false;

// 最近一次 OS 唤醒时间戳：无窗口常驻期间 held，窗口 show 时一次性补发（push 成功后清空）。
let lastResume: number | null = null;

// 未读徽标：core 持「最近一次意图」并按当前设置裁决（badgeEnabled 关闭 → 强制 0
// 清除；重新开启 → reconcileBadgeCount 恢复）。quit 在途兜底清除；平台不支持与持续
// 抛错的 loud 日志各压成一次，防重复推送刷屏。
let pendingBadgeCount: number | null = null;
let badgeUnsupportedLogged = false;
let badgeApplyErrorLogged = false;

/** shell-ipc-settings.ts 经 ctx.state 读写这三个模块级 let（单一权威；解构拷贝会使就绪位失联）。 */
const shellMutableState = {
  get notificationOpenDrainReady(): boolean { return notificationOpenDrainReady },
  set notificationOpenDrainReady(value: boolean) { notificationOpenDrainReady = value },
  get deepLinkRendererReady(): boolean { return deepLinkRendererReady },
  set deepLinkRendererReady(value: boolean) { deepLinkRendererReady = value },
  get pendingBadgeCount(): number | null { return pendingBadgeCount },
  set pendingBadgeCount(value: number | null) { pendingBadgeCount = value },
};


/** 全局原生通知发送限速（含 kind:'test'，与 claim 同款有界滑动窗口）。 */
const nativeNotificationRateLimiter = new BoundedRateLimiter();

/** SYSTEM_RESUME 推送叶：rendererPush 返回 false = 无存活主窗，折算为 push 失败
 *  并 loud；无窗口常驻期间由 show 补发兜底。 */
function pushHeldSystemResume(timestamp: number): boolean {
  const edges = deliveryEdges;
  if (edges === null) return false;
  const pushed = attemptCommittedRegistryPush(() => {
    if (!edges.rendererPush(IPC_CHANNELS.SYSTEM_RESUME, { timestamp })) {
      throw new Error('system-resume renderer push failed');
    }
  });
  if (!pushed.sent) {
    try { console.warn(`[dsh-chamber] system-resume push 失败，保留待重试：${pushed.error}`); } catch { /* best effort */ }
  }
  return pushed.sent;
}

/** OS 唤醒：held 最近一次时间戳；窗口存活已即时收到则立即推送并清空 held（避免 hide→show 补发过期事件）。 */
function handleSystemResume(timestamp: number): void {
  lastResume = timestamp;
  const heldResume = lastResume;
  const edges = deliveryEdges;
  if (heldResume !== null && edges !== null && edges.mainWindowAlive() && pushHeldSystemResume(heldResume)) {
    if (lastResume === heldResume) lastResume = null;
  }
}

/** 主窗口 'show' 补发点：无窗口常驻期间的唤醒事件在窗口恢复可见时一次性补发。 */
function handleMainWindowShown(): void {
  const heldResume = lastResume;
  if (heldResume !== null && pushHeldSystemResume(heldResume)) {
    if (lastResume === heldResume) lastResume = null;
  }
}

/** 通知点击入队：quit 在途 ignore；来源代际校验（旧代际 click 不回灌新 shell）；
 *  入队后立即 drain；有界队列超限丢弃最旧，绝不无限增长。 */
function enqueueNotificationOpen(sourceToken: NotificationSourceToken, sessionId: string): void {
  if (quittingLeaf()) return;
  if (!notificationSourceIncarnations.owns(sourceToken)) return;
  const { sourceId, fingerprint: sourceFingerprint, generation: sourceGeneration } = sourceToken;
  const queued = pendingNotificationOpens.enqueue({ sourceId, sourceFingerprint, sessionId, sourceGeneration });
  if (!queued.accepted) {
    console.warn(`[dsh-chamber] 通知打开队列容量全部被未确认事件占用，拒绝新事件：${sourceId}/${sessionId}`);
    return;
  }
  if (queued.dropped !== null) {
    console.warn(`[dsh-chamber] 通知打开队列已满，丢弃最旧待发事件：${queued.dropped.sourceId}/${queued.dropped.sessionId}`);
  }
  drainPendingNotificationOpens();
}

/** 通知打开事件 drain（retain-until-ACK）：窗口存在、加载完成且 ready 位已置 → 推送；
 *  否则重新 hold 等 did-finish-load/ready。send 只转 in-flight，renderer 精确 ACK
 *  deliveryId+attempt 后才消费；reload/crash 重发所有未 ACK 项。 */
function drainPendingNotificationOpens(): boolean {
  const edges = deliveryEdges;
  if (edges === null) return true;
  if (drainingNotificationOpens) return true;
  if (
    !notificationOpenDrainReady
    || !edges.mainWindowAlive()
    || edges.webViewLoading()
    || !edges.webViewContentAlive()
  ) return true;
  drainingNotificationOpens = true;
  try {
    for (;;) {
      if (quittingLeaf()) return true;
      const delivery = pendingNotificationOpens.shift();
      if (delivery === null) return true;
      try {
        // 逐项复检：Electron 可在 send 跨原生边界时同步拆除/替换窗口。
        if (
          !edges.mainWindowAlive()
          || edges.webViewLoading()
          || !edges.webViewContentAlive()
        ) throw new Error('notification renderer changed while draining');
        if (!edges.rendererPush(IPC_CHANNELS.NOTIFICATION_OPEN, {
          sourceId: delivery.payload.sourceId,
          sourceFingerprint: delivery.payload.sourceFingerprint,
          sessionId: delivery.payload.sessionId,
          deliveryId: delivery.deliveryId,
          attempt: delivery.attempt,
        })) {
          throw new Error('notification renderer push failed');
        }
        // Deliberately retain in-flight ownership until renderer ACK.
      } catch (error) {
        const restored = pendingNotificationOpens.rollback(delivery);
        if (!restored) {
          console.error(`[dsh-chamber] 通知打开事件回滚失败：delivery=${delivery.deliveryId}`);
        }
        // 只有 send 失败的窗口失去握手——单窗接缝下即当前主窗，无条件复位安全。
        notificationOpenDrainReady = false;
        console.error('[dsh-chamber] 通知打开推送失败，等待 renderer 重试：', describeUnknownError(error));
        return false;
      }
    }
  } finally {
    drainingNotificationOpens = false;
  }
}

/** 深链 renderer 队列 drain：窗口存活、加载完成、未崩溃且 ready 位已置 → 顺序
 *  推送；否则 hold。mid-drain 变更/失败 → rollback 保留 + ready 复位（renderer
 *  有界重试重建握手）。 */
function drainPendingRendererDeepLinkIntents(): boolean {
  const edges = deliveryEdges;
  if (edges === null) return true;
  if (drainingRendererDeepLinkIntents) return true;
  // 窗口身份折算：触发点全部锚定当前主窗（currentWindow 恒 true），destroyed/loading/crashed 折算为 edges 三门的取反。
  if (
    !canDeliverRendererDeepLink({
      ready: deepLinkRendererReady,
      currentWindow: true,
      destroyed: !edges.mainWindowAlive(),
      loading: edges.webViewLoading(),
      crashed: !edges.webViewContentAlive(),
    })
  ) return true;

  drainingRendererDeepLinkIntents = true;
  try {
    for (;;) {
      const delivery = pendingRendererIntents.shift();
      if (delivery === null) return true;
      const intent = delivery.payload;
      try {
        // 逐项复检：Electron 可在 send 跨界时同步拆除/替换窗口。
        if (
          !edges.mainWindowAlive()
          || edges.webViewLoading()
          || !edges.webViewContentAlive()
        ) {
          throw new Error('deep-link renderer changed while draining');
        }
        if (!edges.rendererPush(IPC_CHANNELS.DEEP_LINK_INTENT, {
          instanceId: intent.instanceId,
          path: intent.path,
          sourceFingerprint: intent.sourceFingerprint,
          deliveryId: delivery.deliveryId,
          attempt: delivery.attempt,
        })) {
          throw new Error('deep-link renderer push failed');
        }
      } catch (error) {
        // Preserve the failed item for the next renderer handshake instead of
        // converting a transient send race into a lost/reordered activation.
        if (!pendingRendererIntents.rollback(delivery)) {
          console.error(`[dsh-chamber] renderer 深链 intent 回滚失败：${intent.instanceId}`);
        }
        deepLinkRendererReady = false;
        console.error('[dsh-chamber] 深链 intent 推送失败，等待 renderer 重试：', describeUnknownError(error));
        return false;
      }
    }
  } finally {
    drainingRendererDeepLinkIntents = false;
  }
}

/** 深链 renderer 入队（hold/replay；main.ts 的 open-in IPC 与深链消费循环调用）。 */
export function enqueueRendererDeepLinkIntent(intent: VscodeLaunchRequest, sourceToken: NotificationSourceToken): void {
  if (!notificationSourceIncarnations.owns(sourceToken)) return;
  const queued = pendingRendererIntents.enqueue({
    ...intent,
    sourceId: sourceToken.sourceId,
    sourceFingerprint: sourceToken.fingerprint,
    sourceGeneration: sourceToken.generation,
  });
  if (!queued.accepted) {
    if (queued.reason === 'saturated') {
      console.warn(`[dsh-chamber] renderer 深链队列容量全部被在途 intent 占用，拒绝新 intent：${intent.instanceId}`);
    }
    return;
  }
  if (queued.dropped !== null) {
    console.warn(`[dsh-chamber] renderer 深链队列已满，丢弃最旧 intent：${queued.dropped.instanceId}`);
  }
  drainPendingRendererDeepLinkIntents();
}

/** 渲染器生命周期事件：各处 glue 先做 mainWindow===win 身份守卫，仅当前主窗的
 *  事件到达本入口；'show' 走 edges.onMainWindowShown。 */
export type RendererLifecycleEvent = 'did-start-loading' | 'did-finish-load' | 'crashed' | 'closed';

/** ready 位挂钩收敛入口。复位点选 did-start-loading 而非 did-finish-load：慢子资源
 *  可让 finish 拖到 ready IPC 之后，finish 时重置会把已置位标志 clobber 成永久 false。 */
export function onRendererLifecycle(event: RendererLifecycleEvent): void {
  if (event === 'did-start-loading') {
    notificationOpenDrainReady = false;
    deepLinkRendererReady = false;
    pendingNotificationOpens.requeueInFlight();
    pendingRendererIntents.requeueInFlight();
    drainPendingNotificationOpens();
    return;
  }
  if (event === 'did-finish-load') {
    // ready() 可在慢子资源仍让 isLoading() 为 true 时运行；finish 是确定性重放边沿。
    // 补发 held resume：Swift 形态没有窗口 'show' 事件（mainWindowShown 只在
    // didBecomeActive 发），不补发会让即时重连退化成等 15–45s 看门狗；无滞留时为
    // no-op（幂等，Electron 同样受益）。
    handleMainWindowShown();
    drainPendingRendererDeepLinkIntents();
    drainPendingNotificationOpens();
    return;
  }
  // crashed / closed：就绪标志立即失效（崩溃到 reload 间无导航事件），in-flight 全部
  // 重排回待发（reload 后按 FIFO 重发，attempt 自增使旧 document 的迟到 ACK 失效）。
  notificationOpenDrainReady = false;
  deepLinkRendererReady = false;
  pendingNotificationOpens.requeueInFlight();
  pendingRendererIntents.requeueInFlight();
}

/** 来源代际捕获代理（main.ts 的 captureVscodeSource / 插件播种所有权沿用）。 */
export function captureNotificationSource(sourceId: string): NotificationSourceToken | null {
  return notificationSourceIncarnations.capture(sourceId);
}

/** 来源代际持有校验代理（open-in / 深链消费循环的所有权复查沿用）。 */
export function ownsNotificationSource(token: NotificationSourceToken): boolean {
  return notificationSourceIncarnations.owns(token);
}

/** 来源 fingerprint 匹配代理（open-in IPC 的入场校验沿用）。 */
export function matchesNotificationSource(sourceId: string, fingerprint: string): boolean {
  return notificationSourceIncarnations.matches(sourceId, fingerprint);
}

/** 注册表投影类型：TransportInstanceSpec + 非秘密来源证明（design 19 §3.3）。 */
export type ProjectedTransportInstanceSpec = TransportInstanceSpec & { sourceFingerprint: string }

/** 来源证明投影：证明在 presentation/service/home 编辑后存活，退役（删除/传输身份编辑）时轮换。 */
export function projectNotificationSourceInstances(
  instances: readonly TransportInstanceSpec[],
): ProjectedTransportInstanceSpec[] {
  return notificationSourceProofs.replaceRemoteInstances(instances);
}

// registry 读时非秘密投影链：凭据只以存在性布尔标记投影（写入口经 provider 模块，
// 值绝不回读进载荷或日志）；secretStorage 为存储模式投影。main.ts 的
// publishRegistryTransition 沿用本模块导出（core→main 单向依赖）。
export type ProjectedRegistryInstance = TransportInstanceSpec & {
  sshPasswordSet: boolean
  tokenSet: boolean
  passwordSet: boolean
  secretStorage: ReturnType<typeof gatewaySecretStorageMode>
  /** 非秘密投影：Electron flavor 以 safeStorage 写出的凭据本进程无法解密（文件
   *  原地保留，条目 fail closed），renderer 据此提示「跨 flavor 凭据不可读」。 */
  secretStorageUnreadable?: boolean
}

/** 单行凭据存在性投影：标记只在行当前使用的凭据维度上为 true（sshPasswordSet 仅 SSH 行）。 */
export function projectInstanceSecrets(instance: TransportInstanceSpec): ProjectedRegistryInstance {
  return {
    ...instance,
    sshPasswordSet: instance.transport === 'ssh' && getSshPassword(instance.id) !== null,
    tokenSet: instance.kind === 'gateway' && getGatewayToken(instance.id) !== null,
    passwordSet: instance.kind === 'gateway' && getGatewayPassword(instance.id) !== null,
    secretStorage: gatewaySecretStorageMode(),
    ...(gatewaySecretStorageCrossFlavorUnreadable() ? { secretStorageUnreadable: true as const } : {}),
  };
}

/** 注册表整表读时投影（instances_get / save / delete 返回路径）。 */
export function projectInstances(instances: readonly TransportInstanceSpec[]): ProjectedRegistryInstance[] {
  return projectNotificationSourceInstances(instances).map(projectInstanceSecrets);
}

/** 来源 registry 同步：replaceRemoteSources 后把退役 sourceId 的在途/待发事件从两条
 *  队列全部丢弃（同 id 替换绝不继承旧代际的 held 工作），返回退役 id 集合。 */
export function syncNotificationSourceRegistry(
  projected: readonly ProjectedTransportInstanceSpec[],
): string[] {
  const retired = notificationSourceIncarnations.replaceRemoteSources(
    projected.map(instance => ({
      sourceId: `${instance.kind}-${instance.id}`,
      fingerprint: instance.sourceFingerprint,
    })),
  );
  if (retired.length > 0) {
    const retiredIds = new Set(retired);
    pendingNotificationOpens.discardWhere(intent => retiredIds.has(intent.sourceId));
    pendingRendererIntents.discardWhere(intent => retiredIds.has(intent.sourceId));
  }
  return retired;
}

/** will-quit 兜底清除：退出在途不留 Dock 残留；曾有意图才触碰（避免无谓日志）。 */
export function clearBadgeIntentForQuit(applyNativeClear: () => void): void {
  if (pendingBadgeCount !== null) {
    try { applyNativeClear(); } catch { /* best-effort on the way out */ }
    pendingBadgeCount = null;
  }
}

// OS 深链启动队列 + 外链打开预算器（模块级业务状态）：有界 64 条 single-flight
// 启动队列；消费循环闭包在 installIpcHandlers 内装配（装配前到达的深链只入队，
// 装配后按触发消费），quit 门 = quittingLeaf。外链统一入口 openExternally：URL
// 规范化 + 10s/8 次预算 + 超限 30s 冷却（log-and-drop）；宿主叶 = 装配期快照的
// edges.openExternal（白名单/预算/冷却/规范化留 core，edge 只执行 open）。
const pendingIntents = new BoundedVscodeIntentQueue(64);
let drainingPendingIntents = false;
/** 消费循环装配槽：installIpcHandlers 装配后赋值；null = 未装配（只入队不消费）。 */
let drainPendingIntents: (() => void) | null = null;

/** 深链入队：quit 在途 ignore（不启动 VS Code）；目标 single-flight；解析失败 loud。 */
export function enqueueDeepLink(rawUrl: string): void {
  if (quittingLeaf()) return;
  const parsed = parseOpenVscodeIntent(rawUrl);
  if (!parsed.ok) {
    console.error(`[dsh-chamber] 深链解析失败：${parsed.error}`);
    return;
  }
  const queued = pendingIntents.enqueue(parsed.intent);
  if (!queued.accepted) {
    if (queued.reason === 'saturated') {
      console.warn(`[dsh-chamber] 深链启动队列容量全部被在途 intent 占用，拒绝新 intent：${parsed.intent.instanceId}`);
    }
    return;
  }
  if (queued.dropped !== null) {
    console.warn(`[dsh-chamber] 深链启动队列已满，丢弃最旧 intent：${queued.dropped.instanceId}`);
  }
  drainPendingIntents?.();
}

/** 启动尾部 drain 入口（装配就绪后顺序消费冷启动 intent；未装配时 no-op）。 */
export function drainDeepLinkLaunches(): void {
  drainPendingIntents?.();
}

// 外链打开速率限制：10s 窗口内最多 8 次，超限进入 30s 冷却（log-and-drop）；预算器只此一份。
const OPEN_EXTERNAL_BUDGET = 8;
const OPEN_EXTERNAL_WINDOW_MS = 10_000;
const OPEN_EXTERNAL_COOLDOWN_MS = 30_000;
const externalOpenTimes: number[] = [];
let externalOpenCooldownUntil = 0;
/** 宿主打开叶（装配期快照 deps.edges.openExternal；null = 未装配，静默跳过）。 */
let externalOpenLeaf: ((url: string) => Promise<void>) | null = null;

/**
 * 打开外链的统一入口：以规范化后的 href 交给宿主打开叶（避免 raw 字符串中
 * Chromium 已剥离而 OS 层未剥离的空白/换行差异），失败 loud 记录、绝不抛出；
 * 超预算时静默丢弃并冷却。
 */
export function openExternally(url: string): void {
  let normalized: string;
  try {
    normalized = new URL(url).href;
  } catch {
    return;
  }
  const now = Date.now();
  if (now < externalOpenCooldownUntil) return;
  const recent = externalOpenTimes.filter((t) => now - t < OPEN_EXTERNAL_WINDOW_MS);
  if (recent.length >= OPEN_EXTERNAL_BUDGET) {
    externalOpenCooldownUntil = now + OPEN_EXTERNAL_COOLDOWN_MS;
    console.warn('[dsh-chamber] 外部链接打开过于频繁，30s 内暂停（疑似脚本 spam）');
    return;
  }
  externalOpenTimes.length = 0;
  externalOpenTimes.push(...recent, now);
  const leaf = externalOpenLeaf;
  if (leaf === null) return;
  void leaf(normalized).catch((error) => {
    console.error('[dsh-chamber] 打开外部链接失败：', describeUnknownError(error));
  });
}

// runtime check cycle 槽：installIpcHandlers ② J 组段赋值（装配先于任何计时器 tick）。
// main 侧首检/周期计时器与 RUNTIME_CHECK 注册体经同一实现与门；未装配时静默 no-op。
let runtimeCheckRunner: (() => void) | null = null;

/** 触发一次 idle-gated runtime 检查（周期路径与 RUNTIME_CHECK 注册体共用同一实现）。 */
export function runRuntimeCheckCycle(): void {
  const runner = runtimeCheckRunner;
  if (runner !== null) runner();
}

// Shell IPC 注册点：installIpcHandlers 是 shell-core 唯一注册处，main 只做装配
// （trustedIpc 围栏在注入的 registrar 包装处）。注册顺序 = 函数内调用顺序：A/B 为
// 设置、通知与深链握手，C–F 为 SSH/registry 与插件面，G/H 为 gateway/本地插件，
// I 为 open-in/update，J/K 为 runtime。Electron 叶一律替换为注入 seam
// （ctx / edges / settingsIO），逐步骤注记见各段注释。

/** IPC 注册面（channel 为 opaque 通道名）：Electron 侧装配为
 *  (ch, h) => ipcMain.handle(ch, trustedIpc(h))，Swift sidecar 注入同形 B 桥注册。 */
export interface IpcRegistrar {
  handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown): void
}

/** ssh 插件管理目标：spec（registry id + remoteDshHome）+ operational fingerprint
 *  （id 稳定编辑推进）+ 来源代际 token（F 组 owns 复验）。 */
export interface SshPluginTarget {
  spec: RemoteSpec
  fingerprint: string
  sourceToken: NotificationSourceToken
}

/** 元数据恢复可恢复状态联合（ctx 签名用；与 main.ts 局部类型同构）。 */
type RecoverableMetadataStatus = 'selection-corrupt' | 'recovery-in-progress' | 'recovery-marker-corrupt'

/** ShellAssemblyCtx — installIpcHandlers 装配上下文（只放注册体实际引用的字段）。
 *  宿主生命周期权威在 main 侧；core 不持有事务状态，各叶与同名 HostEdges 成员同语义。 */
export interface ShellAssemblyCtx {
  /** INFO 载荷与 settings 平台投影的宿主事实。 */
  hostFacts: {
    /** 壳 flavor：'electron' | 'swift'——INFO 透传，renderer 据此分派宿主机制语义。 */
    flavor: 'electron' | 'swift'
    /** 控制面 URL（INFO 载荷的 `http://127.0.0.1:${cp.port}`）。 */
    controlPlaneUrl: string
    /** 运行平台（BADGE_COUNT 平台门第一参同源）。 */
    platform: NodeJS.Platform
    /** 托盘恢复面存在性（invoke 时求值：托盘在装配后才创建，不得装配期定格）。 */
    trayPresent(): boolean
  }
  /** INFO.dshVersion 的 dsh 运行事实（可选：未提供时 INFO 返回 null）。 */
  runtimeFacts?: {
    /** 当前活动 dsh 运行时版本——invoke 时求值，绝不返回装配期定格值。 */
    dshVersion(): string | null
  }
  /** chamber settings 状态与持久化 IO（装配侧注入，<userData> 路径已绑定）。 */
  settingsIO: {
    /** 当前内存 holder 值（设置权威 = 装配侧内存 holder）。 */
    current(): ChamberSettings
    /** 原子替换内存 holder（applySettingsPatch 全链成功尾部调用）。 */
    commit(next: ChamberSettings): void
    /** 持久化到 <userData>/chamber-settings.json（atomic 0600）；失败 throw，由 applySettingsPatch 回滚已应用副作用。 */
    persist(next: ChamberSettings): void
  }
  /** quit 在途门：入队 ignore 语义与通知投递循环的退出检查经它求值。 */
  isQuitting(): boolean
  /** keep-awake 副作用叶；失败 throw，由 applySettingsPatch 的 catch 做 best-effort
   *  回滚。返回 void | Promise<void>（双 flavor 兼容：同步 throw 与异步 reject 同汇于
   *  同一条回滚路径）。 */
  setKeepAwake(enabled: boolean): void | Promise<void>
  /** 登录自启副作用叶：返回 {ok}|{ok:false,error} 或其 Promise（Electron 同步、
   *  Swift await B 桥；失败绝不 throw，两 flavor 同一形状）。 */
  setLoginItem(
    enabled: boolean,
  ):
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>
  /** registryOrigin 切换确认叶：'confirmed' 放行；'cancelled' 用户取消；
   *  'unavailable' = 无存活主窗。 */
  confirmRegistryOriginSwitch(
    currentOrigin: string,
    nextOrigin: string,
  ): Promise<'confirmed' | 'cancelled' | 'unavailable'>
  // C/D/E/F 组装配依赖：transportManager 现实例注入（Pick 收窄到实际方法面）；
  // audit / gatewaySessions / publishRegistryTransition 与 F 组现实例/闭包族的定义在
  // main 装配侧——自动 seed/撤销路径与注册体共用同一实例，语义不分叉。
  /** registry 读写 + transport 状态/生命周期投影（C/D/E/F 组直接读写面；Pick 收窄到
   *  实际调用的方法；体内以 sm 名解构）。 */
  transportManager: Pick<
    TransportManager,
    | 'listInstances'
    | 'saveInstances'
    | 'status'
    | 'readyUrl'
    | 'disconnect'
    | 'connect'
    | 'reverify'
    | 'logs'
    | 'clearLogs'
    | 'exec'
    | 'appendLog'
  >
  /** 非秘密审计叶（JSONL append；凭据值绝不入日志）。 */
  audit(event: AuditEvent): void
  /** gateway 密码会话管理器（主进程内存持有；C 组 invalidation 直接面）。装配侧传
   *  装配期取值：该 let 仅在 will-quit 清理置 null（届时窗口已关、IPC 不可达），
   *  处理器可达期恒非空。 */
  gatewaySessions: GatewaySessionManager | null
  /** registry 变更生命周期权威 sidecar（来源证明/代际同步 + 插件 seed/journal 撤销
   *  + 通知退役驱逐 + SSH_INSTANCES_CHANGED push——push 文本被 renderer-trust 锚定）。
   *  C 组 save/delete 经它发布 committed 结果。 */
  publishRegistryTransition(
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ): ProjectedRegistryInstance[]
  // F 组装配依赖：编排纯模块在 core 直接 import；下列共享现实例/闭包为 main 装配侧
  // 所有物（journal 单写者、seed 单飞、目标指纹同一实现）。
  /** 权威本地 dsh home 路径（装配期解析注入；core 不碰 Electron paths，与自动路径同一值）。 */
  localDshHome: string
  /** ssh 插件 undo journal 现实例：main 的撤销清理与 F 组 undo/apply 共享；record 永不 throw。 */
  sshPluginJournal: SshPluginJournal
  /** chamber host 包种子数组（sourceDir 已解析；自动与手动 seed 共用同一数组）。 */
  chamberHostPackageSeeds: readonly ChamberHostPackageSeed[]
  /** host 包 seed 单飞注册表现实例：自动与手动 seed 跨路径并发单飞语义不变。 */
  hostPackageSeeding: ExactOwnershipRegistry
  /** ssh 插件目标解析/所有权/执行/探针闭包束（自动 seed 与 ready 边缘共用同一族）。 */
  sshPluginTargets: {
    findRemoteTarget(id: string): SshPluginTarget | null
    ownsRemoteTarget(target: SshPluginTarget): boolean
    scopedExecForTarget(target: SshPluginTarget, extraOwner?: () => boolean): ExecFn
    scopedStatusForTarget(target: SshPluginTarget): StatusFn
    scopedProbeForTarget(
      target: SshPluginTarget,
      probe: (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>,
    ): (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>
    liveProbeFor(id: string): (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>
  }
  // G 组装配依赖：编排纯模块在 core 直接 import；注册参数读取与 ready 位复验在
  // 注册体侧；确认对话框/窗口预检/插件源 pick 走 edges。
  /** 手动 gateway_plugin_sync 的上传执行闭包（ready 自动 sync 与手动 re-entry 共用
   *  同一路径与注册参数）；无实例/非 gateway → null；本地包源解析在闭包内。 */
  syncGatewayChamberPluginsFor(
    id: string,
    url: string,
    headers: Record<string, string>,
    spkiPin: string | null,
  ): Promise<{ uploaded: boolean; skipped: boolean; failed?: boolean; error?: string } | null>
  // H 组装配依赖：编排纯模块在 core 直接 import；本叶只承载宿主编排，本体在 main
  // 装配侧（runtime writer fence 租约 + 启动门属装配侧事务状态）。workspace 只在
  // fence 租约内解析，绝不跨运行时 swap 保留。
  runLocalPluginMutation<T>(
    owner: string,
    mutate: (dshWorkspace: string) => Promise<T>,
  ): Promise<T | { ok: false; error: string }>
  // I 组装配依赖：open-in 面经 wiredCtx/openInCtx 的既有面（hostFacts/settingsIO/
  // transportManager/edges）；update 面经 updater 现实例（main 装配侧构造，UPDATE_*
  // 与状态 push 订阅共用）。装配侧在 installIpcHandlers 之后调 updater.start()，
  // 保持「先订阅后 start」序。
  updateController: UpdateController
  // J 组装配依赖：控制器/fence/动作门/宿主叶全部由 main 装配侧定义并经 ctx 注入；
  // K 组注册体与启动/证据路径共用同一实例/闭包（状态权威单一、单飞语义不分叉）。
  /** DshRuntimeController 现实例（main 装配侧构造；K 组与启动/证据路径共用，状态权威单一）。 */
  runtimeController: DshRuntimeController
  /** runtime 事务槽在飞读门（槽位本体与单写者归 main；core 只经本叶做 busy 布尔读，
   *  注册体中 `runtimeOperation !== null` 替换为 runtimeOperationBusy()）。 */
  runtimeOperationBusy(): boolean
  /** runtime writer fence 现实例（与启动事务共用；busy/tryAcquire 与调用点同一实例，
   *  跨 core/main 串行化语义不分叉，owner 名逐字一致）。 */
  runtimeWriterFence: Pick<RuntimeOperationFence, 'busy' | 'tryAcquire'>
  /** runtime 动作终态门（K 组注册体同用；action = 共享核 RuntimeAction 联合）。 */
  runtimeActionAllowed(action: RuntimeAction): boolean
  /** 权威 runtime base dir（装配期解析注入；纯 store 函数经它与 main 侧同一 baseDir 调用）。 */
  runtimeBaseDir: string
  /** 磁盘/快照/失败证据刷新叶（coalescer 等宿主状态归装配侧；K 组与启动路径同一实现）。 */
  refreshRuntimeEvidence(patch?: RuntimeLifecycleProjection): Promise<void>
  /** pnpm store prune 叶（单飞宿主状态归装配侧；清理路径与启动尾部共用）。 */
  runStorePruneIfNeeded(): Promise<void>
  /** 事务性 dsh 重启宿主叶：controlPlane 未初始化 → throw（同文案）；resolve ≠ success
   *  时 core 注册体按返回的 connectionState 白名单诚实拒绝。 */
  restartLocalDsh(): Promise<string>
  // K 组装配依赖：启动事务本体与共享闭包族全部在 main 装配侧（K 组与启动/证据
  // 路径共用同一实现、同一事务槽与 gate/fence；装配侧事务状态绝不进 core）。
  // dsh-runtime 纯逻辑与 evaluateApplyNowGate 直接 import。
  /** 运行时启动事务宿主叶（gate/fence/事务槽/abort 管理归装配侧；槽忙 → 返回在飞守卫）。 */
  runRuntimeStartup(): Promise<StartupResult | null>
  /** 启动阻塞发布叶（setRuntimeGate(true) + refreshRuntimeEvidence；reason 经 sanitizeErrorText 归一）。 */
  publishBlockedStartup(reason: string, patch?: RuntimeLifecycleProjection): Promise<void>
  /** 宿主启动门写叶（模块级 runtimeStartBlocked 槽与 cp.refreshLocalExposure 归装配侧）。 */
  setRuntimeGate(blocked: boolean, reason?: string | null): void
  /** 元数据恢复资格投影叶（quit/写进程安全/writers quiescent/bundled 版本等宿主事实归
   *  装配侧）；'incomplete' 为永久恢复终态，'half' 为瞬时可重试。 */
  authoritativeMetadataRecoveryStatus(): RecoverableMetadataStatus | null
  /** 用户触发元数据恢复事务宿主叶；返回 null = 资格不符/已在飞（注册体原样返回当前 state）。 */
  runUserMetadataRecovery(
    expectedStatus: RecoverableMetadataStatus,
  ): Promise<StartupResult | null> | null
  /** APPLY_NOW 门输入构造叶（controlPlane connectionState/envOverrideActive/事务槽等宿主读在叶内）。 */
  readApplyNowGateInput(): ApplyNowGateInput
  /** activation journal intent 选择（启动路径与 K 组 RETRY_APPLY 共用；core 只消费 targetVersion 投影）。 */
  selectedJournalIntent(state: ActivationJournalState): { targetVersion: string | null } | null
  /** 本机 dsh 宿主停止叶（cp.stopLocal()；RESTORE_PRE_ROLLBACK 与启动事务内部同源）。 */
  stopLocalDsh(): Promise<void>
  /** runtime 事务槽（槽本体与单写者归装配侧）：begin 登记在飞事务，end 清槽
   *  （finally），inFlight 读在飞 promise（RESET_BUILTIN 需 await 在飞 applying 后再启动）。 */
  runtimeOperationSlot: {
    begin(operation: Promise<StartupResult | null>): void
    end(): void
    inFlight(): Promise<StartupResult | null> | null
  }
  /** 内建 dsh 版本（装配期快照；core 不自行解析内置 workspace）。 */
  bundledRuntimeVersion: string | null
  // —— 插件受保护集合判定与更新退出腿字段 ——
  /** 内建 dsh 工作区路径（装配期解析；活动树解析第二参，core 不自行解析路径）。 */
  builtinDshWorkspacePath: string | null
  /** 运行时线锚锁文件路径叶（装配侧解析 vendor/dsh/pnpm-lock.yaml；读不到返回 null，
   *  core 退到活动树自己的锁文件）。 */
  pinnedRuntimeLockfilePath(): string | null
  /** 更新退出腿武装的回撤叶（可选；Electron 提供真叶，Swift flavor 从不武装）。
   *  I 组订阅在武装期间收到重启失败或相位离开 downloaded 时调用；叶自身幂等。 */
  disarmUpdaterQuit?(reason: string): void
}

/** 装配 shell IPC 面（A–K 组；各组顺序为注册顺序）。edges 以 Pick 收窄；调用点
 *  纪律：whenReady 内、createMainWindow 之前，本函数同时完成投递状态机的
 *  edges/quit 快照。 */
/** 域注册体的上下文：deps + 它们闭包共享的本地助手/模块状态。晚定义的助手以 getter
 *  暴露，保持单一构造点（无构建期前向引用）。 */
export interface ShellIpcCtx {
  deps: Parameters<typeof installIpcHandlers>[0];
  MACOS_NOTIFICATION_SETTINGS_URL: typeof MACOS_NOTIFICATION_SETTINGS_URL;
  NPM_SEARCH_MAX_BODY_BYTES: typeof NPM_SEARCH_MAX_BODY_BYTES;
  applyBadgePresentation: (count: number) => boolean;
  applySettingsPatch: (patch: Partial<ChamberSettings>) => Promise<{ ok: true } | { ok: false; error: string }>;
  captureVscodeSource: (instanceId: string) => NotificationSourceToken | null;
  chamberSettingsStatus: () => ChamberSettingsStatus;
  confirmPluginAction: (copy: { message: string; detail: string }) => Promise<{ ok: true } | { ok: false; error: string } | { cancelled: true }>;
  confirmRuntimeMutation: (message: string, detail: string, confirmLabel: string) => Promise<boolean>;
  deepLinkRendererReady: typeof deepLinkRendererReady;
  drainPendingNotificationOpens: typeof drainPendingNotificationOpens;
  drainPendingRendererDeepLinkIntents: typeof drainPendingRendererDeepLinkIntents;
  enqueueNotificationOpen: typeof enqueueNotificationOpen;
  enqueueRendererDeepLinkIntent: typeof enqueueRendererDeepLinkIntent;
  localProtectionFacts: () => PluginProtectionFacts;
  matchesNotificationSource: typeof matchesNotificationSource;
  nativeNotificationRateLimiter: typeof nativeNotificationRateLimiter;
  notificationOpenDrainReady: typeof notificationOpenDrainReady;
  notificationSourceIncarnations: typeof notificationSourceIncarnations;
  openInCtx: OpenInLaunchContext;
  ownsNotificationSource: typeof ownsNotificationSource;
  pendingBadgeCount: typeof pendingBadgeCount;
  pendingNotificationOpens: typeof pendingNotificationOpens;
  pendingRendererIntents: typeof pendingRendererIntents;
  projectInstances: typeof projectInstances;
  pushSettingsChanged: () => void;
  quittingLeaf: () => boolean;
  reconcileBadgeCount: () => void;
  runRuntimeCheck: () => Promise<ReturnType<DshRuntimeController['getState']>>;
  verifyLocalProfileFamily: (facts: PluginProtectionFacts) => { ok: true } | { ok: false; error: string };
  portableHostSeeds: () => readonly ChamberHostPackageSeed[];
  version: typeof version;
  state: typeof shellMutableState;
}
export function installIpcHandlers(deps: {
  ipc: IpcRegistrar
  edges: Pick<
    HostEdges,
    | 'rendererPush'
    | 'showNativeNotification'
    | 'notificationSupported'
    | 'setBadge'
    | 'badgeCountApiAvailable'
    | 'isFocused'
    | 'onSystemResume'
    | 'onMainWindowShown'
    | 'mainWindowAlive'
    | 'webViewLoading'
    | 'webViewContentAlive'
    | 'showMessage'
    | 'pickPluginSource'
    | 'openExternal'
    | 'openPath'
    | 'showItemInFolder'
    | 'showError'
  >
  ctx: ShellAssemblyCtx
}): void {
  // 单装配不变式：快照投递 edges 子集与 quit 门（本函数先于任何窗口/渲染器事件执行）。
  deliveryEdges = {
    rendererPush: deps.edges.rendererPush,
    mainWindowAlive: deps.edges.mainWindowAlive,
    webViewLoading: deps.edges.webViewLoading,
    webViewContentAlive: deps.edges.webViewContentAlive,
  };
  quittingLeaf = deps.ctx.isQuitting;
  // 外链打开宿主叶快照（规范化/预算/冷却留 core，edge 只执行 open）。
  externalOpenLeaf = deps.edges.openExternal;
  const {
    hostFacts,
    settingsIO,
    setKeepAwake,
    setLoginItem,
    // transportManager → sm（与 main 的 sm 同名，C–F 组共用）；updater/runtimeInstance
    // 为 ctx → 本地语义改名，注册体以原名调用。audit / gatewaySessions /
    // publishRegistryTransition 为装配侧宿主叶。F/H/G/I/J/K 组字段语义见 ShellAssemblyCtx
    // 与各字段注释；K 组共享闭包与事务槽的替换规则见 K 组段注释。
    transportManager: sm,
    localDshHome,
    chamberHostPackageSeeds,
    runtimeController: runtimeInstance,
    runtimeOperationBusy,
    runtimeWriterFence,
    runtimeActionAllowed,
    runtimeBaseDir,
    bundledRuntimeVersion: bundledVersion,
    // 插件受保护集合判定的 F 事实源叶与更新退出腿回撤叶（见 ShellAssemblyCtx 字段注释）。
    builtinDshWorkspacePath,
    pinnedRuntimeLockfilePath,
  } = deps.ctx

  // ① edges 回灌订阅段：OS 唤醒与主窗口 'show' 的订阅单点（held resume 在 core）。
  deps.edges.onSystemResume((timestamp) => {
    handleSystemResume(timestamp);
  });
  deps.edges.onMainWindowShown(() => {
    handleMainWindowShown();
  });

  /** 非秘密 chamber 设置投影（design 14 D7）：当前值 + 平台能力门控。 */
  function chamberSettingsStatus(): ChamberSettingsStatus {
    return {
      settings: settingsIO.current(),
      supported: computeSupported(hostFacts.platform, hostFacts.trayPresent()),
    };
  }

  /** 设置变更推送：committed-push 包装 + rendererPush；false = 无存活主窗，折算为
   *  push 失败并 loud（无窗口常驻期间由下次查询兜底）。 */
  function pushSettingsChanged(): void {
    const pushed = attemptCommittedRegistryPush(() => {
      if (!deps.edges.rendererPush(IPC_CHANNELS.SETTINGS_CHANGED, chamberSettingsStatus())) {
        throw new Error('settings renderer push failed');
      }
    });
    if (!pushed.sent) {
      try { console.warn(`[dsh-chamber] settings 已保存但变更 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* best effort */ }
    }
  }

  /** 应用已校验的设置 patch：先应用副作用，全部成功并持久化成功后才更新 holder——
   *  任何失败 loud 返回 {error} 并回滚已应用副作用（绝不落半个设置）。副作用叶与
   *  持久化均经 ctx 注入；async 兼容双 flavor（同步 throw 与异步 reject 同一路径）。 */
  async function applySettingsPatch(
    patch: Partial<ChamberSettings>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // notifications / sessionTodo 是嵌套对象：deep-merge 到当前值，绝不整组替换丢开关。
    const current = settingsIO.current();
    const next: ChamberSettings = {
      ...current,
      ...patch,
      notifications: patch.notifications !== undefined
        ? { ...current.notifications, ...patch.notifications }
        : current.notifications,
      sessionTodo: patch.sessionTodo !== undefined
        ? { ...current.sessionTodo, ...patch.sessionTodo }
        : current.sessionTodo,
    };
    // 副作用叶抛异常/reject 时 loud 失败并 best-effort 回滚 keepAwake，绝不带病继续。
    try {
      if (patch.keepAwake !== undefined) await setKeepAwake(patch.keepAwake);
      if (patch.launchAtLogin !== undefined) {
        const result = await setLoginItem(patch.launchAtLogin);
        if (!result.ok) {
          // 副作用失败：回滚已应用的 keepAwake，绝不持久化。
          if (patch.keepAwake !== undefined) await setKeepAwake(current.keepAwake);
          return result;
        }
      }
    } catch (error) {
      console.error('[dsh-chamber] 应用 chamber 设置副作用失败：', error);
      try {
        if (patch.keepAwake !== undefined) await setKeepAwake(current.keepAwake);
      } catch {
        // 回滚失败已记日志，不叠加异常。
      }
      return { ok: false, error: 'settings apply failed' };
    }
    try {
      settingsIO.persist(next);
    } catch (error) {
      console.error('[dsh-chamber] 写入 chamber 设置失败：', error);
      // 持久化失败：回滚已应用副作用，holder 保持旧值。
      if (patch.keepAwake !== undefined) await setKeepAwake(current.keepAwake);
      if (patch.launchAtLogin !== undefined) {
        const rollback = await setLoginItem(current.launchAtLogin);
        if (!rollback.ok) console.error(`[dsh-chamber] 登录自启回滚失败：${rollback.error}`);
      }
      return { ok: false, error: 'settings persist failed' };
    }
    settingsIO.commit(next);
    return { ok: true };
  }

  /** 平台门 + 宿主 apply 的编排：badgePlatformGate 先裁决（win32 专属原因在此区分），
   *  supported 后才经 edges.setBadge apply；unsupported 与 apply 失败各压成一次 loud。 */
  function applyBadgePresentation(count: number): boolean {
    const gate = badgePlatformGate(hostFacts.platform, deps.edges.badgeCountApiAvailable());
    if (!gate.supported) {
      if (!badgeUnsupportedLogged) {
        badgeUnsupportedLogged = true;
        console.warn(`[dsh-chamber] 应用图标未读徽标不可用：${gate.reason}`);
      }
      return false;
    }
    const applied = deps.edges.setBadge(count);
    if (!applied.applied) {
      if (!badgeApplyErrorLogged) {
        badgeApplyErrorLogged = true;
        console.warn(`[dsh-chamber] 应用图标未读徽标设置失败：${applied.reason}`);
      }
      return false;
    }
    return true;
  }

/** 按当前设置重新裁决最近一次 renderer 计数意图（badgeEnabled 翻转的即时收敛点）。 */
  function reconcileBadgeCount(): void {
    if (pendingBadgeCount === null) return;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      pendingBadgeCount,
    );
    applyBadgePresentation(count);
  }

  /** 桌面原生通知主链路契约（宿主腿全在 electron-edges）：payload 白名单 → 平台支持
   *  → 设置裁决 → 有界 claim / 全局速率 → 显示。shown=false 时 error 区分裁决侧抑制
   *  与宿主/OS 拒绝（宿主原文透传）；'test' 绕过 claim 与设置门禁但仍受全局预算约束；
   *  通知失败降级且 loud，不误报成功。 */
  // 域拆分上下文：单点构造，晚定义 helper 以 getter 延迟解析（顺序/错误语义不变）。
  const shellIpcCtx = {
    deps,
    deliveryEdges,
    quittingLeaf,
    externalOpenLeaf,
    chamberSettingsStatus,
    pushSettingsChanged,
    applyBadgePresentation,
    applySettingsPatch,
    reconcileBadgeCount,
    get MACOS_NOTIFICATION_SETTINGS_URL() { return MACOS_NOTIFICATION_SETTINGS_URL },
    get NPM_SEARCH_MAX_BODY_BYTES() { return NPM_SEARCH_MAX_BODY_BYTES },
    get captureVscodeSource() { return captureVscodeSource },
    get confirmPluginAction() { return confirmPluginAction },
    get confirmRuntimeMutation() { return confirmRuntimeMutation },
    get deepLinkRendererReady() { return deepLinkRendererReady },
    get drainPendingNotificationOpens() { return drainPendingNotificationOpens },
    get drainPendingRendererDeepLinkIntents() { return drainPendingRendererDeepLinkIntents },
    get enqueueNotificationOpen() { return enqueueNotificationOpen },
    get enqueueRendererDeepLinkIntent() { return enqueueRendererDeepLinkIntent },
    get localProtectionFacts() { return localProtectionFacts },
    get matchesNotificationSource() { return matchesNotificationSource },
    get nativeNotificationRateLimiter() { return nativeNotificationRateLimiter },
    get notificationOpenDrainReady() { return notificationOpenDrainReady },
    get notificationSourceIncarnations() { return notificationSourceIncarnations },
    get openInCtx() { return openInCtx },
    get ownsNotificationSource() { return ownsNotificationSource },
    get pendingBadgeCount() { return pendingBadgeCount },
    get pendingNotificationOpens() { return pendingNotificationOpens },
    get pendingRendererIntents() { return pendingRendererIntents },
    get projectInstances() { return projectInstances },
    get runRuntimeCheck() { return runRuntimeCheck },
    get verifyLocalProfileFamily() { return verifyLocalProfileFamily },
    get portableHostSeeds() { return portableHostSeeds },
    version,
    state: shellMutableState,
  } as ShellIpcCtx;
  registerSettingsHandlers(shellIpcCtx);

  // ② A 组 3 个注册体 + B 组 6 个注册体（trustedIpc 围栏由装配侧在 ipc 注入点包装，
  //    本文件零 electron）。INFO 载荷：控制面 URL + 平台为宿主事实，shell 版本为模块
  //    自读，dshVersion 即时解析。

  registerConnectionHandlers(shellIpcCtx);

  // 插件受保护集合判定：F 事实解析与装后族一致性复验（F/H 组共用）。事实输入全部
  // 来自 ctx：活动树解析 + 内建线世代 + 锚锁文件 + profile 目录。①「同版优先锚」：
  // 用户选装/env 树不得用内建锚判跨代（仅活动世代 == 内建世代时用锚），env 树有内建
  // 锚兜底；② familySource 恒 'runtime'，解析失败 → 保守降级（官方 scope install 一律拒）。
  /** 本 profile 的保护事实：F 从活动运行时的锁文件闭包解析（平台无关，绝不用源线
   *  vendor 树）+ 有效运行时版本 + profile manifest 是否已存在（缺失 ⇒ 写面推迟，
   *  首次安装才创建它）。 */
  /** 锁文件族事实的单条 memo（key 见 memoKey）。 */
  const familyFactsMemo = createKeyedMemo<{
    names: readonly string[] | null;
    versions: PluginProtectionFacts['familyVersions'];
  }>();
  const localProtectionFacts = (): PluginProtectionFacts => {
    const resolved = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspacePath);
    let familyNames: readonly string[] | null = null;
    // 同一解析的版本半边：装后复验用运行时实际提供的版本来判定已装族成员
    // （重定 scope 的 vendored 包保留上游版本，而非世代字符串）；缺 key = 无版本
    // 事实 ⇒ 走世代分支。
    let familyVersions: PluginProtectionFacts['familyVersions'] = null;
    const activePath = resolved.path;
    if (activePath !== null) {
      // 内建锚只描述内建运行时线。用户选装/env 树是另一条线，其自己的锁文件才是
      // 正确事实源——把锚交给它会用从未有过的版本判一个一致的 profile。同版树仍
      // 优先锚（源线锁文件带 opt-in 段，会被 trust criterion 拒绝）。
      const usePinned = shouldPreferPinnedRuntimeLockfile(resolved.version, bundledVersion);
      const pinnedPath = pinnedRuntimeLockfilePath();
      // 本函数在每次本地插件 IPC 读/判定时运行，最大 512 KiB 的锁文件解析由本 memo
      // 挡住；memo key 为完整输入身份（活动树 + 版本 + 来源、锚选择、两个候选锁文件
      // 的 mtime+size），文件变化或运行时切换即重载。profileState 故意不 memo：首次
      // 安装才创建 profile manifest。
      const memoKey = [
        activePath, resolved.version ?? '', resolved.source ?? '',
        usePinned ? 'pinned' : 'tree', bundledVersion ?? '', pinnedPath ?? '',
        lockfileIdentityKey([pinnedPath ?? '', path.join(activePath, 'pnpm-lock.yaml')]),
      ].join('|');
      const family = familyFactsMemo.read(memoKey, () => {
        let resolvedFamily = resolveRuntimeFamily(activePath, {
          pinnedLockfilePath: usePinned ? pinnedPath : null,
        });
        // dev/env 树（DSH_CHAMBER_DSH_PATH）在另一世代通常带源线锁文件与源线树，
        // 会解析不出族事实并让写面降级为「官方安装一律拒」。显式开发 override 仍可用
        // 内建锚兜底；用户选装的已发布运行时绝不用这个替身（那正是本门修复的跨线误判）。
        if (!resolvedFamily.ok && !usePinned && resolved.source === 'env') {
          resolvedFamily = resolveRuntimeFamily(activePath, { pinnedLockfilePath: pinnedPath });
        }
        return {
          names: resolvedFamily.ok ? resolvedFamily.names : null,
          versions: resolvedFamily.ok ? resolvedFamily.versions : null,
        };
      });
      familyNames = family.names;
      familyVersions = family.versions;
    }
    const profileManifest = path.join(localDshHome, 'profiles', WEB_PROFILE, 'package.json');
    return {
      familyNames,
      familyVersions,
      runtimeVersion: resolved.version,
      profileState: existsSync(profileManifest) ? 'ready' : 'absent',
      familySource: 'runtime',
    };
  };
/** 可移植（非 localOnly）chamber host 包种子（另一台主机上「应该有什么」只读本列表；localOnly 空 sourceDir 不算缺件）。 */
  const portableHostSeeds = (): readonly ChamberHostPackageSeed[] =>
    portableChamberHostPackageSeeds(chamberHostPackageSeeds);
  /** 装后族一致性复验：安装成功还不算成功，直到 profile 树被证明一致——被提升的
   *  传递依赖若内建发布不提供（outside-family）或位于另一世代（generation-mismatch），
   *  正是单看直接 spec 看不到的组合拆分。发现即 loud 且操作报失败，不做自动回滚。 */
  const verifyLocalProfileFamily = (facts: PluginProtectionFacts): { ok: true } | { ok: false; error: string } => {
    if (!Array.isArray(facts.familyNames) || facts.familyNames.length === 0) return { ok: true };
    const familyVersions = facts.familyVersions ?? null;
    const verdict = verifyProfileFamilyConsistency({
      profileDir: path.join(localDshHome, 'profiles', WEB_PROFILE),
      familyNames: facts.familyNames,
      runtimeVersion: facts.runtimeVersion ?? null,
      familyVersions,
    });
    if (verdict.ok) {
      // A skip is NOT a pass: record it loudly (the install itself succeeded,
      // skip 不是通过：loud 记录（安装成功但 profile 树未被证明一致）。
      if (verdict.skipped !== undefined) {
        console.warn(`[dsh-chamber] 插件族一致性复验被跳过：${verdict.skipped}`);
      }
      return { ok: true };
    }
    return {
      ok: false,
      error: `installed, but the profile tree no longer matches the instance runtime: ${describeFamilyFindings(verdict.findings, facts.runtimeVersion ?? null, familyVersions)}`,
    };
  };

  // —— F 组：ssh plugin 6 注册体（全零 Electron）。编排纯模块直接 import；共享现
  // 实例/目标闭包束经 ctx（自动 seed/撤销与 F 组共用同一实例）。宿主对话框腿 =
  // edges.showMessage / pickPluginSource；无存活主窗预检 = edges.mainWindowAlive。
  // confirmPluginAction 语义：无窗 → 'native confirmation unavailable'；response===1
  // （'继续'）→ ok；否则 cancelled；异常 → loud 'native confirmation failed: …'。
  const confirmPluginAction = async (
    copy: { message: string; detail: string },
  ): Promise<{ ok: true } | { ok: false; error: string } | { cancelled: true }> => {
    if (!deps.edges.mainWindowAlive()) return { ok: false, error: 'native confirmation unavailable' };
    try {
      const response = await deps.edges.showMessage({
        type: 'warning',
        title: copy.message,
        message: copy.message,
        detail: copy.detail,
        buttons: ['取消', '继续'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return response === 1 ? { ok: true } : { cancelled: true };
    } catch (error) {
      return { ok: false, error: `native confirmation failed: ${describeUnknownError(error)}` };
    }
  };

  registerSshPluginHandlers(shellIpcCtx);

  registerGatewayPluginHandlers(shellIpcCtx);

  registerLocalPluginHandlers(shellIpcCtx);

  // —— I 组：open-in 与 update 7 注册体。open-in 依赖束经 wiredCtx/openInCtx
  // （lookupInstance 经 ctx transportManager；vscodeAvailable 平台事实；打开/揭示叶 =
  // deps.edges）；来源指纹 owns/matches 复查与代际捕获在 core。update 面经
  // ctx.updateController 注入，注册体以原名调用 updater.xxx；状态 push 经
  // committed-push + rendererPush（主窗身份折算为 mainWindowAlive 门 + 对当前主窗
  // 求值；无存活主窗不 push 不 warn）。updater.start() 由装配侧在 installIpcHandlers
  // 之后调用（「先订阅后 start」）。OS 深链消费循环 drainPendingIntents 在 wiredCtx
  // 就绪后装配；失败 loud = edges.showError + 日志。

/** Hold a successful launch intent until the current renderer explicitly says its
 *  onIntent listener is installed (OS deep links and open-in both). Registry lookup
 *  via ctx transportManager; incarnation capture via captureNotificationSource. */
  function captureVscodeSource(instanceId: string): NotificationSourceToken | null {
    if (instanceId === 'local') return captureNotificationSource('local');
    const instance = sm.listInstances().find(candidate => candidate.id === instanceId);
    return instance === undefined
      ? null
      : captureNotificationSource(`${instance.kind}-${instance.id}`);
  }

  // VS Code 深链 + open-in 的共享宿主依赖束（wiredCtx 同时供 OS 深链 drain 与
  // open-in 管线）。lookupInstance 实查；vscodeAvailable 每次实探（无缓存陈旧）；
  // openVscodeUrl 白名单判定留 core、宿主叶 = edges.openExternal。
  const wiredCtx: VscodeLaunchContext = {
    lookupInstance: (id) => {
      const instance = sm.listInstances().find(entry => entry.id === id);
      if (instance === undefined) return null;
      // vscode-remote URL 是 ssh-TRANSPORT 特性——暴露 transport，而非目标 kind。
      return { id: instance.id, host: instance.host, user: instance.user, sshPort: instance.sshPort, transport: instance.transport };
    },
    vscodeAvailable: () => detectVscodeAvailability(hostFacts.platform).available,
    // Chamber 设置 vscodeOpenInNewWindow：惰性读，变更即时作用于下一次拉起；open-in
    // 按钮与 OS 深链共享同一 wiredCtx。
    vscodeOpenInNewWindow: () => settingsIO.current().vscodeOpenInNewWindow,
    openVscodeUrl: async (url) => {
      // 注入点 scheme 复验：只有本文件构造的目标可达宿主打开叶——远端来源的
      // ssh-remote URL 与本地来源的 file URL。
      if (typeof url !== 'string' || !(url.startsWith('vscode://vscode-remote/') || url.startsWith('vscode://file/'))) {
        const message = 'refused to open a non-vscode URL';
        console.error(`[dsh-chamber] ${message}:`, url);
        return { ok: false, error: message };
      }
      try {
        await deps.edges.openExternal(url);
        return { ok: true };
      } catch (error) {
        const message = describeUnknownError(error);
        console.error('[dsh-chamber] 打开 vscode URL 失败：', error);
        return { ok: false, error: `open vscode url failed: ${message}` };
      }
    },
  };

  // open-in 注册表（open-in.ts）：apps() 能力协商 + 统一执行管线。wiredCtx 复用
  // registry/availability/openVscodeUrl，补 stat（node:fs fsp）与 open/show 宿主叶。
  const openInCtx: OpenInLaunchContext = {
    platform: hostFacts.platform,
    lookupInstance: wiredCtx.lookupInstance,
    vscodeAvailable: wiredCtx.vscodeAvailable,
    vscodeOpenInNewWindow: wiredCtx.vscodeOpenInNewWindow,
    openVscodeUrl: wiredCtx.openVscodeUrl,
  }
  registerOpenInHandlers(shellIpcCtx);

  registerUpdateHandlers(shellIpcCtx);

  // OS 深链消费循环装配：startup/装配就绪后顺序消费有界队列。VS Code 启动不等待
  // renderer；成功 intent 进入 renderer hold/replay 队列直到 ready 握手。失败 loud
  // （showError + 日志）；quit 在途的新深链已在 enqueueDeepLink 被 ignore。
  drainPendingIntents = () => {
    if (drainingPendingIntents || quittingLeaf()) return;
    drainingPendingIntents = true;
    void (async () => {
      for (;;) {
        if (quittingLeaf()) return;
        const intent = pendingIntents.shift();
        if (intent === null) return;
        try {
          const sourceToken = captureVscodeSource(intent.instanceId);
          const result = await runVscodeLaunch(intent, wiredCtx);
          if (result.ok && sourceToken !== null && ownsNotificationSource(sourceToken)) {
            enqueueRendererDeepLinkIntent(intent, sourceToken);
          } else {
            const error = result.ok ? 'instance changed while VS Code launch was in progress' : result.error;
            console.error(`[dsh-chamber] 深链执行失败：${error}`);
            deps.edges.showError('打开 VS Code 失败', error);
          }
        } catch (error) {
          // runVscodeLaunch 异常安全；保留最后兜底边界且不泄漏 key。
          console.error('[dsh-chamber] 深链执行异常：', describeUnknownError(error));
        } finally {
          pendingIntents.complete(intent);
        }
      }
    })().finally(() => {
      drainingPendingIntents = false;
      if (!quittingLeaf() && pendingIntents.pendingCount > 0) drainPendingIntents?.();
    });
  };

  // —— J 组：runtime 6 注册体。控制器现实例经 ctx.runtimeController 注入（core 只做
  // 类型 import；K 组与启动/证据路径共用，状态权威单一）。事务槽在飞读门 =
  // runtimeOperationBusy；fence = runtimeWriterFence（owner 名 'runtime:restart' /
  // 'runtime:check' / 'runtime:install' / 'runtime:cleanup-version'）；动作门 =
  // runtimeActionAllowed；宿主叶 = refreshRuntimeEvidence / runStorePruneIfNeeded；
  // restartLocalDsh = PlaneHandle 宿主腿（resolve ≠ success 的白名单判据在注册体）。
  // 确认对话框 = confirmRuntimeMutation（无窗预检 + edges.showMessage；无窗 → false，
  // 调用方静默返回当前 state）。runRuntimeCheck 的 quit 门 = quittingLeaf，装配槽在
  // J 组段尾部赋值——main 侧计时器经 runRuntimeCheckCycle 调用同一实现。
  const confirmRuntimeMutation = async (message: string, detail: string, confirmLabel: string): Promise<boolean> => {
    if (!deps.edges.mainWindowAlive()) return false;
    const response = await deps.edges.showMessage({
      type: 'warning',
      title: message,
      message,
      detail,
      buttons: ['取消', confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  };
  registerRuntimeHandlersA(shellIpcCtx);
  const runRuntimeCheck = async () => {
    if (quittingLeaf() || runtimeOperationBusy() || !runtimeActionAllowed('check')) {
      return runtimeInstance.getState();
    }
    const lease = runtimeWriterFence.tryAcquire('runtime:check');
    if (lease === null) return runtimeInstance.getState();
    try {
      return await runtimeInstance.check();
    } finally {
      lease.release();
    }
  };
  registerRuntimeHandlersB(shellIpcCtx);
  // 周期检查装配槽（main 侧 15s 首检 + 6h 周期与 RUNTIME_CHECK 注册体共用同一实现与门）。
  runtimeCheckRunner = () => {
    void runRuntimeCheck();
  };

  registerRuntimeHandlersC(shellIpcCtx);

}
