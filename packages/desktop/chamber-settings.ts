/**
 * Chamber settings store (design 14 D7, v1 scope) — pure logic, no electron.
 *
 * All chamber-GLOBAL runtime settings live in the main process under
 * <userData>/chamber-settings.json (non-secret, 0600, atomic write). They
 * NEVER touch any instance's dsh home (design 01 §2 P2: per-instance config
 * planes are authoritative; chamber settings are app-level and disjoint).
 *
 * This module is deliberately electron-free so the decision functions are
 * unit-testable with plain node:test (see chamber-settings.test.ts). The
 * electron side effects (powerSaveBlocker / setLoginItemSettings / XDG
 * autostart / window lifecycle) live in main.ts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Close-window behavior (design 14 D1): hide to tray (dsh keeps running) or quit. */
export type WindowCloseBehavior = 'hide-to-tray' | 'quit';

/** Desktop notification settings (design 19 §3.4): opt-in, low-noise by default. */
export interface ChamberNotificationSettings {
  /** 主开关；默认 false（低打扰，用户显式开启）。 */
  enabled: boolean
  /** 聚焦模式：hidden-only 仅在窗口不可见时打扰；always 始终（正在查看的会话除外）。 */
  mode: 'hidden-only' | 'always'
  /** 会话完成（running→idle 边沿）。 */
  onComplete: boolean
  /** 代理提问等待回答（pending 'question'）。 */
  onAsk: boolean
  /** 工具调用/计划审批请求（pending 'approval' | 'plan-review'）。 */
  onRequest: boolean
}

/** Chamber-global runtime settings (design 14 v1 scope). */
export interface ChamberSettings {
  windowCloseBehavior: WindowCloseBehavior
  /** Login autostart (design 14 D6): mac/linux; win gated off in v1. */
  launchAtLogin: boolean
  /** prevent-app-suspension (design 14 D5); default off. */
  keepAwake: boolean
  /** Quit confirmation (design 14 D2, 2026-08 修订): confirm before quitting
   *  while the LOCAL dsh instance is running; remote tunnels never prompt. */
  quitConfirmation: boolean
  /** Desktop notifications (design 19): 主进程裁决权威，渲染端只负责检测与组装。 */
  notifications: ChamberNotificationSettings
}

/** Non-secret status projection: current settings + platform capability gates. */
export interface ChamberSettingsStatus {
  settings: ChamberSettings
  supported: {
    /** false on win32 (v1 gate — STATUS「Windows 首版支持暂缓」). */
    launchAtLogin: boolean
    /** false when no tray recovery surface exists (dev, no icons); macOS is
     *  always safe (Dock icon recovery), so darwin reports true. */
    closeToTray: boolean
  }
}

export const DEFAULT_CHAMBER_SETTINGS: ChamberSettings = {
  windowCloseBehavior: 'hide-to-tray',
  launchAtLogin: false,
  keepAwake: false,
  quitConfirmation: true,
  notifications: {
    enabled: false,
    mode: 'hidden-only',
    onComplete: true,
    onAsk: true,
    onRequest: true,
  },
};

const SETTINGS_KEYS: ReadonlyArray<keyof ChamberSettings> = [
  'windowCloseBehavior',
  'launchAtLogin',
  'keepAwake',
  'quitConfirmation',
  'notifications',
];

const NOTIFICATION_SETTINGS_KEYS: ReadonlyArray<keyof ChamberNotificationSettings> = [
  'enabled',
  'mode',
  'onComplete',
  'onAsk',
  'onRequest',
];

/** 嵌套 notifications 归一：缺失字段用默认；非法值回落默认（持久化读路径，
 *  响亮校验在 validatePatch）。非对象（null/数组/标量）整组回落默认。 */
function normalizeNotificationSettings(input: unknown): ChamberNotificationSettings {
  const notifications: ChamberNotificationSettings = { ...DEFAULT_CHAMBER_SETTINGS.notifications };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return notifications;
  const record = input as Record<string, unknown>;
  if (typeof record.enabled === 'boolean') notifications.enabled = record.enabled;
  if (record.mode === 'hidden-only' || record.mode === 'always') notifications.mode = record.mode;
  if (typeof record.onComplete === 'boolean') notifications.onComplete = record.onComplete;
  if (typeof record.onAsk === 'boolean') notifications.onAsk = record.onAsk;
  if (typeof record.onRequest === 'boolean') notifications.onRequest = record.onRequest;
  return notifications;
}

/** Validate and normalize an unknown settings payload; unknown keys ignored. */
export function normalizeSettings(input: unknown): ChamberSettings {
  const base: ChamberSettings = { ...DEFAULT_CHAMBER_SETTINGS };
  if (input === null || typeof input !== 'object') return base;
  const record = input as Record<string, unknown>;
  if (record.windowCloseBehavior === 'hide-to-tray' || record.windowCloseBehavior === 'quit') {
    base.windowCloseBehavior = record.windowCloseBehavior;
  }
  if (typeof record.launchAtLogin === 'boolean') base.launchAtLogin = record.launchAtLogin;
  if (typeof record.keepAwake === 'boolean') base.keepAwake = record.keepAwake;
  if (typeof record.quitConfirmation === 'boolean') base.quitConfirmation = record.quitConfirmation;
  if (record.notifications !== undefined) {
    base.notifications = normalizeNotificationSettings(record.notifications);
  }
  return base;
}

/** Whether the persisted file's key set is well-formed (unknown keys are a
 *  forward-compat concern, not corruption — tolerate them). */
