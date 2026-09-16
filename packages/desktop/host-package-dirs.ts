/**
 * host-package-dirs.ts —— chamber host 包源目录解析的纯辅助（electron-free）。
 *
 * 为什么单源：chamber host 包的注册表（control-plane 的 CHAMBER_HOST_PACKAGES）
 * 给的是 **scoped 包名**（@scope/dsh-chamber-seed-*），而 dev 布局的向上检索按
 * `<root>/packages/<目录名>` 拼路径——把 scoped 包名当目录名会让检索永远落空。
 * Electron 侧用 pkgDir 直拼、Swift 侧用 --host-*-dir 显式目录，只有 sidecar 的
 * dev 缺省路径需要这层映射；抽成纯函数以便直接单测（2026-12 审查：该映射最初
 * 内联在 sidecar-ctx 里且无测试）。
 */

/** 包名 → 仓库目录名（去 scope）：'@scope/name' → 'name'，无 scope 原样返回。 */
export function packageDirName(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '')
}
