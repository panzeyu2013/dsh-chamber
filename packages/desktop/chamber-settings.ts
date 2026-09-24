/**
 * Chamber settings store (design 14 D7, v1 scope) — pure logic, no electron.
 *
 * All chamber-GLOBAL runtime settings live in the main process under
 * <userData>/chamber-settings.json (non-secret, 0600, atomic write) and NEVER
 * touch any instance's dsh home (design 01 §2 P2: per-instance config planes
 * are authoritative; chamber settings are app-level and disjoint). The electron
 * side effects (powerSaveBlocker / setLoginItemSettings / XDG autostart /
 * window lifecycle) live in main.ts.
 */
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWritePrivateFileNoFollow, ensurePrivateDirectoryNoFollow, readPrivateFileNoFollow } from './control-plane-module.ts';
import { isPlainRecord, preserveFileAside, removeLegacyTmpResidue } from './store-file-hygiene.ts';

/** Close-window behavior (design 14 D1): hide to tray (dsh keeps running) or quit. */
export type WindowCloseBehavior = 'hide-to-tray' | 'quit';

/** Desktop notification settings (design 19 §3.4 + §3.7): opt-in, low-noise by default. */
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
  /** 未读计数徽标（design 19 §3.7）：Dock/任务栏图标上的红色数字气泡——被动
   *  指示（与横幅主开关独立），默认 true；关闭时主进程裁决强制清零。 */
  badgeEnabled: boolean
}

/** 侧边栏「会话待办区」设置：顶部固定待办区（宽栏、空时零占用）的主开关与
 *  事件开关。默认全开——待办区是被动呈现，不是打扰型通知，默认值不同于
 *  notifications。 */
export interface ChamberSessionTodoSettings {
  /** 主开关；默认 true。关闭后侧边栏完全不渲染待办区。 */
  enabled: boolean
  /** 会话完成未读时（默认 true）。 */
  onComplete: boolean
  /** 代理提问等待回答（pending 'question'）时（默认 true）。 */
  onAsk: boolean
  /** 工具调用/计划审批请求（pending 'approval' | 'plan-review'）时（默认 true）。 */
  onRequest: boolean
}

/** Chamber-global runtime settings (design 14 v1 scope). */
export interface ChamberSettings {
  windowCloseBehavior: WindowCloseBehavior
  /** Login autostart (design 14 D6): darwin/win32/linux (design 21 M4). */
  launchAtLogin: boolean
  /** prevent-app-suspension (design 14 D5); default off. */
  keepAwake: boolean
  /** Quit confirmation (design 14 D2): confirm before quitting
   *  while the LOCAL dsh instance is running; remote tunnels never prompt. */
  quitConfirmation: boolean
  /** VS Code open-in window policy (design 16 §3.3 / 20 §4.3): true (default)
   *  appends `?windowId=_blank` to the vscode:// URL so a session folder opens
   *  in a NEW window (an already-open folder is focused, never duplicated);
   *  false hands over the bare URL and lets VS Code's own policy decide. */
  vscodeOpenInNewWindow: boolean
  /** dsh runtime npm registry origin (design 18 M4): default npmjs; custom
   *  origin validated as an https:// URL with no userinfo (trust anchor —
   *  switching origin switches the trust anchor). */
  registryOrigin: string
  /** Desktop notifications (design 19): 主进程裁决权威，渲染端只负责检测与组装。 */
  notifications: ChamberNotificationSettings
  /** 侧边栏「会话待办区」（sidebar todo area）：侧边栏插件消费，主进程仅持久化。 */
  sessionTodo: ChamberSessionTodoSettings
}

/** Non-secret status projection: current settings + platform capability gates. */
export interface ChamberSettingsStatus {
  settings: ChamberSettings
  supported: {
    /** All shipping platforms support login autostart (design 14 D6; win32 =
     *  HKCU Run key via setLoginItemSettings). */
    launchAtLogin: boolean
    /** false when no tray recovery surface exists (dev, no icons); darwin is
     *  always safe (Dock icon recovery). */
    closeToTray: boolean
    /** 未读徽标平台能力（design 19 §3.7 / design 23 M3）：与 badge.ts 的
     *  badgePlatformGate 同平台集合——win32 的任务栏 overlay 角标 v1 未接线，
     *  设置页据此禁用开关并给出原因，绝不呈现一个永远无效的开关。 */
    badgeSupported: boolean
  }
}

