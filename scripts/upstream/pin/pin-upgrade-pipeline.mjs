#!/usr/bin/env node
/**
 * pin-upgrade-pipeline.mjs — 上游 pin 升级的「机械面单批管线」（docs/progress/TODO.md A§16.3）。
 *
 * 由给定 tag 推导**六锚 + 3 个 fork 字面量**的应改值，把 diff 打印出来（只打印、
 * 不写锚），随后自动跑机械面收尾：`registry-views.mjs --write`（registry canonical +
 * §2/§9 生成视图）→ `verify-i18n.mjs --write`（双语记录重录）→
 * `verify-upstream-touchpoints.mjs`（触点门全量收尾）。不自动 commit、不改任何判据。
 *
 * 用法：
 *   node scripts/upstream/pin/pin-upgrade-pipeline.mjs <tag> [--check] [--no-artifact-rebuild] [--strict]
 *
 *   <tag>                形如 dsh-vX.Y.Z-<stage>.N（与 update-vendor.mjs 同一形态）；
 *                        目标版本 = tag 去掉 `dsh-v` 前缀。
 *   --check              只读模式：不写盘；生成视图走 --check 保鲜、i18n 走只读校验、
 *                        触点门强制 --no-artifact-rebuild（C8 退回 advisory）。
 *   --no-artifact-rebuild 触点门传 --no-artifact-rebuild（跳过 C8 产物重建-比对）。
 *   --strict             锚未全部对齐时红（exit 1）；默认把「待人工应用」当正常输出。
 *   --help / -h          打印本用法。
 *
 * 退出码（scripts/README.md §分类规则 3）：0 通过 · 1 红 · 2 用法错误。
 *
 * 覆盖的锚点（单一来源 = verify-upstream-touchpoints.mjs 的 C10；本表由单测与该门
 * 的 REQUIRED / ALLOWED 表双向锁步，两处形态不一致即红）：
 *
 *   运行时线六锚（C10 REQUIRED）：
 *     [1/6] packages/desktop/scripts/bundle-dsh.mjs         bundle 兜底常量（字面量）
 *     [2/6] packages/desktop/vendor/dsh/pnpm-lock.yaml      运行时版本单一来源（派生：bundle:dsh 重生成）
 *     [3/6] .github/workflows/release.yml                   release env
 *     [4/6] scripts/install-gateway.sh                      安装器回退默认值
 *     [5/6] packages/gateway/package.json                   dshAnchorVersion
 *     [6/6] scripts/release/preflight/release-preflight.mjs FORK_VERSION
 *   fork 副本（C5/C10 版本锚）：packages/dsh-client-connection / dsh-client-web /
 *   dsh-api-gateway 的 package.json `version`。
 *
 * 边界：
 *   - **不写锚**：六锚 / 3 fork 字面量只打印 diff，落笔仍由人工按 diff 应用
 *     （本脚本绝不改 pin 值、不写 harness.commit / registry.json 语义 / vendor 树）；
 *   - 派生锚（运行时锁文件）由 `bundle:dsh` 拥有，只报当前/目标与重生成命令；
 *   - 机械面收尾步骤只在 `--check` 下退化为只读，其余情况按 TODO A§16.3 写生成视图；
 *   - 前提：`update-vendor.mjs <tag>` 已把源码线（submodule gitlink + harness.commit +
 *     vendor 链 + 根锁文件）切到该 tag，且 `@deepseek-ai/dsh@<version>` 已发布 npm、
 *     `bundle:dsh` 已刷新运行时锁（双线互斥窗口见 dsh-upgrade-checklist.md §2/§5）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根（本文件位于 scripts/upstream/pin/）。 */
export const ROOT = join(HERE, '../../..')

/** tag 命名：与 scripts/upstream/pin/update-vendor.mjs 的 TAG_RE 同一形态——两处都是
 *  升级入口的独立守卫；单测把两份规则逐样例锁步，改一处必须同批改另一处。 */
export const TAG_RE = /^dsh-v(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)$/u

/** C10 的运行时版本形态（verify-upstream-touchpoints.mjs）。稳定版 tag（无预发布后缀）
 *  不在其中：本管线只点名提醒，不擅自放宽判据（改判据不在本脚本范围内）。 */
export const RUNTIME_VERSION_SHAPE = /^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/u

/** 运行时版本的单一来源（C10 的 current 读自此处；bundle:dsh 生成且已提交）。 */
export const RUNTIME_LOCK = 'packages/desktop/vendor/dsh/pnpm-lock.yaml'

