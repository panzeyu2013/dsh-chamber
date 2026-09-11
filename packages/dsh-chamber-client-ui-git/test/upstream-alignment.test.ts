/**
 * UPSTREAM-ALIGNMENT LOCKS (2026-09-11 audit).
 *
 * Three findings landed in this package, and each one is a convention the
 * compiler cannot see: a native prompt that must not come back, an official
 * primitive that must replace hand-rolled markup, and a cross-package styling
 * hook whose two sides must keep naming the same selector. The package's
 * components are React + CSS modules (not importable under plain node), so the
 * locks read SOURCE TEXT — with comments stripped first (precedent:
 * `packages/dsh-chamber-client-ui-sidebar/test/panel-wiring.test.ts:20-27,105`),
 * because several of the comments below NAME the retired spellings and a lock
 * satisfied by a comment is the failure mode these locks exist to prevent.
 *
 *  - T2c: unregistered-worktree removal never uses `window.confirm`; the
 *    authorization is an in-app `RiskConfirmation`.
 *  - T14: `RiskConfirmation` gates the dirty/submodule discard — rendering from
 *    the gate's HELD kind, never from the derivation the acknowledgement box
 *    clears (2026-09-11 review-fix, F1/F2) — and the status capsule is the
 *    official `Tag` (no hand-rolled capsule palette).
 *  - T3: the sidebar's reveal hook is the `data-git-action` attribute on BOTH
 *    sides (this package emits it; this package's sheet and the sidebar's
 *    sheet select it).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/**
 * Remove line/block comments while preserving string and template literals.
 * @param code - the source text.
 * @returns the source with comments replaced by spaces.
 */
function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) {
      if (ch === '\n') { line = false; out += ch } else out += ' '
      continue
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '
      continue
    }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

const WEB_SOURCES: readonly string[] = ['index.ts', 'locales.ts']

/** Every authored source file of the package's client half (TS/TSX). */
function clientSources(): string[] {
  const clientDir = new URL('../src/client/', import.meta.url)
  const rows: string[] = []
  for (const entry of readdirSync(clientDir)) {
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) rows.push(readFileSync(new URL(entry, clientDir), 'utf8'))
  }
  return rows
}

