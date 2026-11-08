#!/usr/bin/env node
/**
 * verify-pin-alignment.mjs —— 只读 pin 对齐校验器（node/pnpm/上游 pin 树）。
 *
 * 刻意不写死任何版本值：全部从下列单源读取后交叉比较，漂移即退出码 1。
 *   - harness.commit（源线 pin）
 *   - packages/desktop/primary-runtime-lock.json（载荷坐标）↔ vendor/harness-checkout/
 *     scripts/primary-runtime/lock.json（上游 pin 锁；targets 允许收窄到本仓出货平台）
 *   - 根 package.json packageManager（pnpm 声明单源）↔ desktop/gateway dependencies.pnpm、
 *     bundle-dsh BUNDLE_PNPM_VERSION、.github/workflows/*.yml 的 pnpm/action-setup version
 *   - packages/desktop/vendor/dsh/pnpm-lock.yaml（dsh 运行时线单源）↔ bundle-dsh 兜底常量、
 *     release.yml env、install-gateway.sh 默认值、gateway dshAnchorVersion（vendor/dsh/
 *     package.json 存在时再交叉校验）
 *
 * 输出对齐表；退出码 0 = 全部对齐，1 = 有漂移或输入缺失。用法：
 *   node scripts/release/verify-pin-alignment.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const rows = []
const problems = []

/** 规范化比较值：对象键排序、数组按内容排序——只用于相等判断，不改变原值。 */
function comparable(value) {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(comparable).sort())
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, comparable(value[key])])))
  }
  return JSON.stringify(value)
}

/** 输出摘要：长字符串/大对象截断；差异详情走 problems（那里用完整 JSON）。 */
function summary(value) {
  if (value === undefined) return '(missing)'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 56 ? text.slice(0, 53) + '…' : text
}

/** 记录一行对齐结果；repo 与 upstream 不等（且都非 undefined）即漂移。 */
function check(item, repo, upstream, display) {
  const ok = repo !== undefined && upstream !== undefined && comparable(repo) === comparable(upstream)
  rows.push({ item, repo: display?.repo ?? summary(repo), upstream: display?.upstream ?? summary(upstream), ok })
  if (!ok) problems.push(item + ': repo=' + JSON.stringify(repo) + ' upstream=' + JSON.stringify(upstream))
}

/** 读取文件并转成行数组（缺失时返回 null，交给调用方报漂移）。 */
function linesOf(relPath) {
  try { return readFileSync(join(ROOT, relPath), 'utf8').split('\n') } catch { return null }
}

function jsonOf(relPath) {
  const text = linesOf(relPath)
  return text === null ? null : JSON.parse(text.join('\n'))
}

// --- 源线 pin ---------------------------------------------------------------
const pinLines = linesOf('harness.commit') ?? []
const pin = pinLines.map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('#'))
if (pin === undefined) problems.push('harness.commit 缺 pin 行')
const lock = jsonOf('packages/desktop/primary-runtime-lock.json')
const upstreamLock = jsonOf('vendor/harness-checkout/scripts/primary-runtime/lock.json')
if (lock === null) problems.push('缺 packages/desktop/primary-runtime-lock.json')
if (upstreamLock === null) {
  problems.push('缺 vendor/harness-checkout/scripts/primary-runtime/lock.json（pin 子模块未初始化）')
} else if (lock !== null) {
  check('harness.commit ↔ lock.provenance.upstreamCommit', pin, lock.provenance?.upstreamCommit)
  check('nodeVersion', lock.nodeVersion, upstreamLock.nodeVersion)
  check('pythonVersion', lock.pythonVersion, upstreamLock.pythonVersion)
  check('pythonRelease', lock.pythonRelease, upstreamLock.pythonRelease)
  check('pythonPackages', lock.pythonPackages, upstreamLock.pythonPackages,
    { repo: Object.keys(lock.pythonPackages ?? {}).length + ' 项', upstream: Object.keys(upstreamLock.pythonPackages ?? {}).length + ' 项' })
  check('wheels（跨平台）', lock.wheels, upstreamLock.wheels,
    { repo: (lock.wheels?.length ?? '?') + ' 个', upstream: (upstreamLock.wheels?.length ?? '?') + ' 个' })
  const targets = Object.keys(lock.targets ?? {})
  rows.push({ item: 'targets（本仓收窄）', repo: targets.join(','), upstream: '⊆ 上游；本仓只出货 mac-arm64', ok: targets.length === 1 && targets[0] === 'mac-arm64' })
  if (!(targets.length === 1 && targets[0] === 'mac-arm64')) problems.push('targets 必须收窄为 mac-arm64（design 18 §4.2）')
  const ours = lock.targets?.['mac-arm64']
  const theirs = upstreamLock.targets?.['mac-arm64']
  for (const field of ['nodeArchive', 'nodeSha256', 'pythonTarget', 'pythonSha256']) check('targets.mac-arm64.' + field, ours?.[field], theirs?.[field])
  check('targets.mac-arm64.wheels', ours?.wheels, theirs?.wheels,
    { repo: (ours?.wheels?.length ?? '?') + ' 个', upstream: (theirs?.wheels?.length ?? '?') + ' 个' })
}

