/**
 * verify-artifact-freshness.mjs —— 已提交/打包产物的「陈旧即红」守卫
 * （design 21 §7 G2–G8 的 2026-12 遗留四项）。
 *
 * 为什么需要：这四类产物都不是 C8（host dist / dsh-runtime dist / mobile
 * dist+lib）的覆盖对象，也没有各自的 freshness 测试，因此「改了 src 没重建
 * 产物」可以一路绿到用户手里：
 *   1. packages/gateway/host-packages/<name>/ —— build:gateway 拷贝进发布包的
 *      mobile 插件（dist/index.js + lib/* 直接决定 /plugins 能否挂载）；
 *   2. packages/dsh-chamber-seed-<name>/dist/index.js —— 已提交的 esbuild 产物，
 *      控制面 seed 进受管 profile 的就是它；
 *   3. packages/desktop/dist/preload.cjs —— tsc 编译产物，成员面由
 *      preload.cts 决定（G4 只比成员数，不比内容）；
 *   4. packages/renderer/src/generated/typert/<remote>/ —— gen-typert-remotes 的
 *      生成产物，remote 装配契约（C4）读的就是它。
 *
 * 语义（与 control-plane-freshness / build-smoke 同款豁免）：
 *   - 输入缺失（clean checkout、未 build 的环境）⇒ **loud SKIP**，不判红；
 *   - 产物缺失 ⇒ SKIP（源在而产物不在 = 未构建，不是陈旧）；
 *   - 产物在但与「从当前 src 重建/重算」的结果不一致 ⇒ **FAIL（陈旧）**，
 *     绝不自动修复（自动重建会让操作者以为产物被检查过——2026-12 review 的
 *     教训，见 build-smoke.test.ts:110-134）。
 * 退出码：0 无陈旧 / 1 有陈旧 / 2 用法错误。
 *   --self-test  负控：证明比对能抓到人为差异（仪表必须能失败）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEsbuild } from '../lib/esbuild.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
const note = (id, status, detail = '') => results.push({ id, status, detail })

const sameBytes = (a, b) => {
  try { return readFileSync(a).equals(readFileSync(b)) } catch { return false }
}

/** 1. gateway/host-packages 逐文件字节比对（拷贝，不重建）。 */
function checkHostPackages() {
  const copies = [{
    name: 'dsh-chamber-client-ui-mobile',
    files: ['package.json', 'dist/index.js', 'lib/index.js', 'lib/client.js', 'lib/client.js.map'],
  }]
  const stale = []
  let compared = 0
  for (const copy of copies) {
    const outDir = join(ROOT, 'packages', 'gateway', 'host-packages', copy.name)
    const srcDir = join(ROOT, 'packages', copy.name)
    if (!existsSync(outDir) || !existsSync(srcDir)) continue
    for (const file of copy.files) {
      const out = join(outDir, file)
      const src = join(srcDir, file)
      if (!existsSync(src)) continue
      if (!existsSync(out)) { stale.push(copy.name + '/' + file + ' (missing)'); continue }
      compared += 1
      if (!sameBytes(src, out)) stale.push(copy.name + '/' + file)
    }
  }
  if (compared === 0) note('gateway/host-packages', 'skip', '未构建或未安装（无产物可查）')
  else if (stale.length > 0) note('gateway/host-packages', 'stale', '与源不一致：' + stale.join(', ') + '（重建：pnpm run build:gateway）')
  else note('gateway/host-packages', 'ok', compared + ' 文件与源逐字节一致')
}

