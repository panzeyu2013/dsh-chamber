/**
 * Unit tests for the documentation link gate.
 *
 * A link gate is only useful if it is precise in both directions: it must not
 * pass a dead path, and it must not reject a link GitHub resolves (heading
 * slugs with punctuation, CJK headings, duplicate headings, explicit anchors).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAnchors, collectDocuments, collectLinkFailures, linkFailure, MIRRORED_DOCUMENTS, slugify } from './verify-md-links.mjs'

/** Run a body against a throwaway repository layout. */
function withTempRepo(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'md-links-'))
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, path)
      mkdirSync(join(absolute, '..'), { recursive: true })
      writeFileSync(absolute, contents)
    }
    return body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('slugify matches GitHub for punctuation, casing and spaces', () => {
  assert.equal(slugify('Pre-flight: findings (2026-12)'), 'pre-flight-findings-2026-12')
  assert.equal(slugify('`code` and *emphasis*'), 'code-and-emphasis')
  assert.equal(slugify('[link](target) text'), 'link-text')
})

test('slugify keeps CJK and drops other punctuation', () => {
  assert.equal(slugify('设计 09 · 客户端插件'), '设计-09-客户端插件')
})

test('collectAnchors adds duplicate suffixes and explicit anchors', () => {
  const anchors = collectAnchors([
    '# Title',
    '## Repeated',
    '## Repeated',
    '<a id="custom-anchor"></a>',
    '### 带自定义 {#named}',
    '```',
    '## not-a-heading',
    '```',
  ].join('\n'))
  assert.equal(anchors.has('title'), true)
  assert.equal(anchors.has('repeated'), true)
  assert.equal(anchors.has('repeated-1'), true)
  assert.equal(anchors.has('custom-anchor'), true)
  assert.equal(anchors.has('named'), true)
  assert.equal(anchors.has('not-a-heading'), false)
})

test('link failures cover a missing file and a dead anchor', () => {
  withTempRepo({
    'docs/target.md': '# Present Heading\n',
    'docs/source.md': [
      '[ok](./target.md#present-heading)',
      '[ok-cjk](./target.md)',
      '[missing](./gone.md)',
      '[dead-anchor](./target.md#absent)',
      '[external](https://example.com/nope)',
      '[anchor-only](#local)',
    ].join('\n'),
  }, (root) => {
    const { failures, links, documents } = collectLinkFailures(root)
    assert.equal(documents, 2)
    assert.equal(links, 6)
    assert.deepEqual(failures.map(failure => failure.target), ['./gone.md', './target.md#absent'])
  })
})

test('a fragment on a non-Markdown target is not treated as an anchor', () => {
  withTempRepo({ 'docs/asset.txt': 'x\n' }, (root) => {
    const reason = linkFailure({
      sourceFile: join(root, 'docs/source.md'),
      rawTarget: './asset.txt#whatever',
      anchorCache: new Map(),
    })
    assert.equal(reason, null)
  })
})

test('an empty documentation set is a failure, not a pass', () => {
  withTempRepo({}, (root) => {
    const { documents, links, failures } = collectLinkFailures(root)
    assert.equal(documents, 0)
    assert.equal(links, 0)
    assert.deepEqual(failures, [])
  })
})

test('frozen upstream mirrors are excluded from the checked set and reported', () => {
  const { mirrored } = collectDocuments(join(import.meta.dirname, '..', '..'))
  for (const path of MIRRORED_DOCUMENTS.keys()) {
    assert.ok(mirrored.includes(path), `${path} must be reported as a skipped mirror`)
  }
})
