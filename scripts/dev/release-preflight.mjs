#!/usr/bin/env node
/**
 * release-preflight.mjs — 发布前机械门禁。
 *
 * 背景：0e3e8d9（v0.2.0-beta.2）在 push 前只跑了「局部验证」（构建/smoke/
 * test:release-workflow/i18n），完整单测在上一 merge 提交跑过后未在 release
 * 提交重跑；且 main 合入的 eb99f24 带进了一个**不存在的** actions/setup-node
 * SHA（1d0a4696…），任何本地检查都没有覆盖 action SHA，CI 的 validation job
 * 在 "Set up job" 阶段直接死掉；release.yml 的 validation job 又在 Desktop
 * unit tests 抓到 preload.cts 的 L3 lockstep 漂移。本脚本把这些机械检查
 * 一次性本地化，任何一项失败即阻断发布。
 *
 * 用法：
 *   node scripts/dev/release-preflight.mjs <version> [--fork-version <v>]
 *       默认 fork 副本基线 0.1.1-rc.2。--fork-version 可覆盖。
 *   node scripts/dev/release-preflight.mjs --actions-only   # CI 模式：只验
 *       证 .github/workflows/*.yml 的 action SHA（网络解析），其余跳过。
 *   node scripts/dev/release-preflight.mjs <version> --versions-only
 *       # release.yml 早期门：动态核对根、全部 packages 与 dsh 常量。
 *   逃生舱：--offline 跳过网络 SHA 解析；--skip-install 跳过
 *       pnpm install --frozen-lockfile（耗时步骤，网络受限/无 store 时）。
 *       两者都会打印 SKIP 提示——发布前建议完整跑一遍。
 *
 * 依赖：仅 node 内置模块 + git/pnpm 二进制；网络仅用于 SHA 解析
 * （api.github.com，HEAD 200 = 存在）。GITHUB_TOKEN 环境变量可提升限流
 * （未认证 60 次/时/IP，本脚本按唯一 SHA 去重，单次运行 ≤ 十几次请求）。
 *
 * 约定：按「release-checklist.md §1.5（建议新增）」承接清单 §1/§2/§4/§5 的
 * 机械项；§3 完整单测不在此执行（见文末 NOTICE——必须在**精确 release
 * 提交**上重跑，参见 AGENTS.md 验证清单）。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseReleaseVersion } from './release-semver.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SELF_PATH = relative(REPO_ROOT, fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flags = { actionsOnly: false, versionsOnly: false, offline: false, skipInstall: false, forkVersion: undefined }
const positional = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--actions-only') flags.actionsOnly = true
  else if (arg === '--versions-only') flags.versionsOnly = true
  else if (arg === '--offline') flags.offline = true
  else if (arg === '--skip-install') flags.skipInstall = true
  else if (arg === '--fork-version') {
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) {
      console.error('✗ --fork-version requires a value')
      process.exit(2)
    }
    flags.forkVersion = next
    i += 1
  } else positional.push(arg)
}

const VERSION = positional[0]
const FORK_VERSION = flags.forkVersion ?? '0.1.1-rc.2'

// ---------------------------------------------------------------------------
// 检查器（fail-fast：任一失败即退出 1，消息指明修复方向）
// ---------------------------------------------------------------------------

function check(name) {
  return { name, passed: false }
}
function fail(c, message) {
  console.error(`✗ ${c.name}: ${message}`)
  process.exit(1)
}
function ok(c, detail) {
  c.passed = true
  console.log(`✓ ${c.name}${detail ? ` — ${detail}` : ''}`)
}
function readJson(relPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'))
}

/** (a) 版本统一：根 + 全部非 fork 包 = 目标版本；@deepseek-ai/* fork 副本 =
 *  FORK_VERSION；install-gateway.sh 的 DSH_CHAMBER_DSH_VERSION 与 release.yml
 *  env 一致（清单 §1 第三条）。数据驱动，新增包自动纳入。 */
