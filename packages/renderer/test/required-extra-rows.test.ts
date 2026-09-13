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
import { existsSync, readFileSync } from 'node:fs'
import {
  chamberEntryDiagnosticMessage,
  deferredRegistrationFailureMessage,
  DEFERRED_EXTRA_ROW_IDS,
  injectedServices,
  missingInjectedServices,
  missingServiceFact,
  registeredInjectMembers,
  requiredServiceProbeMessage,
  REQUIRED_SERVICE_PROBE_DEADLINE_MS,
  type RegisteredPluginInject,
} from '../src/required-extra-rows.ts'
import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from '../src/chamber-covered.ts'
import { normalize, stripComments } from './source-text.ts'

const readSource = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
const sourceExists = (rel: string): boolean =>
  existsSync(new URL(rel, import.meta.url))

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

test('missingServiceFact carries the verdict as structured facts, not as a sentence', () => {
  // 2026-12 (design 05 §4): the frame renders its own copy and may NAME the
  // missing service — recovering that by parsing the diagnostic line would be
  // brittle by construction, so the producer hands the fields over.
  const fact = missingServiceFact([
    { service: 'sidebarRight', injectedBy: ['@deepseek-ai/dsh-client-ui-chat'] },
    { service: 'slots', injectedBy: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-chat'] },
  ])
  assert.deepEqual(fact.services, ['sidebarRight', 'slots'], 'roster order, one entry per service')
  assert.deepEqual(
    fact.injectedBy,
    ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-renderer'],
    'the injector union is deduped (a plugin injecting two missing services is named once) in first-seen order',
  )
  assert.deepEqual(missingServiceFact([]), { services: [], injectedBy: [] })
})

// ── Finding 3 (2026-09-11 review-fix): the roster's SOURCE audit ────────────
//
// The derived roster is only as true as the declarations behind it, and until
// this round nothing read them: the spec locked ui-chat's face alone, while the
// runtime witness (chamber-entry.ts `register`) CANNOT see the class this test
// exists for — cordis resolves the fiber's inject map from the very same
// expression the derivation reads (`Inject.resolve(plugin.inject)`), so a
// namespace that stops exporting `inject` yields an empty face on BOTH sides:
// no throw, a silently smaller roster, and every family injecting the lost
// members pends forever with no diagnostic. Only a source audit can catch that,
// so this test resolves each registered id's client entry the way
// chamber-entry.ts imports it, derives the faces through the PRODUCTION
// normalizer, and pins:
//
//  - every registered id's face equals its audited face (a face that changes —
//    in this repo or upstream at the next pin — is a visible, reviewable fact,
//    the same discipline the host-graph/factory rosters follow);
//  - every registered id still EXPORTS a face at all (the silent-shrink hole);
//  - the derived union is a superset of the services the probe must cover,
//    `sidebarRight` among them — the miss the probe exists for (ui-chat's face,
//    whose only provider is the non-covered `ui-sidebar-right` row);
//  - the deferred-only members (finding 1) are exactly the audited 11, so the
//    roster extension is load-bearing and never quietly grows a new gap class.
//
// Maintenance at an upstream pin: re-audit the two tables below against the new
// sources (the pin-upgrade checklist already sends the reader to the
// `register(...)` calls) — the failure message names the id and both faces.

/** Client-entry candidates inside one package, in the order chamber-entry's
 *  namespace import resolves them (the two apply.ts entries re-export `inject`
 *  through index.ts; every other package declares it in index.ts). */
const CLIENT_ENTRY_CANDIDATES = ['src/client/apply.ts', 'src/client/index.ts', 'src/client/index.tsx']

/** The source file a registered package id's client entry lives in (vendor
 *  symlink tree first, then the in-repo forks: dsh-client-connection and
 *  dsh-api-gateway are chamber copies, not vendor packages). */
function clientEntrySource(id: string): string {
  const base = id.slice(id.indexOf('/') + 1)
  const roots = [`../../../vendor/harness-packages/${id}`, `../../../packages/${base}`]
  for (const root of roots) {
    for (const rel of CLIENT_ENTRY_CANDIDATES) {
      const file = `${root}/${rel}`
      if (sourceExists(file)) return file
    }
  }
  throw new Error(`no client entry source found for ${id} — check the vendor/in-repo layout this test resolves against`)
}

/** The namespace's exported `inject` face, read from its client entry source.
 *  `undefined` when the source declares none — the silent-shrink hole. */
function faceFromSource(id: string, file: string): unknown {
  const match = /export const inject[^=]*=\s*(\[[\s\S]*?\]|\{[\s\S]*?\n\})/.exec(readSource(file))
  if (match === null) return undefined
  try {
    return new Function(`return (${match[1]})`)() as unknown
  } catch (error) {
    throw new Error(`inject face of ${id} (${file}) is not a literal this audit can read: ${String(error)}`)
  }
}

/**
 * The audited inject face of every FIRST-SCREEN namespace `chamber-entry.ts`
 * registers, in registration order (id → members). This is the audit finding 3
 * asks for; the derived union below is computed from the SOURCES and compared
 * against it, never copied from it.
 */
const AUDITED_FIRST_SCREEN_FACES: ReadonlyArray<readonly [id: string, members: readonly string[]]> = [
  ['@deepseek-ai/dsh-client-connection', []],
  ['@deepseek-ai/dsh-typert-registry', []],
  ['@deepseek-ai/dsh-api-gateway', ['typert', 'connection']],
  ['@deepseek-ai/dsh-api-remotes', ['remote']],
  ['@deepseek-ai/dsh-api-session-controller',
    ['connection', 'fileUpload', 'typert', 'remote', 'remote.commands', 'remote.session', 'remote.subagents']],
  ['@deepseek-ai/dsh-api-workspace-controller', ['remote', 'remote.workspace']],
  ['@deepseek-ai/dsh-client-file-upload', ['remote']],
  ['@deepseek-ai/dsh-client-locale', ['slots', 'remote', 'settingsScope']],
  ['@deepseek-ai/dsh-client-ui-theme', ['slots', 'locale', 'remote', 'settingsScope']],
  ['@dsh-chamber/dsh-chamber-client-ui-layout', ['slots', 'theme', 'locale']],
  ['@dsh-chamber/dsh-chamber-client-ui-sidebar',
    ['slots', 'layout', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'locale']],
  ['@dsh-chamber/dsh-chamber-client-ui-git', ['slots', 'locale']],
  ['@dsh-chamber/dsh-chamber-client-ui-open-in', ['slots', 'locale']],
  ['@deepseek-ai/dsh-client-ui-settings', ['remote', 'remote.settings']],
  ['@deepseek-ai/dsh-client-ui-conversation',
    ['slots', 'sessions', 'fileUpload', 'uiSession', 'uiWorkspace', 'locale', 'settingsScope']],
  ['@deepseek-ai/dsh-client-ui-commands', ['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale']],
  ['@deepseek-ai/dsh-client-ui-input-trigger', ['sessions', 'locale']],
  ['@deepseek-ai/dsh-client-ui-workspace',
    ['slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.directoryPicker', 'layout']],
  ['@deepseek-ai/dsh-client-ui-model-selection', ['commandUi', 'locale', 'sessions', 'slots', 'remote', 'remote.session']],
  ['@deepseek-ai/dsh-client-ui-session', ['sessions', 'slots']],
  ['@deepseek-ai/dsh-client-ui-chat',
    ['slots', 'sessions', 'uiSession', 'uiConversation', 'locale', 'settingsScope', 'remote', 'remote.session', 'sidebarRight']],
  ['@deepseek-ai/dsh-client-ui-approval', ['sessions', 'remote', 'uiSession', 'slots', 'locale']],
  ['@deepseek-ai/dsh-client-ui-directory-picker-browse', ['slots', 'uiWorkspace', 'locale']],
]

/**
 * The services the probe MUST cover (the audited floor of the derived union,
 * independent of which family happens to declare them): the sole non-covered
 * provider case (`sidebarRight`), the primary composition words, and the
 * frame's own chrome dependencies. Subset assertion — a new member is allowed,
 * a lost one is not.
 */
const AUDITED_REQUIRED_SERVICES: readonly string[] = [
  'slots', 'locale', 'sessions', 'workspaces', 'connection', 'remote', 'typert', 'fileUpload',
  'uiSession', 'uiConversation', 'uiWorkspace', 'layout', 'theme', 'settingsScope',
  'commandUi', 'inputTriggers', 'remote.session', 'sidebarRight',
]

/**
 * The deferred inject members that NO first-screen face declares (finding 1).
 * Each one's provider is a first-screen COMPOSITE plugin (the generated-remote
 * mounts behind api-remotes, ui-settings for `settingsSchema`) — which is why
 * the deferred split stays safe, and exactly the assumption the roster
 * extension stopped taking on faith.
 */
const AUDITED_DEFERRED_ONLY_SERVICES: readonly string[] = [
  'remote.goals', 'remote.skills', 'remote.messageFeedback', 'remote.sessionFeedback',
  'remote.agentPresets', 'remote.credentials', 'remote.llm', 'remote.pluginInventory',
  'remote.fileReferences', 'remote.sessionReferenceResolver', 'settingsSchema',
]

/** The `register(...)` calls of chamber-entry.ts, in order: [id, local import name]. */
function registeredPlugins(): Array<[string, string]> {
  const entry = readSource('../src/chamber-entry.ts')
  const imports = new Map<string, string>()
  for (const match of entry.matchAll(/^import \* as (\w+) from '([^']+)'$/gm)) {
    imports.set(match[1]!, match[2]!)
  }
  const out: Array<[string, string]> = []
  for (const match of entry.matchAll(/register\('([^']+)', (\w+)\)/g)) {
    const spec = imports.get(match[2]!)
    assert.ok(spec !== undefined, `registered id ${match[1]} has no namespace import — the roster source is the import`)
    out.push([match[1]!, spec!])
  }
  return out
}

