#!/usr/bin/env node
/**
 * 升级前「pin 预检」——在动 pin **之前**给出重放清单（只读、不改任何文件）。
 *
 * 背景：pin 升级里 upstream 可能重构 ui-layout 的三栏模型（`DETAILS_*` 消失、
 * `details` → `rightbar`），chamber 的 layout fork 会因此立刻编译失败——属于
 * 「先动手、后发现问题」。本脚本把这一步提前：对目标 tag 与当前 pin 做只读
 * diff，直接回答四个问题：
 *
 *   1. **三个 fork 副本**里哪些文件变了，且各自的处置类别（pure 面 = 直接照抄；
 *      patched/own 面 = 需要人工重放）；
 *   2. **chamber 深引的 vendor 文件**（`@deepseek-ai/<pkg>/src/...`）是否变化
 *      ——layout fork 直接 import vendor 的
 *      `AppFrame.tsx`/`columns.ts`/`service.ts`，属于 seam 风险类别；
 *   3. **上游包集合变化**（新增/移除）与新增的 **client 行**（带 `dsh.client`
 *      元数据的包 → roster/covered 决策），以及运行时版本是否已发布 npm；
 *   4. **被吞掉的新增面**——chamber 的改写/不镜像会让上游新功能静默缺席，故本
 *      脚本把两类"看不到"提前成清单：① **dropped 面发生变化**：上游在 chamber
 *      有意不镜像的文件里改了东西，**不是"通常无需动作"**，必须拿 registry 里该
 *      文件的 drop 理由重新照面；② **名词差集**：上游在 chamber 已镜像/已改写的
 *      文件里新增了导出 / `@Remote` 方法 / 点号座席键，而本仓副本里没有这些名
 *      字（= 候选漏接入面）。
 *
 * **覆盖面边界**：本表只含三个 shadow fork（registry 的 `type: fork` 且
 * `versionAnchor ≠ chamber`）。chamber-named fork（ui-layout / ui-sidebar /
 * seed-open-in）不在 `FORK_PATHS` 内——但它们深引的 vendor 文件仍由第 2 问的
 * seam 报告覆盖（见 `upstream-touchpoints.md` §2.6/§2.7），其余增量归 C1/C2 与
 * `upstream-touchpoints.md` §7 第 5/6 步。
 *
 * 用法：
 *   node scripts/upstream/preflight-vendor-pin.mjs dsh-v0.1.5-alpha.1 [--offline] [--fail-on-replay]
 *   node scripts/upstream/preflight-vendor-pin.mjs <tag> --json
 *
 * 退出码：默认 0（advisory；第 4 问的②只报不判——改名/搬代码会带来假阳性，
 * 复核清单的价值在"列出来"，不在"判红"）；`--fail-on-replay` 时若存在需人工
 * 重放项（fork 面 / seam / 新增 client 行 / 移除包 / **dropped 面的能力面变化** /
 * 上游删除 / **未登记的缺失文件**）则 1——测试/打包配置/README 这类 dropped 噪声面
 * 只报不计（见 {@link isDroppedNoise}），否则上游每次功能提交都会打红这个 flag。
 * 只依赖内置模块 + git（+ 可选 npm view）；不写工作树、不动 submodule 的 HEAD
 * （`git diff` 只读对象库；若 tag 对象不在本地会提示 fetch 命令而不自动 fetch）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadRegistry } from './registry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SUBMODULE = path.join(ROOT, 'vendor', 'harness-checkout')

/**
 * 三个 shadow fork 副本：fork 目录名 == 上游包名（vendor 路径 → 本仓副本路径）。
 * 单一来源 = scripts/upstream/registry.json；判定 = `type: fork` 且
 * `versionAnchor !== 'chamber'`（api-gateway 的 authority 是 chamber，但仍是
 * 同名 shadow 副本，故在表内）。chamber-named fork（ui-layout / ui-sidebar /
 * seed-open-in，`versionAnchor: chamber`）不在本表：它们的深引 vendor 文件增量由
 * 第 2 问的 seam 报告覆盖，其余增量归 C1/C2 与 `upstream-touchpoints.md` §7 第 5/6 步。
 * `dropped` / `droppedNotes` 一并带上：上游在 dropped 面里改动时，预检必须把
 * 该文件的 drop 理由原样端出来，而不是退回「通常无需动作」的默认。
 * 读失败必须响亮失败：静默降级成空表会让升级预检假绿。
 */
