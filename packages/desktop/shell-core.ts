/**
 * dsh-chamber desktop shell core (design 25 §4.1; W-09 batch 1 + W-10 S1/S2).
 *
 * Electron-free business logic mechanically relocated from main.ts — pure
 * moves plus documented parameterizations/seam-leaf replacements, no semantic
 * rewrites, no state-machine reordering. The Electron main process imports
 * these functions and constants by their original names; the Swift-native
 * flavor reuses the same core.
 *
 * Hard invariants:
 * - Electron-free by construction: never import the electron package (W-14
 *   face A gate). The sole IPC registration point is installIpcHandlers
 *   (W-10 seam batch): the registrar (deps.ipc) is injected by the assembly
 *   side — Electron main wraps it with the trustedIpc fence, so this file
 *   never spells ipcMain / webContents.send (W-14 face C gate). IPC_CHANNELS
 *   constants (ipc-events.ts — a pure constants module) are legitimately
 *   referenced here since S1.
 * - Host state is parameterized: userData-scoped paths and the runtime base
 *   dir arrive as arguments (resolveActiveRuntime / the path templates), argv
 *   arrives as an argument (scanDeepLinkUrls); nothing reads Electron host
 *   state implicitly. W-09 state is parameterized per function (the
 *   installIpcHandlers ctx seam). W-10 S2 修订：渲染器投递状态机（队列/ready
 *   位/drain/来源代际/held resume/badge holder）是 core 业务状态，以模块作用域
 *   单例承载（装配侧 glue/IPC 与 core 共享同一实例——单装配不变式：
 *   installIpcHandlers 每进程恰一次、先于任何窗口/渲染器事件，装配时快照
 *   edges 子集与 quit 门）；宿主状态仍绝无模块作用域隐式读取。
 *
 * Responsibilities relocated from main.ts (W-09 batch 1):
 * - Control-plane port resolution (design 05 §3.3): resolveControlPlanePort
 *   with its dev backoff base/attempts constants.
 * - Synchronous spawn-time dsh runtime/workspace resolution (design 18):
 *   resolveActiveRuntime / readDshVersion / ActiveRuntimeSource /
 *   ActiveRuntimeResolution.
 * - Proxy transport normalization: proxyTransport.
 * - Shared shell constants: LOCAL_RUNNING_STATES, QUIT_CLEANUP_TIMEOUT_MS,
 *   NPM_SEARCH_MAX_BODY_BYTES.
 * - Defensive deep-link argv scan: scanDeepLinkUrls.
 * - userData-scoped path templates: chamberSettingsFilePath /
 *   sshPasswordsFilePath / gatewaySecretsFilePath / auditLogFilePath /
 *   instancesFilePath / stateRootDir / localDshHomeDir.
 *
 * Responsibilities relocated from main.ts (W-10 S1 info+settings batch):
 * - Shell IPC registration point: installIpcHandlers with the IpcRegistrar /
 *   ShellAssemblyCtx seams (hostFacts / runtimeFacts / settingsIO and the
 *   settings side-effect leaves injected by the Electron main assembly).
 * - INFO / SETTINGS_GET / SETTINGS_SET handler bodies plus their helpers
 *   chamberSettingsStatus / applySettingsPatch / pushSettingsChanged
 *   (verbatim relocations — see the S1 section below).
 *
 * Responsibilities relocated from main.ts (W-10 S2 notify/badge/ready batch):
 * - B 组 6 个注册体（NOTIFY / NOTIFICATIONS_READY / NOTIFICATION_OPEN_ACK /
 *   BADGE_COUNT / DEEP_LINK_READY / DEEP_LINK_ACK）——见 installIpcHandlers ②；
 *   NOTIFY 主链路（maybeShowNativeNotification）与其 claim/限速编排随迁。
 * - 渲染器投递状态机（design 16 §4.2 / design 19 §3.3）：renderer 深链与通知
 *   打开的有界 ACK 队列 + ready 位 + drain（send 叶 = edges.rendererPush，
 *   requeue/rollback/acknowledge 语义原样）、来源代际/证明实例
 *   （NotificationSourceIncarnations / NotificationSourceProofs）、held
 *   lastResume 补发（handleSystemResume / handleMainWindowShown +
 *   pushHeldSystemResume）、badge 意图 holder 与平台门裁决。装配侧经导出入口
 *   访问（onRendererLifecycle / enqueueRendererDeepLinkIntent /
 *   captureNotificationSource / ownsNotificationSource /
 *   matchesNotificationSource / projectNotificationSourceInstances /
 *   syncNotificationSourceRegistry / clearBadgeIntentForQuit）——逐条迁移决策
 *   见「Renderer delivery state machines」段注释。
 *  Responsibilities relocated from main.ts (W-10 S3 registry+credentials batch):
 *  - C 组 7 个注册体：SSH_INSTANCES_GET / SSH_SAVE_CONNECTION /
 *    SSH_DELETE_CONNECTION / SSH_INSTANCES_SET / SSH_SET_PASSWORD /
 *    GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD——按原 main.ts 顺序追加在 B 组
 *    之后（installIpcHandlers ② 段）；随迁注册体侧纯辅助（gatewayOriginFor /
 *    normalizeConnectionInput）与 registry 非秘密投影链（projectInstances /
 *    projectInstanceSecrets——模块级导出，main.ts 的 publishRegistryTransition
 *    沿用：S2 同款 core→main 单向依赖）。事务（connection-save）、canonicalize
 *    （transport-provider）与凭据写入口（ssh/gateway-provider）等纯模块直接
 *    import；装配依赖经 ctx：transportManager 句柄（registry 读写 + 状态/
 *    生命周期投影）/ audit / gatewaySessions / publishRegistryTransition（后
 *    三者宿主定义仍留 main 装配侧——publishRegistryTransition 的插件
 *    seed/journal 生命周期体与其 SSH_INSTANCES_CHANGED push 文本留 main）。
 *  Responsibilities relocated from main.ts (W-10 S4 ssh-connection-state batch):
 *  - D 组 7 个注册体：SSH_CONFIG_LIST / SSH_CONNECT / SSH_DISCONNECT /
 *    SSH_STATUS / SSH_REVERIFY / SSH_LOGS / SSH_LOGS_CLEAR——按原 main.ts 顺序
 *    追加在 C 组之后（installIpcHandlers ② 段）；CONFIG_LIST 经纯模块
 *    ssh-config.ts 的 discoverSshConfigHosts（非秘密投影纪律注释随迁），其余
 *    6 个注册体全走 ctx 注入的 transportManager 句柄（Pick 面 S4 扩
 *    reverify / logs / clearLogs——connect/disconnect/status 为 C 组已有成员）。
 *    status/logs 的非秘密投影形状不变（localPort/phase 等元数据；URL/密钥绝不
 *    出主进程、绝不进载荷/日志——main.ts 原注释语义保留）。
 *
 * 中文说明：自 main.ts 机械搬运的 Electron-free 业务核心（零缝阶段，行为零
 * 变化）；W-10 S1 起 IPC 注册点与 A 组 info+settings 处理器迁入本文件
 * （installIpcHandlers 单点注册，Electron 围栏由 main 注入包装）；S2 追加 B 组
 * notify/badge/ready 6 注册体与渲染器投递状态机（send 叶统一
 * edges.rendererPush）；S3 追加 C 组 registry+凭据 7 注册体与读时投影链（凭据
 * write-only/绝不回读纪律随迁，代码注释保留）；S4 追加 D 组 ssh 连接状态 7
 * 注册体（CONFIG_LIST 经纯模块 ssh-config.ts；其余经 ctx transportManager
 * ——非秘密投影纪律随迁）。HostEdges 其余边沿叶与双 flavor 属后续批。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findFreePort } from './free-port.ts';
import { computeSupported, validatePatch } from './chamber-settings.ts';
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';
import { DEFAULT_CHAMBER_SETTINGS } from './chamber-settings.ts';
import {
  INSTANCE_ID_PATTERN,
  attemptCommittedRegistryPush,
  commitTransportCredentialUpdate,
  type TransportManager,
} from './transport-manager.ts';
import {
  deleteConnectionTransaction,
  saveConnectionTransaction,
  validateDeleteOnlyReplacement,
  type ConnectionCredentialMutations,
} from './connection-save.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
import type { NotificationOpenIntent, NotificationSourceToken } from './notifications.ts';
import {
  canonicalizeTransportInstanceInput,
  type TransportInstanceInput,
  type TransportInstanceSpec,
} from './transport-provider.ts';
import { discoverSshConfigHosts } from './ssh-config.ts';
import { MAX_SSH_PASSWORD_CHARS, getSshPassword, setSshPassword, sshPasswordSupported, sshProvider } from './ssh-provider.ts';
import {
  gatewayPasswordValidationError,
  gatewayProvider,
  gatewaySecretStorageMode,
  gatewayTokenValidationError,
  getGatewayPassword,
  getGatewayToken,
  setGatewayPassword,
  setGatewayToken,
  setInstanceSecrets,
} from './gateway-provider.ts';
import {
  gatewaySessionScopeForConnection,
  type GatewaySessionManager,
  type GatewaySessionOrigin,
} from './gateway-session.ts';
import { gatewaySessionOriginForUrl, gatewayTunnelAuthority } from './gateway-session-refresh.ts';
import type { AuditEvent } from './audit-log.ts';
import { adjudicateBadgeCount, badgePlatformGate, validateBadgeRequest } from './badge.ts';
import {
  BoundedAckDeliveryQueue,
  BoundedVscodeIntentQueue,
  canDeliverRendererDeepLink,
  describeUnknownError,
} from './deep-link.ts';
import type { VscodeLaunchRequest } from './deep-link.ts';
import {
  BoundedRateLimiter,
  MAX_PENDING_NOTIFICATION_OPENS,
  NotificationSourceIncarnations,
  NotificationSourceProofs,
  claimNotificationDetailed,
  decideNotification,
  releaseNotificationClaim,
  validateNotificationRequest,
} from './notifications.ts';
import type { NotificationSettingsLike } from './notifications.ts';
import {
  readCurrentPointerState,
  readOverrideState,
  shouldInvalidate,
  validateVersionTree,
} from '@dsh-chamber/dsh-runtime';

// Control-plane port (design 05 §3.3): the packaged app keeps the documented
// default 17500; the dev launcher (electron-dev.mjs) runs with an isolated
// user-data dir, so its control plane must also avoid the packaged app's port.
// Dev starts at 17520 and auto-backs off to the first free port (parallel
// worktrees each land on their own port); DSH_CHAMBER_CP_PORT pins a fixed
// port. The renderer origin is derived from the actually bound port at
// runtime (controlPlane.port), so nothing else hardcodes the address. Port 0
// lets the OS pick an ephemeral port — the last resort when the whole dev
// backoff range is exhausted.
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

/** The control-plane proxy currently ships the same two transport adapters as
 * the desktop registry. Keep the open-ended provider type at its boundary,
 * then fail loudly if a future adapter reaches registration before the proxy
 * has learned its trust/origin rules. */
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
// sibling package.json exactly like main.ts reads its own — the same file in
// dev and packaged layouts (W-09: the moved resolver keeps comparing the
// override's recorded shellVersion against the same version fact it compared
// in main.ts).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Synchronous spawn-time resolver: env > valid override/current > builtin.
 * Selection metadata corruption and pointer/override disagreement fail closed;
 * they never alias the absence of a user runtime.
 */
