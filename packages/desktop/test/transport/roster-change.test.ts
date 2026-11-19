/**
 * Roster change set (design D §3.2.1/§3.4): the host's single committed diff for one
 * registry replacement. Pure tables — no manager, no IO, no clock. These assertions are
 * the field-classification contract the registry save and the committed push derive from:
 * a consumer may read only the dimensions it owns, and the identity field sets stay in
 * credential-identity.ts (source retirement) / this module (exec channel, seed fingerprint).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeRosterChangeSet,
  execIdentityChanged,
  type RosterChangeDimension,
} from '../../roster-change.ts'
import { logicalSourceIdentity, logicalSourceIdentityChanged } from '../../credential-identity.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'

/** A dsh-over-ssh row: the SSH endpoint triple IS the target identity. */
function dsh(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'same', label: 'host', kind: 'dsh', transport: 'ssh', host: 'a.example.com',
    user: 'alice', sshPort: 22, remotePort: 3080, serviceName: 'dsh-old',
    remoteDshHome: '~/.dsh', insecureHttp: false, ...overrides,
  }
}

/** A gateway-over-ssh row: kind+host+remotePort are identity, the SSH login is mechanism. */
function gateway(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'same', label: 'gateway', kind: 'gateway', transport: 'ssh', host: 'gw.example.com',
    user: 'alice', sshPort: 22, remotePort: 443, serviceName: 'dsh',
    remoteDshHome: '~/.dsh', insecureHttp: false, ...overrides,
  }
}

/** The HTTP-normalized gateway row (SSH-only fields are null by provider validation). */
function gatewayHttp(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return gateway({
    transport: 'http', user: null, sshPort: null, serviceName: null,
    remoteDshHome: null, ...overrides,
  })
}

function dimensionsOf(before: TransportInstanceSpec, after: TransportInstanceSpec): RosterChangeDimension[] {
  const set = computeRosterChangeSet([before], [after]).rows[0]!.dimensions
  return [...set].sort()
}

const sorted = (values: readonly RosterChangeDimension[]): RosterChangeDimension[] => [...values].sort()

test('the logical source identity is kind-aware: gateway ignores SSH account fields, dsh keeps them', () => {
  const sshGateway = gateway()
  const identity = logicalSourceIdentity(sshGateway)
  for (const patch of [
    { user: 'bob' },
    { sshPort: 2222 },
    { transport: 'http' as const, user: null, sshPort: null },
    { serviceName: 'other' },
    { remoteDshHome: '~/other' },
    { insecureHttp: true },
    { spkiPin: 'ab'.repeat(32) },
    { label: 'renamed' },
  ]) {
    const edited = { ...sshGateway, ...patch }
    assert.equal(logicalSourceIdentity(edited), identity, 'a gateway mechanism/metadata edit keeps the source identity: ' + JSON.stringify(patch))
    assert.equal(logicalSourceIdentityChanged(sshGateway, edited), false)
  }
  for (const patch of [{ host: 'other.example.com' }, { remotePort: 8443 }, { kind: 'dsh' as const }]) {
    const edited = { ...sshGateway, ...patch }
    assert.notEqual(logicalSourceIdentity(edited), identity, 'a gateway target edit retargets the source: ' + JSON.stringify(patch))
    assert.equal(logicalSourceIdentityChanged(sshGateway, edited), true)
  }

  const sshDsh = dsh()
  const dshIdentity = logicalSourceIdentity(sshDsh)
  for (const patch of [{ user: 'bob' }, { sshPort: 2222 }, { host: 'other.example.com' }, { remotePort: 4080 }, { kind: 'gateway' as const }]) {
    assert.notEqual(logicalSourceIdentity({ ...sshDsh, ...patch }), dshIdentity, 'a dsh endpoint edit retargets the source: ' + JSON.stringify(patch))
  }
  for (const patch of [{ label: 'renamed' }, { serviceName: 'other' }, { remoteDshHome: '~/other' }, { transport: 'http' as const }]) {
    const edited = { ...sshDsh, ...patch }
    assert.equal(logicalSourceIdentity(edited), dshIdentity, 'a dsh metadata/mechanism edit keeps the identity: ' + JSON.stringify(patch))
  }
})

