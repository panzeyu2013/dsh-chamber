#!/usr/bin/env node
/**
 * verify-mobile-anchors.mjs — 移动插件锚点的**上游保鲜门**（docs/checklists/
 * upstream-touchpoints.md §4 的机器侧；判据纯函数在 `mobile-anchors.mjs`，
 * 参数契约在 `verify-mobile-anchors-args.mjs`（两个都可被测试 import；本文件是
 * 顶层过程式程序，与 verify-upstream-touchpoints.mjs 同一套拆法））。
 *
 * 背景（2026-09-13 STATUS 移动档开放项 ⑤）：`packages/dsh-chamber-client-ui-mobile`
 * 的锚点由 README「Anchor baseline」+ `test/behavior/composer-guard.test.ts` 钉住，但那套是
 * **自证**（只读本包文件），上游把 `data-*`/slot key 改名时不会红——插件样式
 * 静默 no-op，只有真机才看得见。本门把「插件声明的锚点」与「上游真实发射的
 * 锚点」做双向差集（见 mobile-anchors.mjs 文件头）。
 *
 * 与既有门的分工：
 *   - C8 盯**本仓产物陈旧**（mobile dist/lib == src），看不见上游；
 *   - C1/C3/C5 只覆盖 registry 分类条目里的 shadow fork，mobile 不在表内；
 *   - 本门只盯**上游发射点是否还在**，是 C8 的正交补充（§4 登记行写明）。
 *
 * 硬失败 = 锚点没有**写入形**发射点 / 最小断言集缺口；默认模式下根、产物、插件源码
 * 或 pin 身份缺失都是 fail-soft 跳过并在输出里说明（别的机器、CI 上没有上游树是常态）。
 * `--require-anchor-root` 把四条「其实什么都没查」的路径全部改判 exit 1：① 锚点根缺失
 * ② 无 client 产物 ③ 插件源码抽不到 ④ pin 身份不可判定；缺 shell 产物与版本不符同样红。
 * 该开关与 `--simulate-rename` 互斥（后者能在内存里伪造发射证据）。
 *
 * exit-code 语义（与 verify-upstream-touchpoints.mjs 同约定）：
 *   0 全部通过 / fail-soft 跳过 / --help
 *   1 有锚点硬失败（没有写入形发射点，或最小断言集缺口）/ 严格模式下的缺失与不符
 *   2 用法错误（未知参数、--simulate-rename 形态非法等；不会先跑门）
 *
 * 用法：
 *   node scripts/upstream/verify-mobile-anchors.mjs
 *   node scripts/upstream/verify-mobile-anchors.mjs --anchor-root <dir>      # 指定上游锚点根
 *   node scripts/upstream/verify-mobile-anchors.mjs --simulate-rename main=center   # 自测负例（只在内存里改名）
 *   node scripts/upstream/verify-mobile-anchors.mjs --list                   # 打印抽到的锚点表
 *   node scripts/upstream/verify-mobile-anchors.mjs --require-anchor-root    # 严格模式（见 --help）
 *   node scripts/upstream/verify-mobile-anchors.mjs --help
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHAMBER_CROSS_PACKAGE, REQUIRED_ANCHORS, anchorFindings, applySimulatedRename,
  extractDeclaredAnchors,
} from './mobile-anchors.mjs'
import {
  DEFAULT_ANCHOR_ROOTS, USAGE_EXIT_CODE, VERIFY_MOBILE_ANCHORS_USAGE, parseVerifyMobileAnchorsArgs,
} from './verify-mobile-anchors-args.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MOBILE_PACKAGE = join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile')

/** 递归列出目录下（跳过 node_modules/.git 之外无谓目录）匹配的文件。 */
function walkFiles(dir, predicate, out = [], depth = 0) {
  if (depth > 8) return out
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' && dir.endsWith('@deepseek-ai')) continue
      walkFiles(full, predicate, out, depth + 1)
    } else if (predicate(full, entry.name)) out.push(full)
  }
  return out
}

/**
 * 证据路径：仓内文件用 `/`-分隔的仓内相对路径；仓外（上游锚点根在仓库之外，
 * 例如本机 gateway 的 dsh-anchor）用绝对路径——`../../..` 那种相对串没有信息量。
 */
function repoRel(absolute) {
  const rel = relative(ROOT, absolute).split(sep).join('/')
  return rel.startsWith('../') ? absolute : rel
}

/** 读文件为 UTF-8（读不到返回 null，调用方决定 fail-soft 还是红）。 */
function readText(absolute) {
  try { return readFileSync(absolute, 'utf8') } catch { return null }
}

