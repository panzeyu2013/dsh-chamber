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
 *   face A gate). The sole IPC registration point is installIpcHandlers
 *   (W-10 seam batch): the registrar (deps.ipc) is injected by the assembly
 *   side — Electron main wraps it with the trustedIpc fence, so this file
 *   never spells ipcMain / webContents.send (W-14 face C gate). IPC_CHANNELS
 *   constants (ipc-events.ts — a pure constants module) are legitimately
 *   referenced here since S1.
 * - Host state is parameterized: userData-scoped paths and the runtime base
 *   dir arrive as arguments (resolveActiveRuntime / the path templates), argv
 *   arrives as an argument (scanDeepLinkUrls); nothing reads Electron host
 *   state implicitly. Post-W-09 state is parameterized per function (the
 *   installIpcHandlers ctx seam), never read from module scope.
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
 * 中文说明：自 main.ts 机械搬运的 Electron-free 业务核心（零缝阶段，行为零
 * 变化）；W-10 S1 起 IPC 注册点与 A 组 info+settings 处理器迁入本文件
 * （installIpcHandlers 单点注册，Electron 围栏由 main 注入包装）；HostEdges
 * 其余边沿叶与双 flavor 属后续批。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findFreePort } from './free-port.ts';
import { computeSupported, validatePatch } from './chamber-settings.ts';
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';
import { attemptCommittedRegistryPush } from './transport-manager.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
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

// ---------------------------------------------------------------------------
// Shell IPC registration (design 25 §4.1 seam; W-10 S1 info+settings batch).
//
// installIpcHandlers is the single shell-core IPC registration point: the
// Electron main only assembles it (main.ts — trustedIpc fence injected at the
// registrar wrapper, core stays electron-free by construction). This batch
// relocates group A — the INFO / SETTINGS_GET / SETTINGS_SET registrations and
// their settings helpers (chamberSettingsStatus / applySettingsPatch /
// pushSettingsChanged) — VERBATIM from main.ts: only the Electron leaves were
// replaced by injected seams (settingsIO / setKeepAwake / setLoginItem /
// reconcileBadgeCount / confirmRegistryOriginSwitch via ctx, and the
// SETTINGS_CHANGED send leaf via edges.rendererPush — the S0 seam member), so
// behavior is unchanged. Registration order inside this function = the
// original main.ts order; the surrounding steps of the wider W-10 plan are
// annotated in place:
//   ① edges 回灌订阅首段（占位——onSystemResume / onMainWindowShown /
//      onNotifyClick 的 core 回调在 W-10 后续批迁入，订阅点在此注册）；
//   ② A 组 3 个注册体（本批）；
//   ③ 自举（占位——控制面 ready 后的启动/恢复 push 与 drain 挂点在 W-10
//      后续批迁入）。
// ---------------------------------------------------------------------------

/** IPC 注册面：core 经它注册处理器（channel 为 opaque 通道名；Electron 侧
 *  装配为 `(ch, h) => ipcMain.handle(ch, trustedIpc(h))`——trustedIpc 围栏在
 *  注入点包装，Swift sidecar flavor 注入同形 B 桥注册）。 */
export interface IpcRegistrar {
  handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown): void
}

/** ShellAssemblyCtx — installIpcHandlers 装配上下文。最小集原则：只放本批 3
 *  个注册体与其随迁辅助实际引用的字段，后续批按需扩展。chamber settings 的
 *  内存 holder 本批仍归装配侧（main.ts 尚余 20+ 处直读点，随各自批迁入时
 *  holder 一并搬家）；core 侧一律经 settingsIO 读写，权威单一、行为与搬迁前
 *  一致。各副作用叶与其 HostEdges 成员（setKeepAwake / setLoginItem /
 *  setBadge…）同名同语义——后续批把宿主腿迁入 electron-edges 时 core 无需改。 */
export interface ShellAssemblyCtx {
  /** INFO 载荷与 settings 平台投影的宿主事实。 */
  hostFacts: {
    /** 控制面 URL（原 main.ts INFO 载荷的 `http://127.0.0.1:${cp.port}`）。 */
    controlPlaneUrl: string
    /** 运行平台（原 process.platform）。 */
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
  /** keep-awake 副作用叶（装配侧注入现 setKeepAwakeActive——HostEdges
   *  setKeepAwake 的 main.ts 宿主腿；失败 throw，由 applySettingsPatch 的
   *  catch 做 best-effort 回滚，与搬迁前语义一致）。 */
  setKeepAwake(enabled: boolean): void
  /** 登录自启副作用叶（装配侧注入现 applyLaunchAtLogin——HostEdges
   *  setLoginItem 的 main.ts 宿主腿；失败 {error} 返回，绝不 throw）。 */
  setLoginItem(enabled: boolean): { ok: true } | { ok: false; error: string }
  /** badge 意图即时收敛叶（装配侧注入现 reconcileBadgeCount——badge 批迁入
   *  前由 main 注入同函数引用，语义零变）。 */
  reconcileBadgeCount(): void
  /** registryOrigin 切换确认对话框叶（SETTINGS_SET 现 dialog.showMessageBox
   *  腿；文案与无窗判定留在实现侧）：
   *  'confirmed' 放行；
   *  'cancelled' = 用户取消（原返回 { error: 'cancelled', code: 'cancelled' }）；
   *  'unavailable' = 无存活主窗（原返回 { error: 'native confirmation unavailable' }）。 */
  confirmRegistryOriginSwitch(
    currentOrigin: string,
    nextOrigin: string,
  ): Promise<'confirmed' | 'cancelled' | 'unavailable'>
}

/** 装配 shell IPC 面（W-10 S1：A 组 INFO / SETTINGS_GET / SETTINGS_SET + 随迁
 *  settings 辅助）。edges 参数以 Pick 收窄到本批实际调用的成员
 *  （createElectronEdges 返回同形 Pick）；后续批实现新成员时同步扩宽两侧。
 *  调用点纪律：whenReady 内、createMainWindow 之前（窗口加载前注册完毕）。 */
export function installIpcHandlers(deps: {
  ipc: IpcRegistrar
  edges: Pick<HostEdges, 'rendererPush'>
  ctx: ShellAssemblyCtx
}): void {
  const {
    hostFacts,
    settingsIO,
    setKeepAwake,
    setLoginItem,
    reconcileBadgeCount,
    confirmRegistryOriginSwitch,
  } = deps.ctx

  // ① edges 回灌订阅首段（W-10 后续批占位：core 回调在此挂
  //    edges.onSystemResume / onMainWindowShown / notifyClicked——事件源语义
  //    自 main.ts 逐字迁入，订阅点统一走本函数单点）。

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

  // ② A 组 3 个注册体（迁自 main.ts；trustedIpc 围栏由装配侧在 ipc 注入点
  //    包装，本文件零 electron）。
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

  // ③ 自举（W-10 后续批占位：控制面 ready 后的启动/恢复 push、drain 挂点
  //    迁入点——见 macos-swift-v1.md §四批 2）。
}