/** 2. seed dist：按各自 build.mjs 的同一组 esbuild 选项重建到临时文件再比对。 */
async function checkSeedDist() {
  const seeds = ['dsh-chamber-seed-client-graph', 'dsh-chamber-seed-git-worktree', 'dsh-chamber-seed-archive-cleanup', 'dsh-chamber-seed-open-in']
  let compared = 0
  const stale = []
  const work = mkdtempSync(join(tmpdir(), 'dsh-seed-fresh-'))
  try {
    const esbuild = await loadEsbuild(ROOT)
    for (const seed of seeds) {
      const pkgDir = join(ROOT, 'packages', seed)
      const dist = join(pkgDir, 'dist', 'index.js')
      if (!existsSync(dist) || !existsSync(join(pkgDir, 'src', 'index.ts'))) continue
      const out = join(work, seed + '.js')
      await esbuild.build({
        entryPoints: [join(pkgDir, 'src', 'index.ts')],
        absWorkingDir: pkgDir,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile: out,
        external: ['@deepseek-ai/*'],
        logLevel: 'silent',
      })
      compared += 1
      if (!sameBytes(out, dist)) stale.push(seed + '/dist/index.js')
    }
  } catch (error) {
    const detail = String(error.message ?? error).split('\n')[0]
    note('seed dist', 'skip', '无法重建（' + detail + '）——先 pnpm install / 物化 vendor 树')
    return
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (compared === 0) note('seed dist', 'skip', '未构建（无 dist/index.js）')
  else if (stale.length > 0) note('seed dist', 'stale', '与 src 重建结果不一致：' + stale.join(', ') + '（重建：各包 scripts/build.mjs）')
  else note('seed dist', 'ok', compared + ' 包与 src 重建逐字节一致')
}

/** 3. preload.cjs：tsc -p tsconfig.preload.build.json --outDir <tmp> 后比对。 */
function checkPreload() {
  const dist = join(ROOT, 'packages', 'desktop', 'dist', 'preload.cjs')
  if (!existsSync(dist)) { note('desktop/preload.cjs', 'skip', '未构建（无 dist/preload.cjs）'); return }
  const work = mkdtempSync(join(tmpdir(), 'dsh-preload-fresh-'))
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.preload.build.json', '--outDir', work], { cwd: join(ROOT, 'packages', 'desktop'), stdio: 'pipe' })
    const emitted = join(work, 'preload.cjs')
    if (!existsSync(emitted)) { note('desktop/preload.cjs', 'skip', 'tsc 未产出 preload.cjs（配置变了？）'); return }
    if (!sameBytes(emitted, dist)) note('desktop/preload.cjs', 'stale', '与 preload.cts 的编译结果不一致（重建：pnpm --filter @dsh-chamber/desktop run build:preload）')
    else note('desktop/preload.cjs', 'ok', '与 preload.cts 编译结果逐字节一致')
  } catch (error) {
    note('desktop/preload.cjs', 'skip', 'tsc 不可用：' + String(error.message ?? error).split('\n')[0])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 4. renderer/src/generated：快照 → 重跑生成器 → 比对 → 还原（C8 同款纪律）。 */
function checkGenerated() {
  const tree = join(ROOT, 'packages', 'renderer', 'src', 'generated')
  const backup = tree + '.freshness-backup'
  if (!existsSync(tree)) { note('renderer/src/generated', 'skip', '未生成（无 src/generated）'); return }
  try {
    rmSync(backup, { recursive: true, force: true })
    cpSync(tree, backup, { recursive: true })
    execFileSync(process.execPath, [join(ROOT, 'packages', 'renderer', 'scripts', 'gen-typert-remotes.mjs')], { cwd: ROOT, stdio: 'pipe' })
    const walk = (dir, out = []) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full, out)
        else out.push(relative(tree, full))
      }
      return out
    }
    const now = walk(tree).sort()
    const before = walk(backup).sort()
    const changed = []
    for (const file of new Set([...now, ...before])) {
      if (!sameBytes(join(tree, file), join(backup, file))) changed.push(file)
    }
    if (changed.length > 0) note('renderer/src/generated', 'stale', '重跑生成器后不一致：' + changed.slice(0, 5).join(', ') + '（重建：pnpm run build:renderer）')
    else note('renderer/src/generated', 'ok', before.length + ' 个生成文件与重跑结果一致')
  } catch (error) {
    note('renderer/src/generated', 'skip', '无法重跑 gen-typert-remotes：' + String(error.message ?? error).split('\n')[0])
  } finally {
    if (existsSync(backup)) { rmSync(tree, { recursive: true, force: true }); cpSync(backup, tree, { recursive: true }); rmSync(backup, { recursive: true, force: true }) }
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const a = join(tmpdir(), 'dsh-fresh-a-' + process.pid)
    const b = join(tmpdir(), 'dsh-fresh-b-' + process.pid)
    cpSync(join(ROOT, 'package.json'), a)
    cpSync(join(ROOT, 'package.json'), b)
    const identical = sameBytes(a, b)
    execFileSync(process.execPath, ['-e', 'require("node:fs").appendFileSync(process.argv[1], String.fromCharCode(10))', b])
    const detected = !sameBytes(a, b)
    rmSync(a, { force: true }); rmSync(b, { force: true })
    console.log('artifact-freshness self-test: ' + (identical && detected ? 'ok（同内容=一致，追加一字节=陈旧）' : 'FAIL'))
    process.exit(identical && detected ? 0 : 1)
  }
  await checkSeedDist()
  checkHostPackages()
  checkPreload()
  checkGenerated()
  let stale = 0
  for (const result of results) {
    const tag = result.status === 'ok' ? 'OK   ' : result.status === 'skip' ? 'SKIP ' : 'STALE'
    console.log('  ' + tag + ' ' + result.id + (result.detail ? ' — ' + result.detail : ''))
    if (result.status === 'stale') stale += 1
  }
  const skipped = results.filter(r => r.status === 'skip').length
  if (stale > 0) {
    console.error('artifact freshness: ' + stale + ' 类产物陈旧（SKIP ' + skipped + ' 类未构建，不计通过）')
    process.exit(1)
  }
  console.log('artifact freshness: 全部已构建产物与当前 src 一致（SKIP ' + skipped + ' 类未构建）')
}

await main()
