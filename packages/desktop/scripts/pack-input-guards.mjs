#!/usr/bin/env node
/**
 * pack-input-guards.mjs — G5「打包前输入兜底」断言（design 21 §7；TODO D§2.2）。
 *
 * 为什么需要：C8 只保证 seed/runtime 的 dist 与 src 一致，标记守卫只保证
 * control-plane / gateway 产物里出现过当前契约串；dist/web 与 host 包无论文可锁，
 * 于是「改了源码没重建产物」能一路绿到打包/签名。G3 给这些忽略态产物写了
 * `.build-manifest.json`（输入摘要 + 输出指纹），本模块在**现行出货腿**上把它们
 * 再断言一次：存在 + 新鲜（manifest 摘要 / mtime），失败信息带重建命令。
 *
 * 挂点：`pnpm run build:sidecar`（build-sidecar.mjs 的 CLI 成功后、非 dry-run 时
 * 运行）。原 TODO 建议挂在 electron-builder 的 before-pack：Electron flavor 已冻结
 * （docs/progress/electron-frozen.md §2/§5.1，before-pack.mjs 归档只读），所以现行
 * 挂点 = Swift 出货链的 sidecar 装配；Electron 复活时按 §6 在 before-pack 里调用
 * `assertPackArtifactsFresh({ requirePresence: true })` 即可（本模块支持严格档）。
 *
 * 「fresh checkout 缺失另判」（TODO D§2.2 原话）：
 *   - 缺失（未构建）⇒ status='missing'：sidecar 腿的缺省档 loud SKIP（不是陈旧；
 *     clean checkout 的 dist 缺失是正常态），调用方传 requirePresence=true 时升级为失败；
 *   - 存在但陈旧 ⇒ status='stale'：一律失败，绝不自动修复（自动重建会让操作者以为
 *     产物被检查过），错误文案给重建命令（TODO D§2.3）。
 *
 * 覆盖的四类（G5 原文）：dist/web、dist/preload.cjs、dist/host-*-package、
 * dist/control-plane。两种模式：
 *   - `sidecar`（现行出货腿的默认挂点）：只断言本腿真正消费的 dist/web 与
 *     dist/control-plane——host-*-package 是 Electron 侧拷贝、preload.cjs 只属
 *     Electron 打包（均已冻结），拿它们的陈旧去阻断 Swift 打包会让不相关归档件
 *     卡住正式发布；这两类的新鲜度由 verify-artifact-freshness 的 G3 清单类
 *     （host 包）与逐字节比对类（preload）承担；
 *   - `electron-pack`（复活/严格档）：四类全查，配合 requirePresence=true 就是
 *     Electron 打包前 before-pack 的存在 + 新鲜度兜底。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOST_PACKAGE_ARTIFACT_ID,
  HOST_PACKAGE_REBUILD_COMMAND,
  WEB_DIST_ARTIFACT_ID,
  WEB_DIST_REBUILD_COMMAND,
  hostPackageArtifactId,
  hostPackageInputFiles,
  hostPackageToolVersion,
  verifyBuildManifest,
  webDistInputFiles,
  webDistToolVersion,
} from './build-manifest.mjs'
import { HOST_PACKAGE_BUILD_ROWS } from './build-host-graph-package.mjs'

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..')

/** mtime tolerance (HFS+/FAT style 1s granularity; build order still dominates). */
const MTIME_TOLERANCE_MS = 1000

/** Rebuild command per guarded artifact (single source of every failure message). */
export const PACK_INPUT_REBUILD_COMMANDS = Object.freeze({
  web: WEB_DIST_REBUILD_COMMAND,
  preload: 'pnpm --filter @dsh-chamber/desktop run build:preload',
  controlPlane: 'pnpm --filter @dsh-chamber/desktop run build:control-plane',
  hostPackages: HOST_PACKAGE_REBUILD_COMMAND,
})

/** Input files that only mtime-freshness can judge (no manifest builder writes them). */
const PRELOAD_INPUT_FILES = Object.freeze([
  'packages/desktop/electron/preload.cts',
  'packages/desktop/transport-provider.ts',
  'packages/desktop/ssh-config.ts',
  'packages/desktop/updater.ts',
  'packages/desktop/dsh-runtime-controller.ts',
  'packages/desktop/ipc-events.ts',
  'packages/desktop/scripts/build-preload.mjs',
  'packages/desktop/tsconfig.preload.build.json',
  'tsconfig.json',
])
const CONTROL_PLANE_INPUT_DIRS = Object.freeze([
  'packages/control-plane/src',
  'packages/dsh-chamber-wire/src',
])
const CONTROL_PLANE_INPUT_FILES = Object.freeze([
  'packages/desktop/scripts/build-control-plane.mjs',
  'packages/desktop/tsconfig.control-plane.build.json',
  'tsconfig.json',
])
/** Names never walked while collecting mtime inputs. */
const SKIP_INPUT_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', 'test-fixtures', 'coverage', 'release'])

