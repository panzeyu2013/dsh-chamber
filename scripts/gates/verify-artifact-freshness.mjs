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
 *      生成产物，remote 装配契约（C4）读的就是它；生成器 emit 前清空输出树，
 *      本门按「重跑前后相对补集为空 + 目录键集 == C4 roster」判集合，再逐字节
 *      比对同名文件——单看交集内容会漏掉旧 remote 留下的孤儿产物；
 *   4. packages/gateway/dist/index.js —— build:gateway 的 esbuild 产物（包 exports
 *      的落点）；用包自己的 build.mjs 在临时副本里重建后逐字节比对（模块路径按
 *      packages/gateway cwd 归一），dist 不在场时 loud SKIP；
 *   5. packages/dsh-chamber-client-ui-mobile/src/** ↔ lib/client.js —— 同一个包的
 *      build.mjs 在临时副本里重建后比对（full 模式或 --mobile-rebuild 启用）。
 *
 * 语义（与 control-plane-freshness / build-smoke 同款豁免）：
 *   - 输入缺失（clean checkout、未 build 的环境）⇒ **loud SKIP**，不判红；
 *   - 产物在但与「从当前 src 重建/重算」的结果不一致 ⇒ **FAIL（陈旧）**，
 *     绝不自动修复（自动重建会让操作者以为产物被检查过，见
 *     build-smoke.test.ts:110-134）。
 * 退出码：0 无陈旧 / 1 有陈旧 / 2 用法错误。
 *   --self-test       负控：证明比对能抓到人为差异（仪表必须能失败）。
 *   --require-compare 严格档：一类产物都比不了（全 SKIP）即红；默认档下
 *                     clean checkout 的 SKIP 只 loud 打印、不判红。发布前用
 *                     严格档证明「确实比过」，不用 SKIP 冒充通过。
 *   --help            打印用法（exit 0）；未知参数 exit 2（拼错的开关绝不
 *                     静默退化成普通检查）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The C4 mount-order table is the single source for the generated artifact set
// (shared with the upgrade touchpoint gate); the freshness gate imports it and
// never re-types the roster names.
import { EXPECTED_MOUNT_PACKAGES } from '../../packages/renderer/scripts/typert-remote-contract.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
const note = (id, status, detail = '') => results.push({ id, status, detail })

const sameBytes = (a, b) => {
  try { return readFileSync(a).equals(readFileSync(b)) } catch { return false }
}

/**
 * One line of an esbuild bundle as a **module comment**: `// <relative path>`
 * ending in a real source extension. esbuild writes exactly this shape for every
 * inlined module; anything else that starts with `// ` is bundle CONTENT (a line
 * inside a template literal, a string, a license banner, …) and must survive the
 * canonicalization untouched.
 *
 * The extension gate alone is NOT enough: a template-literal content line may
 * itself end in `.ts` (`// ../packages/keep.ts`). The load-bearing test is that
 * the path part RESOLVES to a real file — `<root>/packages/<tail>` under one of
 * the given roots, or the raw path resolved against one of them. A line that
 * names no real module is returned verbatim, so a genuine staged-vs-in-place
 * byte difference stays visible. `--self-test` / the freshness test drive this
 * function directly (a negative control that a content line is NOT rewritten).
 */
// The staged build renders module comments with the temp tree's absolute path,
// and real worktree paths may contain spaces (this repo lives under
// "Application Support"): the existence test is the discriminator against
// template-literal content lines, so the path itself may contain anything.
export const MODULE_COMMENT_LINE = /^\/\/ (.+\.(?:ts|tsx|js|jsx|mjs|cjs|css))$/

/**
 * The normalized tail of one module comment path: the segment after the last
 * `packages/` anchor, or the path itself with its leading `../` rungs stripped
 * (the staged tree reaches the workspace through temp directories, so the rung
 * count differs).
 * @param {string} path - the matched module comment path.
 * @returns {string} the canonical tail.
 */
function moduleCommentTail(path) {
  const anchor = path.lastIndexOf('packages/')
  const tail = anchor >= 0 ? path.slice(anchor + 'packages/'.length) : path
  return tail.replace(/^(?:\.\.\/)+/, '')
}

/**
 * Does one module comment path point at a real file? Either its `packages/` tail
 * exists under one of the roots' `packages/` trees, or the raw path resolves
 * from one of the build cwds.
 * @param {string} path - the matched module comment path.
 * @param {string} tail - {@link moduleCommentTail} of the same path.
 * @param {readonly string[]} roots - repository/package roots to test.
 * @returns {boolean}
 */
