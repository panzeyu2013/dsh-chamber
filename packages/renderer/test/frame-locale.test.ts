/**
 * App-frame copy + failure chrome (T15/T16, 2026-09-11 upstream-alignment).
 *
 * The frame (App.tsx / InstanceView.tsx / the static skeleton) cannot be
 * imported by a node test — it renders the whole shell — so this spec pins it
 * the way the renderer's other frame-level specs do: pure decisions
 * (`resolveFrameLocale`, `frameText`, the dictionaries) by direct call, and the
 * wiring by SOURCE-TEXT locks (comments stripped, whitespace normalized:
 * `source-text.ts`), because a missing link there is a silent no-op.
 *
 * Covered:
 *  - the typed dictionary is complete and identical in shape across locales;
 *  - the locale is chosen from the DOCUMENT language (the official locale
 *    service's own projection), never from the OS locale;
 *  - every audited frame string is routed through the dictionary (the retired
 *    zh literals are gone from the frame sources);
 *  - the failure chrome rides the design system: official Button atom, no
 *    invented `.btn`, --dsw-* aliases with the documented fallbacks;
 *  - the failed-plugin list the official report shows is rendered;
 *  - the two a11y nits (decorative spinner, the control-plane overlay's alert).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  en, FRAME_DICTIONARIES, frameText, readDocumentLocale, resolveFrameLocale,
  subscribeDocumentLocale, zh, type FrameKey,
} from '../src/locales.ts'
import { normalize, stripComments } from './source-text.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const readCode = (rel: string): string => normalize(stripComments(read(rel)))

// ── The dictionary (T16) ───────────────────────────────────────────────────

test('the frame dictionaries are complete, parallel and non-empty', () => {
  const zhKeys = Object.keys(zh).sort()
  assert.deepEqual(Object.keys(en).sort(), zhKeys, 'en must cover exactly the zh key set')
  assert.deepEqual(Object.keys(FRAME_DICTIONARIES), ['zh', 'en'])
  for (const key of zhKeys) {
    assert.ok(zh[key as FrameKey].trim() !== '', `zh.${key} must carry copy`)
    assert.ok(en[key as FrameKey].trim() !== '', `en.${key} must carry copy`)
  }
  // The frame's chrome the audit named must be dictionary-owned, in both locales.
  for (const key of [
    'action.retry', 'action.switchServer', 'boot.loading', 'boot.loadingHint', 'boot.starting',
    'error.ui.title', 'fatal.boot.title', 'fatal.entries.title', 'fatal.controlPlane.title',
    'fatal.harvestTimeout', 'source.local', 'session.untitled',
    'notification.sessionComplete', 'notification.awaitingAnswer', 'notification.awaitingApproval',
  ] as FrameKey[]) {
    assert.ok(key in zh && key in en, `${key} must exist in both dictionaries`)
  }
})

test('frameText substitutes placeholders and keeps unmatched ones verbatim', () => {
  assert.equal(frameText('zh', 'boot.loading', { label: '本地实例' }), '正在加载 本地实例…')
  assert.equal(frameText('en', 'boot.loading', { label: 'Local instance' }), 'Loading Local instance…')
  assert.equal(frameText('en', 'boot.loading'), 'Loading {label}…', 'an omitted param leaves the placeholder')
  assert.equal(frameText('en', 'boot.loading', { other: 'x' }), 'Loading {label}…')
  assert.equal(frameText('zh', 'fatal.harvestTimeout', { seconds: '135' }).includes('135'), true)
  assert.equal(frameText('en', 'action.retry'), 'Retry')
})

// ── Locale selection (the frame owns no `t` seat) ──────────────────────────

test('resolveFrameLocale reads the document language and pins the served default', () => {
  // The official locale service writes `<html lang>` (syncDocumentLanguage):
  // zh-family tags are Chinese, every other known tag is English.
  for (const tag of ['zh', 'zh-CN', 'ZH-cn', 'zh-Hans', 'zh_TW']) {
    assert.equal(resolveFrameLocale(tag), 'zh', `${tag} must resolve to zh`)
  }
  for (const tag of ['en', 'en-US', 'ja-JP', 'de']) {
    assert.equal(resolveFrameLocale(tag), 'en', `${tag} must resolve to en (the frame carries two dictionaries)`)
  }
  // An unset language is the SERVED MARKUP default (index.html lang="zh-CN"),
  // never the OS locale — the same pin the settings bridge documents.
  assert.equal(resolveFrameLocale(undefined), 'zh')
  assert.equal(resolveFrameLocale(null), 'zh')
  assert.equal(resolveFrameLocale(''), 'zh')
  assert.equal(resolveFrameLocale('   '), 'zh')
})

test('the document readers are safe without a DOM (plain-node import) and never throw', () => {
  assert.equal(typeof document, 'undefined', 'this spec runs in plain node')
  assert.equal(readDocumentLocale(), 'zh', 'no document → the served default')
  const unsubscribe = subscribeDocumentLocale(() => {})
  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
})

// ── T15/T16 wiring locks (App.tsx / InstanceView.tsx / main.tsx / CSS) ─────

test('every audited frame string is dictionary-owned (no inline literals remain)', () => {
  const frameSources = {
    'App.tsx': readCode('../src/App.tsx'),
    'InstanceView.tsx': readCode('../src/components/InstanceView.tsx'),
  }
  const retired = [
    '界面发生错误', '实例启动失败', '无法连接控制面', '切换到其他服务器', '正在加载',
    '首次打开需加载完整界面', '未命名会话', '会话已完成', '代理正在等待你的回答',
    '代理请求你的批准', '实例启动超时',
  ]
  for (const [file, source] of Object.entries(frameSources)) {
    for (const literal of retired) {
      assert.ok(!source.includes(literal), `${file} must not inline ${JSON.stringify(literal)} — route it through locales.ts`)
    }
  }
  // …and the sites use the dictionary instead (each audited site, explicitly).
  const app = frameSources['App.tsx']
  for (const call of [
    "t('fatal.boot.title')", "t('fatal.controlPlane.title')", "t('action.retry')",
    "t('action.switchServer')", "t('fatal.entries.title')", "t('source.local')",
    "frameText(locale, 'error.ui.title')", "frameText(locale, 'action.retry')",
    "frameText(readDocumentLocale(), 'fatal.harvestTimeout'",
    "frameText(copyLocale, 'session.untitled')", "frameText(copyLocale, 'notification.sessionComplete')",
    "frameText(copyLocale, 'notification.awaitingAnswer')", "frameText(copyLocale, 'notification.awaitingApproval')",
  ]) {
    assert.ok(app.includes(call), `App.tsx must render copy through ${call}`)
  }
  assert.ok(frameSources['InstanceView.tsx'].includes("frameText(locale, 'boot.loading', { label })"))
  assert.ok(frameSources['InstanceView.tsx'].includes("frameText(locale, 'boot.loadingHint')"))
  // The notification effect holds no render-scope values (`[]` deps): it reads
  // the document language at assembly time, so navigation/notification copy
  // follows an English source instead of freezing the locale of first paint.
  assert.ok(app.includes('const copyLocale = readDocumentLocale()'),
    'the notification titles must read the locale when the edge fires')
  // The frame subscribes to the document language, so a locale change inside a
  // booted shell re-renders the frame chrome too.
  assert.ok(app.includes('useSyncExternalStore(subscribeDocumentLocale, readDocumentLocale)'))
  // The static skeleton is re-labelled from the same dictionary before mount
  // (index.html carries only the served markup's default-language copy).
  assert.ok(readCode('../src/main.tsx').includes("frameText(readDocumentLocale(), 'boot.starting')"))
  assert.ok(read('../index.html').includes('data-chamber-boot-hint'),
    'index.html must expose the skeleton hint hook main.tsx rewrites')
})

test('the failure chrome rides the design system (T15: official Button, --dsw-* tokens)', () => {
  const app = readCode('../src/App.tsx')
  // The official atom, imported by deep source path (the barrel would pull the
  // markdown/highlight families into the main graph).
  assert.ok(app.includes("import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'"),
    'the frame must use the official Button atom')
  // All four retry/switch buttons are the atom: the primary CTA and the
  // per-source switch buttons (the escape hatch stays — 05 §4).
  assert.ok(!/className="btn/.test(app), 'the chamber-invented .btn chrome must be gone')
  assert.ok(!/<button/.test(app), 'every frame button must be the official atom')
  assert.ok(app.includes('variant="primary"') && app.includes('variant="outline"'))
  // The failed-plugin list the official report shows (ids, one per row).
  assert.ok(app.includes('activeShellFailedEntries.map'))
  assert.ok(app.includes('className="fatal-entry"'))
  const css = readCode('../src/styles.css')
  assert.ok(!/\.btn\b/.test(css), 'the .btn rules must be deleted')
  assert.ok(!css.includes('--panel-2') && !css.includes('--accent-dim'),
    'the invented palette entries only .btn consumed must go with it (S6)')
  // The overlay follows the document theme so token-based chrome reads in both
  // themes; the chamber dark palette stays only as the pre-token fallback.
  assert.ok(css.includes('background: var(--dsw-alias-bg-base, var(--bg))'))
  assert.ok(css.includes('color: var(--dsw-alias-state-error-primary, var(--red))'))
  assert.ok(css.includes('color: var(--dsw-alias-label-primary, var(--text))'))
})

test('the two a11y nits are fixed (decorative spinner, alert overlays)', () => {
  const view = readCode('../src/components/InstanceView.tsx')
  assert.ok(view.includes('className="instance-loading-spinner" aria-hidden="true"'),
    'the veil spinner is decoration and must stay out of the a11y tree')
  const app = readCode('../src/App.tsx')
  // Both fatal overlays announce themselves: the boot-failure one and the
  // control-plane one (previously only the former).
  const alerts = app.match(/fatal-overlay[^`]*?role="alert"/g) ?? []
  assert.equal(alerts.length, 2, 'both fatal overlays must carry role="alert"')
})
