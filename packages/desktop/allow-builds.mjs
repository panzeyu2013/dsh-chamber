/**
 * dsh runtime allowBuilds 白名单 —— 单一来源常量（design 16 §4 R3-2 F6/F7、
 * R3-5 P2-3）。
 *
 * 构建期 bundler（scripts/bundle-dsh.mjs）与运行期安装器（M2
 * dsh-runtime-updater 编译产物）必须放行**完全相同的** build-script 依赖集；
 * 白名单 miss 是硬失败（ERR_PNPM_IGNORED_BUILDS），两处漂移会让「构建期能装、
 * 运行期装不上」（或反之）。本文件用 .mjs 以便 bundle-dsh.mjs 直接 import，
 * 保证两个编译产物同源。
 *
 * 新增条目纪律：只有确需执行安装脚本（原生模块/编译步骤）的依赖才能入列；
 * 白名单语义 = 信任该包在安装期执行任意脚本（供应链信任声明，design 16 §4）。
 */
export const ALLOW_BUILDS = [
  'node-pty',
  'koffi',
  'protobufjs',
  '@google/genai',
  '@deepseek-ai/dsh-subprocess-local',
];
