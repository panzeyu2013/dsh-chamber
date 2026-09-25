/**
 * Unit lock for scripts/lib/test-manifest.mjs — the shared package test runner.
 *
 * The negative cases are the point: a child that exits 0 without executing a
 * node:test body, a manifest that lists nothing, and an empty group must all be
 * refused; only real pass/fail/skip corpora count as executed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DRAIN_GRACE_MS, MANIFEST_DUMP_PREFIX, collectEntries, emptyManifestProblems, evaluateChildRun,
  manifestLockstepProblems, parseExecutedTestCount, parseManifestDump, parseReportedTotals, resolveJobs,
  runEntries, selectManifest, spawnCaptured,
} from './test-manifest.mjs'

test('parseExecutedTestCount: spec summary counts executed bodies (pass + fail)', () => {
  const output = '\nℹ tests 7\nℹ suites 0\nℹ pass 6\nℹ fail 1\nℹ skipped 0\n'
  assert.equal(parseExecutedTestCount(output), 7)
})

test('parseExecutedTestCount: a zero-body child is null (never a green run)', () => {
  assert.equal(parseExecutedTestCount(''), null, 'no summary at all')
  assert.equal(parseExecutedTestCount('hello\n'), null, 'unrelated output only')
  assert.equal(parseExecutedTestCount('ℹ tests 0\nℹ pass 0\nℹ fail 0\n'), null, 'explicit zero tests')
  assert.equal(parseExecutedTestCount('ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 3\n'), null, 'all skipped')
})

test('parseExecutedTestCount: the TAP summary form is recognized', () => {
  assert.equal(parseExecutedTestCount('# tests 4\n# pass 3\n# fail 1\n'), 4)
})

test('parseExecutedTestCount: only the LAST summary block decides (nested runner transcript)', () => {
  const output = 'ℹ tests 9\nℹ pass 9\nℹ fail 0\nchild re-ran:\nℹ tests 2\nℹ pass 1\nℹ fail 1\n'
  assert.equal(parseExecutedTestCount(output), 2)
})

test('collectEntries: normalizes paths and { file, nodeArgs } entries in declaration order', () => {
  const entries = collectEntries({
    first: ['a.test.ts'],
    second: [{ file: 'b.test.ts', nodeArgs: ['--import', './loader.mjs'] }, 'c.test.ts'],
  })
  assert.deepEqual(entries, [
    { group: 'first', file: 'a.test.ts', nodeArgs: [] },
    { group: 'second', file: 'b.test.ts', nodeArgs: ['--import', './loader.mjs'] },
    { group: 'second', file: 'c.test.ts', nodeArgs: [] },
  ])
})

test('emptyManifestProblems: a manifest that would run zero children is a defect', () => {
  assert.deepEqual(emptyManifestProblems({}), ['the manifest declares no groups at all'])
  assert.deepEqual(emptyManifestProblems({ core: [] }), ["group 'core' lists zero test files"])
  assert.deepEqual(emptyManifestProblems({ core: ['a.test.ts'] }), [])
})

test('the zero-case guard is WIRED into the runner, not just exported', () => {
  const source = readFileSync(fileURLToPath(new URL('./test-manifest.mjs', import.meta.url)), 'utf8')
  assert.match(source, /const problems = emptyManifestProblems\(runGroups\)/u)
  assert.match(source, /evaluateChildRun\(entry\.file, result, entry\.zeroTestAllowlist \?\? zeroTestAllowlist, \{/u)
  assert.match(source, /requireNoSkips: entry\.requireNoSkips \?\? requireNoSkips/u)
  assert.match(source, /guard: entry\.guard \?\? guard,/u)
})

test('parseReportedTotals: the LAST summary block, nulls when the child never reported', () => {
  assert.deepEqual(parseReportedTotals(''), { tests: null, pass: null, fail: null, skipped: null })
  assert.deepEqual(
    parseReportedTotals('ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ skipped 0\n'),
    { tests: 3, pass: 2, fail: 1, skipped: 0 },
  )
  // A nested runner transcript: only the last block decides.
  assert.deepEqual(
    parseReportedTotals('ℹ tests 9\nℹ pass 9\nℹ fail 0\nℹ skipped 0\nℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n'),
    { tests: 2, pass: 0, fail: 0, skipped: 2 },
  )
  assert.deepEqual(parseReportedTotals('# tests 4\n# pass 4\n# fail 0\n# skipped 0\n'), { tests: 4, pass: 4, fail: 0, skipped: 0 })
})

test('evaluateChildRun: spawn failure, non-zero exit and no executed body are all red', () => {
  assert.equal(evaluateChildRun('a.test.ts', { status: null, signal: null, error: new Error('ENOENT') }).ok, false)
  assert.match(evaluateChildRun('a.test.ts', { status: null, signal: null, error: new Error('ENOENT') }).reason, /ENOENT/u)
  assert.equal(evaluateChildRun('a.test.ts', { status: 1, signal: null, stdout: '', stderr: '' }).ok, false)
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: '', stderr: '' }).ok, false, 'no summary')
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n' }).ok, false, 'tests 0')
  assert.equal(
    evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: 'ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 3\n' }).ok,
    false,
    'all skipped (the 2026-12 hole the old count guard had)',
  )
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n' }).ok, true)
})

test('evaluateChildRun: the allowlist is an explicit exception, requireNoSkips is the macOS-leg discipline', () => {
  const zeroBody = { status: 0, signal: null, stdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n' }
  assert.equal(evaluateChildRun('a.test.ts', zeroBody, [{ file: 'a.test.ts', reason: 'documented' }]).ok, true)
  assert.equal(evaluateChildRun('b.test.ts', zeroBody, [{ file: 'a.test.ts', reason: 'documented' }]).ok, false)
  const skipped = { status: 0, signal: null, stdout: 'ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ skipped 1\n' }
  assert.equal(evaluateChildRun('a.test.ts', skipped).ok, true, 'a partial skip is fine on the default leg')
  assert.equal(evaluateChildRun('a.test.ts', skipped, [], { requireNoSkips: true }).ok, false, 'the macOS leg must not skip')
})

test('selectManifest: platform legs are looked up in GROUPS (nodeArgs inherited), unknown files refused', () => {
  const groups = { core: ['a.test.ts'], args: [{ file: 'w.test.ts', nodeArgs: ['--import', './l.mjs'] }] }
  const platformFiles = { win32: ['w.test.ts'], macos: ['m.test.ts'] }
  assert.deepEqual(selectManifest({ groups, platformFiles, argv: [] }), { groups, leg: undefined })
  assert.deepEqual(selectManifest({ groups, platformFiles, argv: ['--win32'] }), {
    groups: { win32: [{ group: 'win32', file: 'w.test.ts', nodeArgs: ['--import', './l.mjs'] }] },
    leg: 'win32',
  })
  // The macOS file is not in GROUPS: the leg must be refused, not silently run anyway.
  assert.match(selectManifest({ groups, platformFiles, argv: ['--macos'] }).error, /outside GROUPS.*m\.test\.ts/u)
  assert.match(selectManifest({ groups, platformFiles, argv: ['--win32', '--macos'] }).error, /mutually exclusive/u)
  // A package without a leg keeps running its full manifest even when the flag is present.
  assert.deepEqual(selectManifest({ groups, platformFiles: {}, argv: ['--win32'] }), { groups, leg: undefined })
  // Some legs are standalone sets (files the general manifest deliberately does
  // not list, e.g. desktop's darwin-only lock/packaging suites); that must be an
  // explicit opt-in so the strict refusal stays the default.
  const standalone = selectManifest({ groups, platformFiles: { macos: ['m.test.ts'] }, argv: ['--macos'], allowPlatformFilesOutsideGroups: true })
  assert.equal(standalone.leg, 'macos')
  assert.deepEqual(standalone.groups.macos, [{ group: 'macos', file: 'm.test.ts', nodeArgs: [] }])
})

test('evaluateChildRun: guard "registered" keeps a fully platform-skipped file green, but tests 0 is still red', () => {
  const allSkipped = { status: 0, signal: null, stdout: 'ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n' }
  assert.equal(evaluateChildRun('a.test.ts', allSkipped).ok, false, 'the default executed-body guard refuses it')
  assert.equal(evaluateChildRun('a.test.ts', allSkipped, [], { guard: 'registered' }).ok, true)
  const zero = { status: 0, signal: null, stdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n' }
  assert.equal(evaluateChildRun('a.test.ts', zero, [], { guard: 'registered' }).ok, false, 'tests 0 stays red')
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: '' }, [], { guard: 'registered' }).ok, false, 'no summary stays red')
})

test('the per-file timeout is wired into the spawn, not just accepted as an option', () => {
  const source = readFileSync(fileURLToPath(new URL('./test-manifest.mjs', import.meta.url)), 'utf8')
  assert.match(source, /cwd: entry\.packageRoot \?\? packageRoot/u)
  assert.match(source, /timeoutMs: entry\.timeoutMs \?\? timeoutMs/u)
  assert.match(source, /timer = setTimeout\(\(\) => \{/u)
})

test('resolveJobs: --jobs wins over DSH_TEST_JOBS, the default is bounded, invalid values are refused', () => {
  const fallback = resolveJobs([], {})
  assert.ok('jobs' in fallback && fallback.jobs >= 1 && fallback.jobs <= 8, 'the default stays inside 1..8')
  assert.deepEqual(resolveJobs([], { DSH_TEST_JOBS: '7' }), { jobs: 7 })
  assert.deepEqual(resolveJobs(['--win32', '--jobs', '3'], { DSH_TEST_JOBS: '7' }), { jobs: 3 })
  assert.deepEqual(resolveJobs(['--jobs=2'], {}), { jobs: 2 })
  assert.match(resolveJobs(['--jobs', '0'], {}).error, /positive integer/u)
  assert.match(resolveJobs([], { DSH_TEST_JOBS: 'x' }).error, /positive integer/u)
})

/** A passing node:test fixture that prints its marker after the optional delay. */
const passingFixture = (marker, delayMs = 0) => [
  ...(delayMs === 0 ? [] : [`await new Promise((resolve) => setTimeout(resolve, ${String(delayMs)}))`]),
  "console.log('ℹ tests 1')",
  "console.log('ℹ pass 1')",
  `console.log('OUT-${marker}')`,
  '',
].join('\n')

