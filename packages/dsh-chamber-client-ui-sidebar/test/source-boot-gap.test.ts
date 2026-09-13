/**
 * The sidebar's settled-boot gap copy (2026-12, design 05 §4 「降级呈现」second
 * batch).
 *
 * Pinned here because every link is a silent no-op or a silent LIE when it goes
 * missing: a kind that maps to another kind's sentence, a structured payload that
 * renders as "缺少  ", or a dictionary key that exists in only one language.
 * The fact itself is structured by contract (`ServerBootGap`), so this file also
 * pins the vocabulary the sidebar understands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sourceBootGapNote } from '../src/client/source-boot-gap.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ChamberServerAggregate, ServerBootGapKind } from '../src/shared/aggregate-store.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
/** Collapse whitespace so a formatting change cannot break a semantic lock. */
const flat = (text: string): string => text.replace(/\s+/g, ' ')

/** A row with nothing but the gap fact this module reads. */
const row = (bootGap?: ChamberServerAggregate['bootGap']): ChamberServerAggregate =>
  ({ bootGap } as ChamberServerAggregate)

/** Records the key + params instead of localizing, so the decision is visible. */
const spy = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}(${JSON.stringify(params)})`

/** The vocabulary the sidebar understands; a new kind must be added here AND mapped. */
const KINDS: readonly ServerBootGapKind[] = [
  'graph-unavailable',
  'required-services-missing',
  'deferred-registration-failed',
]

test('sourceBootGapNote: no gap renders nothing (the note line stays a live region)', () => {
  assert.equal(sourceBootGapNote(row(), spy), '')
})

test('sourceBootGapNote: each kind maps to its OWN key and carries its structured facts', () => {
  // Representative payloads (not empty ones — those legitimately share the
  // generic sentence): the point is that three KINDS never share a sentence.
  const withPayload: Record<ServerBootGapKind, ChamberServerAggregate['bootGap']> = {
    'graph-unavailable': { kind: 'graph-unavailable' },
    'required-services-missing': { kind: 'required-services-missing', services: ['sidebarRight'] },
    'deferred-registration-failed': { kind: 'deferred-registration-failed', failedIds: ['@deepseek-ai/dsh-client-ui-tool'] },
  }
  const notes = KINDS.map(kind => sourceBootGapNote(row(withPayload[kind]), spy))
  for (let i = 0; i < KINDS.length; i += 1) {
    assert.match(notes[i]!, /^source\.bootGap\.[A-Za-z]+/, KINDS[i])
  }
  // Distinct sentences per kind: a re-badged kind that reuses another's key would
  // make the sidebar claim the wrong cause.
  assert.equal(new Set(notes).size, KINDS.length, notes.join(' | '))
  assert.equal(
    sourceBootGapNote(row({ kind: 'required-services-missing', services: ['sidebarRight', 'slots'] }), spy),
    'source.bootGap.requiredServicesMissing({"services":"sidebarRight, slots"})',
  )
  assert.equal(
    sourceBootGapNote(row({ kind: 'deferred-registration-failed', failedIds: ['a', 'b'] }), spy),
    'source.bootGap.deferredRegistrationFailed({"n":2})',
  )
  assert.equal(
    sourceBootGapNote(row({ kind: 'graph-unavailable', services: ['ignored'] }), spy),
    'source.bootGap.graphUnavailable',
    'a kind ignores payloads that belong to another kind',
  )
})

test('sourceBootGapNote: an empty payload degrades to the generic sentence, never to "  "', () => {
  const generic = sourceBootGapNote(row({ kind: 'required-services-missing' }), spy)
  assert.equal(generic, 'source.bootGap.generic')
  assert.equal(sourceBootGapNote(row({ kind: 'required-services-missing', services: [] }), spy), generic)
  assert.equal(sourceBootGapNote(row({ kind: 'deferred-registration-failed', failedIds: [] }), spy), generic)
})

test('every gap key the sidebar can select exists in BOTH dictionaries, non-empty', () => {
  const keys = [
    'source.bootGap.generic',
    'source.bootGap.graphUnavailable',
    'source.bootGap.requiredServicesMissing',
    'source.bootGap.deferredRegistrationFailed',
  ] as const
  for (const key of keys) {
    assert.ok(zh[key].trim() !== '', `zh ${key}`)
    assert.ok(en[key].trim() !== '', `en ${key}`)
  }
  // The two parameterized sentences must keep their placeholders in both
  // languages, otherwise a named service silently disappears from the copy.
  assert.match(zh['source.bootGap.requiredServicesMissing'], /\{services\}/)
  assert.match(en['source.bootGap.requiredServicesMissing'], /\{services\}/)
  assert.match(zh['source.bootGap.deferredRegistrationFailed'], /\{n\}/)
  assert.match(en['source.bootGap.deferredRegistrationFailed'], /\{n\}/)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'the dictionaries stay aligned')
})

test('ServerSection renders the gap through the SHARED source-note live region', () => {
  const section = flat(read('../src/client/ServerSection.tsx'))
  assert.match(section, /import \{ sourceBootGapNote \} from '\.\/source-boot-gap\.ts'/)
  // Exactly ONE call: the decision is made once, per source.
  assert.equal(section.match(/sourceBootGapNote\(/g)?.length, 1, 'the gap note is computed once')
  // …and it feeds the SAME note cascade every other source note uses, in the
  // documented priority order (managed-down > gap > managed transient). A second
  // live region for the gap would break the one-live-region-per-source rule the
  // note's own comment pins (2026-12 review NIT), so the gap must be a BRANCH.
  assert.match(
    section,
    /const bootGapNote = sourceBootGapNote\(server, t\) .*?const noteIsBootGap = server\.managedRuntimeDown !== true && bootGapNote !== '' const sourceNote = server\.managedRuntimeDown === true \? t\('source\.managedDown'.*?: noteIsBootGap \? bootGapNote : managedTransient/,
    'the gap is a branch of the single source-note cascade, after managed-down',
  )
  // The warning tone is a MODIFIER of that one line, selected by construction
  // (never by comparing rendered copy).
  assert.match(section, /className=\{clsx\(cc\.sourceNote, noteIsBootGap && cc\.sourceNoteBootGap\)\}/)
})

test('the gap note modifier class exists in the sidebar stylesheet', () => {
  const css = read('../src/client/sidebar-chamber.module.css')
  assert.match(css, /\.sourceNoteBootGap \{/, 'the modifier class must exist (it is consumed by ServerSection)')
  assert.match(
    css,
    /\.sourceNoteBootGap \{[^}]*var\(--dsw-alias-state-warn-primary\)/,
    'the warning tone comes from the state token, not a hardcoded colour',
  )
})
