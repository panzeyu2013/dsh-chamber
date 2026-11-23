/**
 * Official `plugin:worktree/entered` record interop lock (design 08 §4.2;
 * alpha.1 worktree projection).
 *
 * WHY: alpha.1's `exit_worktree` returns a Session to the checkout it entered
 * from ONLY when the Session log carries an entry record; the chamber seed enters
 * a checkout by committing the working directory alone, and alpha.1 removed the
 * model's `working_directory` tool — so without this record a chamber-created
 * Session in a checkout has no path back (`WORKTREE_NOT_ENTERED`). The three arms
 * below pin the three silent failure modes:
 * 1. PAYLOAD — the strict upstream schema skips a malformed payload silently
 *    (`enteredWorktreeSchema.safeParse` → return state unchanged), so shape and
 *    the detached-HEAD omission are asserted here;
 * 2. RECORD NAME — a pin bump that renames the literal would leave our writer
 *    producing a row nobody folds;
 * 3. WIRING — the record must be appended by `enterSession` after the directory
 *    commit (and it must be the ENTERED record, never `created`, whose rows the
 *    upstream archive cleanup may reclaim).
 * Missing vendor tree fails LOUDLY; `DSH_CHAMBER_VENDOR_ABSENT=skip` is the only skip.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripComments } from '../../../scripts/dev/test-support/source-text.ts'
import { ENTERED_PATH_MEMORY_LIMIT, ENTERED_RECORD, enteredWorktreeRecord, rememberEnteredPath } from '../src/enter-record.ts'

/** The pinned vendor worktree package (the reader of the record we write). */
const VENDOR_WORKTREE = fileURLToPath(new URL(
  '../../../vendor/harness-packages/@deepseek-ai/dsh-experimental-worktree/src/', import.meta.url))
const MISSING = !existsSync(VENDOR_WORKTREE + 'projection.ts')
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

const vendor = (name: string): string => readFileSync(VENDOR_WORKTREE + name, 'utf8')
const own = (name: string): string => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')

const seeIt = (name: string, body: () => void): void => {
  test(name, { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages/@deepseek-ai/dsh-experimental-worktree is not materialized; '
        + 'this lock must stay loud (explicit DSH_CHAMBER_VENDOR_ABSENT=skip is the only skip)')
    }
    body()
  })
}

test('the entered payload is the strict upstream shape', () => {
  assert.deepEqual(enteredWorktreeRecord('/repo/.agents/worktrees/t', '/repo'),
    { path: '/repo/.agents/worktrees/t', repositoryRoot: '/repo' },
    'a detached checkout omits branch: the upstream schema requires a non-empty string when present')
  assert.deepEqual(enteredWorktreeRecord('/repo/.agents/worktrees/t', '/repo', 'topic'),
    { path: '/repo/.agents/worktrees/t', branch: 'topic', repositoryRoot: '/repo' })
  assert.deepEqual(enteredWorktreeRecord('/repo/.agents/worktrees/t', '/repo', ''),
    { path: '/repo/.agents/worktrees/t', repositoryRoot: '/repo' },
    'an empty branch is omitted, never written as an invalid empty string')
})

test('the record literal is the official projection type', () => {
  assert.equal(ENTERED_RECORD, 'plugin:worktree/entered')
})

seeIt('the pinned upstream projection still folds this record name and payload', () => {
  const projection = stripComments(vendor('projection.ts'))
  assert.match(projection, /ENTERED_RECORD = 'plugin:worktree\/entered'/u,
    'the pinned worktree projection must still name the entered record we write')
  // The strict payload: path + optional branch + repositoryRoot.
  const schemaAt = projection.indexOf('enteredWorktreeSchema: z.ZodType<EnteredWorktree> = z.object({')
  assert.notEqual(schemaAt, -1, 'the pinned projection must validate the entered payload')
  const schemaEnd = projection.indexOf('}).strict()', schemaAt) + '}).strict()'.length
  const schema = projection.slice(schemaAt, schemaEnd)
  for (const field of ['path: z.string().min(1)', 'repositoryRoot: z.string().min(1)']) {
    assert.ok(schema.includes(field), 'the entered schema must require ' + field)
  }
  assert.match(schema, /branch: z\.string\(\)\.min\(1\)\.exactOptional\(\)/u,
    'branch must stay optional-string in the pinned schema')
  assert.match(schema, /\.strict\(\)/u, 'the entered payload is strict: extra fields are rejected')
  // The exit path is what reads repositoryRoot: our record is only useful if exit consumes it.
  const index = stripComments(vendor('index.ts'))
  assert.match(index, /workingDirectory\.set\(agent, left\.repositoryRoot/u,
    'exit_worktree must still return the Session to the recorded repositoryRoot')
  assert.match(index, /WORKTREE_NOT_ENTERED/u, 'exit refuses without a recorded entry (the gap this record closes)')
})

test('enterSession appends the entered record after the directory commit', () => {
  const source = stripComments(own('index.ts'))
  assert.equal((source.match(/appendEnteredRecord\(/gu) ?? []).length, 1,
    'exactly one entered-record writer call in the gateway')
  const call = source.indexOf('appendEnteredRecord(')
  const commit = source.indexOf('workingDirectory.set(agent, entered.path)')
  assert.notEqual(commit, -1, 'the enter path commits the working directory')
  assert.ok(call > commit, 'the record is appended AFTER the directory commit (a refused enter records nothing)')
  assert.match(source, /enteredWorktreeRecord\(entered\.path, entered\.repositoryRoot, entered\.branch\)/u,
    'the payload carries the validated entered path, the entered-from root and the branch')
  assert.doesNotMatch(source, /plugin:worktree\/created/u,
    'the seed must never write created: upstream archive cleanup may reclaim created checkouts (design 08 §1 第 5 条)')
})

test('rememberEnteredPath: repeated same-path enters are idempotent and the memory is bounded', () => {
  const memory = new Map<string, string>()
  assert.equal(rememberEnteredPath(memory, 's1', '/repo/wt'), true, 'first enter appends')
  assert.equal(rememberEnteredPath(memory, 's1', '/repo/wt'), false, 'same path does not duplicate the record')
  assert.equal(rememberEnteredPath(memory, 's1', '/repo/wt2'), true, 'a different path appends')
  memory.clear()
  for (let i = 0; i <= ENTERED_PATH_MEMORY_LIMIT; i += 1) {
    rememberEnteredPath(memory, 's' + i, '/repo/wt-' + i)
  }
  assert.equal(memory.size, ENTERED_PATH_MEMORY_LIMIT, 'the map is capped (oldest entry evicted)')
  assert.equal(memory.has('s0'), false, 'oldest evicted')
  assert.equal(memory.has('s' + ENTERED_PATH_MEMORY_LIMIT), true, 'newest retained')
})

test('wiring: the gateway appends the entered record BEFORE remembering the path', () => {
  const index = own('index.ts')
  const appendAt = index.indexOf('appendEnteredRecord(')
  const rememberAt = index.indexOf('rememberEnteredPath(this.lastEnteredPath')
  assert.ok(appendAt >= 0 && rememberAt >= 0, 'both calls are present')
  assert.ok(appendAt < rememberAt,
    'remember-after-append: a throwing append must stay retryable (remember-first would skip it forever)')
  assert.match(index, /this\.lastEnteredPath\.get\(sessionId\) !== entered\.path/, 'repeated same-path enters stay idempotent')
})
