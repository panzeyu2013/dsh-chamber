#!/usr/bin/env node
/**
 * Restore the pnpm 11 lockfile pruning side-effect for the vendor workspace.
 *
 * 背景：vendor/harness-packages/@deepseek-ai/* 是 symlink 指向固定 commit 的
 * git submodule（vendor/harness-checkout，见 AGENTS.md「Hard Facts」
 * 与 pnpm-workspace.yaml 注释）。
 * pnpm 11 在 lockfile 需要结构性重解时（增删依赖、升降版本、pnpm add/remove/
 * update）会把这一整段 `importers:` 记录裁剪掉——即使 vendor 树在场也一样
 * （实测 pnpm 11.x）。裁剪后 `pnpm install --frozen-lockfile` 会立即失败
 * （"specifiers in the lockfile don't match specifiers in package.json"），CI
 * 每个 job 第一步就红。
 *
 * 提交版 lockfile（git HEAD:pnpm-lock.yaml）保留着完整的 vendor importer
 * 记录，是这些记录的唯一权威来源。本脚本在任意 lockfile 重生成之后执行：
 *   - 把 HEAD 里缺失的 vendor importer 记录补回当前 lockfile（只增不减）；
 *   - **但跳过当前链接树中已不存在的成员**：上游可以把一个
 *     workspace 成员整个移除（如 `native/landlock-run` 的 4 个包），
 *     此时 HEAD 仍带着它的 importer 记录，无条件补回会让 `pnpm install
 *     --frozen-lockfile` 的 preinstall 断言报「锁文件有、链接缺」。判定依据 =
 *     当前 `vendor/harness-packages/@deepseek-ai/<name>` 链接是否存在（断链视为
 *     不存在）；跳过项会 loud 打印，便于升级时确认是预期移除；
 *   - 对 packages:/snapshots: 做并集恢复——真实裁剪会连同 vendor 图的全部
 *     传递依赖条目一起清掉（实测 347+ 条），HEAD 中缺失的条目全部补回；
 *   - 每个 vendor importer 再与**当前成员 package.json** 的声明边做并集：
 *     恢复的记录来自 HEAD，升级新增的 specifier 边它没有；workspace 边写
 *     `link:../<member>`，registry 范围原样落 version，交给 frozen 响亮拒绝
 *     （不猜解析版本，fail-closed）；
 *     同一个包名同时出现在 dependencies / devDependencies / optionalDependencies
 *     时按该顺序**只取一条**（pnpm canonical 对每个 name 只记一条，且 dependencies
 *     优先；rc.2 升级实测有 5 个 vendor 成员撞到该形态：dsh-agent-preset/
 *     schemastery、dsh-experimental-tool-worktree/dsh-experimental-worktree、
 *     dsh-plugin-market/dsh-app-boot、dsh-settings/yaml、
 *     dsh-ssh-helper-runtime/cordis——按组各补一条会写出同一 name 的重复声明，
 *     使 `pnpm install --frozen-lockfile` 在 update-vendor 第 6 步必然失败）；
 *     若该 name 已被记录在 importer 的任一依赖组里，union 不再补第二条（分组
 *     迁移等不解析的差异留给 frozen 响亮拒绝）；
 *   - 新增块按 pnpm 的归一化键排序落位，diff 最小。
 * 然后照常以 `pnpm install --frozen-lockfile` 收尾验证。
 *
 * 用法：
 *   node scripts/upstream/pin/restore-lockfile-vendor-records.mjs            # 就地修复
 *   node scripts/upstream/pin/restore-lockfile-vendor-records.mjs --check    # 只检测，缺失即退出码 1
 * 测试可用环境变量覆盖路径（默认走 git HEAD）：
 *   RESTORE_LOCKFILE_PATH=<工作 lockfile>  RESTORE_LOCKFILE_HEAD=<HEAD 版本>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const lockfilePath = process.env.RESTORE_LOCKFILE_PATH ?? path.join(root, 'pnpm-lock.yaml')
const headLockfilePath = process.env.RESTORE_LOCKFILE_HEAD

const VENDOR_IMPORTER_PREFIX = 'vendor/harness-packages/@deepseek-ai/'
const checkOnly = process.argv.includes('--check')

/** 读取 HEAD 版 lockfile：优先测试覆盖路径，默认 `git show HEAD:pnpm-lock.yaml`。 */
function readHeadLockfile() {
  if (headLockfilePath) {
    if (!existsSync(headLockfilePath)) throw new Error(`RESTORE_LOCKFILE_HEAD 指向的文件不存在：${headLockfilePath}`)
    return readFileSync(headLockfilePath, 'utf8')
  }
  try {
    return execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(`无法读取 git HEAD 的 pnpm-lock.yaml（${err.message}）。本脚本依赖提交版 lockfile 作为 vendor importer 记录的唯一权威来源。`)
  }
}