/**
 * 锚点树与仓内 pin 是否同一个上游：读锚点树 `dsh-web-frontend` 的版本，与
 * `packages/desktop/vendor/dsh/pnpm-lock.yaml`（运行时线的单一来源）里解析到的版本比。
 * 拿不到任一侧时返回 null（调用方只打印，不当成不符——CI/裸 clone 上两侧都可能缺）。
 * @returns {{anchor: string, pinned: string, same: boolean} | null}
 */
function compareAnchorPin(anchorRoot) {
  const anchorManifest = readText(join(anchorRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json'))
  const lockfile = readText(join(ROOT, 'packages', 'desktop', 'vendor', 'dsh', 'pnpm-lock.yaml'))
  if (anchorManifest === null || lockfile === null) return null
  let anchorVersion = null
  try { anchorVersion = JSON.parse(anchorManifest).version ?? null } catch { return null }
  // pnpm keys carry a peer suffix on patched/peer-resolved entries
  // (`'@deepseek-ai/dsh-web-frontend@0.1.5-rc.2(react@19.1.0)'`); the version is
  // the part before the parenthesis (250 such keys exist in this lockfile).
  const pinned = lockfile.match(/^\s{2}'@deepseek-ai\/dsh-web-frontend@([^'()]+)(?:\([^']*\))?':/m)?.[1] ?? null
  if (typeof anchorVersion !== 'string' || pinned === null) return null
  return { anchor: anchorVersion, pinned, same: anchorVersion === pinned }
}

/** 本包源码 `src/**` 下的 TS/TSX（注释里的锚点不算声明，抽取时统一去注释）。 */
function readMobileSources() {
  return walkFiles(join(MOBILE_PACKAGE, 'src'), name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map(absolute => ({ path: repoRel(absolute), text: readText(absolute) }))
    .filter(file => file.text !== null)
}

/**
 * 上游 client 产物语料：
 *   - `<root>/node_modules/@deepseek-ai/**\/lib/*.js`（各 client 半，task 指定的主来源）；
 *   - `<root>/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/*.js`（shell 打包产物：
 *     未单独发布的 client 包——如 ui-dockkit——只在这里，缺了它 `data-dockkit-strip`
 *     这类锚点会假红；首版就踩过）。
 * 两部分同属一个 pin，命中任一即视为「上游确实在发射」。
 *
 * @returns {{clientHalves: Array<object>, shellBundles: Array<object>} | null} 目录不存在时 null。
 */
function readUpstreamFiles(anchorRoot) {
  const packagesDir = join(anchorRoot, 'node_modules', '@deepseek-ai')
  if (!existsSync(packagesDir)) return null
  // `.mjs`/`.cjs` 一并读：真实树里已各有若干（第三轮复核），未来某个 client 半只发 ESM
  // 时不能成为盲区；`.js.map` 不在其列（它不能作为发射证据，读了只会引入噪声）。
  const all = walkFiles(packagesDir, name => /\.(?:js|mjs|cjs)$/.test(name), [])
  const read = files => files.map(absolute => ({ path: repoRel(absolute), text: readText(absolute) }))
    .filter(file => file.text !== null)
  return {
    clientHalves: read(all.filter(absolute => absolute.split(sep).includes('lib'))),
    shellBundles: read(all.filter(absolute => /dsh-web-frontend[\\/]dist[\\/]assets[\\/][^\\/]+\.(?:js|mjs|cjs)$/.test(absolute))),
  }
}

/** shell CSS：`dsh-web-frontend/dist/assets/index-*.css`。 */
function readShellCssFiles(anchorRoot) {
  const assets = join(anchorRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  if (!existsSync(assets)) return []
  return walkFiles(assets, (absolute, name) => /^index-.*\.css$/.test(name), [])
    .map(absolute => ({ path: repoRel(absolute), text: readText(absolute) }))
    .filter(file => file.text !== null)
}

/** chamber 跨包发射方（`data-git-action` 这类仓内钩子）。 */
function readChamberEmitterFiles() {
  const roots = Object.values(CHAMBER_CROSS_PACKAGE)
  const files = []
  for (const rel of roots) {
    const dir = join(ROOT, rel, 'src')
    if (!existsSync(dir)) continue
    for (const absolute of walkFiles(dir, name => name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.css'))) {
      const text = readText(absolute)
      if (text !== null) files.push({ path: repoRel(absolute), text })
    }
  }
  return files
}

/** 找一个可用的上游锚点根（含 `node_modules/@deepseek-ai`）。 */
function resolveAnchorRoot(candidate) {
  const tried = []
  const candidates = candidate === null
    ? DEFAULT_ANCHOR_ROOTS.map(root => (root.startsWith('/') ? root : join(ROOT, root)))
    : [resolve(candidate)]
  for (const root of candidates) {
    tried.push(root)
    if (existsSync(join(root, 'node_modules', '@deepseek-ai'))) return { root: resolve(root), tried }
  }
  return { root: null, tried }
}

function main() {
  const parsed = parseVerifyMobileAnchorsArgs(process.argv.slice(2), process.env)
  if (parsed.help) { console.log(VERIFY_MOBILE_ANCHORS_USAGE); process.exit(0) }
  if (parsed.errors.length > 0) {
    console.error(`${VERIFY_MOBILE_ANCHORS_USAGE}\n用法错误：`)
    for (const error of parsed.errors) console.error(`  - ${error}`)
    process.exit(USAGE_EXIT_CODE)
  }

  const sources = readMobileSources()
  if (sources.length === 0) {
    const detail = `[SKIP] 找不到本包源码：${repoRel(MOBILE_PACKAGE)}/src/**/*.ts(x) 为空——无法抽锚点`
    if (parsed.requireAnchorRoot) {
      console.error(detail)
      console.error('\n移动锚点门：--require-anchor-root 下没有可抽的插件源码（exit 1）')
      process.exit(1)
    }
    console.error(`${detail}，跳过（exit 0）`)
    process.exit(0)
  }
  const { anchors, byKey } = extractDeclaredAnchors(sources)
  console.log(`# 插件声明锚点：${anchors.length} 个（去重后，来自 ${sources.length} 个源文件）`)

  const { root, tried } = resolveAnchorRoot(parsed.anchorRoot)
  if (root === null) {
    const detail = [
      '[SKIP] 上游锚点根不存在或不含 node_modules/@deepseek-ai——本机/CI 未物化上游树，fail-soft 跳过',
      ...tried.map(candidate => `        尝试过：${candidate}${existsSync(candidate) ? '（存在，但无 @deepseek-ai）' : '（不存在）'}`),
      '        需要什么：一个含 `node_modules/@deepseek-ai/**/lib/*.js` 与',
      '        `node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.css` 的目录，',
      '        用 --anchor-root <dir> 或 DSH_MOBILE_ANCHOR_ROOT=<dir> 指过来。',
      '        （本门不依赖 vendor/harness-checkout 子模块，未初始化也不影响。）',
      '        升级流程请加 --require-anchor-root：严格模式下这里 exit 1，',
      '        把「本机/CI 正常跳过」和「其实什么都没查」区分开。',
    ]
    // 严格模式：调用者（升级流程）明确要求「必须真的查过」——静默 exit 0 就是漏洞。
    if (parsed.requireAnchorRoot) {
      console.error(detail.join('\n'))
      console.error('\n移动锚点门：--require-anchor-root 下找不到可用锚点根（exit 1）')
      process.exit(1)
    }
    for (const line of detail) console.log(line)
    process.exit(0)
  }

  const rawFiles = readUpstreamFiles(root)
  const rawCss = readShellCssFiles(root)
  if (rawFiles === null || rawFiles.clientHalves.length === 0) {
    const shell = rawFiles === null ? 0 : rawFiles.shellBundles.length
    const detail = `[SKIP] 锚点根 ${root} 下没有 client 产物（node_modules/@deepseek-ai/**/lib/*.js）`
      + `（同一根下的 shell bundle ${shell} 个、shell CSS ${rawCss.length} 个）`
      + '——不完整的树会让 data-* 锚点假红，fail-soft 跳过' 
    if (parsed.requireAnchorRoot) {
      console.error(detail)
      console.error('\n移动锚点门：--require-anchor-root 下锚点树没有 client 产物（exit 1）')
      process.exit(1)
    }
    console.log(`${detail}（exit 0）`)
    process.exit(0)
  }
  if (parsed.requireAnchorRoot && rawFiles.shellBundles.length === 0 && rawCss.length === 0) {
    console.error(`[FAIL] 锚点根 ${root} 只有 client 半、没有 shell 产物（dsh-web-frontend/dist/assets 下的 js 与 index-*.css）——`
      + '语料不完整：ui-dockkit 这类未单独发布的 client 包只在 shell bundle 里，缺了会假红')
    console.error('\n移动锚点门：--require-anchor-root 下语料不完整（exit 1）')
    process.exit(1)
  }
  // pin 身份：锚点树与仓内 pin 不是同一个上游时，这个门证明的是另一个版本。
  // 注意身份是**版本级**的：同版本的本地重打树同样通过；内容级摘要需要仓内快照，
  // 见 docs/progress/STATUS.md 的登记项（2026-12 第三轮复核）。
  const pin = compareAnchorPin(root)
  if (pin === null) {
    const detail = `[note] pin 身份无法判定：读不到 ${join(ROOT, 'packages', 'desktop', 'vendor', 'dsh', 'pnpm-lock.yaml')}`
      + ` 或锚点树里的 @deepseek-ai/dsh-web-frontend/package.json——本次运行没有验证「锚点树就是仓内 pin」`
    if (parsed.requireAnchorRoot) {
      console.error(`[FAIL] ${detail}`)
      console.error('\n移动锚点门：--require-anchor-root 下 pin 身份不可判定（exit 1）')
      process.exit(1)
    }
    console.log(detail)
  }
  if (pin !== null) {
    if (!pin.same && parsed.requireAnchorRoot) {
      console.error(`[FAIL] 锚点树 dsh-web-frontend@${pin.anchor} != 仓内 pin @${pin.pinned}（packages/desktop/vendor/dsh/pnpm-lock.yaml）——查的不是这个 pin，先物化正确的树再跑`)
      console.error('\n移动锚点门：--require-anchor-root 下锚点树版本与 pin 不符（exit 1）')
      process.exit(1)
    }
    console.log(`# pin 身份：锚点树 dsh-web-frontend@${pin.anchor}${pin.same ? ' == ' : ' != '}仓内 pin @${pin.pinned}${pin.same ? '' : '（前移或换树时按 §7 重锚）'}`)
  }
  if (rawCss.length === 0) {
    console.log(`[note] 锚点根 ${root} 下没有 shell CSS（dsh-web-frontend/dist/assets/index-*.css）：哈希 token 只按 JS 产物判定`)
  }
  // 自测开关只在内存里改名：仓库产物与临时副本都不动。
  const renameAll = files => parsed.renames.length === 0
    ? files
    : files.map(file => ({ ...file, text: applySimulatedRename(file.text, parsed.renames) }))
  const clientHalves = renameAll(rawFiles.clientHalves)
  const shellBundles = renameAll(rawFiles.shellBundles)
  const shell = renameAll(rawCss)
  const corpus = [...clientHalves, ...shellBundles, ...shell]
  if (parsed.renames.length > 0) {
    console.log(`# --simulate-rename（仅内存，不写盘）：${parsed.renames.map(r => `${r.from}→${r.to}`).join(', ')}（作用于 ${corpus.length} 个产物文件）`)
  }
  const chamber = readChamberEmitterFiles()

  console.log(`# 上游语料：${clientHalves.length} 个 client 半 + ${shellBundles.length} 个 shell bundle + ${shell.length} 个 shell CSS（根 ${root}）；`
    + `chamber 跨包发射方 ${chamber.length} 个文件`)

  const findings = anchorFindings({ anchors, upstream: corpus, chamber, required: REQUIRED_ANCHORS })

  if (parsed.list) {
    console.log('\n## 抽到的锚点（kind token 分类 判定 证据数 声明处）')
    for (const row of [...findings.rows].sort((a, b) => `${a.kind}:${a.token}`.localeCompare(`${b.kind}:${b.token}`))) {
      console.log(`  ${row.kind.padEnd(9)} ${row.token.padEnd(44)} ${row.category.padEnd(22)} ${row.verdict.padEnd(8)} ${String(row.evidence.length).padStart(4)}  ${row.path}:${row.line}`)
    }
    console.log('\n## 最小断言集')
    for (const item of REQUIRED_ANCHORS) {
      const declared = byKey.has(`${item.kind}:${item.token}`)
      console.log(`  ${item.kind.padEnd(9)} ${item.token.padEnd(44)} 声明侧=${item.declared.padEnd(8)} 源码命中=${declared ? 'yes' : 'no '}  ${item.note}`)
    }
  }

  console.log('')
  for (const note of findings.notes) console.log(`[note] ${note}`)
  for (const advisory of findings.advisories) console.warn(`[WARN] ${advisory}`)

  if (findings.violations.length > 0) {
    console.error('')
    for (const violation of findings.violations) console.error(`[FAIL] ${violation}`)
    console.error(`\n移动锚点门：${findings.violations.length} 项硬失败（data-* / role / slot 零命中或最小断言集缺口）`)
    process.exit(1)
  }
  console.log(`\n移动锚点门：全部通过（上游 ${corpus.length} 个产物文件；advisory ${findings.advisories.length} 项）`)
  process.exit(0)
}

main()