export const DEFAULT_CHAMBER_SETTINGS: ChamberSettings = {
  windowCloseBehavior: 'hide-to-tray',
  launchAtLogin: false,
  keepAwake: false,
  quitConfirmation: true,
  vscodeOpenInNewWindow: true,
  registryOrigin: 'https://registry.npmjs.org',
  notifications: {
    enabled: false,
    mode: 'hidden-only',
    onComplete: true,
    onAsk: true,
    onRequest: true,
    badgeEnabled: true,
  },
  sessionTodo: {
    enabled: true,
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
  'vscodeOpenInNewWindow',
  'registryOrigin',
  'notifications',
  'sessionTodo',
];

/** Normalize a registry origin (design 18 M4): a valid https:// URL with no
 *  userinfo, reduced to scheme://host (no path/query/hash/trailing slash);
 *  anything else returns null — the origin is a trust anchor, so invalid input
 *  is never silently accepted. The accept/reject decision is
 *  isAllowedRegistryOrigin (shape-for-shape with the Swift leg); WHATWG
 *  parsing only canonicalizes the accepted value. */
function normalizeRegistryOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (!isAllowedRegistryOrigin(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/** Settings-file size bound, mirroring Swift StartupSettings (1 << 20).
 *  An oversized document is corruption, never a truncated read. */
export const MAX_SETTINGS_FILE_BYTES = 1 << 20;

/** Encoding discipline mirroring Swift StartupSettings.hasRejectedEncoding:
 *  a UTF-8 BOM (U+FEFF) or a raw NUL byte (what a UTF-16/UTF-32 document
 *  decodes to under a UTF-8 read) is corruption — the verdict must be explicit,
 *  not silently dependent on the parser's whitespace rules. */
function hasRejectedSettingsEncoding(raw: string): boolean {
  return raw.startsWith('\uFEFF') || raw.includes('\u0000');
}

/** JSON string-body escape decoding (\uXXXX becomes its literal character) used
 *  only for key-name equality — mirrors Swift StartupSettings.decodeJSONEscapes,
 *  so an escaped duplicate key is still one key; non-escape backslashes keep
 *  their next character. */
function decodeJsonEscapes(raw: string): string {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    index += 1;
    if (index >= raw.length) break;
    const next = raw[index]!;
    if (next === '\\') out += '\\';
    else if (next === '"') out += '"';
    else if (next === '/') out += '/';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'u') {
      const hex = raw.slice(index + 1, index + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      }
    } else {
      out += next;
    }
  }
  return out;
}

/** Duplicate JSON keys at ANY nesting level are corruption: JSON.parse keeps the
 *  LAST occurrence while Swift JSONSerialization keeps the FIRST, so the same
 *  bytes would yield opposite settings — both flavors must refuse it (mirrors
 *  Swift hasDuplicateJSONKeys, escape-decoded key comparison included). */
function hasDuplicateJsonKeys(text: string): boolean {
  const stack: Set<string>[] = [];
  let inString = false;
  let escaped = false;
  let current = '';
  let pendingKey: string | null = null;
  for (const char of text) {
    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        current = current.slice(0, -1);
        inString = false;
        pendingKey = decodeJsonEscapes(current);
        current = '';
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      current = '';
    } else if (char === '{') {
      stack.push(new Set());
    } else if (char === '}') {
      stack.pop();
    } else if (char === ':' && stack.length > 0 && pendingKey !== null) {
      const top = stack[stack.length - 1]!;
      if (top.has(pendingKey)) return true;
      top.add(pendingKey);
      pendingKey = null;
    }
  }
  return false;
}

