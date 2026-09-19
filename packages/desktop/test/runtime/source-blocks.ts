import assert from 'node:assert/strict'

/**
 * The balanced `{ … }` block starting at `from`: the exact `{` when `from`
 * is one, otherwise the first `{` at or after it. Shared by the main.ts
 * source-anchor locks (runtime-lockstep / main-decision-gates); a missing
 * start or an unbalanced block fails loudly instead of returning a fragment.
 */
export function balancedBlock(source: string, from: number): string {
  assert.ok(from >= 0, 'block start not found')
  const open = source[from] === '{' ? from : source.indexOf('{', from)
  assert.notEqual(open, -1, 'no block found')
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail('unbalanced block')
}