function moduleCommentResolves(path, tail, roots) {
  if (tail !== '' && roots.some((root) => existsSync(join(root, 'packages', tail)))) return true
  return roots.some((root) => existsSync(resolve(root, path)))
}

/**
 * Canonicalize one bundle line for the staged-vs-in-place byte compare: a line
 * that IS a module comment whose target really exists is re-based to the tail
 * after the last `packages/` segment and stripped of leading `../` rungs.
 * Everything else — `//# sourceMappingURL`, template-literal content, prose that
 * merely looks like a path — is returned verbatim.
 * @param {string} line
 * @param {{ roots?: readonly string[] }} [options] - build cwd roots (the
 *   in-place package dir and the staged copy) used by the existence test;
 *   defaults to the repo root, where `<root>/packages/<tail>` is enough for
 *   in-repo modules.
 * @returns {string}
 */
export function canonComment(line, { roots = [ROOT] } = {}) {
  const match = MODULE_COMMENT_LINE.exec(line)
  if (match === null) return line
  const path = match[1]
  const tail = moduleCommentTail(path)
  if (!moduleCommentResolves(path, tail, roots)) return line
  return '// ' + tail
}

/**
 * Line-wise rung canonicalization for the gateway bundle compare. The staged
 * build reaches the pinned tree through a temp dir and on some platforms (macOS
 * `/var` -> `/private/var`, a symlinked worktree) spells a different number of
 * up-level rungs than the in-place build, so runs of `../` collapse to one
 * token — but ONLY on lines that parse as module comments. The previous
 * whole-text `replace(/(?:\.\.\/)+/gu, '@up@/')` also rewrote `../` runs inside
 * code strings, so a genuine content difference could hide behind it.
 * @param {string} line
 * @returns {string}
 */
export function canonRungs(line) {
  if (!MODULE_COMMENT_LINE.test(line)) return line
  return line.replace(/(?:\.\.\/)+/gu, '@up@/')
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

/**
 * Pure set verdict for the generated tree:
 *  - the relative complements BOTH ways must be empty (a stale artifact the
 *    rerun did not produce is a removal; an artifact the snapshot never had is
 *    an addition),
 *  - the emitted directory set must equal the C4 roster (no wrong-named extra
 *    can hide behind a matching count),
 *  - the file count must equal the roster (one artifact per remote).
 * @param {readonly string[]} before - relative paths in the pre-rerun snapshot.
 * @param {readonly string[]} after - relative paths after the rerun.
 * @param {readonly string[]} roster - package names of the C4 contract.
 * @returns {{ added: string[], removed: string[], dirs: string[], expectedDirs: string[], countMismatch: boolean, stale: boolean }}
 */
export function generatedTreeVerdict(before, after, roster = EXPECTED_MOUNT_PACKAGES) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const added = after.filter((file) => !beforeSet.has(file))
  const removed = before.filter((file) => !afterSet.has(file))
  const dirs = [...new Set(after.map((file) => file.split('/')[0]))].sort()
  const expectedDirs = [...new Set(roster.map((name) => name.slice('@deepseek-ai/'.length)))].sort()
  const countMismatch = after.length !== roster.length
  const stale = added.length > 0 || removed.length > 0 || countMismatch
    || JSON.stringify(dirs) !== JSON.stringify(expectedDirs)
  return { added, removed, dirs, expectedDirs, countMismatch, stale }
}

