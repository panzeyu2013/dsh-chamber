/**
 * Unit tests for the CI change classifier (scripts/dev/classify-ci-changes.mjs).
 *
 * The classifier decides whether the expensive CI chain runs, so its fail-safe
 * direction is the property under test: anything it cannot prove to be prose
 * must come back as `code: true`. Wired into `pnpm run test:upgrade-tools`,
 * which both CI and the release validation run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROSE_ONLY_FILES, PROSE_ONLY_PREFIXES, changedPathsForEvent, classifyChangedPaths } from './classify-ci-changes.mjs'

test('prose-only change skips the expensive chain', () => {
  const result = classifyChangedPaths(['docs/progress/STATUS.md', 'docs/design/09-frontend.md', 'CHANGELOG.md', 'docs/CHANGELOG.en-US.md'])
  assert.equal(result.code, false, result.reason)
  assert.equal(result.prose.length, 4)
  assert.deepEqual(result.codePaths, [])
})

test('anything outside the prose allowlist is code', () => {
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'harness.commit',
    'pnpm-workspace.yaml',
    '.github/workflows/ci.yml',
    'scripts/dev/release-preflight.mjs',
    'packages/renderer/src/main.ts',
    'vendor/harness-packages/@deepseek-ai/dsh-client-web/package.json',
    'tsconfig.json',
    '.gitignore',
    'docs-like/notes.md',
    'README.md.bak',
  ]) {
    assert.equal(classifyChangedPaths([path]).code, true, `${path} must count as code`)
  }
})

test('a mixed change is code — the prose part never dilutes it', () => {
  const result = classifyChangedPaths(['docs/progress/STATUS.md', 'packages/cli/package.json'])
  assert.equal(result.code, true)
  assert.deepEqual(result.prose, ['docs/progress/STATUS.md'])
  assert.deepEqual(result.codePaths, ['packages/cli/package.json'])
  assert.match(result.reason, /packages\/cli\/package\.json/)
})

test('unknown or empty input fails safe', () => {
  for (const input of [undefined, null, [], 'docs/x.md', 42]) {
    const result = classifyChangedPaths(input)
    assert.equal(result.code, true, `input ${JSON.stringify(input)} must fail safe`)
    assert.match(result.reason, /fail-safe/)
  }
})

test('path traversal and directory-shaped entries are never prose', () => {
  for (const path of ['docs/../packages/x.ts', '../docs/x.md', 'docs/', './docs/../AGENTS.md', '']) {
    assert.equal(classifyChangedPaths([path]).code, true, `${JSON.stringify(path)} must count as code`)
  }
  // A leading `./` is normalized, not treated as unknown.
  assert.equal(classifyChangedPaths(['./docs/README.md']).code, false)
  assert.deepEqual(classifyChangedPaths(['./AGENTS.md']).prose, ['AGENTS.md'])
})

test('every allowlisted prefix/file is covered by a real path shape', () => {
  for (const prefix of PROSE_ONLY_PREFIXES) assert.equal(classifyChangedPaths([`${prefix}some/file.md`]).code, false, prefix)
  for (const file of PROSE_ONLY_FILES) assert.equal(classifyChangedPaths([file]).code, false, file)
})

test('push events diff the pushed range', () => {
  const calls = []
  const run = args => {
    calls.push(args)
    return { status: 0, stdout: 'docs/a.md\npackages/b.ts\n', stderr: '' }
  }
  const result = changedPathsForEvent({ eventName: 'push', before: 'a'.repeat(40), after: 'b'.repeat(40) }, run)
  assert.deepEqual(calls, [['diff', '--name-only', 'a'.repeat(40), 'b'.repeat(40)]])
  assert.deepEqual(result.paths, ['docs/a.md', 'packages/b.ts'])
  assert.match(result.note, /^aaaaaaaa\.\.bbbbbbbb$/)
})

test('pull requests diff against the base commit', () => {
  const calls = []
  const run = args => {
    calls.push(args)
    return { status: 0, stdout: 'docs/a.md\n', stderr: '' }
  }
  changedPathsForEvent({ eventName: 'pull_request', baseSha: 'c'.repeat(40), after: 'd'.repeat(40) }, run)
  assert.deepEqual(calls, [['diff', '--name-only', 'c'.repeat(40), 'd'.repeat(40)]])
})

test('untrustworthy ranges and git failures return no list (fail-safe upstream)', () => {
  const neverRun = () => assert.fail('git must not be called without a trustworthy range')
  assert.equal(changedPathsForEvent({ eventName: 'push', before: '0'.repeat(40), after: 'b'.repeat(40) }, neverRun).paths, null)
  assert.equal(changedPathsForEvent({ eventName: 'push', before: '', after: 'b'.repeat(40) }, neverRun).paths, null)
  assert.equal(changedPathsForEvent({ eventName: 'pull_request', baseSha: '', after: 'b'.repeat(40) }, neverRun).paths, null)
  const failing = changedPathsForEvent({ eventName: 'push', before: 'a'.repeat(40), after: 'b'.repeat(40) }, () => ({ status: 128, stdout: '', stderr: 'fatal: bad revision\n' }))
  assert.equal(failing.paths, null)
  assert.match(failing.note, /git diff failed: fatal: bad revision/)
})
