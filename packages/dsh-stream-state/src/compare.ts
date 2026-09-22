/**
 * Differential trace comparator.
 *
 * The oracle compares an old wiring's action trace with the new reducer's effect
 * trace. Both sides are projected through the action normalizer first, so wording
 * and intra-tick ordering never decide a verdict; only behavioral differences do.
 *
 * Importable from a plain node script (scripts/refactor/equivalence.mjs) because
 * it touches nothing but the two pure modules: no fs, no DOM, no fork.
 */
import { normalizeEffect } from './normalize.ts'
import type { RecoveryEffect } from './state.ts'

export interface TraceDifference {
  readonly side: 'missing' | 'extra'
  readonly normalized: string
  readonly at: number | null
}

export interface TraceVerdict {
  readonly equivalent: boolean
  readonly expected: readonly string[]
  readonly actual: readonly string[]
  readonly differences: readonly TraceDifference[]
}

function behavioralKey(effect: RecoveryEffect): string {
  const normalized = normalizeEffect(effect)
  return normalized.kind + ':' + normalized.target + ':' + normalized.reasonClass
}

function effectAt(effect: RecoveryEffect): number | null {
  if (effect.e === 'rebuildCarrier') return effect.at
  if (effect.e === 'throttled') return effect.at
  return null
}

function multiset(list: readonly RecoveryEffect[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const effect of list) {
    if (effect.e === 'forensic') continue
    const key = behavioralKey(effect)
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

/**
 * Compare two effect traces. Behavioral effects are compared as a multiset (so a
 * repeated replacement is a real difference) and forensic effects are compared as
 * a set (so added observability passes while a dropped fact fails).
 */
export function compareTraces(
  expected: readonly RecoveryEffect[],
  actual: readonly RecoveryEffect[],
): TraceVerdict {
  const expectedBehavioral = multiset(expected)
  const actualBehavioral = multiset(actual)
  const differences: TraceDifference[] = []
  for (const [key, count] of expectedBehavioral) {
    const got = actualBehavioral.get(key) ?? 0
    if (got >= count) continue
    const sample = expected.find((e) => e.e !== 'forensic' && behavioralKey(e) === key)
    for (let i = 0; i < count - got; i += 1) {
      differences.push({ side: 'missing', normalized: key, at: sample ? effectAt(sample) : null })
    }
  }
  for (const [key, count] of actualBehavioral) {
    const got = expectedBehavioral.get(key) ?? 0
    if (got >= count) continue
    const sample = actual.find((e) => e.e !== 'forensic' && behavioralKey(e) === key)
    for (let i = 0; i < count - got; i += 1) {
      differences.push({ side: 'extra', normalized: key, at: sample ? effectAt(sample) : null })
    }
  }
  const expectedFacts = new Set(expected.filter((e) => e.e === 'forensic').map(behavioralKey))
  const actualFacts = new Set(actual.filter((e) => e.e === 'forensic').map(behavioralKey))
  for (const fact of expectedFacts) {
    if (!actualFacts.has(fact)) differences.push({ side: 'missing', normalized: fact, at: null })
  }
  return {
    equivalent: differences.length === 0,
    expected: [...expectedBehavioral.keys()].sort(),
    actual: [...actualBehavioral.keys()].sort(),
    differences,
  }
}

/** One-line-per-difference rendering, used by the CLI report. */
export function formatVerdict(verdict: TraceVerdict): string {
  if (verdict.equivalent) return 'equivalent'
  return verdict.differences
    .map((d) => (d.side === 'missing' ? '- ' : '+ ') + d.normalized + (d.at === null ? '' : ' @' + String(d.at)))
    .join('; ')
}