/** The `DEFERRED_ROWS` ids of chamber-entry.ts, in order (id + chunk specifier). */
function deferredPlugins(): Array<[string, string]> {
  const entry = readSource('../src/chamber-entry.ts')
  const out: Array<[string, string]> = []
  for (const match of entry.matchAll(/\['([^']+)', \(\) => import\('([^']+)'\)\]/g)) {
    out.push([match[1]!, match[2]!])
  }
  return out
}

test('every registered first-screen namespace still exports its audited inject face', () => {
  const registered = registeredPlugins()
  assert.equal(registered.length, AUDITED_FIRST_SCREEN_FACES.length,
    'the audited face table must cover every register(...) call — a new family is a new audit')
  for (const [index, [id]] of registered.entries()) {
    const [auditedId, auditedMembers] = AUDITED_FIRST_SCREEN_FACES[index]!
    assert.equal(id, auditedId, `registration order changed: ${id} is not at index ${index} in the audited table`)
    const file = clientEntrySource(id)
    const face = faceFromSource(id, file)
    assert.notEqual(face, undefined,
      `${id} (${file}) no longer exports an inject face — the derived roster would shrink SILENTLY `
      + '(cordis reads undefined too, so no runtime witness can catch it): restore the export or re-audit this spec')
    // The PRODUCTION normalizer, fed the source's own declaration: what the
    // composite would record is what the table audits.
    assert.deepEqual(registeredInjectMembers(id, face), [...auditedMembers],
      `${id}'s inject face (${file}) changed — re-audit the roster and update AUDITED_FIRST_SCREEN_FACES`)
  }
})

