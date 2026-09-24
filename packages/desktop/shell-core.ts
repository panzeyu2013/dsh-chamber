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
import { findFreePort } from './free-port.ts';
import { computeSupported } from './chamber-settings.ts';
import { createKeyedMemo, lockfileIdentityKey } from './lockfile-facts-memo.ts';
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';

import { attemptCommittedRegistryPush } from './transport-manager.ts';
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

/** macOS「系统设置 → 通知」面板深链；固定常量、只由 OPEN_NOTIFICATION_SETTINGS
 *  使用——renderer 不能传 URL，避免把 OPEN_RELEASE 的 URL 白名单扩成任意打开面。 */
export const MACOS_NOTIFICATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
import { BoundedRateLimiter, MAX_PENDING_NOTIFICATION_OPENS, NotificationSourceIncarnations, NotificationSourceProofs } from './notifications.ts';
import { readCurrentPointerState, readOverrideState, shouldInvalidate, validateVersionTree } from '@dsh-chamber/dsh-runtime';
// F 组编排纯模块（plugin-sync / ssh-apply-rows / plugin-tarball）直接 import；
// ssh-plugin-journal / plugin-sync 的现实例与目标闭包束经 ctx 注入——自动
// seed/撤销路径与 F 组注册体必须共享同一实例（单写者/单飞语义不分叉）。
import { portableChamberHostPackageSeeds, shouldPreferPinnedRuntimeLockfile, WEB_PROFILE } from './plugin-sync.ts';
import type { ChamberHostPackageSeed, PluginProtectionFacts } from './plugin-sync.ts';
// 插件受保护集合判定（design 21 §6.11）：control-plane-module 纯函数直接 import，
// 事实输入经 ctx。localProtectionFacts / verifyLocalProfileFamily 为 core 内助手
// （F/H 组注册体共用同一实现）。
import {
  describeFamilyFindings,
  resolveRuntimeFamily,
  verifyProfileFamilyConsistency,
} from './control-plane-module.ts';

// —— Extracted seam types (R4 P7 type-cycle break; leaf headers carry the contract).
import type { HostEdges } from './host-edges.ts';
export type { HostEdges, HostMessageOptions, HostPluginSourcePick, HostSetBadgeResult, NativeNotificationSpec } from './host-edges.ts';
export type { NotificationOpenIntent, NotificationSourceToken } from './notifications.ts';
export type { IpcRegistrar, ShellAssemblyCtx, SshPluginTarget } from './shell-assembly-ctx.ts';
import type { ShellIpcCtx, ShellIpcDeps } from './shell-ipc-ctx.ts';
export type { ShellIpcCtx } from './shell-ipc-ctx.ts';
import type { ProjectedRegistryInstance } from './registry-projection.ts';
export type { ProjectedRegistryInstance } from './registry-projection.ts';
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

export function installIpcHandlers(deps: ShellIpcDeps): void {
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
