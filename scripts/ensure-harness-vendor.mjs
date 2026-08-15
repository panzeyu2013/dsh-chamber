#!/usr/bin/env node
/**
 * ensure-harness-vendor.mjs — 保证 `vendor/harness-packages/@deepseek-ai/*`
 * workspace 包源树就绪(构建期源码复用:vite 与 gen-typert-remotes 均按源码
 * 解析,见设计 05 §3.6 与 vite.config.mjs)。
 *
 * 本地开发:优先复用外部 dsh 检出(兄弟目录 deepseek-harness),零网络。
 * CI/全新环境:从固定 commit(harness.commit)下载快照到 <repo>/vendor/
 * harness-checkout,保证与 pnpm-lock.yaml 同源可复现。
 *
 * 本脚本挂在 root package.json `preinstall`,但 pnpm 在 preinstall 之前就
 * 捕获工作区快照——全新环境(无 vendor 树)仅靠 preinstall 会产生残缺安装
 * (vendor 包全部落空为 registry 解析)。因此 CI/文档流程必须**在 pnpm
 * install 之前显式运行本脚本**(ci.yml 的 Bootstrap vendor tree 步骤)。
 * 本脚本只使用 node 内置模块 + git/curl/tar 二进制,不依赖任何安装产物。
 *
 * 来源解析顺序:
 *   1. DSH_CHAMBER_HARNESS_ROOT 环境变量(显式指定检出目录)
 *   2. <repo>/vendor/harness-checkout(受管快照;内含 .harness-pin 且 == pin 才复用)
 *   3. <repo>/../deepseek-harness(兄弟检出,本地开发便利;HEAD 与 pin 不一致时警告)
 *   4. 从 codeload 下载固定 commit 的 tarball 快照到 <repo>/vendor/harness-checkout
 *
 * 受管快照走 codeload 而非 `git fetch --depth 1 <sha>`:GitHub 对任意 SHA 的
 * shallow fetch 需服务端临时计算 pack,大仓库上极其缓慢;tarball 按 commit
 * 直接出快照,由 blob 存储服务,快且确定性一致。校验通过快照内的
 * `.harness-pin` marker 完成(pin 写入由本脚本独占,内容即 commit)。
 *
 * pin 来源:根目录 harness.commit(已提交)→ DSH_CHAMBER_HARNESS_COMMIT 覆盖。
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LINK_DIR = join(REPO_ROOT, 'vendor', 'harness-packages', '@deepseek-ai')
const MANAGED_DIR = join(REPO_ROOT, 'vendor', 'harness-checkout')
const MANAGED_PIN_FILE = join(MANAGED_DIR, '.harness-pin')
const SIBLING_DIR = join(REPO_ROOT, '..', 'deepseek-harness')
const PIN_FILE = join(REPO_ROOT, 'harness.commit')
const TARBALL_URL = 'https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/'

/** chamber 拷贝包(可改的 dsh 源码,解析到 packages/ 下的副本,见 AGENTS.md)。 */
const EXCLUDED = new Set(['dsh-client-connection', 'dsh-client-web'])

