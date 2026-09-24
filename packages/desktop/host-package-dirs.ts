/**
 * host-package-dirs.ts —— chamber host 包源目录解析的纯辅助（electron-free）。
 *
 * 为什么单源：control-plane 的 CHAMBER_HOST_PACKAGES 给 scoped 包名，而 dev 布局
 * 向上检索按 `<root>/packages/<目录名>` 拼路径——scoped 包名当目录名会永远落空。
 */

/** 包名 → 仓库目录名（去 scope）：'@scope/name' → 'name'，无 scope 原样返回。 */
export function packageDirName(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '')
}
