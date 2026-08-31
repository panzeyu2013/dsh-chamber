#!/usr/bin/env node
/**
 * ensure-harness-vendor.mjs — 保证 `vendor/harness-packages/@deepseek-ai/*`
 * workspace 包源树就绪（构建期源码复用：vite 与 gen-typert-remotes 均按源码
 * 解析，见设计 05 §3.6 与 vite.config.mjs）。
 *
 * 单一事实来源（2026-09 submodule 化）：`vendor/harness-checkout` 是固定
 * commit 的 git submodule（gitlink 即 pin），本脚本只认这一个源——不读
 * DSH_CHAMBER_HARNESS_ROOT / DSH_CHAMBER_HARNESS_COMMIT、不复用兄弟检出、
 * 不从 codeload 下载。pin 的声明性副本是根目录 harness.commit，脚本强制
 * submodule HEAD == harness.commit（任何模式都硬校验，不一致即失败——git
 * commit 是内容寻址的，HEAD 匹配即内容匹配，杜绝静默漂移）。
 *
 * 本脚本挂在 root package.json `preinstall`，但 pnpm 在 preinstall 之前就
 * 捕获工作区快照——全新环境（无 vendor 树）仅靠 preinstall 会产生残缺安装
 * （vendor 包全部落空为 registry 解析）。因此 CI/文档流程必须**在 pnpm
 * install 之前显式运行本脚本**（ci.yml 的 Bootstrap vendor tree 步骤）。
 * 本脚本只使用 node 内置模块 + git 二进制，不依赖任何安装产物。
 *
 * 模式：
 *   默认（ensure）——校验 submodule pin → 差量重建链接（幂等：集合未变时
 *     零操作，消除 preinstall 重链窗口）→ 断言「链接集合 == pnpm-lock.yaml
 *     importer 集合」（对称差非空即失败，提示 restore-lockfile-vendor-records
 *     或走 update-vendor.mjs 重生成）→ 打印摘要。
 *   --allow-lockfile-stale —— 跳过锁文件一致性断言（仅供 update-vendor.mjs
 *     在锁文件重生成**之前**差量建链使用；其余校验不变）。pnpm install 的
 *     preinstall 调用无法传参，同等豁免走环境变量
 *     DSH_CHAMBER_VENDOR_ALLOW_STALE_LOCKFILE=1（重生成流程专用，见
 *     update-vendor.mjs；日常开发/CI 不设置）。
 *   --check —— 只校验不写盘：submodule pin、链接集合与目标集合一致、链接
 *     目标 realpath 指向 submodule。供 CI verify / 本地诊断。
 *
 * pin 升级：运行 `node scripts/dev/update-vendor.mjs <tag>`（原子流程：切
 * submodule → 更新 harness.commit → 差量建链 → 锁文件重生成 → frozen 验证）。
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LINK_DIR = join(REPO_ROOT, 'vendor', 'harness-packages', '@deepseek-ai')
const MANAGED_DIR = join(REPO_ROOT, 'vendor', 'harness-checkout')
const PIN_FILE = join(REPO_ROOT, 'harness.commit')
const LOCKFILE = join(REPO_ROOT, 'pnpm-lock.yaml')

/** chamber 拷贝包（可改的 dsh 源码，解析到 packages/ 下的副本，见 AGENTS.md）。 */
// dsh-api-gateway：chamber 副本（packages/dsh-api-gateway），上游 api-gateway 的
// client 半 + per-entry base-path 补丁（WP3/M3，决策 D1 方案 A）——推流 WebSocket
// 必须落到 `<basePath>/api/remote.mux`，vendor 原包无法打该补丁。
const EXCLUDED = new Set(['dsh-client-connection', 'dsh-client-web', 'dsh-api-gateway'])

