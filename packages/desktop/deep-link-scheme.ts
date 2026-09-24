/**
 * deep-link-scheme.ts —— 深链 scheme 的单一来源（前缀/协议判定与大小写规范化）。
 *
 * WHY 独立 leaf：scheme 判定同时被 shell-core（argv 扫描）与 deep-link（URL.protocol
 * 校验）需要，而两者之间已存在值依赖环——放在任一侧都会形成 ESM 循环并命中 class
 * 声明的 TDZ。本模块零 import，比较逻辑仍只有一份。
 * RFC 3986 §3.1：scheme 大小写不敏感；除本模块外任何地方不得再出现 scheme 比较。
 */
export const DEEP_LINK_SCHEME = 'dsh-chamber'
const DEEP_LINK_SCHEME_PREFIX = DEEP_LINK_SCHEME + '://'
const DEEP_LINK_PROTOCOL = DEEP_LINK_SCHEME + ':'

/** scheme 大小写规范化（全仓唯一一处）：比较前一律经它。 */
function normalizeSchemeCase(value: string): string {
  return value.toLowerCase()
}

/** argv 深链 URL 判定：前缀必须是 `dsh-chamber://`（大小写不敏感），只比较前缀，
 * path/query 原样保留、不参与小写化。 */
export function isDeepLinkUrl(value: string): boolean {
  return normalizeSchemeCase(value.slice(0, DEEP_LINK_SCHEME_PREFIX.length)) === DEEP_LINK_SCHEME_PREFIX
}

/** `new URL(...).protocol` 深链判定（全仓唯一比较点）。 */
export function isDeepLinkProtocol(protocol: string): boolean {
  return normalizeSchemeCase(protocol) === DEEP_LINK_PROTOCOL
}
