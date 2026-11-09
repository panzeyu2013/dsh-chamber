/**
 * pin-upgrade-pipeline.mjs unit tests (plain node:test; read-only against the repo,
 * writes only inside mkdtemp fixtures).
 *
 * The pipeline's whole value is that its printed diff matches the anchors the
 * touchpoint gate actually enforces: the table below is locked against
 * verify-upstream-touchpoints.mjs' C10 REQUIRED / ALLOWED lists, so an anchor list
 * change in either file turns this test red instead of letting the printed diff
 * silently drift from the gate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ANCHOR_SITES,
  ROOT,
  RUNTIME_LOCK,
  TAG_RE,
  deriveAnchorPlan,
  locateLiteral,
  parseArgs,
  pipelineSteps,
  readRuntimeLock,
  renderAnchorPlan,
  runPipeline,
  summarizePlan,
  versionFromTag,
} from './pin-upgrade-pipeline.mjs'

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const VERIFIER = read('scripts/upstream/verify/verify-upstream-touchpoints.mjs')
const currentRuntimeVersion = () => readRuntimeLock(read(RUNTIME_LOCK)).specifier
const TARGET = '9.9.9-alpha.9'

/** C10 anchor facts parsed from the gate itself (the single source this table must mirror). */
function verifierAnchorFacts() {
  const requiredBlock = /const REQUIRED = \[([\s\S]*?)\n\s*\]/u.exec(VERIFIER)
  assert.ok(requiredBlock, 'verify-upstream-touchpoints.mjs must still declare REQUIRED')
  const required = [...requiredBlock[1].matchAll(/'([^']+)'/gu)].map((match) => match[1])
  const anchored = [...VERIFIER.matchAll(/^\s*\['([^']+)', \{ anchor: (true|false),/gmu)]
    .filter((match) => match[2] === 'true')
    .map((match) => match[1])
  return { required, anchored }
}

/**
 * Copy the nine real anchor files into a temp root, rewriting each literal site's
 * current version to target unless its id is named in keepCurrent.
 */
function anchorFixture({ target, keepCurrent = new Set() }) {
  const root = mkdtempSync(join(tmpdir(), 'pin-pipeline-'))
  for (const site of ANCHOR_SITES) {
    const text = read(site.file)
    let next = text
    if (site.kind !== 'derived') {
      const located = locateLiteral(text, site.pattern, target)
      assert.equal(located.ok, true, 'anchor site must locate in the real tree: ' + site.id)
      const wanted = keepCurrent.has(site.id) ? located.version : target
      const line = located.oldLine.replace(located.version, () => wanted)
      next = text.replace(located.oldLine, () => line)
    }
    const full = join(root, site.file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, next)
  }
  return { root, readFile: (rel) => readFileSync(join(root, rel), 'utf8') }
}

function capturingIo() {
  const lines = []
  return {
    lines,
    io: {
      log: (line) => lines.push(line ?? ''),
      error: (line) => lines.push(line ?? ''),
    },
  }
}

const parsedFor = (version, overrides = {}) => ({
  tag: 'dsh-v' + version,
  version,
  check: false,
  noArtifactRebuild: false,
  strict: false,
  help: false,
  problems: [],
  ...overrides,
})

test('versionFromTag derives the runtime version and matches the update-vendor tag grammar', () => {
  assert.equal(versionFromTag('dsh-v1.2.3-alpha.4'), '1.2.3-alpha.4')
  assert.equal(versionFromTag('dsh-v1.2.3'), '1.2.3')
  assert.equal(versionFromTag('dsh-v1.2.3-rc.10'), '1.2.3-rc.10')
  for (const bad of ['dsh-v1.2', 'v1.2.3', 'dsh-1.2.3', 'dsh-v1.2.3-alpha', 'dsh-v1.2.3-beta.x', 'dsh-v1.2.3-alpha.4.5', null, 42]) {
    assert.equal(versionFromTag(bad), null, 'must reject ' + String(bad))
  }
  // Same acceptance set as the pin-upgrade entry this pipeline sits beside.
  const source = read('scripts/upstream/pin/update-vendor.mjs')
  const line = source.split('\n').find((text) => text.includes('const TAG_RE = /'))
  assert.ok(line, 'update-vendor must still declare TAG_RE on one line')
  const literal = line.slice(line.indexOf('/'), line.lastIndexOf('/') + 1)
  const updaterTag = new RegExp(literal.slice(1, -1))
  const samples = ['dsh-v1.2.3-alpha.4', 'dsh-v1.2.3', 'dsh-v1.2.3-rc.10', 'dsh-v1.2.3-alpha', 'v1.2.3', 'dsh-v1.2']
  for (const sample of samples) assert.equal(updaterTag.test(sample), TAG_RE.test(sample), sample)
})

test('anchor table covers exactly the C10 six anchors + three shadow forks', () => {
  const runtime = ANCHOR_SITES.filter((site) => site.anchor !== undefined)
  const forks = ANCHOR_SITES.filter((site) => site.fork !== undefined)
  assert.deepEqual(runtime.map((site) => site.anchor), ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6'])
  assert.deepEqual(forks.map((site) => site.fork), ['1/3', '2/3', '3/3'])
  assert.equal(new Set(ANCHOR_SITES.map((site) => site.file)).size, ANCHOR_SITES.length, 'files must be unique')
  for (const site of ANCHOR_SITES) assert.equal(typeof site.label, 'string')
  const derived = ANCHOR_SITES.filter((site) => site.kind === 'derived')
  assert.equal(derived.length, 1)
  assert.equal(derived[0].file, RUNTIME_LOCK)

  const { required, anchored } = verifierAnchorFacts()
  const forkFiles = forks.map((site) => site.file)
  assert.deepEqual([...required].sort(), runtime.map((site) => site.file).sort(), 'runtime sites mirror C10 REQUIRED')
  assert.deepEqual(
    [...anchored].sort(),
    [...required, ...forkFiles, 'packages/desktop/vendor/dsh/package.json'].sort(),
    'C10 ALLOWED anchor:true list = REQUIRED + forks + the gitignored bundle manifest',
  )
})

test('every anchor site locates in the real tree (pattern-rot lock)', () => {
  const plan = deriveAnchorPlan({ targetVersion: currentRuntimeVersion() })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.entries.length, ANCHOR_SITES.length)
  for (const entry of plan.entries) assert.equal(typeof entry.aligned, 'boolean')
})

test('readRuntimeLock reads the committed runtime lock in the C10 shape', () => {
  const lock = readRuntimeLock(read(RUNTIME_LOCK))
  assert.ok(lock, 'the committed runtime lock must carry the @deepseek-ai/dsh entry')
  assert.match(lock.specifier, /^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/u)
  assert.ok(lock.version.startsWith(lock.specifier + '('), 'version line carries the pnpm hash suffix')
})

test('locateLiteral yields a one-line diff only when the pattern matches exactly once', () => {
  const pattern = ANCHOR_SITES.find((site) => site.id === 'runtime-3-release-env').pattern
  const text = 'env:\n  DSH_CHAMBER_DSH_VERSION: 1.2.3-alpha.4\njobs:\n'
  const located = locateLiteral(text, pattern, '1.2.4-alpha.4')
  assert.equal(located.ok, true)
  assert.equal(located.version, '1.2.3-alpha.4')
  assert.equal(located.lineNumber, 2)
  assert.equal(located.oldLine, '  DSH_CHAMBER_DSH_VERSION: 1.2.3-alpha.4')
  assert.equal(located.newLine, '  DSH_CHAMBER_DSH_VERSION: 1.2.4-alpha.4')
  assert.equal(located.aligned, false)
  assert.equal(locateLiteral(text, pattern, '1.2.3-alpha.4').aligned, true)
  assert.equal(locateLiteral('env: {}\n', pattern, '1.2.4-alpha.4').ok, false)
  const ambiguous = locateLiteral(
    '  DSH_CHAMBER_DSH_VERSION: 1.2.3-alpha.4\n  DSH_CHAMBER_DSH_VERSION: 1.2.3-alpha.4\n',
    pattern,
    '1.2.4-alpha.4',
  )
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.reason, /不唯一/u)
})

