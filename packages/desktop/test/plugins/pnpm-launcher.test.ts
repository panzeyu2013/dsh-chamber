/**
 * pnpm entry candidate tests (design 21 §6.3 / design 23 D2): the candidate
 * set must never name a `.cmd`/`.bat` — Node >=18.20.2/20.12.2 refuses those
 * without a shell (CVE-2024-27980, EINVAL); only the bundled `pnpm.cjs` entry
 * is offered and the caller probes existence. Runs on every CI leg.
 *
 * Run directly: node packages/desktop/test/plugins/pnpm-launcher.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bundledPnpmEntryCandidates,
  firstExistingPnpmEntry,
} from '../../pnpm-launcher.ts'

test('bundledPnpmEntryCandidates: resources → sidecar assembly → legacy assembly → dev, ONE order for both flavors', () => {
  // Swift sidecar (sidecar-ctx passes its two assembly spellings in; the
  // resources root does not exist for this flavor).
  assert.deepEqual(
    bundledPnpmEntryCandidates({
      platform: 'darwin',
      moduleDir: '/R/sidecar',
      assemblyEntry: '/R/sidecar/pnpm/bin/pnpm.cjs',
      legacyAssemblyEntry: '/R/pnpm/bin/pnpm.cjs',
    }),
    ['/R/sidecar/pnpm/bin/pnpm.cjs', '/R/pnpm/bin/pnpm.cjs', '/R/sidecar/node_modules/pnpm/bin/pnpm.cjs'],
  )
  // Electron packaged: the extraResources copy first, no sidecar candidates.
  assert.deepEqual(
    bundledPnpmEntryCandidates({
      platform: 'darwin',
      moduleDir: '/app/resources/app.asar',
      resourcesPath: '/app/resources',
    }),
    ['/app/resources/pnpm/bin/pnpm.cjs', '/app/resources/app.asar/node_modules/pnpm/bin/pnpm.cjs'],
  )
})

test('firstExistingPnpmEntry: the first existing candidate wins, null when nothing exists', () => {
  const exists = (candidate: string): boolean => candidate.includes('/legacy/')
  assert.equal(firstExistingPnpmEntry(['/a', '/legacy/b', '/c'], exists), '/legacy/b')
  assert.equal(firstExistingPnpmEntry(['/a', '/b'], () => false), null)
  // Empty candidate list is legal (caller keeps its documented fallback shape).
  assert.equal(firstExistingPnpmEntry([], () => true), null)
})