// --- pnpm pin：声明单源 + 全部镜像 -----------------------------------------
const rootPkg = jsonOf('package.json')
const packageManager = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager : undefined
const pnpmVersion = packageManager?.startsWith('pnpm@') ? packageManager.slice('pnpm@'.length) : undefined
rows.push({ item: 'pnpm（packageManager 单源）', repo: String(packageManager), upstream: '(单源)', ok: pnpmVersion !== undefined })
if (pnpmVersion === undefined) problems.push('根 package.json 缺 packageManager: pnpm@<x.y.z>')
check('pnpm ↔ desktop dependencies.pnpm', pnpmVersion, jsonOf('packages/desktop/package.json')?.dependencies?.pnpm)
check('pnpm ↔ gateway dependencies.pnpm', pnpmVersion, jsonOf('packages/gateway/package.json')?.dependencies?.pnpm)
const bundleText = (linesOf('packages/desktop/scripts/bundle-dsh.mjs') ?? []).join('\n')
const bundlePnpmMatch = /const BUNDLE_PNPM_VERSION = '([^']+)'/u.exec(bundleText)
check('pnpm ↔ bundle-dsh BUNDLE_PNPM_VERSION', pnpmVersion, bundlePnpmMatch?.[1])
const workflowSites = []
for (const file of readdirSync(join(ROOT, '.github/workflows')).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
  const text = (linesOf('.github/workflows/' + file) ?? []).join('\n')
  for (const match of text.matchAll(/pnpm\/action-setup@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+version:\s*([^\s#]+)/gu)) {
    workflowSites.push({ file, version: match[1] })
  }
}
rows.push({ item: 'pnpm（workflow action-setup 镜像数）', repo: String(workflowSites.length), upstream: '>0', ok: workflowSites.length > 0 })
if (workflowSites.length === 0) problems.push('未找到任何 pnpm/action-setup version 镜像——workflow 解析失配')
for (const site of workflowSites) check('pnpm ↔ ' + site.file, pnpmVersion, site.version)

// --- dsh 运行时线：锁单源 + 六锚 -------------------------------------------
const vendorLockText = (linesOf('packages/desktop/vendor/dsh/pnpm-lock.yaml') ?? []).join('\n')
const runtimeDshMatch = /'@deepseek-ai\/dsh':\s*\n\s+specifier:\s*([^\s]+)/u.exec(vendorLockText)
const runtimeDsh = runtimeDshMatch?.[1]
rows.push({ item: 'dsh 运行时线（vendor lock 单源）', repo: String(runtimeDsh), upstream: '(单源)', ok: runtimeDsh !== undefined })
const fallbackMatch = /function lockfileDshVersion\([\s\S]*?return '([0-9][^']*)'/u.exec(bundleText)
check('dsh ↔ bundle-dsh 兜底常量', runtimeDsh, fallbackMatch?.[1])
const workflowDshMatch = /env:\s*\n\s+DSH_CHAMBER_DSH_VERSION:\s*([^\s#]+)/u.exec((linesOf('.github/workflows/release.yml') ?? []).join('\n'))
check('dsh ↔ release.yml env', runtimeDsh, workflowDshMatch?.[1])
const installerMatch = /DSH_CHAMBER_DSH_VERSION="\$\{DSH_CHAMBER_DSH_VERSION:-([^}]+)\}/u.exec((linesOf('scripts/install-gateway.sh') ?? []).join('\n'))
check('dsh ↔ install-gateway.sh 默认值', runtimeDsh, installerMatch?.[1])
check('dsh ↔ gateway dshAnchorVersion', runtimeDsh, jsonOf('packages/gateway/package.json')?.dshAnchorVersion)
if (existsSync(join(ROOT, 'packages/desktop/vendor/dsh/package.json'))) {
  check('dsh ↔ vendor/dsh/package.json（生成物交叉校验）', runtimeDsh, jsonOf('packages/desktop/vendor/dsh/package.json')?.dependencies?.['@deepseek-ai/dsh'])
}
// dsh 运行时版本 ↔ 上游 pin 树的 @deepseek-ai/dsh 包版本（源码线）。apps/* 扫描兜底
// 路径漂移；只接受 name=@deepseek-ai/dsh 的 manifest。
function upstreamDshManifest() {
  const candidates = ['apps/cli/package.json']
  try {
    for (const name of readdirSync(join(ROOT, 'vendor/harness-checkout', 'apps'))) {
      const rel = 'apps/' + name + '/package.json'
      if (!candidates.includes(rel)) candidates.push(rel)
    }
  } catch {
    // vendor 树缺失已由前面的检查报告；这里保持 null。
  }
  for (const rel of candidates) {
    const pkg = jsonOf('vendor/harness-checkout/' + rel)
    if (pkg?.name === '@deepseek-ai/dsh') return { rel, pkg }
  }
  return null
}
const upstreamDsh = upstreamDshManifest()
if (upstreamDsh === null) {
  problems.push('上游 pin 树找不到 @deepseek-ai/dsh 包（扫描 apps/*）')
}
check('dsh ↔ 上游 pin 树 @deepseek-ai/dsh 包版本', runtimeDsh, upstreamDsh?.pkg?.version)

// --- LibreOffice kit：运行时钟摆 ↔ 上游 pin 根锁 --------------------------
const upstreamLockText = (linesOf('vendor/harness-checkout/pnpm-lock.yaml') ?? []).join('\n')
const kitVersion = (text) => /'@deepseek-ai\/libreoffice-kit@([0-9][^':(]*)/u.exec(text)?.[1]
check('LibreOffice kit ↔ 上游 pin 根锁', kitVersion(vendorLockText), kitVersion(upstreamLockText))
const engineVersions = (text) => [...new Set(
  [...text.matchAll(/'@deepseek-ai\/libreoffice-kit-(?:darwin-arm64|darwin-x64|wasm|win32-arm64|win32-x64)@([0-9][^':(]*)/gu)]
    .map((match) => match[1]),
)].sort().join(',')
check('LibreOffice kit 引擎包版本集', engineVersions(vendorLockText), engineVersions(upstreamLockText))

// --- 输出 -------------------------------------------------------------------
const width = rows.reduce((max, row) => Math.max(max, row.item.length), 0)
for (const row of rows) {
  console.log((row.ok ? 'OK   ' : 'DRIFT') + '  ' + row.item.padEnd(width) + '  repo=' + String(row.repo).padEnd(20) + '  ref=' + row.upstream)
}
if (problems.length > 0) {
  console.error('\npin 对齐检查失败（' + problems.length + ' 项）：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exitCode = 1
} else {
  console.log('\npin 对齐检查通过：' + rows.length + ' 项（source line / payload coords / pnpm mirrors / dsh runtime anchors）')
}