test('deriveAnchorPlan separates pending literals from the derived lockfile anchor', () => {
  const current = currentRuntimeVersion()
  const fixture = anchorFixture({ target: TARGET, keepCurrent: new Set(['runtime-3-release-env', 'fork-2-dsh-client-web']) })
  const plan = deriveAnchorPlan({ targetVersion: TARGET, readFile: fixture.readFile })
  assert.deepEqual(plan.problems, [])
  const summary = summarizePlan(plan)
  assert.equal(summary.total, 9)
  assert.equal(summary.literal, 8)
  assert.equal(summary.derived, 1)
  assert.equal(summary.aligned, 6)
  assert.equal(summary.pendingLiteral, 2)
  assert.equal(summary.pendingDerived, 1)
  const byId = new Map(plan.entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('runtime-3-release-env').aligned, false, 'keepCurrent sites stay at the committed version')
  assert.equal(byId.get('fork-2-dsh-client-web').aligned, false)
  assert.equal(byId.get('runtime-2-lockfile').aligned, false)
  assert.equal(byId.get('runtime-2-lockfile').current, current)
})

test('deriveAnchorPlan reports unreadable or shape-missing sites as problems', () => {
  const fixture = anchorFixture({ target: TARGET })
  const missing = deriveAnchorPlan({
    targetVersion: TARGET,
    readFile: (rel) => {
      if (rel === '.github/workflows/release.yml') throw new Error('gone')
      return fixture.readFile(rel)
    },
  })
  assert.equal(missing.problems.length, 1)
  assert.match(missing.problems[0], /读取失败/u)
  const wrongShape = deriveAnchorPlan({
    targetVersion: TARGET,
    readFile: (rel) => (rel === RUNTIME_LOCK ? 'no entry here\n' : fixture.readFile(rel)),
  })
  assert.equal(wrongShape.problems.length, 1)
  assert.match(wrongShape.problems[0], /读不出 '@deepseek-ai\/dsh'/u)
})

