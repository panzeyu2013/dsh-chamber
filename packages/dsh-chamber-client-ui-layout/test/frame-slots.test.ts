/**
 * Frame slot declaration lock (design 06, workspace W15): the fork's `root`
 * registration declares `shell.leading` and its SlotMap mirror must state the
 * same spec. The seat is mounted by the vendor AppFrame only while the darwin
 * collapse hides the sidebar column entirely; the chamber sidebar fork occupies
 * it, and a missing declaration would leave the occupant a type error with no
 * runtime placeholder to notice.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import { stripComments } from '../../../scripts/dev/test-support/source-text.ts'

const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

// Compile-time lock: the SlotMap merge must carry the seat spec (a missing or
// renamed member fails the package typecheck here, not at a consumer).
const leadingSpec: SlotMap['shell.leading'] = { kind: 'single', scope: 'root' }

test('the SlotMap mirror declares the frame leading seat spec', () => {
  // Parse the REAL declaration instead of comparing a literal to itself: the
  // typed const above is the compile-time arm, this is the source arm.
  const code = stripComments(source)
  const mirrorAt = code.indexOf('interface SlotMap {')
  assert.notEqual(mirrorAt, -1, 'src/client/index.ts declares the SlotMap augmentation')
  const memberAt = code.indexOf("'shell.leading'", mirrorAt)
  assert.notEqual(memberAt, -1, 'the SlotMap mirror declares shell.leading')
  const member = /\{\s*kind:\s*'([^']+)';\s*scope:\s*'([^']+)'\s*\}/u.exec(code.slice(memberAt))
  assert.ok(member !== null, 'the mirror member carries a kind/scope spec')
  assert.deepEqual({ kind: member[1], scope: member[2] }, leadingSpec)
})

test('the root registration declares the frame leading seat as its child', () => {
  const code = stripComments(source)
  const childrenAt = code.indexOf('children: {')
  assert.notEqual(childrenAt, -1, 'the root registration declares its children')
  const registration = code.slice(childrenAt, code.indexOf('}, AppFrame)', childrenAt))
  assert.match(registration, /'shell\.leading': \{ kind: 'single', scope: 'root' \},/)
  assert.match(registration, /'shell\.overlay': \{ kind: 'list', scope: 'root' \},/)
})
