#!/usr/bin/env node
/**
 * update-vendor.mjs — 原子升级 dsh 源码 pin（submodule 化后的唯一升级入口）。
 *
 * 用法：node scripts/dev/update-vendor.mjs <tag>      # tag 如 dsh-v0.1.1-rc.2
 *
 * 流程（vendor/.vendor-update.lock 目录锁防并发；任一步失败即中止并打印
 * 恢复指引，不产生静默半提交状态）：
 *   1. 校验 tag 命名（dsh-vX.Y.Z / dsh-vX.Y.Z-(alpha|beta|rc).N）；
 *   2. 从上游 fetch 该 tag（浅拉取）——本地已存在指向不同 commit 的 tag 时
 *      git 会拒绝覆盖（"would clobber existing tag"），即防重推闸门；
 *      成功后复核本地解析 commit == 远程 ls-remote 解析；
 *   3. 把 vendor/harness-checkout（submodule）checkout 到该 commit；
 *   4. 更新 harness.commit（声明性 pin，保留注释头）；
 *   5. 以 --allow-lockfile-stale 跑 ensure-harness-vendor.mjs 差量建链
 *      （该模式下锁文件断言已禁用，任何非零退出都是硬错误）；
 *   6. 原子重生成锁文件：pnpm install（非 frozen，env 豁免）→
 *      restore-lockfile-vendor-records.mjs（补 vendor importer 记录）→
 *      pnpm install --frozen-lockfile 验证 → 比较 frozen 前后锁文件哈希
 *      （确认 frozen 未改写）；frozen 失败时提示"新增 vendor 包需按
 *      checklist §4 手工补齐 importer 记录"；
 *   7. 输出待提交清单与回归提示（dsh-upgrade-checklist.md §2/§6）。
 *
 * 提交时 submodule gitlink（vendor/harness-checkout）、harness.commit 与
 * pnpm-lock.yaml 必须同批提交；CI 的 Bootstrap/verify 步骤会强制
 * gitlink == harness.commit。提交 gitlink 前不要运行 `git submodule update`
 * （会把 submodule HEAD 拉回旧 gitlink，导致 ensure 硬失败）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SUBMODULE = join(REPO_ROOT, 'vendor', 'harness-checkout')
const PIN_FILE = join(REPO_ROOT, 'harness.commit')
const LOCKFILE = join(REPO_ROOT, 'pnpm-lock.yaml')
const LOCK_DIR = join(REPO_ROOT, 'vendor', '.vendor-update.lock')
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

const TAG_RE = /^dsh-v\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (result.status !== 0) {
    const detail = result.error
      ? (result.error.code === 'ENOENT' ? `找不到可执行文件 ${cmd}（PATH 缺 node/pnpm？按 checklist §0 先 export PATH）` : result.error.message)
      : (result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`)
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${detail}`)
  }
  return result.stdout.trim()
}

/** 错误即中止：throw 让 finally（释放锁）可靠执行——process.exit 会跳过 finally。 */
function fail(message) {
  throw new Error(message)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main() {
  const tag = process.argv[2]
  if (tag === undefined) fail('缺少 <tag> 参数（如 dsh-v0.1.1-rc.2）')
  if (!TAG_RE.test(tag)) {
    fail(`tag 命名不合法: ${tag}（须为 dsh-vX.Y.Z 或 dsh-vX.Y.Z-(alpha|beta|rc).N；上游真实 tag 含 alpha，如 dsh-v0.1.2-alpha.1）`)
  }

  // 目录锁：vendor/.vendor-update.lock 存在即拒绝（mkdir 原子）
  try {
    mkdirSync(LOCK_DIR)
  } catch (err) {
    if (err.code === 'EEXIST') fail(`已有升级在进行（${LOCK_DIR} 存在）；若上次升级异常中止，请确认无残留后 rm -rf ${LOCK_DIR} 再重试`)
    throw err
  }
  const releaseLock = () => { try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch {} }

  let oldPin = null
  try {
    if (!existsSync(join(SUBMODULE, '.git'))) {
      fail(`submodule 未物化（${SUBMODULE} 缺 .git）— 请先 git submodule update --init`)
    }
    oldPin = readPin()

    // 1. fetch 目标 tag（浅拉取足够：gitlink 只记 commit）。本地已存在指向
    // 不同 commit 的同名 tag 时 git 拒绝覆盖（"would clobber existing tag"）
    // ——这就是防重推闸门（上游重推后本地旧 tag 与新值不同 → loud 失败）。
    console.log(`[update-vendor] fetch ${UPSTREAM_URL} tag ${tag}`)
    try {
      run('git', ['-C', SUBMODULE, 'fetch', '--depth', '1', 'origin', 'tag', tag], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      if (/would clobber existing tag/.test(err.message)) {
        fail(`${tag} 本地已有指向不同 commit 的 tag（上游可能重推过）；人工确认后执行 ` +
          `git -C vendor/harness-checkout fetch origin +refs/tags/${tag} 再重试`)
      }
      throw err
    }

    // 2. 复核本地解析 commit == 远程 ls-remote 解析（belt-and-suspenders）
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

    // 4. 更新 harness.commit（保留注释头，替换首个非空非注释行）。
    // join('\n') 会补行间换行，替换值不带 \n，避免文件尾多出空行。
    const lines = readFileSync(PIN_FILE, 'utf8').split('\n')
    const idx = lines.findIndex((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    if (idx === -1) fail(`${PIN_FILE} 中没有有效的 commit 行`)
    lines[idx] = localCommit
    writeFileSync(PIN_FILE, lines.join('\n'))
    console.log(`[update-vendor] harness.commit -> ${localCommit.slice(0, 12)}`)

    // 5. 差量建链。--allow-lockfile-stale 下锁文件断言已禁用，故任何非零
    // 退出都是硬错误（没有"预期失败"分支）。
    console.log('[update-vendor] 差量重建 vendor 链接（--allow-lockfile-stale）')
    const ensure = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'dev', 'ensure-harness-vendor.mjs'), '--allow-lockfile-stale'], { encoding: 'utf8' })
    console.log(ensure.stdout.trim())
    if (ensure.status !== 0) {
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

    const lockBefore = sha256(LOCKFILE)
    const frozen = spawnSync('pnpm', ['install', '--frozen-lockfile'], { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'inherit' })
    if (frozen.status !== 0) {
      fail('pnpm install --frozen-lockfile 验证失败——锁文件未稳定；若本次升级新增了 vendor 包，' +
        '需按 docs/checklists/dsh-upgrade-checklist.md §4 手工补齐 importer 记录后再重试')
    }
    const lockAfter = sha256(LOCKFILE)
    if (lockBefore !== lockAfter) {
      fail('frozen install 改写了锁文件（哈希变化）——重生成结果不稳定，请人工检查 pnpm-lock.yaml 后重试')
    }
    console.log('[update-vendor] 锁文件稳定（frozen 前后哈希一致）')

    // 7. 输出待提交清单
    console.log('\n[update-vendor] 完成。请同批提交：')
    console.log('  - vendor/harness-checkout（submodule gitlink）')
    console.log('  - harness.commit')
    console.log('  - pnpm-lock.yaml')
    console.log('  - 若上游 workspace 集合变化，vendor/harness-packages/@deepseek-ai 链接会随 ensure 自动对齐')
    console.log('注意：提交 gitlink 前不要运行 `git submodule update`（会把 HEAD 拉回旧 gitlink）；')
    console.log('运行时线同步见 checklist §2（bundle-dsh / release.yml env / install-gateway.sh 常量）。')
    console.log('回归：按 docs/checklists/dsh-upgrade-checklist.md §6 全量测试套件 + typecheck + 构建 + smoke')
  } catch (err) {
    console.error(`✗ update-vendor: ${err.message}`)
    if (oldPin !== null) {
      console.error(`恢复指引：submodule 可能已切到新 commit 而 harness.commit/gitlink 仍为旧 pin；` +
        `可执行 git -C vendor/harness-checkout checkout --detach ${oldPin} 切回后重试`)
    }
    process.exitCode = 1
  } finally {
    releaseLock()
  }
}

/** 读取声明性 pin（与 ensure-harness-vendor.mjs 同规则：首个非空非注释行）。 */
function readPin() {
  if (!existsSync(PIN_FILE)) throw new Error(`缺少固定提交文件 ${PIN_FILE}`)
  const line = readFileSync(PIN_FILE, 'utf8').split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'))
  if (line === undefined) throw new Error(`${PIN_FILE} 中没有有效的 commit 行`)
  return line
}

main()
