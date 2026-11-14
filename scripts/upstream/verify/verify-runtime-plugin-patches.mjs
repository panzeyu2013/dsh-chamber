/**
 * verify-runtime-plugin-patches.mjs - 运行期插件补丁（client-plugin-patches）的**真实锚点门**。
 *
 * WHY. The page-level runtime patch table (packages/renderer/src/client-plugin-patches.ts) is
 * applied at load time to a FAIL-CLOSED contract: each registered anchor must appear exactly
 * once in the SERVED bundle text, or the row is refused (bundle-load-failed). The renderer unit
 * suite can only validate the table against synthetic fixtures; the published artifact ships
 * inside the bundled runtime (packages/desktop/vendor/dsh/node_modules) and never enters the
 * repository. This gate closes that gap: it reads the ACTUAL bundled payload, applies every
 * registered patch, and re-runs the same anchor contract on both the raw artifact text and the
 * upstream serving transform (combo script shape).
 *
 * SKIP SEMANTICS. A source-only checkout has no bundled runtime yet (bundle:dsh not run), so a
 * missing payload is a LOUD skip (exit 0): the upgrade pipeline must stay runnable before the
 * runtime leg exists. --require turns the skip into a hard failure for packaging/release legs.
 *
 * Usage: node scripts/upstream/verify/verify-runtime-plugin-patches.mjs [--vendor-root <path>] [--require] [--help]
 *   --vendor-root <path>  runtime vendor root (default packages/desktop/vendor/dsh); the payload
 *                         is resolved as <root>/node_modules/<packageId>/lib/client.js
 *   --require             a missing payload is a failure (exit 1) instead of a loud skip
 *   --help / -h           print this usage
 * Exit codes: 0 pass (or loud skip) - 1 red - 2 usage error.
 *
 * The gate never writes. CI/pin-upgrade-pipeline run it after the runtime leg (bundle:dsh); the
 * per-pin procedure also names it (upstream-touchpoints section 7).
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const ROOT = join(HERE, '../../..')
export const DEFAULT_VENDOR_ROOT = 'packages/desktop/vendor/dsh'
export const PATCH_MODULE = 'packages/renderer/src/client-plugin-patches.ts'

/** Renderer patch module URL (module-scope so tests can point the gate at a fixture copy). */
export function patchModuleUrl(root = ROOT) {
  return pathToFileURL(join(root, PATCH_MODULE)).href
}