test('the derived union covers every audited required service (sidebarRight included)', () => {
  // The union is computed from the SOURCES through the production rules — the
  // same derivation chamber-entry.ts performs at apply time — so this fails when
  // the real faces lose a member, not merely when the table drifts.
  const roster: RegisteredPluginInject[] = registeredPlugins().map(([id]) => {
    const file = clientEntrySource(id)
    return { id, inject: faceFromSource(id, file) }
  })
  const union = injectedServices(roster)
  for (const service of AUDITED_REQUIRED_SERVICES) {
    assert.ok(union.includes(service),
      `the derived roster lost ${service} — the probe would never report its miss (union: ${JSON.stringify(union)})`)
  }
  // The motivating case, spelled out: ui-chat's `sidebarRight`, provided ONLY by
  // the non-covered ui-sidebar-right host-graph row.
  const chat = roster.find(plugin => plugin.id === '@deepseek-ai/dsh-client-ui-chat')
  assert.deepEqual(registeredInjectMembers('ui-chat', chat?.inject).includes('sidebarRight'), true)
  // And the probe's behaviour on that roster: everything provided except
  // sidebarRight reports exactly that service with its injectors, and nothing
  // else (the healthy arm a full union must produce).
  const missing = missingInjectedServices(roster, name => name !== 'sidebarRight')
  assert.deepEqual(missing.map(entry => entry.service), ['sidebarRight'])
  assert.ok(missing[0]!.injectedBy.includes('@deepseek-ai/dsh-client-ui-chat'))
  assert.deepEqual(missingInjectedServices(roster, () => true), [])
})

