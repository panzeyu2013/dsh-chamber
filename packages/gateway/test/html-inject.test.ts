/**
 * html-inject.ts unit tests (S0): the fail-soft trust-declaration injector —
 * size cap (a), idempotency (b), missing </head> (c), insertion before
 * </head> with case-insensitive matching (d). Run with
 * `node packages/gateway/test/html-inject.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HTML_INJECT_MAX_BYTES,
  TRUST_DECLARATION_SCRIPT,
  injectTrustDeclaration,
} from '../src/html-inject.ts'

test('inserts the trust declaration before the first </head> and reports injected:true', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>dsh</title></head><body>ok</body></html>'
  const result = injectTrustDeclaration(html)
  assert.equal(result.injected, true)
  assert.equal(result.html, html.replace('</head>', `${TRUST_DECLARATION_SCRIPT}</head>`))
  assert.equal(TRUST_DECLARATION_SCRIPT, '<script>window.__DSH_TRANSPORT__={ownsHost:true}</script>')
  assert.ok(result.html.indexOf(TRUST_DECLARATION_SCRIPT) < result.html.indexOf('</head>'))
  // Exactly one declaration, no double injection.
  assert.equal(result.html.split('__DSH_TRANSPORT__').length, 2)
})

test('matches the </head> close tag case-insensitively (</HEAD> and mixed case)', () => {
  const upper = '<html><head><title>t</title></HEAD><body>ok</body></html>'
  const upperResult = injectTrustDeclaration(upper)
  assert.equal(upperResult.injected, true)
  assert.equal(upperResult.html, '<html><head><title>t</title>' + TRUST_DECLARATION_SCRIPT + '</HEAD><body>ok</body></html>')

  const mixed = '<html><head></HeAd><body>ok</body></html>'
  const mixedResult = injectTrustDeclaration(mixed)
  assert.equal(mixedResult.injected, true)
  assert.equal(mixedResult.html, '<html><head>' + TRUST_DECLARATION_SCRIPT + '</HeAd><body>ok</body></html>')
})

test('is idempotent: a document already carrying __DSH_TRANSPORT__ is returned untouched', () => {
  const alreadyInjected = '<html><head></head><body>' + TRUST_DECLARATION_SCRIPT + '</body></html>'
  const result = injectTrustDeclaration(alreadyInjected)
  assert.equal(result.injected, false)
  assert.equal(result.html, alreadyInjected)

  // The marker anywhere (even a comment) suppresses injection.
  const commented = '<html><head><!-- __DSH_TRANSPORT__ documented hook --></head><body>ok</body></html>'
  const commentedResult = injectTrustDeclaration(commented)
  assert.equal(commentedResult.injected, false)
  assert.equal(commentedResult.html, commented)
})

test('documents over the 64KiB cap are returned untouched', () => {
  const large = '<html><head></head><body>' + 'x'.repeat(HTML_INJECT_MAX_BYTES) + '</body></html>'
  assert.ok(large.length > HTML_INJECT_MAX_BYTES)
  const result = injectTrustDeclaration(large)
  assert.equal(result.injected, false)
  assert.equal(result.html, large)
})

test('a document exactly at the 64KiB cap is still injectable', () => {
  const padding = 'x'.repeat(HTML_INJECT_MAX_BYTES - '<html><head></head><body></body></html>'.length)
  const boundary = '<html><head></head><body>' + padding + '</body></html>'
  assert.equal(boundary.length, HTML_INJECT_MAX_BYTES)
  const result = injectTrustDeclaration(boundary)
  assert.equal(result.injected, true)
  assert.equal(result.html.length, boundary.length + TRUST_DECLARATION_SCRIPT.length)
})

test('documents without a </head> close tag are returned untouched', () => {
  const noHead = '<html><head><title>dsh</title><body>unclosed head</body></html>'
  assert.equal(noHead.includes('</head>'), false)
  const result = injectTrustDeclaration(noHead)
  assert.equal(result.injected, false)
  assert.equal(result.html, noHead)

  const empty = ''
  const emptyResult = injectTrustDeclaration(empty)
  assert.equal(emptyResult.injected, false)
  assert.equal(emptyResult.html, '')
})
