/**
 * Pinned pnpm version: ONE declared source, every mirror cross-checked
 * (P2-14 of the 13-scripts audit — the version was hand-copied into 13 places
 * with no gate tying them together).
 *
 * Declared source: root `package.json` `packageManager: "pnpm@<x.y.z>"`.
 * Mirrors (read-only: this module never edits anything):
 *   - every `pnpm/action-setup` step's `with.version` in .github/workflows/*.yml
 *   - packages/desktop/package.json    → dependencies.pnpm   (packaged Electron tree)
 *   - packages/gateway/package.json    → dependencies.pnpm   (bundled installer pnpm)
 *   - packages/desktop/scripts/bundle-dsh.mjs → BUNDLE_PNPM_VERSION (npx fallback)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Human-readable name of the single source. */
export const PNPM_SOURCE = 'package.json#packageManager'

/**
 * Pinned pnpm version: ONE declared source + every mirror (read-only).
 * @param {string} repoRoot - repository root.
 * @returns {{ packageManager: string | undefined, workflowPins: { file: string, version: string }[], mirrors: { file: string, label: string, version: string }[] }}
 */
export function readPnpmPinSites(repoRoot) {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const workflowDir = join(repoRoot, '.github', 'workflows')
  const workflowPins = []
  for (const file of readdirSync(workflowDir).filter(name => /\.ya?ml$/u.test(name)).sort()) {
    const text = readFileSync(join(workflowDir, file), 'utf8')
    for (const match of text.matchAll(/pnpm\/action-setup@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+version:\s*([^\s#]+)/gu)) {
      workflowPins.push({ file: '.github/workflows/' + file, version: match[1] })
    }
  }
  const mirrors = []
  for (const spec of [
    { file: 'packages/desktop/package.json', label: 'dependencies.pnpm', pattern: /"pnpm"\s*:\s*"([^"]+)"/u },
    { file: 'packages/gateway/package.json', label: 'dependencies.pnpm', pattern: /"pnpm"\s*:\s*"([^"]+)"/u },
    { file: 'packages/desktop/scripts/bundle-dsh.mjs', label: 'BUNDLE_PNPM_VERSION', pattern: /const BUNDLE_PNPM_VERSION = '([^']+)'/u },
  ]) {
    const text = readFileSync(join(repoRoot, spec.file), 'utf8')
    const match = spec.pattern.exec(text)
    mirrors.push({ file: spec.file, label: spec.label, version: match === null ? '(missing)' : match[1] })
  }
  return { packageManager: root.packageManager, workflowPins, mirrors }
}

/**
 * Findings for every mirror that disagrees with the declared source.
 * @param {object} input - observed pins.
 * @param {string | undefined} input.packageManager - root manifest packageManager.
 * @param {{ file: string, version: string }[]} input.workflowPins - action-setup pins.
 * @param {{ file: string, label: string, version: string }[]} input.mirrors - package/script mirrors.
 * @returns {string[]} findings, empty when every mirror agrees.
 */
export function pnpmPinFindings({ packageManager, workflowPins, mirrors }) {
  const match = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(String(packageManager ?? ''))
  if (match === null) {
    return [PNPM_SOURCE + ' must declare pnpm@<x.y.z>（得到 ' + JSON.stringify(packageManager) + '）']
  }
  const expected = match[1]
  const findings = []
  for (const pin of workflowPins) {
    if (pin.version !== expected) {
      findings.push(pin.file + ': pnpm/action-setup version=' + pin.version + ' != ' + expected + '（单一来源 ' + PNPM_SOURCE + '）')
    }
  }
  for (const mirror of mirrors) {
    if (mirror.version !== expected) {
      findings.push(mirror.file + ': ' + mirror.label + '=' + mirror.version + ' != ' + expected + '（单一来源 ' + PNPM_SOURCE + '）')
    }
  }
  return findings
}