test('runEntries: the bounded pool flushes transcripts in manifest order, not completion order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manifest-pool-'))
  try {
    writeFileSync(join(root, 'a-slow.test.mjs'), passingFixture('A', 150))
    writeFileSync(join(root, 'b-fast.test.mjs'), passingFixture('B'))
    const entries = [
      { group: 'g', file: 'a-slow.test.mjs', nodeArgs: [] },
      { group: 'g', file: 'b-fast.test.mjs', nodeArgs: [] },
    ]
    const log = []
    const out = []
    const { failed } = await runEntries(entries, {
      packageRoot: root,
      jobs: 2,
      log: line => log.push(line),
      writeStdout: text => out.push(text),
      writeStderr: () => {},
    })
    assert.equal(failed, null)
    const transcript = out.join('')
    assert.ok(transcript.includes('OUT-A') && transcript.includes('OUT-B'), 'both transcripts must be written')
    assert.ok(transcript.indexOf('OUT-A') < transcript.indexOf('OUT-B'),
      'manifest order must win over completion order (A is slow but declared first)')
    assert.deepEqual(log, ['\n=== g ==='])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runEntries: a failure stops new launches at the pool bound (fail-fast survives parallelism)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manifest-stop-'))
  try {
    writeFileSync(join(root, 'a-fail.test.mjs'), [
      "console.log('ℹ tests 1')",
      "console.log('ℹ pass 0')",
      "console.log('ℹ fail 1')",
      'process.exit(1)',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'b-slow.test.mjs'), passingFixture('B', 200))
    writeFileSync(join(root, 'c-never.test.mjs'), [
      "const { writeFileSync } = await import('node:fs')",
      "writeFileSync(new URL('./started-c', import.meta.url), 'x')",
      ...passingFixture('C').split('\n'),
    ].join('\n'))
    const entries = [
      { group: 'g', file: 'a-fail.test.mjs', nodeArgs: [] },
      { group: 'g', file: 'b-slow.test.mjs', nodeArgs: [] },
      { group: 'g', file: 'c-never.test.mjs', nodeArgs: [] },
    ]
    const { failed } = await runEntries(entries, {
      packageRoot: root,
      jobs: 2,
      log: () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    })
    assert.equal(failed?.entry.file, 'a-fail.test.mjs', 'the first failing entry in manifest order is reported')
    assert.equal(existsSync(join(root, 'started-c')), false, 'no new child may start after a failure is recorded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runEntries: command entries spawn their own invocation and pass on exit 0 alone', async () => {
  const entries = [
    { file: 'gate-ok', label: 'pnpm run gate:ok', group: '', command: process.execPath, args: ['-e', "console.log('ok')"], rawStatus: true },
    { file: 'gate-bad', label: 'pnpm run gate:bad', group: '', command: process.execPath, args: ['-e', 'process.exit(3)'], rawStatus: true },
  ]
  const log = []
  const { failed } = await runEntries(entries, {
    jobs: 2,
    log: line => log.push(line),
    writeStdout: () => {},
    writeStderr: () => {},
  })
  assert.equal(failed?.entry.file, 'gate-bad')
  assert.equal(failed.reason, 'exit 3')
  assert.deepEqual(log, ['\n=== pnpm run gate:ok ===', '\n=== pnpm run gate:bad ==='])
})

test('spawnCaptured: a leaked stdout-inheriting descendant cannot hold the capture past the drain grace', async t => {
  // The grandchild inherits stdout and outlives the child by 30s: 'close' alone
  // would keep this capture (and a pool slot) for the full 30s. After the child
  // exits, only buffered bytes remain, so the drain grace is a safe bound.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-drain-'))
  const pidFile = join(dir, 'pid')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'ignore'] })",
    "g.unref()",
    `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))`,
    "process.stdout.write('payload')",
  ].join(';')
  const startedAt = Date.now()
  const handle = spawnCaptured(process.execPath, ['-e', script], { drainGraceMs: 300 })
  try {
    const result = await handle.promise
    const elapsed = Date.now() - startedAt
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'payload', 'the child output is complete')
    assert.ok(elapsed >= 300 && elapsed < 5000, 'the capture is released by the grace, not by the survivor (' + elapsed + 'ms)')
    assert.match(result.stderr, /stdio stayed open 300ms after exit/,
      'the bounded release is loud: a truncated tail must be visible in the transcript')
    assert.ok(DEFAULT_DRAIN_GRACE_MS >= 1000, 'the production grace stays generous for slow pipes')
  } finally {
    // Never leave the simulated survivor behind for the rest of the suite.
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
})

