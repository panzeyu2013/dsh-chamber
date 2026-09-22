/**
 * Cross-host lockstep for the gateway runtime-status identity literal
 * (design 18 §9.3 status contract; design 17 §3).
 *
 * The same wire identity is minted and consumed in four places that cannot
 * import each other:
 *   - packages/gateway/src/runtime-manager.ts   (producer constant, Node)
 *   - packages/gateway/src/chamber-assets.ts    (inline browser payload, raw JS)
 *   - packages/desktop/gateway-provider.ts      (Electron main constant)
 *   - packages/dsh-chamber-client-ui-sidebar/src/shared/gateway-runtime.ts
 *     (browser consumer contract — the anchor of this test)
 *
 * A one-sided rename makes the remote status parse fail closed (the consumer
 * rejects the row), which surfaces as a silently missing feature rather than a
 * loud error — so the literal is pinned here instead of trusted to review.
 *
 * Run directly: node packages/dsh-chamber-client-ui-sidebar/test/source-runtime/gateway-runtime-status-kind-lockstep.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GATEWAY_RUNTIME_STATUS_KIND } from '../../src/shared/gateway-runtime.ts'

const SITES = [
  {
    file: '../../../gateway/src/runtime-manager.ts',
    pattern: /export const GATEWAY_RUNTIME_STATUS_KIND = '([^']+)' as const/u,
    count: 1,
  },
  {
    file: '../../../gateway/src/chamber-assets.ts',
    pattern: /row\.kind !== '([^']+)'/u,
    count: 1,
  },
  {
    file: '../../../desktop/gateway-provider.ts',
    pattern: /export const GATEWAY_RUNTIME_IDENTITY = '([^']+)'/u,
    count: 1,
  },
] as const

test('the consumer contract is a well-formed wire identity', () => {
  assert.match(GATEWAY_RUNTIME_STATUS_KIND, /^dsh-chamber-[a-z0-9-]+$/u)
})

for (const site of SITES) {
  test('lockstep: ' + site.file, () => {
    const source = readFileSync(new URL(site.file, import.meta.url), 'utf8')
    const matches = [...source.matchAll(new RegExp(site.pattern.source, 'gu'))]
    assert.equal(matches.length, site.count, site.file + ' must declare the identity exactly ' + String(site.count) + ' time(s)')
    for (const match of matches) {
      assert.equal(match[1], GATEWAY_RUNTIME_STATUS_KIND, site.file + ' drifted from the shared wire identity')
    }
  })
}

test('the local constant is the only source of that literal in this package', () => {
  const source = readFileSync(new URL('../../src/shared/gateway-runtime.ts', import.meta.url), 'utf8')
  const occurrences = [...source.matchAll(/'dsh-chamber-gateway-runtime'/gu)]
  assert.equal(occurrences.length, 1)
})
