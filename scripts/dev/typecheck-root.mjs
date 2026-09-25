#!/usr/bin/env node
/**
 * Chamber-owned filtered typecheck for the ROOT program (repo tsconfig.json).
 *
 * Why a filtered gate: packages/renderer/src/host-graph.ts deliberately
 * deep-imports upstream's own boot-graph validators from
 * vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts
 * by real relative path ("never hand-rolled"), so the root program necessarily
 * compiles pinned vendor sources. Those sources are upstream code compiled under
 * a different (looser) workspace: their own peers
 * (@deepseek-ai/cordis-plugin-loader, @deepseek-ai/dsh-package-manifest) are not
 * modeled here and they use constructor parameter properties that
 * erasableSyntaxOnly forbids. None of those diagnostics is chamber-owned, and
 * the repo's established pattern for a program containing vendor sources is this
 * filtered wrapper (cf. typecheck-client-web / typecheck-connection /
 * typecheck-api-gateway via typecheck-sdk-copy.mjs).
 *
 * This gate therefore fails ONLY on diagnostics inside packages/ (the root
 * program's own sources), on a global/config failure, or on infrastructure
 * output; it prints the filtered vendor diagnostics' count and content so the
 * pre-existing noise stays visible rather than silently swallowed.
 *
 * Acceptance: exits 0 iff tsc reports no error outside the pinned vendor roots.
 */
import { join } from 'node:path'
import { ROOT, runTypecheckProgram } from './typecheck-sdk-copy.mjs'

if (!runTypecheckProgram({
  config: join(ROOT, 'tsconfig.json'),
  ownedRoot: join(ROOT, 'packages'),
  label: 'typecheck',
  showFiltered: true,
})) process.exit(1)