/** 运行时锁里 `@deepseek-ai/dsh` 的 specifier / version 行（与 C10 同一形态）。 */
const RUNTIME_LOCK_ENTRY_RE = /'@deepseek-ai\/dsh':\n\s+specifier: (\S+)\n\s+version: (\S+)/u

/**
 * 六锚 + 3 fork 的落点表。kind：
 *  - literal：人工按 diff 落笔的单行字面量（pattern 整行匹配，捕获组 1 = 当前值）；
 *  - derived：由 bundle:dsh 重生成（本管线只报期望值，不写）。
 * anchor 编号沿用 C10 ALLOWED 表（1/6…6/6）；fork 副本按 1/3…3/3 单列。
 */
export const ANCHOR_SITES = Object.freeze([
  {
    id: 'runtime-1-bundle-fallback',
    anchor: '1/6',
    kind: 'literal',
    file: 'packages/desktop/scripts/bundle-dsh.mjs',
    label: 'bundle 兜底常量（DEFAULT_DSH_VERSION 的锁文件缺位分支）',
    pattern: /^ {2}return '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)';$/mu,
  },
  {
    id: 'runtime-2-lockfile',
    anchor: '2/6',
    kind: 'derived',
    file: RUNTIME_LOCK,
    label: '运行时版本单一来源（bundle:dsh 生成并已提交）',
    regenerate: 'DSH_CHAMBER_DSH_VERSION=<目标版本> pnpm --filter @dsh-chamber/desktop run bundle:dsh -- --force --refresh-lockfile',
  },
  {
    id: 'runtime-3-release-env',
    anchor: '3/6',
    kind: 'literal',
    file: '.github/workflows/release.yml',
    label: 'release workflow env（DSH_CHAMBER_DSH_VERSION）',
    pattern: new RegExp('^ {2}DSH_CHAMBER_DSH_VERSION: (\\S+)$', 'mu'),
  },
  {
    id: 'runtime-4-install-gateway',
    anchor: '4/6',
    kind: 'literal',
    file: 'scripts/install-gateway.sh',
    label: 'gateway 一键安装器回退锚（DSH_CHAMBER_DSH_VERSION 默认值）',
    pattern: /^DSH_CHAMBER_DSH_VERSION="\$\{DSH_CHAMBER_DSH_VERSION:-([^}]+)\}"$/mu,
  },
  {
    id: 'runtime-5-gateway-package',
    anchor: '5/6',
    kind: 'literal',
    file: 'packages/gateway/package.json',
    label: 'gateway 包 dshAnchorVersion',
    pattern: new RegExp('^ {2}"dshAnchorVersion": "([^"]+)",$', 'mu'),
  },
  {
    id: 'runtime-6-release-preflight',
    anchor: '6/6',
    kind: 'literal',
    file: 'scripts/release/preflight/release-preflight.mjs',
    label: '发布预检 FORK_VERSION（fork/源码基线）',
    pattern: /^const FORK_VERSION = flags\.forkVersion \?\? '([^']+)'$/mu,
  },
  {
    id: 'fork-1-dsh-client-connection',
    fork: '1/3',
    kind: 'literal',
    file: 'packages/dsh-client-connection/package.json',
    label: 'fork 副本 dsh-client-connection 版本',
    pattern: FORK_VERSION_PATTERN(),
  },
  {
    id: 'fork-2-dsh-client-web',
    fork: '2/3',
    kind: 'literal',
    file: 'packages/dsh-client-web/package.json',
    label: 'fork 副本 dsh-client-web 版本',
    pattern: FORK_VERSION_PATTERN(),
  },
  {
    id: 'fork-3-dsh-api-gateway',
    fork: '3/3',
    kind: 'literal',
    file: 'packages/dsh-api-gateway/package.json',
    label: 'fork 副本 dsh-api-gateway 版本',
    pattern: FORK_VERSION_PATTERN(),
  },
])

/** fork package.json 的顶层 version 行（`^ {2}"version": "<v>",$`；同一文件里没有第二个同名键）。 */
function FORK_VERSION_PATTERN() {
  return new RegExp('^ {2}"version": "([^"]+)",$', 'mu')
}

/** 由 tag 推导目标版本；不合法返回 null（调用方判用法错误）。 */
export function versionFromTag(tag) {
  if (typeof tag !== 'string') return null
  const match = TAG_RE.exec(tag)
  return match === null ? null : match[1]
}

/** 读运行时锁的 `@deepseek-ai/dsh` 记录；形态不符返回 null（C10 的 loud 失败前提）。 */
export function readRuntimeLock(text) {
  const match = RUNTIME_LOCK_ENTRY_RE.exec(text)
  return match === null ? null : { specifier: match[1], version: match[2] }
}