export function forksFromRegistry(registry) {
  const forks = registry.entries
    .filter(entry => entry.type === 'fork' && entry.versionAnchor !== 'chamber')
    .map(entry => ({
      upstream: entry.upstream,
      fork: entry.ours,
      dropped: entry.classify?.dropped ?? [],
      droppedNotes: entry.classify?.droppedNotes ?? {},
    }))
  // 空表 = 覆盖面消失：预检会以"零差异"通过，比读不出 registry 更隐蔽。
  if (forks.length === 0) {
    throw new Error('registry 未给出任何 shadow fork（type=fork 且 versionAnchor≠chamber）——覆盖面消失必须响亮失败')
  }
  return forks
}

function loadForksOrExit() {
  try {
    return forksFromRegistry(loadRegistry())
  } catch (error) {
    console.error('✗ preflight: 无法读取 scripts/upstream/registry.json（fork 面单一来源）: ' + error.message)
    process.exit(1)
  }
}

export const FORK_PATHS = loadForksOrExit()

/** 从 harness.commit 文本解析 pin（跳过注释/空行，取最后一行）。 */
export function parsePin(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  return lines.length === 0 ? null : lines[lines.length - 1]
}

/**
 * 把一个上游变更路径分类：
 * - `fork-pure`         → 本仓副本该文件与旧 pin 字节一致（直接照抄）；
 * - `fork-replay`       → 本仓副本该文件带补丁（人工重放）；
 * - `fork-dropped`      → 本仓副本没有该文件，但 registry 已登记 dropped（**有意
 *                          不镜像**）：上游这次改了它 ⇒ 必须按 drop 理由复核，
 *                          不是"通常无需动作"；
 * - `fork-unregistered` → 本仓副本没有该文件，且未登记 dropped（C3 违规形状，
 *                          必须裁决：镜像 / 登记 dropped / 改正路径）；
 * - `vendor-seam`       → 非 fork 路径，但被 chamber 源码深引（seam 风险）；
 * - `other`             → 其余（一般忽略）。
 * @param relPath - 相对上游仓库根的路径。
 * @param isPure - 判定器：该 fork 文件当前是否与旧 pin 字节一致。
 * @param deepImports - chamber 深引的上游包相对路径集合。
 * @param forks - fork 描述表（默认模块级 FORK_PATHS；测试可注入）。
 */
export function classifyChange(relPath, isPure, deepImports, forks = FORK_PATHS) {
  const fork = forks.find(candidate => relPath === candidate.upstream || relPath.startsWith(candidate.upstream + '/'))
  if (fork !== undefined) {
    const rel = relPath.slice(fork.upstream.length + 1)
    const local = path.join(ROOT, fork.fork, rel)
    if (!existsSync(local)) return isRegisteredDropped(fork, rel) ? 'fork-dropped' : 'fork-unregistered'
    return isPure(local) ? 'fork-pure' : 'fork-replay'
  }
  for (const dir of deepImports) {
    if (relPath === dir || relPath.startsWith(dir + '/')) return 'vendor-seam'
  }
  return 'other'
}

/**
 * 该 fork 相对路径是否登记在 `classify.dropped`（exact 或目录前缀）。
 * @param fork - fork 描述（须带 `dropped`）。
 * @param relPath - 相对该 fork 上游包根的路径。
 */
export function isRegisteredDropped(fork, relPath) {
  return (fork.dropped ?? []).some(entry => entry.endsWith('/') ? relPath.startsWith(entry) : relPath === entry)
}

/** `*` 通配的整串匹配（不跨 `/`，只作用于单个路径段；registry 的 `droppedNotes` 只有这一种 glob 形态）。 */
export function globMatch(pattern, value) {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('[^/]*')
  return new RegExp('^' + escaped + '$').test(value)
}

/**
 * dropped 面的理由：先 exact，再目录前缀，最后按 `droppedNotes` 的 `*` glob。
 * 找不到时返回 null——调用方必须把它显示成"未登记理由"，不得静默当成无需动作。
 * @param fork - fork 描述（须带 `droppedNotes`）。
 * @param relPath - 相对该 fork 上游包根的路径。
 */
