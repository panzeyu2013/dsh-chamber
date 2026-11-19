/**
 * E2 consumption wiring (review C9 ②③, design 27 §3.3): the derived link facts must reach
 * the three NEW-request gates and the two user-facing surfaces without a second reading of
 * the projection:
 *  - the boot-defer gate (App → shouldDeferBootForSource(phase, linkDown));
 *  - the prewarm/harvest candidate gate (use-view-scheduler excludes link-down sources);
 *  - the deferred veil (InstanceView: 「链路不可用」+「重试」 instead of 「未连接」+「连接」);
 *  - the connection card (ConnectionsSection: bad tone + shared hint, actions/shell kept);
 *  - the frame copy (renderer locales, zh + en).
 *
 * Pure decisions live in source-readiness.test.ts / link-projection.test.ts; this file pins
 * the WIRING (source text) and the copy — the repo's standing shape for hook/component seams.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { frameText } from '../../src/locales.ts'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

const appSource = read('../../src/App.tsx')
const viewSource = read('../../src/components/InstanceView.tsx')
const schedulerSource = read('../../src/app-hooks/use-view-scheduler.ts')
const connectionsSource = read('../../../dsh-chamber-client-ui-settings-connections/src/client/ConnectionsSection.tsx')
const connectionsLocalesSource = read('../../../dsh-chamber-client-ui-settings-connections/src/locales.ts')

test('frame copy: the link-down veil names the link, not a disconnect', () => {
  assert.match(frameText('zh', 'boot.linkDown', { label: 'R1' }), /链路不可用/, 'zh title names the link')
  assert.match(frameText('zh', 'boot.linkDown', { label: 'R1' }), /R1/, 'the source label rides the title')
  assert.match(frameText('en', 'boot.linkDown', { label: 'R1' }), /unavailable/, 'en title names the link')
  assert.match(frameText('zh', 'boot.linkDownHint'), /自动重试/, 'zh hint promises the automatic retry')
  assert.match(frameText('en', 'boot.linkDownHint'), /retries automatically/, 'en hint promises the automatic retry')
  // The manual-disconnect copy stays distinct (the overlay must not conflate the two facts).
  assert.notEqual(frameText('zh', 'boot.linkDown'), frameText('zh', 'boot.deferred', { label: 'R1' }))
})

test('App: the boot-defer gate feeds the derived link-down fact (raw phase unchanged)', () => {
  // The phase input stays the RAW transport projection (folding would turn a missing projection
  // into a refusal); the link dimension rides the derived aggregate fact, never a second read.
  assert.match(appSource,
    /if \(shouldDeferBootForSource\(remoteStatus\[rawId\]\?\.phase, server\.linkState === 'down'\)\) ids\.add\(server\.id\)/)
})

test('prewarm candidates exclude a link-down transport', () => {
  // C9 ②: linkReady is the client-core owner of "ready && not down" — the candidate filter must
  // call it (a down link's boot only burns the 503 budget / the single background slot).
  assert.match(schedulerSource,
    /\.filter\(instance => linkReady\(remoteStatus\[instance\.id\]\)\s*\n\s*&& instanceConnected\(instance\.kind, health, remoteStatus, instance\.id\)\)/)
  // The managed-dsh exclusion still follows the link gate (both are candidate gates).
  assert.match(schedulerSource, /managedRuntimeUnusable\(managedRuntime\[sourceIdForInstance\(instance\)\]\)/)
  assert.match(schedulerSource, /instance\.kind === 'gateway'\s*\n\s*&& managedRuntimeUnusable/)
})

test('InstanceView: the deferred veil branches on the deferral reason (copy + action)', () => {
  assert.match(viewSource, /deferredBootReason\(bootDeferred === true, sourcePhase\)/,
    'the veil reads the shared reason decision, never re-derives it')
  assert.equal((viewSource.match(/deferredReason === 'link-down'/g) ?? []).length, 3,
    'title + hint + action each select the link-down branch')
  assert.match(viewSource, /deferredReason === 'link-down' \? 'boot\.linkDown' : 'boot\.deferred'/,
    'the title selects the link copy')
  assert.match(viewSource, /deferredReason === 'link-down' \? 'boot\.linkDownHint' : 'boot\.deferredHint'/,
    'the hint selects the link copy')
  // The deferred veil stays actionable (decidePresentation is untouched: a deferred source is
  // actionable immediately, and the link-down case keeps the SAME frame — only copy/action move).
  assert.match(viewSource, /bootDeferred: bootDeferred === true,/)
})

test('ConnectionsSection: a ready-but-down card gets the bad tone and the shared hint', () => {
  assert.match(connectionsSource, /linkReady/,
    'the card reuses the ONE link reading instead of re-spelling the state comparison')
  assert.match(connectionsSource,
    /const linkDown = status !== undefined && phase === 'ready' && !linkReady\(status\)/)
  assert.match(connectionsSource, /\|\| linkDown\) && css\.badgeBad/,
    'the status badge must not stay green while the link fast-fails new requests')
  assert.match(connectionsSource, /role="status">\{t\('linkDownHint'\)\}/,
    'the hint is announced (role=status) exactly when no action hint owns the copy')
  // Behavior stays: the disconnect action and every already-mounted shell/snapshot survive.
  assert.match(connectionsSource,
    /onClick=\{\(\) => \{ void runTunnelOp\(spec\.id, connected \? 'disconnect' : 'connect'\) \}\}/,
    'the tunnel action gate stays phase-based (no clear/unmount on link down)')
})

test('settings copy: the card hint exists in BOTH dictionaries', () => {
  const entries = [...connectionsLocalesSource.matchAll(/linkDownHint:\s*'([^']*)'/g)].map(match => match[1]!)
  assert.equal(entries.length, 2, 'zh + en must both declare linkDownHint')
  assert.match(entries[0]!, /链路.*不可用/, 'zh copy names the unavailable link')
  assert.match(entries[1]!, /transport link/, 'en copy names the unavailable transport link')
})