/** 行首键归一化：先剥行内值（`:` 及之后，含 `: {}` 单行块）再剥首尾单引号（仅用于键比较，不用于序列化）。 */
function normalizeKey(keyLine) {
  return keyLine.trim().replace(/:.*$/, '').replace(/^'|'$/g, '')
}

const VENDOR_LINK_DIR = path.join(root, 'vendor', 'harness-packages', '@deepseek-ai')

/**
 * 该 vendor 成员在当前工作区链接树中是否存在（跟随符号链接：断链 → false）。
 * 用于区分「pnpm 裁剪了记录」（要补回）与「上游移除了成员」（不能补回）。
 * 测试可用 RESTORE_VENDOR_LINK_DIR 覆盖链接树位置。
 */
function vendorMemberExists(name) {
  if (!isSafeMemberName(name)) return false
  const dir = process.env.RESTORE_VENDOR_LINK_DIR ?? VENDOR_LINK_DIR
  try {
    return existsSync(path.join(dir, name))
  } catch {
    return false
  }
}

/** Canonical dependency-group order pnpm emits inside an IMPORTER record (alphabetical).
 *  Also the dedupe precedence for one manifest name declared in several groups: pnpm's
 *  lockfile carries ONE entry per name and the installed/canonical group is the regular
 *  `dependencies` one (measured on the rc.2 vendor upgrade: 5 members declare the same name
 *  in dependencies+devDependencies, while the pnpm-generated lockfile only keeps the
 *  dependencies entry). peerDependencies is deliberately absent: measured on the committed
 *  lockfile, importers carry only these three groups (peers live in the packages section) —
 *  unioning a peer into an importer would write a key pnpm never emits there. */
const DEP_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies']

/** One workspace member's manifest through the link tree; null when absent/unreadable. */
/** Lockfile TEXT is not trusted path input: only a flat member name may address the link tree. */
function isSafeMemberName(name) {
  return name !== '' && name !== '.' && !name.includes('/') && !name.includes('\\') && !name.split(path.sep).includes('..')
}
function readMemberManifest(member) {
  // Treat a path-escaping key as "no manifest" (byte-identical block, never an invented edge)
  // instead of reading outside the link tree.
  if (!isSafeMemberName(member)) return null
  const dir = process.env.RESTORE_VENDOR_LINK_DIR ?? VENDOR_LINK_DIR
  const manifestPath = path.join(dir, member, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** Declared edges of one manifest: [{ group, name, specifier }] (workspace and registry alike).
 *  A name declared in several dependency groups collapses to ONE edge in the first group of
 *  DEP_GROUPS (dependencies wins): pnpm records a single importer entry, so unioning the
 *  duplicate copy would grow a second declaration frozen rejects. */
function manifestEdges(manifest) {
  const edges = []
  const declared = new Set()
  for (const group of DEP_GROUPS) {
    const deps = manifest[group]
    if (typeof deps !== 'object' || deps === null) continue
    for (const [name, specifier] of Object.entries(deps)) {
      if (declared.has(name)) continue
      if (typeof specifier === 'string' && specifier !== '') {
        edges.push({ group, name, specifier })
        declared.add(name)
      }
    }
  }
  return edges
}

/** Name of one importer entry header line ("      'name':" or "      name:"), else null. */
function importerEntryName(line) {
  const match = /^      (?:'([^']+)'|([^:]+)):$/.exec(line)
  return match === null ? null : (match[1] ?? match[2])
}

/** Quote a dependency name the way pnpm does (scope/slash names quoted, plain names bare). */
function quoteImporterName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : "'" + name + "'"
}

/**
 * The version pnpm records for one declared edge. Workspace ranges are local links;
 * a link:/file: specifier is its own version; a REGISTRY range cannot be resolved
 * here, so it is written as the specifier and left for `pnpm install --frozen-lockfile`
 * to reject loudly (fail-closed) rather than guessing a version.
 */
function importerVersionFor(name, specifier) {
  if (specifier.startsWith('workspace:')) {
    const scope = '@deepseek-ai/'
    const short = name.startsWith(scope) ? name.slice(scope.length) : name.split('/').pop()
    return 'link:../' + short
  }
  return specifier
}

