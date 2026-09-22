/**
 * Git action-error i18n boundary: the logic layer mints
 * structured codes, the presentation layer resolves them to locales copy, and
 * the en dictionary can never fall back to Chinese. Source locks keep the raw
 * messages English so the unmapped fallback stays honest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  GitActionError, gitActionErrorCode, gitActionErrorText, gitActionErrorTextFor,
} from '../../src/shared/action-error.ts'
import { removeFailureCopyKey } from '../../src/shared/remove-notes.ts'
import { GitWorktreeRpcError } from '../../src/shared/git-api.ts'
import { GitSagaError } from '../../src/shared/saga.ts'
import { en, zh, type GitSidebarKey } from '../../src/locales.ts'

const ACTION_ERROR_SOURCE = readFileSync(new URL('../../src/shared/action-error.ts', import.meta.url), 'utf8')
const COORDINATOR_SOURCE = readFileSync(new URL('../../src/shared/coordinator.ts', import.meta.url), 'utf8')
const API_SOURCE = readFileSync(new URL('../../src/shared/git-api.ts', import.meta.url), 'utf8')
const SAGA_SOURCE = readFileSync(new URL('../../src/shared/saga.ts', import.meta.url), 'utf8')
const SNAPSHOT_SOURCE = readFileSync(new URL('../../src/shared/snapshot.ts', import.meta.url), 'utf8')
const REMOVE_DIALOG_SOURCE = readFileSync(new URL('../../src/client/RemoveWorktreeDialog.tsx', import.meta.url), 'utf8')
const CREATE_DIALOG_SOURCE = readFileSync(new URL('../../src/client/CreateWorktreeDialog.tsx', import.meta.url), 'utf8')
const ROW_SOURCE = readFileSync(new URL('../../src/client/SidebarWorkspaceGitLine.tsx', import.meta.url), 'utf8')

const CJK = /[\u4e00-\u9fff]/u

/** The closed local code vocabulary, read from the type union itself. */
function localCodes(): string[] {
  const start = ACTION_ERROR_SOURCE.indexOf('export type GitActionErrorCode')
  const end = ACTION_ERROR_SOURCE.indexOf('export class GitActionError')
  assert.ok(start !== -1 && end > start, 'the GitActionErrorCode union must exist')
  return [...ACTION_ERROR_SOURCE.slice(start, end).matchAll(/'([a-z-]+)'/g)].map(match => match[1]!)
}

