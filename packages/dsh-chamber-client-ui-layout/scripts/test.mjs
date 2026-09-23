/**
 * @dsh-chamber/dsh-chamber-client-ui-layout test manifest — authoritative file
 * list for this package test script.
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
  // store: the persisted ui-layout store (hydration/versioning/fail-closed).
  store: [
    'test/layout-store.test.ts',
  ],
  // theme: the only document-level theme projection.
  theme: [
    'test/document-theme.test.ts',
  ],
}

function main() {
  runTestManifest({ label: 'layout', packageRoot: PACKAGE_ROOT, groups: GROUPS })
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
