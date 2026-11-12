#!/usr/bin/env node
/**
 * prepare-office-assets.mjs —— 上游 Office 技能资产的落位 / 校验（只读源 → 构建产物目录）。
 *
 * 上游口径（rc.2）：`@deepseek-ai/dsh-skill-office` 只随包发布 4 个技能资产
 * （`office`/`office-docx`/`office-pptx`/`office-xlsx` 的 SKILL.md）；上游
 * primary-runtime prepare 自 rc.2 起不再产出 `office-skills/` sibling（桌面由
 * web-app bundle 的 skill-office 行读包内 assets）。本仓仍落位这份 sibling：载荷
 * 内的运行时树会被 prune 删掉非 `docs/` 下的 Markdown（包括包内 SKILL.md），
 * 启动行必须用 `assetRoot` 指向未被裁剪的这份拷贝。
 * 本仓没有安装上游包，因此源按以下顺序解析（第一个存在的目录）：
 *   1. vendor/harness-packages/@deepseek-ai/dsh-skill-office/assets
 *      （指向 pin 子模块的只读链接树；有它时与运行时看到的包内容一致）
 *   2. vendor/harness-checkout/packages/skill/skill-office/assets
 *      （worktree/源码布局下的等价路径）
 *
 * 落位纪律（产物是**生成目录**，只提交本目录的 README.md）：
 * - 逐文件「同目录 temp + rename」覆盖：任一步失败都不会让已有产物消失/半写；
 * - 保留仓库提交的 README.md，并清掉非期望顶层残留（旧版本留下的目录/文件）；
 * - 写完立即以源为基准自查（清单文件全部在场 + sha256 逐文件一致），不一致即失败；
 * - 源可用时 `--verify` 逐文件比对 sha256；源不可用（干净 checkout 没初始化 vendor）
 *   时降级为「清单文件在场」并打印提示——发布腿在打包后的路径上复核同一命令。
 *
 * 离线纪律：本脚本不联网，只读 vendor 源 + 写 resources 目录；--dry-run 不写盘。
 * 依赖纪律：只用 node 内置（crypto/fs/path/url）。
 *
 * CLI：
 *   node scripts/prepare-office-assets.mjs [--dry-run] [--source <dir>] [--out <dir>]
 *   node scripts/prepare-office-assets.mjs --verify <dir> [--source <dir>]
 * 退出码：0 成功；1 失败（源缺失/缺件、落位自检失败、verify 缺件或 sha256 不符）。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
/** packages/desktop —— 本脚本与 resources/ 的共同根。 */
export const DESKTOP_DIR = path.resolve(SCRIPT_DIR, '..')
/** 仓库根（vendor 源与 packages/ 的父目录）。 */
export const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')
/** 默认落点：与 primary-runtime 平级的生成产物目录（extraResources / sidecar 搬运）。 */
export const DEFAULT_OUT_DIR = path.join(DESKTOP_DIR, 'resources', 'office-skills')
/** 默认源候选（顺序即优先级；第一个存在的目录胜出）。 */
export const DEFAULT_SOURCE_CANDIDATES = [
  path.join(REPO_ROOT, 'vendor', 'harness-packages', '@deepseek-ai', 'dsh-skill-office', 'assets'),
  path.join(REPO_ROOT, 'vendor', 'harness-checkout', 'packages', 'skill', 'skill-office', 'assets'),
]
/** 仓库提交的目录说明文件名（唯一允许在落点里长期存在的非资产文件）。 */
export const COMMITTED_README = 'README.md'
/**
 * 资产清单（唯一单源）：上游 skill-office 的 assets 树恰好是这 4 个文件
 * （rc.2 删除了 office-render/office-recalculate/office-export-pdf 与共享的
 * office/references/sidecar.md）。上游新增/改名技能时改这一处 + 重新 prepare，
 * 并同批同步 control-plane 启动行的 OFFICE_SKILL_NAMES 门控。
 */
export const OFFICE_SKILL_FILES = Object.freeze([
  'office/SKILL.md',
  'office-docx/SKILL.md',
  'office-pptx/SKILL.md',
  'office-xlsx/SKILL.md',
])
/** 落点顶层允许出现的期望项（4 个技能目录 + committed README）。 */
export const OFFICE_SKILL_TOP_LEVEL = Object.freeze(
  [...new Set(OFFICE_SKILL_FILES.map((relative) => relative.split('/')[0]))],
)