export function resolveActiveRuntime(baseDir: string, builtinWorkspace: string | null): ActiveRuntimeResolution {
  const envPath = process.env.DSH_CHAMBER_DSH_PATH;
  if (envPath) return { path: envPath, version: readDshVersion(envPath), source: 'env', blockedReason: null };

  const overrideState = readOverrideState(baseDir);
  const pointerState = readCurrentPointerState(baseDir);
  if (overrideState.kind === 'corrupt') {
    return { path: null, version: null, source: 'bundled', blockedReason: 'dsh runtime override metadata is corrupt' };
  }
  if (pointerState.kind === 'corrupt') {
    return { path: null, version: null, source: 'bundled', blockedReason: 'dsh runtime current pointer is corrupt' };
  }
  const override = overrideState.kind === 'valid' ? overrideState.record : null;
  const pointer = pointerState.kind === 'valid' ? pointerState.version : null;
  // Override validity (invalidatedAt / shell-version mismatch) is decided by
  // the shared dsh-runtime core predicate (shouldInvalidate — the same replay
  // gate the runtime startup and the gateway shape consume).
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

// 本地实例「运行中/在途」状态（design 14 D2，2026-08 修订）：进程存活
// （ready/degraded）或 spawn/重启在途（starting/restarting）——退出会中断
// 它们，需确认。stopped / error / restart-exhausted 无进程可中断，不触发
// 确认。**2026-08 二次修订**：状态字符串不是存活事实——restart 序列里
// `restarting` 期间新进程可能尚未 spawn（backoff 1s→60s），死亡进程在下次
// 探活前也可能滞留在 ready/degraded；退出确认必须同时要求**实际有存活进程**
// （localProcessAlive），否则"本地明明没有实例在运行"也会误弹确认。注意
// `starting` 全程 child 尚未赋值（spawn 解析后才挂到连接上），hasLiveProcess()
// 恒为 false，配合 AND 门实际不参与确认——spawn 在途由控制面的 epoch/stopping
// 守卫在 stop() 时终止（绝不孤儿化），故「无进程则不确认」是安全的。
export const LOCAL_RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded', 'restarting']);

/** 扫描 argv 中的 dsh-chamber:// 深链（防御式：非深链 argv 零副作用、绝不 throw）。 */
export function scanDeepLinkUrls(argv: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('dsh-chamber://')) urls.push(arg);
  }
  return urls;
}

/** 退出清理（will-quit：transport dispose + 控制面 stop）的最长等待；超时强制
 *  退出，防「窗口已关、主进程永久滞留」的半退出态。子进程回收用短窗口
 *  （transport 1s / 本地 dsh 1s → SIGKILL）+ 传输层与控制面并行化，正常
 *  ~1-2s 完成；5s 硬顶仅为异常路径（如残留连接使 server.close 不回调）兜底
 *  （2026-08 排查；2026-08 提速，15s → 5s）。 */
export const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
/** Cap on the npm search JSON body (registry search responses are ~KB-scale;
 * 256 KiB bounds a hostile or misbehaving registry). */
export const NPM_SEARCH_MAX_BODY_BYTES = 256 * 1024;

// userData-scoped path templates (design 25 §4.1 resource-path 收口, W-09
// batch 1): every persistent file / state root under <userData> is spelled
// here once; main.ts passes app.getPath('userData') at each call site.
/** <userData>/chamber-settings.json（design 14 D7）。 */
export function chamberSettingsFilePath(userData: string): string {
  return path.join(userData, 'chamber-settings.json');
}

/** <userData>/ssh-passwords.json（design 05 §8 plaintext fallback, 0600）。 */
export function sshPasswordsFilePath(userData: string): string {
  return path.join(userData, 'ssh-passwords.json');
}

/** <userData>/gateway-secrets.json（design 17 §12, schema v3）。 */
export function gatewaySecretsFilePath(userData: string): string {
  return path.join(userData, 'gateway-secrets.json');
}

/** <userData>/audit-log.jsonl（design 17 §13.4.4, JSONL append）。 */
export function auditLogFilePath(userData: string): string {
  return path.join(userData, 'audit-log.jsonl');
}

/** <userData>/ssh-instances.json（design 03 §2.2 persisted registry）。 */
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

// ---------------------------------------------------------------------------
// HostEdges — the host side-effect seam (design 25 §4.1; W-10 batch).
//
// Core business code reaches every Electron/host side effect ONLY through
// this injected interface. The Electron main process implements it in
// electron-edges.ts (createElectronEdges — W-10 S0 wires the rendererPush
// leaf; later batches move the remaining leaves verbatim); the Swift-native
// flavor will implement the same seam over the B bridge (node-edges.ts).
// Electron-free by construction: member types are strings/numbers/booleans/
// Promises/local structural types — never electron types (W-14 face A gate),
// and no IPC registration or bare channel literals live here. Member-level
// deviations from the design 25 §4.1 draft are annotated per member (v2
// field set per design 25 §0.1 rows A10/B1/B3/B4/B9/B11/D3).
// ---------------------------------------------------------------------------

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

/** dialog.showMessageBox 选项（最小结构形态：按 main.ts 现用调用点
 *  type/title/message/detail/buttons/defaultId/cancelId/noLink 收口；随对话
 *  框叶迁移批按需扩展）。 */
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

/** 插件源一体化 picker 结果（E8/A10：插件源 folder|.tgz，无 pickDirectory）。
 *  与 §4.1 草案 {kind:'folder'|'tgz';path}|null 的偏差：v2 以 status 判别
 *  cancelled/picked（path 非空即 picked；folder|tgz 的 kind 归实现/调用侧按
 *  design 21 §10 ⑧ 判定，待 picker 叶迁移批定稿）。 */
export type HostPluginSourcePick =
  | { status: 'cancelled' }
  | { status: 'picked'; path: string };

/** badge 应用结果。与 §4.1 草案 setBadge(count): boolean 的偏差：v2 用判别
 *  形态区分「已应用」与「未应用 + 原因」（reason 先取 string，细分联合随
 *  badge.ts 平台门迁移批定稿）。 */
export type HostSetBadgeResult =
  | { applied: true }
  | { applied: false; reason: string };

/** resolveResource 的资源位（B1：main.ts 直拼点参数化收口）。 */
export type HostResourceKind = 'builtin-dsh' | 'pnpm' | 'dist-web' | 'host-package' | 'icon';

/** HostEdges — core 侧唯一可见的宿主边沿契约（design 25 §4.1 v2 字段集）。
 *  S0 批实现 rendererPush、S2 批实现渲染器投递/通知/徽标批成员
 *  （electron-edges.ts 头注释按批列出已实现集合）；其余成员标注其后续批来源，
 *  未实现前 core/main.ts 不得调用（Pick 收窄在编译期保证）。 */
export interface HostEdges {
  /** 主窗口渲染器 push 叶（W-10 S0 seam 成员，草案新增）：channel 为 opaque
   *  通道名（Electron 侧恒为 IPC_CHANNELS 常量值），payload 为纯非秘密投影；
   *  返回 false = 当前无存活主窗（单窗身份），调用侧自行折算失败语义。 */
  rendererPush(channel: string, payload: unknown): boolean
  // —— 原生显示/系统集成 ——
  /** 构造并显示原生通知（B4：宿主对象登记/淘汰/evict 全留实现侧私有）。S2 形状
   *  （对 §4.1 草案的批内修订）：clickRoute 携带 click 回灌路由——null = 'test'
   *  通知（无会话上下文，原生 click 只恢复窗口）；否则宿主 click 腿在宿主内先
   *  activate/restore/focus 主窗口（无窗则重建，showMainWindow 语义），成功后才
   *  回调 onActivated（core 的 owns+入队闭包——来源代际校验在 core）。honest-show
   *  结算（showNativeNotificationHonestly 语义）在实现侧内部执行；返回句柄的
   *  shown 暴露结算结果（NOTIFY IPC 返回值与 claim 释放依赖它），dispose 注销
   *  click 回执（注销后该通知的后续 click 只恢复窗口）。实现侧不 throw——构造/
   *  登记/监听失败一律结算为 shown:false 且登记清理内部完成。 */
  showNativeNotification(
    spec: NativeNotificationSpec,
    clickRoute: { token: NotificationSourceToken; onActivated(): void } | null,
  ): { dispose(): void; shown: Promise<{ shown: true } | { shown: false; error: string }> }
  /** Notification.isSupported 平台探测（异常安全由实现侧保证）。 */
  notificationSupported(): boolean
  /** 通知 click → open-intent 回灌（design 25 §4.5 E4：宿主激活窗口腿成功后把
   *  click 送回 core 队列）。S2 的 Electron click 回灌经 showNativeNotification
   *  的 clickRoute 参数实现；本成员供后续批（Swift B flavor 的
   *  edge:notification-clicked 对应面）使用，未实现前不可经 Pick 触碰。 */
  notifyClicked(openIntent: NotificationOpenIntent): void
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
  /** 主窗口存在性门（W-10 S2 批内补充，B3 族）：win!=null 且未销毁——隐藏到
   *  托盘/后台的窗口仍为 true（与 loading/alive 区分：窗口在但不一定可用）。
   *  rendererPush 返回 false 与 mainWindowAlive() 为 false 语义等价。 */
  mainWindowAlive(): boolean
  /** 来源退役驱逐（W-10 S2 批内补充，B4 registry 私有）：注册表退役路径把
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
  // —— 对话框 ——
  /** 插件源一体化 picker（E8/A10：folder|.tgz；design 21 §10 ⑧）。 */
  pickPluginSource(): Promise<HostPluginSourcePick>
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
  /** 资源/打包路径解析（B1/B13：main.ts 直拼点参数化收口）。 */
  resolveResource(kind: HostResourceKind): string
}

