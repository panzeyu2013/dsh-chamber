/**
 * Required extra-row service probe decisions (alpha.2) + the deferred-cluster
 * failure diagnostic (review F2).
 *
 * The probe itself lives in chamber-entry.ts (which no node test can import —
 * its imports resolve to source), so the decision and the message are pure
 * functions here and pinned by these cases; the chamber-entry WIRING is pinned
 * by source-text assertions at the bottom (the same pattern the repo uses for
 * App-level wiring, e.g. sidebar-right-heal-wiring.test.ts), because a missing
 * link there is a silent no-op.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  chamberEntryDiagnosticMessage,
  deferredRegistrationFailureMessage,
  DEFERRED_EXTRA_ROW_IDS,
  injectedServices,
  missingInjectedServices,
  registeredInjectMembers,
  requiredServiceProbeMessage,
  REQUIRED_SERVICE_PROBE_DEADLINE_MS,
  type RegisteredPluginInject,
} from '../src/required-extra-rows.ts'
import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from '../src/chamber-covered.ts'
import { normalize, stripComments } from './source-text.ts'

const readSource = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')

// ── A1 (2026-09-11 upstream-alignment): the probe roster is DERIVED from the
// ── inject faces of the plugins the composite registered — upstream's own fact
// ── (`Object.keys(entry.fiber.inject)`, vendor packages/client/web/src/
// ── boot.ts:138-158), lifted from the per-fiber sweep to the composite's
// ── children, which that sweep cannot see.

test('registeredInjectMembers reads both cordis inject shapes and fails loud on anything else', () => {
  assert.deepEqual(registeredInjectMembers('p', undefined), [])
  assert.deepEqual(registeredInjectMembers('p', null), [])
  assert.deepEqual(registeredInjectMembers('p', ['slots', 'locale']), ['slots', 'locale'])
  // The map form (cordis registry.ts `Inject.resolve`): the KEYS are the
  // services — exactly what upstream reads off `fiber.inject`.
  assert.deepEqual(registeredInjectMembers('p', { slots: null, locale: { some: 'config' } }), ['slots', 'locale'])
  // A namespace whose inject face cannot be read must NOT be silently treated
  // as "injects nothing": that would shrink the probed set without a trace.
  assert.throws(() => registeredInjectMembers('@scope/pkg', 'slots'), /non-array\/non-map inject face/)
  assert.throws(() => registeredInjectMembers('@scope/pkg', ['slots', 7]), /non-string member/)
})

test('injectedServices is the deduped union in registration order', () => {
  const plugins: RegisteredPluginInject[] = [
    { id: 'a', inject: ['sessions', 'slots'] },
    { id: 'b', inject: ['slots', 'locale'] },
    { id: 'c', inject: undefined },
    { id: 'd', inject: ['sidebarRight'] },
  ]
  assert.deepEqual(injectedServices(plugins), ['sessions', 'slots', 'locale', 'sidebarRight'])
  assert.deepEqual(injectedServices([]), [])
})

test('missingInjectedServices names each unprovided service AND the registered plugins injecting it', () => {
  const plugins: RegisteredPluginInject[] = [
    { id: '@deepseek-ai/dsh-client-ui-chat', inject: ['slots', 'sessions', 'sidebarRight'] },
    { id: '@deepseek-ai/dsh-client-ui-approval', inject: ['sessions', 'sidebarRight'] },
  ]
  // The live ctx service store: everything but `sidebarRight` is provided.
  const isProvided = (name: string): boolean => name !== 'sidebarRight'
  assert.deepEqual(missingInjectedServices(plugins, isProvided), [
    { service: 'sidebarRight', injectedBy: ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-approval'] },
  ])
  // A complete roster reports nothing (the probe's healthy arm).
  assert.deepEqual(missingInjectedServices(plugins, () => true), [])
  // The consequence the probe exists for: the sole non-covered provider row.
  assert.deepEqual(
    missingInjectedServices([{ id: '@deepseek-ai/dsh-client-ui-chat', inject: ['sidebarRight'] }], () => false),
    [{ service: 'sidebarRight', injectedBy: ['@deepseek-ai/dsh-client-ui-chat'] }],
  )
})

test('requiredServiceProbeMessage names each service, its injectors, the deadline and the instance', () => {
  const missing = [{ service: 'sidebarRight', injectedBy: ['@deepseek-ai/dsh-client-ui-chat'] }]
  const withInstance = requiredServiceProbeMessage(missing, 'local')
  assert.ok(withInstance.includes('instance local'), 'the instance id must be named when known')
  assert.ok(withInstance.includes('sidebarRight'), 'the missing service must be named')
  assert.ok(withInstance.includes('injected by @deepseek-ai/dsh-client-ui-chat'),
    'the registered plugin injecting it must be named')
  assert.ok(withInstance.includes('still unprovided after'), 'the deadline phrasing is kept')
  assert.ok(withInstance.includes(`${REQUIRED_SERVICE_PROBE_DEADLINE_MS}ms`), 'the deadline must be named')
  assert.ok(withInstance.includes('PENDING'), 'the consequence (the fibers stay pending) must be stated')
  assert.ok(withInstance.includes('NOT blocked'), 'the diagnostic-not-gate contract must be stated')
  const withoutInstance = requiredServiceProbeMessage(missing)
  assert.ok(!withoutInstance.includes('instance'), 'an unknown instance adds no clause')
})

test('the composite derives its roster and still registers the ui-chat inject face the probe exists for', () => {
  // The derived roster is only as true as the vendor declarations behind it:
  // ui-chat root-injects `sidebarRight` (vendor ui-chat/src/client/apply.ts),
  // whose ONLY provider is the non-covered `ui-sidebar-right` host-graph row.
  // If upstream ever drops that member the probe loses its motivating case —
  // this lock makes that a visible fact, never a silent shrink.
  const uiChat = readSource('../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-chat/src/client/apply.ts')
  const declared = /export const inject = \[([^\]]*)\]/.exec(uiChat)?.[1] ?? ''
  assert.ok(declared.includes('sidebarRight'), 'ui-chat must still declare sidebarRight in its inject face')
  const entry = readSource('../src/chamber-entry.ts')
  assert.match(entry, /register\('@deepseek-ai\/dsh-client-ui-chat', UiChat\)/,
    'the composite must register ui-chat through the roster-recording helper')
})

// ── Review F2: the deferred cluster's failures are reported BY ID through the
// ── same named-diagnostic shape the required-service probe uses.

test('chamberEntryDiagnosticMessage is the one line shape both diagnostics share', () => {
  assert.equal(
    chamberEntryDiagnosticMessage('something happened', 'local'),
    '[chamber-entry] (instance local) something happened',
  )
  assert.equal(chamberEntryDiagnosticMessage('something happened'), '[chamber-entry] something happened')
  // The probe message is built THROUGH it (a refactor of the existing line, not
  // a rewrite): same prefix, same instance clause position.
  const missing = [{ service: 'sidebarRight', injectedBy: ['@deepseek-ai/dsh-client-ui-chat'] }]
  assert.ok(requiredServiceProbeMessage(missing, 'local').startsWith('[chamber-entry] (instance local) '))
  assert.ok(requiredServiceProbeMessage(missing).startsWith('[chamber-entry] composite service(s)'))
})

test('deferredRegistrationFailureMessage names every failed id, the instance and the consequence', () => {
  const failed = ['@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-chamber-client-ui-settings-bridge']
  const message = deferredRegistrationFailureMessage(failed, 'local')
  assert.ok(message.startsWith('[chamber-entry] (instance local)'), 'same prefix + instance clause as the probe')
  assert.ok(message.includes('2'), 'the count must be stated')
  for (const id of failed) assert.ok(message.includes(id), `failed id ${id} must be named`)
  // The consequence is the SLOT/SERVICE gap (ui-tool declares tool.call.toolview,
  // which the extra row ui-cordis injects into), not a boot failure.
  assert.ok(message.includes('slot'), 'the undeclared-slot consequence must be stated')
  assert.ok(message.includes('NOT blocked'), 'the diagnostic-not-gate contract must be stated')
  assert.ok(deferredRegistrationFailureMessage(failed).startsWith('[chamber-entry] deferred'),
    'an unknown instance adds no clause')
})

test('DEFERRED_EXTRA_ROW_IDS: unique, legal package names, covered but factory-less (the deferred shape)', () => {
  // The roster is what host-graph.ts matches an extra row's `external` requests
  // against: "covered by the composite, but registered only AFTER the boot
  // settled" is exactly "in CHAMBER_COVERED_IDS and NOT in
  // CHAMBER_COVERED_FACTORY_IDS".
  assert.equal(new Set(DEFERRED_EXTRA_ROW_IDS).size, DEFERRED_EXTRA_ROW_IDS.length)
  assert.ok(DEFERRED_EXTRA_ROW_IDS.length > 0, 'the roster must not be empty')
  const pkgName = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
  for (const id of DEFERRED_EXTRA_ROW_IDS) {
    assert.match(id, pkgName, `deferred id ${JSON.stringify(id)} is not a legal package name`)
    assert.ok(CHAMBER_COVERED_IDS.includes(id), `deferred id ${id} must stay covered (else its host-graph row double-registers)`)
    assert.ok(!CHAMBER_COVERED_FACTORY_IDS.includes(id),
      `deferred id ${id} must have NO module-table factory (that is what makes it a guaranteed require miss)`)
  }
  // The families whose failure this diagnostic exists for: ui-tool declares the
  // `tool.call.toolview` slot the extra row ui-cordis injects into
  // (vendor ui-tool/src/client/apply.ts:38, ui-cordis/src/client/index.ts:119-143).
  assert.ok(DEFERRED_EXTRA_ROW_IDS.includes('@deepseek-ai/dsh-client-ui-tool'))
  assert.ok(DEFERRED_EXTRA_ROW_IDS.includes('@deepseek-ai/dsh-client-ui-trajectory'))
  assert.ok(DEFERRED_EXTRA_ROW_IDS.includes('@dsh-chamber/dsh-chamber-client-ui-settings-bridge'))
  // ui-settings stays FIRST-SCREEN (locale/ui-theme root-inject settingsScope):
  // it has a factory and must never be listed as deferred.
  assert.ok(!DEFERRED_EXTRA_ROW_IDS.includes('@deepseek-ai/dsh-client-ui-settings'))
})

test('chamber-entry wires the deferred roster, the per-row isolation and the named report', () => {
  const entry = readSource('../src/chamber-entry.ts')
  // The roster is the single source both the lockstep assert and the diagnostic
  // use — a locally invented list would drift from required-extra-rows.ts.
  assert.match(entry, /DEFERRED_EXTRA_ROW_IDS/, 'the entry must reconcile its roster with the shared list')
  assert.match(entry, /assertDeferredRosterLockstep\(\)/, 'a roster drift must fail the entry loud (apply-time assert)')
  // Per-row isolation: one failed chunk must neither cancel the rest of the
  // cluster (a failed settings-bridge used to drop every settings section) nor
  // hide WHICH id failed.
  assert.match(entry, /DEFERRED_ROWS\.map\(async \(\[id, load\]\) => \{/,
    'the cluster must be a data-driven id+chunk roster, loaded per row')
  assert.match(entry, /catch \(error\)/, 'each chunk load needs its own catch (the failed id set is the report)')
  assert.match(entry, /const failed: string\[\] = \[\]/, 'the failures must be collected BY ID')
  assert.doesNotMatch(entry, /\] = await Promise\.all\(\[\s*\n\s*import\(/,
    'a bare Promise.all over the imports loses the failed-id set and drops the whole cluster')
  // Reporting: the shared builder + the shell seam (never console-only), and
  // still no boot gate (the registration is fire-and-forget).
  assert.match(entry, /deferredRegistrationFailureMessage\(/, 'the failed id set must be reported by name')
  assert.match(entry, /degradedSeam\(message\)/, 'the report must reach the shell degrade seam')
  assert.match(entry, /void registerDeferred\(ctx, degradedSeam\)\.catch/, 'a deferred failure must still never block the boot')
})

test('deferred rows mount with their row id as the fiber name', () => {
  const entry = readSource('../src/chamber-entry.ts')
  // Cordis names an UNNAMED fiber after its nearest NAMED ancestor (cordis
  // fiber.ts `get name()`, else 'root'), so a bare mount makes every fiber in
  // this cluster report as `@dsh-chamber/app` — in cordis error text and in the
  // crash-attribution index, which are read by humans and by the plugin-status
  // surfaces. The upstream loader names graph rows by id
  // (`loader.create({ name: row.id })`); this pins the composite to the same
  // convention.
  assert.match(entry, /ctx\.plugin\(\{ \.\.\.\w+, name: outcome\.id \}\)/,
    'a deferred row must be mounted with its row id as the fiber name')
  assert.doesNotMatch(entry, /ctx\.plugin\((?:outcome\.plugin|loaded)\)/,
    'a bare mount loses the row identity in every fiber-name diagnostic')
})

// ── A1 wiring: every first-screen mount goes through the roster-recording
// ── helper, so registration and probed set can never drift apart.

test('chamber-entry derives the probed roster from the registered namespaces (no hand-written service list)', () => {
  const entry = normalize(stripComments(readSource('../src/chamber-entry.ts')))
  // The helper IS the registration path: one call mounts the plugin AND records
  // the id + the namespace's exported inject face…
  assert.match(entry, /const register = \(id: string, plugin: object\): void => \{/,
    'the register helper must mount and record in one step')
  assert.match(entry, /const fiber = ctx\.plugin\(plugin\) as unknown as \{ inject\?: unknown \} \| undefined/,
    'the mount happens inside the helper, so no bare ctx.plugin can bypass the roster')
  assert.match(entry, /const declared = registeredInjectMembers\(id, \(plugin as \{ inject\?: unknown \}\)\.inject\)/,
    'the roster source is the namespace export, normalized by the shared helper')
  assert.match(entry, /registered\.push\(\{ id, inject: declared \}\)/,
    'the derived declaration (never a local service list) is what the probe receives')
  // …and the fiber's own inject map is a WITNESS: a namespace whose declaration
  // stopped being exported (so the derivation would silently shrink) fails loud.
  assert.match(
    entry,
    /plugin \$\{id\} mounts an inject set \$\{JSON\.stringify\(witnessKeys\)\} that its namespace does not export/,
    'a derivation blind spot must fail the entry loud, never shrink the roster silently',
  )
  // No bare first-screen mount can bypass the roster: the only ctx.plugin calls
  // left are the helper's own (`plugin`) and the deferred cluster's named object
  // form (whose chunks are not evaluated when the probe runs).
  const args = [...entry.matchAll(/ctx\.plugin\(([^)]*)/g)].map(match => match[1]!.trim())
  assert.ok(args.length > 0, 'the composite must still register plugins')
  for (const arg of args) {
    assert.ok(arg.startsWith('plugin') || arg.startsWith('{'),
      `a bare ctx.plugin(${arg}…) bypasses the derived roster — mount it through register()`)
  }
  // The probe consumes exactly that roster, and the old hardcoded list is gone.
  assert.match(entry, /missingInjectedServices\(registered, isProvided\)/,
    'the probe must test the derived inject union, never a local list')
  assert.match(entry, /assertRequiredExtraRowServices\(ctx, degradedSeam, registered\)/,
    'the derived roster must reach the probe')
  assert.doesNotMatch(entry, /REQUIRED_EXTRA_ROW_SERVICES/, 'the hand-written roster constant is retired')
  assert.doesNotMatch(entry, /requiredServiceProbeMessage\(isProvided/, 'the probe must pass the missing set, not a predicate')
})