function checkVersionUniformity() {
  const c = check('version uniformity (root + packages + installer dsh constant)')
  const mismatches = []
  const root = readJson('package.json')
  if (root.version !== VERSION) mismatches.push(`package.json=${root.version}`)

  let packageCount = 0
  for (const entry of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    packageCount += 1
    const rel = join('packages', entry.name, 'package.json')
    let pkg
    try { pkg = readJson(rel) } catch { continue }
    const isFork = pkg.name?.startsWith('@deepseek-ai/')
    const expected = isFork ? FORK_VERSION : VERSION
    if (pkg.version !== expected) {
      mismatches.push(`${rel}=${pkg.version} (${isFork ? `fork, expected ${FORK_VERSION}` : `expected ${VERSION}`})`)
    }
  }

  const installer = readFileSync(join(REPO_ROOT, 'scripts/install-gateway.sh'), 'utf8')
  const scriptMatch = /DSH_CHAMBER_DSH_VERSION="\$\{DSH_CHAMBER_DSH_VERSION:-([^}]+)\}"/.exec(installer)
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')
  const envMatch = /env:\s*\n\s*DSH_CHAMBER_DSH_VERSION:\s*([^\s]+)/.exec(workflow)
  const scriptVer = scriptMatch?.[1]
  const envVer = envMatch?.[1]
  if (scriptVer === undefined || envVer === undefined) {
    mismatches.push('DSH_CHAMBER_DSH_VERSION 常量在 install-gateway.sh / release.yml 中缺失或格式不符')
  } else if (scriptVer !== envVer) {
    mismatches.push(`install-gateway.sh=${scriptVer} != release.yml env=${envVer}`)
  }

  if (mismatches.length > 0) fail(c, mismatches.join('; '))
  ok(c, `${VERSION} across root+${packageCount} packages; fork copies @ ${FORK_VERSION}; installer dsh constant in sync`)
}

/** (b) changelog：两份 CHANGELOG 均有 `## [<version>]` 节（release.yml 提取
 *  发布正文，缺失即失败），且中英条目数相等、非空。 */
function checkChangelog() {
  const c = check(`changelog sections [${VERSION}] in CHANGELOG.md + docs/CHANGELOG.en-US.md`)
  const files = ['CHANGELOG.md', 'docs/CHANGELOG.en-US.md']
  const counts = {}
  for (const rel of files) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.startsWith(`## [${VERSION}]`))
    if (start === -1) fail(c, `${rel}: no section for [${VERSION}] (release.yml would fail extracting the release body)`)
    let count = 0
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## [')) break
      if (/^- /.test(lines[i])) count += 1
    }
    counts[rel] = count
  }
  if (counts['CHANGELOG.md'] === 0) fail(c, 'CHANGELOG.md section is empty')
  if (counts['docs/CHANGELOG.en-US.md'] !== counts['CHANGELOG.md']) {
    fail(c, `zh/en entry counts differ: CHANGELOG.md=${counts['CHANGELOG.md']}, docs/CHANGELOG.en-US.md=${counts['docs/CHANGELOG.en-US.md']}`)
  }
  ok(c, `zh ${counts['CHANGELOG.md']} entries = en ${counts['docs/CHANGELOG.en-US.md']} entries`)
}