// ---------------------------------------------------------------------------
// Renderer delivery state machines (W-10 S2 notify/badge/ready batch).
//
// 迁自 main.ts 的渲染器侧队列状态机（design 16 §4.2 / design 19 §3.3 /
// design 14 D4）：pendingRendererIntents + deepLinkRendererReady + drain、
// pendingNotificationOpens + notificationOpenDrainReady + drain、来源代际/
// 证明实例（notificationSourceIncarnations / NotificationSourceProofs）、held
// lastResume 补发、badge 意图 holder。本段是 core 业务状态（非宿主状态）——
// 对 W-09「状态一律参数化、绝不模块作用域读」头部注记的批内修订：装配侧窗口
// glue / open-in IPC / 深链消费循环与 installIpcHandlers 必须共享同一实例。
// 单装配不变式：installIpcHandlers 每进程恰一次、先于任何窗口/渲染器事件（S1
// 调用点纪律：whenReady 内、createMainWindow 之前），装配时把 HostEdges 投递
// 子集（deliveryEdges）与 quit 门（quittingLeaf）快照进本段——此后所有导出
// 入口可用。Electron-free 不变式不变：本文件零 electron import，投递 send 叶
// 一律 edges.rendererPush、窗口事实一律 edges 门。
//
// 迁移决策（逐条注记，施工图 S2）：
// - drainPendingRendererDeepLinkIntents / drainPendingNotificationOpens 随队列
//   迁入（send 叶改 edges.rendererPush(IPC_CHANNELS.DEEP_LINK_INTENT /
//   NOTIFICATION_OPEN,…)，requeue/rollback/ACK/ready 位语义原样保留；窗口身份
//   复查（原 mainWindow === win）折算为「投递门只对当前主窗求值」——所有 drain
//   触发点（glue 的 mainWindow===win 守卫 / trusted IPC = 当前主窗 / 入队调用）
//   都锚定当前主窗，mid-drain 的 Electron 同步拆除竞态由每项 edges 门复检兜住；
//   ready 位只在投递失败时复位（= 原「仅发送失败的窗口失去握手」语义——单窗下
//   该窗即当前主窗，且 ready 位只由当前主窗的 trusted IPC 置位，无条件复位安全）。
// - enqueueRendererDeepLinkIntent：迁入并导出（main.ts 的 open-in IPC 与深链
//   消费循环（S9 前留 main）继续调用；签名与语义不变）。
// - enqueueNotificationOpen：迁入（其唯一调用方 = NOTIFY 流构造的 click 回灌
//   闭包，见 installIpcHandlers；不导出）。
// - captureVscodeSource：**留在 main.ts**（依赖 transportManager registry 查
//   找 = 装配侧所有物；代际捕获改经导出的 captureNotificationSource 代理）。
// - notificationSourceIncarnations / NotificationSourceProofs 实例迁入（NOTIFY
//   流、入队 owns 校验与 registry 退役共用；main.ts 侧经导出的 capture / owns /
//   matches / project / sync 入口访问）。
// - held lastResume 补发迁入（handleSystemResume / handleMainWindowShown +
//   pushHeldSystemResume 经 edges.rendererPush 推送 SYSTEM_RESUME——committed
//   push 包装与搬迁前同款）；订阅点 = installIpcHandlers ① 段注册
//   edges.onSystemResume / onMainWindowShown。传输层唤醒重探
//   （reconnectStaleTransports）留在 main 装配侧另挂 powerMonitor 监听。
// - badge 意图 holder 迁入（BADGE_COUNT 注册体随迁；平台门 = badgePlatformGate
//   (platform, edges.badgeCountApiAvailable()) 留 core——E5「门控逻辑留
//   core」）；quit 兜底清除经 clearBadgeIntentForQuit 导出（main will-quit
//   调用，原生清除叶由调用侧注入）。
// - ready 位挂钩收敛为 onRendererLifecycle(event) 单一入口：did-start-loading /
//   did-finish-load / crashed / closed 由 main 窗口 glue 调用（每处先做
//   mainWindow===win 身份守卫）；'show'（held-resume 补发点）经
//   edges.onMainWindowShown → handleMainWindowShown，不占本入口。
// ---------------------------------------------------------------------------

/** 投递状态机实际使用的 HostEdges 子集（装配时自 installIpcHandlers 的
 *  deps.edges 快照——见上「单装配不变式」）。 */
type DeliveryEdgeSet = Pick<
  HostEdges,
  'rendererPush' | 'mainWindowAlive' | 'webViewLoading' | 'webViewContentAlive'
>;

let deliveryEdges: DeliveryEdgeSet | null = null;
/** quit 在途门（装配侧 ctx.isQuitting——入队/通知投递循环的 ignore 语义）。 */
let quittingLeaf: () => boolean = () => false;

// 来源生命周期权威（design 19 §3.3）：移除或传输身份编辑推进代际，原生通知
// click 闭包与 held opens 无法跨进同 id 替换。
const notificationSourceIncarnations = new NotificationSourceIncarnations();
// 来源证明 sidecar（非秘密投影；presentation/service/home 编辑后存活，退役轮换）。
const notificationSourceProofs = new NotificationSourceProofs();

// 桌面通知（design 19 §3.3）：pendingNotificationOpens 照搬 pendingIntents 的
// 队列 + drain 模式——点击通知时窗口可能正在重建/加载，事件不能丢。
const pendingNotificationOpens = new BoundedAckDeliveryQueue<NotificationOpenIntent>(MAX_PENDING_NOTIFICATION_OPENS);
let notificationOpenDrainReady = false;
let drainingNotificationOpens = false;

// 成功启动 VS Code 与 renderer 来源激活是两条独立链：前者不等待 UI，后者必须
// 等 App 安装 onIntent 后通过 deep-link-ready 握手才能发送。窗口加载/崩溃会复位
// ready；成功 intent 在有界队列中 hold/replay，绝不发给 about:blank 或尚未订阅
// 的 renderer。
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

// 最近一次 OS 唤醒时间戳（design 14 D4）：无窗口常驻（托盘态）期间 held，窗口
// show 时一次性补发（push 成功后清空，避免 hide→show 补发过期事件）。
let lastResume: number | null = null;

// 未读徽标（design 19 §3.7）：renderer 推真实未读计数，core 持「最近一次意图」
// 并按当前设置裁决呈现（badgeEnabled 关闭 → 强制 0 清除；重新开启 →
// reconcileBadgeCount 恢复）。quit 在途兜底清除（clearBadgeIntentForQuit）。
// badgeUnsupportedLogged / badgeApplyErrorLogged 把平台不支持（win32 / API 缺
// 失）与持续抛错的 loud 日志压成一次——防重复推送刷屏。
let pendingBadgeCount: number | null = null;
let badgeUnsupportedLogged = false;
let badgeApplyErrorLogged = false;

/** 全局原生通知发送限速（含 kind:'test'，与 claim 同款有界滑动窗口）。 */
const nativeNotificationRateLimiter = new BoundedRateLimiter();

/** SYSTEM_RESUME 推送叶包装：单窗身份 send（edges.rendererPush 返回 false =
 *  无存活主窗）折算为 push 失败并 loud——与搬迁前「mainWindow 变更即 throw」
 *  语义等价；无窗口常驻期间由 show 补发兜底。 */
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

/** OS 唤醒（design 14 D4，core 侧）：held 最近一次唤醒时间戳；窗口存活（含隐
 *  藏）已即时收到则立即推送并清空 held，避免 hide→show 补发过期事件。 */
function handleSystemResume(timestamp: number): void {
  lastResume = timestamp;
  const heldResume = lastResume;
  const edges = deliveryEdges;
  if (heldResume !== null && edges !== null && edges.mainWindowAlive() && pushHeldSystemResume(heldResume)) {
    if (lastResume === heldResume) lastResume = null;
  }
}

/** 主窗口 'show' 补发点（B9）：无窗口常驻（托盘态）期间的唤醒事件 held
 *  （lastResume），窗口恢复可见时一次性补发。 */
function handleMainWindowShown(): void {
  const heldResume = lastResume;
  if (heldResume !== null && pushHeldSystemResume(heldResume)) {
    if (lastResume === heldResume) lastResume = null;
  }
}

/** 通知点击入队（design 19 §3.3）：quit 在途 ignore；来源代际校验（捕获 token
 *  必须仍为当前代际——同 sourceId 重加后旧 click 不回灌新 shell）；入队后立即
 *  drain（窗口已加载则直接推送，重建/加载中由 did-finish-load 补发——窗口关闭
 *  期间点击通知不丢事件，照搬 pendingIntents 模式）。有界队列（64 条上限，与
 *  renderer 深链队列同款防御）：窗口长期无法加载时超限丢弃最旧，绝不无限增长。 */
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

/** 通知打开事件统一 drain（design 19 §3.3，retain-until-ACK）：窗口存在、已完
 *  成加载且 renderer 已就绪（onOpen 监听注册后经 dsh-chamber:notifications-ready
 *  置位）→ 直接推送；任一条件不满足 → 重新 hold，did-finish-load / ready IPC
 *  后再补发。send 叶 = edges.rendererPush（W-10 S2 迁入后改法；返回 false 折算
 *  为该次 send 失败）；send 只转 in-flight，renderer 精确 ACK deliveryId+attempt
 *  后才消费；reload/crash 会重发所有未 ACK 项。 */
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
        // Re-check every item: Electron can synchronously tear down/replace a
        // window while send() crosses the native boundary（窗口身份折算见段注释）。
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
        // Only the window whose send failed may lose its handshake——单窗接缝下
        // 「当前主窗」即该窗（ready 位只由当前主窗的 trusted IPC 置位），复位
        // 安全：renderer 的有界就绪重试建立下一次握手（NOTIFICATIONS_READY 的
        // 「返回 false → 重试」语义原样保留）。
        notificationOpenDrainReady = false;
        console.error('[dsh-chamber] 通知打开推送失败，等待 renderer 重试：', describeUnknownError(error));
        return false;
      }
    }
  } finally {
    drainingNotificationOpens = false;
  }
}

/** 深链 renderer 队列 drain（design 16 hold/replay）：窗口存活、完成加载、非崩
 *  溃且 ready 位已置（App 安装 onIntent 后经 deep-link-ready 握手）→ 顺序推送；
 *  任一条件不满足 → hold。send 叶 = edges.rendererPush（W-10 S2 迁入后改法）；
 *  mid-drain 变更/失败 → rollback 保留 + ready 复位 + 返回 false（renderer 有界
 *  重试重建握手）。 */
