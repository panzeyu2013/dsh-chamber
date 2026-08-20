/**
 * Chamber-owned typecheck for `packages/dsh-client-web` (the boot.ts N-ctx
 * seam + runtimeCtx getter — see AGENTS.md runtime boundaries).
 *
 * Why a filtered gate: the vendored dsh tree is source-only (`vendor/
 * harness-packages/@deepseek-ai/*` has no compiled `lib/`), so the package's
 * own tsconfig resolves `@deepseek-ai/*` through the `paths` mapping in
 * `packages/dsh-client-web/tsconfig.json` to the vendor sources. Those
 * sources are upstream code compiled under a different (looser) config and
 * are NOT chamber-owned — the root typecheck excludes them, and the repo's
 * established pattern for lib-less vendor consumption is ambient declarations.
 * This gate therefore fails ONLY on errors inside `packages/dsh-client-web/`
 * itself and ignores the pre-existing vendor-graph noise, so a future edit
 * to boot.ts (or any chamber-owned file in the package) is caught by tsc —
 * the check `pnpm run build:renderer` alone cannot provide (esbuild).
 *
 * Acceptance: exits 0 iff tsc reports no error in a chamber-owned file.
 * A tsc crash / config failure with no file-scoped errors at all is a
 * failure, not a pass.
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const CONFIG = join(ROOT, 'packages', 'dsh-client-web', 'tsconfig.json')

const result = spawnSync(process.execPath, [TSC, '-p', CONFIG, '--noEmit'], {
  cwd: ROOT,
  encoding: 'utf8',
})

const lines = String(result.stdout + result.stderr).split('\n').filter(Boolean)
const chamberErrors = lines.filter(line => line.startsWith('packages/dsh-client-web/'))
const vendorErrors = lines.filter(line => line.startsWith('vendor/harness-packages/'))
const otherLines = lines.filter(
  line => !line.startsWith('packages/dsh-client-web/') && !line.startsWith('vendor/harness-packages/'),
)

if (chamberErrors.length > 0) {
  for (const line of chamberErrors) console.error(line)
  console.error(`\ntypecheck:client-web FAILED — ${chamberErrors.length} error(s) in packages/dsh-client-web/`)
  if (vendorErrors.length > 0) {
    console.error(`(filtered ${vendorErrors.length} pre-existing vendor-graph error lines)`)
  }
  process.exit(1)
}

if (result.status !== 0 && vendorErrors.length === 0) {
  // Non-zero with no file-scoped errors: tsc itself failed (config / crash).
  for (const line of otherLines) console.error(line)
  console.error('\ntypecheck:client-web FAILED — tsc exited without chamber-owned diagnostics')
  process.exit(1)
}

console.log(`typecheck:client-web OK (chamber-owned files clean; ${vendorErrors.length} vendor-graph error lines filtered)`)
