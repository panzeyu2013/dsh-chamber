/**
 * Main-process shared pure logic for the gateway plugin-apply IPC surface: payload
 * validation + confirmation copy builder + registry-spec name parser. No Electron
 * imports. The whitelists are the control-plane shared single source, the same one
 * the gateway routes validate against: a renderer spec that passes here cannot be
 * refused there for shape reasons (the gateway stays authoritative; this is defense
 * in depth + fast, honest pre-flight errors).
 */

import {
  extractSpecName,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
} from './control-plane-module.ts'

/** Per-list op bound of one apply batch (design: ≤ 20 ops each). */
export const GATEWAY_APPLY_MAX_OPS = 20
/** Per-spec/name length bound of one apply batch item. */
export const GATEWAY_APPLY_MAX_ITEM_CHARS = 200

/** The validated apply payload the IPC handler executes with. */
export interface GatewayApplyPayloadValue {
  add: string[]
  remove: string[]
  deferRestart: boolean
}

export type GatewayApplyPayloadValidation =
  | { ok: true; value: GatewayApplyPayloadValue }
  | { ok: false; error: string }

/**
 * Parse + validate one registry ADD spec (`name@spec` | `name`, optional scope) into its
 * package name: client-side mirror of the gateway install route's SHAPE validation. `file:`
 * specs are REFUSED here (folder pushes go through gateway_plugin_materialize). Returns null
 * for any invalid shape; the caller owns the honest error text. The PROTECTED-SET judgement is
 * NOT mirrored — family facts live on the server, whose own decide is the authority.
 */
export function parseSpecArg(spec: string): { name: string } | null {
  if (typeof spec !== 'string') return null
  if (spec === '' || spec.length > MAX_PLUGIN_SPEC_CHARS) return null
  if (!PLUGIN_SPEC_PATTERN.test(spec)) return null
  const name = pluginSpecName(spec)
  if (!PLUGIN_NAME_PATTERN.test(name)) return null
  return { name }
}

/** Package name a registry spec refers to: everything before the LAST `@` (shape already
 *  guaranteed by the whitelist); bare `@scope/name` is returned whole. Single-sourced in
 *  control-plane plugin-spec.ts via the control-plane-module facade. */
export const pluginSpecName = extractSpecName

/**
 * Validate the renderer-supplied apply payload: add/remove arrays of strings, ≤
 * GATEWAY_APPLY_MAX_OPS each, each item ≤ GATEWAY_APPLY_MAX_ITEM_CHARS and whitelist-SHAPED
 * (adds are registry specs — `file:` refused; removes are bare names); deferRestart boolean
 * when present. Never trust the renderer: the gateway re-validates per op and runs the
 * protected-set decision server-side, so this payload check is shape only.
 */
export function validateApplyPayload(input: unknown): GatewayApplyPayloadValidation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid apply payload' }
  }
  const record = input as Record<string, unknown>
  const add = record.add
  const remove = record.remove
  const deferRestart = record.deferRestart
  if (!Array.isArray(add)) return { ok: false, error: 'add must be an array of registry specs' }
  if (!Array.isArray(remove)) return { ok: false, error: 'remove must be an array of plugin names' }
  if (add.length > GATEWAY_APPLY_MAX_OPS) {
    return { ok: false, error: `add is limited to ${GATEWAY_APPLY_MAX_OPS} specs per apply` }
  }
  if (remove.length > GATEWAY_APPLY_MAX_OPS) {
    return { ok: false, error: `remove is limited to ${GATEWAY_APPLY_MAX_OPS} names per apply` }
  }
  if (deferRestart !== undefined && typeof deferRestart !== 'boolean') {
    // A non-boolean `deferRestart` (e.g. the string 'false') must never be
    // treated as truthy and skip an expected restart.
    return { ok: false, error: 'deferRestart must be a boolean' }
  }
  for (const item of add) {
    if (typeof item !== 'string' || item.length > GATEWAY_APPLY_MAX_ITEM_CHARS) {
      return { ok: false, error: `invalid add spec: ${JSON.stringify(item)}` }
    }
    if (parseSpecArg(item) === null) {
      return { ok: false, error: `invalid add spec: ${JSON.stringify(item)}` }
    }
  }
  for (const item of remove) {
    if (typeof item !== 'string' || item.length > GATEWAY_APPLY_MAX_ITEM_CHARS) {
      return { ok: false, error: `invalid remove name: ${JSON.stringify(item)}` }
    }
    if (!PLUGIN_NAME_PATTERN.test(item)) {
      return { ok: false, error: `invalid remove name: ${JSON.stringify(item)}` }
    }
  }
  if (add.length === 0 && remove.length === 0) {
    return { ok: false, error: 'nothing to apply: add and remove are both empty' }
  }
  return {
    ok: true,
    value: { add: add as string[], remove: remove as string[], deferRestart: deferRestart === true },
  }
}

/** List copy helper: first three items joined, `等 N 个` when longer. */
function copyList(items: string[]): string {
  return items.length <= 3
    ? items.join('、')
    : `${items.slice(0, 3).join('、')} 等 ${items.length} 个`
}

/**
 * Confirmation-dialog copy builder for the gateway plugin apply: a batch write onto the
 * gateway's managed dsh is a persistent, globally-visible (multi-desktop) change, never a
 * silent script action. zh-CN copy consistent with the ssh/local confirmations in plugin-sync.ts.
 */
export function buildApplyConfirmMessage(info: {
  targetLabel: string | null
  targetId: string
  add: string[]
  remove: string[]
  deferRestart: boolean
}): { message: string; detail: string } {
  const target = info.targetLabel ?? info.targetId
  const detailParts: string[] = []
  if (info.add.length > 0) {
    detailParts.push(
      `将从 npm registry 安装 ${copyList(info.add)}（由 gateway 队列在实例上执行）。`,
    )
  }
  if (info.remove.length > 0) {
    detailParts.push(
      `将从实例移除 ${copyList(info.remove)}——已安装插件集为所有连接此 gateway 的桌面共享，移除影响全部桌面。`,
    )
  }
  detailParts.push(
    info.deferRestart
      ? '本次不自动重启；变更在该 gateway 的 dsh 实例下次重启后生效。'
      : '执行完成后将自动重启该 gateway 上的 dsh 实例使变更生效——本机及其它桌面上的会话会随之重连。',
  )
  if (info.add.length > 0) {
    detailParts.push('安装的插件代码将在 gateway 上的 dsh 实例内以该实例用户身份执行。')
  }
  return {
    message: `修改 gateway 实例 ${target} 的插件？`,
    detail: detailParts.join('\n'),
  }
}
