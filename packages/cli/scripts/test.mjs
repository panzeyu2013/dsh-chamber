/**
 * @dsh-chamber/cli test manifest — authoritative file list for this package
 * test script.
 *
 * Runner semantics (a missing listed file, the zero-test verdict, first-failure
 * stop, the bounded pool and the dump mode the global tests gate reads) are the
 * shared engine's: scripts/lib/test-manifest.mjs. This file owns only the data
 * table.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // follow-filter: the stdout event filter the follow loop consumes (pure).
  'follow-filter': [
    'test/follow-filter.test.ts',
  ],
  // contract: the CLI surface (help/usage/exit codes/arg parsing) and the loop.
  contract: [
    'test/cli-contract.test.ts',
  ],
}

function main() {
  runTestManifest({ label: 'cli', packageRoot: PACKAGE_ROOT, groups: GROUPS })
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
