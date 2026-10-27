/**
 * gate-registry.mjs — the ONE machine source for "which gate runs where".
 *
 * The same gate set is written by hand in four places today (run-checks modes, ci.yml
 * steps, release.yml validation steps, the release-proof required-step table) and the
 * copies drift. This module owns the data and the data invariants; consumers derive
 * from it instead of restating it:
 *
 *   - run-checks derives its modes (deriveModes), so "what does check:static run"
 *     has exactly one answer;
 *   - the workflow generator renders step blocks from the same entries;
 *   - the release proof resolves its required steps from proof:true entries, so a proof
 *     entry must be boolean, sit on both ci+release surfaces and be placed on
 *     release validation with a known ci job.
 *
 * Data invariants (validated here, not by a separate gate):
 *   1. id is unique and dotted/kebab; title and command are non-empty.
 *   2. the command resolves: a bare name must exist in the root manifest scripts, an
 *      explicit 'node <path>' must exist on disk, and 'pnpm ...' must name a script.
 *   3. at least one mode; modes are a subset of static|typecheck|tests.
 *   4. a gate with a missing surface MUST carry a reason, and release implies ci
 *      (a release-blocking gate must be proven on the push path).
 *   5. tier 'architecture' may never be local-only.
 *   6. a workflow placement names a known ci job, release validation and a pre|post order.
 *   7. a proof gate must be boolean, sit on both surfaces and be placed on release validation.
 *
 * Everything here is pure: no fs reads at import time, no clock, no environment.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const GATE_REGISTRY_PATH = fileURLToPath(new URL('./gate-surfaces.json', import.meta.url))

/** The ci.yml jobs release-proof pins; workflows may only place a gate on one of these. */
export const CI_JOB_IDS = ['test', 'test-windows', 'test-windows-pack', 'test-macos', 'test-macos-pack']

/** Modes the runner recognises; 'full' is derived, never stored. */
const GATE_MODES = Object.freeze(['static', 'typecheck', 'tests'])

/** Stable gate id: dotted or kebab, starts with a lowercase word. */
export const GATE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u

/** Tier families: architecture gates are always release-blocking. */
export const GATE_TIERS = Object.freeze(['architecture', 'policy', 'quality', 'upstream', 'test', 'typecheck', 'assembly'])

/** Load the registry JSON. Throws on unreadable/invalid JSON (never silently empty). */
export function loadGateRegistry(path = GATE_REGISTRY_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.gates)) {
    throw new Error('gate-surfaces.json must be an object with a gates array')
  }
  return parsed
}

/** Root manifest scripts (the declaration a bare command resolves through). */
export function rootScripts() {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  return manifest.scripts ?? {}
}

