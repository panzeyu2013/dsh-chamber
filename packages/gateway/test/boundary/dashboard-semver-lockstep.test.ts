/**
 * Lockstep: the dashboard's inline SemVer comparator is
 * shipped as source text (chamber-dashboard-semver.ts) and must agree with the
 * shared dsh-runtime version-safety comparator on every VALID semver pair. The
 * invalid-input policies differ BY DESIGN and are pinned here too: the
 * dashboard compares unparseable versions equal so a stable sort keeps them at
 * the tail, while the shared comparator sorts invalid versions last.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXACT_SEMVER, compareSemverAsc } from '@dsh-chamber/dsh-runtime'
import { DASHBOARD_SEMVER_JS } from '../../src/chamber-dashboard-semver.ts'

/** Evaluate exactly the bytes routes.ts interpolates into the served script. */
const dashboardCompare = new Function(`${DASHBOARD_SEMVER_JS}\nreturn semverCompare;`)() as (a: string, b: string) => number

const sign = (value: number): number => (value < 0 ? -1 : value > 0 ? 1 : 0)

const VALID_SEMVER = [
  '0.0.0', '0.1.0', '1.0.0', '1.0.1', '1.2.3', '1.10.0', '2.0.0', '10.0.0',
  '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
  '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1',
  '1.0.0-0', '1.0.0-1', '1.0.0-2', '1.0.0-10', '1.0.0-0.1',
  '1.0.0+build.1', '1.0.0-alpha+build.1', '1.0.0-beta.2+build.7',
  '999999999999999999999.0.0', '1.0.0-999999999999999999999',
]

test('the shipped dashboard comparator agrees with the shared version-safety comparator on valid semver', () => {
  for (const version of VALID_SEMVER) {
    assert.match(version, EXACT_SEMVER, `the lockstep matrix must stay valid semver: ${version}`)
  }
  for (const a of VALID_SEMVER) {
    for (const b of VALID_SEMVER) {
      assert.equal(
        sign(dashboardCompare(a, b)),
        sign(compareSemverAsc(a, b)),
        `dashboard vs shared comparator disagree on ${a} vs ${b}`,
      )
    }
  }
})

test('invalid-input policy: equal-and-stable in the dashboard, sorted-last in the shared comparator', () => {
  // Unparseable on one side: the dashboard keeps a stable sort position (0),
  // the shared comparator refuses to order it as a real version (invalid > valid).
  assert.equal(dashboardCompare('garbage', '1.0.0'), 0)
  assert.equal(compareSemverAsc('garbage', '1.0.0'), 1)
  assert.equal(dashboardCompare('1.0.0', 'not-a-version'), 0)
  assert.equal(compareSemverAsc('1.0.0', 'not-a-version'), -1)
  // Both unparseable: both comparators are equal (no fabrication of an order).
  assert.equal(dashboardCompare('garbage', 'not-a-version'), 0)
  assert.equal(compareSemverAsc('garbage', 'not-a-version'), 0)
  // Leading zeros are invalid for both; the dashboard keeps them stable at the
  // tail, the shared comparator sorts them after the valid version.
  assert.equal(dashboardCompare('01.0.0', '1.0.0'), 0)
  assert.equal(compareSemverAsc('01.0.0', '1.0.0'), 1)
})

test('the shipped source stays template-safe and regex-free', () => {
  // routes.ts interpolates this text into a template literal: a backslash or a
  // ${ sequence would be consumed/expanded before the browser ever sees it.
  assert.equal(DASHBOARD_SEMVER_JS.includes('\\'), false, 'no backslash escapes in the shipped source')
  assert.equal(DASHBOARD_SEMVER_JS.includes('${'), false, 'no template interpolation in the shipped source')
  assert.match(DASHBOARD_SEMVER_JS, /function semverCompare\(a, b\)/)
})