/** (c) i18n：spawn verify-i18n.mjs（无 --write），全部 pair consistent。 */
function checkI18n() {
  const c = check('verify:i18n (5 pairs consistent)')
  const result = spawnSync(process.execPath, ['scripts/dev/verify-i18n.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    fail(c, `verify-i18n failed (exit ${result.status})\n${(result.stderr || result.stdout || '').trim()}`)
  }
  const consistent = (result.stdout || '').split('\n').filter((l) => /consistent/.test(l)).length
  ok(c, `${consistent} pairs consistent`)
}

/** (d) action SHA：.github/workflows/*.yml 每个 uses: 必须 pin 到完整 40 位
 *  SHA；随后对唯一 SHA 发 api.github.com HEAD（200 = 存在；422/404 = 幻影
 *  SHA）。失败历史：release.yml 曾带 1d0a4696…（不存在）→ CI 死在 Set up job。 */
export function parseActionPins(workflowText) {
  const pins = []
  // `uses:` 在 YAML 步骤里两种形态都存在：`- uses: owner/repo@sha` 与
  // `id: x` / `name: x` 步骤下的裸 `uses: owner/repo@sha` 键。
  const re = /^\s*(?:-\s*)?uses:\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([^\s#]+)/gm
  let m
  while ((m = re.exec(workflowText)) !== null) pins.push({ owner: m[1], repo: m[2], ref: m[3] })
  return pins
}

export function actionPinsFromWorkflowDir(repoRoot = REPO_ROOT) {
  const pins = []
  for (const file of readdirSync(join(repoRoot, '.github/workflows')).filter((f) => f.endsWith('.yml'))) {
    const text = readFileSync(join(repoRoot, '.github/workflows', file), 'utf8')
    for (const pin of parseActionPins(text)) pins.push({ ...pin, file })
  }
  return pins
}

export async function verifyActionShas(pins, { token } = {}) {
  const seen = new Map()
  for (const pin of pins) {
    const key = `${pin.owner}/${pin.repo}@${pin.ref}`
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(pin)
  }
  const results = []
  for (const [key, occurrences] of seen) {
    const slash = key.indexOf('/')
    const at = key.indexOf('@')
    const owner = key.slice(0, slash)
    const repo = key.slice(slash + 1, at)
    const sha = key.slice(at + 1)
    const headers = {
      'User-Agent': 'dsh-chamber-release-preflight',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    let response
    try {
      response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, {
        method: 'HEAD',
        headers,
      })
      if (response.status === 405) {
        // HEAD 不被端点支持时退回 GET（仅读取状态码，丢弃 body）。
        response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, {
          method: 'GET',
          headers,
        })
        await response.arrayBuffer().catch(() => {})
      }
    } catch (error) {
      results.push({ owner, repo, sha, ok: false, status: 'network-error', message: error.message, occurrences })
      continue
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      results.push({ owner, repo, sha, ok: false, status: 403, message: 'GitHub API rate limit exhausted — set GITHUB_TOKEN or wait (60 req/hr unauthenticated per IP)', occurrences })
      continue
    }
    const status = response.status
    results.push({
      owner,
      repo,
      sha,
      ok: status === 200,
      status,
      message: status === 200 ? undefined : status === 422 || status === 404 ? 'no such commit — phantom/typo SHA (check the "# vX.Y.Z" comment)' : `unexpected status ${status}`,
      occurrences,
    })
  }
  return results
}

/** 语法 + 网络解析合一（await 后 fail-fast）。 */
async function checkActionShas(pins = actionPinsFromWorkflowDir()) {
  const c = check('action SHA pins resolve upstream (network)')
  const unpinned = pins.filter((p) => !/^[0-9a-f]{40}$/i.test(p.ref))
  if (unpinned.length > 0) {
    fail(c, `unpinned action refs (must be full 40-hex commit SHAs): ${unpinned.map((p) => `${p.owner}/${p.repo}@${p.ref} (${p.file})`).join(', ')}`)
  }
  const results = await verifyActionShas(pins, { token: process.env.GITHUB_TOKEN })
  const bad = results.filter((r) => !r.ok)
  if (bad.length > 0) {
    for (const b of bad) {
      console.error(`✗ ${b.owner}/${b.repo}@${b.sha} (${b.occurrences.map((o) => o.file).join(', ')}): ${b.message ?? `status ${b.status}`}`)
    }
    fail(c, `${bad.length} of ${results.length} unique action SHA(s) do not resolve`)
  }
  ok(c, `${pins.length} pins / ${results.length} unique SHAs resolve to real commits`)
}

// ---------------------------------------------------------------------------
// 工作区 / 仓库级检查
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'release', '.cache', '.dev-user-data', '.pnpm-store', '.turbo'])

/** (e) 冲突标记：packages/ docs/ scripts/ 中行首 `<<<<<<< ` / `>>>>>>> `
 *  （真实 merge 冲突签名；行内文本如清单里的字面模式不算）。跳过二进制与
 *  生成/依赖目录。 */
