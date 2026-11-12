/**
 * prepare-office-assets.test.mjs —— Office 技能资产落位/校验 machinery 的行为与纪律用例。
 *
 * 覆盖五件事：
 *  ① 清单单源：4 个 SKILL.md（rc.2 资产面）、顶层期望集合、
 *     默认落点/默认源候选顺序；
 *  ② 源解析：显式 --source 优先、默认候选按顺序、全缺时响亮给提示；源缺件在写盘前拒绝；
 *  ③ 落位：逐文件 temp+rename、保留 committed README、清非期望顶层残留、幂等、
 *     清上次中断留下的 temp 文件；
 *  ④ verify：源可用时逐文件 sha256（篡改必红、缺源文件必红）；源不可用时降级为
 *     资产在场校验；
 *  ⑤ CLI：--dry-run 不写盘、真实 prepare→verify 往返、参数/互斥校验。
 *
 * 全部用临时目录夹具，不读 vendor（干净 checkout 里 vendor 可能是空的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMITTED_README,
  DEFAULT_OUT_DIR,
  DEFAULT_SOURCE_CANDIDATES,
  OFFICE_SKILL_FILES,
  OFFICE_SKILL_TOP_LEVEL,
  formatPlan,
  materializeOfficeAssets,
  missingOfficeAssetFiles,
  officeAssetPlan,
  parseArgs,
  resolveOfficeAssetsSource,
  sha256File,
  verifyOfficeAssets,
} from './prepare-office-assets.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.join(SCRIPT_DIR, 'prepare-office-assets.mjs')

/** 临时工作目录（同步用例；结束即删）。 */
function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-office-assets-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 夹具源树：清单文件逐一点内容；options.skip 可漏掉一个文件（缺件用例）。 */
function writeOfficeSource(root, options = {}) {
  for (const relative of OFFICE_SKILL_FILES) {
    if (options.skip === relative) continue
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '# fixture ' + relative + '\n')
  }
  return root
}

/** 夹具落点：committed README + 一个旧技能目录 + 一个顶层杂文件（模拟历史残留）。 */
function writeOfficeOut(root) {
  mkdirSync(path.join(root, 'legacy-skill'), { recursive: true })
  writeFileSync(path.join(root, 'legacy-skill', 'SKILL.md'), '# legacy\n')
  writeFileSync(path.join(root, 'notes.txt'), 'stray\n')
  writeFileSync(path.join(root, COMMITTED_README), '# committed readme\n')
  return root
}

test('① 清单单源：4 个 SKILL.md（rc.2 资产面）与顶层期望集合', () => {
  assert.equal(OFFICE_SKILL_FILES.length, 4)
  assert.deepEqual(
    OFFICE_SKILL_FILES.filter((relative) => relative.endsWith('/SKILL.md')).sort(),
    ['office-docx', 'office-pptx', 'office-xlsx', 'office']
      .map((name) => name + '/SKILL.md').sort(),
  )
  assert.equal(OFFICE_SKILL_FILES.includes('office/references/sidecar.md'), false,
    'rc.2 起 sidecar.md 已随 office-render/recalculate/export-pdf 一起删除')
  assert.equal(OFFICE_SKILL_FILES.includes(COMMITTED_README), false, 'README 是 committed 说明文件，不属于资产清单')
  assert.deepEqual(
    [...OFFICE_SKILL_TOP_LEVEL].sort(),
    ['office', 'office-docx', 'office-pptx', 'office-xlsx'],
  )
  assert.equal(DEFAULT_OUT_DIR.endsWith(path.join('resources', 'office-skills')), true)
  assert.equal(DEFAULT_SOURCE_CANDIDATES.length, 2)
  assert.ok(DEFAULT_SOURCE_CANDIDATES[0].endsWith(path.join('vendor', 'harness-packages', '@deepseek-ai', 'dsh-skill-office', 'assets')))
  assert.ok(DEFAULT_SOURCE_CANDIDATES[1].endsWith(path.join('vendor', 'harness-checkout', 'packages', 'skill', 'skill-office', 'assets')))

  const plan = officeAssetPlan(path.join(path.sep, 'src'), path.join(path.sep, 'out'))
  assert.equal(plan.files.length, 4)
  assert.equal(plan.files[0].relative, 'office/SKILL.md')
  assert.equal(plan.files.every((entry) => entry.destination.startsWith(path.join(path.sep, 'out'))), true)
  assert.deepEqual(plan.keep, [COMMITTED_README])
  assert.match(formatPlan(plan).join('\n'), /files: 4（4x SKILL\.md）/u)
  assert.match(formatPlan(plan).join('\n'), /office-xlsx\/SKILL\.md ← /u)
})