/** 跟随符号链接的常规文件判定（目录/悬空链接都算 false）。 */
export function isRegularFile(target) {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** 跟随符号链接的目录判定（vendor/harness-packages 候选本身是链接）。 */
export function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** 文件 sha256（verify 与落位自检共用）。 */
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 解析资产源目录：显式 --source 必须存在；否则按 DEFAULT_SOURCE_CANDIDATES 取第一个。
 * @returns {{ source: string, explicit: boolean }}
 */
export function resolveOfficeAssetsSource(explicit = null, options = {}) {
  const candidates = options.candidates ?? DEFAULT_SOURCE_CANDIDATES
  if (explicit !== null && explicit !== undefined) {
    const source = path.resolve(explicit)
    if (!isDirectory(source)) throw new Error('--source 指向的 office 资产目录不存在：' + source)
    return { source, explicit: true }
  }
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return { source: candidate, explicit: false }
  }
  throw new Error('找不到 office 技能资产源（依次尝试：' + candidates.join(' / ') + '）'
    + '——vendor 指向 pin 的子模块，请先初始化 vendor/harness-checkout（含 harness-packages 链接树），'
    + '或用 --source <dir> 显式注入')
}

/** 源树里缺失（或不是常规文件）的资产清单（相对路径）。 */
export function missingOfficeAssetFiles(sourceDir) {
  const missing = []
  for (const relative of OFFICE_SKILL_FILES) {
    if (!isRegularFile(path.join(sourceDir, relative))) missing.push(relative)
  }
  return missing
}

/** dry-run 打印与落位共用的事实（源/落点/清单文件映射）。 */
export function officeAssetPlan(source, outDir = DEFAULT_OUT_DIR) {
  const sourceDir = typeof source === 'string' ? path.resolve(source) : source.source
  return {
    source: sourceDir,
    outDir: path.resolve(outDir),
    files: OFFICE_SKILL_FILES.map((relative) => ({
      relative,
      source: path.join(sourceDir, relative),
      destination: path.join(path.resolve(outDir), relative),
    })),
    topLevel: [...OFFICE_SKILL_TOP_LEVEL],
    keep: [COMMITTED_README],
  }
}

/**
 * 落点完整性判定（不出网）：清单文件全部在场；给了 source（源可用）时逐文件比对 sha256。
 * @param outDir - 落点目录。
 * @param options.source - 源目录字符串 / null（无源时只做在场校验；缺省 null）。
 * @returns {{ ok: boolean, problems: string[], checked: number, compared: number, source: string|null, files: Record<string, string> }}
 */
export function verifyOfficeAssets(outDir, options = {}) {
  const destination = path.resolve(outDir)
  const sourceOption = options.source ?? null
  const sourceDir = sourceOption === null ? null
    : (typeof sourceOption === 'string' ? path.resolve(sourceOption) : path.resolve(sourceOption.source))
  const problems = []
  const files = {}
  for (const relative of OFFICE_SKILL_FILES) {
    const file = path.join(destination, relative)
    if (!isRegularFile(file)) {
      problems.push('缺文件：' + relative + '（' + file + '）')
      continue
    }
    files[relative] = sha256File(file)
  }
  const checked = Object.keys(files).length
  let compared = 0
  if (sourceDir !== null) {
    for (const relative of OFFICE_SKILL_FILES) {
      const sourceFile = path.join(sourceDir, relative)
      if (!isRegularFile(sourceFile)) {
        problems.push('源缺文件（无法比对 sha256）：' + relative + '（' + sourceFile + '）')
        continue
      }
      if (files[relative] === undefined) continue // 已作为「缺文件」记过
      const expected = sha256File(sourceFile)
      if (files[relative] !== expected) {
        problems.push('sha256 与源不符：' + relative + '（out=' + files[relative] + '，source=' + expected + '）')
      } else {
        compared += 1
      }
    }
  }
  return { ok: problems.length === 0, problems, checked, compared, source: sourceDir, files }
}

/** 清掉上次中断留下的 temp 文件（本脚本命名：<file>.tmp-<pid>）。 */
function removeStaleTempFiles(rootDir) {
  let removed = 0
  const stack = [rootDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (/\.tmp-\d+$/u.test(entry.name)) {
        rmSync(entryPath, { force: true })
        removed += 1
      }
    }
  }
  return removed
}

/**
 * 真实落位（唯一会写盘的入口）：逐文件 temp+rename，保留 README，清非期望顶层残留，
 * 最后以源为基准自检（源缺件在动盘之前就拒绝，避免写一半）。
 * @returns {{ written: number, removed: string[], temps: number, verify: object }}
 */