const MIN_LINKS = 100

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`)
  }
  return result.stdout.trim()
}

/** 读取声明性 pin（harness.commit 首个非空非注释行）。 */
function readPin() {
  if (!existsSync(PIN_FILE)) {
    throw new Error(`缺少固定提交文件 ${PIN_FILE}(与 submodule gitlink 同源,请提交)`)
  }
  const line = readFileSync(PIN_FILE, 'utf8').split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'))
  if (line === undefined) throw new Error(`${PIN_FILE} 中没有有效的 commit 行`)
  return line
}

/** submodule 当前 HEAD；目录缺失/非 git 检出返回 null。 */
function submoduleHead() {
  if (!existsSync(join(MANAGED_DIR, '.git'))) return null
  try {
    return run('git', ['-C', MANAGED_DIR, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

/**
 * 校验 submodule 单一事实来源：目录存在、HEAD 可解析、且 == 声明性 pin。
 * 任何模式共用；不匹配即硬失败（不再有"警告后继续"的静默回退）。
 */
function verifyPin() {
  const pin = readPin()
  if (!existsSync(MANAGED_DIR)) {
    throw new Error(`submodule ${MANAGED_DIR} 不存在 — 请先物化：git submodule update --init(本地) 或 checkout submodules: true(CI)`)
  }
  const head = submoduleHead()
  if (head === null) {
    throw new Error(`${MANAGED_DIR} 不是 git 检出（submodule 未正确物化）`)
  }
  if (head !== pin) {
    throw new Error(`submodule HEAD=${head.slice(0, 12)} != harness.commit pin=${pin.slice(0, 12)} — 禁止从漂移检出建链;` +
      ` pin 升级请走 node scripts/dev/update-vendor.mjs <tag>`)
  }
  // gitlink（index 里的 160000 条目）与声明 pin 一致：把"手改 harness.commit
  // 而 gitlink 未动"的洞从 CI（checkout 物化后硬失败）提前到本地。
  const gitlink = gitLinkCommit()
  if (gitlink !== null && gitlink !== pin) {
    throw new Error(`submodule gitlink=${gitlink.slice(0, 12)} != harness.commit pin=${pin.slice(0, 12)} — 请用 node scripts/dev/update-vendor.mjs <tag> 升级（gitlink 与 pin 同批提交）`)
  }
  return pin
}

/** 读取 index 中 submodule 的 gitlink commit；未跟踪/无 submodule 时返回 null。 */
function gitLinkCommit() {
  try {
    const line = run('git', ['-C', REPO_ROOT, 'ls-files', '-s', '--', 'vendor/harness-checkout'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const m = /^160000\s+([0-9a-f]{40})\s/.exec(line)
    return m !== null ? m[1] : null
  } catch {
    return null
  }
}

/**
 * 遍历 submodule 的 workspace 包：解析上游自己的 pnpm-workspace.yaml
 * `packages:` globs（权威来源——旧手工链接只走了 packages/** + vendor/**，
 * 漏掉了 native/landlock-run、apps/* 等根，导致 @deepseek-ai/node-addon-landlock-run、
 * @deepseek-ai/dsh-web-frontend 缺失，非 frozen 安装无法解析），收集
 * package.json name 为 @deepseek-ai/* 的目录。website/examples/python
 * （部署/演示根，chamber 构建不引用）按前缀排除。
 */
const SKIP_ROOT_PREFIXES = ['website', 'examples', 'python']

function expandPattern(source, pattern) {
  const segments = pattern.split('/')
  let dirs = [source]
  for (const seg of segments) {
    if (seg === '') continue
    if (seg === '*') {
      dirs = dirs.flatMap((d) => existsSync(d)
        ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name))
        : [])
    } else {
      dirs = dirs.map((d) => join(d, seg))
    }
  }
  return dirs
}

function workspacePatterns(source) {
  const file = join(source, 'pnpm-workspace.yaml')
  if (!existsSync(file)) throw new Error(`检出处缺少 ${file}`)
  const patterns = []
  let inPackages = false
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trimEnd()
    if (!inPackages) {
      if (/^packages:\s*$/.test(line)) inPackages = true
      continue
    }
    if (/^\S/.test(line)) break
    const match = line.match(/^\s*-\s*(\S+)\s*$/)
    if (match !== null && !match[1].startsWith('#')) patterns.push(match[1])
  }
  if (patterns.length === 0) throw new Error(`无法解析 ${file} 的 packages 列表`)
  return patterns
}

function collectPackages(source) {
  const found = []
  for (const pattern of workspacePatterns(source)) {
    for (const dir of expandPattern(source, pattern)) {
      if (!existsSync(dir)) continue
      const rootRel = relative(source, dir)
      if (SKIP_ROOT_PREFIXES.some((p) => rootRel === p || rootRel.startsWith(`${p}/`))) continue
      const manifest = join(dir, 'package.json')
      if (!existsSync(manifest)) continue
      let name
      try {
        name = JSON.parse(readFileSync(manifest, 'utf8')).name
      } catch {
        continue
      }
      if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
      const suffix = name.slice('@deepseek-ai/'.length)
      if (!EXCLUDED.has(suffix)) found.push({ suffix, dir })
    }
  }
  const seen = new Set()
  const unique = []
  for (const p of found) {
    if (seen.has(p.suffix)) continue
    seen.add(p.suffix)
    unique.push(p)
  }
  return unique
}

/**
 * 解析 pnpm-lock.yaml importers 段的 vendor 链接成员集合。
 * v9 锁文件里 vendor importer 键是恰好 2 空格缩进的
 * `vendor/harness-packages/@deepseek-ai/<name>:`；pnpm 对**零依赖**成员序列化
 * 为单行块 `vendor/harness-packages/@deepseek-ai/<name>: {}`，两种行尾都要
 * 识别。registry 快照（packages:/snapshots: 段）不会出现该前缀。不依赖 yaml
 * 解析库（脚本只允许内置模块）。
 */
function lockfileVendorMembers() {
  if (!existsSync(LOCKFILE)) return new Set()
  const members = new Set()
  for (const raw of readFileSync(LOCKFILE, 'utf8').split('\n')) {
    const m = raw.match(/^  vendor\/harness-packages\/@deepseek-ai\/([^:]+):(?:\s*\{\})?\s*$/)
    if (m !== null) members.add(m[1])
  }
  return members
}

/** 链接集合 vs 锁文件 importer 集合一致性断言（对称差非空即失败）。 */
function assertLockfileMatches(packages) {
  if (!existsSync(LOCKFILE)) {
    throw new Error(`pnpm-lock.yaml 缺失（${LOCKFILE}）— 请先 pnpm install 生成锁文件，或走 update-vendor.mjs 重生成`)
  }
  const linked = new Set(packages.map((p) => p.suffix))
  const recorded = lockfileVendorMembers()
  const missing = [...linked].filter((s) => !recorded.has(s))
  const stale = [...recorded].filter((s) => !linked.has(s))
  if (missing.length > 0 || stale.length > 0) {
    const hint = '运行 node scripts/dev/restore-lockfile-vendor-records.mjs 补回 importer 记录，' +
      '或走 node scripts/dev/update-vendor.mjs <tag> 原子重生成锁文件'
    throw new Error(`链接集合与 pnpm-lock.yaml importer 集合不一致（${hint}）` +
      `${missing.length > 0 ? `\n  链接有、锁文件缺(${missing.length}): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}` : ''}` +
      `${stale.length > 0 ? `\n  锁文件有、链接缺(${stale.length}): ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ' …' : ''}` : ''}`)
  }
  return linked.size
}

function linkTarget(link, dir) {
  // Windows junction 要求绝对目标（node 对 junction 类型会自动归一化为绝对路径）
  return process.platform === 'win32' ? dir : relative(dirname(link), dir)
}

/** 期望的链接（suffix → 目标路径）。 */
function planTargets(packages) {
  const targets = new Map()
  for (const { suffix, dir } of packages) {
    targets.set(suffix, { dir, rel: linkTarget(join(LINK_DIR, suffix), dir) })
  }
  return targets
}

/**
 * 差量重建链接（幂等）：只删除多余、修复指向错误、补齐缺失；
 * 集合未变时零操作（消除 preinstall 重链窗口与并发竞态）。
 * 非符号链接占位一律拒绝覆盖。
 */
function rebuildLinks(source, packages) {
  mkdirSync(LINK_DIR, { recursive: true })
  const targets = planTargets(packages)
  const existing = new Map()
  for (const entry of readdirSync(LINK_DIR)) {
    const link = join(LINK_DIR, entry)
    let st
    try {
      st = lstatSync(link)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    if (!st.isSymbolicLink()) {
      throw new Error(`${link} 不是符号链接 — 拒绝覆盖,请人工检查`)
    }
    existing.set(entry, link)
  }

  const toRemove = [...existing.keys()].filter((s) => !targets.has(s))
  const toFix = []
  const toAdd = []
  for (const [suffix, t] of targets) {
    const link = join(LINK_DIR, suffix)
    if (!existing.has(suffix)) {
      toAdd.push(suffix)
      continue
    }
    let current
    try {
      current = readlinkSync(link)
    } catch {
      current = null
    }
    if (current !== null && resolve(dirname(link), current) !== resolve(dirname(link), t.rel)) {
      toFix.push(suffix)
    }
  }

  if (toRemove.length === 0 && toFix.length === 0 && toAdd.length === 0) {
    return { changed: false, count: targets.size }
  }
  for (const suffix of toRemove) {
    rmSync(existing.get(suffix), { recursive: true, force: true })
  }
  for (const suffix of toFix) {
    rmSync(join(LINK_DIR, suffix), { recursive: true, force: true })
  }
  for (const suffix of [...toFix, ...toAdd]) {
    const t = targets.get(suffix)
    const link = join(LINK_DIR, suffix)
    try {
      symlinkSync(t.rel, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (err) {
      // 并发容错：另一进程可能已抢先建好同一链接。重读校验——指向正确则
      // 视为已完成，否则 loud 报错（绝不静默覆盖）。
      if (err.code === 'EEXIST') {
        let current
        try {
          current = readlinkSync(link)
        } catch {
          current = null
        }
        if (current !== null && resolve(dirname(link), current) === resolve(dirname(link), t.rel)) {
          continue
        }
        throw new Error(`${link} 并发创建冲突且目标不一致（${current ?? '不可读'} vs ${t.rel}）— 人工检查`)
      }
      throw err
    }
  }
  return { changed: true, count: targets.size, removed: toRemove.length, fixed: toFix.length, added: toAdd.length }
}

/**
 * 受管 submodule 解析 shim：`@deepseek-ai/dsh-subprocess-local` 的 postinstall
 * （ensure-spawn-helper.mjs）用 import.meta.resolve('node-pty') 从脚本真实
 * 路径向上解析。pnpm 的 allowBuilds 只约束"依赖包"的构建脚本，workspace
 * 成员自身的 postinstall 在全新安装时无条件执行——而成员真实路径在 submodule
 * 内，node-pty 只存在于仓库的虚拟存储，解析必然失败。这里在 submodule 根放
 * 一个 node_modules 符号链接指向仓库根 node_modules（node-pty 已作为根
 * devDependency 提升到根，见 package.json 与 pnpm-workspace.yaml 注释），
 * 使该 postinstall 在全新安装时能解析到 node-pty 并成为无害 no-op（helper
 * 不存在时无事可做）。指向根 node_modules 而非 .pnpm 虚拟存储，是因为虚拟
 * 存储的公共提升层（node_modules/.pnpm/node_modules）在部分平台/pnpm 版本
 * （Windows + pnpm 11.22）下不可靠；根 node_modules 是安装的主要产物，任何
 * 平台都存在且根依赖恒被链接。submodule 物化后由 ensure 幂等补齐。
 */
function shimLink() {
  return { shim: join(MANAGED_DIR, 'node_modules'), target: join(REPO_ROOT, 'node_modules') }
}

function ensureManagedResolutionShim() {
  if (!existsSync(MANAGED_DIR)) return
  const { shim, target } = shimLink()
  let st
  try {
    st = lstatSync(shim)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (st !== undefined) {
    if (!st.isSymbolicLink()) {
      throw new Error(`${shim} 已存在且不是符号链接 — 拒绝覆盖,请人工检查`)
    }
    // 已存在则校验目标（与 rebuildLinks 同款比对）——指向错误/悬空的 shim
    // 会被修复，避免"零操作"放行错误目标。
    let current
    try {
      current = readlinkSync(shim)
    } catch {
      current = null
    }
    const expected = process.platform === 'win32' ? target : relative(dirname(shim), target)
    if (current !== null && resolve(dirname(shim), current) === resolve(dirname(shim), expected)) {
      return
    }
    rmSync(shim, { recursive: true, force: true })
  }
  symlinkSync(
    process.platform === 'win32' ? target : relative(dirname(shim), target),
    shim,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  console.log(`[ensure-harness-vendor] 解析 shim 就绪: ${relative(REPO_ROOT, shim)} -> ${relative(REPO_ROOT, target)}`)
}

/** --check：只校验不写盘。任一失败 throw。 */
function checkOnly(pin, packages) {
  if (!existsSync(LINK_DIR)) {
    throw new Error(`链接目录 ${LINK_DIR} 缺失 — 请先运行 node scripts/dev/ensure-harness-vendor.mjs（ensure 模式）建立链接`)
  }
  const targets = planTargets(packages)
  const linked = new Set()
  for (const entry of readdirSync(LINK_DIR)) {
    const link = join(LINK_DIR, entry)
    let st
    try {
      st = lstatSync(link)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    if (!st.isSymbolicLink()) {
      throw new Error(`${link} 不是符号链接 — 人工检查`)
    }
    linked.add(entry)
  }
  const problems = []
  for (const suffix of linked) {
    if (!targets.has(suffix)) {
      problems.push(`多余链接 ${suffix}`)
      continue
    }
    let current
    try {
      current = readlinkSync(join(LINK_DIR, suffix))
    } catch {
      current = null
    }
    if (current === null || resolve(dirname(join(LINK_DIR, suffix)), current) !== resolve(dirname(join(LINK_DIR, suffix)), targets.get(suffix).rel)) {
      problems.push(`链接目标错误 ${suffix}`)
    }
  }
  for (const suffix of targets.keys()) {
    if (!linked.has(suffix)) problems.push(`缺失链接 ${suffix}`)
  }
  // 解析 shim 与 ensure 模式同款校验（存在性 + 目标），保证 --check 与
  // ensure 的验收集合一致（--check 只读：仅报告，不修复）。
  if (existsSync(MANAGED_DIR)) {
    const { shim, target } = shimLink()
    const expected = process.platform === 'win32' ? target : relative(dirname(shim), target)
    let shimState = '缺失'
    try {
      const st = lstatSync(shim)
      if (!st.isSymbolicLink()) {
        shimState = '非符号链接'
      } else {
        let current
        try {
          current = readlinkSync(shim)
        } catch {
          current = null
        }
        if (current !== null && resolve(dirname(shim), current) === resolve(dirname(shim), expected)) {
          shimState = null
        } else {
          shimState = `目标错误(${current ?? '不可读'})`
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (shimState !== null) problems.push(`解析 shim ${relative(REPO_ROOT, shim)}: ${shimState}`)
  }
  if (problems.length > 0) {
    throw new Error(`--check 失败（${problems.length}）:\n  ${problems.slice(0, 10).join('\n  ')}${problems.length > 10 ? '\n  …' : ''}`)
  }
  assertLockfileMatches(packages)
  console.log(`[ensure-harness-vendor] --check 通过: submodule pin=${pin.slice(0, 12)}, 链接 ${targets.size} 个与锁文件 importer 集合一致`)
}

function main() {
  const args = process.argv.slice(2)
  const checkMode = args.includes('--check')
  const allowStaleLockfile = args.includes('--allow-lockfile-stale') || process.env.DSH_CHAMBER_VENDOR_ALLOW_STALE_LOCKFILE === '1'
  const pin = verifyPin()
  const packages = collectPackages(MANAGED_DIR)
  if (packages.length < MIN_LINKS) {
    throw new Error(`发现的 @deepseek-ai 包过少(${packages.length} < ${MIN_LINKS}),疑似 submodule 不完整: ${MANAGED_DIR}`)
  }
  if (checkMode) {
    checkOnly(pin, packages)
    return
  }
  const result = rebuildLinks(MANAGED_DIR, packages)
  if (!allowStaleLockfile) {
    assertLockfileMatches(packages)
  } else {
    console.warn('[ensure-harness-vendor] 跳过锁文件一致性断言（--allow-lockfile-stale，仅限 update-vendor 重生成流程）')
  }
  ensureManagedResolutionShim()
  const summary = result.changed
    ? `差量重建: 删 ${result.removed} / 修 ${result.fixed} / 补 ${result.added},共 ${result.count} 个链接`
    : `集合未变,零操作（${result.count} 个链接）`
  console.log(`[ensure-harness-vendor] vendor/harness-packages/@deepseek-ai: ${summary} (source=submodule ${MANAGED_DIR}, pin=${pin.slice(0, 12)})`)
}

main()
