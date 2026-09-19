/**
 * bundle-dsh 的 pnpm 启动形状（版本探测与安装执行共用同一份）。
 *
 * Windows 上 pnpm 以 `pnpm.cmd` 暴露，而 Node ≥18.20.2/20.12.2 起拒绝不经
 * shell 直启 .cmd/.bat（CVE-2024-27980，EINVAL）：探测写死 `spawnSync('pnpm.cmd')`
 * 时，PATH 上精确版本的 pnpm 永远探测不到，每次都退到 `npx --yes pnpm@…` 兜底
 * （2026-12 复核 P2——执行路径本来就带 `shell: process.platform === 'win32'`，
 * 只有探测漏了）。探测与执行因此共用 `bundlePnpmLaunch()`：Windows 经 cmd.exe
 * 解析 `pnpm.cmd`，POSIX 直接 exec。`npx` 兜底保留。
 */
export function bundlePnpmLaunch(platform = process.platform) {
  return { command: 'pnpm', shell: platform === 'win32' }
}
