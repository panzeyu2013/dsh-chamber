/**
 * @dsh-chamber/dsh-chamber-client-core test manifest - authoritative file list
 * for this source-only package's own leaf suites.
 *
 * The package ships no runtime and has no build; its consumers (sidebar,
 * renderer) host their integration suites. The files here pin the PR2 client
 * contracts that belong to the kernel itself: checkout placement/identity,
 * derive placement + signatures, view-prefs checkoutOrder and the unary
 * workingDirectory extraction. Shared runner semantics (missing listed file,
 * first-failure stop, zero-test guard) live in scripts/lib/test-manifest.mjs.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // checkout: the derived-row leaf (placement/identity/order keys) and its
  // derive integration (family rows, `only` exemption, both signatures).
  checkout: [
    'test/checkout-placement.test.ts',
    'test/derive-checkout.test.ts',
    'test/session-echo-checkout.test.ts',
  ],
  // state: the neutral layout store's PR2 contract and the checkoutOrder
  // preference (schema/parse/prune).
  state: [
    'test/view-prefs-checkout.test.ts',
    'test/workspace-git-flags.test.ts',
  ],
  // resident: the page-level resident-shell bridge (N-ctx resident v1.1) — the
  // publish reference guard, listener isolation, the release-request channel and
  // the frozen empty state the settings panel reads.
  resident: [
    'test/resident-store.test.ts',
  ],
  // panel-axis: the page-level panel ledger (N-ctx multi-instance sidebar) — the
  // per-source published entries, the stable frozen snapshot the shells read, and
  // the one-shot select intent the target shell consumes after boot (TTL-bounded).
  'panel-axis': [
    'test/panel-axis.test.ts',
  ],
  // runtime: the unary producer's workingDirectory fact (unmounted/cold source).
  runtime: [
    'test/instance-api-working-directory.test.ts',
  ],
}

runTestManifest({
  label: '@dsh-chamber/dsh-chamber-client-core',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