export function droppedReasonFor(fork, relPath) {
  const notes = fork.droppedNotes ?? {}
  if (typeof notes[relPath] === 'string') return notes[relPath]
  const byPrefix = Object.keys(notes).find(key => key.endsWith('/') && relPath.startsWith(key))
  if (byPrefix !== undefined) return notes[byPrefix]
  const byGlob = Object.keys(notes).find(key => key.includes('*') && globMatch(key, relPath))
  return byGlob === undefined ? null : notes[byGlob]
}

/**
 * dropped 面里的"噪声面"：chamber 有意不镜像的测试 / 打包配置 / README。它们变了照样
 * 列出来，但默认不算"需人工处理"——上游几乎每次功能提交都动测试，把它们计入硬门会让
 * --fail-on-replay 常年红，最后被当成噪声忽略。
 * @param relPath - 相对该 fork 上游包根的路径。
 */
export function isDroppedNoise(relPath) {
  return relPath.startsWith('tests/') || relPath.includes('/tests/')
    || relPath === 'tsdown.config.ts' || relPath.endsWith('/tsdown.config.ts')
    || /(?:^|\/)README(?:\.[^/]*)?$/.test(relPath)
}

/**
 * 把 --name-status 的行展开成"有效变更"：重命名（R）在上游是"旧路径消失 + 新路径
 * 出现"，而本仓副本还留在旧路径上；把旧路径按删除补一条，删除分支才看得见它。
 * @param changed - {status, path, from} 数组。
 */
export function expandRenames(changed) {
  const effective = []
  for (const change of changed) {
    effective.push({ status: change.status, path: change.path })
    if (change.status.startsWith('R') && change.from !== null && change.from !== undefined && change.from !== change.path) {
      effective.push({ status: 'D', path: change.from })
    }
  }
  return effective
}

/**
 * 去掉 git 对特殊路径的 C 转义引号形（"b/src/na\303\257ve.ts" → 明文路径），并剥掉
 * b/ 前缀。diff 的 +++ 头与 --name-status 的两侧都经它归一，免得同一个文件在两侧
 * 不同形——那会让它既落 other、又永远拿不到名词差集。
 * @param raw - git 输出的原始路径（可能带引号与八进制字节）。
 */
export function unquoteGitPath(raw) {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed.replace(/^b\//, '')
  const body = trimmed.slice(1, -1)
  const bytes = []
  const simpleEscapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
    const next = body[i + 1]
    if (next !== undefined && simpleEscapes[next] !== undefined) { bytes.push(simpleEscapes[next]); i += 1; continue }
    const oct = body.slice(i + 1, i + 4)
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue }
    bytes.push(...Buffer.from(next === undefined ? '' : next, 'utf8'))
    i += 1
  }
  return Buffer.from(bytes).toString('utf8').replace(/^b\//, '')
}

/**
 * 解析 git diff -U0 的输出，按文件收集**新增行**。
 * 状态机：diff --git 重置；+++/--- 头只在 hunk 外被认作头；@@ 进入 hunk；只有 hunk
 * 内的 + 行才是新增内容——否则"内容恰好以 ++ 开头"的源码行会被当成 +++ 文件头，把
 * 该文件后续的名词静默丢到伪路径上。
 * @param diffText - "git diff -U0 <old> <new> -- <paths...>" 的原文。
 * @returns 上游仓库相对路径 → 新增行数组（按出现顺序）。
 */
export function collectAddedLinesByFile(diffText) {
  const byFile = new Map()
  let current = null
  let inHunk = false
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; inHunk = false; continue }
    if (!inHunk && line.startsWith('+++ ')) {
      const raw = line.slice(4)
      current = raw.trim() === '/dev/null' ? null : unquoteGitPath(raw)
      if (current !== null && !byFile.has(current)) byFile.set(current, [])
      continue
    }
    if (!inHunk && line.startsWith('--- ')) continue
    if (line.startsWith('@@')) { inHunk = true; continue }
    if (!inHunk || current === null) continue
    if (line.startsWith('+')) byFile.get(current).push(line.slice(1))
  }
  return byFile
}