/** 3 lines: entry header + specifier + version. */
function buildEdgeLines(edge) {
  return [
    '      ' + quoteImporterName(edge.name) + ':',
    '        specifier: ' + edge.specifier,
    '        version: ' + importerVersionFor(edge.name, edge.specifier),
  ]
}

/**
 * Union one importer block with the member's CURRENT package.json edges (TODO A§16.4).
 * pnpm prunes the whole record on a structural re-resolve, so the restored HEAD record
 * predates edges the upgrade just added; restoring it alone leaves frozen with no repair
 * path. Existing lines are never reordered or rewritten: additions are spliced into the
 * pnpm-sorted positions (groups alphabetical, entries by name). A name the record already
 * carries in ANY group is never duplicated (pnpm keeps one entry per name; manifestEdges
 * already collapses a name declared in several groups to the dependencies-first edge).
 * A registry range is written verbatim as the version so frozen rejects it loudly — never
 * a guessed version. Returns the number of edges added (0 = block untouched).
 */
function unionImporterEdges(lines, manifest) {
  const edges = manifestEdges(manifest)
  if (edges.length === 0) return 0
  const groups = new Map()
  for (let index = 1; index < lines.length; index += 1) {
    const header = /^    ([A-Za-z]+):( \{\})?$/.exec(lines[index])
    if (header === null) continue
    let end = lines.length
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^    [A-Za-z]+:( \{\})?$/.test(lines[next])) { end = next; break }
    }
    const names = []
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const name = importerEntryName(lines[cursor])
      if (name !== null) names.push({ name, start: cursor })
    }
    groups.set(header[1], { name: header[1], headerIndex: index, end, names, inlineEmpty: header[2] !== undefined })
  }
  // pnpm records ONE importer entry per name. A name already restored from HEAD in ANY
  // group must not be duplicated when the CURRENT manifest names another group as winner
  // (the 5 rc.2 cross-group cases: the HEAD record keeps `dependencies`, the manifest also
  // declares `devDependencies`). A genuine group migration is left for frozen to reject.
  const recordedNames = new Set()
  for (const group of groups.values()) for (const entry of group.names) recordedNames.add(entry.name)
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const buckets = new Map()
  const bucketFor = (at) => {
    if (!buckets.has(at)) buckets.set(at, { entries: [], groups: [] })
    return buckets.get(at)
  }
  const inlinePending = new Map()
  const pendingByPosition = new Map()
  const missingGroups = new Map()
  let added = 0
  for (const edge of edges) {
    if (recordedNames.has(edge.name)) continue
    const group = groups.get(edge.group)
    if (group === undefined) {
      if (!missingGroups.has(edge.group)) missingGroups.set(edge.group, [])
      missingGroups.get(edge.group).push(edge)
      continue
    }
    if (group.names.some(entry => entry.name === edge.name)) continue
    if (group.inlineEmpty) {
      if (!inlinePending.has(group.name)) inlinePending.set(group.name, [])
      inlinePending.get(group.name).push(edge)
      continue
    }
    const target = group.names.find(entry => entry.name > edge.name)
    const at = target === undefined ? group.end : target.start
    if (!pendingByPosition.has(at)) pendingByPosition.set(at, [])
    pendingByPosition.get(at).push(edge)
    added += 1
  }
  for (const [groupName, edgesToAdd] of inlinePending) {
    const group = groups.get(groupName)
    bucketFor(group.headerIndex + 1).entries.push(...edgesToAdd.map(buildEdgeLines))
    added += edgesToAdd.length
  }
  for (const [at, edgesToAdd] of pendingByPosition) {
    bucketFor(at).entries.push(...[...edgesToAdd].sort(byName).map(buildEdgeLines))
  }
  for (const [groupName, edgesToAdd] of missingGroups) {
    let at = lines.length
    for (const [name, group] of groups) {
      if (name > groupName) { at = group.headerIndex; break }
    }
    const block = ['    ' + groupName + ':']
    for (const edge of [...edgesToAdd].sort(byName)) block.push(...buildEdgeLines(edge))
    bucketFor(at).groups.push({ name: groupName, lines: block })
    added += edgesToAdd.length
  }
  if (buckets.size === 0) return 0
  // Inline-empty groups become expanded groups before any splice (assignment keeps indices).
  for (const groupName of inlinePending.keys()) {
    const group = groups.get(groupName)
    lines[group.headerIndex] = '    ' + group.name + ':'
  }
  // Bottom-up splices. At one anchor the added ENTRY segments extend the preceding group's
  // body; a new-group block goes before the following group header (or at block end), so
  // entries emit first, then the new groups sorted by name.
  const splices = [...buckets.entries()].sort((a, b) => b[0] - a[0])
  for (const [at, bucket] of splices) {
    const entryLines = [...bucket.entries]
      .map(block => ({ name: importerEntryName(block[0]) ?? '', lines: block }))
      .sort(byName)
      .flatMap(entry => entry.lines)
    const groupLines = [...bucket.groups].sort(byName).flatMap(group => group.lines)
    lines.splice(at, 0, ...entryLines, ...groupLines)
  }
  return added
}

