/**
 * Emission coverage gate (G-A) - no dead lifecycle faces.
 *
 * WHY. A union member with no producer or executor is a face the model promises
 * and nothing performs: the carrier declared an outbound reconcile effect nobody
 * ever emitted, and a source effect the reducer never produced. Both were invisible
 * because every consumer reads the TYPE, so the compiler accepted them. This gate
 * reads the literals out of the unions and the dispatch/execution points out of the
 * implementation, and fails on any literal that has neither a producer nor a
 * documented exemption.
 *
 * WHAT COUNTS AS COVERED. For an EVENT union kind, a production dispatch is a
 * reducer case or an explicit comparison/dispatch site. For an EFFECT union member,
 * coverage is an emission ('e: x') or an execution point ('case x' / 'e === x').
 * The corpus is this package's src/ - the package owns the model; consumers own
 * execution, and G-H separately checks the export surface against production
 * importers.
 *
 * NEGATIVE CONTROL. The pure helpers are exercised with a fabricated literal that
 * appears nowhere in the corpus, and the test asserts it is reported. A gate that
 * cannot fail is not a gate.
 *
 * The exemption list exists for a literal whose consumer is scheduled but not yet
 * landed; every entry carries the reason and must reference a REAL uncovered
 * literal, so a stale exemption (the face became covered) fails too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', '..', 'src')

type Position = 'kind' | 'effect'

export interface Surface {
  readonly name: string
  readonly file: string
  readonly position: Position
  readonly literals: readonly string[]
}

export interface Exemption {
  readonly surface: string
  readonly literal: string
  readonly reason: string
}

/** Empty on purpose: a face without a consumer is a defect until its phase lands. */
export const EXEMPTIONS: readonly Exemption[] = []

function sourceText(file: string): string {
  return readFileSync(join(SRC_DIR, file), 'utf8')
}

/** Literals between two markers (the event-kind unions are standalone blocks). */
export function blockLiterals(text: string, startMarker: string, endMarker: string): string[] {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker, start)
  if (start < 0 || end < 0) return []
  const found: string[] = []
  for (const match of text.slice(start, end).matchAll(/'([A-Za-z][A-Za-z0-9]*)'/gu)) {
    const literal = match[1] as string
    if (!found.includes(literal)) found.push(literal)
  }
  return found
}

/** Literals declared as a readonly object property with a string literal value. */
export function propertyLiterals(text: string, property: string): string[] {
  const pattern = new RegExp("\\{ readonly " + property + ": '([A-Za-z][A-Za-z0-9]*)'", 'gu')
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const literal = match[1] as string
    if (!found.includes(literal)) found.push(literal)
  }
  return found
}

/** The declared surfaces, read from the sources (never hard-coded). */
export function surfaces(): Surface[] {
  const state = sourceText('state.ts')
  const source = sourceText('source.ts')
  return [
    {
      name: 'CarrierEventKind',
      file: 'state.ts',
      position: 'kind',
      literals: blockLiterals(state, 'export type CarrierEventKind =', 'export interface CarrierEvent'),
    },
    { name: 'RecoveryEffect', file: 'state.ts', position: 'effect', literals: propertyLiterals(state, 'e') },
    { name: 'SourceEvent', file: 'source.ts', position: 'kind', literals: propertyLiterals(source, 'kind') },
    { name: 'SourceEffect', file: 'source.ts', position: 'effect', literals: propertyLiterals(source, 'e') },
  ]
}

/** Every production source byte of this package. */
export function productionCorpus(): string {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts')).sort()
  return files.map((name) => readFileSync(join(SRC_DIR, name), 'utf8')).join('\n')
}

/** Does the corpus contain a producer/handler for this literal?
 *
 * Two different rules, because the two positions fail differently:
 *  - an EVENT kind must be HANDLED (`case 'x'` / `kind === 'x'`): an event no
 *    reducer branch understands is an input the model silently ignores;
 *  - an EFFECT member must be PRODUCED (`{ e: 'x'`)`: an effect no reducer
 *    emits is a promise nothing performs, however many consumers switch on it.
 *
 * The declaration itself must not count: a union member is written
 * `{ readonly e: 'x' }`, so the emission probe has no `readonly` anchor and the
 * declaration text cannot satisfy its own coverage check. */
export function coversLiteral(corpus: string, position: Position, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^$()|[\]{}\\]/gu, '\\$&')
  const patterns = position === 'kind'
    ? ["case '" + escaped + "'", "kind === '" + escaped + "'"]
    : ["{ e: '" + escaped + "'"]
  return patterns.some((pattern) => corpus.includes(pattern))
}

export function uncoveredLiterals(
  declared: readonly Surface[],
  corpus: string,
  exemptions: readonly Exemption[] = EXEMPTIONS,
): string[] {
  const exempted = new Set(exemptions.map((entry) => entry.surface + '\u0000' + entry.literal))
  const uncovered: string[] = []
  for (const surface of declared) {
    for (const literal of surface.literals) {
      if (coversLiteral(corpus, surface.position, literal)) continue
      if (exempted.has(surface.name + '\u0000' + literal)) continue
      uncovered.push(surface.name + '.' + literal)
    }
  }
  return uncovered
}

/** Exemptions that no longer name an uncovered literal (stale = the gate would lie). */
export function staleExemptions(
  declared: readonly Surface[],
  corpus: string,
  exemptions: readonly Exemption[] = EXEMPTIONS,
): Exemption[] {
  const uncovered = new Set(uncoveredLiterals(declared, corpus, []))
  return exemptions.filter((entry) => !uncovered.has(entry.surface + '.' + entry.literal))
}

test('the declared surfaces are real and the corpus is non-empty', () => {
  const declared = surfaces()
  assert.ok(declared.length >= 4, 'every lifecycle union must be declared')
  for (const surface of declared) {
    assert.ok(surface.literals.length >= 2, surface.name + ' parsed no literals - the extractor lost the union')
  }
  const corpus = productionCorpus()
  assert.ok(corpus.includes('reduceCarrier') && corpus.includes('reduceSource'), 'the corpus must be the production sources')
})

test('every event kind and effect literal has a production producer or executor', () => {
  const uncovered = uncoveredLiterals(surfaces(), productionCorpus())
  assert.deepEqual(
    uncovered,
    [],
    'declared lifecycle faces with no producer/executor (delete them or add a documented exemption): ' + uncovered.join(', '),
  )
})

test('no exemption is stale (an exemption must cover a real dead face)', () => {
  const stale = staleExemptions(surfaces(), productionCorpus())
  assert.deepEqual(stale, [], 'stale exemptions: ' + stale.map((entry) => entry.surface + '.' + entry.literal).join(', '))
})

test('negative control: a fabricated literal is reported and a real one is covered', () => {
  const corpus = productionCorpus()
  const fabricated: Surface[] = [
    { name: 'FabricatedEvent', file: 'nowhere.ts', position: 'kind', literals: ['ghostEvent', 'alsoMissing'] },
  ]
  assert.deepEqual(uncoveredLiterals(fabricated, corpus), ['FabricatedEvent.ghostEvent', 'FabricatedEvent.alsoMissing'])
  const swallowed: Exemption[] = [
    { surface: 'FabricatedEvent', literal: 'ghostEvent', reason: 'negative control only' },
  ]
  assert.deepEqual(uncoveredLiterals(fabricated, corpus, swallowed), ['FabricatedEvent.alsoMissing'])
  assert.equal(coversLiteral(corpus, 'kind', 'carrierOpened'), true)
  assert.equal(coversLiteral(corpus, 'effect', 'rebuildCarrier'), true)
})
