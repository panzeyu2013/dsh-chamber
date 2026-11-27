/**
 * Unit locks for the shared source-text helper (`scripts/dev/test-support/source-text.ts`).
 *
 * WHY THIS FILE EXISTS: stripComments/normalize are the truth source behind dozens of
 * source-lock tests AND the production ladder-table gate. A regression in the helper does
 * not make those locks fail — it moves the text they match, so a comment eaten as code or
 * code eaten as a comment turns the locks GREEN without any of them noticing. This suite
 * pins the helper's own contract: comments blanked with length/newlines preserved,
 * string/template/regex literals untouched, the `)`/`]`-then-regex recovery, the two
 * registered edges (unclosed block comment, `${}` interiors not scanned) and the documented
 * nested-template over-strip. The closing canary keeps that one known hazard out of the
 * shipping corpus.
 *
 * Run directly: node scripts/dev/test-support/source-text.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from './source-text.ts'
import { walkFiles } from '../../lib/walk.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Comments are blanked 1:1: byte length and line structure must survive every input. */
function assertShapePreserved(input, output, label) {
  assert.equal(output.length, input.length, label + ': stripping must preserve the byte length so positions stay valid')
  assert.equal(output.split('\n').length, input.split('\n').length, label + ': stripping must preserve the line structure')
}

test('line comments are blanked while the comment newline and the following code survive', () => {
  const input = 'const before = 1 // secret marker\nconst after = 2\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'line comment')
  assert.doesNotMatch(output, /secret|marker/u, 'the comment text must be blanked')
  assert.ok(output.startsWith('const before = 1 '), 'code before the comment survives')
  assert.ok(output.endsWith('\nconst after = 2\n'), 'the newline and the next line survive')
})

test('block comments are blanked in place, including their newlines', () => {
  const input = 'const a = 1\n/* block\n   secret */\nconst b = 2\nconst inline = /* hidden */ 3\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'block comment')
  assert.doesNotMatch(output, /block|secret|hidden/u, 'both block comments must be blanked')
  assert.ok(output.startsWith('const a = 1\n'), 'code before the block comment survives')
  assert.match(output, /\nconst b = 2\n/u, 'the line after the block comment survives')
  assert.match(output, /const inline = +3\n$/u, 'code around the inline block comment survives')
})

test('a `//` inside a string literal (https URL) is not a comment', () => {
  const input = 'const url = "https://example.test/a//b"\nconst tail = "kept" // gone\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'string literal')
  assert.ok(output.includes('"https://example.test/a//b"'), 'the URL text survives verbatim')
  assert.ok(output.includes('"kept"'), 'the string before a real comment survives')
  assert.doesNotMatch(output, /gone/u, 'the trailing real comment is still blanked')
})

test('regex literals keep their body, including `//` inside a character class and escaped slashes', () => {
  const input = 'const re = /[//]/u\nconst escaped = /a\\/\\//u\nconst after = 1\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'regex literal')
  assert.ok(output.includes('/[//]/u'), 'the character-class regex survives verbatim')
  assert.ok(output.includes('/a\\/\\//u'), 'escaped slashes survive verbatim')
  assert.match(output, /const after = 1/u, 'the code after the regex literals survives')
})

test('a regex literal directly after `)` or `]` is recovered instead of eaten as a comment', () => {
  // Third-round counter-example: `)`/`]`/`}` followed by a class-bearing literal. Treated as
  // division, the `//` inside the class becomes a line-comment start and blanks the real code
  // (`assert.doesNotMatch` source locks would then pass on source that lost its body).
  const input = 'if (ok) /[//]/.test(s)\nconst tail = arr[0] /a\\/\\//.test(s)\nconst next = 1\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'regex after a closing bracket')
  assert.ok(output.includes('if (ok) /[//]/.test(s)'), 'the after-`)` regex survives')
  assert.ok(output.includes('arr[0] /a\\/\\//.test(s)'), 'the after-`]` regex survives')
  assert.match(output, /const next = 1/u, 'the code after both regex literals survives')
})

test('a division slash is not treated as a regex start, and its line comment is still stripped', () => {
  const input = 'const half = total / 2 // note\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'division')
  assert.match(output, /total \/ 2/u, 'the division survives')
  assert.doesNotMatch(output, /note/u, 'the real comment is stripped')
})

test('template literals are copied verbatim: `//` and URLs inside them are not comments', () => {
  const input = 'const plain = `a // b`\nconst url = `https://example.test//`\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'template literal')
  assert.match(output, /`a \/\/ b`/u, 'the template text survives (a template is not a comment)')
  assert.match(output, /`https:\/\/example\.test\/\/`/u, 'a URL inside a template survives')
  assert.equal(output, input, 'no comment/regex trigger: a plain template passes through unchanged')
})