/**
 * 解析 lockfile：header（首个节之前的非空行）+ 有序节列表，每节含有序块
 * （块 = 2 空格缩进的行首键 + 其后到下一个块/节头之间的所有行）。settings/
 * overrides 的 2 空格键值行相邻出现且无嵌套体，归入同一逻辑块（避免序列化
 * 时插入空行）；importers/packages/snapshots 的块之间必有空行，不受影响。
 * 逐节记录节头后是否有空行（settings/overrides 无，importers/packages/
 * snapshots 有）。
 */
function parse(text) {
  const lines = text.split('\n')
  const header = []
  const sections = []
  let current = null
  let currentBlock = null
  let pendingBlankAfterHeader = false
  let prevWasBlockKey = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^[A-Za-z][A-Za-z0-9_-]*:$/.test(line)) {
      current = { name: line.slice(0, -1), blocks: [], blankAfterHeader: false }
      sections.push(current)
      currentBlock = null
      pendingBlankAfterHeader = true
      prevWasBlockKey = false
      continue
    }
    if (current === null) {
      if (line !== '') header.push(line)
      continue
    }
    if (/^  \S/.test(line)) {
      if (prevWasBlockKey && currentBlock !== null) {
        currentBlock.lines.push(line)
      } else {
        currentBlock = { key: line, lines: [line] }
        current.blocks.push(currentBlock)
      }
      prevWasBlockKey = true
      pendingBlankAfterHeader = false
      continue
    }
    if (line === '') {
      if (pendingBlankAfterHeader) current.blankAfterHeader = true
      pendingBlankAfterHeader = false
      prevWasBlockKey = false
      continue
    }
    if (currentBlock !== null) {
      currentBlock.lines.push(line)
      pendingBlankAfterHeader = false
      prevWasBlockKey = false
    }
  }
  return { header, sections }
}

/** 序列化：lockfileVersion 头 + 每节（节头、节后空行按原样、块间空行），文件尾单个换行。 */
function serialize(parsed) {
  const out = [...parsed.header]
  for (const section of parsed.sections) {
    out.push('')
    out.push(`${section.name}:`)
    if (section.blankAfterHeader) out.push('')
    for (let i = 0; i < section.blocks.length; i++) {
      if (i > 0) out.push('')
      out.push(...section.blocks[i].lines)
    }
  }
  return `${out.join('\n')}\n`
}

/**
 * 合并：把 HEAD 中缺失的 vendor importer 记录（及其传递依赖的 packages/
 * snapshots 条目）补进当前文件。只增不减；现有块与顺序原样保留，新增块按
 * pnpm 的归一化键排序落位（importers/packages/snapshots 三节排序后与 pnpm
 * 自身输出一致，diff 最小）。
 */