test('the exec channel identity is one field list (label/scheme/pin never rebind it)', () => {
  const base = dsh()
  for (const patch of [
    { kind: 'gateway' as const }, { transport: 'http' as const }, { host: 'other.example.com' },
    { user: 'bob' }, { sshPort: 2222 }, { remotePort: 4080 },
    { serviceName: 'other' }, { remoteDshHome: '~/other' },
  ]) {
    assert.equal(execIdentityChanged(base, { ...base, ...patch }), true, 'exec identity must include ' + JSON.stringify(patch))
  }
  assert.equal(execIdentityChanged(base, { ...base, label: 'renamed', insecureHttp: true, spkiPin: 'ab'.repeat(32) }), false,
    'presentation/scheme/pin never rebind exec work')
})

test('the dimension matrix derives every consequence from one committed diff', () => {
  const dshBase = dsh()
  const gatewaySsh = gateway()
  const gatewayHttpBase = gatewayHttp()
  const cases: Array<{ name: string; before: TransportInstanceSpec; after: TransportInstanceSpec; expected: RosterChangeDimension[] }> = [
    { name: 'label only', before: dshBase, after: { ...dshBase, label: 'renamed' }, expected: ['displayOnly'] },
    { name: 'nothing changed', before: dshBase, after: { ...dshBase }, expected: [] },
    { name: 'label with another edit is not displayOnly', before: dshBase, after: { ...dshBase, label: 'renamed', serviceName: 'x' }, expected: ['execRevoke', 'seedReseed', 'seedRevoke', 'transportRebuild'] },
    { name: 'serviceName edit', before: dshBase, after: { ...dshBase, serviceName: 'dsh-new' }, expected: ['execRevoke', 'seedReseed', 'seedRevoke', 'transportRebuild'] },
    { name: 'remoteDshHome edit', before: dshBase, after: { ...dshBase, remoteDshHome: '~/new' }, expected: ['execRevoke', 'seedReseed', 'seedRevoke', 'transportRebuild'] },
    { name: 'host retarget (dsh)', before: dshBase, after: { ...dshBase, host: 'other.example.com' }, expected: ['execRevoke', 'forwardRevoke', 'seedReseed', 'seedRevoke', 'sourceRetire', 'transportRebuild'] },
    { name: 'user retarget (dsh)', before: dshBase, after: { ...dshBase, user: 'bob' }, expected: ['execRevoke', 'forwardRevoke', 'seedReseed', 'seedRevoke', 'sourceRetire', 'transportRebuild'] },
    { name: 'sshPort retarget (dsh)', before: dshBase, after: { ...dshBase, sshPort: 2222 }, expected: ['execRevoke', 'forwardRevoke', 'seedReseed', 'seedRevoke', 'sourceRetire', 'transportRebuild'] },
    { name: 'remotePort retarget (dsh)', before: dshBase, after: { ...dshBase, remotePort: 4080 }, expected: ['execRevoke', 'forwardRevoke', 'seedReseed', 'seedRevoke', 'sourceRetire', 'transportRebuild'] },
    { name: 'insecureHttp switch', before: gatewayHttpBase, after: { ...gatewayHttpBase, insecureHttp: true }, expected: ['transportRebuild'] },
    { name: 'SPKI pin switch', before: gatewayHttpBase, after: { ...gatewayHttpBase, spkiPin: 'ab'.repeat(32) }, expected: ['transportRebuild'] },
    { name: 'gateway SSH -> HTTP mechanism switch keeps the source', before: gatewaySsh, after: gatewayHttp(), expected: ['bootCapability', 'execRevoke', 'forwardRevoke', 'seedRevoke', 'transportRebuild'] },
    { name: 'gateway SSH account edit (user)', before: gatewaySsh, after: { ...gatewaySsh, user: 'bob' }, expected: ['execRevoke', 'forwardRevoke', 'seedRevoke', 'transportRebuild'] },
    { name: 'gateway sshPort edit', before: gatewaySsh, after: { ...gatewaySsh, sshPort: 2222 }, expected: ['execRevoke', 'forwardRevoke', 'seedRevoke', 'transportRebuild'] },
    { name: 'gateway host retarget (no bootCapability)', before: gatewaySsh, after: { ...gatewaySsh, host: 'other.example.com' }, expected: ['execRevoke', 'forwardRevoke', 'seedRevoke', 'sourceRetire', 'transportRebuild'] },
    { name: 'gateway remotePort retarget', before: gatewaySsh, after: { ...gatewaySsh, remotePort: 8443 }, expected: ['execRevoke', 'forwardRevoke', 'seedRevoke', 'sourceRetire', 'transportRebuild'] },
    { name: 'kind switch dsh -> gateway', before: dshBase, after: { ...dshBase, kind: 'gateway' }, expected: ['execRevoke', 'forwardRevoke', 'seedRevoke', 'sourceRetire', 'transportRebuild'] },
    { name: 'gateway service edit does not reseed (not dsh x ssh)', before: gatewaySsh, after: { ...gatewaySsh, serviceName: 'other' }, expected: ['execRevoke', 'seedRevoke', 'transportRebuild'] },
  ]
  for (const entry of cases) {
    assert.deepEqual(dimensionsOf(entry.before, entry.after), sorted(entry.expected), entry.name)
  }
})