/** Count non-overlapping literal occurrences of one string. */
export function countOccurrences(text, needle) {
  let count = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Upstream serving transform, reproduced from the host's combo-script writer
 * (vendor/harness-checkout/packages/client/modules/src/index.ts: prepareSource strips the
 * per-module sourceURL/sourceMappingURL trailers and the combo writer appends ';\n' plus the
 * combo sourceMappingURL trailer). The patch gate must hold on BOTH raw and served text.
 * @param raw - raw published bundle text
 * @returns the served combo-script shape for a single-resource bundle
 */
export function toServedComboText(raw) {
  const stripped = String(raw)
    .replace(/\/\/# sourceMappingURL=.*$/m, '')
    .replace(/\/\/# sourceURL=.*$/m, '')
    .replace(/\s+$/u, '')
  return stripped + ';\n' + '//# sourceMappingURL=/plugins/??<combo>.js.map&rev=verify\n'
}

/**
 * Verify one registered patch against one bundle text: explicit anchor counts, fail-closed
 * apply, structural re-check, compile check, and two drift controls (mutated/duplicated anchors
 * must be refused). Pure: no I/O so the unit suite can drive it with fixtures.
 * @param patch - one entry of CLIENT_PLUGIN_PATCHES
 * @param text - raw or served bundle text
 * @param label - diagnostic prefix
 * @returns {{ problems: string[], patched: string | null }}
 */
export function verifyPatchText(patch, text, label) {
  const problems = []
  const anchors = patch.anchorTexts ?? []
  if (!Array.isArray(anchors) || anchors.length === 0) {
    problems.push(label + ': patch carries no anchorTexts (registry shape drift)')
    return { problems, patched: null }
  }
  anchors.forEach((anchor, index) => {
    const count = countOccurrences(text, anchor)
    if (count !== 1) problems.push(label + ': anchor ' + (index + 1) + '/' + anchors.length + ' matched ' + count + ' times (expected exactly 1)')
  })
  const patched = patch.apply(text)
  if (patched === null) {
    problems.push(label + ': apply refused the text (fail-closed contract violated or anchor shape drifted)')
    return { problems, patched: null }
  }
  for (const anchor of anchors) {
    if (patched.includes(anchor)) problems.push(label + ': anchor survived the rewrite')
  }
  const baseCalls = countOccurrences(patched, 'chamberBasePath')
  if (baseCalls !== 1) problems.push(label + ': patched text carries chamberBasePath ' + baseCalls + ' times (expected 1)')
  try {
    new Function(patched)
  } catch (error) {
    problems.push(label + ': patched text does not compile: ' + error.message)
  }
  const first = anchors[0]
  const corrupted = text.replace(first, first.slice(0, -1) + ' ')
  if (corrupted === text || patch.apply(corrupted) !== null) problems.push(label + ': a mutated anchor was not refused (drift control lost)')
  if (patch.apply(text + '\n;' + text) !== null) problems.push(label + ': duplicated anchors were not refused (drift control lost)')
  return { problems, patched }
}

/**
 * Resolve the raw payload path for one patch package id.
 * @param vendorRoot - runtime vendor root (repo-relative or absolute)
 * @param packageId - npm package id
 * @returns absolute payload path
 */
export function payloadPath(vendorRoot, packageId) {
  return join(vendorRoot, 'node_modules', packageId, 'lib', 'client.js')
}

/** CLI argument parser; problems are usage errors (exit 2). */
export function parseArgs(argv) {
  const flags = { require: false, help: false }
  const problems = []
  let vendorRoot = DEFAULT_VENDOR_ROOT
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { flags.help = true; continue }
    if (argument === '--require') { flags.require = true; continue }
    if (argument === '--vendor-root') {
      vendorRoot = argv[index + 1]
      if (vendorRoot === undefined || vendorRoot === '' || vendorRoot.startsWith('-')) {
        problems.push('--vendor-root needs a path')
        vendorRoot = DEFAULT_VENDOR_ROOT
      }
      index += 1
      continue
    }
    problems.push('unknown argument ' + argument)
  }
  return { vendorRoot, ...flags, problems }
}

export const USAGE = [
  'Usage: node scripts/upstream/verify/verify-runtime-plugin-patches.mjs [--vendor-root <path>] [--require] [--help]',
  '',
  '  --vendor-root <path>  runtime vendor root (default ' + DEFAULT_VENDOR_ROOT + '); payload = <root>/node_modules/<packageId>/lib/client.js',
  '  --require             missing payload is a failure (exit 1) instead of a loud skip (exit 0)',
  '  --help / -h           print this usage',
  '',
  'Verifies every registered runtime client-plugin patch against the real bundled payload:',
  'raw artifact text AND the upstream served combo shape: each anchor exactly once, apply ok,',
  'patched text compiles, and mutated/duplicated anchors are refused. Read-only.',
].join('\n')

/**
 * Run the gate (I/O boundary; unit suites drive the pure helpers instead).
 * @param {{ root?: string, vendorRoot?: string, requirePayload?: boolean }} options
 * @returns {Promise<{ code: number, lines: string[] }>}
 */
export async function runGate({ root = ROOT, vendorRoot = DEFAULT_VENDOR_ROOT, requirePayload = false } = {}) {
  const lines = []
  const resolvedRoot = resolve(root, vendorRoot)
  const patchModule = await import(patchModuleUrl(root))
  const patches = patchModule.CLIENT_PLUGIN_PATCHES
  if (!Array.isArray(patches) || patches.length === 0) {
    lines.push('x verify-runtime-plugin-patches: the patch table is empty (registry shape drift)')
    return { code: 1, lines }
  }
  const problems = []
  let verified = 0
  let skipped = 0
  for (const patch of patches) {
    const url = '/api/i/verify' + '/plugins/??' + patch.packageId + '/client.js&rev=verify'
    const found = patchModule.findClientPluginPatch(url)
    if (found === null || found.packageId !== patch.packageId) {
      problems.push('registry wiring: findClientPluginPatch(' + patch.packageId + ') did not return the registered patch')
      continue
    }
    if (patchModule.findClientPluginPatch('/api/i/verify/plugins/??a/client.js&rev=1,b/client.js&rev=1') !== null) {
      problems.push('registry wiring: a batch combo URL must not match a single-id patch')
    }
    const file = payloadPath(resolvedRoot, patch.packageId)
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      skipped += 1
      lines.push('! verify-runtime-plugin-patches: SKIP ' + patch.packageId + ' payload missing: ' + file)
      lines.push('  (source-only checkout or bundle:dsh not run; the gate is a loud skip' + (requirePayload ? ' but --require makes it fatal' : '') + ')')
      continue
    }
    const rawProblems = verifyPatchText(patch, raw, patch.packageId + ' [raw]')
    const served = toServedComboText(raw)
    const servedProblems = verifyPatchText(patch, served, patch.packageId + ' [served]')
    problems.push(...rawProblems.problems, ...servedProblems.problems)
    verified += 1
    lines.push('  ' + patch.packageId + ': raw ' + raw.length + ' B, served ' + served.length + ' B, ' + (patch.anchorTexts?.length ?? 0) + ' anchors, apply ok')
  }
  if (problems.length > 0) {
    lines.push('x verify-runtime-plugin-patches: ' + problems.length + ' problem(s)')
    for (const problem of problems) lines.push('  - ' + problem)
    return { code: 1, lines }
  }
  if (verified === 0 && skipped > 0) {
    lines.push(requirePayload
      ? 'x verify-runtime-plugin-patches: --require set but no payload was found'
      : '~ verify-runtime-plugin-patches: skipped (no bundled payload in this checkout; run bundle:dsh then re-run)')
    return { code: requirePayload ? 1 : 0, lines }
  }
  lines.push('OK verify-runtime-plugin-patches: ' + verified + ' patch(es) x raw+served verified; anchors exact, apply ok, drift/duplicate refused')
  return { code: 0, lines }
}

const isEntry = process.argv[1] !== undefined && (() => {
  try { return fileURLToPath(import.meta.url) === process.argv[1] } catch { return false }
})()
if (isEntry) {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    console.log(USAGE)
  } else if (parsed.problems.length > 0) {
    for (const problem of parsed.problems) console.error('[verify-runtime-plugin-patches] ' + problem)
    console.error(USAGE)
    process.exitCode = 2
  } else {
    const outcome = await runGate({ vendorRoot: parsed.vendorRoot, requirePayload: parsed.require })
    for (const line of outcome.lines) console.log(line)
    process.exitCode = outcome.code
  }
}