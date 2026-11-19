/**
 * E2 consumption wiring (review C9 ②③, design 27 §3.3): the derived link facts must reach
 * the three NEW-request gates and the two user-facing surfaces without a second reading of
 * the projection:
 *  - the boot-defer gate (App → bootDeferralReasonForSource(kind-checked phase, linkDown), with shouldDeferBootForSource as its boolean form);
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
import { linkReady } from '@dsh-chamber/dsh-chamber-client-core'
import { instanceConnected } from '../../src/transport-source.ts'

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

test('App: the boot-defer gate feeds ONE kind-validated raw projection and the derived link fact', () => {
  // The phase input stays the RAW transport projection (a folded/missing projection must not read
  // as a manual disconnect) and is kind-gated: during a registry kind switch the OLD provider's
  // READY is not the replacement's fact (the instanceConnected discipline). The link dimension
  // rides the derived aggregate fact, never a second read; the deferral REASON is decided here
  // once and handed to the veil (InstanceView must not re-derive it from a derived phase — P2-1).
  assert.match(appSource, /const raw = remoteStatus\[rawId\]/)
  assert.match(appSource,
    /bootDeferralReasonForSource\(raw\?\.kind === server\.kind \? raw\.phase : undefined, server\.linkState === 'down'\)/)
  assert.match(appSource, /bootDeferReason=\{deferredBootReasons\.get\(viewId\)\}/,
    'the App hands InstanceView the explicit reason instead of a derived phase')
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
  // 来路由 App 一次判定（原始相位 + 链路事实）；组件只消费，绝不从派生 sourcePhase 反推——
  // gateway 托管折叠会让派生相位非 ready，从相位反推会把链路 down 误播成手动断开（P2-1）。
  assert.match(viewSource, /const bootDeferred = bootDeferReason !== undefined/)
  assert.match(viewSource, /deferredBootReason\(bootDeferred, bootDeferReason\)/,
    'the veil reads the App-computed reason, never re-derives it from sourcePhase')
  assert.equal(/deferredBootReason\([^)]*sourcePhase/.test(viewSource), false,
    'sourcePhase must not feed the deferral reason (a derived-phase fold is not a deferral fact)')
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

test('prewarm: a stale old-kind READY(+down) projection cannot pass the candidate gate', () => {
  // linkReady alone would read the OLD provider's projection; the scheduler ANDs instanceConnected,
  // which requires status.kind === instance.kind — the replacement kind never inherits the old
  // provider's READY/link fact (P2-2).
  const stale = { kind: 'dsh', phase: 'ready', link: { state: 'down', linkEpoch: 1 } }
  assert.equal(linkReady(stale), false, 'linkReady reads the old projection as not ready for NEW work')
  assert.equal(instanceConnected('gateway', null, { g1: stale } as never, 'g1'), false,
    'the kind gate rejects the stale projection, so the prewarm conjunction is false')
  // Control: matched kind keeps both gates honest (ready+down is excluded by linkReady).
  assert.equal(linkReady({ phase: 'ready', link: { state: 'down', linkEpoch: 1 } }), false)
  assert.equal(instanceConnected('gateway', null, { g1: { kind: 'gateway', phase: 'ready' } } as never, 'g1'), true)
})

test('ConnectionsSection: a ready-but-down card gets the bad tone and the shared hint', () => {
  assert.match(connectionsSource, /linkReady/,
    'the card reuses the ONE link reading instead of re-spelling the state comparison')
  assert.match(connectionsSource,
    /const linkDown = status !== undefined && phase === 'ready' && !linkReady\(status\)/)
  assert.match(connectionsSource, /\|\| linkDown\) && css\.badgeBad/,
    'the status badge must not stay green while the link fast-fails new requests')
  assert.match(connectionsSource, /phase === 'ready' && !linkDown && css\.badgeOk/,
    'a ready-but-down card must not carry the ok fill (its tone cannot depend on CSS order)')
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

test('aggregate pull and the staleness watchdog consume the ONE reachability partition (fourth gate)', () => {
  // design 06 §4.8 ④: a ready-and-down source is PARKED — it must not enter the refresh plan, and it
  // must not be treated as not-connected (that reset prunes snapshots/runtime facts). The partition
  // itself is locked in transport-source.test.ts; this test pins the hook wiring (source text).
  const hookSource = read('../../src/app-hooks/use-aggregate-refresh.ts')
  assert.match(hookSource,
    /const \{ ready, notReady \} = partitionSourceReachability\(health, remoteStatus, remoteInstances\)/,
    'the edge poll reads the partition bucket, not a second kind/phase reading')
  assert.match(hookSource, /partitionSourceReachability\(health, remoteStatus, remoteInstances\)\.ready/,
    'the staleness watchdog consumes the SAME ready bucket')
  assert.equal(hookSource.includes('collectReadySourceIds'), false,
    'the local two-bucket collector must not come back')
  assert.equal(hookSource.includes('linkDown'), false,
    'the parked bucket never feeds the not-connected reset (down is not a disconnect)')
  assert.equal(hookSource.includes('instanceConnected('), false,
    'no second reachability reading may shadow the partition')
})
