/**
 * verify-upstream-touchpoints.mjs argument-guard tests (2026-12 review P2).
 *
 * Two halves, because they answer two different questions:
 *   1. PURE: `parseVerifyArgs` pins the accepted surface and every rejection
 *      reason (the gate script itself is a top-level program — importing it
 *      would run C1/C3–C10, so the decision logic lives in its own module, the
 *      same split artifact-gate.mjs uses).
 *   2. WIRING (subprocess): the script must actually consult the guard BEFORE
 *      any gate runs. That matters more than the parse result: the default mode
 *      rebuilds and restores the committed artifacts in place, so a silently
 *      ignored argument means a full write pass the caller never asked for. The
 *      regression therefore also asserts that a usage error leaves an artifact's
 *      mtime untouched and prints no gate marker.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USAGE_EXIT_CODE, VERIFY_USAGE, parseVerifyArgs } from './verify-upstream-touchpoints-args.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'verify-upstream-touchpoints.mjs')
/** Any committed artifact C8 rewrites in default mode (witness for "no write"). */
const witnessArtifact = join(here, '..', '..', 'packages', 'dsh-runtime', 'dist', 'index.js')

const run = (...argv) => spawnSync(process.execPath, [scriptPath, ...argv], {
  cwd: join(here, '..', '..'),
  encoding: 'utf8',
})

test('no arguments means the documented default run (no help, no usage error)', () => {
  assert.deepEqual(parseVerifyArgs([]), { help: false, noArtifactRebuild: false, tags: null, errors: [] })
})

test('--no-artifact-rebuild is accepted in either position and never duplicated', () => {
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuild']), {
    help: false, noArtifactRebuild: true, tags: null, errors: [],
  })
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuild', '--tags', 'v1', 'v2']), {
    help: false, noArtifactRebuild: true, tags: ['v1', 'v2'], errors: [],
  })
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuild', '--no-artifact-rebuild']).errors, [
    '重复的 --no-artifact-rebuild（第 2 个参数）',
  ])
})

test('--tags requires exactly two tag values', () => {
  assert.deepEqual(parseVerifyArgs(['--tags', 'v0.1.0-rc.7', 'v0.1.0-rc.8']).tags, ['v0.1.0-rc.7', 'v0.1.0-rc.8'])
  // A missing/flag-looking value used to fall through to a silent full run.
  assert.match(parseVerifyArgs(['--tags', 'v1']).errors.join('\n'), /--tags 需要恰好两个 tag 值/)
  assert.match(parseVerifyArgs(['--tags']).errors.join('\n'), /--tags 需要恰好两个 tag 值（得到 无）/)
  assert.match(parseVerifyArgs(['--tags', '--no-artifact-rebuild']).errors.join('\n'), /--tags 需要恰好两个 tag 值/)
  assert.match(parseVerifyArgs(['--tags', 'a', 'b', 'c']).errors.join('\n'), /不接受位置参数 c/)
  assert.match(parseVerifyArgs(['--tags', 'a', 'b', '--tags', 'c', 'd']).errors.join('\n'), /重复的 --tags/)
})

test('every unrecognized argument is an error — a typo can never be ignored', () => {
  // The near-miss that motivated the guard: one missing letter in the only
  // flag that suppresses the in-place artifact rebuild.
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuid']).errors, [
    '未知参数 --no-artifact-rebuid（已知：--no-artifact-rebuild, --tags, --help, -h）',
  ])
  for (const argument of ['--tag', '--tags=v1', '--verbose', '-x', '--']) {
    assert.match(parseVerifyArgs([argument]).errors.join('\n'), /未知参数/, `${argument} must be rejected`)
  }
  assert.match(parseVerifyArgs(['run']).errors.join('\n'), /不接受位置参数 run/)
})

test('--help wins over everything else and is the only zero-error early exit', () => {
  assert.equal(parseVerifyArgs(['--help']).help, true)
  assert.equal(parseVerifyArgs(['-h']).help, true)
  assert.equal(parseVerifyArgs(['--help', '--no-artifact-rebuild']).help, true)
  const withTypo = parseVerifyArgs(['--help', '--nope'])
  assert.equal(withTypo.help, true)
  assert.deepEqual(withTypo.errors, [], 'help short-circuits before validation, like every standard CLI')
  assert.equal(parseVerifyArgs(['--no-artifact-rebuild']).help, false)
})

test('usage text documents every accepted flag and both exit codes', () => {
  for (const fragment of ['--no-artifact-rebuild', '--tags <old> <new>', '--help, -h', '退出码', '就地重建']) {
    assert.ok(VERIFY_USAGE.includes(fragment), `usage text must document ${fragment}`)
  }
  assert.equal(USAGE_EXIT_CODE, 2)
  assert.equal(VERIFY_USAGE.startsWith('verify-upstream-touchpoints'), true)
})

test('the script exits 2 on an unknown argument without running a single gate or writing an artifact', () => {
  const before = statSync(witnessArtifact).mtimeMs
  const result = run('--no-artifact-rebuid')
  assert.equal(result.status, USAGE_EXIT_CODE, `unknown argument must exit ${USAGE_EXIT_CODE} (got ${result.status})`)
  assert.match(result.stderr, /未知参数 --no-artifact-rebuid/)
  assert.match(result.stderr, /--no-artifact-rebuild/)
  assert.doesNotMatch(result.stdout, /[✓] C\d/, 'no gate may run before the guard')
  assert.doesNotMatch(result.stdout, /C8/, 'the in-place artifact rebuild must never start for a usage error')
  assert.equal(statSync(witnessArtifact).mtimeMs, before, 'a usage error must not touch any artifact')
})

test('--help prints the usage text, runs no gate and exits 0', () => {
  const before = statSync(witnessArtifact).mtimeMs
  const result = run('--help')
  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes(VERIFY_USAGE), '--help must print the module\'s single usage text')
  assert.doesNotMatch(result.stdout, /[✓] C\d/, '--help must short-circuit before the gates')
  assert.doesNotMatch(result.stdout, /C8 提交态生成物/, '--help must never reach the rebuild gate')
  assert.equal(statSync(witnessArtifact).mtimeMs, before, '--help must not touch any artifact')
})

/** Argument text of every `await import(...)` call in a source file (balanced-paren scan). */
function dynamicImportArguments(source) {
  const args = []
  const marker = 'await import('
  let from = 0
  for (;;) {
    const at = source.indexOf(marker, from)
    if (at === -1) return args
    let depth = 1
    let i = at + marker.length
    const start = i
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') depth -= 1
      i += 1
    }
    args.push(source.slice(start, i - 1))
    from = i
  }
}

test('every dynamic import in the gate goes through pathToFileURL (Windows ESM scheme trap)', () => {
  // Regression lock for the test-windows leg: Node's ESM loader accepts only
  // file:/data:/node: URLs, so `import(join(ROOT, 'x.mjs'))` reads a Windows
  // absolute path as the scheme 'd:' and the gate dies instantly with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — while staying green on every POSIX leg
  // (2026-09-11 CI: C1/C3/C4 green, then the C4 assembly-contract import).
  const args = dynamicImportArguments(readFileSync(scriptPath, 'utf8'))
  assert.ok(args.length >= 3, `expected the gate's dynamic imports, found ${args.length}`)
  for (const argument of args) {
    assert.match(
      argument,
      /pathToFileURL\(/,
      `a dynamic import must not take a raw path (import(${argument.trim().replace(/\s+/g, ' ')})）`,
    )
  }
})
