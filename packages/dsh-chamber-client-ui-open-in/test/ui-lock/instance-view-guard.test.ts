/**
 * OPEN-IN MENU + FAILURE PRESENTATION LOCKS.
 *
 * Locks the open-in menu owner guard and the split-button control against the
 * official primitive: the `.instance-view`-scoped dismissal of this N-ctx shell
 * (the one piece the vendor `Menu` cannot own) plus catalog icons, split-button
 * flow, per-source memory, in-flight pick semantics and re-probe on open. The
 * component is React + CSS + raster marks (not importable under plain node), so
 * the wiring is locked as SOURCE TEXT with comments stripped first — a lock
 * satisfied by a comment is exactly what these assertions exist to prevent. The
 * pure owner-guard decision is tested directly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { menuOwnerAllowsInteraction, type MenuOwnerSnapshot } from '../../src/client/instance-view-guard.ts'
import { en, zh } from '../../src/locales.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const button = stripComments(source('../../src/client/OpenInButton.tsx'))
const guard = stripComments(source('../../src/client/instance-view-guard.ts'))
const client = stripComments(source('../../src/client/index.ts'))

test('menu owner guard fails closed for hidden, pending, or disconnected N-ctx state', () => {
  const active: MenuOwnerSnapshot = {
    triggerConnected: true,
    ownerConnected: true,
    ownerContainsTrigger: true,
    ownerIsInstanceView: true,
    ownerHasInactiveClass: false,
    ownerHidden: false,
    ownerAriaHidden: false,
    rendered: true,
  }
  assert.equal(menuOwnerAllowsInteraction(active), true)

  for (const key of [
    'triggerConnected',
    'ownerConnected',
    'ownerContainsTrigger',
    'ownerIsInstanceView',
    'rendered',
  ] as const) {
    assert.equal(menuOwnerAllowsInteraction({ ...active, [key]: false }), false, key)
  }
  for (const key of ['ownerHasInactiveClass', 'ownerHidden', 'ownerAriaHidden'] as const) {
    assert.equal(menuOwnerAllowsInteraction({ ...active, [key]: true }), false, key)
  }
})

test('the official Menu primitive carries the chamber menu density', () => {
  assert.match(
    button,
    /import \{\s*IconChevronDownOutlineRegular, Menu, Tooltip, type MenuItem,\s*\} from '@deepseek-ai\/dsh-client-ui-primitives'/u,
  )
  // Upstream's own menu composition (OpenInAppAction.tsx:181-198): fill
  // selection, end alignment, focus transfer + arrow navigation — with the
  // chamber menu-density decision on top (`compact` 26px/12px, never upstream's
  // `dense`; design 06 §7, design 20 §1).
  for (const prop of ['autoFocus', 'compact', 'selection="fill"', 'align="end"']) {
    assert.ok(button.includes(prop), `the official Menu must be opened with ${prop}`)
  }
  // Row icons: the app marks the button shows, at the primitive's icon size.
  assert.match(button, /const items: MenuItem\[\] = entries\.map\(entry => \(\{[\s\S]*?icon: appMark\(iconUrl\(entry\.id\), MENU_MARK_SIZE\)/u)
  // The decode-failure memory is keyed by the icon URL, not by app id or
  // source: the page reads ONE machine catalog, so the same URL means the same
  // bytes in every source's button and a failure must fall back everywhere
  // instead of re-decoding once per source.
  assert.ok(button.includes('useState(failedIcons.has(url))'), 'the failed-icon memory is keyed by the icon URL')
  assert.ok(button.includes('failedIcons.add(url)'), 'failures are recorded under that URL')
  assert.ok(button.includes('aria-haspopup="menu"'), 'the chevron still advertises the menu')
  assert.ok(button.includes('aria-expanded={open}'), 'the chevron still reports the open state')
})

test('the control uses upstream geometry and the machine catalog as its only icon source', () => {
  // Geometry, marks, glyphs and fallbacks are upstream's
  // (OpenInAppAction.module.css / OpenInAppAction.tsx at the pin).
  // Sizes and shapes are locked here as source text because the component (and
  // its CSS module) cannot be imported under the plain node runner.
  assert.ok(
    button.includes('<IconChevronDownOutlineRegular size={11} />'),
    'the chevron must be the design-system icon at the official 11px size',
  )
  assert.match(button, /function appMark\(iconUrl: string \| null, size: number\)/u,
    'the mark is chosen by the catalog answer alone')
  assert.ok(
    button.includes('return iconUrl === null ? <GenericAppMark size={size} /> : <CatalogIcon url={iconUrl} size={size} />'),
    "a miss draws upstream's square, a hit the machine's art",
  )
  assert.ok(button.includes('const BUTTON_MARK_SIZE = 15'), 'the button mark uses the official 15px size')
  assert.ok(button.includes('const MENU_MARK_SIZE = 18'), 'the menu mark uses the official 18px size')
  assert.ok(button.includes('viewBox="0 0 24 24"'), "the fallback mark is upstream's rounded square")
  assert.ok(button.includes('strokeWidth="1.8"'), "the fallback mark keeps upstream's stroke weight")

  const css = stripComments(source('../../src/client/OpenInButton.module.css'))
  for (const rule of [
    'height: 28px',
    'border: 0.5px solid var(--dsw-alias-border-l4)',
    'border-radius: 14px',
    'overflow: hidden',
    'padding: 5px 6px 5px 7px',
    'padding: 5px 6px 5px 4px',
    'border-left: 0.5px solid var(--dsw-alias-border-l4)',
    'object-fit: contain',
    'flex: none',
  ]) {
    assert.ok(css.includes(rule), `the control must keep upstream's \`${rule}\``)
  }
})

test('the registration mirrors the official row (order), with our own id', () => {
  // `order: -10` is the official `open-in-app` row's own value (the official
  // plugin registers `order: -10` at this same slot), so any third-party row
  // sorts exactly as it would upstream.
  assert.ok(client.includes("'conversation.session.header.utilities'"), 'the official header utilities slot')
  assert.ok(client.includes('order: -10'), "the registration must keep upstream's -10 row order")
  assert.ok(!client.includes('order: -1,'), 'the retired chamber order must not come back')
  // The id deliberately stays chamber's own: the slot registry THROWS on a
  // duplicate list id at the same priority, so reusing `open-in-app` would turn
  // an accidentally materialized official row into a load failure.
  assert.ok(client.includes("id: 'open-in'"), 'the entry keeps its own slot id')
  assert.ok(!client.includes("id: 'open-in-app'"), "the official row's id must not be reused")
})

test('the .instance-view dismissal is the only bespoke menu behaviour kept', () => {
  assert.match(button, /useInstanceViewDismissal\(open, groupRef, \(\) => \{ setOpen\(false\) \}\)/u)
  assert.ok(button.includes('ref={groupRef}'), 'the guard anchors on the element the Menu wraps')
  // The guard reads every N-ctx signal the shell publishes.
  for (const signal of ["'instance-hidden'", "'instance-pending'", "'hidden'", "'aria-hidden'"]) {
    assert.ok(guard.includes(signal), `the owner guard must keep watching ${signal}`)
  }
  // The primitive owns dismissal while the owner lives.
  assert.ok(button.includes('onClose={() => { setOpen(false) }}'), 'the primitive dismissal closes the menu')
  // Re-probe on open: the chevron refreshes the pools for BOTH the click and
  // arrow-key paths.
  assert.equal(
    [...button.matchAll(/void refresh\(\)/gu)].length,
    2,
    'opening by click and by arrow key must both re-probe the catalog',
  )
  assert.ok(button.includes("event.key === 'ArrowDown' || event.key === 'ArrowUp'"), 'arrow-key opening stays')
})

test('T5: the main button uses the design-system Tooltip and the existing dictionary keys', () => {
  assert.equal(
    [...button.matchAll(/<Tooltip label=\{tooltip\} side="bottom">/gu)].length,
    1,
    'upstream has one split-button form, so the main button is wrapped once',
  )
  // No native title bubble on either half of the split control: WebKit and
  // Chromium draw native tooltips differently, so both halves share the
  // design-system Tooltip source. The opening tag ends at the JSX attribute
  // list's own line, so the arrow functions inside it do not truncate the match.
  const mainButton = /className=\{styles\.button\}[\s\S]{0,600}?\n\s*>/u.exec(button)
  assert.ok(mainButton !== null, 'the main button exists')
  assert.ok(!mainButton[0].includes('title='), 'the main button must not carry a native title attribute')
  assert.ok(mainButton[0].includes('aria-label={title}'), 'the accessible name stays on the button')
  assert.equal(
    [...button.matchAll(/<Tooltip label=\{t\('menuToggle'\)\} side="bottom">/gu)].length,
    1,
    'the chevron uses the same design-system Tooltip source as the main button',
  )
  assert.equal([...button.matchAll(/\btitle=/gu)].length, 0, 'no native title bubble remains on the split control')

  // The copy rides the keys the dictionaries already carry.
  assert.match(button, /const title = phase === 'error' \? t\('openError'\) : t\('openTitle', \{ app: appLabel\(activeEntry, t, platform\) \}\)/u)
  assert.match(button, /phase === 'error' \? t\('openError'\) : t\('openTooltip'\)/u)
  assert.match(button, /`\$\{t\('openFailed'\)\}\$\{failureReason\}`/u)
  for (const key of ['openTitle', 'openTooltip', 'openError', 'openFailed', 'menuToggle'] as const) {
    assert.ok(key in zh && key in en, `${key} must exist in both dictionaries`)
  }
})

test('T5: a launch failure is surfaced in the app, never console-logged', () => {
  const clientDir = new URL('../../src/client/', import.meta.url)
  for (const entry of readdirSync(clientDir)) {
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
    const stripped = stripComments(readFileSync(new URL(entry, clientDir), 'utf8'))
    assert.ok(!/console\.(error|warn|log)\(/u.test(stripped), `${entry} must not console-log a launch failure`)
  }
  // Both rejection paths (result.ok === false and a transport rejection) set
  // the reason, and the error dress clears it with the phase it belongs to.
  assert.equal(
    [...button.matchAll(/setFailureReason\(/gu)].length,
    5,
    'two failure paths set the reason; a success and the decay timer clear it',
  )
  assert.match(button, /errorTimer\.current = setTimeout\(\(\) => \{\s*setPhase\('idle'\)\s*setFailureReason\(null\)\s*\}, ERROR_DECAY_MS\)/u)
})

test('the aligned launch semantics are unchanged (250ms busy dress, 2s error, in-flight pick)', () => {
  assert.match(button, /const BUSY_DRESS_DELAY_MS = 250/u)
  assert.match(button, /const ERROR_DECAY_MS = 2_000/u)
  const pick = /onSelect=\{\(id\) => \{[\s\S]*?\n {6}\}\}/u.exec(button)
  assert.ok(pick !== null, 'the pick handler exists')
  const chooseAt = pick[0].indexOf('choose(id)')
  const inFlightAt = pick[0].indexOf('if (inFlight.current) return')
  assert.ok(inFlightAt !== -1 && chooseAt > inFlightAt, 'a pick during an in-flight launch is still ignored whole')
  assert.ok(button.includes('if (result.ok)'), 'the launch result gate stays')
})

/**
 * STREAM-HEALTH SEAT/CHIP WIRING LOCKS.
 *
 * The React seat and chip are not importable under plain node, so their wiring
 * is pinned as source text. Covered: the registration order behind the open-in
 * gates, the per-session ladder ownership, the evidence-gated execution
 * discipline, the inert chip, and the cross-package churn constant shared with
 * the api-gateway fork.
 */
