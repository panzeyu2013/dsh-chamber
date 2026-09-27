/**
 * I-4 lock: `sidebar.workspaces` stays DECLARED but never rendered.
 *
 * WHY: the official ui-workspace registers into that hole; revoking the declaration
 * would make its registration throw. chamber renders its own multi-source browsing
 * region instead, so the hole must never be CALLED — a call would mount the official
 * workspace UI over the chamber list. This lock makes an accidental render call or a
 * silent removal of the declaration fail loudly, and records the accepted deviation
 * (design 24 §1 / design 05 §2.2.1) so the decision is not re-litigated.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const slots = stripComments(read('../../src/client/contract/slots.ts'))
// The RUNTIME children table is what the official registrant resolves against; the type
// declaration alone would keep this lock green while registration throws.
const runtime = stripComments(read('../../src/client/index.ts'))
// Every shell source, not one file: renderSlot calls live in more than one component.
const clientDir = fileURLToPath(new URL('../../src/client', import.meta.url))
const shell = readdirSync(clientDir, { recursive: true, encoding: 'utf8' })
  .filter(name => name.endsWith('.tsx'))
  .map(name => stripComments(readFileSync(join(clientDir, name), 'utf8')))
  .join('\n')

test('sidebar.workspaces is declared for registrant compatibility but never rendered', () => {
  assert.match(slots, /'sidebar\.workspaces': \{/, 'the declaration must stay: ui-workspace registration would throw without it')
  assert.match(slots, /owner: \{ wide: boolean; expandSidebar: \(\) => void \}/, 'the owner type stays wire-compatible with the official declaration')
  assert.match(runtime, /'sidebar\.workspaces': \{ kind: 'single', scope: 'root' \}/,
    'the RUNTIME children table must keep the hole too (registration throws on an undeclared child)')
  assert.doesNotMatch(shell, /'sidebar\.workspaces'/, 'the chamber shell must never call the hole (its own multi-source list owns the region)')
  const calls = [...shell.matchAll(/renderSlot\(\s*'([^']+)'/g)].map(match => match[1])
  assert.ok(calls.length > 0, 'the rendered-slot list must be extractable, otherwise this lock is vacuous')
  assert.equal(calls.includes('sidebar.workspaces'), false, 'no render call may be added later')
})
