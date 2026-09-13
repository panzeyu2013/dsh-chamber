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
 * - msgpackr-extract：msgpackr 的原生加速器，由上游**私有**桌面应用构建面引入
 *   （`apps/desktop/scripts/macos-seed-store.ts` 用 `msgpackr`；上游 `packages/**`
 *   无 msgpackr 依赖，本 pin 亦无 store-index 包）。运行时闭包不含它——已提交的
 *   `packages/desktop/vendor/dsh/pnpm-lock.yaml` 对 `msgpackr*` 零命中——故该否认
 *   在运行时树是**惰性的防御性 false**（登记语义，不是已发生的拒绝），与上游
 *   pnpm-workspace 的裁决一致。
 * - node-addon-require-builtin：上游 pnpm-workspace 显式 `false`；本仓运行时锁文件里
 *   有它（0.1.4），但该版本**没有**任何 install/preinstall/postinstall 脚本（已实测），
 *   所以这一条今天是惰性的防御性登记——将来版本若加上安装脚本，pnpm 会按我们的裁决
 *   拒绝执行而不是硬失败。
 *
 * 与上游的**有意差异**（登记，不擅自改行为）：`protobufjs`（postinstall）与
 * `@google/genai` 在本清单里是 `true`，而上游 pnpm-workspace 记 `false` 并注明其脚本
 * 是 no-op。运行时闭包的安装脚本集只能由真机首装验证，因此在对齐前保留放行；对齐需
 * 一次 M2 全新安装的门禁证据（见 STATUS 的 open 项）。
 */
export const DENY_BUILDS = ['msgpackr-extract', 'node-addon-require-builtin'];

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