function drainPendingRendererDeepLinkIntents(): boolean {
  const edges = deliveryEdges;
  if (edges === null) return true;
  if (drainingRendererDeepLinkIntents) return true;
  // 原门（main.ts）以 canDeliverRendererDeepLink + mainWindow===win 求值；窗口
  // 身份折算见段注释（currentWindow 恒 true——触发点全部锚定当前主窗），
  // destroyed/loading/crashed 折算为 edges 三门的取反。
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
        // Re-check every item（同通知 drain：Electron 可在 send 跨界时同步拆除/
        // 替换窗口）。
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

/** 深链 renderer 入队（hold/replay 队列；main.ts 的 open-in IPC 与深链消费循环
 *  调用——随队列迁 core，签名与语义不变）。 */
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

/** 渲染器生命周期事件（main 窗口 glue 调用——did-start-loading / closed 在
 *  createMainWindow，did-finish-load / crashed 在 installRendererRecovery；
 *  'show' 不占本入口，走 edges.onMainWindowShown；每处 glue 先做
 *  mainWindow===win 身份守卫，仅当前主窗的事件到达本入口）。 */
export type RendererLifecycleEvent = 'did-start-loading' | 'did-finish-load' | 'crashed' | 'closed';

/** ready 位挂钩收敛入口（W-10 S2）：窗口事件 → 队列状态机复位/重放，语义逐字
 *  迁自 main.ts 窗口 glue。did-start-loading 必先于页面脚本执行（ready IPC 恒在
 *  其后），顺序保证成立——复位点选在 start-loading 而非 finish-load 的原因：
 *  did-finish-load 可能被 >500ms 的慢子资源拖迟到 ready() invoke 之后，在 finish
 *  时重置会把已置位的标志 clobber 成永久 false。 */
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
    // ready() can run while late subresources still keep isLoading() true. The
    // first drain then correctly holds; finish is the deterministic replay edge.
    drainPendingRendererDeepLinkIntents();
    drainPendingNotificationOpens();
    return;
  }
  // crashed / closed：通知就绪标志立即失效（崩溃到 reload 之间没有导航事件，
  // 不重置则向死 frame 推送丢事件）+ in-flight 全部重排回待发（reload 后按
  // 原 FIFO 重发，attempt 自增使旧 document 的迟到 ACK 失效）。
  notificationOpenDrainReady = false;
  deepLinkRendererReady = false;
  pendingNotificationOpens.requeueInFlight();
  pendingRendererIntents.requeueInFlight();
}

/** 来源代际捕获代理（main.ts 的 captureVscodeSource / 插件播种所有权沿用——
 *  NotificationSourceIncarnations 实例随迁 W-10 S2）。 */
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

/** 来源证明投影（NotificationSourceProofs 实例随迁 W-10 S2；main.ts 的 registry
 *  查询/投影沿用——证明在 presentation/service/home 编辑后仍存活，renderer 生命
 *  周期退役（删除/传输身份编辑）时轮换）。 */
export function projectNotificationSourceInstances(
  instances: readonly TransportInstanceSpec[],
): ProjectedTransportInstanceSpec[] {
  return notificationSourceProofs.replaceRemoteInstances(instances);
}

// ---------------------------------------------------------------------------
// W-10 S3（registry+凭据批）：registry 读时非秘密投影链迁入（自 main.ts 的
// projectInstanceSecrets / projectInstances 局部闭包逐字搬迁，行为零变）。
// sshPasswordSet/tokenSet/passwordSet 为凭据**存在性**布尔标记（读侧只判
// null——写入口经 ssh/gateway-provider 模块直调，值绝不回读进载荷或日志）；
// secretStorage 是凭据镜像的存储模式投影（'safeStorage' | 'plaintext'）。
// main.ts 的 publishRegistryTransition（registry 生命周期 sidecar，S3 留
// main 装配侧经 ctx 注入）沿用本模块导出——S2 同款 core→main 单向依赖：
// 注册表投影先经 projectNotificationSourceInstances 挂来源证明，再经
// projectInstanceSecrets 挂凭据存在性标记。
// ---------------------------------------------------------------------------
export type ProjectedRegistryInstance = TransportInstanceSpec & {
  sshPasswordSet: boolean
  tokenSet: boolean
  passwordSet: boolean
  secretStorage: ReturnType<typeof gatewaySecretStorageMode>
}

/** 单行凭据存在性投影（设计 17 §2.3/§9.1/§13.4.1：registry 保持无凭据元数据；
 *  标记只在行当前使用的凭据维度上为 true——sshPasswordSet 仅对 SSH 传输行）。 */
export function projectInstanceSecrets(instance: TransportInstanceSpec): ProjectedRegistryInstance {
  return {
    ...instance,
    sshPasswordSet: instance.transport === 'ssh' && getSshPassword(instance.id) !== null,
    tokenSet: instance.kind === 'gateway' && getGatewayToken(instance.id) !== null,
    passwordSet: instance.kind === 'gateway' && getGatewayPassword(instance.id) !== null,
    secretStorage: gatewaySecretStorageMode(),
  };
}

/** 注册表整表读时投影（instances_get / save / delete 的返回路径——W-10 S3
 *  随迁；语义与 main.ts 原 projectInstances 完全一致）。 */
export function projectInstances(instances: readonly TransportInstanceSpec[]): ProjectedRegistryInstance[] {
  return projectNotificationSourceInstances(instances).map(projectInstanceSecrets);
}

/** 来源 registry 同步（退役权威 + 队列清理，W-10 S2）：replaceRemoteSources 后
 *  把退役 sourceId 的在途/待发事件从两条队列全部丢弃（同 id 替换绝不继承旧代际
 *  的 held 工作）；返回退役 id 集合——装配侧注册表退役路径再经
 *  edges.retireNotificationsForSources 驱逐活跃原生通知。 */
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

/** will-quit 兜底清除（design 19 §3.7）：退出在途不留 Dock 残留；曾有意图才触
 *  碰（避免无谓日志）。清空意图并调用注入的原生清除叶（main 装配侧以
 *  typeof 守卫的 app.setBadgeCount(0) 实现）。 */
export function clearBadgeIntentForQuit(applyNativeClear: () => void): void {
  // 兜底清除（退出在途不留 Dock 残留；曾有意图才触碰，避免无谓日志）。
  if (pendingBadgeCount !== null) {
    try { applyNativeClear(); } catch { /* best-effort on the way out */ }
    pendingBadgeCount = null;
  }
}

// ---------------------------------------------------------------------------
// Shell IPC registration (design 25 §4.1 seam; W-10 S1 info+settings +
// S2 notify/badge/ready + S3 registry/credentials + S4 ssh-connection-state
// batch).
//
// installIpcHandlers is the single shell-core IPC registration point: the
// Electron main only assembles it (main.ts — trustedIpc fence injected at the
// registrar wrapper, core stays electron-free by construction). Relocated
// groups, VERBATIM from main.ts with only the Electron leaves replaced by
// injected seams — behavior unchanged:
//   S1 group A — INFO / SETTINGS_GET / SETTINGS_SET registrations and their
//   settings helpers (chamberSettingsStatus / applySettingsPatch /
//   pushSettingsChanged): leaves via settingsIO / setKeepAwake / setLoginItem /
//   confirmRegistryOriginSwitch (ctx) + SETTINGS_CHANGED send via
//   edges.rendererPush. Registration order inside this function = the original
//   main.ts order; the surrounding steps of the wider W-10 plan are annotated
//   in place:
//   ① edges 回灌订阅段（S2 转实：onSystemResume / onMainWindowShown 的 core 回调
//     在此注册——held-resume 补发语义随迁 core，见上段状态机）；
//   ② A 组 3 个注册体（S1 批）+ B 组 6 个注册体（S2 批：NOTIFY /
//     NOTIFICATIONS_READY / NOTIFICATION_OPEN_ACK / BADGE_COUNT /
//     DEEP_LINK_READY / DEEP_LINK_ACK——按原 main.ts 顺序追加）+ C 组 7 个
//     注册体（S3 批：SSH_INSTANCES_GET / SSH_SAVE_CONNECTION /
//     SSH_DELETE_CONNECTION / SSH_INSTANCES_SET / SSH_SET_PASSWORD /
//     GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD——按原 main.ts 顺序追加在 B 组
//     之后；全零 Electron：事务/canonicalize/凭据写入口为纯模块直接 import，
//     装配依赖经 ctx——transportManager/audit/gatewaySessions/
//     publishRegistryTransition，见 ShellAssemblyCtx 与「W-10 S3 registry
//     投影链」段注释）+ D 组 7 个注册体（S4 批：SSH_CONFIG_LIST / SSH_CONNECT /
//     SSH_DISCONNECT / SSH_STATUS / SSH_REVERIFY / SSH_LOGS / SSH_LOGS_CLEAR
//     ——按原 main.ts 顺序追加在 C 组之后；CONFIG_LIST 经纯模块 ssh-config.ts
//     import，其余 6 个经 ctx transportManager——Pick 扩 reverify/logs/
//     clearLogs，见 ShellAssemblyCtx）；
//   ③ 自举（占位——控制面 ready 后的启动/恢复 push 与余下 drain 挂点在 W-10
//      后续批迁入，见 macos-swift-v1.md §四批 2）。
// ---------------------------------------------------------------------------

/** IPC 注册面：core 经它注册处理器（channel 为 opaque 通道名；Electron 侧
 *  装配为 `(ch, h) => ipcMain.handle(ch, trustedIpc(h))`——trustedIpc 围栏在
 *  注入点包装，Swift sidecar flavor 注入同形 B 桥注册）。 */
export interface IpcRegistrar {
  handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown): void
}

/** ShellAssemblyCtx — installIpcHandlers 装配上下文。最小集原则：只放已迁注册
 *  体与其随迁辅助实际引用的字段，后续批按需扩展（S1 → S2：增 isQuitting、移除
 *  reconcileBadgeCount——意图 holder 与裁决随 BADGE_COUNT 批迁入 core 后
 *  SETTINGS_SET 直接调 core 内 reconcile，见 installIpcHandlers ②）；S3
 *  （registry+凭据批）增 transportManager / audit / gatewaySessions /
 *  publishRegistryTransition 四字段（宿主生命周期权威仍留 main，见字段注释）；
 *  S4（ssh 连接状态批）无新字段——D 组注册体复用 transportManager（Pick 扩
 *  reverify/logs/clearLogs）与纯模块 import，见字段注释。
 *  chamber
 *  settings 的内存 holder 仍归装配侧（main.ts 尚余 20+ 处直读点，随各自批迁入时
 *  holder 一并搬家）；core 侧一律经 settingsIO 读写，权威单一、行为与搬迁前一
 *  致。各副作用叶与其 HostEdges 成员（setKeepAwake / setLoginItem /
 *  setBadge…）同名同语义——宿主腿迁入 electron-edges 时 core 无需改。 */