test('① 源解析：显式 --source 优先、默认候选按顺序、全缺时响亮提示', () => {
  withTempDir((dir) => {
    const first = path.join(dir, 'candidate-first')
    const second = path.join(dir, 'candidate-second')
    writeOfficeSource(first)
    writeOfficeSource(second)
    const candidates = [first, second]
    assert.equal(resolveOfficeAssetsSource(null, { candidates }).source, first, '默认候选按顺序取第一个存在的')
    rmSync(first, { recursive: true, force: true })
    assert.equal(resolveOfficeAssetsSource(null, { candidates }).source, second, '第一个缺失时回退第二个')
    // 显式 source 优先于默认候选。
    assert.deepEqual(resolveOfficeAssetsSource(second, { candidates }), { source: second, explicit: true })
    assert.throws(() => resolveOfficeAssetsSource(path.join(dir, 'nope'), { candidates }), /--source/u)
    assert.throws(() => resolveOfficeAssetsSource(null, { candidates: [] }), /找不到 office 技能资产源[\s\S]*--source/u)
  })
})

test('② 源缺/缺件：materialize 在动盘之前拒绝，既有落点不被破坏', () => {
  withTempDir((dir) => {
    // 源目录不存在。
    assert.throws(
      () => materializeOfficeAssets({ source: path.join(dir, 'no-source'), outDir: path.join(dir, 'out') }),
      /--source/u,
    )
    // 源缺一个文件：先扫清单再写盘，落点原样保留。
    const incomplete = writeOfficeSource(path.join(dir, 'incomplete-source'), { skip: 'office-pptx/SKILL.md' })
    assert.deepEqual(missingOfficeAssetFiles(incomplete), ['office-pptx/SKILL.md'])
    const outDir = writeOfficeOut(path.join(dir, 'out'))
    const before = readFileSync(path.join(outDir, COMMITTED_README), 'utf8')
    assert.throws(
      () => materializeOfficeAssets({ source: incomplete, outDir }),
      /office 资产源缺件[\s\S]*office-pptx\/SKILL\.md/u,
    )
    assert.equal(readFileSync(path.join(outDir, COMMITTED_README), 'utf8'), before, '失败不得动既有落点')
    assert.equal(readFileSync(path.join(outDir, 'notes.txt'), 'utf8'), 'stray\n')
    assert.equal(existsSync(path.join(outDir, 'office', 'SKILL.md')), false)
  })
})

test('③ 真实落位：4 文件 + 保留 README + 清非期望顶层残留 + 幂等', () => {
  withTempDir((dir) => {
    const source = writeOfficeSource(path.join(dir, 'source'))
    const outDir = writeOfficeOut(path.join(dir, 'out'))
    const first = materializeOfficeAssets({ source, outDir })
    assert.equal(first.written, 4)
    assert.deepEqual(first.removed.sort(), ['legacy-skill', 'notes.txt'])
    assert.equal(first.verify.ok, true, first.verify.problems.join('；'))
    assert.equal(first.verify.compared, 4)
    for (const relative of OFFICE_SKILL_FILES) {
      assert.equal(readFileSync(path.join(outDir, relative), 'utf8'), '# fixture ' + relative + '\n', relative)
    }
    assert.equal(readFileSync(path.join(outDir, COMMITTED_README), 'utf8'), '# committed readme\n', 'committed README 必须保留')
    assert.deepEqual(readdirSync(outDir).sort(), [...OFFICE_SKILL_TOP_LEVEL, COMMITTED_README].sort())

    // 幂等：再跑一次不改内容、不报错、不产生多余文件。
    const before = new Map(OFFICE_SKILL_FILES.map((relative) => [relative, readFileSync(path.join(outDir, relative), 'utf8')]))
    const second = materializeOfficeAssets({ source, outDir })
    assert.equal(second.written, 4)
    assert.deepEqual(second.removed, [])
    assert.deepEqual(readdirSync(outDir).sort(), [...OFFICE_SKILL_TOP_LEVEL, COMMITTED_README].sort())
    for (const relative of OFFICE_SKILL_FILES) {
      assert.equal(readFileSync(path.join(outDir, relative), 'utf8'), before.get(relative))
    }
    assert.equal(verifyOfficeAssets(outDir, { source }).ok, true)
  })
})