test('removals and additions carry their own dimensions, never a remount', () => {
  const removedSsh = computeRosterChangeSet([dsh()], [])
  assert.deepEqual(removedSsh.removedIds, ['same'])
  assert.deepEqual(removedSsh.retiredIds, ['same'])
  assert.deepEqual(removedSsh.rows, [])
  assert.equal(removedSsh.removedRows.length, 1)
  assert.deepEqual([...removedSsh.removedRows[0]!.dimensions].sort(), ['execRevoke', 'forwardRevoke', 'sourceRetire'])
  assert.deepEqual(removedSsh.forwardRevokeSourceIds, ['dsh-same'])

  const removedHttp = computeRosterChangeSet([gatewayHttp()], [])
  assert.deepEqual([...removedHttp.removedRows[0]!.dimensions].sort(), ['execRevoke', 'sourceRetire'], 'an HTTP row has no forward leg to revoke')
  assert.deepEqual(removedHttp.forwardRevokeSourceIds, [])

  const added = computeRosterChangeSet([], [dsh()])
  assert.deepEqual(added.removedIds, [])
  assert.deepEqual(added.retiredIds, [])
  assert.deepEqual([...added.rows[0]!.dimensions], [], 'a genuinely new source has no diff consequence')
  assert.deepEqual(added.bootCapabilityIds, [])
})

test('id lists are deduped and order-stable (removed first, then BEFORE-order retargets)', () => {
  const before = [dsh({ id: 'gone' }), dsh({ id: 'edited' }), dsh({ id: 'stable' })]
  const after = [dsh({ id: 'edited', host: 'other.example.com' }), dsh({ id: 'stable' }), dsh({ id: 'added' })]
  const change = computeRosterChangeSet(before, after)
  assert.deepEqual(change.removedIds, ['gone'])
  assert.deepEqual(change.retiredIds, ['gone', 'edited'])
  assert.deepEqual(change.rows.map(row => row.id), ['edited', 'stable', 'added'])
  assert.deepEqual(change.transportRebuildIds, ['edited'])
  assert.deepEqual(change.execRevokeIds, ['edited'])
  assert.deepEqual(change.forwardRevokeSourceIds, ['dsh-gone', 'dsh-edited'])
  assert.deepEqual(change.seedRevokeIds, ['gone', 'edited'])
  assert.deepEqual(change.seedReseedIds, ['edited'])
  assert.deepEqual(change.bootCapabilityIds, [])
})

test('bootCapabilityIds lists only surviving rows whose transport word changed', () => {
  const gatewaySsh = gateway()
  const change = computeRosterChangeSet([gatewaySsh, dsh({ id: 'other' })], [gatewayHttp(), dsh({ id: 'other' })])
  assert.deepEqual(change.bootCapabilityIds, ['same'])
  const retireAndSwitch = computeRosterChangeSet([gatewaySsh], [gatewayHttp({ host: 'other.example.com' })])
  assert.deepEqual(retireAndSwitch.bootCapabilityIds, [], 'a retired source is never remounted (retirement disposes the shell)')
  assert.ok(retireAndSwitch.rows[0]!.dimensions.has('sourceRetire'))
})