test('renderAnchorPlan prints unified-diff lines only for pending literals', () => {
  const plan = {
    targetVersion: TARGET,
    entries: [
      {
        kind: 'literal', anchor: '3/6', file: 'a.yml', label: 'env', lineNumber: 2,
        version: '1.0.0-alpha.1', oldLine: '  V: 1.0.0-alpha.1', newLine: '  V: 9.9.9-alpha.9', aligned: false,
      },
      {
        kind: 'literal', fork: '1/3', file: 'p.json', label: 'fork', lineNumber: 4,
        version: '9.9.9-alpha.9', oldLine: '  "version": "9.9.9-alpha.9",', newLine: '  "version": "9.9.9-alpha.9",', aligned: true,
      },
      {
        kind: 'derived', anchor: '2/6', file: RUNTIME_LOCK, label: 'lock',
        current: '1.0.0-alpha.1', rawVersion: '1.0.0-alpha.1 (hash)', aligned: false, regenerate: 'bundle:dsh --force',
      },
    ],
    problems: [],
  }
  const lines = renderAnchorPlan(plan, { tag: 'dsh-v9.9.9-alpha.9' }).split('\n')
  assert.ok(lines.includes('    --- a/a.yml'))
  assert.ok(lines.includes('    +++ b/a.yml'))
  assert.ok(lines.includes('    @@ 行 2 @@'))
  assert.ok(lines.includes('    -  V: 1.0.0-alpha.1'))
  assert.ok(lines.includes('    +  V: 9.9.9-alpha.9'))
  assert.ok(!lines.includes('    --- a/p.json'), 'an aligned literal must not reprint a diff')
  const text = lines.join('\n')
  assert.match(text, /\[锚 3\/6\] ✗ 待人工应用/u)
  assert.match(text, /\[fork 1\/3\] ✓ 已是 9\.9\.9-alpha\.9/u)
  assert.match(text, /\[锚 2\/6\] ✗ 待重生成/u)
  assert.match(text, /重生成: bundle:dsh --force/u)
  assert.match(text, /（bundle:dsh 拥有；本管线不写）/u)
})

test('parseArgs accepts one tag plus flags and aggregates usage problems', () => {
  const parsed = parseArgs(['dsh-v9.9.9-alpha.9', '--check', '--no-artifact-rebuild', '--strict'])
  assert.equal(parsed.tag, 'dsh-v9.9.9-alpha.9')
  assert.equal(parsed.version, '9.9.9-alpha.9')
  assert.equal(parsed.check, true)
  assert.equal(parsed.noArtifactRebuild, true)
  assert.equal(parsed.strict, true)
  assert.deepEqual(parsed.problems, [])
  assert.equal(parseArgs(['--help']).help, true)
  assert.deepEqual(parseArgs(['--help']).problems, [])
  assert.match(parseArgs([]).problems[0], /缺少 <tag>/u)
  assert.match(parseArgs(['dsh-v9.9-alpha.9']).problems[0], /不合法/u)
  assert.match(parseArgs(['dsh-v9.9.9-alpha.9', '--wirte']).problems[0], /未知参数 --wirte/u)
  assert.match(parseArgs(['dsh-v9.9.9-alpha.9', 'extra']).problems[0], /多余的位置参数/u)
})

test('pipelineSteps keeps the mechanical batch order and the write/check modes', () => {
  const write = pipelineSteps({})
  assert.deepEqual(write.map((step) => step.id), ['registry-views', 'verify-i18n', 'verify-upstream-touchpoints'])
  assert.deepEqual(write[0].args, ['--write'])
  assert.deepEqual(write[1].args, ['--write'])
  assert.deepEqual(write[2].args, [])
  const check = pipelineSteps({ check: true })
  assert.deepEqual(check[0].args, ['--check'])
  assert.deepEqual(check[1].args, [])
  assert.deepEqual(check[2].args, ['--no-artifact-rebuild'])
  assert.deepEqual(pipelineSteps({ noArtifactRebuild: true })[2].args, ['--no-artifact-rebuild'])
  for (const step of write) assert.equal(typeof step.script, 'string')
})

