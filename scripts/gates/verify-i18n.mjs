/**
 * Bilingual-pair consistency gate (docs/i18n-record.json + per-package
 * README.i18n.yaml sidecars). Both languages carry equal authority; after
 * editing either side, bring the other along and re-record with
 * `npm run verify:i18n -- --write`.
 *
 * 发现面是 glob 而不是手写清单（升级计划 §22.3.7）：
 *  - docs 下任意层级的 *.en-US.md 自动成为一对（递归子目录；中文主档 = 同目录
 *    同名去 .en-US.md，只有 docs/ 顶层的镜像保留「仓库根 stem.md 优先」的旧
 *    语义）——新增镜像而不登记 = 红，删掉某一侧 = 红；只扫顶层会让 docs 子目录
 *    的整对镜像静默落在发现面之外；
 *  - packages/<pkg>/README.i18n.yaml 记录同目录 README 对的内容哈希，文件在而记录
 *    过期 = 红（--write 重录）。
 * 这样「手写 5 对、镜像整段缺失仍全绿」的盲区不再存在。
 *
 * sidecar 的两种已登记格式都认（发现面必须覆盖真实文件名，不能只认其中一种）：
 *  - 平铺：`README.md: <hash>` / `README.zh.md: <hash>`；
 *  - 嵌套（en:/zh: 两级映射）：键带缩进，同样一行一 hash；
 *  - hash 算法按位数区分：64 位 = 文件 sha-256（chamber 侧 sidecar），
 *    40 位 = git blob 哈希（dsh-client-connection / dsh-client-web 这类上游拷贝沿用的
 *    `git hash-object` 记录；这里用 sha1("blob <字节数>\0" + 内容) 原地重算，
 *    不启动 git）。
 * 解析不到任何一对的 sidecar 直接判红：一个存在却读不出行对的记录文件是「静默空扫」，
 * 不能当通过（这正是 4 个嵌套 sidecar 此前被整包跳过、2 个 git-blob 包被位数过滤的盲区）。
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

/**
 * git blob 哈希（`git hash-object` 的等价实现，**不启动 git**）：
 * sha1("blob " + 字节长度 + "\0" + 内容)。上游拷贝沿用 40 位十六进制的这种记录。
 * @param {string} relPath - 仓库根相对路径。
 * @returns {string} 40 位十六进制哈希。
 */
export function gitBlobSha1(relPath) {
  const content = readFileSync(join(ROOT, relPath))
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

/** sidecar 的一行文件/hash 对：允许缩进（嵌套 en:/zh: 结构），hash 64 位 sha256 或 40 位 git blob。 */
export const SIDECAR_PAIR_LINE = /^\s*(README(?:\.[A-Za-z]{2}(?:-[A-Za-z]+)?)?\.md):\s*([0-9a-f]{64}|[0-9a-f]{40})\s*$/u

/** 按记录位数选算法（sidecar 里写的是哪种，就用哪种校验）。 */
export function sidecarHashAlgorithm(hash) {
  return hash.length === 64 ? 'sha256' : 'git-blob'
}

function fileExists(relPath) {
  try {
    readFileSync(join(ROOT, relPath))
    return true
  } catch {
    return false
  }
}

/**
 * glob：docs/ 下每一对 X.en-US.md ↔ 中文主档（递归子目录）。
 * 子目录里的镜像同样必须在发现面内（同目录配对）；只有 docs/ 顶层的镜像保留
 * 「仓库根 stem.md 优先」的旧语义（README/CONTRIBUTING 的中文主档在仓库根）。
 * @param {string} [root] - repository root (tests inject a fixture).
 * @returns {{ en: string, zh: string }[]} doc pairs.
 */
export function discoverDocPairs(root = ROOT) {
  const pairs = []
  const visit = (directory, relDir) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir === '' ? entry.name : relDir + '/' + entry.name
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), rel)
        continue
      }
      if (!entry.name.endsWith('.en-US.md')) continue
      const stem = entry.name.slice(0, -'.en-US.md'.length)
      const sibling = relDir === '' ? 'docs/' + stem + '.md' : 'docs/' + relDir + '/' + stem + '.md'
      const zh = relDir === '' && fileExists(stem + '.md') ? stem + '.md' : sibling
      pairs.push({ en: 'docs/' + rel, zh })
    }
  }
  visit(join(root, 'docs'), '')
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
      // 缩进键是嵌套 en:/zh: 结构的正常形态（4 个 sidecar 这样写）；不带 ^ 锚定
      // 只能看到平铺记录，那 4 个包会被静默跳过。
      const match = SIDECAR_PAIR_LINE.exec(line)
      if (match === null) continue
      pairs.push({ lineIndex: index, file: 'packages/' + pkg + '/' + match[1], hash: match[2], algorithm: sidecarHashAlgorithm(match[2]) })
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
// sidecar 一行都解析不出（格式变了/写坏了）：同样是 --write 修不了的失败面——
// 静默跳过会让「记录文件在、其实没校验任何一对」冒充通过。
let sidecarUnreadable = false
// sidecar 指向不存在的文件：--write 不能凭空重录，也不能静默跳过（否则一次
// --write 会把指向幽灵文件的记录当成「已一致」留在盘上）。
let missingRecordTarget = false
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
  if (sidecar.pairs.length === 0) {
    console.error('DRIFTED      ' + sidecar.sidecar + ' —— 解析不到任何 README 文件/hash 对'
      + '（已支持：平铺与缩进 en:/zh: 结构；64 位 sha-256 与 40 位 git blob 哈希）——记录格式变了，或文件写坏了')
    drifted = true
    sidecarUnreadable = true
    continue
  }
  let changed = false
  const nextLines = [...sidecar.lines]
  for (const pair of sidecar.pairs) {
    if (!fileExists(pair.file)) {
      console.error('DRIFTED      ' + sidecar.sidecar + ' —— 记录指向不存在的文件：' + pair.file)
      drifted = true
      missingRecordTarget = true
      continue
    }
    const actual = pair.algorithm === 'git-blob' ? gitBlobSha1(pair.file) : sha256(pair.file)
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
  if (sidecarUnreadable) {
    console.error('\n有 sidecar 解析不出任何一对——--write 只能重录已解析到的记录，先把记录格式修对')
    process.exit(1)
  }
  if (missingRecordTarget) {
    console.error('\n有 sidecar 记录指向不存在的文件——--write 不能凭空重录，先补文件或删掉那一行')
    process.exit(1)
  }
} else if (drifted || structuralFailure) {
  // 结构不对等是 --write 修不了的失败面：记录里的哈希可以恰好都是最新（drifted
  // 为 false），但镜像少了一节/标题层级对不上仍必须红——先前的非 write 分支只看
  // drifted，这种「哈希最新、结构残缺」的镜像可以一路绿。
  if (structuralFailure) {
    console.error('\n结构不对等——把缺的段落补齐再重录（哈希重录改变不了镜像少一节）')
  }
  console.error('\none or more pairs drifted — sync the other side, then run: npm run verify:i18n -- --write')
  process.exit(1)
}