/** 点号字面量里明显不是座席键的形状（文件扩展名 / 版本号）。 */
const SLOT_LIKE_DENY = /\.(?:[cm]?[jt]sx?|json|md|css|scss|html?|ya?ml|png|svg|map|txt)$|^v?\d+(?:\.\d+)+$/i

/**
 * 按状态剥离块注释（跨行；inline 块注释保留其后的真代码，块内 // 不提前闭合），并透传
 * 引号字面量与 `//` 行尾注释——副本里注释掉的旧声明不得压掉真漏报。
 * @param lines - 待扫描的文本行。
 */
export function stripBlockComments(lines) {
  const out = []
  let inBlock = false
  for (const line of lines) {
    let code = ''
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', i)
        if (close < 0) { i = line.length; break }
        i = close + 2
        inBlock = false
        continue
      }
      const ch = line[i]
      if (ch === '"' || ch === "'" || ch.charCodeAt(0) === 96) {
        // 引号字面量整体透传：里面的 /* 或 // 不是注释起始。
        const end = stringLiteralEnd(line, i, ch)
        code += line.slice(i, end + 1)
        i = end + 1
        continue
      }
      if (ch === '/' && line[i + 1] === '/') { code += line.slice(i); i = line.length; break }
      if (ch === '/' && line[i + 1] === '*') { inBlock = true; i += 2; continue }
      code += ch
      i += 1
    }
    out.push(code)
  }
  return out
}

/**
 * 单行内字符串字面量的结束下标（含转义跳过）；未闭合时返回行尾，调用方按整行透传。
 * @param line - 当前行。
 * @param start - 起始引号下标。
 * @param quote - 引号字符。
 */
function stringLiteralEnd(line, start, quote) {
  for (let i = start + 1; i < line.length; i += 1) {
    if (line[i] === '\\') { i += 1; continue }
    if (line[i] === quote) return i
  }
  return line.length - 1
}

/**
 * 按顶层逗号切分声明文本：括号/方括号/花括号内与引号内的逗号不切。用于
 * export const a = 1, b = 2 这类多声明——裸 split(',') 会把对象属性、箭头参数、
 * 类型注解、数组元素与字符串内容切成伪标识符，在副本侧压掉真漏报。
 * @param text - 待切分的声明文本。
 */
