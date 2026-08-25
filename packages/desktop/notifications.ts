/**
 * Desktop notification decision logic (design 19 §3.3) — pure logic, no
 * electron, unit-testable with plain node:test (see notifications.test.ts).
 *
 * The main process (main.ts) is the authority for the decision chain: the
 * renderer only detects session edges and assembles a NotificationRequest,
 * then the desktop shell decides whether a native notification is actually
 * shown (settings from chamber-settings.json, dedupe claim, focus state).
 * The Electron side effects (new Notification / click → window focus /
 * notification-open push) live in main.ts.
 */

/** 通知事件种类（design 19 §3.2）：complete / ask / request + test（设置页测试按钮）。 */
export type NotificationKind = 'complete' | 'ask' | 'request' | 'test';

/** 渲染端组装的通知请求（design 19 §3.3）——纯非秘密投影。 */
export interface NotificationRequest {
  /** 'local' | 'ssh-<id>' */
  sourceId: string
  sessionId: string
  kind: NotificationKind
  title: string
  body: string
  /** 正在屏幕上查看的会话（渲染端 document.hasFocus 判定，主进程再查一次作为权威）。 */
  requireHidden: boolean
}

/** 通知裁决所用设置子集——从 ChamberSettings.notifications 解耦（测试友好）。 */
export interface NotificationSettingsLike {
  enabled: boolean
  mode: 'hidden-only' | 'always'
  onComplete: boolean
  onAsk: boolean
  onRequest: boolean
}

/**
 * 裁决链（主进程门禁，design 19 §3.3 顺序）：
 * 1. kind==='test' 直接放行（绕过全部设置门禁——设置页「发送测试通知」）；
 * 2. enabled === false → skip 'disabled'；
 * 3. kind 对应事件开关（complete→onComplete / ask→onAsk / request→onRequest）
 *    关闭 → skip 'kind-off'；
 * 4. requireHidden === true 且窗口聚焦 → skip 'on-screen'（正在查看的会话不打扰）；
 * 5. mode === 'hidden-only' 且窗口聚焦 → skip 'focused-hidden-only'
 *    （'always' 放行聚焦状态）；
 * 6. 否则 'show'。
 * 'test' 不受 requireHidden 影响（绕过全部门禁）。
 *
 * 信任切分（review 2026-08）：主进程的 anyWindowFocused 只回答「是否有窗口
 * 聚焦」，无法知道用户正在查看哪个会话——会话级焦点只有渲染端可见。因此在
 * 'always' 模式下（步骤 5 放行聚焦状态），「正在查看的会话不打扰」的豁免
 * 完全依赖渲染端上报的 requireHidden（步骤 4 的 on-screen 判定）；主进程
 * isAnyWindowFocused 不参与 'always' 的独立豁免。'hidden-only' 模式下两者
 * 叠加：步骤 4 保护被查看会话，步骤 5 保护任何聚焦状态下的打扰。
 */
export function decideNotification(input: {
  request: NotificationRequest
  settings: NotificationSettingsLike
  anyWindowFocused: boolean
}): { action: 'show' } | { action: 'skip'; reason: string } {
  const { request, settings, anyWindowFocused } = input;
  if (request.kind === 'test') return { action: 'show' };
  if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
  const kindSwitch: Record<'complete' | 'ask' | 'request', boolean> = {
    complete: settings.onComplete,
    ask: settings.onAsk,
    request: settings.onRequest,
  };
  if (!kindSwitch[request.kind]) return { action: 'skip', reason: 'kind-off' };
  if (request.requireHidden && anyWindowFocused) return { action: 'skip', reason: 'on-screen' };
  if (settings.mode === 'hidden-only' && anyWindowFocused) {
    // 'always' 放行聚焦状态：此处不拦截。焦点豁免（正在查看的会话不打扰）
    // 在 'always' 模式下完全依赖渲染端 requireHidden（上面的 on-screen 判定）
    // ——主进程 isAnyWindowFocused 不参与 'always' 的独立豁免（信任切分见
    // 模块头注释，review 2026-08）。
    return { action: 'skip', reason: 'focused-hidden-only' };
  }
  return { action: 'show' };
}

