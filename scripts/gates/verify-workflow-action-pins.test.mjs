/**
 * Unit tests for the pnpm single-source contract: one declared version plus its
 * mirrors. A silent divergence is the failure mode, so every case below pins a
 * drift as a finding (and the real repository as finding-free).
 *
 * The static-gate set no longer needs a parity test here: the gate registry is the
 * single source, run-checks derives from it and ci.yml/release.yml render from it
 * (freshness covered by gate-workflow-views.test.mjs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
