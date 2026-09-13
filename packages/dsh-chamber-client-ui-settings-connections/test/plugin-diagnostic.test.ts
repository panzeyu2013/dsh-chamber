/**
 * pluginDiagnosticText / pluginDiagnosticTone / bannerProjection unit tests —
 * the consumer-side severity decision for client-plugin runtime diagnostics
 * (design 09 §3.5): `instance-version-conflict` is informational (the page
 * reuses the first-loaded plugin revision and nothing in-app can switch it),
 * every other non-ok state is a problem. The card shows detail only for
 * problems; the plugin dialog always shows the full detail. bannerProjection
 * (plan 24 B1.4) de-duplicates the banner: title = short state name, detail
 * = message ?? pluginId ?? null — the triple repetition of state + pluginId
 * + message never reaches the screen. Mirror of the action-hint.test.ts
 * style: plain node:test, no dsh, no React.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  bannerProjection, bootGapText, pluginDiagnosticText, pluginDiagnosticTone,
  type PluginDiagnostic, type ServerBootGap,
} from '../src/client/plugin-diagnostic.ts'
import { en, zh } from '../src/locales.ts'

/** Identity translator: the key itself is the observable contract. */
const t = (key: string): string => key

test('pluginDiagnosticTone: instance-version-conflict is informational, never a problem', () => {
  assert.equal(pluginDiagnosticTone('instance-version-conflict'), 'info')
  assert.equal(pluginDiagnosticTone('ok'), 'ok')
  for (const state of ['not-injected', 'graph-unreachable', 'bundle-load-failed', 'restart-required'] as const) {
    assert.equal(pluginDiagnosticTone(state), 'problem', state)
  }
})

test('pluginDiagnosticText: maps every state to its own locale key', () => {
  const expected: Readonly<Record<PluginDiagnostic['state'], string>> = {
    'ok': 'pluginDiagnosticOk',
    'not-injected': 'pluginDiagnosticNotInjected',
    'graph-unreachable': 'pluginDiagnosticGraphUnreachable',
    'bundle-load-failed': 'pluginDiagnosticBundleFailed',
    'restart-required': 'pluginDiagnosticRestartRequired',
    'instance-version-conflict': 'pluginDiagnosticInstanceVersionConflict',
  }
  for (const [state, key] of Object.entries(expected) as [PluginDiagnostic['state'], string][]) {
    assert.equal(pluginDiagnosticText(state, t), key)
  }
})

test('bannerProjection: the message is the single detail — the pluginId is never duplicated beside it', () => {
  const diagnostic: PluginDiagnostic = {
    state: 'bundle-load-failed',
    pluginId: '@deepseek-ai/dsh-demo',
    message: 'the bundle import was rejected',
  }
  assert.deepEqual(bannerProjection(diagnostic, t), {
    title: 'pluginDiagnosticBundleFailed',
    detail: 'the bundle import was rejected',
  })
})

test('bannerProjection: the pluginId stands in only when there is no message', () => {
  assert.deepEqual(bannerProjection({ state: 'bundle-load-failed', pluginId: '@deepseek-ai/dsh-demo' }, t), {
    title: 'pluginDiagnosticBundleFailed',
    detail: '@deepseek-ai/dsh-demo',
  })
  // An empty-string message counts as absent — never an empty detail line.
  assert.deepEqual(bannerProjection({ state: 'not-injected', pluginId: '@deepseek-ai/dsh-demo', message: '' }, t), {
    title: 'pluginDiagnosticNotInjected',
    detail: '@deepseek-ai/dsh-demo',
  })
})

test('bannerProjection: neither message nor pluginId → the bare state name, detail null', () => {
  assert.deepEqual(bannerProjection({ state: 'restart-required' }, t), {
    title: 'pluginDiagnosticRestartRequired',
    detail: null,
  })
})

// ── settled-boot gap (2026-12, design 05 §4 「降级呈现」) ────────────────────

test('bootGapText: each kind maps to its own key and carries its structured facts', () => {
  const kt = (key: string, params?: Record<string, string | number>): string =>
    params === undefined ? key : `${key}(${JSON.stringify(params)})`
  const kinds: readonly ServerBootGap['kind'][] = [
    'graph-unavailable', 'required-services-missing', 'deferred-registration-failed',
  ]
  const withPayload: Record<ServerBootGap['kind'], ServerBootGap> = {
    'graph-unavailable': { kind: 'graph-unavailable' },
    'required-services-missing': { kind: 'required-services-missing', services: ['sidebarRight'] },
    'deferred-registration-failed': { kind: 'deferred-registration-failed', failedIds: ['@deepseek-ai/dsh-client-ui-tool'] },
  }
  const texts = kinds.map(kind => bootGapText(withPayload[kind], kt))
  for (let i = 0; i < kinds.length; i += 1) assert.match(texts[i]!, /^bootGap[A-Z]/, kinds[i])
  assert.equal(new Set(texts).size, kinds.length, 'three kinds must never share one sentence')
  // Positive per-kind pins: a collapse onto the GENERIC key would still satisfy
  // the two checks above (every candidate matches /^bootGap[A-Z]/ and the set
  // stays size 3 — 2026-12 falsification round), so pin the exact key.
  assert.equal(bootGapText({ kind: 'graph-unavailable' }, kt), 'bootGapGraphUnavailable')
  assert.equal(
    bootGapText({ kind: 'required-services-missing', services: ['sidebarRight', 'slots'] }, kt),
    'bootGapRequiredServicesMissing({"services":"sidebarRight, slots"})',
  )
  assert.equal(
    bootGapText({ kind: 'deferred-registration-failed', failedIds: ['a', 'b'] }, kt),
    'bootGapDeferredRegistrationFailed({"n":2})',
  )
  // An empty payload (older producer / hand-built row) degrades to the generic
  // sentence instead of rendering "缺少  " or "0 个插件家族".
  assert.equal(bootGapText({ kind: 'required-services-missing' }, kt), 'bootGapGeneric')
  assert.equal(bootGapText({ kind: 'required-services-missing', services: [] }, kt), 'bootGapGeneric')
  assert.equal(bootGapText({ kind: 'deferred-registration-failed', failedIds: [] }, kt), 'bootGapGeneric')
})