/** 把非 global 的整行 pattern 变成 global 副本，用于「命中必须唯一」的判定。 */
function globalOf(pattern) {
  const flags = new Set(pattern.flags)
  flags.add('g')
  return new RegExp(pattern.source, [...flags].join(''))
}

/**
 * 定位一个 literal 站点：整行 pattern 必须**恰好命中一行**、且该行里版本串只出现
 * 一次——否则无法安全给出 diff（宁可红也不猜着改）。
 * @returns {{ ok: true, version: string, lineNumber: number, oldLine: string, newLine: string, aligned: boolean } | { ok: false, reason: string }}
 */
export function locateLiteral(text, pattern, targetVersion) {
  const matches = [...text.matchAll(globalOf(pattern))]
  if (matches.length === 0) {
    return { ok: false, reason: '锚点形状未命中（该行形态可能已变，先更新本脚本锚点表并复核 C10）' }
  }
  if (matches.length > 1) {
    return { ok: false, reason: `锚点行不唯一（命中 ${matches.length} 行），无法安全给出 diff` }
  }
  const match = matches[0]
  const version = match[1]
  const line = match[0]
  if (line.split(version).length - 1 !== 1) {
    return { ok: false, reason: `锚行内版本出现多次，无法安全定位：${line.trim()}` }
  }
  const lineNumber = text.slice(0, match.index).split('\n').length
  return {
    ok: true,
    version,
    lineNumber,
    oldLine: line,
    newLine: line.replace(version, () => targetVersion),
    aligned: version === targetVersion,
  }
}

/**
 * 读齐六锚 + 3 fork 的当前值，产出「已对齐 / 待应用」计划。
 * @param {object} input - { targetVersion, readFile?, sites? }
 * @param {(rel: string) => string} [input.readFile] - 仓库根相对路径读取器（测试注入）。
 * @returns {{ targetVersion: string, entries: object[], problems: string[] }}
 */
export function deriveAnchorPlan({ targetVersion, readFile = (rel) => readFileSync(join(ROOT, rel), 'utf8'), sites = ANCHOR_SITES }) {
  const entries = []
  const problems = []
  for (const site of sites) {
    let text
    try {
      text = readFile(site.file)
    } catch (error) {
      problems.push(`${site.file}: 读取失败（${error.message}）`)
      continue
    }
    if (typeof text !== 'string') {
      problems.push(`${site.file}: 读取失败（无内容）`)
      continue
    }
    if (site.kind === 'derived') {
      const lock = readRuntimeLock(text)
      if (lock === null) {
        problems.push(`${site.file}: 读不出 '@deepseek-ai/dsh' 的 specifier/version 行（C10 的单一来源形态已变）`)
        continue
      }
      entries.push({ ...site, current: lock.specifier, rawVersion: lock.version, aligned: lock.specifier === targetVersion })
      continue
    }
    const located = locateLiteral(text, site.pattern, targetVersion)
    if (!located.ok) {
      problems.push(`${site.file}: ${located.reason}`)
      continue
    }
    entries.push({ ...site, ...located })
  }
  return { targetVersion, entries, problems }
}

/** 计划计数（报告与退出判定共用）。 */
export function summarizePlan(plan) {
  const literals = plan.entries.filter((entry) => entry.kind === 'literal')
  const derived = plan.entries.filter((entry) => entry.kind === 'derived')
  return {
    total: plan.entries.length,
    aligned: plan.entries.filter((entry) => entry.aligned).length,
    literal: literals.length,
    derived: derived.length,
    pendingLiteral: literals.filter((entry) => !entry.aligned).length,
    pendingDerived: derived.filter((entry) => !entry.aligned).length,
  }
}