test('the deferred cluster carries exactly the audited deferred-only inject members (finding 1)', () => {
  // The roster extension is load-bearing only if these members really are absent
  // from every first-screen face: this pins BOTH directions, so a future
  // first-screen family that starts declaring one of them (making the extension
  // redundant) and a new deferred-only member (a new silent-gap candidate) are
  // both visible here instead of in a field report.
  const firstScreen = injectedServices(registeredPlugins().map(([id]) => {
    const file = clientEntrySource(id)
    return { id, inject: faceFromSource(id, file) }
  }))
  const deferredRoster: RegisteredPluginInject[] = deferredPlugins().map(([id, spec]) => {
    const file = clientEntrySource(spec.replace(/\/client$/, ''))
    return { id, inject: faceFromSource(id, file) }
  })
  const deferredOnly = injectedServices(deferredRoster).filter(service => !firstScreen.includes(service))
  assert.deepEqual([...deferredOnly].sort(), [...AUDITED_DEFERRED_ONLY_SERVICES].sort(),
    'the deferred-only inject members changed — re-audit finding 1\'s list (chamber-entry.ts comment + this spec)')
  // Each audited member is named by a deferred family, and the probe reports it
  // with that family once the deferred roster is part of the probed set: the
  // behaviour the re-armed pass exists for.
  const fullRoster = [
    ...registeredPlugins().map(([id]) => ({ id, inject: faceFromSource(id, clientEntrySource(id)) })),
    ...deferredRoster,
  ]
  const missing = missingInjectedServices(fullRoster, name => !AUDITED_DEFERRED_ONLY_SERVICES.includes(name))
  assert.deepEqual([...missing.map(entry => entry.service)].sort(), [...AUDITED_DEFERRED_ONLY_SERVICES].sort())
  for (const entry of missing) {
    assert.ok(entry.injectedBy.length > 0, `${entry.service} must name the deferred family injecting it`)
    for (const id of entry.injectedBy) {
      assert.ok(DEFERRED_EXTRA_ROW_IDS.includes(id),
        `${entry.service} is injected by ${id}, which is not a deferred row — the deferred-only audit is stale`)
    }
  }
  // Spot-check the reviewer's own example: `remote.goals` comes from ui-goal.
  assert.deepEqual(missing.find(entry => entry.service === 'remote.goals')?.injectedBy,
    ['@deepseek-ai/dsh-client-ui-goal'])
})