/** 去重 TTL（OpenChamber 同款）：同 key 5s 内只发一次，防事件风暴/双路径重放双发。 */
export const NOTIFICATION_DEDUPE_TTL_MS = 5_000;

/** 去重 claim 表：key = JSON([sourceId, sessionId, kind]) → 上次 claim 时间戳。 */
const notificationClaims = new Map<string, number>();

/**
 * 去重 claim（与 OpenChamber 同款）：同 key 在 TTL 内第二次返回 false；
 * TTL 过后恢复可发；不同 key 互不影响。'test' 不走 claim（恒 true——测试按钮
 * 连点每次都应真实显示）。顺手清理过期条目，map 按 TTL 窗口保持有界。
 */
export function claimNotification(request: NotificationRequest, now: number = Date.now()): boolean {
  if (request.kind === 'test') return true;
  const key = JSON.stringify([request.sourceId, request.sessionId, request.kind]);
  const claimedAt = notificationClaims.get(key);
  if (claimedAt !== undefined && now - claimedAt < NOTIFICATION_DEDUPE_TTL_MS) {
    return false;
  }
  // 清理 TTL 窗口外的条目（只在本次 claim 通过后做，避免每请求全表扫描）。
  for (const [existingKey, at] of notificationClaims) {
    if (now - at >= NOTIFICATION_DEDUPE_TTL_MS) notificationClaims.delete(existingKey);
  }
  notificationClaims.set(key, now);
  return true;
}

/** 字段长度上限（防异常 title/body 刷屏，design 19 §3.6）。 */
const MAX_SOURCE_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 512;

const NOTIFICATION_KINDS: ReadonlySet<string> = new Set(['complete', 'ask', 'request', 'test']);

/**
 * IPC payload 白名单校验（design 19 §3.6）：sourceId/sessionId/title/body 必须
 * 为非空 string（前三个 ≤256、body ≤512）、kind 四选一、requireHidden 为
 * boolean。未知/多余字段忽略（校验只做白名单必要字段，不做全等断言）。
 */
export function validateNotificationRequest(
  raw: unknown,
): { ok: true; request: NotificationRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'notification payload must be an object' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.sourceId !== 'string' || record.sourceId === '') {
    return { ok: false, error: 'sourceId must be a non-empty string' };
  }
  if (record.sourceId.length > MAX_SOURCE_ID_LENGTH) {
    return { ok: false, error: `sourceId is too long (max ${MAX_SOURCE_ID_LENGTH})` };
  }
  if (typeof record.sessionId !== 'string') {
    return { ok: false, error: 'sessionId must be a string' };
  }
  if (record.sessionId.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, error: `sessionId is too long (max ${MAX_SESSION_ID_LENGTH})` };
  }
  if (typeof record.kind !== 'string' || !NOTIFICATION_KINDS.has(record.kind)) {
    return { ok: false, error: 'kind must be one of "complete" | "ask" | "request" | "test"' };
  }
  // sessionId 非空要求仅对真实会话事件生效：'test'（设置页测试按钮）没有会话
  // 上下文，允许空串——但 click 处理必须跳过 test 的打开会话路径（main.ts）。
  if (record.sessionId === '' && record.kind !== 'test') {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  if (typeof record.title !== 'string' || record.title === '') {
    return { ok: false, error: 'title must be a non-empty string' };
  }
  if (record.title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `title is too long (max ${MAX_TITLE_LENGTH})` };
  }
  if (typeof record.body !== 'string' || record.body === '') {
    return { ok: false, error: 'body must be a non-empty string' };
  }
  if (record.body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: `body is too long (max ${MAX_BODY_LENGTH})` };
  }
  if (typeof record.requireHidden !== 'boolean') {
    return { ok: false, error: 'requireHidden must be a boolean' };
  }
  return {
    ok: true,
    request: {
      sourceId: record.sourceId,
      sessionId: record.sessionId,
      kind: record.kind as NotificationKind,
      title: record.title,
      body: record.body,
      requireHidden: record.requireHidden,
    },
  };
}
