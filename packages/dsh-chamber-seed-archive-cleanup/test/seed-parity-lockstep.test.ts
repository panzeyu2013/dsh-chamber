/**
 * Cross-seed parity lockstep (design 08 / 20 / 24 host domains).
 *
 * The three seed domains each own a private copy of the wire carrier
 * (`domainResult` + a typed error class). Seed packages MUST stay standalone
 * dist bundles — the build keeps only `@deepseek-ai/*` external, so any chamber
 * workspace dependency (e.g. `@dsh-chamber/dsh-chamber-wire`) is inlined by
 * esbuild and costs nothing at runtime; the carrier copies predate that shared
 * package and are not part of its domain-contract surface. This test is the
 * compensating lockstep: it imports all three domains' REAL carriers and pins
 * the observable semantics they share, plus the two divergences that are
 * deliberate rather than accidental.
 *
 * REGISTERED DIVERGENCE 1 — absent `retryable` default:
 *   - gitWorktree (src/core.ts:domainResult) serializes an ABSENT flag as
 *     `retryable:true` for codes in RETRYABLE_CODES (the client's
 *     DETERMINISTIC_HOST_RETRYABLE_OVERRIDES + host-client-lockstep suite
 *     depend on it);
 *   - archiveCleanup / openInApp serialize only an EXPLICIT true.
 *   The behavior matrix below fails on any unregistered drift in either
 *   direction.
 * REGISTERED DIVERGENCE 2 — single-flight shape: archive's RunGate is a
 *   boolean domain single-flight (busy refusal, tested here), while
 *   git-worktree uses the private per-common-dir KeyedMutex
 *   (src/core.ts KeyedMutex) because its mutations must QUEUE per repository
 *   instead of refusing. Not unifiable without changing the git contract.
 *
 * Also pins the shared vendor-resolution seam of the four seed tsconfigs:
 * they all EXTEND one base (`tsconfig.seed-base.json`) and declare no paths
 * of their own (the version↔lockfile half of the seam is gated by
 * scripts/upstream/lockfile-store-path-mappings.test.mjs, which scans
 * `packages/<pkg>/tsconfig*.json`).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArchiveCleanupError, domainResult as archiveDomainResult, errorText } from '../src/core.ts'
import { RunGate } from '../src/binding.ts'
import { GitWorktreeError, RETRYABLE_CODES, domainResult as gitDomainResult } from '../../dsh-chamber-seed-git-worktree/src/core.ts'
import { OpenInAppError, domainResult as openInDomainResult } from '../../dsh-chamber-seed-open-in/src/core.ts'

interface Carrier {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: string; readonly message?: string; readonly retryable?: boolean }
}

interface Domain {
  readonly name: string
  readonly code: string
  readonly run: (operation: () => Promise<unknown>) => Promise<Carrier>
  readonly known: (retryable?: boolean) => Error
}

const DOMAINS: readonly Domain[] = [
  {
    name: 'gitWorktree',
    code: 'git-command-failed',
    run: async operation => (await gitDomainResult(operation)) as unknown as Carrier,
    known: retryable => new GitWorktreeError('git-command-failed', 'git-command-failed message', retryable === undefined ? {} : { retryable }),
  },
  {
    name: 'archiveCleanup',
    code: 'busy',
    run: async operation => (await archiveDomainResult(operation)) as unknown as Carrier,
    known: retryable => new ArchiveCleanupError('busy', 'busy message', retryable),
  },
  {
    name: 'openInApp',
    code: 'launch-failed',
    run: async operation => (await openInDomainResult(operation)) as unknown as Carrier,
    known: retryable => new OpenInAppError('launch-failed', 'launch-failed message', retryable),
  },
]

test('domainResult carrier: the ok path is identical across the three seed domains', async () => {
  for (const domain of DOMAINS) {
    assert.deepEqual(await domain.run(async () => 42), { ok: true, value: 42 }, domain.name)
  }
})

test('domainResult carrier: explicit retryable=false — omitted by archive/openIn, preserved by git', async () => {
  // REGISTERED DIVERGENCE 1b: git serializes an EXPLICIT false as
  // `retryable:false` — the host-proven pre-mutation refusal signal the client
  // clears its "uncertain outcome" recovery on (git core.ts domainResult).
  // archiveCleanup / openInApp omit the flag for false. The matrix fails on any
  // unregistered drift in either direction.
  for (const domain of DOMAINS) {
    const expected = domain.name === 'gitWorktree'
      ? { ok: false, error: { code: domain.code, message: `${domain.code} message`, retryable: false } }
      : { ok: false, error: { code: domain.code, message: `${domain.code} message` } }
    assert.deepEqual(await domain.run(async () => { throw domain.known(false) }), expected, domain.name)
  }
})

test('domainResult carrier: explicit retryable=true serializes identically in all three', async () => {
  for (const domain of DOMAINS) {
    assert.deepEqual(
      await domain.run(async () => { throw domain.known(true) }),
      { ok: false, error: { code: domain.code, message: `${domain.code} message`, retryable: true } },
      domain.name,
    )
  }
})

test('domainResult carrier: an unknown failure is rethrown unchanged in ALL three (never wrapped)', async () => {
  for (const domain of DOMAINS) {
    const boom = new Error('boom')
    await assert.rejects(
      () => domain.run(async () => { throw boom }),
      (error: unknown) => error === boom,
      domain.name,
    )
  }
})

test('REGISTERED DIVERGENCE 1: only gitWorktree defaults an absent retryable flag, and only from RETRYABLE_CODES', async () => {
  assert.equal(RETRYABLE_CODES.has('git-timeout'), true, 'the pinned sample code must stay in the git set')
  assert.deepEqual(
    await gitDomainResult(async () => { throw new GitWorktreeError('git-timeout', 'git-timeout message') }),
    { ok: false, error: { code: 'git-timeout', message: 'git-timeout message', retryable: true } },
  )
  assert.deepEqual(
    await gitDomainResult(async () => { throw new GitWorktreeError('not-in-retryable-codes', 'm') }),
    { ok: false, error: { code: 'not-in-retryable-codes', message: 'm' } },
  )
  assert.deepEqual(
    await archiveDomainResult(async () => { throw new ArchiveCleanupError('busy', 'm') }),
    { ok: false, error: { code: 'busy', message: 'm' } },
  )
  assert.deepEqual(
    await openInDomainResult(async () => { throw new OpenInAppError('launch-failed', 'm') }),
    { ok: false, error: { code: 'launch-failed', message: 'm' } },
  )
})

test('typed domain errors: name/code/message contract matches; default retryable is the registered difference', () => {
  const git = new GitWorktreeError('x', 'm')
  const archive = new ArchiveCleanupError('x', 'm')
  const openIn = new OpenInAppError('x' as never, 'm')
  assert.deepEqual([git.name, archive.name, openIn.name], ['GitWorktreeError', 'ArchiveCleanupError', 'OpenInAppError'])
  assert.deepEqual([git.code, archive.code, openIn.code], ['x', 'x', 'x'])
  assert.deepEqual([git.message, archive.message, openIn.message], ['m', 'm', 'm'])
  assert.equal(git.retryable, undefined)
  assert.equal(archive.retryable, false)
  assert.equal(openIn.retryable, false)
})

test('archive errorText: the in-package single source keeps both thrown-value shapes', () => {
  assert.equal(errorText(new Error('x')), 'x')
  assert.equal(errorText('plain'), 'plain')
  assert.equal(errorText(undefined), 'undefined')
})

test('REGISTERED DIVERGENCE 2: the archive single-flight gate refuses a concurrent run with a retryable busy error', async () => {
  const gate = new RunGate()
  let release: (value: number) => void = () => {}
  const first = gate.run(() => new Promise<number>(resolvePromise => { release = resolvePromise }))
  await assert.rejects(
    () => gate.run(async () => 2),
    (error: unknown) => error instanceof ArchiveCleanupError && error.code === 'busy' && error.retryable === true,
  )
  release(1)
  assert.equal(await first, 1)
  assert.equal(await gate.run(async () => 3), 3, 'the gate releases after the in-flight run settles')
})

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const SEED_PACKAGES = [
  'dsh-chamber-seed-client-graph',
  'dsh-chamber-seed-git-worktree',
  'dsh-chamber-seed-archive-cleanup',
  'dsh-chamber-seed-open-in',
] as const

/** The ONE shared base every seed config extends (it carries the seam). */
const SHARED_SEED_TSCONFIG = join(ROOT, 'packages', 'dsh-chamber-seed-client-graph', 'tsconfig.seed-base.json')

