#!/usr/bin/env node
/**
 * Ensure the Electron binary is present after install.
 *
 * electron@43.x 的 npm 发布包缺失 scripts 字段（无 postinstall），pnpm/npm
 * 都不会下载其二进制；dev:desktop 需要
 * packages/desktop/node_modules/electron/dist/electron。本脚本在根
 * postinstall 中兜底：按 .npmrc 的 electron_mirror（或 ELECTRON_MIRROR 环境
 * 变量）执行 electron 自带的 install.js；二进制已就位则跳过。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** Locate the electron package from the desktop workspace's resolution. */
function resolveElectronDir() {
  try {
    return path.dirname(require.resolve('electron/package.json', { paths: [path.join(root, 'packages', 'desktop')] }))
  } catch {
    return null
  }
}

/** Read electron_mirror from the project .npmrc (fallback: env ELECTRON_MIRROR). */
function readMirror() {
  const npmrc = path.join(root, '.npmrc')
  if (existsSync(npmrc)) {
    for (const line of readFileSync(npmrc, 'utf8').split('\n')) {
      const m = /^\s*electron_mirror\s*=\s*(\S+)\s*$/.exec(line)
      if (m !== null) return m[1]
    }
  }
  return process.env.ELECTRON_MIRROR ?? null
}

const electronDir = resolveElectronDir()
if (electronDir === null) {
  console.log('[ensure-electron] electron 未安装（desktop 依赖缺失），跳过')
  process.exit(0)
}

const version = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version
const versionFile = path.join(electronDir, 'dist', 'version')
if (existsSync(versionFile) && readFileSync(versionFile, 'utf8').trim().replace(/^v/, '') === version) {
  console.log(`[ensure-electron] electron@${version} 二进制已就位，跳过`)
  process.exit(0)
}

const mirror = readMirror()
console.log(
  mirror === null
    ? '[ensure-electron] 未配置 electron_mirror，从默认源下载（可能很慢）'
    : `[ensure-electron] 从镜像下载 electron@${version}：${mirror}`,
)
const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
  cwd: electronDir,
  stdio: 'inherit',
  env: { ...process.env, ...(mirror === null ? {} : { ELECTRON_MIRROR: mirror }) },
})
if (result.error || result.status !== 0) {
  console.error(`[ensure-electron] 下载失败（exit ${result.status ?? 'null'}）`)
  process.exit(result.status ?? 1)
}
console.log(`[ensure-electron] electron@${version} 就绪`)
