/**
 * Unit tests for the script-test manifest runner: argument resolution, the
 * both-directions manifest check (listed-but-missing, on-disk-but-unlisted,
 * duplicated) and the naming rule with its SUBJECT_TESTS escape hatch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUPS, SUBJECT_TESTS, manifestProblems, resolveSelection } from './run-script-tests.mjs'

test('no arguments select every group in declaration order', () => {
  const selection = resolveSelection([])
  assert.deepEqual(selection.problems, [])
  assert.deepEqual(selection.groups, Object.keys(GROUPS))
  assert.equal(selection.list, false)
})

test('--group selects one group, repeats dedupe, and unknown names are usage errors', () => {
  assert.deepEqual(resolveSelection(['--group', 'upstream']).groups, ['upstream'])
  assert.deepEqual(resolveSelection(['--group', 'upstream', '--group', 'release']).groups, ['upstream', 'release'])
  assert.deepEqual(resolveSelection(['--group', 'upstream', '--group', 'upstream']).groups, ['upstream'])
  assert.deepEqual(resolveSelection(['--group', 'nope']).problems, [`unknown group 'nope' (known: gates, upstream, release, gui-acceptance)`])
  assert.deepEqual(resolveSelection(['--group']).problems, ['--group needs a group name'])
  assert.deepEqual(resolveSelection(['--verbose']).problems, [`unknown argument '--verbose'`])
  assert.equal(resolveSelection(['--list']).list, true)
})

test('a manifest that matches the tree reports nothing', () => {
  const problems = manifestProblems({
    listed: [{ group: 'gates', path: 'scripts/gates/a.test.mjs' }],
    onDisk: ['scripts/gates/a.test.mjs'],
    moduleExists: () => true,
    subjects: [],
  })
  assert.deepEqual(problems, [])
})

test('both directions of drift are failures: listed-but-missing and on-disk-but-unlisted', () => {
  const problems = manifestProblems({
    listed: [
      { group: 'gates', path: 'scripts/gates/gone.test.mjs' },
      { group: 'release', path: 'scripts/release/dup.test.mjs' },
      { group: 'upstream', path: 'scripts/release/dup.test.mjs' },
    ],
    onDisk: ['scripts/release/dup.test.mjs', 'scripts/upstream/orphan.test.mjs'],
    moduleExists: () => true,
    subjects: [],
  })
  assert.deepEqual(problems, [
    'scripts/gates/gone.test.mjs is listed by \'gates\' but does not exist',
    'scripts/release/dup.test.mjs is listed twice (release and upstream)',
    'scripts/upstream/orphan.test.mjs exists but no group lists it',
  ])
})

test('a non-mjs test under scripts/ is reported instead of silently ignored', () => {
  const problems = manifestProblems({
    listed: [],
    onDisk: ['scripts/gates/legacy.test.ts'],
    moduleExists: () => true,
    subjects: [],
  })
  assert.deepEqual(problems, ['scripts/gates/legacy.test.ts must be a .test.mjs: the scripts suites are ESM files this manifest owns (scripts/README.md §分类规则 3)'])
})

test('a stem without a sibling module must be an accepted subject lock', () => {
  const listed = [{ group: 'release', path: 'scripts/release/policy.test.mjs' }]
  const onDisk = ['scripts/release/policy.test.mjs']
  const violations = manifestProblems({ listed, onDisk, moduleExists: () => false, subjects: [] })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /must be named after the module it tests \(missing scripts\/release\/policy\.mjs\), or listed in SUBJECT_TESTS/)
  assert.deepEqual(
    manifestProblems({
      listed,
      onDisk,
      moduleExists: () => false,
      subjects: [{ path: 'scripts/release/policy.test.mjs', reason: 'accepted for this test' }],
    }),
    [],
  )
})

test('a stale SUBJECT_TESTS entry is a failure, so the allowlist cannot rot', () => {
  const problems = manifestProblems({
    listed: [{ group: 'gates', path: 'scripts/gates/a.test.mjs' }],
    onDisk: ['scripts/gates/a.test.mjs'],
    moduleExists: () => true,
    subjects: [{ path: 'scripts/gates/vanish.test.mjs', reason: 'no longer listed' }],
  })
  assert.deepEqual(problems, ['SUBJECT_TESTS lists scripts/gates/vanish.test.mjs, but no group carries it — drop the entry'])
})

test('the shipped manifest is self-consistent: unique entries, real reasons, no stale subject lock', () => {
  const listed = Object.entries(GROUPS).flatMap(([group, files]) => files.map(path => ({ group, path })))
  const paths = listed.map(entry => entry.path)
  assert.equal(new Set(paths).size, paths.length, 'a file belongs to exactly one group')
  assert.equal(new Set(listed.map(entry => entry.group)).size, Object.keys(GROUPS).length)
  for (const entry of SUBJECT_TESTS) {
    assert.ok(paths.includes(entry.path), `${entry.path} must be listed by a group`)
    assert.ok(entry.path.startsWith('scripts/'), 'subject locks live under scripts/')
    assert.ok(entry.reason.length > 20, 'a subject lock needs the reason a reviewer accepted')
  }
})
