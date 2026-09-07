/**
 * dsh-chamber desktop shell core (design 25 §4.1; W-09 batch 1).
 *
 * Electron-free business logic mechanically relocated from main.ts — the
 * zero-seam phase of the P1 split (companion 四批 1): pure moves plus the
 * single documented parameterization, no semantic rewrites, no state-machine
 * reordering. The Electron main process imports these functions and constants
 * by their original names; a later seam batch (W-10) and the Swift-native
 * flavor reuse the same core.
 *
 * Hard invariants:
 * - Electron-free by construction: never import the electron package (W-14
 *   face A gate); no IPC registration, no renderer push channels and no bare
 *   channel literals — IPC ownership stays in main.ts until the seam batch.
 * - Host state is parameterized: userData-scoped paths and the runtime base
 *   dir arrive as arguments (resolveActiveRuntime / the path templates), argv
 *   arrives as an argument (scanDeepLinkUrls); nothing reads Electron host
 *   state implicitly.
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
 * 中文说明：自 main.ts 机械搬运的 Electron-free 业务核心（零缝阶段，行为零
 * 变化）；Electron 边沿与 IPC 注册仍留在 main.ts，seam 化与双 flavor 属后续批。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findFreePort } from './free-port.ts';
import type { NotificationOpenIntent } from './notifications.ts';
import type { TransportInstanceSpec } from './transport-provider.ts';
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

/** 原生通知 open intent（design 19 §3.3）——re-export 自纯逻辑模块
 *  notifications.ts（electron-free，结构类型可直接跨 core/edges 使用）。 */
export type { NotificationOpenIntent };

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
 *  W-10 S0 批仅实现 rendererPush（electron-edges.ts）；其余成员标注其后续批
 *  来源，未实现前 core/main.ts 不得调用（Pick 收窄在编译期保证）。 */
export interface HostEdges {
  /** 主窗口渲染器 push 叶（W-10 S0 seam 成员，草案新增）：channel 为 opaque
   *  通道名（Electron 侧恒为 IPC_CHANNELS 常量值），payload 为纯非秘密投影；
   *  返回 false = 当前无存活主窗（单窗身份），调用侧自行折算失败语义。 */
  rendererPush(channel: string, payload: unknown): boolean
  // —— 原生显示/系统集成 ——
  /** 构造并显示原生通知（B4：宿主对象登记/淘汰留在实现侧），返回 click 回执
   *  注销函数（core 只持有界 ACK 队列/去重/限速）。 */
  showNativeNotification(spec: NativeNotificationSpec): () => void
  /** Notification.isSupported 平台探测（异常安全由实现侧保证）。 */
  notificationSupported(): boolean
  /** 通知 click → open-intent 回灌（click 激活窗口腿为 focusMainWindow）。 */
  notifyClicked(openIntent: NotificationOpenIntent): void
  /** macOS 平台门 + app.setBadgeCount（design 19 §3.7；与草案 boolean 偏差见
   *  HostSetBadgeResult）。 */
  setBadge(count: number): HostSetBadgeResult
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
  /** 渲染器可用性门（B3）：webContents 是否仍在加载。 */
  webViewLoading(): boolean
  /** 渲染器可用性门（B3）：webContents 是否存活（非 crashed/destroyed）。 */
  webViewContentAlive(): boolean
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