/** 3. renderer/src/generated/typert：快照 → 重跑生成器 → 集合+字节比对 → 还原（C8 同款纪律）。 */
function checkGenerated() {
  const tree = join(ROOT, 'packages', 'renderer', 'src', 'generated', 'typert')
  const backup = tree + '.freshness-backup'
  if (!existsSync(tree)) { note('renderer/src/generated/typert', 'skip', '未生成（无 src/generated/typert）'); return }
  try {
    rmSync(backup, { recursive: true, force: true })
    cpSync(tree, backup, { recursive: true })
    execFileSync(process.execPath, [join(ROOT, 'packages', 'renderer', 'scripts', 'gen-typert-remotes.mjs')], { cwd: ROOT, stdio: 'pipe' })
    // Paths are relative to the walk ROOT on both sides: the snapshot lives in
    // a sibling directory, so a hardcoded `tree` base would spell every backup
    // file as '../typert.freshness-backup/...' and defeat the set comparison.
    const walk = (dir, base, out = []) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full, base, out)
        else out.push(relative(base, full))
      }
      return out
    }
    const now = walk(tree, tree).sort()
    const before = walk(backup, backup).sort()
    const verdict = generatedTreeVerdict(before, now)
    const changed = []
    for (const file of now) {
      if (!sameBytes(join(tree, file), join(backup, file))) changed.push(file)
    }
    const details = []
    if (verdict.added.length > 0) details.push('重跑多出：' + verdict.added.slice(0, 5).join(', '))
    if (verdict.removed.length > 0) details.push('重跑未产出（旧残留）：' + verdict.removed.slice(0, 5).join(', '))
    if (verdict.countMismatch) details.push('数量 ' + now.length + ' != C4 roster ' + EXPECTED_MOUNT_PACKAGES.length)
    if (JSON.stringify(verdict.dirs) !== JSON.stringify(verdict.expectedDirs)) {
      details.push('目录集 != C4 roster：[' + verdict.dirs.join(', ') + '] vs [' + verdict.expectedDirs.join(', ') + ']')
    }
    if (changed.length > 0) details.push('内容不一致：' + changed.slice(0, 5).join(', '))
    if (verdict.stale || changed.length > 0) {
      note('renderer/src/generated/typert', 'stale', details.join('；') + '（重建：pnpm run build:renderer）')
    } else {
      note('renderer/src/generated/typert', 'ok', before.length + ' 个生成文件与重跑结果一致（集合与 C4 roster 一致）')
    }
  } catch (error) {
    note('renderer/src/generated/typert', 'skip', '无法重跑 gen-typert-remotes：' + String(error.message ?? error).split('\n')[0])
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
    // cwd = packages/gateway, so rebase the staged bundle back to that spelling:
    // repo-root prefix -> '../..', then '<root>/packages/<x>' -> '../<x>'.
    // Both roots go through realpathSync: mkdtemp lives under a symlinked temp
    // dir on macOS (/var -> /private/var), and esbuild spells module comments
    // against the real path — a non-realpath relative() misses by one rung and
    // every comment compares as different (probe: 71 false diffs).
    const inPlaceRoot = relative(pkgDir, ROOT)
    const stagedRoot = relative(realpathSync(stage), realpathSync(ROOT))
    // Belt and braces for a platform that still spells the roots differently:
    // collapse RUNG RUNS on module-comment lines only (canonRungs). The module
    // list, every referenced file and all code still compare byte for byte, and
    // code strings are never rewritten, so a stale bundle cannot hide here.
    const canonicalRungs = (text) => text.split('\n').map(canonRungs).join('\n')
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

/**
 * 5. packages/dsh-chamber-client-ui-mobile 的 `src/**` ↔ `lib/client.js`：
 *    在**临时副本**里跑包自己的 build.mjs（同一份构建配方，不重抄），再逐字节
 *    比对 `lib/client.js`。不写工作树（避免与并发的测试读取/其他构建互相踩），
 *    因此 esbuild 的模块注释里上跳层级与就地构建不同，两侧都先把 `../` 连续段
 *    归一化（与 gateway 重建同一个手法）；代码/模块列表/每个被引用的文件仍逐字节比。
 *
 *    只在 full 模式（或显式 --mobile-rebuild）启用：CI 由**独立的 C8 step**
 *    （verify-upstream-touchpoints.mjs 的就地重建比对）覆盖移动产物；tests 模式
 *    本身没有移动产物的字节比对，这里是 full 档更重的同题复核；未启用时打一行
 *    NOTE，不静默当通过。
 */
function checkMobileClientBundle() {
  const pkgDir = join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile')
  const client = join(pkgDir, 'lib', 'client.js')
  if (!existsSync(client)) { note('mobile/lib/client.js', 'skip', '未构建（无 lib/client.js）（重建：pnpm run build:mobile）'); return }
  const work = mkdtempSync(join(tmpdir(), 'dsh-mobile-fresh-'))
  try {
    // Same repo depth (work/packages/<pkg>) so the package tsconfig's
    // "extends ../../tsconfig.json" resolves: without that chain esbuild's
    // auto-discovered tsconfig silently disappears and the staged build stops
    // reproducing the in-place bytes (probe: no "use strict" prologue).
    mkdirSync(join(work, 'packages'), { recursive: true })
    cpSync(join(ROOT, 'tsconfig.json'), join(work, 'tsconfig.json'))
    const stage = join(work, 'packages', 'dsh-chamber-client-ui-mobile')
    mkdirSync(join(stage, 'scripts'), { recursive: true })
    cpSync(join(pkgDir, 'package.json'), join(stage, 'package.json'))
    cpSync(join(pkgDir, 'tsconfig.json'), join(stage, 'tsconfig.json'))
    cpSync(join(pkgDir, 'scripts', 'build.mjs'), join(stage, 'scripts', 'build.mjs'))
    cpSync(join(pkgDir, 'src'), join(stage, 'src'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(join(pkgDir, 'node_modules'), join(stage, 'node_modules'), linkType)
    const result = spawnSync(process.execPath, [join(stage, 'scripts', 'build.mjs')], { cwd: stage, stdio: 'pipe' })
    if (result.status !== 0) {
      const lines = String(result.stderr ?? '').trim().split('\n')
      note('mobile/lib/client.js', 'skip', '重建不可用：' + (lines[lines.length - 1] || ('exit ' + String(result.status))))
      return
    }
    const rebuilt = join(stage, 'lib', 'client.js')
    if (!existsSync(rebuilt)) { note('mobile/lib/client.js', 'skip', '重建未产出 lib/client.js'); return }
    // Existence roots: the repo root (its packages/ tree is the canonical
    // spelling of every in-repo module) plus both build cwds — the in-place
    // package dir and the staged copy. A module comment is normalized only when
    // it names a real file (a template-literal content line ending in .ts stays
    // raw, so the byte difference it carries is not erased).
    const canonical = (source) => source.split('\n')
      .map((line) => canonComment(line, { roots: [ROOT, pkgDir, stage] }))
      .join('\n')
    const rebuiltText = canonical(readFileSync(rebuilt, 'utf8'))
    const onDiskText = canonical(readFileSync(client, 'utf8'))
    if (rebuiltText !== onDiskText) {
      note('mobile/lib/client.js', 'stale', '与 src/** 重建结果不一致（重建：pnpm run build:mobile）')
    } else {
      note('mobile/lib/client.js', 'ok', '与 src/** 重建逐字节一致（临时副本重建，未写工作树）')
    }
  } catch (error) {
    note('mobile/lib/client.js', 'skip', '重建不可用：' + String(error.message ?? error).split('\n')[0])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 用法（--help 与未知参数都打印它）。 */
const USAGE = [
  '用法: node scripts/gates/verify-artifact-freshness.mjs [--mobile-rebuild] [--require-compare] [--self-test]',
  '',
  '  无参数           比对已构建的 host-packages / preload / typert / gateway dist。',
  '  --mobile-rebuild  追加 mobile src/** ↔ lib/client.js 的临时副本重建比对（full 档同款）。',
  '  --require-compare 严格档：一类产物都比不了（全 SKIP，例如 clean checkout）即红；',
  '                    用于必须证明「比过」的场合；默认档下 SKIP 只 loud 打印、不判红。',
  '  --self-test       负控：证明比对能抓到人为差异，exit 0/1。',
  '  --help            打印本用法，exit 0。',
  '未知参数 = exit 2（拼错的 --mobil-rebuild 绝不能静默退化成普通检查）。',
].join('\n')

/**
 * 汇总判定（纯函数，main 与负控共用）：比较过几类（ok/stale 都算比过）、跳过
 * 几类、陈旧几类、严格档是否失败。--require-compare 的语义是「一类都比不了即
 * 红」：全 SKIP 常见于 clean checkout / 未 build 的环境，默认档 loud SKIP 不判
 * 红；发布前的严格档必须证明「比过」，不能拿 SKIP 冒充通过。
 * @param {readonly { status: string }[]} results - note() 收集的判定。
 * @param {{ requireCompare?: boolean }} [options] - 严格档开关。
 * @returns {{ compared: number, skipped: number, stale: number, strictFailure: boolean }}
 */
export function summarizeResults(results, { requireCompare = false } = {}) {
  const compared = results.filter((result) => result.status === 'ok' || result.status === 'stale').length
  const skipped = results.filter((result) => result.status === 'skip').length
  const stale = results.filter((result) => result.status === 'stale').length
  return { compared, skipped, stale, strictFailure: requireCompare && compared === 0 }
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const unknown = argv.filter((argument) => !['--mobile-rebuild', '--require-compare', '--self-test'].includes(argument))
  if (unknown.length > 0) {
    console.error('artifact-freshness: 未知参数 ' + unknown.join(' '))
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  const requireCompare = argv.includes('--require-compare')
  if (argv.includes('--self-test')) {
    const a = join(tmpdir(), 'dsh-fresh-a-' + process.pid)
    const b = join(tmpdir(), 'dsh-fresh-b-' + process.pid)
    cpSync(join(ROOT, 'package.json'), a)
    cpSync(join(ROOT, 'package.json'), b)
    const identical = sameBytes(a, b)
    execFileSync(process.execPath, ['-e', 'require("node:fs").appendFileSync(process.argv[1], String.fromCharCode(10))', b])
    const detected = !sameBytes(a, b)
    rmSync(a, { force: true }); rmSync(b, { force: true })
    // Set arm (the checkGenerated instrument): an EXTRA artifact the rerun does
    // not emit must read as stale (removed), a missing one as stale too, and the
    // roster directory set must be judged, not just the count.
    const roster = ['@deepseek-ai/dsh-a', '@deepseek-ai/dsh-b']
    const emitted = ['dsh-a/f.js', 'dsh-b/f.js']
    const clean = generatedTreeVerdict(emitted, emitted, roster)
    const extra = generatedTreeVerdict([...emitted, 'dsh-stale/f.js'], emitted, roster)
    const missing = generatedTreeVerdict(emitted, ['dsh-a/f.js'], roster)
    const wrongDir = generatedTreeVerdict(['dsh-c/f.js', 'dsh-a/f.js'], ['dsh-c/f.js', 'dsh-a/f.js'], roster)
    const setArm = clean.stale === false
      && extra.stale && extra.removed.length === 1 && extra.added.length === 0
      && missing.stale && missing.countMismatch
      && wrongDir.stale
    // Strict arm (the --require-compare instrument): an all-SKIP result set must
    // read as a failure, one compared class must not.
    const strictArm = summarizeResults([{ status: 'skip' }, { status: 'skip' }], { requireCompare: true }).strictFailure
      && !summarizeResults([{ status: 'ok' }], { requireCompare: true }).strictFailure
    const selfTestOk = identical && detected && setArm && strictArm
    console.log('artifact-freshness self-test: ' + (selfTestOk
      ? 'ok（同内容=一致，追加一字节=陈旧，多余/缺失/错名产物=陈旧，全 SKIP 严格档=红）'
      : 'FAIL'))
    process.exit(selfTestOk ? 0 : 1)
  }
  const mobileRebuild = argv.includes('--mobile-rebuild')
    || process.env.DSH_ARTIFACT_FRESHNESS_MOBILE_REBUILD === '1'
  checkHostPackages()
  checkPreload()
  if (mobileRebuild) checkMobileClientBundle()
  else console.log('  NOTE  mobile src/** ↔ lib/client.js 重建比对未启用（full 模式或 --mobile-rebuild 启用；CI 由独立的 C8 step（verify-upstream-touchpoints.mjs 就地重建）覆盖，tests 档本身没有移动产物字节比对）')
  checkGenerated()
  checkGatewayDist()
  for (const result of results) {
    const tag = result.status === 'ok' ? 'OK   ' : result.status === 'skip' ? 'SKIP ' : 'STALE'
    console.log('  ' + tag + ' ' + result.id + (result.detail ? ' — ' + result.detail : ''))
  }
  const summary = summarizeResults(results, { requireCompare })
  if (summary.stale > 0) {
    console.error('artifact freshness: ' + summary.stale + ' 类产物陈旧或缺失（比较 ' + summary.compared + ' 类 / 跳过 ' + summary.skipped + ' 类无法比对；缺失类先跑 pnpm run build:artifacts）')
    process.exit(1)
  }
  if (summary.strictFailure) {
    console.error('artifact freshness: --require-compare 要求至少比较一类产物，但全部 ' + summary.skipped + ' 类都 SKIP（未 build 的环境——先跑 pnpm run build:artifacts）')
    process.exit(1)
  }
  console.log('artifact freshness: 全部已构建产物与当前 src 一致（比较 ' + summary.compared + ' 类 / 跳过 ' + summary.skipped + ' 类无法比对）')
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