export interface ShellAssemblyCtx {
  /** INFO 载荷与 settings 平台投影的宿主事实。 */
  hostFacts: {
    /** 控制面 URL（原 main.ts INFO 载荷的 `http://127.0.0.1:${cp.port}`）。 */
    controlPlaneUrl: string
    /** 运行平台（原 process.platform——BADGE_COUNT 平台门 badgePlatformGate
     *  第一参同源）。 */
    platform: NodeJS.Platform
    /** 托盘恢复面存在性（SETTINGS 投影 closeToTray 门）——invoke 时求值：
     *  托盘在装配后才创建（main.ts maybeCreateTray），不得装配期定格。 */
    trayPresent(): boolean
  }
  /** INFO.dshVersion 的 dsh 运行事实（可选：未提供时 INFO 返回 null）。 */
  runtimeFacts?: {
    /** 当前活动 dsh 运行时版本——invoke 时求值，保持现语义（原 INFO 每次
     *  调用 resolveActiveRuntime(...).version：运行时重启/切换后返回新版本，
     *  绝不返回装配期定格值）。 */
    dshVersion(): string | null
  }
  /** chamber settings 状态与持久化 IO（装配侧注入现 chamber-settings 读写
   *  函数，<userData> 路径已绑定）。 */
  settingsIO: {
    /** 当前内存 holder 值（设置权威 = 装配侧内存 holder）。 */
    current(): ChamberSettings
    /** 原子替换内存 holder（applySettingsPatch 全链成功尾部调用）。 */
    commit(next: ChamberSettings): void
    /** 持久化到 <userData>/chamber-settings.json（atomic 0600）；失败 throw，
     *  由 applySettingsPatch 触发已应用副作用的回滚。 */
    persist(next: ChamberSettings): void
  }
  /** quit 在途门（design 14 D2——原 main.ts 模块级 quitRequested）：通知/深链
   *  入队的 ignore 语义与通知投递循环的退出检查经它求值（装配侧注入
   *  `() => quitRequested`；S2 起随入队/队列迁入 core 的依赖）。 */
  isQuitting(): boolean
  /** keep-awake 副作用叶（装配侧注入现 setKeepAwakeActive——HostEdges
   *  setKeepAwake 的 main.ts 宿主腿；失败 throw，由 applySettingsPatch 的
   *  catch 做 best-effort 回滚，与搬迁前语义一致）。 */
  setKeepAwake(enabled: boolean): void
  /** 登录自启副作用叶（装配侧注入现 applyLaunchAtLogin——HostEdges
   *  setLoginItem 的 main.ts 宿主腿；失败 {error} 返回，绝不 throw）。 */
  setLoginItem(enabled: boolean): { ok: true } | { ok: false; error: string }
  /** registryOrigin 切换确认对话框叶（SETTINGS_SET 现 dialog.showMessageBox
   *  腿；文案与无窗判定留在实现侧）：
   *  'confirmed' 放行；
   *  'cancelled' = 用户取消（原返回 { error: 'cancelled', code: 'cancelled' }）；
   *  'unavailable' = 无存活主窗（原返回 { error: 'native confirmation unavailable' }）。 */
  confirmRegistryOriginSwitch(
    currentOrigin: string,
    nextOrigin: string,
  ): Promise<'confirmed' | 'cancelled' | 'unavailable'>
  // —— W-10 S3（registry+凭据批）新增字段：C 组 7 注册体的装配依赖。registry
  // 读写/投影句柄（transportManager）为现实例注入；audit / gatewaySessions /
  // publishRegistryTransition 为宿主叶或宿主生命周期对象（定义仍留 main
  // 装配侧——publishRegistryTransition 的插件 seed/journal 撤销与
  // SSH_INSTANCES_CHANGED push 文本归装配侧，随后续批再迁）。W-10 S4（ssh
  // 连接状态批）不新增字段：D 组 7 注册体复用 transportManager（Pick 扩
  // reverify/logs/clearLogs，见字段注释）+ 纯模块 ssh-config.ts import。
  /** registry 读写 + transport 状态/生命周期投影句柄（C/D 组注册体直接读写
   *  面；装配侧注入 transport-manager 现实例——纯模块按引用共享，语义与搬迁
   *  前 main.ts 的 sm 局部常量一致；Pick 收窄到已迁批实际调用的方法面
   *  （W-10 S4 扩 reverify/logs/clearLogs——D 组状态/日志/重验证通道），体内
   *  以 sm 名解构以保持注册体文本逐字）。 */
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
  >
  /** S24 非秘密审计叶（原 main.ts 的 audit = appendAuditEvent({ file:
   *  auditLogPath })——装配侧绑定 <userData> 路径注入；JSONL append 只记非
   *  秘密事实，凭据值绝不入日志）。 */
  audit(event: AuditEvent): void
  /** gateway 密码会话管理器（design 17 §7.1/§9.3——主进程内存持有；C 组注册体
   *  invalidation 的直接面）。装配侧传模块级 `gatewaySessions` 的**装配期取
   *  值**：该 let 仅在 will-quit 清理置 null（届时窗口已关、IPC 处理器不可
   *  达），处理器可达期恒非空——null 分支判据与搬迁前逐字一致（有界收敛注记：
   *  同一 will-quit 竞态下原直读闭包可见 null 而装配捕获不可见的路径不可达）。 */
  gatewaySessions: GatewaySessionManager | null
  /** registry 变更生命周期权威 sidecar（main-branch source-lifecycle
   *  authority：来源证明/代际同步 + 插件 seed/journal 撤销 + 活跃通知退役驱逐
   *  + SSH_INSTANCES_CHANGED committed push 编排）——S3 留 main 装配侧经本叶
   *  注入（其宿主对象 readySeedEdges/hostPackageSeeding/sshPluginJournal/
   *  setGatewaySyncRegistration/startAutomaticHostSeed 归装配侧，push 文本被
   *  renderer-trust 锚定），C 组 save/delete 注册体经它发布 committed 结果。 */
  publishRegistryTransition(
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ): ProjectedRegistryInstance[]
}

