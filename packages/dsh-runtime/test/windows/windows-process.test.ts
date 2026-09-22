/**
 * Windows process-tree probe unit tests (design 21): the exec helpers are
 * win32-gated and their off-platform refusal is asserted here.
 * Real Windows tooling behavior is covered by the control-plane win32-only
 * integration test (win32-lifecycle.integration.test.ts).
 *
 * Run directly: node packages/dsh-runtime/test/windows/windows-process.test.ts
 *
 * The pure CIM-parser, descendant-walk, command-string and identity faces are
 * NOT asserted here: the cross-package twin parity gate
 * (packages/control-plane/test/protocol/win-probes-parity.test.ts:75-204) is
 * the authoritative side and feeds BOTH twins the superset fixtures plus
 * absolute expected rows (TREE 75-85, TASKKILL_CASES 87-96, IDENTITY_CASES
 * 98-139; asserted at 151-204) on every leg
 * (control-plane/scripts/test.mjs:67,151).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasWindowsDescendants,
  killWindowsTree,
  killWindowsTreeWithResidual,
  queryWindowsProcessTable,
} from '../../src/windows-process.ts'

test('windows exec helpers fail closed off win32', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => queryWindowsProcessTable(), /win32/)
  assert.throws(() => hasWindowsDescendants(1), /win32/)
  assert.throws(() => killWindowsTree(1), /win32/)
  assert.throws(() => killWindowsTreeWithResidual(1), /win32/)
})
