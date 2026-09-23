/**
 * archiveCleanup wire lockstep (cross-package, design 24 §3).
 *
 * The wire contract is SINGLE-SOURCED in the neutral
 * `@dsh-chamber/dsh-chamber-wire` package: the host gateway and the sidebar
 * client accessor both import it by specifier. Two facts TypeScript cannot
 * derive from a table are pinned here against the REAL sources instead:
 *
 * 1. the HOST method's parameter identifiers — the generic gateway derives
 * accepted argument names from the method source text, so `purge` must
 * spell them literally. This suite parses the real signature out of
 * `../src/index.ts` and asserts it equals {@link ARCHIVE_CLEANUP_PURGE_ARGS}
 * in order, and that every `@Remote` name and the service namespace come
 * from the shared package;
 * 2. the CONSUMER call sites — the sidebar accessor and the control-plane
 * host-package registry must both track the shared table. The registry
 * itself keeps its probe string as source text because control-plane must
 * not depend on a SEED package (the seed is assembled against the
 * registry, never the other way round); the desktop build no longer pins
 * `rootDir` either (: `build:control-plane` = tsc --noEmit + esbuild
 * bundle, so an import would inline fine) — the layering rule is the
 * reason, and the drift lock lives HERE. Both sides pin the same wire
 * constants.
 *
 * A rename on any side therefore fails THIS suite instead of silently dropping
 * an argument or probing a dead domain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
 ARCHIVE_CLEANUP_DOMAIN,
 ARCHIVE_CLEANUP_PROBE_METHOD,
 ARCHIVE_CLEANUP_PURGE_METHOD,
 archiveCleanupEndpoint,
 archiveCleanupPurgeArgs,
} from '@dsh-chamber/dsh-chamber-wire'

/** The purge argument keys, IN ORDER, as the shared builder actually emits them
 * (behavior, not a re-exported table: the table is module-internal). */
const PURGE_ARG_KEYS = Object.keys(archiveCleanupPurgeArgs({ sessionIds: [], force: true, protectSessionIds: [] }))

const HOST_SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const CLIENT_SOURCE = readFileSync(
 new URL('../../dsh-chamber-client-core/src/instance-api.ts', import.meta.url),
 'utf8')
const CONTROL_PLANE_REGISTRY_SOURCE = readFileSync(
 new URL('../../control-plane/src/host-graph-seed.ts', import.meta.url),
 'utf8')

test('the descriptor spells the two-segment wire endpoints',() => {
 assert.equal(ARCHIVE_CLEANUP_DOMAIN, 'archiveCleanup')
 assert.equal(ARCHIVE_CLEANUP_PURGE_METHOD, 'purge')
 assert.equal(ARCHIVE_CLEANUP_PROBE_METHOD, 'probe')
 assert.equal(archiveCleanupEndpoint(ARCHIVE_CLEANUP_PURGE_METHOD), 'archiveCleanup/purge')
 assert.equal(archiveCleanupEndpoint(ARCHIVE_CLEANUP_PROBE_METHOD), 'archiveCleanup/probe')
})

test('the args builder emits exactly the registered argument keys, in order',() => {
 const args = archiveCleanupPurgeArgs({ sessionIds: ['s1'], force: true, protectSessionIds: ['s9'] })
 assert.deepEqual(Object.keys(args), ['sessionIds', 'force', 'protectSessionIds'])
 assert.deepEqual(args, { sessionIds: ['s1'], force: true, protectSessionIds: ['s9'] })
})

test('the HOST method signature is exactly the descriptor args, in order',() => {
 const signature = /purge\(\s*([^)]*?)\)\s*:\s*Promise/u.exec(HOST_SOURCE)
 assert.ok(signature, 'the gateway must keep a plain purge(...) method declaration')
 const parameterNames = signature[1]
 .split(',')
 .map(part => part.trim().split(/[?:]/)[0].trim())
 .filter(Boolean)
 assert.deepEqual(
 parameterNames,
 PURGE_ARG_KEYS,
 'a host-side rename must update the shared wire package (the single source), never just the signature')
})