const MIN_LINKS = 100

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`)
  }
  return result.stdout.trim()
}

function gitHead(dir) {
  try {
    return run('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

function readPin() {
  const fromEnv = process.env.DSH_CHAMBER_HARNESS_COMMIT
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.trim()
  if (!existsSync(PIN_FILE)) {
    throw new Error(`缺少固定提交文件 ${PIN_FILE}(与 pnpm-lock.yaml 同源,请提交)`)
  }
  const line = readFileSync(PIN_FILE, 'utf8').split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'))
  if (line === undefined) throw new Error(`${PIN_FILE} 中没有有效的 commit 行`)
  return line
}

function validSource(root) {
  return root !== null
    && existsSync(join(root, 'packages'))
    && existsSync(join(root, 'tsconfig.host.json'))
}

function managedMatchesPin(pin) {
  return existsSync(MANAGED_PIN_FILE) && readFileSync(MANAGED_PIN_FILE, 'utf8').trim() === pin
}

function downloadManaged(pin) {
  console.log(`[ensure-harness-vendor] 下载固定 commit ${pin.slice(0, 12)} 快照 → ${MANAGED_DIR}`)
  const staging = `${MANAGED_DIR}.staging`
  const archive = `${MANAGED_DIR}.tgz`
  try {
    rmSync(staging, { recursive: true, force: true })
    rmSync(archive, { force: true })
    mkdirSync(staging, { recursive: true })
    run('curl', ['-fsSL', `${TARBALL_URL}${pin}`, '--connect-timeout', '30', '--max-time', '1200', '-o', archive])
    run('tar', ['xzf', archive, '-C', staging, '--strip-components=1'])
    if (!validSource(staging)) {
      throw new Error(`快照内容不完整(缺 packages/ 或 tsconfig.host.json): ${staging}`)
    }
    writeFileSync(join(staging, '.harness-pin'), `${pin}\n`)
    rmSync(MANAGED_DIR, { recursive: true, force: true })
    renameSync(staging, MANAGED_DIR)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
}

function resolveSource(pin) {
  const fromEnv = process.env.DSH_CHAMBER_HARNESS_ROOT
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!validSource(fromEnv)) {
      throw new Error(`DSH_CHAMBER_HARNESS_ROOT=${fromEnv} 不是有效的 dsh 检出(缺 packages/ 或 tsconfig.host.json)`)
    }
    console.log(`[ensure-harness-vendor] 使用 DSH_CHAMBER_HARNESS_ROOT: ${fromEnv}`)
    return fromEnv
  }
  if (managedMatchesPin(pin)) {
    console.log(`[ensure-harness-vendor] 复用受管快照 ${MANAGED_DIR} (pin = ${pin.slice(0, 12)})`)
    return MANAGED_DIR
  }
  if (existsSync(SIBLING_DIR) && validSource(SIBLING_DIR)) {
    const head = gitHead(SIBLING_DIR)
    if (head !== null && head !== pin) {
      console.warn(`[ensure-harness-vendor] 警告: 兄弟检出 ${SIBLING_DIR} HEAD=${head.slice(0, 12)} 与 pin ${pin.slice(0, 12)} 不一致 — 构建结果可能与 pnpm-lock.yaml 失配`)
    }
    console.log(`[ensure-harness-vendor] 使用兄弟检出 ${SIBLING_DIR}${head === null ? ' (非 git 检出)' : ''}`)
    return SIBLING_DIR
  }
  if (existsSync(MANAGED_DIR)) {
    console.warn('[ensure-harness-vendor] 受管快照与 pin 不一致,重新下载')
  }
  downloadManaged(pin)
  return MANAGED_DIR
}

/**
 * 遍历检出树的 workspace 包:解析上游自己的 pnpm-workspace.yaml `packages:`
 * globs(权威来源——旧手工链接只走了 packages/** + vendor/**,漏掉了
 * native/landlock-run、apps/* 等根,导致 @deepseek-ai/node-addon-landlock-run、
 * @deepseek-ai/dsh-web-frontend 缺失,非 frozen 安装无法解析),收集
 * package.json name 为 @deepseek-ai/* 的目录。website/examples/python
 * (部署/演示根,chamber 构建不引用)按前缀排除。
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

function rebuildLinks(source) {
  mkdirSync(LINK_DIR, { recursive: true })
  for (const entry of readdirSync(LINK_DIR)) {
    const link = join(LINK_DIR, entry)
    const st = lstatSync(link)
    if (st.isSymbolicLink()) {
      // junction 也是 reparse point;递归+force 对链接本身安全(不跟随目标)
      rmSync(link, { recursive: true, force: true })
    } else {
      throw new Error(`${link} 不是符号链接 — 拒绝覆盖,请人工检查`)
    }
  }
  const packages = collectPackages(source)
  if (packages.length < MIN_LINKS) {
    throw new Error(`发现的 @deepseek-ai 包过少(${packages.length} < ${MIN_LINKS}),疑似检出不完整: ${source}`)
  }
  for (const { suffix, dir } of packages) {
    const link = join(LINK_DIR, suffix)
    // Windows junction 要求绝对目标(node 对 junction 类型会自动归一化为绝对路径,
    // 这里仍显式传绝对路径以消除歧义)
    const target = process.platform === 'win32' ? dir : relative(dirname(link), dir)
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  return packages.length
}

/**
 * 受管快照解析 shim:`@deepseek-ai/dsh-subprocess-local` 的 postinstall
 * (ensure-spawn-helper.mjs)用 import.meta.resolve('node-pty') 从脚本真实
 * 路径向上解析。pnpm 的 allowBuilds 只约束"依赖包"的构建脚本,workspace
 * 成员自身的 postinstall 在全新安装时无条件执行——而成员真实路径在受管
 * 快照内,node-pty 只存在于仓库的虚拟存储,解析必然失败。这里在快照根放
 * 一个 node_modules 符号链接指向仓库根 node_modules(node-pty 已作为根
 * devDependency 提升到根,见 package.json 与 pnpm-workspace.yaml 注释),
 * 使该 postinstall 在全新安装时能解析到 node-pty 并成为无害 no-op(helper
 * 不存在时无事可做)。指向根 node_modules 而非 .pnpm 虚拟存储,是因为虚拟
 * 存储的公共提升层(node_modules/.pnpm/node_modules)在部分平台/pnpm 版本
 * (Windows + pnpm 11.22)下不可靠;根 node_modules 是安装的主要产物,任何
 * 平台都存在且根依赖恒被链接。
 * 仅受管快照(CI/全新环境)需要:兄弟检出/外部根时成员真实路径在仓库外,
 * 仓库内 shim 够不着(本地为增量开发,不触发全新安装的脚本执行)。
 */
function ensureManagedResolutionShim() {
  if (!existsSync(MANAGED_DIR)) return
  const shim = join(MANAGED_DIR, 'node_modules')
  const target = join(REPO_ROOT, 'node_modules')
  let st
  try {
    st = lstatSync(shim)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (st !== undefined) {
    if (st.isSymbolicLink()) return
    throw new Error(`${shim} 已存在且不是符号链接 — 拒绝覆盖,请人工检查`)
  }
  symlinkSync(
    process.platform === 'win32' ? target : relative(dirname(shim), target),
    shim,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  console.log(`[ensure-harness-vendor] 快照解析 shim 就绪: ${relative(REPO_ROOT, shim)} -> ${relative(REPO_ROOT, target)}`)
}

function main() {
  const pin = readPin()
  const source = resolveSource(pin)
  const count = rebuildLinks(source)
  if (source === MANAGED_DIR) ensureManagedResolutionShim()
  console.log(`[ensure-harness-vendor] vendor/harness-packages/@deepseek-ai: ${count} 个包链接就绪 (source=${source}, pin=${pin.slice(0, 12)})`)
}

main()