test('T2c: no native prompt survives anywhere in the package', () => {
  const sources = [...clientSources(), ...WEB_SOURCES.map(rel => source(`../src/${rel}`))]
  for (const code of sources) {
    const stripped = stripComments(code)
    assert.ok(!/window\.confirm/u.test(stripped), 'window.confirm must not remain (2026-09-11 upstream-alignment, T2c)')
    assert.ok(!/(?<![\w.])confirm\(/u.test(stripped), 'neither may the bare global confirm()')
  }
})

test('T2c: the unregistered removal authorizes through RiskConfirmation', () => {
  const line = stripComments(source('../src/client/SidebarWorkspaceGitLine.tsx'))
  assert.match(line, /RiskConfirmation/u, 'the official acknowledgement dialog must be rendered')
  assert.ok(!line.includes('window.confirm'))
  // The row's trash action only opens the gate — the removal call itself moved
  // into the dialog's confirm handler, so a stray re-introduction of a direct
  // call inside the row's onClick fails here.
  const rowClick = line.slice(line.indexOf('aria-label={t(\'remove\')}'))
  const removalCall = rowClick.indexOf('removeUnregisteredWorktree(')
  const gate = rowClick.indexOf('setUnregisteredRemove(')
  assert.ok(gate !== -1, 'the row action must open the acknowledgement dialog')
  assert.ok(removalCall === -1 || removalCall > gate, 'the removal must not run from the row action')
  assert.ok(
    rowClick.includes('acknowledged={unregisteredAcknowledged}'),
    'the dialog confirm stays unavailable until the box is checked (upstream RiskConfirmation semantics)',
  )
})

test('T14: RiskConfirmation gates both discard authorizations of the remove dialog', () => {
  const dialog = stripComments(source('../src/client/RemoveWorktreeDialog.tsx'))
  assert.match(dialog, /import \{[^}]*RiskConfirmation[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)

  // The gate's OWN state decides whether it is up: the kind chosen when
  // `Remove` opened it is HELD until its cancel or confirm releases it. The
  // pending derivation answers `null` the very moment the acknowledgement box
  // is ticked (case-tested in `test/discard-gate.test.ts`), so a gate rendering
  // from it dismisses itself under the user's cursor and leaves `onConfirm`
  // unreachable — the removal then needs a second `Remove` click
  // (2026-09-11 review-fix, F1).
  assert.match(dialog, /open=\{discardGateOpen !== null\}/u, 'the gate renders from the held gate state')
  assert.doesNotMatch(
    dialog,
    /open=\{[^}]*pendingDiscardAuthorization/u,
    'the gate must never render from the pending derivation — ticking the box clears it',
  )
  // The held kind decides the gate's copy AND the box it binds, so a gate left
  // over from the other authorization can never look like the right one.
  for (const prop of ['title', 'description', 'acknowledgeLabel', 'acknowledged']) {
    assert.match(
      dialog,
      new RegExp(`${prop}=\\{discardGateOpen === 'submodule' \\?`, 'u'),
      `${prop} must follow the held gate kind`,
    )
  }
  assert.match(
    dialog,
    /onAcknowledgedChange=\{\(acknowledged\) => \{\s*if \(discardGateOpen === 'submodule'\) setDiscardSubmodules\(acknowledged\)\s*else setDiscardChanges\(acknowledged\)/u,
    'the box writes the acknowledgement of the held kind',
  )

  const gate = dialog.slice(dialog.indexOf('<RiskConfirmation'))
  const cancel = gate.slice(gate.indexOf('onCancel={'), gate.indexOf('onConfirm={'))
  assert.match(cancel, /setDiscardGateOpen\(null\)/u, 'cancel/close/Escape (onCancel) releases the gate')
  const confirm = gate.slice(gate.indexOf('onConfirm={'))
  assert.match(
    confirm,
    /setDiscardGateOpen\(null\)[\s\S]{0,80}void runRemove\(\)/u,
    'the gate confirm performs the removal — ONE gesture (click Remove, tick, Confirm)',
  )

  // A refusal only ARMS the matching authorization: it states the warning and
  // the NEXT `Remove` click opens the gate (design 08 §5.4). Only the click may
  // open it, and only with the kind the derivation answered.
  const opens = [...dialog.matchAll(/setDiscardGateOpen\(([^)]*)\)/gu)].map(match => match[1].trim())
  assert.ok(opens.length >= 4, 'the gate state has its open, reset, cancel and confirm sites')
  for (const argument of opens) {
    assert.ok(
      argument === 'null' || argument === 'pendingDiscardAuthorization',
      `only the remove click may open the gate (saw setDiscardGateOpen(${argument}))`,
    )
  }
  assert.ok(
    opens.includes('pendingDiscardAuthorization'),
    'the remove click opens the gate with the kind the derivation answered',
  )
  // A refusal still arms the gate for the next click without closing the dialog.
  assert.ok(dialog.includes('setFreshDirty(true)'), 'a fresh dirty preflight arms the dirty gate')
  assert.ok(dialog.includes('setSubmoduleBlock(true)'), 'the submodule refusal arms the submodule gate')

  // The hand-rolled checkbox gate is gone: no checkbox bound to the discard
  // state, and the confirm button no longer disables on it.
  assert.ok(!/checked=\{discardChanges\}/u.test(dialog), 'the in-dialog discard checkbox must be deleted')
  assert.ok(!/checked=\{discardSubmodules\}/u.test(dialog), 'the in-dialog submodule checkbox must be deleted')
  assert.ok(
    !/confirmDisabled = [\s\S]{0,400}needsDiscardConfirmation && !discardChanges/u.test(dialog),
    'confirmDisabled must not carry the discard gate any more',
  )
  // Both authorizations still map onto the single `discardChanges` wire flag —
  // the capability the host's `--force` path requires is unchanged. The truth
  // table itself is case-tested in `test/discard-gate.test.ts`.
  assert.match(
    dialog,
    /import \{ discardAuthorized, nextDiscardGate \} from '\.\.\/shared\/discard-gate\.ts'/u,
    'the dialog takes both decisions from the pure, case-tested module',
  )
  assert.match(dialog, /pendingDiscardAuthorization = nextDiscardGate\(gateFacts\)/u)
  assert.match(
    dialog,
    /\.\.\.\(discardAuthorized\(gateFacts\) \? \{ discardChanges: true \} : \{\}\)/u,
    'the removal carries discardChanges: true only under an explicit acknowledgement',
  )
})

test('T14: the status capsule is the official Tag, not a hand-rolled capsule', () => {
  const line = stripComments(source('../src/client/SidebarWorkspaceGitLine.tsx'))
  const css = stripComments(source('../src/client/SidebarGit.module.css'))
  assert.match(line, /import \{[^}]*Tag[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)
  assert.ok(line.includes('<Tag tone="warning"'), 'the capsule renders through the primitive with an explicit tone')
  assert.ok(!line.includes('unregisteredStatusWarn'), 'the bespoke warn-tone class must be gone')
  assert.ok(!css.includes('unregisteredStatusWarn'), 'its stylesheet rule must be gone')
  // Only placement survives in the sheet: no palette, no capsule geometry
  // (the primitive owns 11px/17px, the radius, the tone fills).
  const placement = /\.unregisteredStatus \{[^}]*\}/u.exec(css)
  assert.ok(placement !== null, 'the placement class must exist')
  for (const property of ['background', 'color', 'font-size', 'line-height', 'padding', 'border-radius', 'corner-shape']) {
    assert.ok(!placement[0].includes(property), `.unregisteredStatus must not own ${property}`)
  }
})

test('T3: the reveal hook is the data-git-action attribute on both sides', () => {
  const line = stripComments(source('../src/client/SidebarWorkspaceGitLine.tsx'))
  const gitCss = stripComments(source('../src/client/SidebarGit.module.css'))
  // The sidebar sheet is read from THIS package on purpose: the reveal is one
  // behaviour with two owners, and a rename on one side alone silently stops
  // the hover reveal (design 08 §3.2) while both sheets still look correct.
  const sidebarCss = stripComments(
    source('../../dsh-chamber-client-ui-sidebar/src/client/sidebar-chamber.module.css'),
  )

  // Emitting side: both occupant actions carry the hook.
  assert.equal(
    [...line.matchAll(/data-git-action=""/gu)].length,
    2,
    'both the create and the remove action carry the attribute hook',
  )
  assert.ok(!line.includes('git-ws-action'), 'no literal class hook on the emitting side')

  // Selecting sides.
  assert.ok(gitCss.includes('[data-git-action]'), "the plugin's own reveal rule selects the attribute")
  assert.ok(!gitCss.includes(':global(.git-ws-action'), 'the global-class selector must be gone')
  assert.ok(sidebarCss.includes('[data-git-action]'), 'the sidebar reveal selects the same attribute')
  assert.ok(!sidebarCss.includes('.git-ws-action'), 'the sidebar must not keep the retired class hook')
})
