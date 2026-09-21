/**
 * Test-only ESM resolver: run gateway source (and the control-plane sources it
 * imports) directly under the bundled node without a pnpm node_modules tree.
 *
 * This worktree has no node_modules, but packages/gateway/scripts/test.mjs
 * entries may carry nodeArgs (its documented loader seam). The gateway source
 * deliberately imports its sibling workspace packages by package name
 * ("@dsh-chamber/control-plane"), which bare-node resolution cannot follow
 * here; this hook maps exactly those bare specifiers onto the real source
 * entry points so the tests exercise production code, never a re-implemented
 * shim. Nothing here changes shipped behavior: the hook exists only in
 * packages/gateway/test/**.
 *
 * Usage (registered from the test manifest's nodeArgs):
 *   node --import ./test/session-state/workspace-loader.mjs <test file>
 */
import { register } from 'node:module'

register(new URL('./workspace-resolver.mjs', import.meta.url))