test('every gap key exists in BOTH dictionaries with its placeholders', () => {
  const keys = [
    'bootGapLabel', 'bootGapGeneric', 'bootGapGraphUnavailable',
    'bootGapRequiredServicesMissing', 'bootGapDeferredRegistrationFailed', 'bootGapHint',
  ] as const
  for (const key of keys) {
    assert.ok(zh[key].trim() !== '', `zh ${key}`)
    assert.ok(en[key].trim() !== '', `en ${key}`)
  }
  assert.match(zh.bootGapRequiredServicesMissing, /\{services\}/)
  assert.match(en.bootGapRequiredServicesMissing, /\{services\}/)
  assert.match(zh.bootGapDeferredRegistrationFailed, /\{n\}/)
  assert.match(en.bootGapDeferredRegistrationFailed, /\{n\}/)
})

test('the card suppresses an `ok` graph status when a gap is present', () => {
  // Two facts, one screen: the graph channel's `ok` says nothing about whether
  // the page's surfaces registered, so "正常" must not sit next to "前端能力受限".
  const src = new URL('../src/client/plugin-diagnostic.tsx', import.meta.url)
  const text = readFileSync(fileURLToPath(src), 'utf8').replace(/\s+/g, ' ')
  assert.match(
    text,
    /const showDiagnostic = diagnostic !== undefined && !\(bootGap !== undefined && diagnostic\.state === 'ok'\)/,
    'an ok diagnostic must be suppressed when a gap is present',
  )
  assert.match(text, /if \(!showDiagnostic && bootGap === undefined\) return null/,
    'neither fact present ⇒ nothing renders (no empty line)')
  assert.match(text, /\{showDiagnostic && diagnostic !== undefined && \(/, 'the diagnostic line is gated on showDiagnostic')
  assert.match(text, /\{bootGap !== undefined && \(/, 'the gap line has its own gate')
  // The CARD must consume the pure mapping too (the dialog lock below is not
  // enough: the card could drop the sentence and stay green — falsification round).
  assert.match(text, /bootGapText\(bootGap, t\)/, 'the card must render the mapped sentence')
  // Both lines are `role="status"`: neither is an emergency and neither may steal focus.
  // Comments are stripped first: the module header NAMES the attribute, and a lock
  // satisfied by prose is exactly what these locks exist to prevent.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ')
  assert.equal(code.match(/role="status"/g)?.length, 2, 'both lines announce politely, never as alert')
  assert.doesNotMatch(code, /role="alert"/)
})

test('the plugin dialog renders the gap too, and its banner already ignores `ok`', () => {
  const url = new URL('../src/client/PluginDialog.tsx', import.meta.url)
  const text = readFileSync(fileURLToPath(url), 'utf8').replace(/\s+/g, ' ')
  assert.match(text, /\{bootGap !== undefined \? \(/, 'the dialog carries the same gap fact')
  assert.match(text, /bootGapText\(bootGap, t\)/)
  assert.match(text, /diagnostic !== undefined && diagnostic\.state !== 'ok' \? bannerProjection\(diagnostic, t\) : null/,
    'the dialog banner keeps ignoring `ok`, so it cannot contradict the gap line')
})

test('the service id is named ONCE per surface (no sentence + span duplication)', () => {
  // 2026-12 review: rendering the three seats side by side showed the services
  // printed twice on the connections card — `bootGapText` already embeds
  // `{services}` and the component ALSO appended a span with the same ids. The
  // failed-id list is the complementary half (the sentence carries the count).
  for (const rel of ['../src/client/plugin-diagnostic.tsx', '../src/client/PluginDialog.tsx']) {
    const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\s+/g, ' ')
    assert.doesNotMatch(text, /bootGap\.services \?\? \[\]\)\.join/, `${rel} must not render the services again`)
    assert.match(text, /bootGap\.failedIds \?\? \[\]\)\.join/, `${rel} must keep naming the failed ids`)
    // …and in the WARN tone the frame and the sidebar use: the gap is a warning,
    // not an error, and one fact must not change colour between seats.
    assert.match(text, /css\.pluginDiagnosticWarn\)\} role="status"/, `${rel} must use the warn tone for the gap`)
  }
})