/** The vendor-source + pnpm-store mappings a tsconfig declares (order-insensitive). */
function vendorPathMappings(tsconfigPath: string): string[] {
  const text = readFileSync(tsconfigPath, 'utf8')
  return [...text.matchAll(/"([^"]+)"\s*:\s*\[\s*"([^"]+)"\s*\]/gu)]
    .map(match => `${match[1]} -> ${match[2]}`)
    .filter(entry => entry.includes('/.pnpm/') || entry.includes('vendor/harness-packages'))
    .sort()
}

/** The `extends` target of a tsconfig, resolved to an absolute path (null when absent). */
function extendsTarget(tsconfigPath: string): string | null {
  const target = /"extends"\s*:\s*"([^"]+)"/u.exec(readFileSync(tsconfigPath, 'utf8'))?.[1]
  return target === undefined ? null : resolve(dirname(tsconfigPath), target)
}

test('the four seed tsconfigs extend ONE shared vendor-resolution base', () => {
  const reference = vendorPathMappings(SHARED_SEED_TSCONFIG)
  assert.deepEqual(
    reference.map(entry => entry.split(' -> ')[0]),
    ['@deepseek-ai/*', '@standard-schema/spec', 'compression', 'negotiator', 'undici'],
    'the shared base must keep the wildcard plus the four documented store mappings',
  )
  for (const pkg of SEED_PACKAGES) {
    const config = join(ROOT, 'packages', pkg, 'tsconfig.json')
    assert.equal(
      extendsTarget(config),
      SHARED_SEED_TSCONFIG,
      `${pkg}/tsconfig.json must extend the shared seed base`,
    )
    assert.deepEqual(
      vendorPathMappings(config),
      [],
      `${pkg}/tsconfig.json must declare no vendor mapping of its own (single source: the shared base)`,
    )
  }
})