test('③ 8→4 升级残留：期望目录内的陈旧文件与旧技能目录都被递归清掉', () => {
  withTempDir((dir) => {
    const source = writeOfficeSource(path.join(dir, 'source'))
    const outDir = path.join(dir, 'out')
    mkdirSync(path.join(outDir, 'office-render'), { recursive: true })
    writeFileSync(path.join(outDir, 'office-render', 'SKILL.md'), '# legacy\n')
    mkdirSync(path.join(outDir, 'office', 'references'), { recursive: true })
    writeFileSync(path.join(outDir, 'office', 'references', 'sidecar.md'), '# legacy sidecar\n')
    writeFileSync(path.join(outDir, 'office', 'stray.txt'), 'stray\n')
    writeFileSync(path.join(outDir, COMMITTED_README), '# committed readme\n')
    const result = materializeOfficeAssets({ source, outDir })
    assert.equal(result.verify.ok, true, result.verify.problems.join('；'))
    assert.equal(existsSync(path.join(outDir, 'office-render')), false, '旧顶层技能目录必须清掉')
    assert.equal(existsSync(path.join(outDir, 'office', 'references')), false,
      '期望目录内的陈旧子目录（8→4 的 references/sidecar.md）必须递归清掉')
    assert.equal(existsSync(path.join(outDir, 'office', 'stray.txt')), false, '期望目录内的杂文件必须清掉')
    assert.equal(readFileSync(path.join(outDir, COMMITTED_README), 'utf8'), '# committed readme\n')
    assert.deepEqual(readdirSync(outDir).sort(), [...OFFICE_SKILL_TOP_LEVEL, COMMITTED_README].sort())
    assert.ok(result.removed.includes('office-render'), result.removed.join(','))
    assert.ok(result.removed.includes('office/references'), result.removed.join(','))
    assert.ok(result.removed.includes('office/stray.txt'), result.removed.join(','))
  })
})

test('③ 中断残留：上次进程留下的 <file>.tmp-<pid> 必须被清掉', () => {
  withTempDir((dir) => {
    const source = writeOfficeSource(path.join(dir, 'source'))
    const outDir = path.join(dir, 'out')
    const result = materializeOfficeAssets({ source, outDir })
    assert.equal(result.temps, 0)
    const stale = path.join(outDir, 'office', 'SKILL.md.tmp-99999')
    writeFileSync(stale, 'stale half write\n')
    const second = materializeOfficeAssets({ source, outDir })
    assert.equal(second.temps, 1, '旧 pid 的 temp 必须被清扫')
    assert.equal(existsSync(stale), false)
    assert.equal(readFileSync(path.join(outDir, 'office', 'SKILL.md'), 'utf8'), '# fixture office/SKILL.md\n')
  })
})

test('④ verify：源可用时逐文件 sha256；篡改/源缺件必红', () => {
  withTempDir((dir) => {
    const source = writeOfficeSource(path.join(dir, 'source'))
    const outDir = path.join(dir, 'out')
    materializeOfficeAssets({ source, outDir })
    const ok = verifyOfficeAssets(outDir, { source })
    assert.equal(ok.ok, true, ok.problems.join('；'))
    assert.equal(ok.checked, 4)
    assert.equal(ok.compared, 4)

    // 篡改一个文件的字节：sha256 必须红（在场校验会放过它，源比对不会）。
    appendFileSync(path.join(outDir, 'office', 'SKILL.md'), 'tampered\n')
    const tampered = verifyOfficeAssets(outDir, { source })
    assert.equal(tampered.ok, false)
    assert.ok(tampered.problems.some((problem) => problem.includes('sha256 与源不符：office/SKILL.md')), tampered.problems.join('；'))
    // 无源降级：只做在场校验（4 文件仍在 → 通过）——这是干净 checkout 的语义。
    assert.equal(verifyOfficeAssets(outDir, { source: null }).ok, true)
    // 再 prepare 一次恢复绿。
    materializeOfficeAssets({ source, outDir })
    assert.equal(verifyOfficeAssets(outDir, { source }).ok, true)

    // 源自身缺件：无法比对 → 红。
    const incomplete = writeOfficeSource(path.join(dir, 'incomplete'), { skip: 'office/SKILL.md' })
    const incompleteCheck = verifyOfficeAssets(outDir, { source: incomplete })
    assert.equal(incompleteCheck.ok, false)
    assert.ok(incompleteCheck.problems.some((problem) => problem.includes('源缺文件')), incompleteCheck.problems.join('；'))
  })
})

test('④ verify：缺文件逐项点名（4 个全缺）', () => {
  withTempDir((dir) => {
    const empty = path.join(dir, 'empty')
    mkdirSync(empty, { recursive: true })
    const check = verifyOfficeAssets(empty, { source: null })
    assert.equal(check.ok, false)
    assert.equal(check.checked, 0)
    assert.equal(check.problems.filter((problem) => problem.startsWith('缺文件：')).length, 4)
    const absent = verifyOfficeAssets(path.join(dir, 'never-created'), { source: null })
    assert.equal(absent.ok, false)
    assert.equal(absent.problems.length, 4)
    assert.ok(absent.problems.every((problem) => problem.includes('缺文件')))
  })
})

