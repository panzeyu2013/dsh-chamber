#!/usr/bin/env node
/**
 * update-vendor.mjs — 原子升级 dsh 源码 pin（submodule 化后的唯一升级入口）。
 *
 * 用法：node scripts/update-vendor.mjs <tag>      # tag 如 dsh-v0.1.1-rc.2
 *
 * 流程（任一步失败即中止，不产生半提交状态；vendor/.vendor-update.lock
 * 目录锁防并发）：
 *   1. 校验 tag 命名（dsh-vX.Y.Z / dsh-vX.Y.Z-rc.N）；
 *   2. 从上游 fetch 该 tag（浅拉取），并校验本地解析的 commit == 远程
 *      ls-remote 解析（防上游 tag 重推）；
 *   3. 把 vendor/harness-checkout（submodule）checkout 到该 commit；
 *   4. 更新 harness.commit（声明性 pin，保留注释头）；
 *   5. 以 --allow-lockfile-stale 跑 ensure-harness-vendor.mjs 差量建链
 *      （锁文件此时必然滞后——这正是重生成信号）；
 *   6. 原子重生成锁文件：pnpm install（非 frozen）→
 *      restore-lockfile-vendor-records.mjs（补 vendor importer 记录）→
 *      pnpm install --frozen-lockfile 验证 → git diff --exit-code 确认稳定；
 *   7. 输出待提交清单与回归提示（dsh-upgrade-checklist.md §6 炮组）。
 *
 * 提交时 submodule gitlink（vendor/harness-checkout）、harness.commit 与
 * pnpm-lock.yaml 必须同批提交；CI 的 Bootstrap/verify 步骤会强制
 * gitlink == harness.commit。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SUBMODULE = join(REPO_ROOT, 'vendor', 'harness-checkout')
const PIN_FILE = join(REPO_ROOT, 'harness.commit')
const LOCK_DIR = join(REPO_ROOT, 'vendor', '.vendor-update.lock')
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

const TAG_RE = /^dsh-v\d+\.\d+\.\d+(-rc\.\d+)?$/

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`)
  }
  return result.stdout.trim()
}

function fail(message) {
  console.error(`✗ update-vendor: ${message}`)
  process.exit(1)
}

function main() {
  const tag = process.argv[2]
  if (tag === undefined) fail('缺少 <tag> 参数（如 dsh-v0.1.1-rc.2）')
  if (!TAG_RE.test(tag)) fail(`tag 命名不合法: ${tag}（须为 dsh-vX.Y.Z 或 dsh-vX.Y.Z-rc.N）`)

  // 目录锁：vendor/.vendor-update.lock 存在即拒绝（mkdir 原子）
  try {
    mkdirSync(LOCK_DIR)
  } catch (err) {
    if (err.code === 'EEXIST') fail(`已有升级在进行（${LOCK_DIR} 存在）；完成后重试`)
    throw err
  }
  const releaseLock = () => { try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch {} }

  try {
    if (!existsSync(join(SUBMODULE, '.git'))) {
      fail(`submodule 未物化（${SUBMODULE} 缺 .git）— 请先 git submodule update --init`)
    }

    // 1. fetch 目标 tag（浅拉取足够：gitlink 只记 commit）
    console.log(`[update-vendor] fetch ${UPSTREAM_URL} tag ${tag}`)
    run('git', ['-C', SUBMODULE, 'fetch', '--depth', '1', 'origin', 'tag', tag], { stdio: ['ignore', 'pipe', 'pipe'] })

    // 2. 校验本地解析 commit == 远程 ls-remote 解析（防上游 tag 重推）
    const localCommit = run('git', ['-C', SUBMODULE, 'rev-parse', `${tag}^{commit}`])
    let remotePeeled = null
    let remoteRaw = null
    for (const line of run('git', ['ls-remote', UPSTREAM_URL, `refs/tags/${tag}`], { stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')) {
      if (line.trim() === '') continue
      const [sha, ref] = line.trim().split(/\s+/)
      if (ref.endsWith('^{}')) remotePeeled = sha
      else remoteRaw = sha
    }
    if (remotePeeled === null && remoteRaw === null) fail(`远程不存在 tag ${tag}`)
    const remoteCommit = remotePeeled ?? remoteRaw
    if (localCommit !== remoteCommit) {
      fail(`tag ${tag} 远程解析 ${remoteCommit.slice(0, 12)} != 本地 fetch ${localCommit.slice(0, 12)} — 上游 tag 疑似被重推，人工确认`)
    }
    console.log(`[update-vendor] tag ${tag} -> commit ${localCommit.slice(0, 12)}（远程一致）`)

    // 3. checkout submodule 到该 commit（detached）
    run('git', ['-C', SUBMODULE, 'checkout', '--detach', localCommit])

    // 4. 更新 harness.commit（保留注释头，替换 commit 行）
    const lines = readFileSync(PIN_FILE, 'utf8').split('\n')
    const idx = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('#'))
    if (idx === -1) fail(`${PIN_FILE} 中没有有效的 commit 行`)
    lines[idx] = `${localCommit}\n`
    writeFileSync(PIN_FILE, lines.join('\n'))
    console.log(`[update-vendor] harness.commit -> ${localCommit.slice(0, 12)}`)

    // 5. 差量建链（豁免锁文件断言：重生成前的预期滞后）
    console.log('[update-vendor] 差量重建 vendor 链接（--allow-lockfile-stale）')
    const ensure = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'dev', 'ensure-harness-vendor.mjs'), '--allow-lockfile-stale'], { encoding: 'utf8' })
    console.log(ensure.stdout.trim())
    if (ensure.stderr?.trim()) console.error(ensure.stderr.trim())
    if (ensure.status !== 0 && !/锁文件|importer 集合不一致/.test(ensure.stderr || '')) {
      // 断言失败是预期（锁文件滞后）；其他失败（pin/链接）是硬错误
      fail(`ensure-harness-vendor 失败: ${ensure.stderr?.trim() || `exit ${ensure.status}`}`)
    }

    // 6. 原子重生成锁文件
    // preinstall 里的 ensure 断言无法传参，用环境变量豁免（仅此流程设置；
    // 日常开发/CI 不设——CI 靠显式 Bootstrap + 漂移断言兜底）。
    console.log('[update-vendor] 重生成锁文件（pnpm install 非 frozen）')
    const install = spawnSync('pnpm', ['install'], { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, DSH_CHAMBER_VENDOR_ALLOW_STALE_LOCKFILE: '1' } })
    if (install.status !== 0) fail('pnpm install（非 frozen）失败——中止，锁文件未提交')
    console.log('[update-vendor] 补回 vendor importer 记录')
    const restore = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'dev', 'restore-lockfile-vendor-records.mjs')], { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'inherit' })
    if (restore.status !== 0) fail('restore-lockfile-vendor-records 失败')
    const frozen = spawnSync('pnpm', ['install', '--frozen-lockfile'], { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'inherit' })
    if (frozen.status !== 0) fail('pnpm install --frozen-lockfile 验证失败——锁文件未稳定')

    // 7. 输出待提交清单
    console.log('\n[update-vendor] 完成。请同批提交：')
    console.log('  - vendor/harness-checkout（submodule gitlink）')
    console.log('  - harness.commit')
    console.log('  - pnpm-lock.yaml')
    console.log('  - 若上游 workspace 集合变化，vendor/harness-packages/@deepseek-ai 链接会随 ensure 自动对齐')
    console.log('回归：按 docs/checklists/dsh-upgrade-checklist.md §6 全量炮组 + typecheck + 构建 + smoke')
  } catch (err) {
    console.error(`✗ update-vendor: ${err.message}`)
    process.exitCode = 1
  } finally {
    releaseLock()
  }
}

main()
