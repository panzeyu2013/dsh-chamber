#!/usr/bin/env node
/**
 * Ensure the shared Electron dist is present after install.
 *
 * electron@43.x 的 npm 发布包缺失 scripts 字段（无 postinstall），pnpm/npm
 * 都不会下载其二进制；桌面开发需要真实的 Electron 可执行文件。本脚本在根
 * postinstall 中兜底，物化「每机器共享 dist」（平台缓存目录，逻辑见
 * packages/desktop/scripts/electron-shared.mjs）：git worktree 并行开发时，
 * 每个 worktree 不再各自下载/解压 ~300MB —— dev 启动器（electron-dev.mjs）
 * 与 postinstall 共用同一份共享 dist；DSH_CHAMBER_ELECTRON_DIST 可指向现成
 * dist 目录（含旧流程遗留的本地 dist）直接复用。
 *
 * 惰性门（2026-08，用户拍板；2026-09 起目标改为共享 dist）：Electron 二进制
 * 只在桌面端需要——server 部署（gateway/control-plane/CLI）完全不需要它。
 * 默认 SKIP；仅当显式设置 DSH_CHAMBER_ELECTRON=1（桌面开发 dev:desktop 的
 * electron-dev.mjs 会在共享 dist 缺失时自动物化；打包 electron-builder 自行
 * 拉取自己的缓存）时才下载。全新环境先跑 gateway/单测不再白下 ~100MB 二进制。
 */
import { ensureSharedElectronDist, resolveElectronPackageDir } from '../../packages/desktop/scripts/electron-shared.mjs'

if (process.env.DSH_CHAMBER_ELECTRON !== '1') {
  console.log(
    '[ensure-electron] 跳过（未设置 DSH_CHAMBER_ELECTRON=1；仅桌面开发/打包需要，server 部署无需 Electron 二进制）',
  )
  process.exit(0)
}

// 与旧行为一致：electron npm 包缺失（desktop 依赖未安装的过滤安装等）时优雅
// 跳过而不是让 postinstall 失败——DSH_CHAMBER_ELECTRON=1 只是"允许下载"，
// 没有 electron 包可引导就无事可做。
if (resolveElectronPackageDir() === null) {
  console.log('[ensure-electron] electron 未安装（desktop 依赖缺失），跳过')
  process.exit(0)
}

try {
  const { distDir, status } = await ensureSharedElectronDist()
  console.log(`[ensure-electron] 共享 Electron dist 就绪（${status}）: ${distDir}`)
} catch (err) {
  console.error(`[ensure-electron] 引导失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