/** 渲染 diff 报告（只有待应用字面量才有 -/+ 两行；派生锚只报期望与重生成命令）。 */
export function renderAnchorPlan(plan, { tag } = {}) {
  const lines = [`锚点推导（tag ${tag ?? '?'} → 目标版本 ${plan.targetVersion}）`]
  for (const entry of plan.entries) {
    const prefix = entry.anchor !== undefined ? `[锚 ${entry.anchor}]` : `[fork ${entry.fork}]`
    if (entry.kind === 'derived') {
      const state = entry.aligned ? '✓ 已对齐' : '✗ 待重生成'
      lines.push('')
      lines.push(`${prefix} ${state} · ${entry.label}`)
      lines.push(`    文件: ${entry.file}（bundle:dsh 拥有；本管线不写）`)
      lines.push(`    当前: ${entry.current}（lock 记录 version ${entry.rawVersion}）  目标: ${plan.targetVersion}`)
      if (!entry.aligned) lines.push(`    重生成: ${entry.regenerate}`)
      continue
    }
    if (entry.aligned) {
      lines.push('')
      lines.push(`${prefix} ✓ 已是 ${plan.targetVersion} · ${entry.label}（${entry.file}:${entry.lineNumber}）`)
      continue
    }
    lines.push('')
    lines.push(`${prefix} ✗ 待人工应用 · ${entry.label}`)
    lines.push(`    --- a/${entry.file}`)
    lines.push(`    +++ b/${entry.file}`)
    lines.push(`    @@ 行 ${entry.lineNumber} @@`)
    lines.push(`    -${entry.oldLine}`)
    lines.push(`    +${entry.newLine}`)
  }
  return lines.join('\n')
}

/** 锚点计划的收尾摘要（与退出码判定同一 count）。 */
export function renderPlanSummary(plan) {
  const summary = summarizePlan(plan)
  const lines = [`锚点汇总：${summary.aligned}/${summary.total} 已是目标版本；待人工应用 ${summary.pendingLiteral} 处字面量 diff；派生锚（运行时锁文件）${summary.pendingDerived > 0 ? '待 bundle:dsh 重生成' : '已对齐'}。`]
  if (summary.pendingLiteral > 0) {
    lines.push('本管线只打印 diff、不写锚（TODO A§16.3）：请人工应用上面的 diff；应用后可用 --strict 把「全部对齐」当硬断言。')
  }
  return lines.join('\n')
}

/** 机械面收尾步骤（顺序固定：生成视图 → 双语记录 → 触点门）。 */
export function pipelineSteps({ check = false, noArtifactRebuild = false } = {}) {
  return [
    {
      id: 'registry-views',
      label: 'registry 生成视图（registry.json canonical + §2/§9 GENERATED 块）',
      script: 'scripts/upstream/registry/registry-views.mjs',
      args: [check ? '--check' : '--write'],
    },
    {
      id: 'verify-i18n',
      label: '双语记录（docs 镜像 / 包 README 对）',
      script: 'scripts/gates/checks/verify-i18n.mjs',
      args: check ? [] : ['--write'],
    },
    {
      id: 'verify-upstream-touchpoints',
      label: '上游触点门（C1/C3–C16 收尾）',
      script: 'scripts/upstream/verify/verify-upstream-touchpoints.mjs',
      args: noArtifactRebuild || check ? ['--no-artifact-rebuild'] : [],
    },
  ]
}