function checkConflictMarkers() {
  const c = check('no merge-conflict markers in packages/ docs/ scripts/')
  const hits = []
  const TEXT_EXT = new Set(['.ts', '.cts', '.mts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.sh', '.yml', '.yaml', '.css', '.html', '.vue'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && TEXT_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        const buf = readFileSync(full)
        if (buf.includes(0)) continue // binary
        const text = buf.toString('utf8')
        if (/^(<<<<<<< |>>>>>>> )/m.test(text)) hits.push(relative(REPO_ROOT, full))
      }
    }
  }
  walk(join(REPO_ROOT, 'packages'))
  walk(join(REPO_ROOT, 'docs'))
  walk(join(REPO_ROOT, 'scripts'))
  if (hits.length > 0) fail(c, hits.join(', '))
  ok(c, 'clean')
}

/** (f) git 工作区健康：无已修改/未跟踪（排除本脚本自身路径），stash 为空。 */
function checkGitStatus() {
  const c = check('git status clean + no untracked + empty stash')
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean)
  const dirty = porcelain.filter((l) => {
    const path = l.slice(3).trim()
    if (path === SELF_PATH) return false
    // vendor/harness-checkout 是 git submodule：其内部未跟踪内容（ensure
    // 建的 node_modules 解析 shim）是预期产物、不影响 gitlink。只有
    // gitlink/HEAD 漂移（git diff --submodule 有输出）才算 dirty。
    if (path === 'vendor/harness-checkout') {
      try {
        return execFileSync('git', ['diff', '--submodule=short', '--', 'vendor/harness-checkout'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== ''
      } catch {
        return true // diff 判定失败时保守视为 dirty
      }
    }
    return true
  })
  if (dirty.length > 0) fail(c, `uncommitted/untracked changes:\n${dirty.map((l) => `    ${l}`).join('\n')}`)
  const stash = execFileSync('git', ['stash', 'list'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  if (stash.length > 0) fail(c, `non-empty git stash:\n${stash}`)
  ok(c, 'working tree clean')
}

/** (g) 锁文件一致：pnpm install --frozen-lockfile（清单 §4；含 vendor importer
 *  记录——pnpm 11 重新生成锁文件会裁剪它们，frozen 校验即捕获）。 */
function checkFrozenInstall() {
  const c = check('pnpm install --frozen-lockfile')
  if (flags.skipInstall) {
    console.log(`SKIP ${c.name} — --skip-install given (run it before push!)`)
    return
  }
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 15 * 60 * 1000 })
  if (result.status !== 0) {
    fail(c, `pnpm install --frozen-lockfile exited ${result.status}${result.error ? ` (${result.error.message})` : ''}`)
  }
  ok(c, 'lockfile in sync')
}

/** (h) 发布工作流策略测试：test:release-workflow（静态策略；CI 同步跑）。 */
function checkReleaseWorkflow() {
  const c = check('pnpm run test:release-workflow')
  const result = spawnSync('pnpm', ['run', 'test:release-workflow'], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 5 * 60 * 1000 })
  if (result.status !== 0) {
    fail(c, `test:release-workflow exited ${result.status}${result.error ? ` (${result.error.message})` : ''}`)
  }
  ok(c, 'release workflow policy holds')
}

/** (i) NOTICE：完整单测必须在**精确 release 提交**上重跑——上一轮在 eb7c22a
 *  跑绿不等于 0e3e8d9 绿（preload.cts 合并解析丢声明 → L3 lockstep 在 CI 才爆）。 */
