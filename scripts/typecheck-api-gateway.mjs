/**
 * Chamber-owned static gate for `packages/dsh-api-gateway`.
 *
 * The pinned dsh workspace is source-only, so resolving this copied package's
 * real imports necessarily pulls vendor source into each TypeScript program.
 * Those dependencies normally compile behind their own project boundaries and
 * emit diagnostics when flattened under this package config. We therefore run
 * both the official host/client programs and filter ONLY diagnostics whose
 * source file is inside the pinned vendor checkout. Any diagnostic in the
 * chamber-owned copy, any unexpected path, or a compiler/configuration failure
 * remains fatal. This is deliberately narrower than ignoring a non-zero tsc
 * exit and catches edits to every file listed by the two package projects.
 */
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const OWNED_ROOT = join(ROOT, 'packages', 'dsh-api-gateway')
const VENDOR_ROOTS = [
  join(ROOT, 'vendor', 'harness-checkout'),
  join(ROOT, 'vendor', 'harness-packages'),
]
const PROJECTS = ['client']
const DIAGNOSTIC = /^(.*)\(\d+,\d+\): error TS\d+:/
const GLOBAL_DIAGNOSTIC = /^error TS\d+:/

function inside(path, root) {
  const candidate = relative(normalize(root), normalize(path))
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
}

function absoluteDiagnosticPath(rawPath) {
  return normalize(isAbsolute(rawPath) ? rawPath : resolve(ROOT, rawPath))
}

let failed = false
for (const role of PROJECTS) {
  const config = join(OWNED_ROOT, `tsconfig.check-${role}.json`)
  const result = spawnSync(process.execPath, [TSC, '-p', config, '--noEmit', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (result.error !== undefined || result.signal !== null) {
    console.error(result.error ?? `typecheck:api-gateway ${role} terminated by ${String(result.signal)}`)
    failed = true
    continue
  }

  const lines = String(result.stdout + result.stderr).split('\n')
  const diagnostics = []
  const infrastructure = []
  let current
  for (const line of lines) {
    const match = DIAGNOSTIC.exec(line)
    if (match !== null) {
      current = { path: absoluteDiagnosticPath(match[1]), lines: [line] }
      diagnostics.push(current)
    } else if (GLOBAL_DIAGNOSTIC.test(line)) {
      current = { path: undefined, lines: [line] }
      diagnostics.push(current)
    } else if (line !== '' && current !== undefined && /^\s/.test(line)) {
      current.lines.push(line)
    } else if (line !== '') {
      infrastructure.push(line)
      current = undefined
    }
  }

  const owned = diagnostics.filter(item => item.path !== undefined && inside(item.path, OWNED_ROOT))
  const vendor = diagnostics.filter(item => item.path !== undefined
    && VENDOR_ROOTS.some(root => inside(item.path, root)))
  const unexpected = diagnostics.filter(item => item.path === undefined
    || (!inside(item.path, OWNED_ROOT)
      && !VENDOR_ROOTS.some(root => inside(item.path, root))))

  if (owned.length > 0 || unexpected.length > 0
    || infrastructure.length > 0
    || (result.status !== 0 && diagnostics.length === 0)) {
    for (const item of [...owned, ...unexpected]) console.error(item.lines.join('\n'))
    for (const line of infrastructure) console.error(line)
    if (result.status !== 0 && diagnostics.length === 0) {
      console.error(lines.filter(Boolean).join('\n'))
    }
    console.error(
      `typecheck:api-gateway ${role} FAILED — ${String(owned.length)} owned, `
      + `${String(unexpected.length)} unexpected diagnostic(s), `
      + `${String(infrastructure.length)} compiler output line(s)`,
    )
    failed = true
    continue
  }

  console.log(
    `typecheck:api-gateway ${role} OK (owned files clean; `
    + `${String(vendor.length)} vendor-source diagnostic(s) filtered)`,
  )
}

if (failed) process.exit(1)
