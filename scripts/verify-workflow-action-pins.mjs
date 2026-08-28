/**
 * Offline workflow-pin consistency guard.
 *
 * The release validation job mirrors ci.yml. A one-character typo in its
 * setup-node SHA made every tag release fail before validation could start.
 * Keep the shared bootstrap actions on one immutable 40-hex commit across
 * CI and every release job; an intentional upgrade must update all uses in
 * the same change.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const workflowDir = resolve(root, '.github/workflows')
const workflows = readdirSync(workflowDir)
  .filter(name => /\.ya?ml$/.test(name))
  .map(name => resolve(workflowDir, name))
const sharedActions = [
  'actions/checkout',
  'pnpm/action-setup',
  'actions/setup-node',
  'actions/cache',
]

const sources = workflows.map(path => ({ path, text: readFileSync(path, 'utf8') }))

// Every external action in every workflow is immutable. This catches a new
// workflow/action even when it is not one of the CI/release bootstrap actions
// enumerated below. Local actions (`./...`) and docker images are not refs.
const actionPins = new Map()
for (const source of sources) {
  const usesPattern = /^\s*-?\s*uses:\s*([^\s@]+)@([^\s#]+).*$/gm
  for (const match of source.text.matchAll(usesPattern)) {
    const action = match[1]
    const pin = match[2]
    if (action.startsWith('./') || action.startsWith('docker://')) continue
    assert.match(pin, /^[0-9a-f]{40}$/, `${action} must use a full immutable commit SHA in ${source.path}`)
    const pins = actionPins.get(action) ?? []
    pins.push({ path: source.path, sha: pin })
    actionPins.set(action, pins)
  }
}
for (const [action, pins] of actionPins) {
  const unique = new Set(pins.map(pin => pin.sha))
  assert.equal(unique.size, 1, `${action} pins drifted across workflows: ${[...unique].join(', ')}`)
}

for (const action of sharedActions) {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`uses:\\s*${escaped}@([0-9a-f]+)`, 'g')
  const pins = []
  for (const source of sources.filter(source => /\/(ci|release)\.yml$/.test(source.path))) {
    const matches = [...source.text.matchAll(pattern)]
    assert.ok(matches.length > 0, `${action} must be pinned in ${source.path}`)
    for (const match of matches) {
      pins.push({ path: source.path, sha: match[1] })
    }
  }
  for (const pin of pins) {
    assert.match(pin.sha, /^[0-9a-f]{40}$/, `${action} must use a full immutable commit SHA in ${pin.path}`)
  }
  const unique = new Set(pins.map(pin => pin.sha))
  assert.equal(
    unique.size,
    1,
    `${action} pins drifted across CI/release workflows: ${[...unique].join(', ')}`,
  )
}

const releaseWorkflow = sources.find(source => source.path.endsWith('/release.yml'))
assert.ok(releaseWorkflow, 'release workflow must be included in the guard')
const releaseConcurrencyGroups = releaseWorkflow.text.match(
  /^\s*group:\s*release-\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*format\('v\{0\}',\s*inputs\.version\)\s*\|\|\s*github\.ref_name\s*\}\}\s*$/gm,
) ?? []
assert.equal(
  releaseConcurrencyGroups.length,
  1,
  'release concurrency must be declared once at workflow scope and normalize tag/manual triggers to the same release tag',
)

assert.match(
  releaseWorkflow.text,
  /create-release:\n(?:[ \t]+#[^\n]*\n)*[ \t]+needs:\s*validation\s*\n/,
  'create-release must wait for validation before mutating GitHub Release state',
)
assert.match(
  releaseWorkflow.text,
  /- name:\s*Create GitHub Release \(draft\)\n[ \t]+id:\s*create_release\n[ \t]+if:\s*\$\{\{\s*github\.event\.inputs\.dry_run\s*!=\s*'true'\s*\}\}/,
  'dry-run must skip GitHub Release creation/update entirely',
)

console.log('workflow action pins: OK')