export function splitTopLevelCommas(text) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      current += ch
      if (ch === '\\') { current += text[i + 1] === undefined ? '' : text[i + 1]; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * 从行里抽出「名词」——上游新增能力的可搜索名。三类（刻意**不做** inject 面与
 * 平台词：它们要语义上下文，且 inject 缺失已由运行期探针
 * required-extra-rows + boot-gap 诊断覆盖）：
 *  - export  导出声明（含 default / declare / abstract / function* / let / var，
 *            命名再导出、export type {}、export const a = 1, b = 2）；
 *  - remote  @Remote('name') 线方法（单/双引号，允许跨行）；
 *  - slot    点号座席键字面量（sidebar.* / shell.* / settings.* …）。
 * 注释处理：块注释按状态跨行剥离（inline 块注释保留其后的真代码），行首 // 行整行
 * 跳过——副本里注释掉的旧声明不得压掉真漏报。已知缺口：反引号模板字符串、
 * @Remote(CONST)、行尾 // 注释不剥、export * as ns、解构导出，以及多声明里第二及以后
 * 紧跟 `;` / `!` 的绑定名（`export let a, b;` 只报 `a`）。报告工具，遇新形态补这里即可。
 * @param lines - 待扫描的文本行。
 * @returns 去重后的 {kind, name} 列表。
 */

export function addedNameTokens(lines) {
  const codeLines = stripBlockComments(lines).filter((line) => !line.trim().startsWith('//'))
  const text = codeLines.join('\n')
  const out = new Map()
  const add = (kind, name) => { if (!out.has(kind + ':' + name)) out.set(kind + ':' + name, { kind, name }) }
  for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) add('export', m[1])
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) add('export', name)
    }
  }
  for (const line of codeLines) {
    const statement = /^\s*export\s+(?:const|let|var)\s+(.+)$/.exec(line)
    if (statement === null) continue
    for (const part of splitTopLevelCommas(statement[1])) {
      // 标识符后必须紧跟 = / : / , 或段尾：`Record<string, total>` 这类泛型与
      // 正则字面量里的逗号会切出 `total>` / `total/`，旧形状会把它们当导出名。
      const name = /^([A-Za-z_$][\w$]*)\s*(?:[=:,]|$)/.exec(part.trim())?.[1]
      if (name !== undefined) add('export', name)
    }
  }
  for (const m of text.matchAll(/@Remote\(\s*['"]([^'"]+)['"]/g)) add('remote', m[1])
  for (const m of text.matchAll(/['"]([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)['"]/g)) {
    const name = m[1]
    if (SLOT_LIKE_DENY.test(name)) continue
    if (out.has('remote:' + name)) continue
    add('slot', name)
  }
  return [...out.values()]
}

/**
 * 名词差集：新增名词里**本仓副本的同类名词集合里没有**的那些。kind 必须同时
 * 相同（slot 键要求副本里也是点号字面量），避免"名字只在注释里出现过"的假阴性。
 * 返回项交给人工复核；本函数不判红（改名/搬代码是合法假阳性）。
 * @param tokens - addedNameTokens(上游新增行)。
 * @param copyTokens - addedNameTokens(本仓副本文本行)。
 */
export function tokensMissingFromCopy(tokens, copyTokens) {
  const present = new Set(copyTokens.map(token => token.kind + ':' + token.name))
  return tokens.filter(token => !present.has(token.kind + ':' + token.name))
}

/**
 * 收集 chamber 源码深引的上游**包名**（`from '@deepseek-ai/<pkg>/src/...'`）。
 * 返回包名集合；调用方再用 {@link resolvePackageDirs} 映射到上游仓库路径。
 * @param root - 仓库根（测试可覆盖）。
 */
export function collectDeepImportedPackages(root = ROOT) {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue
      const text = readFileSync(full, 'utf8')
      for (const match of text.matchAll(/from '(@deepseek-ai\/[a-z0-9-]+)\/src\//g)) {
        found.add(match[1].slice('@deepseek-ai/'.length))
      }
    }
  }
  for (const group of readdirSync(path.join(root, 'packages'))) {
    const groupDir = path.join(root, 'packages', group)
    if (statSync(groupDir).isDirectory()) walk(groupDir)
  }
  return found
}

/** 上游 workspace 成员清单的候选路径（覆盖上游 pnpm-workspace.yaml 的各根）。 */
const MEMBER_MANIFEST_PATTERN = /^(packages\/[^/]+\/[^/]+|native\/[^/]+|native\/[^/]+\/packages\/[^/]+|apps\/[^/]+|benchmarks|website)\/package\.json$/

/** 该 ref 下所有可能的上游成员清单路径。 */
function memberManifestPaths(listAtRef) {
  return listAtRef.split('\n').filter(line => MEMBER_MANIFEST_PATTERN.test(line))
}

/**
 * 包名 → 上游仓库目录（如 `dsh-client-ui-layout` → `packages/client/ui-layout`）。
 * @param io - 只读访问器 `{ list, read }`。
 * @param ref - 解析所用的 ref。
 * @returns name → dir 映射（未命中的包不在映射中）。
 */
export function resolvePackageDirs(io, ref) {
  const map = new Map()
  for (const manifestPath of memberManifestPaths(io.list(ref))) {
    try {
      const manifest = JSON.parse(io.read(ref, manifestPath))
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) {
        map.set(manifest.name.slice('@deepseek-ai/'.length), path.posix.dirname(manifestPath))
      }
    } catch { /* unparsable manifest: skip */ }
  }
  return map
}

/**
 * 上游 workspace 成员集合（覆盖 `packages/<group>/<pkg>`、`native/**`、
 * `apps/*`、`benchmarks`、`website` 各根，按包名）——非 `packages/<group>/<pkg>` 的成员
 * （如 `native/landlock-run/packages/*`）同样被识别。
 * @param io - `{ list(ref): string, read(ref, path): string }` 只读访问器。
 * @param ref - 目标 ref（pin 或 tag）。
 */
export function upstreamPackages(io, ref) {
  const names = new Set()
  for (const manifestPath of memberManifestPaths(io.list(ref))) {
    try {
      const manifest = JSON.parse(io.read(ref, manifestPath))
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) names.add(manifest.name)
    } catch { /* unparsable manifest: skip */ }
  }
  return names
}