/** Full-line comments removed: a lock must be satisfied by CODE, never by prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every string literal (single/double/template) of a comment-stripped source. */
function stringLiterals(source: string): string[] {
  const stripped = stripComments(source)
  return [...stripped.matchAll(/'([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*"|`([^`\\]|\\.)*`/g)].map(match => match[0])
}

const stub = (key: GitSidebarKey): string => 't:' + key

test('every local GitActionError code has copy in BOTH dictionaries (and en is not Chinese)', () => {
  const codes = localCodes()
  assert.ok(codes.length >= 10, 'the local vocabulary must not collapse')
  for (const code of codes) {
    const key = removeFailureCopyKey(code)
    assert.notEqual(key, undefined, code + ' has no code→copy entry')
    assert.equal(typeof zh[key!], 'string', code + ' → zh.' + String(key))
    assert.equal(typeof en[key!], 'string', code + ' → en.' + String(key))
    assert.match(zh[key!], CJK, code + ' zh copy must be translated')
    assert.doesNotMatch(en[key!], CJK, code + ' en copy must not fall back to Chinese')
  }
})

test('every GitActionError thrown by the coordinator is a declared code with copy', () => {
  const codes = new Set(localCodes())
  const thrown = [...COORDINATOR_SOURCE.matchAll(/new GitActionError\('([a-z-]+)'/g)].map(match => match[1]!)
  assert.ok(thrown.length >= 10, 'the coordinator must mint structured codes')
  for (const code of thrown) {
    assert.ok(codes.has(code), 'coordinator throws undeclared code ' + code)
    assert.notEqual(removeFailureCopyKey(code), undefined, code + ' lacks localized copy')
  }
})

test('the host refusal codes keep their dedicated copy and the whole en dictionary is CJK-free', () => {
  for (const code of ['running-agent', 'main-worktree', 'worktree-locked', 'worktree-dirty', 'worktree-invalid', 'git-host-not-loaded']) {
    const key = removeFailureCopyKey(code)
    assert.notEqual(key, undefined, code + ' lost its code→copy entry')
    assert.doesNotMatch(en[key!], CJK, code + ' en copy must not fall back to Chinese')
  }
  for (const key of Object.keys(en) as GitSidebarKey[]) {
    assert.doesNotMatch(en[key], CJK, 'en.' + key + ' carries Chinese')
  }
})

test('gitActionErrorText resolves codes, follows the saga original chain, and keeps unmapped messages', () => {
  assert.equal(gitActionErrorText(new GitActionError('action-in-progress', 'raw'), stub), 't:actionInProgress')
  assert.equal(gitActionErrorCode(new GitActionError('worktree-not-found', 'raw')), 'worktree-not-found')
  // The saga wrapper has no code of its own: the host error's code must win.
  assert.equal(
    gitActionErrorText(new GitSagaError(new GitWorktreeRpcError('running-agent', 'host raw')), stub),
    't:runningAgentBlocked',
  )
  // Unmapped code / plain error: the raw message is kept (English by source lock).
  // GitWorktreeRpcError.message carries the code prefix; an unmapped code keeps
  // that raw (English) text.
  assert.equal(gitActionErrorText(new GitWorktreeRpcError('operation-conflict', 'raw english'), stub), 'operation-conflict: raw english')
  assert.equal(gitActionErrorText(new Error('plain english'), stub), 'plain english')
  assert.equal(gitActionErrorTextFor(undefined, 'kept', stub), 'kept')
  // A hostile value must not throw out of the resolver.
  assert.equal(gitActionErrorText({ toString: () => { throw new Error('hostile') } }, stub), 'unknown Git error')
})

test('no user-facing string literal in the git logic layer carries Chinese', () => {
  for (const [name, source] of Object.entries({
    'action-error.ts': ACTION_ERROR_SOURCE,
    'coordinator.ts': COORDINATOR_SOURCE,
    'git-api.ts': API_SOURCE,
    'saga.ts': SAGA_SOURCE,
    'snapshot.ts': SNAPSHOT_SOURCE,
  })) {
    const offenders = stringLiterals(source).filter(literal => CJK.test(literal))
    assert.deepEqual(offenders, [], name + ' still hardcodes Chinese in a string literal')
  }
})

test('the presentation layer resolves codes instead of rendering raw messages', () => {
  assert.match(REMOVE_DIALOG_SOURCE, /gitActionErrorText\(error, t\)/, 'the remove dialog must localize failures')
  assert.doesNotMatch(REMOVE_DIALOG_SOURCE, /setRemoveError\(error\.message/, 'no raw message path may remain')
  assert.match(REMOVE_DIALOG_SOURCE, /gitActionErrorCode\(error\) === 'worktree-dirty'/, 'the host dirty refusal must arm the discard gate')
  assert.match(CREATE_DIALOG_SOURCE, /gitActionErrorText\(error, t\)/, 'the create dialog must localize failures')
  assert.match(ROW_SOURCE, /gitActionErrorTextFor\(source\.actionErrorCode, actionError, t\)/, 'the source strip must localize the stored code')
  // The dirty marker carries the shared code (same situation, same copy).
  assert.match(COORDINATOR_SOURCE, /class WorktreeDirtyError extends GitActionError/)
  assert.match(COORDINATOR_SOURCE, /super\('worktree-dirty'/)
})
