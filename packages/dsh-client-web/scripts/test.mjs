/**
 * @deepseek-ai/dsh-client-web test manifest — authoritative file list for this
 * package test script.
 *
 * Runner semantics (a missing listed file, the zero-test guard, first-failure
 * stop, the bounded pool and the dump mode the global tests gate reads) are the
 * shared engine's: scripts/lib/test-manifest.mjs. This file owns only the data
 * table and the per-file vendor-register argument.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // boot kernel tolerance/rows: plain strip-types entries.
  boot: [
    'test/boot-tolerance.test.ts',
    'test/boot-rows.test.ts',
  ],
  // configureContext resolves the upstream module surface through the vendor register.
  context: [
    { file: 'test/configure-context.test.ts', nodeArgs: ['--import', '../../scripts/dev/test-client-web-register.mjs'] },
  ],
}

function main() {
  runTestManifest({ label: 'dsh-client-web', packageRoot: PACKAGE_ROOT, groups: GROUPS })
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
