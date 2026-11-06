/**
 * Path-based removal input: the host sees one identity + one discard
 * authorization. The registered-removal dialog (and its discard gate) is gone in
 * PR3, so the only consumer is the checkout row's confirmation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unregisteredRemoveInput, unregisteredRemoveOptions } from '../../src/shared/remove-input.ts'

test('unregistered removal carries discardChanges only when explicitly authorized', () => {
  const target = { repoId: 'r-1', worktreeId: 'w-1', path: '/repo/wt', branch: 'task', head: 'a'.repeat(40) }
  assert.equal('discardChanges' in unregisteredRemoveInput('op', target), false,
    'a clean row never sends the force authorization')
  assert.equal('discardChanges' in unregisteredRemoveInput('op', target, { discardChanges: false }), false,
    'an explicit false is the absent case')
  assert.equal(unregisteredRemoveInput('op', target, { discardChanges: true }).discardChanges, true,
    'the acknowledged dirty row sends the flag')
  assert.equal(unregisteredRemoveInput('op', target, { deleteBranch: 'task' }).deleteBranch, 'task',
    'the branch-deletion authorization stays an explicit option')
  assert.deepEqual(unregisteredRemoveInput('op', target).expected,
    { repoId: 'r-1', worktreeId: 'w-1', branch: 'task', head: 'a'.repeat(40) },
    'identity re-verification rides along on every request')
})

test('the checkout row authorizes the discard flag only when the dialog collected it', () => {
  assert.deepEqual(unregisteredRemoveOptions(false), {},
    'a row without a discard acknowledgement must not send the force authorization')
  assert.deepEqual(unregisteredRemoveOptions(true), { discardChanges: true },
    'the acknowledged dirty/submodule row sends exactly the flag the host consumes')
  assert.deepEqual(unregisteredRemoveOptions(false, 'task'), { deleteBranch: 'task' },
    'the explicit branch checkbox sends exactly the branch')
  assert.deepEqual(unregisteredRemoveOptions(false, null), {}, 'no branch choice = keep the branch')
  assert.deepEqual(unregisteredRemoveOptions(true, 'task'), { discardChanges: true, deleteBranch: 'task' },
    'both explicit authorizations can ride together')
})