const seat = stripComments(source('../../src/client/session-stream-health-seat.ts'))
const chip = stripComments(source('../../src/client/SessionStreamHealthChip.tsx'))
const openInEntry = stripComments(source('../../src/client/index.ts'))

test('stream-health seat: registered before the open-in gates, ladder state in the seat, defensive face read', () => {
  const call = openInEntry.indexOf('registerSessionStreamHealthSeat(ctx, t)')
  const bail = openInEntry.indexOf('if (source === null) return')
  assert.notEqual(call, -1, 'the entry must register the stream-health seat')
  assert.notEqual(bail, -1, 'the open-in source gate must still exist')
  assert.ok(call < bail, 'the recovery seat must not sit behind the open-in source gate')
  assert.match(openInEntry, /import \{ registerSessionStreamHealthSeat \} from '\.\/session-stream-health-seat\.ts'/)
  assert.match(seat, /'conversation\.session\.header\.actions'/)
  assert.match(seat, /inject: \(\) => face,/)
  assert.match(seat, /const ladders = new Map<string, SessionStreamHealthState>\(\)/)
  assert.match(seat, /const storeLadder = \(sessionId: string, state: SessionStreamHealthState\): void => \{/,
    'per-session state must survive a chip remount through one shared store')
  assert.match(seat, /reflect\.get\('sessions', false\)/, 'an absent cordis service must not throw through the ctx proxy')
  // rc.2: the stage-move detour (and its presented-recency memory) is gone; the
  // automatic heal executes the concrete resync on the presented target.
  assert.doesNotMatch(seat, /previousPresented|rememberPresented|healSessionStream|hasHealRoute/)
})

test('stream-health seat: the page delivery owner owns the automatic rebuild, header retains the manual exit', () => {
  assert.match(seat, /resyncAvailable: hasSessionStreamResync\(sessions, sessionId\)/)
  assert.match(seat, /healRoute: hasSessionStreamResync\(sessions, sessionId\)/,
    'the automatic heal executes resync on the presented target, so its gate is the same guarded probe read')
  const policy = stripComments(source('../../src/client/session-stream-health.ts'))
  assert.doesNotMatch(policy, /auto-resync/)
  assert.match(seat, /if \(plan\.action === 'heal'\) \{/)
  assert.doesNotMatch(seat, /plan\.action === 'auto-resync'/)
  assert.doesNotMatch(seat, /plan\.action === 'resync'/)
  assert.equal([...seat.matchAll(/resyncSessionStream\(/gu)].length, 2,
    'the header executes the automatic heal AND its injected user action — nothing else')
  const page = stripComments(source('../../../renderer/src/components/InstanceView.tsx'))
  // The automatic rebuild moved to the page-level delivery owner (one ladder, one
  // ledger); the retired planner must never return to the view.
  assert.doesNotMatch(page, /planSessionOpenAutoRebuild\(/)
  // Pin the FULL call, arguments included: dropping the monotonic `at` argument
  // makes the streak NaN, which disables every afterMs gate while name-only locks
  // and the pure-module tests stay green.
  assert.match(page, /activeSymptomSinceMs\(\{/)
  // Desktop-observed paint/schedule evidence must reach the same owner.
  assert.match(page, /readRendererStallStrikes\(/)
  assert.match(page, /scheduleStalled: true/)
  assert.match(page, /inputBlocked: true/)
  // The upper tiers must have real executors, or stuckEvidence only burns quota.
  assert.match(page, /decision\.action\?\.tier === 'instance-reboot'/)
  assert.match(page, /onRebootInstance\?\.\(instanceId\)/)
  assert.match(page, /decision\.action\?\.tier === 'document-reload'/)
  assert.match(page, /shouldReloadDocument\(documentReloadBudgetStorage\(\), Date\.now\(\)\)/)
  // The ladder ledger must survive the reboot it authorized, or every boot gets a
  // fresh quota and the page reboots forever (page-lifetime owner).
  assert.doesNotMatch(page, /useEffect\(\(\) => \{\s*deliveryOwnerRef\.current = createSessionDeliveryOwner\(\)/)
  assert.match(page, /const deliveryOwnerRef = useRef\(createSessionDeliveryOwner\(\)\)/)
  assert.match(page, /deliveryOwnerRef\.current\.observe\(/)
  // The error face the header cannot heal (an address-only subagent selection, a
  // masked target) must reach the owner with the positive "no stage move" fact,
  // which is what lets the page's own bounded resync recover it automatically.
  assert.match(page, /healRoute: observed\.healRoute/)
  const shellSource = stripComments(source('../../../renderer/src/shell.ts'))
  assert.match(shellSource, /const resyncAvailable = hasSessionStreamResync\(sessions, sessionId\)/)
  assert.match(shellSource, /healRoute: resyncAvailable/,
    'the page health read must derive the route from the guarded probe, never infer it')
  assert.doesNotMatch(shellSource, /hasHealRoute|healSessionStream/,
    'the retired stage-move helpers must not return to the shell')
  assert.match(page, /decision\.action\?\.tier === 'resync'/)
  assert.match(page, /rebuildInstanceSessionStream\(instanceId, currentSessionId\)/)
  assert.doesNotMatch(seat, /if \(!sessionStreamLeversAvailable\(current, now\)\) return/,
    'the manual exit must survive an exhausted automatic budget')
  assert.match(seat, /resync: \(sessionId\) => \{/)
  assert.match(seat, /storeLadder\(sessionId, markSessionStreamHeal\(current, now\)\)/)
})

test('stream-health chip: only the injected action reloads, idle renders nothing, controls match the plan', () => {
  assert.equal([...chip.matchAll(/location\.reload\(\)/gu)].length, 0, 'the chip must not reload on its own')
  assert.equal([...seat.matchAll(/location\.reload\(\)/gu)].length, 1, 'exactly one reload path: the injected user action')
  assert.doesNotMatch(chip, /useRef/, 'the ladder state must not live in a component ref')
  assert.match(chip, /if \(face\.label === null\) return null/)
  assert.match(chip, /<span role="status" aria-live="polite">\{label\}<\/span>/, 'the live region is the label alone')
  assert.doesNotMatch(chip, /<div[^>]*role="status"/)
  assert.match(chip, /face\.reload \? \(/)
  assert.match(chip, /face\.resync \? \(/)
  assert.match(chip, /<button type="button" className=\{styles\.action\} onClick=\{\(\) => \{ resync\(sessionId\) \}\}>/)
  assert.equal([...chip.matchAll(/resync\(sessionId\)/gu)].length, 1, 'the click is the only resync invocation in the chip')
  assert.doesNotMatch(chip, /useEffect\(\(\) => \{ resync/, 'resync must not ride an effect')
})

test('stream-health churn: the seat mirrors the api-gateway literal and wakes the renderer', () => {
  const fork = stripComments(readFileSync(
    new URL('../../../dsh-api-gateway/src/client/stream-carrier-fact.ts', import.meta.url), 'utf8'))
  const forkEvent = /export const STREAM_CARRIER_FAILED_EVENT = '([^']+)'/u.exec(fork)
  assert.ok(forkEvent !== null, 'the fork must export the page event name')
  const seatEvent = /const CARRIER_CHURN_EVENT = '([^']+)'/u.exec(seat)
  assert.equal(seatEvent?.[1], forkEvent[1], 'the seat must listen on the fork event, spelled identically')
  assert.match(seat, /window\.addEventListener\(CARRIER_CHURN_EVENT, onChurn\)/u)
  assert.match(seat, /window\.removeEventListener\(CARRIER_CHURN_EVENT, onChurn\)/u, 'the listener must be torn down')
  assert.match(seat, /\.\.\.\(carrierChurn === undefined \? \{\} : \{ carrierChurn \}\)/u, 'the fact must reach the decision observation')
  assert.match(seat, /const churnListeners = new Set<\(\) => void>\(\)/u)
  assert.match(seat, /subscribe: \(listener\) => \{\n\s*churnListeners\.add\(listener\)/u)
  assert.match(seat, /carrierChurn = \{ at, count \}\n\s*for \(const listener of \[\.\.\.churnListeners\]\) listener\(\)/u,
    'the broadcast must follow the stored fact in the same handler')
  assert.match(seat, /const onChurn = \(event: Event\): void => \{(?:(?!\n\s*return\b)[\s\S])*?for \(const listener/u,
    'no unconditional return may precede the broadcast')
  assert.match(chip, /useEffect\(\(\) => subscribe\(\(\) => setTick\(value => value \+ 1\)\), \[subscribe\]\)/u)
})