function merge(currentText, headText) {
  const cur = parse(currentText)
  const head = parse(headText)
  const curSections = new Map(cur.sections.map((s) => [s.name, s]))
  const headSections = new Map(head.sections.map((s) => [s.name, s]))

  let addedImporters = 0
  const skippedRemovedMembers = []
  const curImporters = curSections.get('importers')
  const headImporters = headSections.get('importers')
  if (curImporters && headImporters) {
    const keys = new Set(curImporters.blocks.map((b) => normalizeKey(b.key)))
    for (const block of headImporters.blocks) {
      const key = normalizeKey(block.key)
      if (!key.startsWith(VENDOR_IMPORTER_PREFIX) || keys.has(key)) continue
      const member = key.slice(VENDOR_IMPORTER_PREFIX.length)
      if (!vendorMemberExists(member)) {
        // 上游已把该 workspace 成员整个移除：HEAD 的记录不再有对应链接，补回会让
        // frozen 验证的链接/记录一致性断言失败。
        skippedRemovedMembers.push(member)
        keys.add(key)
        continue
      }
      curImporters.blocks.push({ key: block.key, lines: [...block.lines] })
      keys.add(key)
      addedImporters++
    }
  }

  // TODO A§16.4: restoring the HEAD record is not enough when the CURRENT member
  // package.json declares edges that record predates (a structural re-resolve prunes
  // the whole record, so those edges have no other repair path). Union them in:
  // workspace edges become local links, registry ranges stay fail-closed at frozen.
  let unionedEdges = 0
  if (curImporters) {
    for (const block of curImporters.blocks) {
      const key = normalizeKey(block.key)
      if (!key.startsWith(VENDOR_IMPORTER_PREFIX)) continue
      const manifest = readMemberManifest(key.slice(VENDOR_IMPORTER_PREFIX.length))
      if (manifest === null) continue
      unionedEdges += unionImporterEdges(block.lines, manifest)
    }
  }

  const added = { packages: 0, snapshots: 0 }
  // 真实裁剪（pnpm 11.21 实测）不只是删 importer 记录：vendor 图的全部
  // 传递依赖条目（packages:/snapshots:）也随重解一起被清掉。直接对这两个
  // 节做并集恢复——HEAD 中有而当前缺失的条目全部补回（它们本就在提交版
  // lockfile 中，补回后仍为合法条目；若某依赖是被有意移除的，其条目恢复为
  // 未被引用的惰性数据，不影响 frozen 检查）。
  for (const sectionName of ['packages', 'snapshots']) {
    const curSection = curSections.get(sectionName)
    const headSection = headSections.get(sectionName)
    if (!curSection || !headSection) continue
    const keys = new Set(curSection.blocks.map((b) => normalizeKey(b.key)))
    for (const block of headSection.blocks) {
      const key = normalizeKey(block.key)
      if (!keys.has(key)) {
        curSection.blocks.push({ key: block.key, lines: [...block.lines] })
        keys.add(key)
        added[sectionName]++
      }
    }
  }

  // pnpm 按归一化键排序这三个节（提交版实测 SORTED）；新增块按同样排序落位，
  // 既有块位置不动，diff 最小且接近 pnpm 自身输出。
  if (addedImporters > 0 || added.packages > 0 || added.snapshots > 0) {
    for (const sectionName of ['importers', 'packages', 'snapshots']) {
      const section = curSections.get(sectionName)
      if (section) section.blocks.sort((a, b) => (normalizeKey(a.key) < normalizeKey(b.key) ? -1 : 1))
    }
  }

  return {
    parsed: cur,
    addedImporters,
    unionedEdges,
    addedPackages: added.packages,
    addedSnapshots: added.snapshots,
    skippedRemovedMembers,
  }
}

if (!existsSync(lockfilePath)) {
  console.error(`[restore-lockfile] 未找到 lockfile：${lockfilePath}`)
  process.exit(1)
}
const currentText = readFileSync(lockfilePath, 'utf8')
const headText = readHeadLockfile()

const { parsed, addedImporters, unionedEdges, addedPackages, addedSnapshots, skippedRemovedMembers } = merge(currentText, headText)

if (skippedRemovedMembers.length > 0) {
  console.log(
    `[restore-lockfile] 跳过 ${skippedRemovedMembers.length} 条已从上游 workspace 移除的成员记录（当前链接树中不存在）：`
      + `${skippedRemovedMembers.slice(0, 6).join(', ')}${skippedRemovedMembers.length > 6 ? ' …' : ''}`,
  )
}

if (addedImporters === 0 && unionedEdges === 0 && addedPackages === 0 && addedSnapshots === 0) {
  console.log('[restore-lockfile] vendor importer 记录完整，无需修复。')
  process.exit(0)
}

if (checkOnly) {
  console.error(`[restore-lockfile] 检测到缺失：vendor importer ${addedImporters} 条、specifier 边 ${unionedEdges} 条（同一包名跨依赖组只补一条，dependencies 优先）、packages ${addedPackages} 条、snapshots ${addedSnapshots} 条。`)
  console.error('[restore-lockfile] 请执行 node scripts/upstream/pin/restore-lockfile-vendor-records.mjs 修复后再提交。')
  process.exit(1)
}

const mergedText = serialize(parsed)
writeFileSync(lockfilePath, mergedText)
console.log(`[restore-lockfile] 已补回 vendor importer ${addedImporters} 条、specifier 边 ${unionedEdges} 条、packages ${addedPackages} 条、snapshots ${addedSnapshots} 条。`)
console.log('[restore-lockfile] 请运行 pnpm install --frozen-lockfile 验证。')
