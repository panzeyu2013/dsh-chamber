/**
 * VENDOR PRESENTED-FACT LOCKSTEP (design 05 section 4, design 09).
 *
 * The chamber renderer routes every session presentation through the OFFICIAL
 * ui-workspace view owner and reads the presented row only through the official
 * runtime facts. Those facts live in the pinned dsh source tree, not in any
 * chamber artifact, so an upstream pin that keeps rendering but moves them would
 * leave the chamber green while presentations stop opening. This file pins the
 * facts by source text on the PINNED tree:
 *
 *  1. uiWorkspace.openSession(target) presents by delegating to replaceMain,
 *     which RETAINS the target with source 'mainView' and only then releases the
 *     reference it replaced - presentation never drops every main-view
 *     reference, even for one tick;
 *  2. sessions.retain() attaches the target's own open() to the returned
 *     reference (reference.attachOpening(this.manager.get(id).open(), signal)),
 *     so retaining IS the presentation/open entry point, and a row's positive
 *     retainedBy.mainView count is the readable presented fact the chamber
 *     health surfaces key on;
 *  3. the local source counts ride the list row: retainScope increments the
 *     caller source's count and publishRetention writes the record onto
 *     byId[id].retainedBy.
 *
 * The source locks at the end pin the CHAMBER half of the same facts: the view
 * owner is read ONLY through reflect.get('uiWorkspace', false) (a direct
 * property on the real cordis proxy throws while the row is still activating),
 * the dispatch still presents through navigation.openSession, and the core
 * runtime-report pass-through still declares the rc.2 row ownership field.
 *
 * The tree is resolved through the vendor symlink layout
 * (vendor/harness-packages/@deepseek-ai/...). A missing tree LOUD-SKIPS the
 * vendor locks (they read nothing and must not read as green) while the chamber
 * source locks still run, so the file is never a zero-test run.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const VENDOR_ROOT = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai', import.meta.url))
const VENDOR_SKIP = existsSync(VENDOR_ROOT)
  ? false
  : 'vendor/harness-packages 未物化（pnpm install / 子模块缺失）：' + VENDOR_ROOT

/** Code-only, whitespace-normalized text of one repo-relative source file. */
function repoSource(path: string): string {
  return normalize(stripComments(readFileSync(fileURLToPath(new URL('../../../../' + path, import.meta.url)), 'utf8')))
}

const SESSION_CONTROLLER = 'vendor/harness-packages/@deepseek-ai/dsh-api-session-controller/src/client'
const UI_WORKSPACE = 'vendor/harness-packages/@deepseek-ai/dsh-client-ui-workspace/src/client'

test('vendor presented fact: openSession retains the target as mainView, then releases the replaced reference', { skip: VENDOR_SKIP }, () => {
  const navigation = repoSource(UI_WORKSPACE + '/navigation.ts')
  assert.match(
    navigation,
    /openSession\(target: SessionTarget\): void \{ this\.replaceMain\(target, this\.lifetime\.signal, 'reveal'\) \}/,
    'the ui-workspace view owner no longer delegates openSession to replaceMain - the shell presentation entry point must be re-derived',
  )
  assert.match(
    navigation,
    /const reference = this\.sessions\.retain\(target, \{ source: 'mainView' \}\)/,
    "replaceMain no longer retains the presented target with source 'mainView' - retainedBy.mainView is no longer the presented fact",
  )
  assert.match(
    navigation,
    /const previous = this\.mainReference this\.mainReference = reference previous\?\.release\(\)/,
    'replaceMain no longer releases the replaced reference AFTER adopting the new one - presentation may hold zero main-view references',
  )
})

test('vendor presented fact: retain() starts the presented session open (retaining IS presenting)', { skip: VENDOR_SKIP }, () => {
  const service = repoSource(SESSION_CONTROLLER + '/sessions/service.ts')
  assert.match(
    service,
    /reference\.attachOpening\(this\.manager\.get\(id\)\.open\(\), signal\)/,
    'ClientSessions.retain() no longer attaches the shared initial open() - retaining would stop presenting/opening the target',
  )
})

test('vendor presented fact: source counts ride the list row as retainedBy', { skip: VENDOR_SKIP }, () => {
  const service = repoSource(SESSION_CONTROLLER + '/sessions/service.ts')
  const contract = repoSource(SESSION_CONTROLLER + '/contract/sessions.ts')
  assert.match(
    contract,
    /readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>/,
    'SessionRetainInfo no longer declares the source-count map the presented fact is read from',
  )
  assert.match(
    contract,
    /retain\(target: SessionTarget, options: SessionRetainOptions\): SessionReference/,
    'ISessions.retain signature changed - the presentation entry point must be re-derived',
  )
  assert.match(
    service,
    /retainedBy: freezeRetainedBy\(\{ \.\.\.previous\.retainedBy, \[source\]: \(previous\.retainedBy\[source\] \?\? 0\) \+ 1 \}\)/,
    'retainScope no longer increments the caller source count - a positive mainView count would no longer mean presented',
  )
  assert.match(
    service,
    /this\.list\.set\(\{ \.\.\.state, byId: \{ \.\.\.state\.byId, \[id\]: \{ \.\.\.row, retainedBy \} \} \}\)/,
    'publishRetention no longer writes retainedBy onto the list row - the presented fact would stop reaching list readers',
  )
})

test('chamber renderer lock: the view owner is read through reflect.get(uiWorkspace, false) only', () => {
  const shell = repoSource('packages/renderer/src/shell.ts')
  assert.match(
    shell,
    /const reflect = \(ctx as \{ reflect\?: \{ get\?\(name: string, strict\?: boolean\): unknown \} \}\)\.reflect/,
    'shell.ts no longer reads the ctx reflect face - the service-lookup contract changed',
  )
  assert.match(
    shell,
    /if \(reflect\?\.get === undefined\) return undefined/,
    'a ctx without a reflect face must stay on the transient poll path',
  )
  assert.match(
    shell,
    /const found = reflect\.get\('uiWorkspace', false\)/,
    "shell.ts must read the view owner through reflect.get('uiWorkspace', false) - a renamed service or a dropped false argument breaks the transient arm",
  )
  assert.doesNotMatch(
    shell,
    /\.uiWorkspace\b/,
    'a direct ctx.uiWorkspace read reappeared - the real cordis proxy throws on an absent service while ui-workspace is still activating',
  )
  assert.match(
    shell,
    /navigation\.openSession\(sessionId\)/,
    'the dispatch no longer presents through the official view owner openSession',
  )
})

test('chamber renderer lock: the core runtime report still passes the rc.2 row ownership field through', () => {
  const derive = repoSource('packages/dsh-chamber-client-core/src/derive.ts')
  assert.match(
    derive,
    /retainedBy\?: Readonly<Record<string, number>>/,
    'projectRuntimeFacts no longer accepts the rc.2 retainedBy row field - the presentation pass-through must be re-derived',
  )
})
