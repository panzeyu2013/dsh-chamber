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
  missingRequiredServices,
  requiredServiceProbeMessage,
  REQUIRED_EXTRA_ROW_SERVICES,
  REQUIRED_SERVICE_PROBE_DEADLINE_MS,
} from '../src/required-extra-rows.ts'
import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from '../src/chamber-covered.ts'

const readSource = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')

test('the required set names exactly the extra-row-only service a composite plugin injects', () => {
  // 2026-09 三轮: `fileUpload` was removed (the upload client is now covered by
  // the composite) and `resources` was removed — ui-sidebar-right INJECTS
  // `resources` (vendor ui-sidebar-right/src/client/index.ts:76) and the row is
  // itself non-covered, so a missing `resources` provider can only ever show up
  // together with the `sidebarRight` miss this set already probes.
  assert.deepEqual([...REQUIRED_EXTRA_ROW_SERVICES], ['sidebarRight'])
})

test('missingRequiredServices reports unprovided services in declaration order', () => {
  const none = missingRequiredServices(() => false)
  assert.deepEqual(none, ['sidebarRight'])
  assert.deepEqual(missingRequiredServices(name => name === 'sidebarRight'), [])
  assert.deepEqual(missingRequiredServices(() => true), [])
  // A caller-supplied set is honoured (probe reuse for future rows).
  assert.deepEqual(missingRequiredServices(name => name === 'a', ['a', 'b']), ['b'])
})

test('requiredServiceProbeMessage names the services, the deadline, and the instance', () => {
  const withInstance = requiredServiceProbeMessage(['sidebarRight'], 'local')
  assert.ok(withInstance.includes('instance local'), 'the instance id must be named when known')
  assert.ok(withInstance.includes('sidebarRight'), 'the missing service must be named')
  assert.ok(withInstance.includes(`${REQUIRED_SERVICE_PROBE_DEADLINE_MS}ms`), 'the deadline must be named')
  assert.ok(withInstance.includes('conversation view may stay unregistered'), 'the consequence must be stated')
  assert.ok(withInstance.includes('ui-sidebar-right'), 'the responsible row must be named')
  const withoutInstance = requiredServiceProbeMessage(['sidebarRight'])
  assert.ok(!withoutInstance.includes('instance'), 'an unknown instance adds no clause')
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
  assert.ok(requiredServiceProbeMessage(['sidebarRight'], 'local').startsWith('[chamber-entry] (instance local) '))
  assert.ok(requiredServiceProbeMessage(['sidebarRight']).startsWith('[chamber-entry] required extra-row service(s)'))
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

test('deferred rows mount with their row id as the fiber name (nav provenance)', () => {
  const entry = readSource('../src/chamber-entry.ts')
  // A slot entry's provenance stamp is its registrant FIBER's name
  // (ui-renderer registry.ts: `options.registrant ?? ctx.fiber.name`), and
  // cordis names an unnamed fiber after its nearest NAMED ancestor
  // (cordis fiber.ts `get name()`, else 'root'). Mounted bare, every row here
  // inherited `@dsh-chamber/app`, so the settings shell stamped every
  // composite-provided `settings.section` with a name that is not an
  // official/chamber PACKAGE id and marked each row「插件」. The upstream loader
  // names graph rows by id (`loader.create({ name: row.id })`); this pins the
  // composite to the same convention.
  assert.match(entry, /ctx\.plugin\(\{ \.\.\.\w+, name: outcome\.id \}\)/,
    'a deferred row must be mounted with its row id as the fiber name')
  assert.doesNotMatch(entry, /ctx\.plugin\((?:outcome\.plugin|loaded)\)/,
    'a bare mount loses the row identity and mislabels every settings section as plugin-provided')
})