test('a template interpolation is not scanned: comment text inside `${}` is left as visible noise', () => {
  // Registered edge (helper head comment :36): `${}` interiors are not lexed separately, so a
  // comment inside an interpolation stays in the output. Direction = under-strip: it can make a
  // lock FAIL loudly, never pass on code that was stripped away.
  const input = 'const s = `${value /* kept as noise */ }`\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'interpolation')
  assert.match(output, /kept as noise/u, 'a comment inside ${} is not stripped (documented under-strip direction)')
  assert.ok(output.includes('${value'), 'the interpolation text itself survives')
})

test('a nested template without `//` in its text passes through unchanged (the common form)', () => {
  const input = "const s = `${cond ? `a` : 'b'}`\n"
  assert.equal(stripComments(input), input, 'nested templates alone must not trigger comment blanking')
})

test('registered boundary: a nested template whose inner text contains `//` is over-stripped', () => {
  // THE ONE KNOWN HAZARD (helper head comment :36-38): the inner opening backtick is read as
  // closing the outer template, so a `//` in the inner template text starts a line comment and
  // the rest of the line is blanked. Direction = over-strip (dangerous for doesNotMatch locks),
  // which is why the shipping-source canary below must stay empty; this assertion makes the
  // boundary visible, so fixing it (or changing the stripping strategy) fails here first.
  const input = 'const s = `${`a // b`}`\nconst next = 1\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'nested template boundary')
  assert.doesNotMatch(output, /kept|\/\/ b/u, 'the inner `//` is misread as a comment start (documented over-strip)')
  assert.doesNotMatch(output, /b`/u, 'the inner template tail is blanked on that line')
  assert.match(output, /const next = 1/u, 'the line comment stops at the newline, as a line comment does')
})

test('an unclosed block comment blanks the rest of the source while keeping every newline', () => {
  const input = 'const kept = 1\n/* never closed\nconst eaten = 2\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'unclosed block comment')
  assert.ok(output.startsWith('const kept = 1\n'), 'code before the opener survives')
  assert.doesNotMatch(output, /never closed|eaten/u, 'everything after the unclosed opener is blanked')
  assert.equal(output.split('\n').length, input.split('\n').length, 'newlines survive so line numbers stay valid')
})

test('CRLF input keeps its line count and its code lines', () => {
  const input = 'const a = 1 // secret\r\nconst b = 2\r\n'
  const output = stripComments(input)
  assertShapePreserved(input, output, 'CRLF')
  assert.equal(output.split('\n').length, 3, 'both CRLF terminators survive as newlines')
  assert.ok(output.startsWith('const a = 1 '), 'code before the comment survives')
  assert.doesNotMatch(output, /secret/u, 'the comment text is blanked')
  assert.ok(output.endsWith('const b = 2\r\n'), 'an untouched CRLF code line is reproduced byte-for-byte')
})

test('normalize collapses every whitespace run so formatting cannot break a semantic lock', () => {
  assert.equal(normalize('  a\n\t b   c\r\n'), ' a b c ')
  assert.equal(normalize('const  a = 1'), 'const a = 1')
  assert.equal(normalize('already clean'), 'already clean')
})

/**
 * The registered hazard shape, as a line-level text approximation: an interpolation containing a
 * nested template whose raw text contains `//` before its closing backtick. It matches the
 * boundary fixture (asserted below), so it cannot silently rot into a no-op; multi-line inner
 * templates are outside this canary's scope.
 */
const NESTED_TEMPLATE_HAZARD = /\$\{[^`\n]*`[^`\n]*\/\/[^`\n]*`/u

test('canary: the hazard pattern matches the registered boundary fixture (it cannot rot into a no-op)', () => {
  assert.match('const s = `${`a // b`}`', NESTED_TEMPLATE_HAZARD, 'the canary must still recognise the registered fixture')
  assert.doesNotMatch('const url = `https://example.test//`', NESTED_TEMPLATE_HAZARD, 'a plain template URL is not the hazard shape')
})

test('canary: the shipping source carries no nested-template-with-// hazard shape', () => {
  const shippingFile = /\.(?:ts|tsx|mjs)$/u
  const testFile = /(?:\.test\.(?:ts|tsx|mjs)$)|(?:\/test\/)/u
  const files = [
    ...walkFiles(join(REPO_ROOT, 'packages'), path => shippingFile.test(path) && !testFile.test(path)),
    // scripts/release/ is real source while the shared walk treats `release` as build output.
    ...walkFiles(join(REPO_ROOT, 'scripts'), path => shippingFile.test(path) && !testFile.test(path), {
      ignoredDirs: ['node_modules', 'dist', '.git'],
    }),
  ]
  assert.ok(files.length > 500, 'a canary that scans nothing has not passed (got ' + String(files.length) + ' file(s))')
  const hits = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [index, line] of text.split('\n').entries()) {
      if (NESTED_TEMPLATE_HAZARD.test(line)) hits.push(file.slice(REPO_ROOT.length) + ':' + String(index + 1) + ' :: ' + line.trim())
    }
  }
  assert.deepEqual(hits, [], 'nested template with a // in its raw text: the source-text helper over-strips it, so source locks reading these files would silently lose teeth')
})