test('⑤ CLI：--dry-run 打印 4 文件且不写盘；缺源响亮失败', () => {
  withTempDir((dir) => {
    const source = writeOfficeSource(path.join(dir, 'source'))
    const outDir = path.join(dir, 'out')
    const dryRun = spawnSync(process.execPath, [CLI_PATH, '--dry-run', '--source', source, '--out', outDir], { encoding: 'utf8' })
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.match(dryRun.stdout, /files: 4/u)
    assert.match(dryRun.stdout, /office-xlsx\/SKILL\.md ← /u)
    assert.equal(existsSync(outDir), false, '--dry-run 不得写盘')
    const missingSource = spawnSync(process.execPath, [CLI_PATH, '--dry-run', '--source', path.join(dir, 'nope')], { encoding: 'utf8' })
    assert.equal(missingSource.status, 1)
    assert.match(missingSource.stderr, /--source/u)
  })
})

test('⑤ CLI 真实往返：prepare → verify 绿；篡改后 verify 红；重跑恢复', () => {
  withTempDir((dir) => {
    const source = writeOfficeSource(path.join(dir, 'source'))
    const outDir = writeOfficeOut(path.join(dir, 'out'))
    const prepare = spawnSync(process.execPath, [CLI_PATH, '--source', source, '--out', outDir], { encoding: 'utf8' })
    assert.equal(prepare.status, 0, prepare.stderr)
    assert.match(prepare.stdout, /落位完成/u)
    for (const relative of OFFICE_SKILL_FILES) assert.equal(existsSync(path.join(outDir, relative)), true, relative)
    assert.equal(existsSync(path.join(outDir, COMMITTED_README)), true)

    const verify = spawnSync(process.execPath, [CLI_PATH, '--verify', outDir, '--source', source], { encoding: 'utf8' })
    assert.equal(verify.status, 0, verify.stderr)
    assert.match(verify.stdout, /资产完整/u)

    appendFileSync(path.join(outDir, 'office-xlsx', 'SKILL.md'), 'x\n')
    const tampered = spawnSync(process.execPath, [CLI_PATH, '--verify', outDir, '--source', source], { encoding: 'utf8' })
    assert.equal(tampered.status, 1)
    assert.match(tampered.stderr, /sha256 与源不符：office-xlsx\/SKILL\.md/u)

    const reprepare = spawnSync(process.execPath, [CLI_PATH, '--source', source, '--out', outDir], { encoding: 'utf8' })
    assert.equal(reprepare.status, 0, reprepare.stderr)
    assert.equal(spawnSync(process.execPath, [CLI_PATH, '--verify', outDir, '--source', source], { encoding: 'utf8' }).status, 0)
  })
})

test('⑤ CLI 参数：未知参数/缺取值/互斥/解析', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/u)
  assert.throws(() => parseArgs(['--verify']), /缺少取值/u)
  assert.throws(() => parseArgs(['--source']), /缺少取值/u)
  assert.throws(() => parseArgs(['--dry-run', '--verify', '/x']), /互斥/u)
  const options = parseArgs(['--dry-run', '--source', 'src', '--out', 'out'])
  assert.equal(options.dryRun, true)
  assert.equal(options.source, path.resolve('src'))
  assert.equal(options.outDir, path.resolve('out'))
  assert.equal(parseArgs([]).verifyDir, null)
  assert.equal(parseArgs(['--verify', '/x']).verifyDir, path.resolve('/x'))
  assert.equal(parseArgs(['--help']).help, true)
  assert.ok(sha256File(path.join(SCRIPT_DIR, 'prepare-office-assets.mjs')).length === 64)
})

test('office 清单与 control-plane 启动行门控锁步（pin 改技能时同批更新）', () => {
  const gateSource = readFileSync(path.join(SCRIPT_DIR, '..', '..', 'control-plane', 'src', 'startup-plugin-rows.ts'), 'utf8')
  const gateNames = /OFFICE_SKILL_NAMES[^=]*=\s*\[([\s\S]*?)\]/u.exec(gateSource)
  assert.notEqual(gateNames, null, 'startup-plugin-rows.ts 必须保留 OFFICE_SKILL_NAMES 门控清单')
  const gated = [...gateNames[1].matchAll(/'([^']+)'/gu)].map(match => match[1]).sort()
  assert.deepEqual(gated, [...OFFICE_SKILL_TOP_LEVEL].sort(),
    'prepare 的清单与控制面门控的技能名集合必须一致（升级 pin 改技能时同批更新）')
})