test('the HOST derives every wire name from the shared package',() => {
 assert.ok(HOST_SOURCE.includes("from '@dsh-chamber/dsh-chamber-wire'"), 'the host must import the shared contract package')
 assert.match(HOST_SOURCE, /super\(ctx, ARCHIVE_CLEANUP_DOMAIN\)/)
 assert.ok(HOST_SOURCE.includes('@Remote(ARCHIVE_CLEANUP_PURGE_METHOD)'))
 assert.ok(HOST_SOURCE.includes('@Remote(ARCHIVE_CLEANUP_PROBE_METHOD)'))
 assert.equal(
 /'archiveCleanup\//.test(HOST_SOURCE),
 false,
 'the host must not hand-write an endpoint literal beside the shared contract')
})

test('every host @Remote name is a protocol SEGMENT, never the client envelope path',() => {
 // The domain half lives in `super(ctx, ARCHIVE_CLEANUP_DOMAIN)`; `@Remote`
 // takes the bare method segment, and the pinned dsh-typert-protocol rejects
 // a '/' at PLUGIN LOAD — which takes the whole managed instance down (only a
 // real host, not a unit test, used to catch it). Pinning the decorator
 // arguments to the constants keeps `archiveCleanupEndpoint()` (the ENVELOPE
 // path, which belongs to the client call site) out of the host.
 const decorated = [...HOST_SOURCE.matchAll(/@Remote\(([^)]*)\)/gu)].map(match => match[1].trim())
 assert.deepEqual(decorated.sort(), ['ARCHIVE_CLEANUP_PROBE_METHOD', 'ARCHIVE_CLEANUP_PURGE_METHOD'],
  'the host decorators must name the shared method constants directly')
 for (const name of [ARCHIVE_CLEANUP_PURGE_METHOD, ARCHIVE_CLEANUP_PROBE_METHOD]) {
  assert.match(name, /^[A-Za-z0-9_$.-]+$/u, 'a host @Remote export name must be one protocol segment')
 }
})

test('the CLIENT imports the shared package and builds its call from it',() => {
 assert.ok(
 CLIENT_SOURCE.includes("from '@dsh-chamber/dsh-chamber-wire'"),
 'the client must import the shared contract package')
 assert.equal(
 /dsh-chamber-seed-archive-cleanup\/src\/wire/.test(CLIENT_SOURCE),
 false,
 'no relative cross-package source path may survive beside the package specifier')
 for (const name of ['ARCHIVE_CLEANUP_PURGE_METHOD', 'archiveCleanupEndpoint', 'archiveCleanupPurgeArgs']) {
 assert.ok(CLIENT_SOURCE.includes(name), `the client must import/use ${name}`)
 }
 assert.ok(
 CLIENT_SOURCE.includes('archiveCleanupEndpoint(ARCHIVE_CLEANUP_PURGE_METHOD)'),
 'the endpoint string must come from the shared contract')
 assert.ok(
 CLIENT_SOURCE.includes('archiveCleanupPurgeArgs({ sessionIds, force, protectSessionIds })'),
 'the argument object must come from the shared contract')
 assert.equal(
 /'archiveCleanup\//.test(CLIENT_SOURCE),
 false,
 'no hand-written endpoint literal may survive beside the shared contract')
})

test('the control-plane host-package registry probes the SAME domain/method',() => {
 // The registry row is the activation-probe source; dsh-runtime's
 // HOST_DOMAIN_PROBE_NAMES is pinned to the registry set by the existing
 // drift tests. This closes the remaining wire.ts ↔ registry gap.
 assert.ok(
 CONTROL_PLANE_REGISTRY_SOURCE.includes(
 `probe: { method: '${archiveCleanupEndpoint(ARCHIVE_CLEANUP_PROBE_METHOD)}', args: {} }`),
 'the archive-cleanup registry row must probe the shared descriptor endpoint')
})
