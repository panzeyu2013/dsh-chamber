/**
 * Chamber-owned typecheck for `packages/dsh-client-connection` (the in-repo
 * copy of the official connection client with the base-path patch — see
 * AGENTS.md runtime boundaries).
 *
 * Why a filtered gate: the package's solution tsconfig (tsconfig.json) only
 * references tsconfig.client.json / tsconfig.host.json; both extend the root
 * tsconfig and map the `@deepseek-ai/*` imports through `paths` to the
 * source-only vendor tree (`vendor/harness-packages/@deepseek-ai/*` has no
 * compiled lib/). Those sources are upstream code compiled under a different
 * (looser) config and are NOT chamber-owned — the root typecheck excludes
 * them, and the repo's established pattern for lib-less vendor consumption
 * is ambient declarations. This gate therefore fails ONLY on errors inside
 * `packages/dsh-client-connection/` itself and ignores the pre-existing
 * vendor-graph noise, so a future edit to the base-path patch (or any other
 * chamber-owned file in the package) is caught by tsc — the check
 * `pnpm run test:connection` alone cannot provide (it runs the node test
 * files, not a program-wide check).
 *
 * Acceptance: exits 0 iff tsc reports no error in a chamber-owned file for
 * BOTH sub-configs. A tsc crash / config failure with no file-scoped errors
 * at all is a failure, not a pass.
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const CONFIGS = [
  ['client', join(ROOT, 'packages', 'dsh-client-connection', 'tsconfig.client.json')],
  ['host', join(ROOT, 'packages', 'dsh-client-connection', 'tsconfig.host.json')],
]

let chamberErrors = 0
let vendorErrors = 0
let unexpectedErrors = 0

for (const [name, config] of CONFIGS) {
  const result = spawnSync(process.execPath, [TSC, '-p', config, '--noEmit', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const lines = String(result.stdout + result.stderr).split('\n').filter(Boolean)
  const diagnostics = lines.filter(line => /\berror TS\d+:/.test(line))
  const configChamber = diagnostics.filter(line => line.startsWith('packages/dsh-client-connection/'))
  const configVendor = diagnostics.filter(line => line.startsWith('vendor/harness-packages/'))
  const configUnexpected = diagnostics.filter(line => !configChamber.includes(line) && !configVendor.includes(line))
  chamberErrors += configChamber.length
  vendorErrors += configVendor.length
  unexpectedErrors += configUnexpected.length

  if (configUnexpected.length > 0) {
    console.error(`[${name} sub-config: unexpected diagnostics]`)
    for (const line of configUnexpected) console.error(line)
  }
  if (result.status === null) {
    for (const line of lines) console.error(line)
    const cause = result.error?.message ?? (result.signal ? `terminated by ${result.signal}` : 'terminated without an exit status')
    console.error(`\ntypecheck:connection FAILED — tsc ${cause} (${name} sub-config)`)
    process.exit(1)
  }
  if (result.status !== 0 && diagnostics.length === 0) {
    // Non-zero with no TypeScript diagnostic: tsc itself failed (config /
    // signal / startup crash). Vendor errors in another run cannot mask it.
    for (const line of lines) console.error(line)
    console.error(`\ntypecheck:connection FAILED — tsc exited without TypeScript diagnostics (${name} sub-config)`)
    process.exit(1)
  }
}

if (chamberErrors > 0 || unexpectedErrors > 0) {
  for (const [name, config] of CONFIGS) {
    const result = spawnSync(process.execPath, [TSC, '-p', config, '--noEmit', '--pretty', 'false'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const lines = String(result.stdout + result.stderr).split('\n').filter(Boolean)
    const configChamber = lines.filter(line => line.startsWith('packages/dsh-client-connection/'))
    if (configChamber.length > 0) {
      console.error(`[${name} sub-config]`)
      for (const line of configChamber) console.error(line)
    }
  }
  console.error(`\ntypecheck:connection FAILED — ${chamberErrors} chamber error(s), ${unexpectedErrors} unexpected error(s)`)
  if (vendorErrors > 0) {
    console.error(`(filtered ${vendorErrors} pre-existing vendor-graph error lines)`)
  }
  process.exit(1)
}

console.log(`typecheck:connection OK (chamber-owned files clean; ${vendorErrors} vendor-graph error lines filtered)`)
