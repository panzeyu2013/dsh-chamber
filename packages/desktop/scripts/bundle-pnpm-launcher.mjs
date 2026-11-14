/**
 * bundle-dsh 的 pnpm 启动形状（版本探测与安装执行共用同一份）。
 *
 * Windows 上 pnpm 以 `pnpm.cmd` 暴露，而 Node ≥18.20.2/20.12.2 起拒绝不经
 * shell 直启 .cmd/.bat（CVE-2024-27980，EINVAL）：探测写死 `spawnSync('pnpm.cmd')`
 * 时，PATH 上精确版本的 pnpm 永远探测不到，每次都退到 `npx --yes pnpm@…` 兜底
 * （执行路径带 `shell: process.platform === 'win32'`，探测必须与之一致）。
 * 探测与执行因此共用 `bundlePnpmLaunch()`：Windows 经 cmd.exe
 * 解析 `pnpm.cmd`，POSIX 直接 exec。`npx` 兜底保留。
 */
export function bundlePnpmLaunch(platform = process.platform) {
  return { command: 'pnpm', shell: platform === 'win32' }
}

/** 安装命令的有界尝试次数：瞬时失败只重试一次，绝不无限重试。 */
export const BUNDLE_PNPM_INSTALL_ATTEMPTS = 2

/**
 * pnpm 安装的瞬时失败分类：ZFS 上建 hardlink 偶发 `ERR_PNPM_EAGAIN`
 * （首次失败、二次成功；staging 可弃、安装幂等），只需一次有界重试。
 * 其它失败（ENOSPC、冻结锁冲突、真实解析错误）不得重试——重试会掩盖它们。
 * `output` 是被捕获的 stderr（可是空串）。
 */
export function isTransientPnpmEagain(output) {
  if (typeof output !== 'string' || output === '') return false
  return /ERR_PNPM_EAGAIN/.test(output) || /\bEAGAIN\b/.test(output)
}

/**
 * pnpm 安装输出合并：stdout / stderr 各管道分块保序（stdout 块在前、stderr 块在后）。
 * 瞬时判定不得只看 stderr——pnpm 的 ERR_PNPM_EAGAIN 行可能落在 stdout。
 * @param {string | undefined} stdout - 捕获的 stdout（可为空）
 * @param {string | undefined} stderr - 捕获的 stderr（可为空）
 * @returns {string} 合并后的输出（分类与转发的单一来源）
 */
export function mergePnpmInstallOutput(stdout, stderr) {
  return [stdout, stderr].filter((chunk) => typeof chunk === 'string' && chunk !== '').join('\n')
}

/**
 * 每次安装尝试的 spawn env：第一次原样，后续尝试强制 hardlink 导入方式
 * （ZFS 上 ERR_PNPM_EAGAIN 是建 hardlink 的瞬时失败；hardlink 是最轻的物理落盘路径）。
 * @param {number} attempt - 1-based 尝试序号
 * @param {NodeJS.ProcessEnv} [baseEnv] - 基础 env（测试注入；默认 process.env）
 * @returns {NodeJS.ProcessEnv} 该次尝试的 env
 */
export function pnpmInstallRetryEnv(attempt, baseEnv = process.env) {
  if (attempt <= 1) return baseEnv
  return { ...baseEnv, npm_config_package_import_method: 'hardlink' }
}