/** Validate the registry against the data invariants; returns problems (empty = usable). */
export function validateGateRegistry(registry, { scripts = rootScripts(), exists = existsSync } = {}) {
  const problems = []
  const seen = new Set()
  for (const [index, gate] of registry.gates.entries()) {
    const at = 'gates[' + index + ']'
    if (gate === null || typeof gate !== 'object') { problems.push(at + ' must be an object'); continue }
    if (typeof gate.id !== 'string' || !GATE_ID_PATTERN.test(gate.id)) problems.push(at + '.id invalid: ' + JSON.stringify(gate.id))
    else if (seen.has(gate.id)) problems.push(at + '.id duplicated: ' + gate.id)
    else seen.add(gate.id)
    if (typeof gate.title !== 'string' || gate.title.trim() === '') problems.push(at + '.title must be a non-empty string')
    if (typeof gate.command !== 'string' || gate.command.trim() === '') problems.push(at + '.command must be a non-empty string')
    if (!GATE_TIERS.includes(gate.tier)) problems.push(at + '.tier unknown: ' + JSON.stringify(gate.tier))
    if (gate.platform !== undefined && gate.platform !== 'darwin') problems.push(at + '.platform must be "darwin" when present')
    if (!Array.isArray(gate.modes) || gate.modes.length === 0) problems.push(at + '.modes must be a non-empty array')
    else for (const mode of gate.modes) if (!GATE_MODES.includes(mode)) problems.push(at + '.modes has unknown mode: ' + JSON.stringify(mode))
    const surfaces = gate.surfaces
    if (surfaces === null || typeof surfaces !== 'object') { problems.push(at + '.surfaces must be an object'); continue }
    for (const key of ['local', 'ci', 'release']) {
      if (typeof surfaces[key] !== 'boolean') problems.push(at + '.surfaces.' + key + ' must be boolean')
    }
    const omitted = ['local', 'ci', 'release'].filter(key => surfaces[key] === false)
    if (omitted.length > 0 && (typeof gate.reason !== 'string' || gate.reason.trim() === '')) {
      problems.push(at + ' omits ' + omitted.join('/') + ' but carries no reason')
    }
    if (surfaces.release === true && surfaces.ci !== true) problems.push(at + ' is release-blocking but not proven in CI')
    if (gate.tier === 'architecture' && omitted.length > 0) problems.push(at + ' is an architecture gate and may never be local-only')
    if (gate.workflow !== undefined) {
      if (surfaces.ci !== true || surfaces.release !== true) problems.push(at + ': a workflow placement is generated into both workflows, so ci and release surfaces must be true')
      const workflow = gate.workflow
      if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
        problems.push(at + '.workflow must be an object')
      } else {
        if (typeof workflow.ciJob !== 'string' || workflow.ciJob === '') problems.push(at + '.workflow.ciJob must be a non-empty string')
        else if (!CI_JOB_IDS.includes(workflow.ciJob)) problems.push(at + '.workflow.ciJob must be one of ' + CI_JOB_IDS.join('/'))
        if (workflow.releaseJob !== 'validation') problems.push(at + '.workflow.releaseJob must be validation')
        if (workflow.order !== 'pre' && workflow.order !== 'post') problems.push(at + '.workflow.order must be pre or post')
      }
    }
    if (gate.proof !== undefined && typeof gate.proof !== 'boolean') problems.push(at + '.proof must be boolean when present')
    if (gate.proof === true) {
      // A proof gate that is not placed on a job silently leaves REQUIRED_JOB_STEPS
      // (verify-release-ci-proof only collects placed proofs) while every gate stays green.
      if (surfaces.ci !== true || surfaces.release !== true) problems.push(at + ' declares proof but is not proven on both ci and release surfaces')
      if (gate.workflow === undefined || gate.workflow === null) {
        problems.push(at + ' declares proof without a workflow placement (it would silently leave the release proof)')
      } else if (gate.workflow.releaseJob !== 'validation') {
        problems.push(at + ' proves a release but is not placed on release validation')
      }
    }
    if (typeof gate.command === 'string' && gate.command.trim() !== '') {
      const command = gate.command.trim()
      if (command.startsWith('node ')) {
        const file = command.slice('node '.length).split(/\s+/u)[0]
        if (!exists(new URL('../../' + file, import.meta.url))) problems.push(at + ' command file missing: ' + file)
      } else if (command.startsWith('pnpm ')) {
        const filtered = /^pnpm --filter (\S+) run (\S+)/u.exec(command)
        const rootRun = /^pnpm run (\S+)/u.exec(command)
        if (filtered !== null) {
          // A package script (build:preload) is resolved by the package manifest at run
          // time; the filter must name a workspace package, never a path.
          if (!/^[@a-z0-9][@a-z0-9/._-]*$/u.test(filtered[1])) problems.push(at + ' pnpm --filter target invalid: ' + filtered[1])
        } else if (rootRun === null) {
          problems.push(at + ' pnpm command must be a run: ' + command)
        } else if (typeof scripts[rootRun[1]] !== 'string') {
          problems.push(at + ' pnpm command is not a root script: ' + rootRun[1])
        }
      } else if (typeof scripts[command] !== 'string') {
        problems.push(at + ' command is not a root script: ' + command)
      }
    }
  }
  return problems
}

/** Canonical executable command of one gate (what a step actually runs). */
export function gateInvocation(gate) {
  return gate.command.startsWith('node ') || gate.command.startsWith('pnpm ')
    ? gate.command
    : 'pnpm run ' + gate.command
}

/** Gates that run on this platform, in registry order. */
function eligibleGates(registry, platform) {
  return registry.gates.filter(gate => gate.platform === undefined || gate.platform === platform)
}

/**
 * Derive the four runner modes from the registry.
 * 'full' is the concatenation static + typecheck + tests (never stored).
 */
export function deriveModes(registry, { platform = process.platform } = {}) {
  const eligible = eligibleGates(registry, platform)
  const pick = mode => eligible.filter(gate => gate.modes.includes(mode)).map(gate => gate.command)
  const modes = { static: pick('static'), typecheck: pick('typecheck'), tests: pick('tests') }
  return { ...modes, full: [...modes.static, ...modes.typecheck, ...modes.tests] }
}

/** Gate ids that must be proven by the release CI (order preserved). */
export function proofGateIds(registry) {
  return registry.gates.filter(gate => gate.proof === true).map(gate => gate.id)
}
