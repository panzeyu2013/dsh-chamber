/**
 * v2 embedded-browser CSP source resolution (design 28 §16.3).
 *
 * Pins the four things the static-serving header assertion cannot: the default
 * claim stays byte-identical to v1, the generated list is exactly the wire
 * generator's alias+loopback grid, the desktop caller may widen it with the bare
 * `http:`/`https:` scheme sources (upstream ui-sidebar-browser frames ANY http(s)
 * page), and invalid caller input ('self', wildcard host, credential URL) still
 * fails construction rather than widening the policy silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { frameSrcDirective, resolveBrowserFrameSources } from '../../src/browser-frame-sources.ts'
import {
  FORWARD_ALIAS_OCTETS,
  FORWARD_LOCAL_LOOPBACK_HOSTS,
  FORWARD_WIRE_VERSION,
  forwardAliasHost,
  forwardFrameSources,
} from '@dsh-chamber/dsh-chamber-wire/forward'

test('default is the v1 blob-only claim (gateway/cli/standalone byte-identical)', () => {
  const defaults = resolveBrowserFrameSources(undefined)
  assert.deepEqual(defaults, ['blob:'])
  assert.deepEqual(resolveBrowserFrameSources(null), ['blob:'])
  assert.equal(frameSrcDirective(defaults), 'frame-src blob:')
})

test('generated list = blob + local loopback + every alias host, in one frozen array', () => {
  const sources = forwardFrameSources()
  assert.equal(FORWARD_WIRE_VERSION >= 2, true, 'v2 wire contract expected')
  assert.equal(sources[0], 'blob:')
  assert.equal(sources.length, 1 + FORWARD_LOCAL_LOOPBACK_HOSTS.length + FORWARD_ALIAS_OCTETS.capacity)
  for (const host of FORWARD_LOCAL_LOOPBACK_HOSTS) assert.ok(sources.includes('http://' + host + ':*'))
  for (let octet = FORWARD_ALIAS_OCTETS.min; octet <= FORWARD_ALIAS_OCTETS.max; octet += 1) {
    assert.ok(sources.includes('http://' + forwardAliasHost(octet) + ':*'), 'missing alias ' + String(octet))
  }
  assert.equal(Object.isFrozen(sources), true)
})

test('resolve accepts the generated list, the desktop http(s) widening, de-duplicates and keeps order', () => {
  const generated = forwardFrameSources()
  const resolved = resolveBrowserFrameSources([...generated, ...generated])
  assert.deepEqual(resolved, generated)
  assert.equal(Object.isFrozen(resolved), true)
  // The desktop main/sidecar append exactly these two bare scheme sources: the
  // upstream iframe behavior frames arbitrary http(s) pages, so the CSP must not
  // be narrower than the browser surface it hosts.
  const desktop = [...generated, 'http:', 'https:']
  const resolvedDesktop = resolveBrowserFrameSources([...desktop, 'https:', 'http:'])
  assert.deepEqual(resolvedDesktop, desktop, 'scheme widening is de-duplicated in first-seen order')
  assert.equal(resolvedDesktop[resolvedDesktop.length - 1], 'https:')
  assert.equal(frameSrcDirective(resolvedDesktop), 'frame-src ' + desktop.join(' '))
})

test('resolve rejects widening entries and malformed input loudly', () => {
  const bad: readonly unknown[] = [
    ['self'],
    ['*'],
    ['http://example.com:*'],
    ['http://127.0.0.1:8080'],
    ['blob:;'],
    [],
    'blob:',
  ]
  for (const value of bad) {
    assert.throws(() => resolveBrowserFrameSources(value), TypeError, JSON.stringify(value))
  }
  assert.throws(() => resolveBrowserFrameSources(['http://127.0.0.2:*']), TypeError, 'blob: is required')
  assert.throws(() => resolveBrowserFrameSources(['http:', 'https:']), TypeError, 'blob: is required even with the scheme widening')
})

test('frame-src directive: default never carries a bare scheme, desktop widening does, self stays rejected', () => {
  const defaultDirective = frameSrcDirective(forwardFrameSources())
  assert.ok(defaultDirective.length > 0 && defaultDirective.length < 8192, 'header budget: ' + String(defaultDirective.length))
  assert.doesNotMatch(defaultDirective, /'self'/)
  assert.doesNotMatch(defaultDirective, /frame-src[^;]*\b(?:http|https):\s/)
  const desktopDirective = frameSrcDirective([...forwardFrameSources(), 'http:', 'https:'])
  assert.match(desktopDirective, /frame-src blob: [^;]* http: https:$/u)
  assert.doesNotMatch(desktopDirective, /'self'/)
  assert.ok(desktopDirective.length < 8192, 'header budget: ' + String(desktopDirective.length))
})