/** 默认命令执行器：`node <repo-relative script> <args...>`，cwd = 仓库根、输出直通。 */
export function defaultRunCommand({ script, args, root = ROOT }) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(`✗ 无法执行 ${script}: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

export const USAGE = [
  '用法: node scripts/upstream/pin/pin-upgrade-pipeline.mjs <tag> [--check] [--no-artifact-rebuild] [--strict]',
  '',
  '<tag>                  形如 dsh-vX.Y.Z-<stage>.N（与 update-vendor.mjs 同一形态）',
  '--check                只读模式：不写盘（生成视图 --check、i18n 只读、触点门 --no-artifact-rebuild）',
  '--no-artifact-rebuild  触点门跳过 C8 产物重建-比对（advisory）',
  '--strict               锚未全部对齐时 exit 1；默认把「待人工应用」当正常输出',
  '--help / -h            打印本用法',
  '',
  '行为：由 tag 推导六锚 + 3 fork 字面量的应改值并打印 diff（不写锚、不提交、不改判据），',
  '随后跑 registry-views --write → verify-i18n --write → verify-upstream-touchpoints。',
].join('\n')

/**
 * 解析 CLI 参数；问题聚合到 problems（调用方统一判 exit 2，不在解析里直接退出）。
 * @param {string[]} argv
 * @returns {{ tag: string | null, version: string | null, check: boolean, noArtifactRebuild: boolean, strict: boolean, help: boolean, problems: string[] }}
 */
export function parseArgs(argv) {
  const flags = { check: false, noArtifactRebuild: false, strict: false, help: false }
  const problems = []
  let tag = null
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') { flags.help = true; continue }
    if (argument === '--check') { flags.check = true; continue }
    if (argument === '--no-artifact-rebuild') { flags.noArtifactRebuild = true; continue }
    if (argument === '--strict') { flags.strict = true; continue }
    if (argument.startsWith('-')) { problems.push(`未知参数 ${argument}`); continue }
    if (tag !== null) { problems.push(`多余的位置参数 ${argument}（只接受一个 <tag>）`); continue }
    tag = argument
  }
  const version = tag === null ? null : versionFromTag(tag)
  if (tag === null && !flags.help) problems.push('缺少 <tag> 参数（形如 dsh-vX.Y.Z-alpha.N）')
  if (tag !== null && version === null) {
    problems.push(`tag 命名不合法: ${tag}（须为 dsh-vX.Y.Z 或 dsh-vX.Y.Z-(alpha|beta|rc).N）`)
  }
  return { tag, version, ...flags, problems }
}

/**
 * 跑完整批处理：锚点推导/打印 → 机械面步骤 → 收尾判定。
 * @param {object} input - { parsed, io?, readFile?, runCommand?, root? }
 * @returns {number} 退出码（0 通过 / 1 红；用法错误由调用方在 main 里判 2）
 */
export function runPipeline({ parsed, io = console, readFile, runCommand = defaultRunCommand, root = ROOT }) {
  const log = (line = '') => io.log(line)
  const error = (line) => io.error(line)
  const { tag, version, check, noArtifactRebuild, strict } = parsed
  log(`[pin-upgrade-pipeline] tag ${tag} → 目标版本 ${version}${check ? '（check 模式：不写盘）' : ''}`)
  log('前提：update-vendor.mjs 已把源码线切到该 tag；本管线不改 pin、不改判据、不自动提交。')
  if (!RUNTIME_VERSION_SHAPE.test(version)) {
    log(`注意：${version} 不在 C10 的运行时版本形态内（需 x.y.z-(alpha|beta|rc).N）；稳定版 tag 须先扩展 C10 正则，否则触点门会红。`)
  }
  log('')

  const plan = deriveAnchorPlan({ targetVersion: version, readFile, sites: ANCHOR_SITES })
  if (plan.problems.length > 0) {
    for (const problem of plan.problems) error(`✗ 锚点推导: ${problem}`)
    error('[pin-upgrade-pipeline] 锚点表与工作树形态不一致——先修本脚本锚点表（C10 同一形态），不猜着改文件。')
    return 1
  }
  log(renderAnchorPlan(plan, { tag }))
  log('')
  log(renderPlanSummary(plan))
  log('')

  let failed = null
  for (const step of pipelineSteps({ check, noArtifactRebuild })) {
    const command = `node ${step.script}${step.args.length > 0 ? ' ' + step.args.join(' ') : ''}`
    log(`[pin-upgrade-pipeline] ▶ ${step.label}: ${command}`)
    if (runCommand({ ...step, root }) !== 0) { failed = { step, command }; break }
  }
  if (failed !== null) {
    error(`✗ [pin-upgrade-pipeline] ${failed.step.label} 失败（${failed.command}）——批处理中止，后续步骤未执行。`)
    return 1
  }

  log('')
  const summary = summarizePlan(plan)
  const pending = summary.pendingLiteral + summary.pendingDerived
  if (summary.pendingLiteral > 0) {
    log(`[pin-upgrade-pipeline] 机械面完成；仍有 ${summary.pendingLiteral} 处锚字面量待人工应用（见上方 diff）` +
      `${summary.pendingDerived > 0 ? '，派生锚（运行时锁文件）待 bundle:dsh 重生成' : ''}。`)
  } else if (summary.pendingDerived > 0) {
    log('[pin-upgrade-pipeline] 机械面完成；六锚/3 fork 字面量已对齐，派生锚（运行时锁文件）待 bundle:dsh 重生成。')
  } else {
    log('[pin-upgrade-pipeline] 机械面完成；六锚 + 3 fork 字面量均已对齐目标版本。')
  }
  if (strict && pending > 0) {
    error('[pin-upgrade-pipeline] --strict: 六锚/3 fork 未全部对齐目标版本 ⇒ 红（应用 diff / bundle:dsh 后重跑）。')
    return 1
  }
  log('[pin-upgrade-pipeline] 未提交：按 dsh-upgrade-checklist.md §2 同批提交六锚/3 fork + 生成视图 + i18n 记录；本管线不自动 commit。')
  return 0
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) { console.log(USAGE); return }
  if (parsed.problems.length > 0) {
    for (const problem of parsed.problems) console.error(`[pin-upgrade-pipeline] ${problem}`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  process.exitCode = runPipeline({ parsed })
}

/** 入口判定：realpath 双侧比较（符号链接绝对路径调用时也不静默 no-op）。 */
const isEntry = (() => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isEntry) main()
