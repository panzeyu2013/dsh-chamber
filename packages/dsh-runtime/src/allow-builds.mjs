/**
 * dsh runtime allowBuilds 白名单 —— 单一来源常量（design 18 §4 R3-2 F6/F7、
 * R3-5 P2-3）。
 *
 * 构建期 bundler（scripts/bundle-dsh.mjs）与运行期安装器（M2
 * dsh-runtime-updater 编译产物）必须放行**完全相同的** build-script 依赖集；
 * 白名单 miss 是硬失败（ERR_PNPM_IGNORED_BUILDS），两处漂移会让「构建期能装、
 * 运行期装不上」（或反之）。本文件用 .mjs 以便 bundle-dsh.mjs 直接 import，
 * 保证两个编译产物同源。
 *
 * 新增条目纪律：只有确需执行安装脚本（原生模块/编译步骤）的依赖才能入列；
 * 白名单语义 = 信任该包在安装期执行任意脚本（供应链信任声明，design 18 §4）。
 */
export const ALLOW_BUILDS = [
  'node-pty',
  'koffi',
  'fs-ext',
  'protobufjs',
  '@google/genai',
  '@deepseek-ai/dsh-subprocess-local',
];

/**
 * 显式否认的 build-script 依赖（design 18 §4，2026-09 0.1.5 线补录）。
 *
 * pnpm 11 的 strictDepBuilds 默认 true：**未列出**的 build-script 依赖是硬失败
 * （ERR_PNPM_IGNORED_BUILDS），所以「不使用其安装脚本」也必须显式登记，否则构建期
 * （bundle:dsh）与运行期（M2 安装器）都会装不上。语义 = 已评审并拒绝该包在安装期
 * 执行脚本。
 * - msgpackr-extract：msgpackr 的原生加速器（0.1.5 线 store-index 依赖引入）；
 *   只用 msgpackr 的可移植 JS 编解码即可，与上游 pnpm-workspace 的裁决一致。
 */
export const DENY_BUILDS = ['msgpackr-extract'];

/**
 * 渲染 pnpm-workspace.yaml 的 allowBuilds 块（两个生成点共用，防漂移）：
 * 放行项 → `true`，否认项 → `false`。
 * @returns 缩进好的 YAML 行（不含 `allowBuilds:` 头）。
 */
export function renderAllowBuildsBlock() {
  return [
    ...ALLOW_BUILDS.map((name) => `  ${JSON.stringify(name)}: true`),
    ...DENY_BUILDS.map((name) => `  ${JSON.stringify(name)}: false`),
  ].join('\n');
}
