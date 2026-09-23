/**
 * deep-link-scheme.ts —— 深链 scheme 的单一来源（前缀/协议判定与大小写规范化）。
 *
 * WHY 独立 leaf 模块：scheme 判定同时被 shell-core（argv 扫描）与 deep-link
 * （URL.protocol 校验）需要，而这两者之间已存在值依赖环（shell-core 顶层
 * `new BoundedVscodeIntentQueue(...)` / `new BoundedAckDeliveryQueue(...)` 来自
 * deep-link）。把 scheme 事实放在任一侧都会形成 ESM 循环，并命中 class 声明的
 * TDZ（顶层实例化先于对侧求值）。本模块零 import，两侧都从它取用——比较逻辑
 * 仍然只有一份实现。
 *
 * RFC 3986 §3.1：scheme 大小写不敏感（WHATWG `new URL().protocol` 与 Windows
 * 注册表查找同样不区分大小写）。除本模块外任何地方不得再出现 scheme 比较。
 */
export const DEEP_LINK_SCHEME = 'dsh-chamber'
const DEEP_LINK_SCHEME_PREFIX = DEEP_LINK_SCHEME + '://'
const DEEP_LINK_PROTOCOL = DEEP_LINK_SCHEME + ':'

/** scheme 大小写规范化（全仓唯一一处）：比较前一律经它。 */
function normalizeSchemeCase(value: string): string {
  return value.toLowerCase()
}

/** argv 深链 URL 判定：前缀必须 `dsh-chamber://`（大小写不敏感）——只比较前缀，
 *  path/query 原样保留、不参与小写化。 */
export function isDeepLinkUrl(value: string): boolean {
  return normalizeSchemeCase(value.slice(0, DEEP_LINK_SCHEME_PREFIX.length)) === DEEP_LINK_SCHEME_PREFIX
}

/** `new URL(...).protocol` 深链判定（全仓唯一比较点）。 */
export function isDeepLinkProtocol(protocol: string): boolean {
  return normalizeSchemeCase(protocol) === DEEP_LINK_PROTOCOL
}
