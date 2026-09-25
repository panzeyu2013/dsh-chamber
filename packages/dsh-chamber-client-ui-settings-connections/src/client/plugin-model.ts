/**
 * The READ-ONLY plugin-row model layer (design 21 §3 / §6.11): the pure,
 * UI-free and backend-free core of the model view PluginDialog renders — the
 * installed-row projection. The write model (apply classification, batch
 * policy, gateway task projection, undo derive and the diff/apply boundary)
 * was retired with the plugin write faces (D1); this module now carries the
 * read face alone.
 *
 * Discipline: PURE + LOCALE-FREE (no runtime imports, no window surface, no localized
 * copy — plain node runs every function). Ambient types stay in src/global.d.ts; every
 * IPC/wire shape consumed here is a LOCAL structural twin named *Shape with its authority
 * cited. The protected set P = B₀ ∪ S ∪ F is derived and projected by the BACKEND — this
 * module holds NO hand mirror of the Node-side predicate.
 */

/* ---- The read-side row projection ----
 * 后端三端各投影 `rows: PluginRow[]`（加性字段；`dependencies` 语义不变），渲染端只消费。
 * - projectInstalledRows：已安装列表行投影。行集 = profile 的依赖表——安装自带组合（B₀）
 *   与 chamber 播种物（S）不造行（chamber 组件有自己的表；官方组合是运行时基线）。受保护名若
 *   出现在依赖表里仍只读可见。行投影缺失/非数组 = 显式空投影（同版本发行恒有 `rows`；
 *   §6.11.7 的旧 gateway 回退已删除），绝不回落到 `dependencies` 过滤。
 * 本模块不重算保护集合。 */

/** 行角色（wire 单源的字面量并集；渲染端只渲染，绝不推导）。一行已安装事实的唯一声明在
 *  wire 的 `./plugin-row` 面，这里经 client-core 浏览器面只 import/再导出，不重声明字段。 */
import type {
  PluginRow as PluginRowShape,
  PluginRowRole as PluginRowRoleShape,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-row'
export type { PluginRowShape, PluginRowRoleShape }

/** 加性 `rows` 成员的载体孪生（`rows` 缺失只可能是形状违规的载荷：同版本发行的三端恒投影它）。 */
export interface PluginRowsCarrierShape {
  rows?: readonly PluginRowShape[] | undefined
}

/** 读清单上的加性行投影；缺失/非数组 → 空数组（显式空投影）。返回浅拷贝，调用方可自由排序。 */
export function pluginRowsOf(manifest: PluginRowsCarrierShape | null | undefined): PluginRowShape[] {
  if (manifest === null || manifest === undefined) return []
  const rows = manifest.rows
  return Array.isArray(rows) ? [...rows] : []
}

/** 已安装列表的一行视图（渲染端只读投影）。 */
export interface InstalledRowView {
  name: string
  /** 依赖值（掩码后）；后端行没有依赖项且自身 spec 为 null 时为 null（防御：渲染端落到版本格）。 */
  spec: string | null
  version: string | null
  role: PluginRowRoleShape
  protected: boolean
}

/**
 * Project one zone's installed rows from a backend manifest: the backend's
 * `rows` (one row per declared dependency — design 21 §6.11.5) rendered in
 * backend order. `rows: []` and a malformed/missing `rows` both render the
 * empty state — the renderer never re-derives rows from `dependencies`, since
 * that would resurrect the protection mirror the renderer must not own.
 */
export function projectInstalledRows(
  dependencies: Record<string, string>,
  rows: readonly PluginRowShape[],
): InstalledRowView[] {
  return rows.map(row => ({
    name: row.name,
    spec: dependencies[row.name] ?? row.spec ?? null,
    version: row.version,
    role: row.role,
    protected: row.protected,
  }))
}
