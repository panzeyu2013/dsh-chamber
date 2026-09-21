/**
 * SVG resource scoper artifact markers — single source for the mobile committed
 * bundle guard (`artifact-scope-marker.test.mjs`) and the post-build page guard
 * (`assert-scoper-artifact.mjs`). W8 / R15③; the artifact-freshness family of
 * STATUS:61.
 *
 * The three facts the fix is made of:
 *   1. the attribute the installer stamps on every processed <svg>;
 *   2. the document-unique token prefix family;
 *   3. the entry's **anchored install CALL** (a definition without the call proves nothing).
 *
 * 第三个标记为什么是「属性名 + 必须是调用」而不是裸调用文本（2026-12 审计 S3 修正）：
 *   - 裸调用名 `installSvgResourceScope()` 在 esbuild **压缩**后会被改成短标识符（实测安装态为
 *     `Aw()`），于是页面产物守卫对任何真实构建**恒红**（旧标记集就是这样坏的）；
 *   - 入口改写成语义等价的锚定赋值 `globalThis.__chamberSvgScopeInstalled = installSvgResourceScope()`
 *     后，点号属性名不被压缩改写，因此**压缩与未压缩产物都能 grep 到**；
 *   - 但单一子串无法同时覆盖两种空格形态（压缩后 `=` 无空格、未压缩有空格），所以第三个事实用
 *     **模式**判定：属性名出现，且右侧确实是一次调用（把右侧换成 `null` 即失配 ⇒ 负控仍成立）。
 */

/** The bundle wrapper the mobile loader installs (proves the file is the client bundle). */
export const CLIENT_BUNDLE_MARKER = 'window.__ModuleLoader__.load'

/** Marker ①/②: plain string literals that survive minification. */
export const SCOPER_LITERAL_MARKERS = [
  'data-chamber-svg-scope',
  'chamber-csvg',
]

/** The anchored-assignment property name (marker ③'s anchor). */
export const SCOPER_CALL_MARKER_NAME = '__chamberSvgScopeInstalled'

/** Marker ③'s human label (what callers print when it is missing). */
const CALL_MARKER_LABEL = SCOPER_CALL_MARKER_NAME + '=<call>'

/** The three marker labels, in report order (①/② literal, ③ pattern). */
export const SCOPER_MARKERS = [
  ...SCOPER_LITERAL_MARKERS,
  CALL_MARKER_LABEL,
]

/**
 * Marker ③: the anchored property is assigned a **call** (whitespace-agnostic, so
 * both the minified page chunk and the pretty-printed mobile bundle match).
 */
const CALL_ASSIGNMENT_PATTERN = new RegExp(
  SCOPER_CALL_MARKER_NAME + '\\s*=\\s*[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*\\s*[(<]',
)

/** True when `source` shows the entry assigning the anchored install call. */
export function hasScoperCallMarker(source) {
  return CALL_ASSIGNMENT_PATTERN.test(source)
}

/**
 * Markers absent from `source` (empty = fresh).
 * @param {string} source - artifact text.
 * @returns {string[]} missing marker labels, in {@link SCOPER_MARKERS} order.
 */
export function missingScoperMarkers(source) {
  const missing = SCOPER_LITERAL_MARKERS.filter(marker => !source.includes(marker))
  if (!hasScoperCallMarker(source)) missing.push(CALL_MARKER_LABEL)
  return missing
}