test('spawnCaptured: a large stdout write is captured in full, not just up to process exit', async () => {
  // 1 MiB fills the pipe buffer several times over, so the child stays alive
  // while the parent drains and the process exits with bytes still queued: the
  // capture must wait for the pipe EOF ('close'), not for the process exit —
  // an exit-time snapshot intermittently lost the manifest dump line.
  const bytes = 1024 * 1024
  const handle = spawnCaptured(process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}))`], {})
  const result = await handle.promise
  assert.equal(result.status, 0)
  assert.equal(result.stdout.length, bytes, 'the pipe must be drained through close, not process exit')
})

test('runEntries: schedule reorders launches but not transcript flushes', async () => {
  const entries = [
    { file: 'a', label: 's', group: 'g', nodeArgs: [], rawStatus: true },
    { file: 'b', label: 's', group: 'g', nodeArgs: [], rawStatus: true },
    { file: 'c', label: 's', group: 'g', nodeArgs: [], rawStatus: true },
  ]
  const launched = []
  const out = []
  const runner = (entry) => {
    launched.push(entry.file)
    return {
      promise: Promise.resolve({ status: 0, signal: null, stdout: 'OUT-' + entry.file, stderr: '' }),
      kill() {},
    }
  }
  const { failed } = await runEntries(entries, {
    jobs: 1,
    schedule: [2, 0, 1],
    runner,
    log: () => {},
    writeStdout: text => out.push(text),
    writeStderr: () => {},
  })
  assert.equal(failed, null)
  assert.deepEqual(launched, ['c', 'a', 'b'], 'the schedule is the launch order')
  assert.equal(out.join(''), 'OUT-aOUT-bOUT-c', 'the transcript still flushes in declaration order')
})

test('parseManifestDump: the last marker line wins; malformed or absent payloads are null', () => {
  const good = { entries: [], packageRoot: '/p', label: 'x' }
  assert.deepEqual(parseManifestDump('noise\n' + MANIFEST_DUMP_PREFIX + JSON.stringify(good)), good)
  assert.equal(parseManifestDump('noise only'), null)
  assert.equal(parseManifestDump(MANIFEST_DUMP_PREFIX + 'not-json'), null)
  assert.equal(parseManifestDump(MANIFEST_DUMP_PREFIX + '{"entries":"x","packageRoot":"/p"}'), null)
})

test('the dump switch is wired into the runner after its validation path', () => {
  const source = readFileSync(fileURLToPath(new URL('./test-manifest.mjs', import.meta.url)), 'utf8')
  assert.match(source, /env\[MANIFEST_DUMP_ENV\] === '1'/u)
  assert.match(source, /MANIFEST_DUMP_PREFIX \+ JSON\.stringify/u)
})

test('runEntries: pre-run rawStatus sections are ordered, flushed and judged by exit status alone', async () => {
  const entries = [
    { file: 'chain-a', label: 'step-a', group: 'step', rawStatus: true, preResult: { status: 0, signal: null, stdout: 'A', stderr: '' } },
    { file: 'chain-b', label: 'step-b', group: 'step', rawStatus: true, preResult: { status: 1, signal: null, stdout: 'B', stderr: '' } },
  ]
  const log = []
  const out = []
  const { failed, failures } = await runEntries(entries, {
    jobs: 2,
    log: line => log.push(line),
    writeStdout: text => out.push(text),
    writeStderr: () => {},
  })
  assert.equal(failed?.entry.file, 'chain-b')
  assert.equal(failures.length, 1)
  assert.deepEqual(log, ['\n=== step-a / step ===', '\n=== step-b / step ==='])
  assert.equal(out.join(''), 'AB', 'pre-run transcripts flush in entry order')
})

test('runEntries: keepGoing collects every failure instead of stopping at the first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manifest-keepgoing-'))
  try {
    const failingFixture = ["console.log('ℹ tests 1')", "console.log('ℹ fail 1')", 'process.exit(1)', ''].join('\n')
    writeFileSync(join(root, 'a-fail.test.mjs'), failingFixture)
    writeFileSync(join(root, 'b-pass.test.mjs'), passingFixture('B'))
    writeFileSync(join(root, 'c-fail.test.mjs'), failingFixture)
    const { failed, failures } = await runEntries([
      { group: 'g', file: 'a-fail.test.mjs', nodeArgs: [] },
      { group: 'g', file: 'b-pass.test.mjs', nodeArgs: [] },
      { group: 'g', file: 'c-fail.test.mjs', nodeArgs: [] },
    ], {
      packageRoot: root,
      jobs: 1,
      keepGoing: true,
      log: () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    })
    assert.equal(failed?.entry.file, 'a-fail.test.mjs')
    assert.deepEqual(failures.map(record => record.entry.file), ['a-fail.test.mjs', 'c-fail.test.mjs'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runEntries: an unanswered child is killed at timeoutMs and fails as ETIMEDOUT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manifest-timeout-'))
  try {
    // The interval keeps the child alive: a bare unsettled top-level await makes
    // node exit 13 on its own, which would test that exit code and not the timer.
    writeFileSync(join(root, 'hang.test.mjs'), 'setInterval(() => {}, 1000)\nawait new Promise(() => {})\n')
    const started = Date.now()
    const { failed } = await runEntries([{ group: 'g', file: 'hang.test.mjs', nodeArgs: [] }], {
      packageRoot: root,
      jobs: 1,
      timeoutMs: 250,
      log: () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    })
    assert.equal(failed?.entry.file, 'hang.test.mjs')
    assert.match(failed.reason, /ETIMEDOUT/u)
    assert.ok(Date.now() - started < 5_000, 'the per-file timeout must end the child, not the suite')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('evaluateChildRun names the real failure mode: timeout/overflow are not 无法启动', () => {
  const timedOut = evaluateChildRun('x.test.ts', { error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) })
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.reason, /按文件超时/u)
  assert.doesNotMatch(timedOut.reason, /无法启动/u, 'a killed-but-started child is not a launch failure')

  const overflowed = evaluateChildRun('x.test.ts', { error: Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }) })
  assert.equal(overflowed.ok, false)
  assert.match(overflowed.reason, /输出超限/u)
  assert.doesNotMatch(overflowed.reason, /无法启动/u)

  const notSpawned = evaluateChildRun('x.test.ts', { error: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) })
  assert.equal(notSpawned.ok, false)
  assert.match(notSpawned.reason, /无法启动/u, 'only a genuine launch error keeps that wording')
})

test('manifestLockstepProblems: a whole manifest passes and every defect is named', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manifest-lockstep-'))
  try {
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'a.test.ts'), '')
    writeFileSync(join(root, 'nested', 'b.test.mjs'), '')
    assert.deepEqual(
      manifestLockstepProblems({
        packageRoot: root,
        groups: { unit: ['a.test.ts'], nested: ['nested/b.test.mjs'] },
      }),
      [],
    )
    // An on-disk file that is not listed is a defect (a new test must be wired).
    assert.deepEqual(
      manifestLockstepProblems({ packageRoot: root, groups: { unit: ['a.test.ts'] } }),
      ['on-disk test file is not listed: nested/b.test.mjs'],
    )
    // A listed file that is not on disk is a defect.
    assert.deepEqual(
      manifestLockstepProblems({ packageRoot: root, groups: { unit: ['a.test.ts', 'nested/b.test.mjs', 'ghost.test.ts'] } }),
      ['listed test file is missing on disk: ghost.test.ts'],
    )
    // Duplicates and a platform leg outside GROUPS are defects.
    const groupProblems = manifestLockstepProblems({
      packageRoot: root,
      groups: { unit: ['a.test.ts', 'nested/b.test.mjs', 'a.test.ts'] },
      platformFiles: { win32: ['outside.test.ts'] },
      platformSubsetsOfGroups: ['win32'],
    })
    assert.ok(groupProblems.some(problem => problem.includes('lists a file twice')), groupProblems.join('; '))
    assert.ok(groupProblems.some(problem => problem.includes('win32 file is not in GROUPS')), groupProblems.join('; '))
    // The allowlist must carry a reason and a real file.
    assert.deepEqual(
      manifestLockstepProblems({
        packageRoot: root,
        groups: { unit: ['a.test.ts', 'nested/b.test.mjs'] },
        allowlist: [{ file: 'ghost.test.ts', reason: ' ' }],
      }),
      ['allowlist entry has no reason: ghost.test.ts'],
    )
    // Empty discovery cannot pass the lockstep silently.
    const empty = mkdtempSync(join(tmpdir(), 'dsh-manifest-empty-'))
    try {
      assert.deepEqual(
        manifestLockstepProblems({ packageRoot: empty, groups: { unit: ['a.test.ts'] } }),
        [
          'no test file was discovered — the lockstep assertion would be fooled by an empty set',
          'listed test file is missing on disk: a.test.ts',
        ],
      )
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
