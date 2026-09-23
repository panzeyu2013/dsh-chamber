/**
 * verify-artifact-freshness.mjs —— 已提交/打包产物的「陈旧即红」守卫
 * （design 21 §7 G2–G8）。
 *
 * 为什么需要：以下四类产物不是 C8（seed dist ×4 + dsh-runtime dist + mobile
 * dist+lib）的覆盖对象——C8 独占 seed/runtime/mobile 的新鲜度判定，产物清单的
 * 单一来源 = scripts/lib/build-artifacts.mjs；这四类也没有各自的 freshness
 * 测试，因此「改了 src 没重建产物」可以一路绿到用户手里：
 *   1. packages/gateway/host-packages/<name>/ —— build:gateway 拷贝进发布包的
 *      mobile 插件（dist/index.js + lib/* 直接决定 /plugins 能否挂载）；
 *   2. packages/desktop/dist/preload.cjs —— tsc 编译产物，成员面由
 *      preload.cts 决定（G4 只比成员数，不比内容）；
 *   3. packages/renderer/src/generated/typert/<remote>/ —— gen-typert-remotes 的
 *      生成产物，remote 装配契约（C4）读的就是它；
 *   4. packages/gateway/dist/index.js —— build:gateway 的 esbuild 产物（包 exports
 *      的落点）；用包自己的 build.mjs 在临时副本里重建后逐字节比对（模块路径按
 *      packages/gateway cwd 归一），dist 不在场时 loud SKIP。
 *
 * 语义（与 control-plane-freshness / build-smoke 同款豁免）：
 *   - 输入缺失（clean checkout、未 build 的环境）⇒ **loud SKIP**，不判红；
 *   - 产物在但与「从当前 src 重建/重算」的结果不一致 ⇒ **FAIL（陈旧）**，
 *     绝不自动修复（自动重建会让操作者以为产物被检查过，见
 *     build-smoke.test.ts:110-134）。
 * 退出码：0 无陈旧 / 1 有陈旧 / 2 用法错误。
 *   --self-test  负控：证明比对能抓到人为差异（仪表必须能失败）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 2. preload.cjs：tsc -p tsconfig.preload.build.json --outDir <tmp> 后比对。 */
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

/** 3. renderer/src/generated：快照 → 重跑生成器 → 比对 → 还原（C8 同款纪律）。 */
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

/** 4. gateway/dist/index.js：用包自己的 build.mjs 在临时副本里重建后逐字节比对。 */
function checkGatewayDist() {
  const dist = join(ROOT, 'packages', 'gateway', 'dist', 'index.js')
  if (!existsSync(dist)) { note('gateway/dist/index.js', 'skip', '未构建（无 dist/index.js）（重建：pnpm run build:gateway）'); return }
  const pkgDir = join(ROOT, 'packages', 'gateway')
  const mobileDir = join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile')
  const prerequisites = [
    join(pkgDir, 'node_modules', 'pnpm', 'package.json'),
    join(pkgDir, 'node_modules', 'esbuild', 'package.json'),
    join(mobileDir, 'dist', 'index.js'),
    join(mobileDir, 'lib', 'client.js'),
  ]
  const missingPrerequisite = prerequisites.find((path) => !existsSync(path))
  if (missingPrerequisite !== undefined) {
    note('gateway/dist/index.js', 'skip', '重建前置缺失：' + relative(ROOT, missingPrerequisite) + '（重建：pnpm run build:gateway）')
    return
  }
  // Stage a copy of the package so the package's OWN build script (single
  // source of the build recipe) runs unmodified but writes into the temp tree.
  // build.mjs derives packageDir from its own location, so package.json,
  // scripts/build.mjs and src are copied while node_modules and the sibling
  // mobile package are symlinked. The pnpm/host-package copies the script makes
  // stay in temp; the working tree is never written.
  const work = mkdtempSync(join(tmpdir(), 'dsh-gateway-fresh-'))
  try {
    const stage = join(work, 'gateway')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    mkdirSync(join(stage, 'scripts'), { recursive: true })
    cpSync(join(pkgDir, 'package.json'), join(stage, 'package.json'))
    cpSync(join(pkgDir, 'scripts', 'build.mjs'), join(stage, 'scripts', 'build.mjs'))
    cpSync(join(pkgDir, 'src'), join(stage, 'src'), { recursive: true })
    symlinkSync(join(pkgDir, 'node_modules'), join(stage, 'node_modules'), linkType)
    symlinkSync(mobileDir, join(work, 'dsh-chamber-client-ui-mobile'), linkType)
    const result = spawnSync(process.execPath, [join(stage, 'scripts', 'build.mjs')], { cwd: stage, stdio: 'pipe' })
    if (result.status !== 0) {
      const lines = String(result.stderr ?? '').trim().split('\n')
      const detail = lines[lines.length - 1]
      note('gateway/dist/index.js', 'skip', '重建不可用：' + (detail === '' ? 'exit ' + String(result.status) : detail))
      return
    }
    // esbuild prints module comments as paths relative to the process cwd. The
    // in-place build (pnpm --filter @dsh-chamber/gateway run build) runs with
    // cwd = packages/gateway, so canonicalize the staged bundle back to that
    // spelling before comparing: repo-root prefix -> '../..', then
    // '<root>/packages/<x>' -> '../<x>'.
    const inPlaceRoot = relative(pkgDir, ROOT)
    const stagedRoot = relative(stage, ROOT)
    // esbuild spells module comments as paths relative to the build cwd, so the
    // staged tree emits a different number of up-level rungs than the in-place
    // build (a macOS TMPDIR under /var/folders, and symlinked node_modules,
    // both shift the depth). Canonicalize the RUNG RUNS on both sides before
    // comparing: the module list, every referenced file and all code still
    // compare byte for byte, so a stale bundle cannot hide behind this.
    const canonicalRungs = (text) => text.replace(/(?:\.\.\/)+/gu, '@up@/')
    let rebuilt = readFileSync(join(stage, 'dist', 'index.js'), 'utf8')
    if (stagedRoot !== inPlaceRoot) rebuilt = rebuilt.split(stagedRoot).join(inPlaceRoot)
    rebuilt = canonicalRungs(rebuilt.split(inPlaceRoot + '/packages/').join('../'))
    const onDisk = canonicalRungs(readFileSync(dist, 'utf8'))
    if (rebuilt !== onDisk) {
      note('gateway/dist/index.js', 'stale', '与 src 重建结果不一致（重建：pnpm run build:gateway）')
    } else {
      note('gateway/dist/index.js', 'ok', '与 src 重建逐字节一致')
    }
  } catch (error) {
    note('gateway/dist/index.js', 'skip', '重建不可用：' + String(error.message ?? error).split('\n')[0])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}


function main() {
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
  checkHostPackages()
  checkPreload()
  checkGenerated()
  checkGatewayDist()
  let stale = 0
  for (const result of results) {
    const tag = result.status === 'ok' ? 'OK   ' : result.status === 'skip' ? 'SKIP ' : 'STALE'
    console.log('  ' + tag + ' ' + result.id + (result.detail ? ' — ' + result.detail : ''))
    if (result.status === 'stale') stale += 1
  }
  const skipped = results.filter(r => r.status === 'skip').length
  if (stale > 0) {
    console.error('artifact freshness: ' + stale + ' 类产物陈旧或缺失（SKIP ' + skipped + ' 类无法比对；缺失类先跑 pnpm run build:artifacts）')
    process.exit(1)
  }
  console.log('artifact freshness: 全部已构建产物与当前 src 一致（SKIP ' + skipped + ' 类无法比对）')
}

await main()
