/**
 * @dsh-chamber/dsh-chamber-seed-open-in test manifest — authoritative file list
 * for this package test script.
 *
 * Runner semantics (a missing listed file, the zero-test verdict, first-failure
 * stop, the bounded pool and the dump mode the global tests gate reads) are the
 * shared engine's: scripts/lib/test-manifest.mjs. This file owns only the data
 * table and the per-file transform-types/vendor-register arguments.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // lockstep: the seeded package must resolve the same vendor paths as the host.
  lockstep: [
    'test/vendor-paths-lockstep.test.ts',
  ],
  // core: the in-instance open-in catalog/icons/launch seed. The vendor stubs
  // keep the upstream imports resolvable without the built install tree.
  core: [
    {
      file: 'test/core.test.ts',
      nodeArgs: ['--experimental-transform-types', '--import', './test/support/vendor-register.mjs'],
    },
  ],
}

function main() {
  runTestManifest({ label: 'seed-open-in', packageRoot: PACKAGE_ROOT, groups: GROUPS })
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