function printFullBatteryNotice() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  console.log(`
────────────────────────────────────────────────────────────────
⚠ NOTICE — run the FULL unit battery (§3 of release-checklist.md)
  on the EXACT release commit (current HEAD: ${head}), not on the
  merge commit it was green on (v0.2.0-beta.2 regression: the battery
  ran on eb7c22a; preload.cts changed before 0e3e8d9 → the L3
  ipc-surface-mirror lockstep test broke and only CI caught it).

  node packages/control-plane/test/protocol.ts
  node packages/control-plane/test/storage.ts
  node packages/control-plane/test/m1-dsh-client.ts
  node packages/control-plane/test/host-logs.ts
  node packages/control-plane/test/manager-api.ts
  node packages/control-plane/test/local-connection.ts
  node packages/control-plane/test/spawn-dsh.ts
  node packages/control-plane/test/instance-proxy.ts
  node packages/control-plane/test/gateway-transport.test.ts
  node packages/control-plane/test/ws-frames.ts
  node packages/control-plane/test/static-serving.ts
  node packages/control-plane/test/host-graph-seed.ts
  node packages/control-plane/test/restart-local.ts
  pnpm run test:runtime && pnpm run test:gateway && pnpm run test:desktop
  pnpm run test:renderer-shell && pnpm run test:git && pnpm run test:host-git
  pnpm run test:sidebar && pnpm run test:settings-bridge
  pnpm run test:connections && pnpm run test:client-web
  pnpm run test:connection && pnpm run test:cli
  pnpm run typecheck && pnpm run typecheck:runtime
  pnpm run typecheck:sidebar && pnpm run typecheck:layout
  pnpm run typecheck:connections && pnpm run typecheck:settings-bridge
  pnpm run typecheck:git && pnpm run typecheck:open-in
  pnpm run typecheck:client-web && pnpm run typecheck:host-graph
  pnpm run typecheck:host-git && pnpm run typecheck:gateway
────────────────────────────────────────────────────────────────`)
}

// ---------------------------------------------------------------------------
// 入口（ESM 顶层 await；网络检查必须真正等完再进入下一项）。仅当本文件作为
// 主入口运行时执行 CLI——作为模块被 import（如 release-workflow-policy.test.mjs
// 的 CI SHA 校验）时只导出函数，不触发任何检查。
// ---------------------------------------------------------------------------

const IS_MAIN = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

async function runPreflight() {
  console.log(`release preflight for ${VERSION} (fork baseline ${FORK_VERSION}) — ${new Date().toISOString()}\n`)
  try {
    parseReleaseVersion(VERSION) // 复用 release.yml 的 stable | canonical beta.N 门
  } catch (error) {
    console.error(`✗ version: ${error.message}`)
    process.exit(1)
  }
  const ran = []
  checkVersionUniformity(); ran.push('version uniformity')
  checkChangelog(); ran.push('changelog')
  checkI18n(); ran.push('i18n')
  if (flags.offline) {
    console.log('SKIP action SHA pin resolution — --offline given (run online before release!)')
  } else {
    await checkActionShas()
  }
  ran.push('action SHAs')
  checkConflictMarkers(); ran.push('conflict markers')
  checkGitStatus(); ran.push('git status')
  checkFrozenInstall(); ran.push('frozen install')
  checkReleaseWorkflow(); ran.push('release workflow')
  printFullBatteryNotice()
  console.log(`\n✓ release preflight passed: ${ran.join(' → ')}. Gate open for the §3 full battery, then §7 commit/tag/push.`)
}

async function runActionShaOnly() {
  if (flags.offline) {
    console.log('SKIP action SHA pin resolution — --offline given (CI must not skip)')
    process.exit(0)
  }
  const pins = actionPinsFromWorkflowDir()
  console.log(`action SHA preflight for .github/workflows/*.yml (${pins.length} pins) — ${new Date().toISOString()}\n`)
  await checkActionShas(pins)
  console.log('\n✓ action SHA preflight passed — safe to run the release workflow.')
}

function runVersionsOnly() {
  console.log(`release version preflight for ${VERSION} (fork baseline ${FORK_VERSION})\n`)
  try {
    parseReleaseVersion(VERSION)
  } catch (error) {
    console.error(`✗ version: ${error.message}`)
    process.exit(1)
  }
  checkVersionUniformity()
}

if (IS_MAIN) {
  if (flags.actionsOnly) {
    await runActionShaOnly()
  } else if (flags.versionsOnly) {
    if (VERSION === undefined) {
      console.error('usage: node scripts/dev/release-preflight.mjs <version> --versions-only')
      process.exit(2)
    }
    runVersionsOnly()
  } else {
    if (VERSION === undefined) {
      console.error('usage: node scripts/dev/release-preflight.mjs <version> [--fork-version <v>] [--offline] [--skip-install]')
      console.error('       node scripts/dev/release-preflight.mjs <version> --versions-only')
      console.error('       node scripts/dev/release-preflight.mjs --actions-only')
      process.exit(2)
    }
    await runPreflight()
  }
}
