/**
 * Unit tests for the pnpm single-source contract (P2-14) and the static-gate
 * parity contract (P1-1). Both are the "one declared source + mirrors" shape:
 * a silent divergence is the failure mode, so every case below pins a drift as
 * a finding (and the real repository as finding-free).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODES } from './run-checks.mjs'
import {
  STATIC_GATE_EXEMPTIONS,
  ciUnclassifiedGateCommands,
  jobBlock,
  staticGateParityProblems,
} from './static-gate-parity.mjs'
import { pnpmPinFindings, readPnpmPinSites } from './pnpm-pin.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ROOT_SCRIPTS = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts

test('pnpmPinFindings: agreement is silent, every drift is a finding', () => {
  const clean = { packageManager: 'pnpm@1.2.3', workflowPins: [{ file: 'a.yml', version: '1.2.3' }], mirrors: [{ file: 'b.json', label: 'dependencies.pnpm', version: '1.2.3' }] }
  assert.deepEqual(pnpmPinFindings(clean), [])
  assert.match(pnpmPinFindings({ ...clean, packageManager: 'pnpm@1.2' })[0], /must declare pnpm@<x\.y\.z>/)
  assert.match(pnpmPinFindings({ ...clean, packageManager: undefined })[0], /must declare/)
  assert.match(pnpmPinFindings({ ...clean, workflowPins: [{ file: 'a.yml', version: '9.9.9' }] }).join(';'), /a\.yml: pnpm\/action-setup version=9\.9\.9 != 1\.2\.3/)
  assert.match(pnpmPinFindings({ ...clean, mirrors: [{ file: 'b.json', label: 'dependencies.pnpm', version: '(missing)' }] }).join(';'), /b\.json: dependencies\.pnpm=\(missing\) != 1\.2\.3/)
})

test('the real repository pins one pnpm version everywhere (P2-14)', () => {
  const sites = readPnpmPinSites(REPO_ROOT)
  assert.ok(sites.workflowPins.length >= 9, 'every pnpm/action-setup step must be seen（得到 ' + String(sites.workflowPins.length) + '）')
  assert.equal(sites.mirrors.length, 3)
  assert.deepEqual(pnpmPinFindings(sites), [])
})

test('ciUnclassifiedGateCommands ignores classifier-gated and piped blocks', () => {
  const job = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Classify',
    '        run: node scripts/gates/classify-ci-changes.mjs',
    '      - name: Gate',
    '        run: pnpm run verify:i18n',
    '      - name: Heavy',
    '        if: steps.classify.outputs.code == \'true\'',
    '        run: pnpm run build:renderer',
    '      - name: Piped',
    '        run: |',
    '          pnpm run typecheck',
    '  test-windows:',
    '    steps: []',
  ].join('\n')
  const scripts = { 'verify:i18n': 'node scripts/gates/verify-i18n.mjs', 'build:renderer': 'pnpm --filter x run build' }
  assert.deepEqual(ciUnclassifiedGateCommands(jobBlock(job, 'test'), scripts), [
    'node scripts/gates/classify-ci-changes.mjs',
    'node scripts/gates/verify-i18n.mjs',
  ])
})

test('MODES.static and ci.yml\'s unclassified gate set are single-sourced (P1-1)', () => {
  const job = jobBlock(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'), 'test')
  assert.ok(job.length > 0, 'ci.yml must declare the test job')
  const ciCommands = ciUnclassifiedGateCommands(job, ROOT_SCRIPTS)
  assert.ok(ciCommands.length >= 10, 'the static chain must be non-trivial（得到 ' + String(ciCommands.length) + '）')
  const problems = staticGateParityProblems({ staticSteps: MODES.static, ciCommands, scripts: ROOT_SCRIPTS })
  assert.deepEqual(problems, [], problems.join('\n'))
  // Negative controls: dropping a step on EITHER side must be detected, and a
  // stale exemption must be rejected (an exemption carried by both sides).
  const missingLocal = staticGateParityProblems({
    staticSteps: MODES.static.filter(step => step !== 'verify:registry'),
    ciCommands,
    scripts: ROOT_SCRIPTS,
  })
  assert.ok(missingLocal.some(problem => problem.includes('verify-registry')), missingLocal.join('\n'))
  const missingCi = staticGateParityProblems({
    staticSteps: MODES.static,
    ciCommands: ciCommands.filter(command => !command.includes('verify-registry')),
    scripts: ROOT_SCRIPTS,
  })
  assert.ok(missingCi.some(problem => problem.includes('verify:registry') || problem.includes('verify-registry')), missingCi.join('\n'))
  const staleExemptions = staticGateParityProblems({
    staticSteps: [...MODES.static, 'node scripts/gates/classify-ci-changes.mjs'],
    ciCommands,
    scripts: ROOT_SCRIPTS,
  })
  assert.ok(staleExemptions.some(problem => problem.includes('exemption')), staleExemptions.join('\n'))
  assert.ok(STATIC_GATE_EXEMPTIONS.size >= 4)
})