test('a roster that grows after the probe started is probed (finding 1: the live array + the re-arm)', () => {
  // The probe's roster is the SAME array apply() passed in; registerDeferred
  // pushes into it as each chunk mounts (source-text lock below). This is the
  // decision-side half: a member added after construction is probed like any
  // other, which is what makes the re-armed pass worth its one extra poll.
  const roster: RegisteredPluginInject[] = [{ id: '@deepseek-ai/dsh-client-ui-chat', inject: ['slots'] }]
  assert.deepEqual(missingInjectedServices(roster, name => name === 'slots'), [])
  roster.push({ id: '@deepseek-ai/dsh-client-ui-goal', inject: ['slots', 'remote.goals'] })
  assert.deepEqual(missingInjectedServices(roster, name => name === 'slots'), [
    { service: 'remote.goals', injectedBy: ['@deepseek-ai/dsh-client-ui-goal'] },
  ])
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
  // 2026-12 (design 05 §4): the deferred cluster reports its OWN kind with the
  // failed ids attached. Sharing the probe's kind made the two facts
  // indistinguishable to the frame's copy table (and dropped the second one as a
  // same-kind repeat).
  assert.match(
    entry,
    /degradedSeam\(\{\s*kind: 'deferred-registration-failed',\s*message,\s*failedIds: \[\.\.\.failed\],\s*\}\)/,
    'the report must reach the shell degrade seam as a structured fact of its own kind',
  )
  assert.match(entry, /void registerDeferred\(ctx, degradedSeam, registered, probeRearm\)\.catch/,
    'a deferred failure must still never block the boot')
  // 2026-09-11 review-fix (finding 1): the deferred rows extend the LIVE probe
  // roster with their own exported inject face, and one probe pass is re-armed
  // once the cluster registered — without both, a deferred family whose
  // composite-provided service never activated pends with no diagnostic. The
  // recording is normalized EAGERLY and per-row guarded, so a bad face cannot
  // surface as an uncaught throw inside the probe timer, nor cost the rows after
  // it their mount.
  assert.match(entry, /registered\.push\(\{ id: outcome\.id, inject: registeredInjectMembers\(outcome\.id, loaded\.inject\) \}\)/,
    'each mounted deferred row must feed its namespace inject face into the probed roster')
  assert.match(entry, /deferred plugin \$\{outcome\.id\} exports an unreadable inject face/,
    'an unreadable deferred face must be logged per row, never thrown out of the cluster loop')
  assert.match(entry, /if \(mounted > 0\) probeRearm\.reArm\?\.\(\)/,
    'the roster growth must re-arm one probe pass (the probe stops on a clean verdict)')
  assert.match(entry, /probeRearm\.reArm = \(\) => \{/,
    'the probe must publish its re-arm hook for the deferred cluster')
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
  assert.match(entry, /assertRequiredExtraRowServices\(ctx, degradedSeam, registered, probeRearm\)/,
    'the derived roster must reach the probe (with the re-arm hand-off, finding 1)')
  assert.doesNotMatch(entry, /REQUIRED_EXTRA_ROW_SERVICES/, 'the hand-written roster constant is retired')
  assert.doesNotMatch(entry, /requiredServiceProbeMessage\(isProvided/, 'the probe must pass the missing set, not a predicate')
  // 2026-12 (design 05 §4): the probe's verdict travels STRUCTURED — the kind
  // plus the service/injector facts — through the shell seam, so the frame's
  // copy can name the missing service instead of parsing the diagnostic line.
  assert.match(
    entry,
    /degradedSeam\(\{ kind: 'required-services-missing', message, \.\.\.missingServiceFact\(missing\) \}\)/,
    'the probe must report the structured fact (kind + services + injectors)',
  )
})
