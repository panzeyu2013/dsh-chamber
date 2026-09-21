/**
 * Parity between the local static gate set (`run-checks.mjs` MODES.static) and
 * the file-only gates ci.yml runs OUTSIDE its change classifier (P1-1 of the
 * 13-scripts audit: the two had silently drifted — the local static mode ran
 * `remote-state-injection-matrix.mjs` while ci.yml ran
 * `remote-state-acceptance.mjs`, so neither side could see the other's gate).
 *
 * Pure text parsing so the contract is unit-testable: the ci.yml `test` job is
 * sliced out, each step's classifier `if:` is inspected, and only the
 * unclassified `run:` gates are collected. Both sides are canonicalized through
 * the root manifest's `scripts` map (`verify:i18n` and
 * `node scripts/gates/verify-i18n.mjs` are the same gate).
 *
 * EXEMPTIONS are validated in BOTH directions: an entry must be carried by
 * exactly one side, so an exemption has to be deleted the moment it stops being
 * needed (the same discipline release-workflow-policy.test.mjs applies to the
 * push↔release alignment).
 */

/**
 * Static gates that deliberately live on one side only, with the reason.
 * Keys are canonical commands (the form the root manifest resolves to).
 * @type {ReadonlyMap<string, string>}
 */
export const STATIC_GATE_EXEMPTIONS = new Map([
  ['node scripts/gates/verify-shim-payload-shape.mjs',
    'ci.yml runs it from the macOS leg as a direct script (test-macos); the ubuntu static chain has no macOS toolchain'],
  ['node scripts/release/release-preflight.mjs --actions-only',
    'resolves action SHAs over the network (api.github.com) — ci.yml runs it in the ubuntu leg, the local static mode stays offline'],
  ['node scripts/gates/classify-ci-changes.mjs',
    'push-path plumbing, not a gate: it only decides whether the expensive chain is worth running'],
  ['node scripts/dev/ensure-harness-vendor.mjs',
    'bootstrap, not a gate: it materializes the vendor link tree before pnpm install'],
])

/**
 * Slice one job out of a workflow file (top-level 2-space job keys delimit it).
 * @param {string} workflowText - workflow file contents.
 * @param {string} name - job name (e.g. 'test').
 * @returns {string} job text, or '' when the job is absent.
 */
export function jobBlock(workflowText, name) {
  const start = String(workflowText).indexOf('\n  ' + name + ':')
  if (start === -1) return ''
  const rest = String(workflowText).slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/u)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/**
 * Canonical command of one ci.yml `run:` line: `pnpm run <script>` resolves
 * through the root manifest (so both spellings of a gate compare equal).
 * @param {string} command - inline run command.
 * @param {Record<string, string>} scripts - root manifest scripts map.
 * @returns {string} canonical command.
 */
export function canonicalizeCommand(command, scripts) {
  const trimmed = String(command).trim()
  const match = /^pnpm run ([A-Za-z0-9:_-]+)/u.exec(trimmed)
  if (match === null) return trimmed
  return canonicalizeStaticStep(match[1], scripts)
}

/**
 * Canonical command of one MODES.static entry (bare package-script names resolve
 * through the root manifest; explicit `node …` entries stay as written).
 * @param {string} step - MODES.static entry.
 * @param {Record<string, string>} scripts - root manifest scripts map.
 * @returns {string} canonical command.
 */
export function canonicalizeStaticStep(step, scripts) {
  if (String(step).startsWith('node ')) return step
  const command = scripts?.[step]
  if (typeof command === 'string' && command.startsWith('node ')) return command.trim()
  return 'pnpm run ' + step
}

/**
 * Gate commands ci.yml's job runs WITHOUT the change-classifier guard. Multi-line
 * `run: |` blocks are ignored on purpose: every static gate is a single inline
 * command (the piped blocks are the classifier-gated build steps).
 * @param {string} jobText - one job's text.
 * @param {Record<string, string>} scripts - root manifest scripts map.
 * @returns {string[]} canonical commands, in file order.
 */
export function ciUnclassifiedGateCommands(jobText, scripts) {
  const commands = []
  let step = null
  const flush = () => {
    if (step === null) return
    if (!step.classified) {
      for (const command of step.commands) commands.push(canonicalizeCommand(command, scripts))
    }
    step = null
  }
  for (const raw of String(jobText).split('\n')) {
    if (/^ {6}- /u.test(raw)) {
      flush()
      step = { classified: false, commands: [] }
    }
    if (step === null) continue
    if (/^\s+if:.*steps\.classify\.outputs\.code == 'true'/u.test(raw)) step.classified = true
    const run = /^\s+run:\s+([^\s|>].*)$/u.exec(raw)
    if (run !== null) step.commands.push(run[1])
  }
  flush()
  return commands
}

/**
 * Compare the local static set with the ci.yml static set.
 * @param {object} input - comparison inputs.
 * @param {readonly string[]} input.staticSteps - MODES.static entries.
 * @param {readonly string[]} input.ciCommands - canonical ci.yml static commands.
 * @param {Record<string, string>} input.scripts - root manifest scripts map.
 * @param {ReadonlyMap<string, string>} [input.exemptions] - one-sided gates.
 * @returns {string[]} problems, empty when the sets agree.
 */
export function staticGateParityProblems({
  staticSteps,
  ciCommands,
  scripts,
  exemptions = STATIC_GATE_EXEMPTIONS,
}) {
  const problems = []
  const local = new Set(staticSteps.map(step => canonicalizeStaticStep(step, scripts)))
  const ci = new Set(ciCommands)
  const exempted = new Set(exemptions.keys())
  for (const command of ci) {
    if (!local.has(command) && !exempted.has(command)) {
      problems.push('ci.yml runs ' + command + ' outside the change classifier, but MODES.static does not list it')
    }
  }
  for (const command of local) {
    if (!ci.has(command) && !exempted.has(command)) {
      problems.push('MODES.static lists ' + command + ', but ci.yml does not run it outside the change classifier')
    }
  }
  for (const key of exemptions.keys()) {
    const inLocal = local.has(key)
    const inCi = ci.has(key)
    if (inLocal === inCi) {
      problems.push('static-gate exemption ' + key + ' is stale: local=' + (inLocal ? 'yes' : 'no')
        + ', ci.yml=' + (inCi ? 'yes' : 'no') + ' — exactly one side must carry it')
    }
  }
  return problems
}