/** 装配 shell IPC 面（W-10 S1 A 组 + S2 B 组 + S3 C 组 + S4 D 组注册体与随迁
 *  辅助；各组注册顺序 = 原 main.ts 顺序）。edges 参数以 Pick 收窄到本批实际
 *  调用的成员（createElectronEdges 返回同形超集）；后续批实现新成员时同步
 *  扩宽两侧。
 *  调用点纪律：whenReady 内、createMainWindow 之前（窗口加载前注册完毕）——
 *  本函数同时完成渲染器投递状态机的 edges/quit 快照（单装配不变式，见上段）。 */
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
  >
  ctx: ShellAssemblyCtx
}): void {
  // 单装配不变式（渲染器投递状态机段注释）：快照投递 edges 子集与 quit 门——
  // 本函数先于任何窗口/渲染器事件执行（调用点纪律见上），此后 onRendererLifecycle /
  // enqueueRendererDeepLinkIntent / handleSystemResume 等导出入口可用。
  deliveryEdges = {
    rendererPush: deps.edges.rendererPush,
    mainWindowAlive: deps.edges.mainWindowAlive,
    webViewLoading: deps.edges.webViewLoading,
    webViewContentAlive: deps.edges.webViewContentAlive,
  };
  quittingLeaf = deps.ctx.isQuitting;
  const {
    hostFacts,
    settingsIO,
    setKeepAwake,
    setLoginItem,
    confirmRegistryOriginSwitch,
    // W-10 S3（registry+凭据批）：transportManager → sm（与搬迁前 main.ts 的
    // sm 局部常量同名，C 组注册体文本逐字保留）；W-10 S4 的 D 组（ssh 连接
    // 状态 7 注册体）同用该句柄（Pick 扩 reverify/logs/clearLogs）。audit /
    // gatewaySessions / publishRegistryTransition 为装配侧宿主叶（定义在 main，
    // 经 ctx 注入）。
    transportManager: sm,
    audit,
    gatewaySessions,
    publishRegistryTransition,
  } = deps.ctx

  // ① edges 回灌订阅段（S2 转实）：OS 唤醒与主窗口 'show' 的事件源语义自 main.ts
  //    逐字迁入，订阅点统一走本函数单点——held lastResume 补发在 core（上段状态
  //    机）。notifyClicked（Swift B flavor 对应面）留后续批。
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

  /** 设置变更推送（SETTINGS_CHANGED send 源）：committed-push 包装 +
   *  rendererPush 叶。叶返回 false = 无存活主窗（含窗口在 push 前已被关/换的
   *  竞态），折算为 push 失败并 loud——与搬迁前「throw → {sent:false}」语义
   *  等价（S0 四个 committed 状态 push 同款形状）；无窗口常驻期间由下次查询
   *  兜底。 */
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

  /** 应用一个已校验的设置 patch（design 14 D7）：先应用副作用（keep-awake /
   *  登录自启），**全部成功并持久化成功后才更新 holder**——任何失败 loud 返回
   *  {error} 并回滚已应用的副作用（绝不落半个设置、绝不内存与磁盘不一致）。
   *  windowCloseBehavior 无副作用（影响未来的 close 事件）。副作用叶与持久化
   *  均经 ctx 注入（main 宿主腿）；回滚路径读 current()——commit 只在全链
   *  成功尾部发生，回滚时 current() 恒为旧值，与搬迁前 holder 语义一致。 */
  function applySettingsPatch(patch: Partial<ChamberSettings>): { ok: true } | { ok: false; error: string } {
    // notifications / sessionTodo 是嵌套对象：patch 可能只带部分子键
    // （validatePatch 允许 partial），必须 deep-merge 到当前值，绝不整组
    // 替换丢开关。
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
    // 副作用应用包 try：keep-awake / 登录自启叶意外抛异常时 loud 失败并
    // best-effort 回滚 keepAwake，绝不带病继续（绝不落半个设置）。
    try {
      if (patch.keepAwake !== undefined) setKeepAwake(patch.keepAwake);
      if (patch.launchAtLogin !== undefined) {
        const result = setLoginItem(patch.launchAtLogin);
        if (!result.ok) {
          // 副作用失败：回滚已应用的 keepAwake（保持原状），绝不持久化。
          if (patch.keepAwake !== undefined) setKeepAwake(current.keepAwake);
          return result;
        }
      }
    } catch (error) {
      console.error('[dsh-chamber] 应用 chamber 设置副作用失败：', error);
      try {
        if (patch.keepAwake !== undefined) setKeepAwake(current.keepAwake);
      } catch {
        // 回滚失败也 loud 已记日志，不再叠加异常。
      }
      return { ok: false, error: 'settings apply failed' };
    }
    try {
      settingsIO.persist(next);
    } catch (error) {
      console.error('[dsh-chamber] 写入 chamber 设置失败：', error);
      // 持久化失败：回滚已应用的副作用，holder 保持旧值——内存/磁盘/实际行为一致。
      if (patch.keepAwake !== undefined) setKeepAwake(current.keepAwake);
      if (patch.launchAtLogin !== undefined) {
        const rollback = setLoginItem(current.launchAtLogin);
        if (!rollback.ok) console.error(`[dsh-chamber] 登录自启回滚失败：${rollback.error}`);
      }
      return { ok: false, error: 'settings persist failed' };
    }
    settingsIO.commit(next);
    return { ok: true };
  }

  /** 平台门 + 宿主 apply 的 core 侧编排（E5——「平台门与裁决留 core（badge.ts）」）：
   *  badgePlatformGate(platform, edges.badgeCountApiAvailable()) 先裁决
   *  （win32 的专属平台原因在此区分），supported 后才经 edges.setBadge apply。
   *  unsupported 与 apply 失败各压成一次 loud（badgeUnsupportedLogged /
   *  badgeApplyErrorLogged——防重复推送刷屏）。 */
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

  /** 按当前设置重新裁决最近一次 renderer 计数意图（设置切换后的即时收敛——
   *  SETTINGS_SET 的 badgeEnabled 翻转收敛点；S2 起 holder/裁决随 BADGE_COUNT
   *  迁入本函数，S1 的 ctx.reconcileBadgeCount 注入叶移除）。 */
  function reconcileBadgeCount(): void {
    if (pendingBadgeCount === null) return;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      pendingBadgeCount,
    );
    applyBadgePresentation(count);
  }

  /** 桌面原生通知主链路（design 19 §3.3；W-10 S2 迁入——宿主腿全在
   *  electron-edges：构造/登记/淘汰/click 腿/honest-show 结算 = showNativeNotification、
   *  能力探测 = notificationSupported、焦点事实 = isFocused）：payload 白名单 →
   *  平台支持 → 设置裁决 → 有界 claim / 全局速率 → 显示。返回是否收到原生
   *  `show` 事件（异步 failed/close/timeout 均为 false）。'test' 绕过 claim 与
   *  设置门禁，但仍受全局宿主预算约束；通知失败降级且 loud，不误报成功，会话业
   *  务/侧边栏蓝点不受影响。 */
  async function maybeShowNativeNotification(payload: unknown): Promise<boolean> {
    const validated = validateNotificationRequest(payload);
    if (!validated.ok) {
      console.warn(`[dsh-chamber] 拒绝非法通知 payload：${validated.error}`);
      return false;
    }
    const request = validated.request;
    // 设置权威在装配侧内存 holder（settingsIO.current——settings-set 即时更新）；
    // 旧文件缺字段时用 DEFAULT 兜底（normalizeSettings 已归一，此处仅防御）。
    const settings: NotificationSettingsLike = {
      ...DEFAULT_CHAMBER_SETTINGS.notifications,
      ...(settingsIO.current().notifications ?? {}),
    };
    // 搬迁差异注记：原 readNotificationHostBoolean 区分「探测异常（拒发）」与
    // 「未聚焦」；接缝下 isFocused 由实现侧保证异常安全恒 boolean（单窗守卫内
    // isVisible/isFocused 探测不可达异常），两态同值——有意收敛，注释于
    // electron-edges isFocused。
    const anyWindowFocused = deps.edges.isFocused();
    const decision = decideNotification({
      request,
      settings,
      anyWindowFocused,
    });
    if (decision.action === 'skip') return false;
    if (!notificationSourceIncarnations.matches(request.sourceId, request.sourceFingerprint)) {
      console.warn(`[dsh-chamber] 通知来源 fingerprint 已过期：${request.sourceId}`);
      return false;
    }
    const sourceToken = request.kind === 'test' ? null : notificationSourceIncarnations.capture(request.sourceId);
    if (request.kind !== 'test' && sourceToken === null) {
      console.warn(`[dsh-chamber] 通知来源已不在当前 registry：${request.sourceId}`);
      return false;
    }
    // A disabled/kind/focus decision is terminal before consulting the host.
    // Unsupported-platform logging should describe an actual show attempt, not
    // every deliberately suppressed renderer edge（notificationSupported 探测失败
    // 与不支持同值——实现侧异常安全；与搬迁前区分「探测失败」消息的有意收敛）。
    if (!deps.edges.notificationSupported()) {
      console.warn('[dsh-chamber] 通知裁决跳过：平台不支持原生通知');
      return false;
    }
    // 去重 claim（5s TTL）：防同一事件双路径/重放双发；'test' 不走 claim。
    // 顺序在裁决之后：被设置/焦点跳过的请求不消费去重槽（design 19 §3.3）。
    const claim = claimNotificationDetailed(request);
    if (!claim.accepted) {
      if (claim.reason === 'saturated') {
        console.warn('[dsh-chamber] 通知去重窗口已达硬上限，拒绝新通知');
      }
      return false;
    }
    if (!nativeNotificationRateLimiter.tryAcquire()) {
      releaseNotificationClaim(claim.token);
      console.warn('[dsh-chamber] 原生通知发送速率达到硬上限，拒绝新通知');
      return false;
    }
    // 宿主腿（构造 + 有界登记/淘汰 + click 腿 + honest-show 结算全在实现侧，
    // B4——见 HostEdges.showNativeNotification 注释）：实现侧不 throw，shown 结
    // 算后 core 释放 claim 并如实返回 IPC 结果。
    const clickRoute = sourceToken === null
      ? null
      : {
        token: sourceToken,
        // click 回灌（宿主先 activate/restore/focus 成功才回调本闭包）：代际复
        // 查（旧来源代际的 click 不回灌同 id 替换后的新 shell）后入队打开意图。
        onActivated: () => {
          if (!notificationSourceIncarnations.owns(sourceToken)) {
            console.warn(`[dsh-chamber] 忽略旧来源代际的通知点击：${request.sourceId}`);
            return;
          }
          enqueueNotificationOpen(sourceToken, request.sessionId);
        },
      };
    const handle = deps.edges.showNativeNotification(
      { title: request.title, body: request.body },
      clickRoute,
    );
    const outcome = await handle.shown;
    if (!outcome.shown) {
      releaseNotificationClaim(claim.token);
      console.warn(`[dsh-chamber] 原生通知显示失败：${outcome.error}`);
      return false;
    }
    return true;
  }

  // ② A 组 3 个注册体（S1 迁自 main.ts；trustedIpc 围栏由装配侧在 ipc 注入点
  //    包装，本文件零 electron）+ B 组 6 个注册体（S2 批，按原 main.ts 顺序追加）。
  // 桌面身份/版本信息（dsh-chamber:info）：控制面 URL + 平台为宿主事实，
  // shell 版本为模块自读（与 main.ts 同源 package.json），dshVersion 即时
  // 解析（ctx.runtimeFacts）。
  deps.ipc.handle(IPC_CHANNELS.INFO, () => ({
    controlPlaneUrl: hostFacts.controlPlaneUrl,
    dshVersion: deps.ctx.runtimeFacts?.dshVersion() ?? null,
    version,
    platform: hostFacts.platform,
  }));

  // Chamber settings 查询：非秘密投影（当前值 + 平台能力门控）。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_GET, () => chamberSettingsStatus());

  // Chamber settings 应用并持久化 + 变更推送。失败 loud {error}，绝不静默假成功。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_SET, async (payload: unknown) => {
    const { patch } = payload as { patch?: unknown };
    const validated = validatePatch(patch);
    if (!validated.ok) return { error: validated.error };
    // Switching the dsh runtime version source moves the trust boundary of
    // version checks/downloads/installs — require native user confirmation
    // (design 18) before applying the patch.
    const currentSettings = settingsIO.current();
    const nextOrigin = validated.patch.registryOrigin;
    if (nextOrigin !== undefined && nextOrigin !== currentSettings.registryOrigin) {
      const verdict = await confirmRegistryOriginSwitch(currentSettings.registryOrigin, nextOrigin);
      if (verdict === 'unavailable') return { error: 'native confirmation unavailable' };
      if (verdict !== 'confirmed') return { error: 'cancelled', code: 'cancelled' };
    }
    const applied = applySettingsPatch(validated.patch);
    if (!applied.ok) return applied;
    // badgeEnabled 翻转的即时收敛：仅在本次 patch 实际携带该键时重新裁决
    // 最近一次 renderer 计数意图（关闭 → 立即清零；开启 → 恢复当前未读数），
    // 绝不等到下一次推送；无关设置变更不重发 setBadgeCount。
    if (validated.patch.notifications?.badgeEnabled !== undefined) {
      reconcileBadgeCount();
    }
    pushSettingsChanged();
    return chamberSettingsStatus();
  });

  // —— B 组（S2 批；W-10 S2 施工图第 1 项）——
  // 桌面通知（design 19 §3.3）：渲染端检测会话边沿并组装 payload → notify
  // （invoke，返回是否实际显示）→ 主进程白名单/去重/裁决 + 原生通知。
  // 载荷形状 = 原 main.ts 的 trustedIpc(({ payload }) => …)——invoke 实参对象
  // 解构在处理器内完成（registrar 处理器只收单参 unknown）。
  deps.ipc.handle(IPC_CHANNELS.NOTIFY, (payload: unknown) =>
    maybeShowNativeNotification((payload as { payload?: unknown }).payload));
  // Renderer 通知就绪信号（design 19 §3.3）：onOpen 监听注册后调用——通知点击
  // 的推送只在就绪后放行（did-finish-load 早于监听注册，见 drain 条件）。
  // 返回 true 与 preload 的 Promise<boolean> 声明一致（成功置位信号）。
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATIONS_READY, () => {
    notificationOpenDrainReady = true;
    const drainAccepted = drainPendingNotificationOpens();
    // A send race revokes ready inside the drain. Returning false makes the
    // renderer's bounded readiness retry establish the next handshake.
    return drainAccepted && notificationOpenDrainReady;
  });
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATION_OPEN_ACK, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return false;
    const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
    return pendingNotificationOpens.acknowledge(deliveryId as number, attempt as number);
  });
  // 未读徽标计数（design 19 §3.7）：renderer 推真实计数（0 = 清除）→ 白名单
  // 校验 → 记录意图 → 设置裁决（badgeEnabled）→ 平台门 + edges.setBadge。
  // 返回是否实际应用；渲染端静默容忍 false（主进程已 loud 记平台/失败原因）。
  deps.ipc.handle(IPC_CHANNELS.BADGE_COUNT, (payload: unknown) => {
    const validated = validateBadgeRequest(payload);
    if (!validated.ok) {
      console.error(`[dsh-chamber] 徽标计数请求校验失败：${validated.error}`);
      return false;
    }
    pendingBadgeCount = validated.count;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      validated.count,
    );
    return applyBadgePresentation(count);
  });
  // Deep-link renderer readiness (design 16 hold/replay): App invokes this
  // only after installing deepLink.onIntent. Successful cold-start launches
  // held before that point are replayed now; navigation/crash resets the bit.
  deps.ipc.handle(IPC_CHANNELS.DEEP_LINK_READY, () => {
    deepLinkRendererReady = true;
    const drainAccepted = drainPendingRendererDeepLinkIntents();
    return drainAccepted && deepLinkRendererReady;
  });
  deps.ipc.handle(IPC_CHANNELS.DEEP_LINK_ACK, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return false;
    const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
    return pendingRendererIntents.acknowledge(deliveryId as number, attempt as number);
  });

  // —— C 组（S3 批；W-10 S3 施工图第 1 项）——
  // registry + 凭据 7 注册体（按原 main.ts 顺序紧接 B 组追加；注册体与下述纯
  // 辅助自 main.ts 逐字迁入，全零 Electron）。trustedIpc 围栏由装配侧在
  // registrar 注入点包装；事务（connection-save）/ canonicalize
  // （transport-provider）/ 凭据写入口（ssh/gateway-provider）与 session origin
  // 纯函数（gateway-session*）为 electron-free 纯模块直接 import。凭据
  // write-only 语义与「绝不回读」纪律保持：读侧只判存在性（!== null），值绝不
  // 进入载荷/日志。装配依赖经 ctx：sm = transportManager 句柄（registry 读写
  // + 状态/生命周期投影）、audit（S24 审计叶）、gatewaySessions（会话
  // invalidation 宿主面）、publishRegistryTransition（registry 变更生命周期
  // sidecar——宿主对象与 SSH_INSTANCES_CHANGED push 文本留 main，本组注册体
  // 经 ctx 调用）。
  /** The gateway-session origin for a registered instance (design 17 §9.3
   * per-origin session key): scheme from `insecureHttp`, explicit port —
   * URL.origin normalizes default-port elision, so the cache key matches
   * the registration baseUrl and the provider's probe origin. */
  function gatewayOriginFor(spec: TransportInstanceSpec): GatewaySessionOrigin {
    return {
      baseUrl: `${spec.insecureHttp ? 'http' : 'https'}://${spec.host}:${spec.remotePort}`,
      insecureHttp: spec.insecureHttp,
      scope: gatewaySessionScopeForConnection(spec),
    };
  }

  const normalizeConnectionInput = (candidate: TransportInstanceInput): TransportInstanceSpec | null => {
    if (candidate === null || typeof candidate !== 'object') return null;
    const canonical = canonicalizeTransportInstanceInput(candidate) as TransportInstanceInput;
    if (canonical.transport === 'ssh') return sshProvider.validateSpec(canonical);
    if (canonical.transport === 'http') return gatewayProvider.validateSpec(canonical);
    return null;
  };

  deps.ipc.handle(IPC_CHANNELS.SSH_INSTANCES_GET, () =>
    projectInstances(sm.listInstances())
  );
  /**
   * Main-owned ADD/EDIT transaction for registry metadata plus every
   * applicable write-only credential dimension. The renderer sends only
   * NEW values; old values are snapshotted and compensated here, where
   * they can never cross IPC. connection-save.ts stops the old live
   * transport, writes binding-guarded secrets, writes metadata last, and
   * restores every store plus metadata on any ordinary failure. Exact-id
   * deletion has its own transaction/channel; legacy instances_set below
   * accepts only an unchanged no-op roster.
   */
  deps.ipc.handle(IPC_CHANNELS.SSH_SAVE_CONNECTION, (payload: unknown) => {
    const before = sm.listInstances();
    const currentProjected = () => projectInstances(sm.listInstances());
    const refuse = (error: string) => ({
      ok: false as const,
      instances: currentProjected(),
      error,
      metadataCommitted: false,
    });
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return refuse('invalid connection save payload');
    }
    const record = payload as Record<string, unknown>;
    const previousId = record.previousId;
    if (previousId !== null && (typeof previousId !== 'string' || !INSTANCE_ID_PATTERN.test(previousId))) {
      return refuse('invalid or unknown connection id');
    }
    if (record.input === null || typeof record.input !== 'object' || Array.isArray(record.input)) {
      return refuse('invalid connection metadata');
    }
    if (record.credentials === null || typeof record.credentials !== 'object' || Array.isArray(record.credentials)) {
      return refuse('invalid connection credentials payload');
    }
    const credentialRecord = record.credentials as Record<string, unknown>;
    const allowedCredentialKeys = new Set(['sshPassword', 'gatewayToken', 'gatewayPassword']);
    if (Object.keys(credentialRecord).some(key => !allowedCredentialKeys.has(key))) {
      return refuse('invalid connection credentials payload');
    }
    for (const key of allowedCredentialKeys) {
      const value = credentialRecord[key];
      if (value !== undefined && typeof value !== 'string') {
        return refuse('invalid connection credentials payload');
      }
    }
    const credentials = credentialRecord as ConnectionCredentialMutations;
    const input = record.input as TransportInstanceInput;
    const normalized = normalizeConnectionInput(input);
    if (normalized === null) return refuse('invalid connection metadata');
    const sshPassword = credentials.sshPassword === '' ? undefined : credentials.sshPassword;
    const gatewayToken = credentials.gatewayToken === '' ? undefined : credentials.gatewayToken;
    const gatewayPassword = credentials.gatewayPassword === '' ? undefined : credentials.gatewayPassword;
    if (sshPassword !== undefined) {
      if (sshPassword.length > MAX_SSH_PASSWORD_CHARS) {
        return refuse(`SSH password is limited to ${MAX_SSH_PASSWORD_CHARS} characters`);
      }
      if (!sshPasswordSupported()) {
        // design 21 C15: Windows 密码认证不可用(askpass 需 PE 可执行)——门控
        // 拒绝并给出主路径引导(密钥 / ssh-agent / Pageant)。
        return refuse('SSH password auth is not supported on Windows yet — use a key or ssh-agent (Pageant) instead');
      }
    }
    const tokenError = gatewayTokenValidationError(gatewayToken ?? null);
    if (tokenError !== null) return refuse(tokenError);
    const passwordError = gatewayPasswordValidationError(gatewayPassword ?? null);
    if (passwordError !== null) return refuse(passwordError);

    const previous = typeof previousId === 'string'
      ? sm.listInstances().find(instance => instance.id === previousId) ?? null
      : null;
    const previousReadyUrl = typeof previousId === 'string' ? sm.readyUrl(previousId) : null;
    const invalidateGatewaySessionsFor = (spec: TransportInstanceSpec | null, readyUrl: string | null): void => {
      if (spec === null || spec.kind !== 'gateway') return;
      if (gatewaySessions === null) throw new Error('gateway session manager is unavailable');
      if (spec.transport === 'http') gatewaySessions.invalidate(gatewayOriginFor(spec));
      if (spec.transport === 'ssh') gatewaySessions.invalidateScope(gatewaySessionScopeForConnection(spec));
      if (readyUrl !== null) {
        const liveOrigin = gatewaySessionOriginForUrl(
          readyUrl,
          spec.spkiPin ?? undefined,
          spec.transport === 'ssh' ? gatewayTunnelAuthority(spec.remotePort) : undefined,
          gatewaySessionScopeForConnection(spec),
        );
        if (liveOrigin === null) throw new Error('invalid ready gateway session origin');
        gatewaySessions.invalidate(liveOrigin);
      }
    };
    const invalidateOldAndCurrentSessions = (): void => {
      invalidateGatewaySessionsFor(previous, previousReadyUrl);
      const current = sm.listInstances().find(instance => instance.id === normalized.id) ?? null;
      invalidateGatewaySessionsFor(current, sm.readyUrl(normalized.id));
    };

    const result = saveConnectionTransaction({
      listInstances: () => sm.listInstances(),
      normalize: normalizeConnectionInput,
      saveInstances: instances => sm.saveInstances(instances),
      getSshPassword,
      getGatewayToken,
      getGatewayPassword,
      setSshPassword: (id, value, bindingSpec) => setSshPassword(id, value, bindingSpec),
      setGatewaySecrets: (id, token, password, bindingSpec) => setInstanceSecrets(id, token, password, bindingSpec),
      invalidateGatewaySessions: (oldSpec, nextSpec) => {
        invalidateGatewaySessionsFor(oldSpec, previousReadyUrl);
        if (nextSpec !== null) invalidateGatewaySessionsFor(nextSpec, null);
      },
      isActive: id => {
        const status = sm.status(id);
        return status !== null && status.phase !== 'idle';
      },
      disconnect: id => { sm.disconnect(id); },
      connect: id => {
        // Password/session state must be invalidated before the replacement
        // live gateway verifies; otherwise a credential edit could briefly
        // reuse the old cached Cookie.
        invalidateOldAndCurrentSessions();
        sm.connect(id);
      },
    }, {
      previousId: previousId as string | null,
      input,
      credentials: { sshPassword, gatewayToken, gatewayPassword },
    });
    if (!result.ok) {
      const instances = result.metadataCommitted
        ? publishRegistryTransition(before, result.instances)
        : projectInstances(result.instances);
      return { ...result, instances };
    }

    if (result.changes.gatewayPassword) invalidateOldAndCurrentSessions();
    const credentialAudits: Array<[boolean, string, boolean]> = [
      [result.changes.sshPassword, 'ssh_password', getSshPassword(normalized.id) !== null],
      [result.changes.gatewayToken, 'token', getGatewayToken(normalized.id) !== null],
      [result.changes.gatewayPassword, 'password', getGatewayPassword(normalized.id) !== null],
    ];
    for (const [changed, detail, isSet] of credentialAudits) {
      if (!changed) continue;
      audit({
        ts: new Date().toISOString(),
        event: isSet ? 'credential_set' : 'credential_cleared',
        sourceId: normalized.id,
        kind: normalized.kind,
        transport: normalized.transport,
        detail,
      });
    }
    return { ok: true as const, instances: publishRegistryTransition(before, result.instances) };
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_DELETE_CONNECTION, (payload: unknown) => {
    const { id } = payload as { id?: unknown };
    const before = sm.listInstances();
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      console.warn('[dsh-chamber] desktop_ssh_delete_connection: invalid id refused');
      return projectInstances(before);
    }
    const result = deleteConnectionTransaction({
      listInstances: () => sm.listInstances(),
      saveInstances: next => sm.saveInstances(next),
      getSshPassword,
      getGatewayToken,
      getGatewayPassword,
      setSshPassword: (id, value, bindingSpec) => setSshPassword(id, value, bindingSpec),
      setGatewaySecrets: (id, token, password, bindingSpec) => setInstanceSecrets(id, token, password, bindingSpec),
      invalidateGatewaySessions: spec => {
        if (gatewaySessions === null) throw new Error('gateway session manager is unavailable');
        if (spec.transport === 'http') gatewaySessions.invalidate(gatewayOriginFor(spec));
        if (spec.transport === 'ssh') gatewaySessions.invalidateScope(gatewaySessionScopeForConnection(spec));
        const readyUrl = sm.readyUrl(spec.id);
        if (readyUrl !== null) {
          const liveOrigin = gatewaySessionOriginForUrl(
            readyUrl,
            spec.spkiPin ?? undefined,
            spec.transport === 'ssh' ? gatewayTunnelAuthority(spec.remotePort) : undefined,
            gatewaySessionScopeForConnection(spec),
          );
          if (liveOrigin === null) throw new Error('invalid ready gateway session origin');
          gatewaySessions.invalidate(liveOrigin);
        }
      },
      isActive: id => {
        const status = sm.status(id);
        return status !== null && status.phase !== 'idle';
      },
      disconnect: id => { sm.disconnect(id); },
      connect: id => { sm.connect(id); },
    }, id);
    if (!result.ok) {
      console.error(`[dsh-chamber] desktop_ssh_delete_connection transaction failed: ${result.error}`);
      return result.metadataCommitted
        ? publishRegistryTransition(before, result.instances)
        : projectInstances(result.instances);
    }
    return publishRegistryTransition(before, result.instances);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_INSTANCES_SET, (payload: unknown) => {
    const instances = payload;
    if (!Array.isArray(instances)) {
      console.warn('[dsh-chamber] desktop_ssh_instances_set: non-array input refused');
      return projectInstances(sm.listInstances());
    }
    const before = sm.listInstances();
    // Compatibility channel is exact no-op only. Full-roster deletion is a
    // stale read-modify-write primitive (delete A + concurrent add C could
    // accidentally delete C); production deletion is id-addressed through
    // desktop_ssh_delete_connection, while add/edit use save_connection.
    const normalized = validateDeleteOnlyReplacement(before, instances, normalizeConnectionInput);
    if (normalized === null) {
      console.warn('[dsh-chamber] desktop_ssh_instances_set: only an exact unchanged no-op roster is allowed');
    }
    return projectInstances(before);
  });
  // Legacy explicit SSH-password CLEAR action. Non-empty writes are owned
  // exclusively by desktop_ssh_save_connection so metadata + all credential
  // domains share one compensated transaction.
  deps.ipc.handle(IPC_CHANNELS.SSH_SET_PASSWORD, (payload: unknown) => {
    const { id, password } = payload as { id?: unknown; password?: unknown };
    const spec = typeof id === 'string'
      ? sm.listInstances().find(instance => instance.id === id)
      : undefined;
    const clearing = password === null || password === '';
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || spec === undefined
      || (password !== null && typeof password !== 'string')) {
      return { error: 'invalid or unknown instance id' };
    }
    if (!clearing) return { error: 'desktop_ssh_set_password is clear-only; use desktop_ssh_save_connection to set credentials' };
    // Clearing remains available on platforms where accepting a new SSH
    // password is unsupported; non-empty writes never reach this handler.
    try {
      // Rebuild only a live SSH transport so it stops using the cleared
      // transport credential. Gateway/http transports are unaffected.
      // S24 audit records only the credential kind, never its value.
      const hadPassword = getSshPassword(id) !== null;
      commitTransportCredentialUpdate(sm, id, status => status.transport === 'ssh', () => {
        setSshPassword(id, null, null);
      });
      if (hadPassword) {
        audit({
          ts: new Date().toISOString(),
          event: 'credential_cleared',
          sourceId: id,
          kind: spec.kind,
          transport: spec.transport,
          detail: 'ssh_password',
        });
      }
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Legacy explicit gateway-token CLEAR action. Non-empty writes use the
  // authoritative save_connection transaction above.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_TOKEN, (payload: unknown) => {
    const { id, token } = payload as { id?: unknown; token?: unknown };
    const spec = typeof id === 'string'
      ? sm.listInstances().find(instance => instance.id === id)
      : undefined;
    const clearing = token === null || token === '';
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || spec === undefined
      || (token !== null && typeof token !== 'string')) {
      return { error: 'invalid or unknown instance id' };
    }
    if (!clearing) return { error: 'desktop_gateway_set_token is clear-only; use desktop_ssh_save_connection to set credentials' };
    try {
      // Revoke the currently registered Authorization header BEFORE
      // clearing the token. disconnect() synchronously emits the old
      // gateway idle projection, so the control plane unregisters
      // gateway:<id> before a replacement transport can register.
      // S24 audit names the credential kind, never its value.
      const hadToken = getGatewayToken(id) !== null;
      commitTransportCredentialUpdate(sm, id, status => status.kind === 'gateway', () => {
        setGatewayToken(id, null, null);
      });
      if (hadToken) {
        audit({
          ts: new Date().toISOString(),
          event: 'credential_cleared',
          sourceId: id,
          kind: spec.kind,
          transport: spec.transport,
          detail: 'token',
        });
      }
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Legacy explicit gateway-password CLEAR action. It also invalidates the
  // corresponding cached sessions; non-empty writes use save_connection.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_PASSWORD, (payload: unknown) => {
    const { id, password } = payload as { id?: unknown; password?: unknown };
    const spec = typeof id === 'string'
      ? sm.listInstances().find(instance => instance.id === id)
      : undefined;
    const clearing = password === null || password === '';
    // Same id whitelist + registry-existence gate as the token clear.
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || spec === undefined
      || (password !== null && typeof password !== 'string')) {
      return { error: 'invalid or unknown instance id' };
    }
    if (!clearing) return { error: 'desktop_gateway_set_password is clear-only; use desktop_ssh_save_connection to set credentials' };
    try {
      // Clearing a password invalidates every cached login session before
      // the target can reconnect. Both direct and SSH origins are owned by
      // the exact connection/target scope across historical local ports.
      if (gatewaySessions === null) throw new Error('gateway session manager is unavailable');
      if (spec.transport === 'http') gatewaySessions.invalidate(gatewayOriginFor(spec));
      if (spec.transport === 'ssh') gatewaySessions.invalidateScope(gatewaySessionScopeForConnection(spec));
      const liveReadyUrl = sm.readyUrl(id);
      if (liveReadyUrl !== null) {
        const tunnelAuthority = spec.transport === 'ssh'
          ? gatewayTunnelAuthority(spec.remotePort)
          : undefined;
        const liveOrigin = gatewaySessionOriginForUrl(
          liveReadyUrl,
          spec.spkiPin ?? undefined,
          tunnelAuthority,
          gatewaySessionScopeForConnection(spec),
        );
        if (liveOrigin === null) throw new Error('invalid ready gateway session origin');
        gatewaySessions.invalidate(liveOrigin);
      }
      // Same disconnect-before-clear discipline as the token handler: a
      // live gateway target is rebuilt without the removed credential.
      // S24 audit never records the password value.
      const hadPassword = getGatewayPassword(id) !== null;
      commitTransportCredentialUpdate(sm, id, status => status.kind === 'gateway', () => {
        setGatewayPassword(id, null, null);
      });
      if (hadPassword) {
        audit({
          ts: new Date().toISOString(),
          event: 'credential_cleared',
          sourceId: id,
          kind: spec.kind,
          transport: spec.transport,
          detail: 'password',
        });
      }
      return { ok: true };
    } catch (error) {
      return { error: describeUnknownError(error) };
    }
  });

  // —— D 组（S4 批；W-10 S4 施工图第 1 项）——
  // ssh 连接状态 7 注册体（按原 main.ts 顺序紧接 C 组追加；注册体自 main.ts
  // 逐字迁入，全零 Electron）。trustedIpc 围栏由装配侧在 registrar 注入点
  // 包装。CONFIG_LIST：~/.ssh/config 非秘密投影（alias/hostName/user/port——
  // keys/proxies/credentials 绝不离开主进程），经纯模块 ssh-config.ts 的
  // discoverSshConfigHosts 直接 import（原注释随迁）；CONNECT / DISCONNECT /
  // STATUS / REVERIFY / LOGS / LOGS_CLEAR 全走 ctx 注入的 transportManager
  // 句柄（sm；Pick 面扩 reverify/logs/clearLogs，见 ShellAssemblyCtx）。
  // status/logs 的非秘密投影纪律保持（localPort/phase 等元数据可读；URL/密钥
  // 绝不进投影/载荷/日志——main.ts 原注释语义随迁保留）。
  // ~/.ssh/config discovery (design 05 §5): non-secret host projections only
  // (alias/hostName/user/port) — keys/proxies/credentials never leave the
  // main process.
  deps.ipc.handle(IPC_CHANNELS.SSH_CONFIG_LIST, () => discoverSshConfigHosts());
  deps.ipc.handle(IPC_CHANNELS.SSH_CONNECT, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.connect(id);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_DISCONNECT, (payload: unknown) => {
    const { id } = payload as { id: string };
    sm.disconnect(id);
    return sm.status(id);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_STATUS, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.status(id);
  });
  // On-demand ready-state re-verification (user activation of a source/
  // session): one immediate identity probe for a READY transport — a dead
  // gateway session or remote endpoint flips the phase within one probe
  // round-trip instead of waiting for the periodic heartbeat (transport-
  // manager reverify; see READY_VERIFY_INTERVAL_MS).
  deps.ipc.handle(IPC_CHANNELS.SSH_REVERIFY, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.reverify(id);
  });
  // 环形日志读/清（transport-manager ring buffer）：LOGS 返回有界环形日志
  // （非秘密——logSummary 等元数据；URL/密钥纪律同 status 投影），LOGS_CLEAR
  // 清空该实例环形日志。
  deps.ipc.handle(IPC_CHANNELS.SSH_LOGS, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.logs(id);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_LOGS_CLEAR, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.clearLogs(id);
  });

  // ③ 自举（W-10 后续批占位：控制面 ready 后的启动/恢复 push、余下 drain 挂点
  //    迁入点——见 macos-swift-v1.md §四批 2）。
}