test('runPipeline prints the plan then runs the mechanical batch in order', () => {
  const current = currentRuntimeVersion()
  const fixture = anchorFixture({ target: current })
  const { lines, io } = capturingIo()
  const calls = []
  const code = runPipeline({
    parsed: parsedFor(current),
    io,
    readFile: fixture.readFile,
    runCommand: (step) => {
      calls.push(step.id + '|' + step.args.join(' '))
      return 0
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, ['registry-views|--write', 'verify-i18n|--write', 'verify-upstream-touchpoints|'])
  const text = lines.join('\n')
  assert.match(text, /锚点汇总：9\/9 已是目标版本/u)
  assert.match(text, /六锚 \+ 3 fork 字面量均已对齐目标版本/u)
})

test('runPipeline warns that pending anchors need manual application; --strict turns that red', () => {
  const current = currentRuntimeVersion()
  const fixture = anchorFixture({ target: TARGET, keepCurrent: new Set(ANCHOR_SITES.map((site) => site.id)) })
  const run = (strict) => {
    const { lines, io } = capturingIo()
    const calls = []
    const code = runPipeline({
      parsed: parsedFor(TARGET, { strict }),
      io,
      readFile: fixture.readFile,
      runCommand: (step) => {
        calls.push(step.id)
        return 0
      },
    })
    return { code, text: lines.join('\n'), calls }
  }
  const advisory = run(false)
  assert.equal(advisory.code, 0, 'pending anchors are normal output, not a failure')
  assert.deepEqual(advisory.calls, ['registry-views', 'verify-i18n', 'verify-upstream-touchpoints'])
  assert.match(advisory.text, /仍有 8 处锚字面量待人工应用/u)
  assert.match(advisory.text, /本管线只打印 diff、不写锚/u)
  const strict = run(true)
  assert.equal(strict.code, 1)
  assert.match(strict.text, /--strict: 六锚\/3 fork 未全部对齐目标版本/u)
})

test('runPipeline requires the derived lockfile anchor to be aligned too under --strict', () => {
  const fixture = anchorFixture({ target: TARGET })
  const run = (strict) => {
    const { lines, io } = capturingIo()
    const calls = []
    const code = runPipeline({
      parsed: parsedFor(TARGET, { strict }),
      io,
      readFile: fixture.readFile,
      runCommand: (step) => {
        calls.push(step.id)
        return 0
      },
    })
    return { code, text: lines.join('\n'), calls }
  }
  const advisory = run(false)
  assert.equal(advisory.code, 0, 'an unregenerated derived anchor is reported, not fatal')
  assert.deepEqual(advisory.calls, ['registry-views', 'verify-i18n', 'verify-upstream-touchpoints'])
  assert.match(advisory.text, /字面量已对齐，派生锚（运行时锁文件）待 bundle:dsh 重生成/u)
  const strict = run(true)
  assert.equal(strict.code, 1)
  assert.match(strict.text, /--strict: 六锚\/3 fork 未全部对齐目标版本/u)
})

test('runPipeline stops at the first failing mechanical step', () => {
  const current = currentRuntimeVersion()
  const fixture = anchorFixture({ target: current })
  const { io } = capturingIo()
  const calls = []
  const code = runPipeline({
    parsed: parsedFor(current),
    io,
    readFile: fixture.readFile,
    runCommand: (step) => {
      calls.push(step.id)
      return step.id === 'verify-i18n' ? 1 : 0
    },
  })
  assert.equal(code, 1)
  assert.deepEqual(calls, ['registry-views', 'verify-i18n'])
})

test('runPipeline refuses to run the batch when an anchor site cannot be located', () => {
  const current = currentRuntimeVersion()
  const fixture = anchorFixture({ target: current })
  const calls = []
  const code = runPipeline({
    parsed: parsedFor(current),
    io: capturingIo().io,
    readFile: (rel) => (rel === RUNTIME_LOCK ? 'not a lock\n' : fixture.readFile(rel)),
    runCommand: () => {
      calls.push('ran')
      return 0
    },
  })
  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('the pipeline script carries no live dsh version literal (C10 scans scripts/)', () => {
  const source = read('scripts/upstream/pin/pin-upgrade-pipeline.mjs')
  assert.doesNotMatch(source, /0\.\d+\.\d+-(?:alpha|beta|rc)\.\d+/u)
})
