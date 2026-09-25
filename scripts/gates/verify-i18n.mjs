/**
 * Bilingual-pair consistency gate (docs/i18n-record.json + per-package
 * README.i18n.yaml sidecars). Both languages carry equal authority; after
 * editing either side, bring the other along and re-record with
 * `npm run verify:i18n -- --write`.
 *
 * 发现面是 glob 而不是手写清单（升级计划 §22.3.7）：
 *  - docs/*.en-US.md 自动成为一对（中文主档 = 同名去 .en-US.md；根目录优先，
 *    否则 docs/）——新增镜像而不登记 = 红，删掉某一侧 = 红；
 *  - packages/<pkg>/README.i18n.yaml 记录同目录 README 对的内容哈希，文件在而记录
 *    过期 = 红（--write 重录）。
 * 这样「手写 5 对、镜像整段缺失仍全绿」的盲区不再存在。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareStructures } from '../lib/i18n-structure.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const RECORD_FILE = 'docs/i18n-record.json'
const SIDECAR_NAME = 'README.i18n.yaml'

function sha256(relPath) {
  return createHash('sha256').update(readFileSync(join(ROOT, relPath))).digest('hex')
}

function fileExists(relPath) {
  try {
    readFileSync(join(ROOT, relPath))
    return true
  } catch {
    return false
  }
}

/** glob：docs/ 下的每对 X.en-US.md ↔ 中文主档（根目录优先，否则 docs/）。 */
export function discoverDocPairs(root = ROOT) {
  const pairs = []
  for (const name of readdirSync(join(root, 'docs')).sort()) {
    if (!name.endsWith('.en-US.md')) continue
    const stem = name.slice(0, -'.en-US.md'.length)
    const zh = fileExists(stem + '.md') ? stem + '.md' : 'docs/' + stem + '.md'
    pairs.push({ en: 'docs/' + name, zh })
  }
  return pairs
}

/** glob：packages/<pkg>/README.i18n.yaml（记录同目录 README 对的 sha-256）。 */
export function discoverSidecars(root = ROOT) {
  const sidecars = []
  for (const pkg of readdirSync(join(root, 'packages')).sort()) {
    const rel = 'packages/' + pkg + '/' + SIDECAR_NAME
    if (!fileExists(rel)) continue
    const lines = readFileSync(join(root, rel), 'utf8').split('\n')
    const pairs = []
    for (const [index, line] of lines.entries()) {
      const match = /^(README(?:\.[A-Za-z]{2}(?:-[A-Za-z]+)?)?\.md):\s*([0-9a-f]{64})\s*$/u.exec(line)
      if (match === null) continue
      pairs.push({ lineIndex: index, file: 'packages/' + pkg + '/' + match[1], hash: match[2] })
    }
    sidecars.push({ sidecar: rel, lines, pairs })
  }
  return sidecars
}

const write = process.argv.includes('--write')
const recordPath = join(ROOT, RECORD_FILE)
let record = { files: {} }
try {
  record = JSON.parse(readFileSync(recordPath, 'utf8'))
} catch { /* first run */ }
record.files ??= {}

let drifted = false
// 结构不对等是「--write 修不了」的失败面：哈希重录改变不了「镜像少了一节」。
let structuralFailure = false
const seen = new Set()

for (const pair of discoverDocPairs()) {
  seen.add(pair.en)
  if (!fileExists(pair.zh)) {
    console.error('DRIFTED      ' + pair.en + ' —— 缺中文主档：' + pair.zh)
    drifted = true
    continue
  }
  const structure = compareStructures(readFileSync(join(ROOT, pair.zh), 'utf8'), readFileSync(join(ROOT, pair.en), 'utf8'))
  if (!structure.ok) {
    console.error('DRIFTED      ' + pair.en + ' —— 结构不对等（--write 修不了，必须把缺的那侧补齐）：' + structure.problems.join('；'))
    structuralFailure = true
  }
  const hashes = { en: sha256(pair.en), zh: sha256(pair.zh) }
  const prev = record.files[pair.en]
  const ok = prev !== undefined && prev.en === hashes.en && prev.zh === hashes.zh
  console.log((write ? 'recorded' : ok ? 'consistent' : 'DRIFTED').padEnd(12) + ' ' + pair.en)
  if (write) record.files[pair.en] = hashes
  else if (!ok) drifted = true
}

for (const en of Object.keys(record.files)) {
  if (seen.has(en)) continue
  console.error('DRIFTED      ' + en + ' —— 记录里有一对已不存在（删掉记录或恢复文件）')
  drifted = true
  if (write) delete record.files[en]
}

for (const sidecar of discoverSidecars()) {
  let changed = false
  const nextLines = [...sidecar.lines]
  for (const pair of sidecar.pairs) {
    if (!fileExists(pair.file)) {
      console.error('DRIFTED      ' + sidecar.sidecar + ' —— 记录指向不存在的文件：' + pair.file)
      drifted = true
      continue
    }
    const actual = sha256(pair.file)
    const ok = actual === pair.hash
    console.log((write ? 'recorded' : ok ? 'consistent' : 'DRIFTED').padEnd(12) + ' ' + pair.file)
    if (!ok && !write) drifted = true
    if (write && !ok) {
      nextLines[pair.lineIndex] = nextLines[pair.lineIndex].replace(pair.hash, actual)
      changed = true
    }
  }
  if (changed) writeFileSync(join(ROOT, sidecar.sidecar), nextLines.join('\n'))
}

if (write) {
  writeFileSync(recordPath, JSON.stringify(record, undefined, 2) + '\n')
  console.log('record written: ' + RECORD_FILE + '（sidecar 哈希按实际内容重录）')
  if (structuralFailure) {
    console.error('\n结构不对等不能用 --write 抹平——把缺的段落补齐再重录')
    process.exit(1)
  }
} else if (drifted) {
  console.error('\none or more pairs drifted — sync the other side, then run: npm run verify:i18n -- --write')
  process.exit(1)
}
