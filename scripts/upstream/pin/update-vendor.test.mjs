import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// The pin-upgrade pipeline is a two-script handshake: update-vendor switches the
// submodule + harness.commit FIRST and runs the link rebuild BEFORE the operator
// `git add`s the gitlink. The gitlink guard in ensure-harness-vendor must
// therefore be bypassable for that one mid-upgrade call — and only that call.

test('update-vendor runs the mid-upgrade link rebuild with the gitlink guard explicitly skipped', () => {
  const source = read('./update-vendor.mjs')
  assert.match(source, /ensure-harness-vendor\.mjs'\), '--allow-lockfile-stale'\]/)
  assert.match(
    source,
    /env: \{ \.\.\.process\.env, DSH_CHAMBER_VENDOR_SKIP_GITLINK: '1' \}/,
    'the diff link rebuild must opt out of the gitlink guard for this one call',
  )
})

test('the gitlink guard stays on unless the upgrade pipeline opts out', () => {
  const ensure = read('../../dev/bootstrap/ensure-harness-vendor.mjs')
  assert.match(ensure, /process\.env\.DSH_CHAMBER_VENDOR_SKIP_GITLINK === '1'/)
  // The bypass is NARROW: it needs the stale-lockfile upgrade mode too, so a stray env
  // variable alone fails closed instead of silently disabling the drift guard.
  assert.match(ensure, /allowStaleLockfile && process\.env\.DSH_CHAMBER_VENDOR_SKIP_GITLINK === '1'/)
  assert.match(ensure, /!allowStaleLockfile[\s\S]{0,120}不得关闭 gitlink 对拍/)
  assert.match(ensure, /if \(options\.skipGitlinkGuard !== true\)/, 'default paths must still fail on a drifted gitlink')
  assert.match(ensure, /跳过 gitlink 对拍/, 'the bypass must be logged, never silent')
})

test('interrupted-upgrade guidance tells the operator to git add and rerun', () => {
  const source = read('./update-vendor.mjs')
  // Before: the guidance told the operator to check the submodule back out, which
  // leads them into the exact state the guard rejects and says nothing about the
  // index. The recovery the checklist expects is \`git add\` of the three files.
  assert.match(source, /git add vendor\/harness-checkout harness\.commit/, 'the recovery must name the git add step')
  assert.match(source, /升级中断态/, 'the guidance must name the mid-upgrade state')
})