export function materializeOfficeAssets(options = {}) {
  const log = options.log ?? (() => {})
  const source = resolveOfficeAssetsSource(options.source ?? null, options)
  const outDir = path.resolve(options.outDir ?? DEFAULT_OUT_DIR)
  const missing = missingOfficeAssetFiles(source.source)
  if (missing.length > 0) {
    throw new Error('office 资产源缺件（' + missing.length + '/' + OFFICE_SKILL_FILES.length + '）：'
      + missing.join(' / ') + '（源：' + source.source + '）——升级 pin 后先核对清单与上游 assets 树')
  }
  mkdirSync(outDir, { recursive: true })
  const tempSuffix = '.tmp-' + String(process.pid)
  let written = 0
  for (const relative of OFFICE_SKILL_FILES) {
    const from = path.join(source.source, relative)
    const to = path.join(outDir, relative)
    mkdirSync(path.dirname(to), { recursive: true })
    const temp = to + tempSuffix
    rmSync(temp, { force: true })
    copyFileSync(from, temp)
    renameSync(temp, to)
    written += 1
  }
  // 清非期望顶层残留（旧技能目录/临时文件），README 与 4 个期望目录保留。
  const removed = []
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (entry.name === COMMITTED_README || OFFICE_SKILL_TOP_LEVEL.includes(entry.name)) continue
    rmSync(path.join(outDir, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  const temps = removeStaleTempFiles(outDir)
  // 写完自检：源可用，清单文件必须全部在场且 sha256 全对（fail-closed）。
  const verify = verifyOfficeAssets(outDir, { source: source.source })
  if (!verify.ok) {
    throw new Error('office 资产落位自检失败（' + verify.problems.join('；') + '）——落点未达契约，请重跑 prepare')
  }
  log('[office-assets] 落位完成：' + outDir + '（files=' + String(written) + '，sha256 核对 '
    + String(verify.compared) + '/' + String(OFFICE_SKILL_FILES.length)
    + (removed.length === 0 ? '' : '，清理残留：' + removed.join(',')) + '）')
  return { written, removed, temps, verify }
}

const USAGE = [
  '用法：',
  '  node scripts/prepare-office-assets.mjs [--dry-run] [--source <dir>] [--out <dir>]',
  '  node scripts/prepare-office-assets.mjs --verify <dir> [--source <dir>]',
].join('\n')

/** 解析 CLI 参数（未知参数 = 失败；--dry-run 与 --verify 互斥）。 */
export function parseArgs(argv) {
  const options = { dryRun: false, verifyDir: null, source: null, outDir: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(arg + ' 缺少取值')
      return argv[index]
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--verify') options.verifyDir = path.resolve(next())
    else if (arg === '--source') options.source = path.resolve(next())
    else if (arg === '--out') options.outDir = path.resolve(next())
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error('未知参数：' + arg)
  }
  if (options.dryRun && options.verifyDir !== null) {
    throw new Error('--dry-run 与 --verify 互斥（一个演练落位，一个只校验既有落点）')
  }
  return options
}

/** dry-run 的计划打印（发布腿日志的证据面）。 */
export function formatPlan(plan) {
  const lines = [
    '[office-assets] source: ' + plan.source,
    '[office-assets] out: ' + plan.outDir,
    '[office-assets] files: ' + String(plan.files.length) + '（' + String(plan.topLevel.length) + 'x SKILL.md）',
  ]
  for (const entry of plan.files) lines.push('[office-assets]   ' + entry.relative + ' ← ' + entry.source)
  lines.push('[office-assets] 保留顶层：' + [...plan.keep, ...plan.topLevel].join(' / '))
  return lines
}

/** --verify 的源解析：显式 source 缺即失败；默认候选全缺时降级为「只做在场校验」。 */
function resolveVerifySource(explicit) {
  if (explicit !== null) return resolveOfficeAssetsSource(explicit).source
  try {
    return resolveOfficeAssetsSource(null).source
  } catch {
    return null
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.verifyDir !== null) {
    const source = resolveVerifySource(options.source)
    if (source === null) {
      console.log('[office-assets] 源不可用（vendor 未初始化）：本次只做清单文件在场校验，不比对 sha256')
    }
    const result = verifyOfficeAssets(options.verifyDir, { source })
    if (result.ok) {
      console.log('[office-assets] 资产完整：' + options.verifyDir + '（files=' + String(result.checked)
        + '，sha256 核对 ' + String(result.compared) + '/' + String(OFFICE_SKILL_FILES.length) + '）')
      return 0
    }
    console.error('[office-assets] 资产不完整（' + options.verifyDir + '）：\n  - ' + result.problems.join('\n  - '))
    return 1
  }
  const source = resolveOfficeAssetsSource(options.source)
  const outDir = options.outDir ?? DEFAULT_OUT_DIR
  const plan = officeAssetPlan(source.source, outDir)
  const missing = missingOfficeAssetFiles(source.source)
  if (missing.length > 0) {
    throw new Error('office 资产源缺件（' + missing.length + '/' + OFFICE_SKILL_FILES.length + '）：'
      + missing.join(' / ') + '（源：' + source.source + '）')
  }
  for (const line of formatPlan(plan)) console.log(line)
  if (options.dryRun) {
    console.log('[office-assets] dry-run：源/清单校验通过；未写盘')
    return 0
  }
  materializeOfficeAssets({ source: source.source, outDir, log: (line) => { console.log(line) } })
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error('[office-assets] 失败：' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
