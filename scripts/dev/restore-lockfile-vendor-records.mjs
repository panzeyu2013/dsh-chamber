#!/usr/bin/env node
/**
 * Restore the pnpm 11 lockfile pruning side-effect for the vendor workspace.
 *
 * 背景：vendor/harness-packages/@deepseek-ai/* 是 symlink 指向外部 harness
 * 检出（见 AGENTS.md「Always-On Constraints」与 pnpm-workspace.yaml 注释）。
 * pnpm 11 在 lockfile 需要结构性重解时（增删依赖、升降版本、pnpm add/remove/
 * update）会把这一整段 `importers:` 记录裁剪掉——即使 vendor 树在场也一样
 * （实测 pnpm 11.21.0）。裁剪后 `pnpm install --frozen-lockfile` 会立即失败
 * （"specifiers in the lockfile don't match specifiers in package.json"），CI
 * 每个 job 第一步就红。
 *
 * 提交版 lockfile（git HEAD:pnpm-lock.yaml）保留着完整的 vendor importer
 * 记录，是这些记录的唯一权威来源。本脚本在任意 lockfile 重生成之后执行：
 *   - 把 HEAD 里缺失的 vendor importer 记录补回当前 lockfile（只增不减）；
 *   - 对 packages:/snapshots: 做并集恢复——真实裁剪会连同 vendor 图的全部
 *     传递依赖条目一起清掉（实测 347+ 条），HEAD 中缺失的条目全部补回；
 *   - 新增块按 pnpm 的归一化键排序落位，diff 最小。
 * 然后照常以 `pnpm install --frozen-lockfile` 收尾验证。
 *
 * 用法：
 *   node scripts/dev/restore-lockfile-vendor-records.mjs            # 就地修复
 *   node scripts/dev/restore-lockfile-vendor-records.mjs --check    # 只检测，缺失即退出码 1
 * 测试可用环境变量覆盖路径（默认走 git HEAD）：
 *   RESTORE_LOCKFILE_PATH=<工作 lockfile>  RESTORE_LOCKFILE_HEAD=<HEAD 版本>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
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
  const curImporters = curSections.get('importers')
  const headImporters = headSections.get('importers')
  if (curImporters && headImporters) {
    const keys = new Set(curImporters.blocks.map((b) => normalizeKey(b.key)))
    for (const block of headImporters.blocks) {
      const key = normalizeKey(block.key)
      if (key.startsWith(VENDOR_IMPORTER_PREFIX) && !keys.has(key)) {
        curImporters.blocks.push({ key: block.key, lines: [...block.lines] })
        keys.add(key)
        addedImporters++
      }
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

  return { parsed: cur, addedImporters, addedPackages: added.packages, addedSnapshots: added.snapshots }
}

if (!existsSync(lockfilePath)) {
  console.error(`[restore-lockfile] 未找到 lockfile：${lockfilePath}`)
  process.exit(1)
}
const currentText = readFileSync(lockfilePath, 'utf8')
const headText = readHeadLockfile()

const { parsed, addedImporters, addedPackages, addedSnapshots } = merge(currentText, headText)

if (addedImporters === 0 && addedPackages === 0 && addedSnapshots === 0) {
  console.log('[restore-lockfile] vendor importer 记录完整，无需修复。')
  process.exit(checkOnly ? 0 : 0)
}

if (checkOnly) {
  console.error(`[restore-lockfile] 检测到缺失：vendor importer ${addedImporters} 条、packages ${addedPackages} 条、snapshots ${addedSnapshots} 条。`)
  console.error('[restore-lockfile] 请执行 node scripts/dev/restore-lockfile-vendor-records.mjs 修复后再提交。')
  process.exit(1)
}

const mergedText = serialize(parsed)
writeFileSync(lockfilePath, mergedText)
console.log(`[restore-lockfile] 已补回 vendor importer ${addedImporters} 条、packages ${addedPackages} 条、snapshots ${addedSnapshots} 条。`)
console.log('[restore-lockfile] 请运行 pnpm install --frozen-lockfile 验证。')