/** WHATWG dot-segment normalization for the strict origin check: only '.'/'..'
 *  and their %2e spellings are dot segments; other escapes stay literal. */
function normalizeDotSegments(pathValue: string): string {
  if (pathValue === '') return '';
  const segments: string[] = [];
  for (const segment of pathValue.split('/')) {
    const lowered = segment.toLowerCase();
    if (lowered === '.' || lowered === '%2e') continue;
    if (lowered === '..' || lowered === '.%2e' || lowered === '%2e.' || lowered === '%2e%2e') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Non-ASCII host scalars forbidden by UTS46/bidi/private-use rules (mirror of
 *  Swift StartupSettings.isForbiddenNonAsciiHostScalar): rejected fail-closed. */
function isForbiddenNonAsciiHostScalar(value: number): boolean {
  if (value >= 0xE000 && value <= 0xF8FF) return true;
  if (value >= 0xF0000) return true;
  if (value >= 0x0590 && value <= 0x08FF) return true;
  if (value >= 0xFB1D && value <= 0xFDFF) return true;
  if (value >= 0xFE70 && value <= 0xFEFF) return true;
  if (value >= 0x10800 && value <= 0x10FFF) return true;
  if (value >= 0x1E800 && value <= 0x1EFFF) return true;
  if (value === 0x037A || (value >= 0x2135 && value <= 0x2138)) return true;
  return /\p{N}/u.test(String.fromCodePoint(value));
}

/** Strict registry-origin shape check, shape-for-shape with Swift
 *  StartupSettings.isAllowedRegistryOrigin: WHATWG parsing alone is laxer in
 *  exactly the ways the Swift leg judges corrupt (IPv6 literals, IDN hiding
 *  forbidden scalars, empty/'+'-prefixed/out-of-range ports, whitespace,
 *  backslashes). Only when this accepts may normalizeRegistryOrigin canonicalize
 *  the value — both flavors accept/reject the same shapes. */
function isAllowedRegistryOrigin(raw: string): boolean {
  const stripped = raw.replace(/[\t\n\r]/g, '');
  if (!stripped.toLowerCase().startsWith('https:')) return false;
  let rest = stripped.slice('https:'.length);
  if (rest.startsWith('//')) rest = rest.slice(2);
  const markerIndexes = [rest.indexOf('/'), rest.indexOf('?'), rest.indexOf('#')]
    .filter(index => index >= 0)
    .sort((a, b) => a - b);
  const authorityEnd = markerIndexes.length > 0 ? markerIndexes[0]! : rest.length;
  const authority = rest.slice(0, authorityEnd);
  const tail = rest.slice(authorityEnd);
  if (authority === '' || authority.includes('@') || authority.includes('\\')) return false;
  const parts = authority.split(':');
  if (parts.length > 2) return false;
  const host = parts[0]!;
  if (host === '') return false;
  if (parts.length === 2) {
    const portText = parts[1]!;
    if (!/^[0-9]+$/.test(portText)) return false;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  for (const scalar of host) {
    const value = scalar.codePointAt(0)!;
    const asciiAllowed = (value >= 0x30 && value <= 0x39) || (value >= 0x41 && value <= 0x5A)
      || (value >= 0x61 && value <= 0x7A) || value === 0x2E || value === 0x2D || value === 0x5F;
    if (asciiAllowed) continue;
    if (value <= 0x7F) return false;
    if (isForbiddenNonAsciiHostScalar(value)) return false;
    if (/\p{L}/u.test(scalar) || /\p{N}/u.test(scalar)) continue;
    return false;
  }
  let pathOnly = '';
  let remainder = '';
  let markerSeen = false;
  for (const char of tail) {
    if (!markerSeen && (char === '?' || char === '#')) {
      markerSeen = true;
      continue;
    }
    if (markerSeen) remainder += char;
    else pathOnly += char;
  }
  if (markerSeen && remainder !== '') return false;
  const normalized = normalizeDotSegments(pathOnly);
  return normalized === '' || normalized === '/';
}


const NOTIFICATION_SETTINGS_KEYS: ReadonlyArray<keyof ChamberNotificationSettings> = [
  'enabled',
  'mode',
  'onComplete',
  'onAsk',
  'onRequest',
  'badgeEnabled',
];

/** 嵌套 notifications 归一：缺失/非法值回落默认（持久化读路径；响亮校验在 validatePatch）；非对象整组回落。 */
function normalizeNotificationSettings(input: unknown): ChamberNotificationSettings {
  const notifications: ChamberNotificationSettings = { ...DEFAULT_CHAMBER_SETTINGS.notifications };
  if (!isPlainRecord(input)) return notifications;
  const record = input as Record<string, unknown>;
  if (typeof record.enabled === 'boolean') notifications.enabled = record.enabled;
  if (record.mode === 'hidden-only' || record.mode === 'always') notifications.mode = record.mode;
  if (typeof record.onComplete === 'boolean') notifications.onComplete = record.onComplete;
  if (typeof record.onAsk === 'boolean') notifications.onAsk = record.onAsk;
  if (typeof record.onRequest === 'boolean') notifications.onRequest = record.onRequest;
  if (typeof record.badgeEnabled === 'boolean') notifications.badgeEnabled = record.badgeEnabled;
  return notifications;
}

const SESSION_TODO_SETTINGS_KEYS: ReadonlyArray<keyof ChamberSessionTodoSettings> = [
  'enabled',
  'onComplete',
  'onAsk',
  'onRequest',
];

/** 嵌套 sessionTodo 归一：缺失/非法值回落默认（持久化读路径；响亮校验在 validatePatch）；非对象整组回落。 */
function normalizeSessionTodoSettings(input: unknown): ChamberSessionTodoSettings {
  const sessionTodo: ChamberSessionTodoSettings = { ...DEFAULT_CHAMBER_SETTINGS.sessionTodo };
  if (!isPlainRecord(input)) return sessionTodo;
  const record = input as Record<string, unknown>;
  if (typeof record.enabled === 'boolean') sessionTodo.enabled = record.enabled;
  if (typeof record.onComplete === 'boolean') sessionTodo.onComplete = record.onComplete;
  if (typeof record.onAsk === 'boolean') sessionTodo.onAsk = record.onAsk;
  if (typeof record.onRequest === 'boolean') sessionTodo.onRequest = record.onRequest;
  return sessionTodo;
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
  if (typeof record.vscodeOpenInNewWindow === 'boolean') base.vscodeOpenInNewWindow = record.vscodeOpenInNewWindow;
  const origin = normalizeRegistryOrigin(record.registryOrigin);
  if (origin !== null) base.registryOrigin = origin;
  if (record.notifications !== undefined) {
    base.notifications = normalizeNotificationSettings(record.notifications);
  }
  if (record.sessionTodo !== undefined) {
    base.sessionTodo = normalizeSessionTodoSettings(record.sessionTodo);
  }
  return base;
}

/** Whether the persisted file's key set is well-formed (unknown keys are a
 *  forward-compat tolerance, not corruption). The nested sub-blocks are part of
 *  the file's SHAPE: a scalar/array/wrongly-typed block is corruption, never a
 *  silent fall-back to defaults — the corrupt-preserve discipline of
 *  registryOrigin, since a trust-relevant value must not be silently
 *  reinterpreted. */
function isValidSettingsFile(input: unknown): input is Record<string, unknown> {
  if (!isPlainRecord(input)) return false;
  const record = input as Record<string, unknown>;
  if (record.windowCloseBehavior !== undefined
    && record.windowCloseBehavior !== 'hide-to-tray'
    && record.windowCloseBehavior !== 'quit') return false;
  for (const key of ['launchAtLogin', 'keepAwake', 'quitConfirmation', 'vscodeOpenInNewWindow'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'boolean') return false;
  }
  // Once persisted, an invalid trust anchor is corruption, not a silent switch back to the public default registry.
  if (record.registryOrigin !== undefined && normalizeRegistryOrigin(record.registryOrigin) === null) return false;
  // Nested notifications shape: must be an object with correctly-typed known
  // fields (unknown nested keys stay a forward-compat tolerance); an invalid
  // `mode` is corruption — silently flipping 'always' back to 'hidden-only'
  // would change notification behavior without the user's consent.
  if (record.notifications !== undefined) {
    const notifications = record.notifications;
    if (!isPlainRecord(notifications)) return false;
    const nested = notifications as Record<string, unknown>;
    if (nested.mode !== undefined && nested.mode !== 'hidden-only' && nested.mode !== 'always') return false;
    for (const key of ['enabled', 'onComplete', 'onAsk', 'onRequest', 'badgeEnabled'] as const) {
      if (nested[key] !== undefined && typeof nested[key] !== 'boolean') return false;
    }
  }
  // Nested sessionTodo shape: same discipline — a wrongly typed sub-block is
  // corruption, never a silent reinterpretation of the user's UI choice.
  if (record.sessionTodo !== undefined) {
    const sessionTodo = record.sessionTodo;
    if (!isPlainRecord(sessionTodo)) return false;
    const nested = sessionTodo as Record<string, unknown>;
    for (const key of ['enabled', 'onComplete', 'onAsk', 'onRequest'] as const) {
      if (nested[key] !== undefined && typeof nested[key] !== 'boolean') return false;
    }
  }
  return true;
}

/** The read outcome callers need to decide whether an OS-level side effect (the
 *  login item) may be touched; Swift's `StartupSettings.readValidatedData`
 *  returns the same three-way verdict. `corrupt` also covers launches AFTER
 *  preservation: reading the renamed-to-`*.corrupt` state as `missing` would
 *  replay `launchAtLogin:false` and silently unregister the login item one
 *  launch later, so the sibling keeps the state indeterminate. */
export type SettingsFileState = 'missing' | 'ok' | 'corrupt';

/**
 * Read the settings file: missing → defaults; corrupt → PRESERVE as
 * `*.corrupt` (reversible, never silently faked as defaults) and return
 * defaults with a loud `notice`. `state` tells the caller which happened —
 * default VALUES may surface for the UI, but a corrupt file must never be
 * treated as a user instruction to change an OS-level side effect (the login
 * item); the missing-live-plus-corrupt-sibling launch reports `corrupt` too.
 */
export function readSettingsFile(
  filePath: string,
): { settings: ChamberSettings; notice: string | null; state: SettingsFileState } {
  // One-time crash-residue sweep of the legacy write path's FIXED
  // `${filePath}.tmp` residue at the startup load (see removeLegacyTmpResidue).
  removeLegacyTmpResidue(filePath);
  let raw: string;
  try {
    // No-follow / single-link / inode read discipline as the credential mirrors:
    // the file is non-secret but carries the registry trust anchor and is 0600,
    // so its read rides the shared private-file primitive. tightenMode converges
    // a historical loose (0644) file to 0600 on first read; ENOENT → defaults;
    // anything unsafe (planted symlink / multi-link leaf) is loud + preserved as
    // `*.corrupt`, never read through.
    raw = readPrivateFileNoFollow(filePath, { tightenMode: 0o600, maxBytes: MAX_SETTINGS_FILE_BYTES }).value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // The live file is gone, but a preserved `*.corrupt` sibling proves the
      // settings were unreadable (renamed on a previous launch): keep the state
      // indeterminate instead of decaying to `missing`, whose default replays as
      // a silent login-item unregister.
      if (corruptSiblingExists(filePath)) {
        return {
          settings: { ...DEFAULT_CHAMBER_SETTINGS },
          notice: `chamber settings missing but the preserved corrupt copy ${filePath}.corrupt exists; using defaults`,
          state: 'corrupt',
        };
      }
      return { settings: { ...DEFAULT_CHAMBER_SETTINGS }, notice: null, state: 'missing' };
    }
    const notice = `chamber settings unreadable (${String(error)}); using defaults`;
    preserveCorrupt(filePath);
    return { settings: { ...DEFAULT_CHAMBER_SETTINGS }, notice, state: 'corrupt' };
  }
  try {
    // 双 flavor 严格度对齐：Swift StartupSettings 判损坏的形态在共享读取器上
    // 同样成立——编码（BOM/裸 NUL）、任意层级的重复 JSON 键（JSON.parse 取最后
    // 一个而 JSONSerialization 取第一个，同一字节流结论相反）与大小上限
    // （maxBytes 拒绝而非截断）。registryOrigin 由 isAllowedRegistryOrigin 单源。
    if (hasRejectedSettingsEncoding(raw)) throw new Error('settings file has an unsupported encoding (BOM/NUL)');
    if (hasDuplicateJsonKeys(raw)) throw new Error('settings file has duplicate JSON keys');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSettingsFile(parsed)) throw new Error('settings file is not an object');
    return { settings: normalizeSettings(parsed), notice: null, state: 'ok' };
  } catch (error) {
    const notice = `chamber settings corrupt (${String(error)}); preserved as *.corrupt, using defaults`;
    preserveCorrupt(filePath);
    return { settings: { ...DEFAULT_CHAMBER_SETTINGS }, notice, state: 'corrupt' };
  }
}

/** Atomic write, 0600 — the control-plane replace primitive via the desktop
 *  facade (random O_EXCL tmp → fsync → rename → parent-directory fsync; a
 *  planted symlink / multi-link leaf is refused fail-closed); the parent
 *  directory is ensured owner-only (0700) first. The explicit mode keeps the
 *  file owner-only on every replace (the registry origin is a trust anchor). */
export function writeSettingsFile(filePath: string, settings: ChamberSettings): void {
  ensurePrivateDirectoryNoFollow(dirname(filePath), 0o700);
  atomicWritePrivateFileNoFollow(filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** Does the preserved `*.corrupt` evidence sibling exist?
 *  Any directory entry counts (even a symlink) — lstatSync never follows it,
 *  matching the no-follow discipline of the read path. */
function corruptSiblingExists(filePath: string): boolean {
  try {
    lstatSync(`${filePath}.corrupt`);
    return true;
  } catch {
    return false;
  }
}

function preserveCorrupt(filePath: string): void {
  // The rename is single-sourced in store-file-hygiene.preserveFileAside; only the failure wording is store-specific.
  const result = preserveFileAside(filePath, '.corrupt');
  if (!result.ok) console.error(`[chamber-settings] 保留损坏设置文件失败：`, result.error);
}

/** 关窗隐藏到托盘的「恢复入口可用」判定（design 14 D1）：macOS Dock 图标常驻
 *  （激活即恢复窗口），其余平台必须有托盘。 */
export function closeToTrayRecoveryAvailable(
  platform: NodeJS.Platform,
  trayAvailable: boolean,
): boolean {
  return platform === 'darwin' || trayAvailable;
}

/** Platform capability gates (design 14 D6/D1; design 21 M4: launchAtLogin on
 *  win32 via the HKCU Run key). `badgeSupported` mirrors the badge.ts platform
 *  gate: the unread badge is wired on macOS (Dock) and Linux only, so the
 *  settings page must disable the switch instead of offering one that can never
 *  take effect. */
export function computeSupported(
  platform: NodeJS.Platform,
  trayAvailable: boolean,
): ChamberSettingsStatus['supported'] {
  return {
    launchAtLogin: true,
    closeToTray: closeToTrayRecoveryAvailable(platform, trayAvailable),
    badgeSupported: platform === 'darwin' || platform === 'linux',
  };
}

/** The three outcomes a main-window `close` request can resolve to before the
 *  quit gate runs; `defer-quit` keeps the window alive while the decision is
 *  pending — it is ONLY destroyed once the exit is confirmed. */
export type MainWindowCloseAction = 'hide' | 'defer-quit' | 'close';

/**
 * Route a main-window close request. A close that would end in a quit is
 * `defer-quit`: the caller preventDefaults it and asks `app.quit()` with the
 * window alive. Destroying the window first and only THEN asking in
 * `before-quit` would leave no window to restore when the dialog is cancelled,
 * and rebuilding via `loadURL` is a full page reload (lost renderer state);
 * the Swift flavor likewise turns the close into `NSApp.terminate` and keeps
 * the window alive. Only an already-confirmed quit or the updater's own window
 * teardown may actually `close`; hide-to-tray is `shouldHideToTray`'s branch.
 * The flags are the live quit state machine, not a JSON source of truth.
 */
export function decideMainWindowClose(input: {
  behavior: WindowCloseBehavior
  recoveryAvailable: boolean
  quitRequested: boolean
  quitConfirmed: boolean
  updateRestartArmed: boolean
}): MainWindowCloseAction {
  if (shouldHideToTray(input.behavior, input.recoveryAvailable, input.quitRequested, input.updateRestartArmed)) {
    return 'hide';
  }
  if (input.quitConfirmed || input.updateRestartArmed) return 'close';
  return 'defer-quit';
}

/**
 * Does the startup login-item reconcile touch the OS login item? A corrupt
 * settings file means "unreadable → do not touch it" in both flavors: replaying
 * `launchAtLogin:false` would silently UNREGISTER the user's login item. A
 * missing file or a valid file without the key replays `false` normally (the
 * loud *.corrupt preservation + notice is unchanged).
 */
export function launchAtLoginReconcileDecision(
  state: SettingsFileState,
  launchAtLogin: boolean,
): { action: 'apply'; enabled: boolean } | { action: 'skip'; reason: 'corrupt-settings' } {
  if (state === 'corrupt') return { action: 'skip', reason: 'corrupt-settings' };
  return { action: 'apply', enabled: launchAtLogin };
}

/** The subset of Electron's LoginItemSettings the read-back validates
 *  (structural so the decision is testable without electron). */
export interface LoginItemSettingsReadBack {
  openAtLogin?: unknown
  /** darwin only (macOS 13+): 'not-registered' | 'enabled' | 'requires-approval' | 'not-found'. */
  status?: unknown
}

/**
 * Judge the state the OS reports AFTER `setLoginItemSettings`: a missing/
 * non-boolean `openAtLogin` is a failed read (never a pass), a state that does
 * not match the request is a failure with both values, and on macOS an item
 * still held at 'requires-approval' is not actually launchable → failure. An
 * unconditional `{ok:true}` would let an OS that silently refused look applied.
 */
export function verifyLaunchAtLoginReadBack(
  requested: boolean,
  observed: LoginItemSettingsReadBack,
  platform: NodeJS.Platform,
): { ok: true } | { ok: false; error: string } {
  // Most actionable verdict first: macOS holds the item at 'requires-approval' — registered but not launchable until the user acts.
  if (platform === 'darwin' && requested && observed.status === 'requires-approval') {
    return {
      ok: false,
      error: 'login item registered but macOS requires user approval (System Settings > General > Login Items)',
    };
  }
  const actual = observed.openAtLogin;
  if (typeof actual !== 'boolean') {
    return { ok: false, error: 'login item read-back unavailable (getLoginItemSettings returned no openAtLogin)' };
  }
  if (actual !== requested) {
    return { ok: false, error: `login item read-back mismatch: requested openAtLogin=${requested}, observed ${actual}` };
  }
  return { ok: true };
}

/**
 * Close-window decision (design 14 D1): hide to tray only when the behavior is
 * hide-to-tray, a recovery surface exists (tray on win/linux; Dock on macOS) and
 * no real quit is in flight — never hide a window the user could not get back to.
 * `updateRestartArmed` is the「重启并安装」leg: the updater's `quitAndInstall()`
 * closes every window itself on macOS (`before-quit` runs AFTER that close), so
 * swallowing it would abort the whole install/relaunch chain — while armed this
 * decision is always false, whatever `quitRequested` says.
 */
export function shouldHideToTray(
  behavior: WindowCloseBehavior,
  recoveryAvailable: boolean,
  quitRequested: boolean,
  updateRestartArmed = false,
): boolean {
  return behavior === 'hide-to-tray' && recoveryAvailable && !quitRequested && !updateRestartArmed;
}

/**
 * Whether the host must take the update quit over once the native leg's grace
 * expired: macOS's native `quitAndInstall()` closes every window and stops
 * without reaching `app.quit()`, leaving the process windowless with the update
 * staged. Take over only when no real quit is in flight (it would race the
 * normal teardown), the arming was not released by a failure, and the window is
 * GONE — a live window means either the native leg never got there or the user
 * pulled the app back, and yanking a visible app from under the user is never
 * acceptable (the stall watchdog owns that case and reports honestly).
 */
export function shouldUpdaterQuitTakeOver(
  quitRequested: boolean,
  updateRestartArmed: boolean,
  windowAlive: boolean,
): boolean {
  return !quitRequested && updateRestartArmed && !windowAlive;
}

/**
 * Quit-risk projection (design 14 D2): confirm before quitting only while the
 * LOCAL dsh instance is running (remote tunnels never prompt) — except when the
 * confirmation is off, or a downloaded update is ready to install on quit (the
 * user already confirmed「更新」and was told「退出时安装」— never block it).
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

/** Validate a renderer-supplied settings patch: known keys + types only. Failures
 *  carry a stable machine-readable `code` (e.g. 'invalid-registry-origin');
 *  `error` is display text only. A nested sub-object accepts a partial set of its
 *  known keys; applySettingsPatch deep-merges it so untouched switches survive. */
export function validatePatch(
  patch: unknown,
): { ok: true; patch: Partial<ChamberSettings> } | { ok: false; error: string; code?: string } {
  if (!isPlainRecord(patch)) {
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
    } else if (key === 'registryOrigin') {
      const origin = normalizeRegistryOrigin(record[key]);
      if (origin === null) {
        return { ok: false, error: 'registryOrigin must be a valid https:// URL without credentials', code: 'invalid-registry-origin' };
      }
      result.registryOrigin = origin;
    } else if (key === 'notifications') {
      const validated = validateNotificationSettingsPatch(record[key]);
      if (!validated.ok) return validated;
      // Partial 嵌套 patch 经 record 投影存入，由 applySettingsPatch deep-merge 补全为完整对象。
      (result as Record<string, unknown>)[key] = validated.patch;
    } else if (key === 'sessionTodo') {
      const validated = validateSessionTodoSettingsPatch(record[key]);
      if (!validated.ok) return validated;
      (result as Record<string, unknown>)[key] = validated.patch;
    } else if (typeof record[key] !== 'boolean') {
      return { ok: false, error: `${key} must be a boolean` };
    } else {
      (result as Record<string, unknown>)[key] = record[key];
    }
  }
  return { ok: true, patch: result };
}

/** 嵌套 notifications patch 校验：非数组对象；mode 二选一，其余布尔；未知嵌套键拒绝（缺字段 = 不修改，由 deep-merge 兜底）。 */
function validateNotificationSettingsPatch(
  input: unknown,
): { ok: true; patch: Partial<ChamberNotificationSettings> } | { ok: false; error: string } {
  if (!isPlainRecord(input)) {
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

/** 嵌套 sessionTodo patch 校验：非数组对象，全部布尔；未知嵌套键拒绝（缺字段 = 不修改，由 deep-merge 兜底）。 */
function validateSessionTodoSettingsPatch(
  input: unknown,
): { ok: true; patch: Partial<ChamberSessionTodoSettings> } | { ok: false; error: string } {
  if (!isPlainRecord(input)) {
    return { ok: false, error: 'sessionTodo must be an object' };
  }
  const record = input as Record<string, unknown>;
  const result: Partial<ChamberSessionTodoSettings> = {};
  for (const key of Object.keys(record)) {
    if (!(SESSION_TODO_SETTINGS_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown sessionTodo key: ${key}` };
    }
    if (typeof record[key] !== 'boolean') {
      return { ok: false, error: `sessionTodo.${key} must be a boolean` };
    }
    (result as Record<string, unknown>)[key] = record[key];
  }
  return { ok: true, patch: result };
}
