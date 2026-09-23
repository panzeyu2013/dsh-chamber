/**
 * The read-face plugin-row wire contract (design 21 §6.11.5): THE single
 * definition of the row shape every plugin-read backend projects and every
 * consumer reads.
 *
 * Consumers, all through THIS module (a backend that derives rows and a client
 * that renders them never re-declare the shape):
 * - control-plane `protected-plugins.ts` (the row producer) re-exports these
 *   names, so gateway (`plugins-installed.ts`) and the desktop main
 *   (`plugin-sync.ts` through `control-plane-module.ts`) keep consuming
 *   `PluginRow` / `PluginRowRole` off the control-plane surface;
 * - desktop preload (`preload.cts`) and renderer (`renderer/src/global.d.ts`)
 *   consume the shape through client-core's pass-through face
 *   (`@dsh-chamber/dsh-chamber-client-core/plugin-row`), the same browser-side
 *   pattern as `./plugin-manifest`;
 * - settings-connections (`client/plugin-model.ts`) consumes the same
 *   client-core face and renames it at the module edge
 *   (`PluginRowShape` / `PluginRowRoleShape`) without re-declaring it.
 *
 * C14 in `scripts/upstream/plugin-protection-gate.mjs` asserts this file's
 * field set against the expected signature and asserts every consumer only
 * imports/re-exports it — a local redeclaration, a drifted reference face, or a
 * missing field here is red.
 *
 * PURE + TYPE-ONLY: zero runtime exports, zero dependencies — the seed esbuild
 * bundle and every client bundle inline or erase it.
 */

/** 行角色（读面投影；渲染端只渲染，不推导）。 */
export type PluginRowRole =
  | 'composition'
  | 'seed'
  | 'layer'
  | 'third-party'
  | 'materialized'
  | 'unknown'

/** 一行已安装事实（design 21 §6.11.5 的 wire 形状）。 */
export interface PluginRow {
  name: string
  /** 声明的依赖值（各后端按自己的掩码纪律处理）。投影行恒来自依赖表，
   *  因此除非掩码器显式返回 null，它不会是 null。 */
  spec: string | null
  /** 已装版本（能从 node_modules 清单读到才有；否则 null）。 */
  version: string | null
  role: PluginRowRole
  protected: boolean
  owner?: 'installation' | 'chamber' | 'user'
}