function git(args, opts = {}) {
  // core.quotePath=false：非 ASCII 路径不再输出八进制转义引号形，两侧路径同形。
  return execFileSync('git', ['-c', 'core.quotePath=false', '-C', SUBMODULE, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

/**
 * git 只读调用的失败出口：新 clone 缺目标 tag/对象是常见情形，必须给出可执行的
 * fetch 提示而不是抛一栈 trace。
 * @param args - 传给 git 的参数（-C SUBMODULE 由 {@link git} 加）。
 */
function gitOrExit(args) {
  try {
    return git(args)
  } catch (error) {
    const detail = (error.stderr ?? '').toString().trim() || error.message
    console.error('[preflight] git ' + args.join(' ') + ' 失败：' + detail)
    console.error('[preflight] 若缺目标 tag 对象，先执行：git -C vendor/harness-checkout fetch origin tag <tag>')
    process.exit(2)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const tag = argv.find(arg => !arg.startsWith('--'))
  const offline = argv.includes('--offline')
  const asJson = argv.includes('--json')
  const failOnReplay = argv.includes('--fail-on-replay')
  if (tag === undefined) {
    console.error('用法: node scripts/upstream/preflight-vendor-pin.mjs <tag> [--offline] [--fail-on-replay] [--json]')
    process.exit(2)
  }

  const pin = parsePin(readFileSync(path.join(ROOT, 'harness.commit'), 'utf8'))
  if (pin === null) { console.error('[preflight] 无法解析 harness.commit 的 pin'); process.exit(2) }

  let target
  try {
    target = git(['rev-parse', `${tag}^{commit}`]).trim()
  } catch {
    console.error(`[preflight] 本地 submodule 没有 tag ${tag} 的对象；先执行：`)
    console.error(`  git -C vendor/harness-checkout fetch origin tag ${tag}`)
    process.exit(2)
  }
  if (target === pin) { console.log(`[preflight] 当前 pin 已是 ${tag}（${pin.slice(0, 12)}），无需升级。`); process.exit(0) }

  const deepImportNames = collectDeepImportedPackages()
  const changed = gitOrExit(['diff', '--name-status', pin, target]).trim().split('\n').filter(Boolean)
    .map(line => {
      const [status, ...rest] = line.split('\t')
      return { status, path: unquoteGitPath(rest[rest.length - 1]), from: rest.length > 1 ? unquoteGitPath(rest[0]) : null }
    })

  const isPure = (local) => {
    const rel = path.relative(ROOT, local).split(path.sep).join('/')
    const fork = FORK_PATHS.find(candidate => rel.startsWith(`${candidate.fork}/`))
    if (fork === undefined) return false
    const upstreamRel = `${fork.upstream}/${rel.slice(fork.fork.length + 1)}`
    try {
      const old = execFileSync('git', ['-C', SUBMODULE, 'show', `${pin}:${upstreamRel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return old === readFileSync(local, 'utf8')
    } catch { return false }
  }

  const io = {
    list: ref => gitOrExit(['ls-tree', '-r', '--name-only', ref]).trim(),
    read: (ref, file) => git(['show', `${ref}:${file}`]),
  }
  // chamber 深引的包名 → 上游仓库目录（用于把 vendor 变更标为 seam 风险）。
  const dirsByPackage = resolvePackageDirs(io, pin)
  const deepImports = new Set(
    [...deepImportNames].map(name => dirsByPackage.get(name)).filter(dir => dir !== undefined),
  )

  const buckets = { 'fork-pure': [], 'fork-replay': [], 'fork-dropped': [], 'fork-unregistered': [], 'vendor-seam': [], other: [] }
  const deletedFiles = []
  for (const change of expandRenames(changed)) {
    const bucket = classifyChange(change.path, isPure, deepImports)
    // 上游删除/搬走一个本仓仍持有的镜像文件：与旧 pin 字节一致也不构成"照抄"——动 pin 后
    // C1/C3 会以「fork 自有文件未登记 own」硬失败。落 replay 桶（本来就是 replay 则保持），
    // 并一律列进 deletedFiles：操作员要知道是"删副本或登记 own"，而不是"重放"。
    if (change.status.startsWith('D') && (bucket === 'fork-pure' || bucket === 'fork-replay')) {
      buckets['fork-replay'].push(change)
      deletedFiles.push(change.path)
      continue
    }
    buckets[bucket].push(change)
  }

  // 第 4 问①：dropped 面发生变化——上游在 chamber 有意不镜像的文件里改了东西。
  // 必须把 registry 的 drop 理由端出来；「上游有、本仓副本没有」不等于「无需动作」。
  const droppedChanges = buckets['fork-dropped'].map(change => {
    const fork = FORK_PATHS.find(candidate => change.path.startsWith(candidate.upstream + '/'))
    const rel = fork === undefined ? change.path : change.path.slice(fork.upstream.length + 1)
    return { file: change.path, reason: fork === undefined ? null : droppedReasonFor(fork, rel), noise: isDroppedNoise(rel) }
  })
  const droppedActionable = droppedChanges.filter(item => !item.noise).length

  // 第 4 问②：名词差集——上游在已镜像/已改写文件里新增的 导出 / Remote / 座席键，
  // 本仓副本里没有的名字（候选漏接入面）。只报不判：改名/搬代码是合法假阳性。
  const addedLines = FORK_PATHS.length === 0
    ? new Map()
    : collectAddedLinesByFile(gitOrExit(['diff', '-U0', pin, target, '--', ...FORK_PATHS.map(fork => fork.upstream)]))
  const nounCandidates = []
  for (const change of [...buckets['fork-pure'], ...buckets['fork-replay']]) {
    const lines = addedLines.get(change.path)
    if (lines === undefined || lines.length === 0) continue
    const fork = FORK_PATHS.find(candidate => change.path.startsWith(candidate.upstream + '/'))
    if (fork === undefined) continue
    const local = path.join(ROOT, fork.fork, change.path.slice(fork.upstream.length + 1))
    if (!existsSync(local)) continue
    const copyTokens = addedNameTokens(readFileSync(local, 'utf8').split('\n'))
    for (const token of tokensMissingFromCopy(addedNameTokens(lines), copyTokens)) {
      nounCandidates.push({ file: change.path, kind: token.kind, name: token.name })
    }
  }

  const pinPkgs = upstreamPackages(io, pin)
  const tagPkgs = upstreamPackages(io, target)
  const addedPkgs = [...tagPkgs].filter(name => !pinPkgs.has(name))
  const removedPkgs = [...pinPkgs].filter(name => !tagPkgs.has(name))

  // 新增包里的 client 行（带 dsh.client 元数据 → host-graph 会发射为行，
  // 需要 covered/roster 裁决）。目录名与包名可能不同，统一经 dirsAtTarget 解析。
  const dirsAtTarget = resolvePackageDirs(io, target)
  const newRows = []
  for (const name of addedPkgs) {
    const dir = dirsAtTarget.get(name.slice('@deepseek-ai/'.length))
    if (dir === undefined) continue
    try {
      const manifest = JSON.parse(io.read(target, dir + '/package.json'))
      if (manifest.dsh?.client !== undefined) newRows.push({ name, dir })
    } catch { /* unparsable manifest: skip */ }
  }

  const runtimeVersion = tag.replace(/^dsh-v/, '')
  let published = null
  if (!offline) {
    try {
      published = execFileSync('npm', ['view', '@deepseek-ai/dsh@' + runtimeVersion, 'version'], { encoding: 'utf8' }).trim() !== ''
    } catch { published = false }
  }

  const report = {
    tag, pin, target,
    changedFiles: changed.length,
    pure: buckets['fork-pure'].length,
    replay: buckets['fork-replay'].length,
    dropped: buckets['fork-dropped'].length,
    unregistered: buckets['fork-unregistered'].length,
    seam: buckets['vendor-seam'].length,
    addedPackages: addedPkgs,
    removedPackages: removedPkgs,
    newClientRows: newRows.map(row => row.name),
    runtimeVersion,
    runtimePublished: published,
    replayFiles: buckets['fork-replay'].map(change => change.path),
    seamFiles: buckets['vendor-seam'].map(change => change.path),
    unregisteredFiles: buckets['fork-unregistered'].map(change => change.path),
    deletedFiles,
    droppedActionable,
    droppedChanges,
    nounCandidates,
  }

  if (asJson) { console.log(JSON.stringify(report, null, 2)) }
  else {
    console.log('[preflight] ' + pin.slice(0, 12) + ' → ' + tag + '（' + target.slice(0, 12) + '）：上游变更 ' + changed.length + ' 个文件')
    console.log('[preflight] fork 面：pure ' + report.pure + '（照抄）/ 需人工重放 ' + report.replay + ' / dropped 面变化 ' + report.dropped + '（其中需处理 ' + report.droppedActionable + '）')
    if (report.unregistered > 0) {
      console.log('[preflight] ⚠ 上游文件既未镜像、也未登记 dropped ' + report.unregistered + ' 个（C3 违规形状，必须裁决）：')
      for (const file of report.unregisteredFiles.slice(0, 20)) console.log('  · 未裁决 ' + file)
    }
    if (deletedFiles.length > 0) {
      console.log('[preflight] ⚠ 上游删除/搬走了本仓仍持有的镜像文件 ' + deletedFiles.length + ' 个（删除副本或登记 own，否则动 pin 后 C1/C3 硬失败）：')
      for (const file of deletedFiles.slice(0, 20)) console.log('  · 已删除 ' + file)
    }
    if (report.replayFiles.length > 0) for (const file of report.replayFiles.slice(0, 20)) console.log('  · 重放 ' + file)
    if (report.dropped > 0) {
      const droppedActionableItems = droppedChanges.filter(item => !item.noise)
      const droppedNoiseItems = droppedChanges.filter(item => item.noise)
      if (droppedActionableItems.length > 0) {
        console.log('[preflight] ⚠ dropped 面发生变化 ' + droppedActionableItems.length + ' 个（不是「无需动作」：按 drop 理由复核上游是否在有意不镜像的文件里长了功能）：')
        for (const item of droppedActionableItems.slice(0, 20)) {
          console.log('  · ' + item.file + ' —— 理由：' + (item.reason ?? '未登记理由（registry classify.droppedNotes 缺该路径）'))
        }
      }
      if (droppedNoiseItems.length > 0) {
        console.log('[preflight] dropped 噪声面变化 ' + droppedNoiseItems.length + ' 个（测试/打包配置/README，只报不计失败）：' + droppedNoiseItems.slice(0, 8).map(item => item.file).join(', '))
      }
    }
    if (report.nounCandidates.length > 0) {
      console.log('[preflight] ⚠ 上游在已镜像文件里新增名词、本仓副本没有 ' + report.nounCandidates.length + ' 个（候选漏接入面，逐条复核）：')
      for (const item of report.nounCandidates.slice(0, 40)) console.log('  · ' + item.kind + ' ' + item.name + '  ← ' + item.file)
    }
    if (report.seamFiles.length > 0) {
      console.log('[preflight] ⚠ chamber 深引的 vendor 文件变化 ' + report.seamFiles.length + ' 个（seam 风险，必须与 fork 一起评审）：')
      for (const file of report.seamFiles.slice(0, 20)) console.log('  · seam ' + file)
    }
    if (addedPkgs.length > 0) console.log('[preflight] 新增上游包 ' + addedPkgs.length + '：' + addedPkgs.join(', '))
    if (removedPkgs.length > 0) console.log('[preflight] ⚠ 移除上游包 ' + removedPkgs.length + '：' + removedPkgs.join(', ') + '（锁文件/链接集合需同步）')
    if (newRows.length > 0) console.log('[preflight] ⚠ 新增 client 行 ' + newRows.length + '：' + newRows.map(row => row.name + '(' + row.dir + ')').join(', ') + '（roster/covered 需裁决）')
    console.log('[preflight] 运行时 @deepseek-ai/dsh@' + runtimeVersion + ' 已发布 npm：' + (published === null ? '未检查（--offline）' : String(published)))
  }

  if (failOnReplay && (report.replay > 0 || report.seam > 0 || report.newClientRows.length > 0 || report.removedPackages.length > 0 || report.droppedActionable > 0 || report.unregistered > 0)) {
    console.error('[preflight] 存在需人工处理的项（--fail-on-replay）')
    process.exit(1)
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