function isValidSettingsFile(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

/**
 * Read the settings file. Missing file → defaults; corrupt file → PRESERVE it
 * as `*.corrupt` (reversible, never silently faked as defaults) and return
 * defaults with a loud `notice` for the caller to log.
 */
export function readSettingsFile(filePath: string): { settings: ChamberSettings; notice: string | null } {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: { ...DEFAULT_CHAMBER_SETTINGS }, notice: null };
    }
    const notice = `chamber settings unreadable (${String(error)}); using defaults`;
    preserveCorrupt(filePath);
    return { settings: { ...DEFAULT_CHAMBER_SETTINGS }, notice };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSettingsFile(parsed)) throw new Error('settings file is not an object');
    return { settings: normalizeSettings(parsed), notice: null };
  } catch (error) {
    const notice = `chamber settings corrupt (${String(error)}); preserved as *.corrupt, using defaults`;
    preserveCorrupt(filePath);
    return { settings: { ...DEFAULT_CHAMBER_SETTINGS }, notice };
  }
}

/** Atomic write (tmp + rename), 0600 — mirrors the ssh-passwords store pattern. */
export function writeSettingsFile(filePath: string, settings: ChamberSettings): void {
  const tmpPath = `${filePath}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

function preserveCorrupt(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.corrupt`);
  } catch (error) {
    // Never throw out of the read path; the caller logs the loud notice already.
    console.error(`[chamber-settings] 保留损坏设置文件失败：`, error);
  }
}

/** Platform capability gates (design 14 D6/D1). */
export function computeSupported(
  platform: NodeJS.Platform,
  trayAvailable: boolean,
): ChamberSettingsStatus['supported'] {
  return {
    launchAtLogin: platform !== 'win32',
    closeToTray: platform === 'darwin' || trayAvailable,
  };
}

/**
 * Close-window decision (design 14 D1): hide to tray only when the behavior
 * is hide-to-tray, a recovery surface exists (tray on win/linux; Dock on
 * macOS), and no real quit is in flight. Never hide a window the user could
 * not get back to.
 */
export function shouldHideToTray(
  behavior: WindowCloseBehavior,
  recoveryAvailable: boolean,
  quitRequested: boolean,
): boolean {
  return behavior === 'hide-to-tray' && recoveryAvailable && !quitRequested;
}

/**
 * Quit-risk projection (design 14 D2, 2026-08 修订): confirm before quitting
 * only while the LOCAL dsh instance is running (remote tunnels never prompt —
 * user decision) — EXCEPT when the user turned the confirmation off, or a
 * downloaded update is ready to install on quit (design 11
 * autoInstallOnAppQuit: the user already confirmed「更新」and was told「退出时
 * 安装」— never block it with a second dialog).
 */
export function computeQuitRisk(input: {
  quitConfirmation: boolean
  localRunning: boolean
  updateDownloadReady: boolean
}): { needsConfirm: boolean; reasons: string[] } {
  if (input.updateDownloadReady) return { needsConfirm: false, reasons: [] };
  if (!input.quitConfirmation) return { needsConfirm: false, reasons: [] };
  const reasons: string[] = [];
  if (input.localRunning) reasons.push('正在运行的本地 dsh 实例');
  return { needsConfirm: reasons.length > 0, reasons };
}

/** Validate a renderer-supplied settings patch: known keys + types only. The
 *  notifications sub-object accepts a partial set of its known keys (unknown
 *  nested keys rejected); applySettingsPatch deep-merges it over the current
 *  value so a partial nested patch never drops the untouched switches. */
export function validatePatch(patch: unknown): { ok: true; patch: Partial<ChamberSettings> } | { ok: false; error: string } {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'settings patch must be an object' };
  }
  const record = patch as Record<string, unknown>;
  const result: Partial<ChamberSettings> = {};
  for (const key of Object.keys(record)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown setting key: ${key}` };
    }
    if (key === 'windowCloseBehavior') {
      if (record[key] !== 'hide-to-tray' && record[key] !== 'quit') {
        return { ok: false, error: 'windowCloseBehavior must be "hide-to-tray" or "quit"' };
      }
      result.windowCloseBehavior = record[key] as WindowCloseBehavior;
    } else if (key === 'notifications') {
      const validated = validateNotificationSettingsPatch(record[key]);
      if (!validated.ok) return validated;
      // Partial 嵌套 patch 经 record 投影存入（同下方布尔分支的既有写法）；
      // 由 applySettingsPatch deep-merge 补全为完整对象。
      (result as Record<string, unknown>)[key] = validated.patch;
    } else if (typeof record[key] !== 'boolean') {
      return { ok: false, error: `${key} must be a boolean` };
    } else {
      (result as Record<string, unknown>)[key] = record[key];
    }
  }
  return { ok: true, patch: result };
}

/** 嵌套 notifications patch 校验：必须是非数组对象；mode 二选一；其余布尔；
 *  未知嵌套键拒绝（缺字段 = 不修改该项，由调用方 deep-merge 兜底）。 */
function validateNotificationSettingsPatch(
  input: unknown,
): { ok: true; patch: Partial<ChamberNotificationSettings> } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'notifications must be an object' };
  }
  const record = input as Record<string, unknown>;
  const result: Partial<ChamberNotificationSettings> = {};
  for (const key of Object.keys(record)) {
    if (!(NOTIFICATION_SETTINGS_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown notifications key: ${key}` };
    }
    if (key === 'mode') {
      if (record[key] !== 'hidden-only' && record[key] !== 'always') {
        return { ok: false, error: 'notifications.mode must be "hidden-only" or "always"' };
      }
      result.mode = record[key] as ChamberNotificationSettings['mode'];
    } else if (typeof record[key] !== 'boolean') {
      return { ok: false, error: `notifications.${key} must be a boolean` };
    } else {
      (result as Record<string, unknown>)[key] = record[key];
    }
  }
  return { ok: true, patch: result };
}