/** @param {string} dir @param {string[]} out @returns {string[]} every regular file under dir */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_INPUT_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      walkFiles(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/** Newest mtime (ms) over files + walked dirs; missing entries are a hard error. */
function newestMtime(root, dirs, files) {
  let newest = 0
  for (const relativeDir of dirs) {
    const full = join(root, relativeDir)
    if (!existsSync(full)) throw new Error('pack-input-guards: 声明的输入目录不存在：' + relativeDir)
    for (const file of walkFiles(full)) newest = Math.max(newest, statSync(file).mtimeMs)
  }
  for (const relativeFile of files) {
    const full = join(root, relativeFile)
    if (!existsSync(full)) throw new Error('pack-input-guards: 声明的输入文件不存在：' + relativeFile)
    newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
}

/** Verdict helper. */
function verdict(id, status, detail, rebuild) {
  return { id, status, detail, rebuild }
}

/**
 * dist/web: presence = index.html, freshness = G3 manifest (inputs digest +
 * toolchain + output fingerprints).
 * @param {{ desktopDir?: string, root?: string }} [options]
 */
export function inspectWebDist({ desktopDir = DESKTOP_DIR, root = REPO_ROOT } = {}) {
  const dir = join(desktopDir, 'dist', 'web')
  const rebuild = PACK_INPUT_REBUILD_COMMANDS.web
  if (!existsSync(join(dir, 'index.html'))) {
    return verdict('dist/web', 'missing', '未构建（缺 dist/web/index.html）', rebuild)
  }
  try {
    const result = verifyBuildManifest(dir, {
      artifactId: WEB_DIST_ARTIFACT_ID,
      inputs: webDistInputFiles({ root }),
      toolVersion: webDistToolVersion({ root }),
      rebuildCommand: rebuild,
    })
    // verifyBuildManifest 的成功态是 'ok'；G5 的判词只有 fresh/missing/stale。
    if (result.status === 'ok') {
      return verdict('dist/web', 'fresh', '构建清单一致（' + String(result.manifest.inputsCount) + ' 输入 / ' + String(result.manifest.outputs.length) + ' 输出）', rebuild)
    }
    return verdict('dist/web', result.status, result.problems.join('；'), rebuild)
  } catch (error) {
    return verdict('dist/web', 'stale', '无法判定新鲜度：' + (error instanceof Error ? error.message : String(error)), rebuild)
  }
}

/**
 * dist/preload.cjs: presence + mtime freshness against its compile inputs.
 * @param {{ desktopDir?: string, root?: string }} [options]
 */
export function inspectPreload({ desktopDir = DESKTOP_DIR, root = REPO_ROOT } = {}) {
  const artifact = join(desktopDir, 'dist', 'preload.cjs')
  const rebuild = PACK_INPUT_REBUILD_COMMANDS.preload
  if (!existsSync(artifact)) return verdict('dist/preload.cjs', 'missing', '未构建（Electron 归档件；复活打包时才会产出）', rebuild)
  const newest = newestMtime(root, [], PRELOAD_INPUT_FILES)
  const artifactMtime = statSync(artifact).mtimeMs
  if (artifactMtime + MTIME_TOLERANCE_MS < newest) {
    return verdict('dist/preload.cjs', 'stale', '产物早于编译输入（artifact mtime ' + new Date(artifactMtime).toISOString() + ' < input ' + new Date(newest).toISOString() + '）', rebuild)
  }
  return verdict('dist/preload.cjs', 'fresh', '产物不早于全部编译输入', rebuild)
}

/**
 * dist/control-plane/index.js: presence + mtime freshness against the bundled
 * control-plane/wire sources and the builder.
 * @param {{ desktopDir?: string, root?: string }} [options]
 */
export function inspectControlPlane({ desktopDir = DESKTOP_DIR, root = REPO_ROOT } = {}) {
  const artifact = join(desktopDir, 'dist', 'control-plane', 'index.js')
  const rebuild = PACK_INPUT_REBUILD_COMMANDS.controlPlane
  if (!existsSync(artifact)) return verdict('dist/control-plane', 'missing', '未构建（缺 dist/control-plane/index.js）', rebuild)
  const newest = newestMtime(root, CONTROL_PLANE_INPUT_DIRS, CONTROL_PLANE_INPUT_FILES)
  const artifactMtime = statSync(artifact).mtimeMs
  if (artifactMtime + MTIME_TOLERANCE_MS < newest) {
    return verdict('dist/control-plane', 'stale', '产物早于编译输入（artifact mtime ' + new Date(artifactMtime).toISOString() + ' < input ' + new Date(newest).toISOString() + '）', rebuild)
  }
  return verdict('dist/control-plane', 'fresh', '产物不早于全部编译输入', rebuild)
}

/**
 * dist/host-*-package: every row must be present WITH a G3 manifest whose inputs
 * (the seed package's built dist) still match. One aggregate verdict keeps the
 * row set from silently shrinking to the one directory that happens to exist.
 * @param {{ desktopDir?: string, root?: string, rows?: readonly {label: string, sourceDir: string, outDir: string}[] }} [options]
 */
export function inspectHostPackages({ desktopDir = DESKTOP_DIR, root = REPO_ROOT, rows = HOST_PACKAGE_BUILD_ROWS } = {}) {
  const rebuild = PACK_INPUT_REBUILD_COMMANDS.hostPackages
  const results = []
  for (const row of rows) {
    const dir = join(desktopDir, 'dist', basename(row.outDir))
    if (!existsSync(join(dir, 'dist', 'index.js')) || !existsSync(join(dir, 'package.json'))) {
      results.push({ label: row.label, status: 'missing', problems: ['缺 ' + dir] })
      continue
    }
    try {
      const result = verifyBuildManifest(dir, {
        artifactId: hostPackageArtifactId(dir),
        inputs: hostPackageInputFiles(row.sourceDir, { root }),
        toolVersion: hostPackageToolVersion(),
        rebuildCommand: rebuild,
      })
      results.push({ label: row.label, status: result.status, problems: result.problems })
    } catch (error) {
      results.push({ label: row.label, status: 'stale', problems: ['无法判定新鲜度：' + (error instanceof Error ? error.message : String(error))] })
    }
  }
  const missing = results.filter((result) => result.status === 'missing')
  const stale = results.filter((result) => result.status === 'stale')
  const detail = results.filter((result) => result.status !== 'fresh').map((result) => result.label + '：' + result.problems.join('；')).join('、')
  if (missing.length === results.length) {
    return verdict(HOST_PACKAGE_ARTIFACT_ID, 'missing', '未构建（Electron 侧拷贝；当前出货腿不产出）', rebuild)
  }
  if (stale.length > 0 || missing.length > 0) {
    return verdict(HOST_PACKAGE_ARTIFACT_ID, 'stale', detail, rebuild)
  }
  return verdict(HOST_PACKAGE_ARTIFACT_ID, 'fresh', results.length + ' 个 host 包产物与输入摘要一致', rebuild)
}

/** Supported guard modes (see the header's two-mode note). */
export const PACK_INPUT_MODES = Object.freeze(['sidecar', 'electron-pack'])

/**
 * G5 verdicts. Missing artifacts are 'missing' (caller decides whether that is
 * a SKIP or a failure); existing-but-drifted artifacts are 'stale'.
 * @param {{ desktopDir?: string, root?: string, rows?: readonly object[], mode?: 'sidecar' | 'electron-pack' }} [options]
 * @returns {{ id: string, status: 'fresh' | 'missing' | 'stale', detail: string, rebuild: string }[]}
 */
export function inspectPackArtifacts(options = {}) {
  const { mode = 'electron-pack' } = options
  if (!PACK_INPUT_MODES.includes(mode)) throw new Error('pack-input-guards: 未知 mode ' + JSON.stringify(mode))
  const live = [inspectWebDist(options), inspectControlPlane(options)]
  if (mode === 'sidecar') return live
  return [live[0], inspectPreload(options), live[1], inspectHostPackages(options)]
}

/**
 * Pack/build-time assertion: fresh = OK log line; missing = loud SKIP (default)
 * or failure (requirePresence); stale = failure with the rebuild command.
 * @param {{ desktopDir?: string, root?: string, rows?: readonly object[], mode?: 'sidecar' | 'electron-pack', requirePresence?: boolean, log?: (line: string) => void }} [options]
 * @returns {{ verdicts: readonly object[] }}
 * @throws Error aggregating every stale/missing problem and its rebuild command.
 */
export function assertPackArtifactsFresh({ desktopDir = DESKTOP_DIR, root = REPO_ROOT, rows = HOST_PACKAGE_BUILD_ROWS, mode = 'electron-pack', requirePresence = false, log = console.log } = {}) {
  const verdicts = inspectPackArtifacts({ desktopDir, root, rows, mode })
  const failures = []
  for (const item of verdicts) {
    if (item.status === 'fresh') {
      log('[pack-inputs] OK   ' + item.id + ' — ' + item.detail)
    } else if (item.status === 'missing' && !requirePresence) {
      log('[pack-inputs] SKIP ' + item.id + ' — ' + item.detail + '（重建：' + item.rebuild + '）')
    } else {
      failures.push(item)
    }
  }
  if (failures.length > 0) {
    const lines = failures.map((item) => '  ✗ ' + item.id + '：' + item.detail + '（重建：' + item.rebuild + '）')
    throw new Error('打包前输入断言失败（' + failures.length + ' 项）——产物存在但已陈旧（或严格档下缺失），拒绝打包：\n' + lines.join('\n'))
  }
  return { verdicts }
}
