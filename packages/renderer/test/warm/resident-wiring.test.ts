/**
 * 常驻阀接线锁（N-ctx 壳常驻 v1.1）：App 注入活态 viewStore 与两个活 ref、常驻阀走纯快照构建器、
 * 面板打开时请求一次带 DOM 计数的快照。行为面由 resident-snapshot / resident-panel-model 直测；
 * 本套件只锁「接线不被静默摘掉」（与 input-activity-wiring 同规）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const APP = read('../../src/App.tsx')
const GUARD = read('../../src/app-hooks/use-resident-guard.ts')
const PANEL = read('../../../dsh-chamber-client-ui-settings-bridge/src/client/ResidentPanel.tsx')

test('App wiring: the resident guard receives the live view store and both live refs', () => {
  assert.match(APP, /useResidentGuard\(\{/)
  assert.match(APP, /pendingView: pendingViewRef, settingsTarget: settingsTargetRef/,
    'pending/settings target must be passed as LIVE refs, not render-time values')
  assert.match(APP, /activeView, paintedView, viewStore,/,
    'the live view store is the release-time active/painted authority')
})

test('guard wiring: one pure snapshot builder, subscriber-gated DOM counts, refresh and input cleanup', () => {
  assert.match(GUARD, /buildResidentSnapshot\(/, 'the snapshot projection stays a pure unit')
  assert.match(GUARD, /residentBridge\.subscriberCount\(\) > 0/, 'DOM node counts are collected only for subscribers')
  assert.match(GUARD, /residentBridge\.onRefresh\(/, 'panel-open refresh must republish with DOM counts')
  assert.match(GUARD, /clearInput\(/, 'released/unmounted shells drop their input recency')
  assert.doesNotMatch(GUARD, /JSON\.stringify\(id\)/, 'the DOM selector must not interpolate JSON.stringify')
})

test('panel wiring: opening the panel requests one refreshed snapshot', () => {
  assert.match(PANEL, /residentBridge\.requestRefresh\(/)
  assert.match(PANEL, /generalResidentSettingsTarget/, 'the settings-panel target row shows a hint instead of a release action')
  assert.match(PANEL, /setInterval\(/, 'the panel keeps one display-only clock for live hidden durations')
})
