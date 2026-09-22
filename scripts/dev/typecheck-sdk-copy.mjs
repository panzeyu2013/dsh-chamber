/**
 * Shared engine for the two chamber-owned SDK-copy typecheck gates
 * (`typecheck-connection`, `typecheck-api-gateway`; 2026-12 single-sourcing pass:
 * the two scripts were 96.2% identical, differing only in the owned package,
 * the project list and their log label).
 *
 * Why the gate is shaped this way: the pinned dsh workspace is source-only, so
 * resolving a copied package's real imports necessarily pulls vendor source into
 * each TypeScript program. Those dependencies normally compile behind their own
 * project boundaries and emit diagnostics when flattened under this package
 * config. We therefore run the official programs and filter ONLY diagnostics
 * whose source file is inside the pinned vendor checkout. Any diagnostic in the
 * chamber-owned copy, any unexpected path, or a compiler/configuration failure
 * remains fatal. This is deliberately narrower than ignoring a non-zero tsc exit
 * and catches edits to every file listed by the package's projects.
 */
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const VENDOR_ROOTS = [
  join(ROOT, 'vendor', 'harness-checkout'),
  join(ROOT, 'vendor', 'harness-packages'),
]
const DIAGNOSTIC = /^(.*)\(\d+,\d+\): error TS\d+:/
const GLOBAL_DIAGNOSTIC = /^error TS\d+:/

/** Is `path` inside `root` (or equal to it)? Both sides are normalized first. */
export function inside(path, root) {
  const candidate = relative(normalize(root), normalize(path))
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
}

/** Absolute path of a tsc diagnostic target (relative paths resolve from the repo root). */
export function absoluteDiagnosticPath(rawPath) {
  return normalize(isAbsolute(rawPath) ? rawPath : resolve(ROOT, rawPath))
}

/**
 * Split one tsc output into diagnostics (with their continuation lines) and
 * infrastructure lines (anything else that is not blank).
 * @param output - tsc stdout+stderr.
 * @returns {{ diagnostics: Array<{ path: string | undefined, lines: string[] }>, infrastructure: string[] }}
 */
export function parseTypecheckOutput(output) {
  const lines = String(output).split('\n')
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
  return { diagnostics, infrastructure }
}

/**
 * Evaluate one project's tsc result against the owned copy and the vendor roots.
 * @param result - the spawnSync result (status/error/signal/stdout/stderr).
 * @param ownedRoot - absolute path of the chamber-owned copy.
 * @returns the crash/ok verdict plus the classified diagnostics.
 */
export function evaluateProject(result, ownedRoot) {
  // `signal` is null on a normal spawnSync result; the ?? keeps hand-built
  // results (tests) on the same path instead of misreading a missing field as a
  // crash.
  if (result.error !== undefined || (result.signal ?? null) !== null) {
    return { crashed: true, ok: false, reason: result.error ?? ('terminated by ' + String(result.signal)), diagnostics: [], infrastructure: [] }
  }
  const { diagnostics, infrastructure } = parseTypecheckOutput(String(result.stdout ?? '') + String(result.stderr ?? ''))
  const owned = diagnostics.filter(item => item.path !== undefined && inside(item.path, ownedRoot))
  const vendor = diagnostics.filter(item => item.path !== undefined
    && VENDOR_ROOTS.some(root => inside(item.path, root)))
  const unexpected = diagnostics.filter(item => item.path === undefined
    || (!inside(item.path, ownedRoot)
      && !VENDOR_ROOTS.some(root => inside(item.path, root))))
  const ok = owned.length === 0 && unexpected.length === 0 && infrastructure.length === 0
    && !(result.status !== 0 && diagnostics.length === 0)
  return { crashed: false, ok, owned, vendor, unexpected, infrastructure, lines: String(result.stdout ?? '') + String(result.stderr ?? '') }
}

/**
 * Run one copy's projects and report every failure to stderr.
 * @param options.packageDir - package directory name under packages/.
 * @param options.label - the gate's log label (e.g. 'typecheck:connection').
 * @param options.projects - the per-package project roles to typecheck.
 * @returns true when every project is clean (vendor-source diagnostics filtered).
 */
export function runTypecheckCopy({ packageDir, label, projects = ['client', 'host'] }) {
  const ownedRoot = join(ROOT, 'packages', packageDir)
  let failed = false
  for (const role of projects) {
    const config = join(ownedRoot, 'tsconfig.check-' + role + '.json')
    const result = spawnSync(process.execPath, [TSC, '-p', config, '--noEmit', '--pretty', 'false'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const outcome = evaluateProject(result, ownedRoot)
    if (outcome.crashed) {
      console.error(outcome.reason)
      failed = true
      continue
    }
    if (!outcome.ok) {
      for (const item of [...outcome.owned, ...outcome.unexpected]) console.error(item.lines.join('\n'))
      for (const line of outcome.infrastructure) console.error(line)
      if (result.status !== 0 && outcome.diagnostics.length === 0) {
        console.error(outcome.lines.split('\n').filter(Boolean).join('\n'))
      }
      console.error(
        label + ' ' + role + ' FAILED — ' + String(outcome.owned.length) + ' owned, '
        + String(outcome.unexpected.length) + ' unexpected diagnostic(s), '
        + String(outcome.infrastructure.length) + ' compiler output line(s)',
      )
      failed = true
      continue
    }
    console.log(
      label + ' ' + role + ' OK (owned files clean; '
      + String(outcome.vendor.length) + ' vendor-source diagnostic(s) filtered)',
    )
  }
  return !failed
}
