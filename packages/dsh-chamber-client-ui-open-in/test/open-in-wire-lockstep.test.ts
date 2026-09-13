/**
 * Wire lockstep between the chamber open-in client and its host domain
 * (design 20 §9).
 *
 * The two halves live in different runtimes — the client is browser code
 * bundled into the composite, the domain is a Node seed package running inside
 * the managed instance — so neither can import the other. This test reads the
 * host side's SOURCE TEXT (the authoritative strings) and fails on any drift of
 * the namespace, the method list, the qualified method names, the error-code
 * set, the `@Remote` surface or the icon media types. It replaces the retired
 * route/byte mirror (`shared/open-in-app-protocol.ts`, design 20 §8).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OPEN_IN_APP_ERROR_CODES,
  OPEN_IN_APP_ICON_MIME_ALLOWLIST,
  OPEN_IN_APP_ICON_METHOD,
  OPEN_IN_APP_METHODS,
  OPEN_IN_APP_APPS_METHOD,
  OPEN_IN_APP_OPEN_METHOD,
  OPEN_IN_APP_PROBE_METHOD,
  OPEN_IN_APP_REMOTE_NAMESPACE,
} from '../src/shared/open-in-wire.ts'

const SEED = join(import.meta.dirname, '..', '..', 'dsh-chamber-seed-open-in', 'src')
const seedShared = readFileSync(join(SEED, 'shared.ts'), 'utf8')
const seedIndex = readFileSync(join(SEED, 'index.ts'), 'utf8')
const seedIcons = readFileSync(join(SEED, 'icons.ts'), 'utf8')

/** Every quoted literal of a `const NAME = [ … ] as const` array. */
function stringArray(source: string, name: string): string[] {
  const match = new RegExp(`${name} = \\[([^\\]]*)\\]`, 'u').exec(source)
  assert.ok(match !== null, `${name} is missing from the host domain source`)
  return [...match[1]!.matchAll(/'([^']+)'/gu)].map(entry => entry[1]!)
}

/** Every `@Remote('<name>')` method name declared by the host facade. */
function remoteMethods(source: string): string[] {
  return [...source.matchAll(/@Remote\('([^']+)'\)/gu)].map(entry => entry[1]!)
}

test('wire lockstep: the namespace and method list match the host domain', () => {
  const namespace = /OPEN_IN_APP_REMOTE_NAMESPACE = '([^']+)'/u.exec(seedShared)?.[1]
  assert.equal(namespace, OPEN_IN_APP_REMOTE_NAMESPACE)
  assert.deepEqual(stringArray(seedShared, 'OPEN_IN_APP_METHODS'), [...OPEN_IN_APP_METHODS])
})

test('wire lockstep: the qualified method names match the host domain', () => {
  const qualified = (method: string): string => `${OPEN_IN_APP_REMOTE_NAMESPACE}/${method}`
  assert.equal(qualified('probe'), OPEN_IN_APP_PROBE_METHOD)
  assert.equal(qualified('apps'), OPEN_IN_APP_APPS_METHOD)
  assert.equal(qualified('icon'), OPEN_IN_APP_ICON_METHOD)
  assert.equal(qualified('open'), OPEN_IN_APP_OPEN_METHOD)
  // The host publishes the same four constants from the same namespace.
  for (const method of OPEN_IN_APP_METHODS) {
    assert.match(
      seedShared,
      new RegExp(`\\$\\{OPEN_IN_APP_REMOTE_NAMESPACE\\}/${method}\``, 'u'),
      `the host domain must publish a fully qualified constant for ${method}`,
    )
  }
})

test('wire lockstep: the host exposes exactly the methods this client calls', () => {
  assert.deepEqual(remoteMethods(seedIndex), [...OPEN_IN_APP_METHODS])
})

test('wire lockstep: the error-code set matches the host domain', () => {
  assert.deepEqual(stringArray(seedShared, 'OPEN_IN_APP_ERROR_CODES'), [...OPEN_IN_APP_ERROR_CODES])
})

test('wire lockstep: the icon media types this client accepts are the host\'s output set', () => {
  // The host's icon extractor declares its contentType union (upstream parity);
  // the client refuses to build a data URL outside it.
  const union = /readonly contentType: ([^\n]+)/u.exec(seedIcons)?.[1]
  assert.ok(union !== undefined, 'the host icon type must declare its contentType union')
  const declared = [...union.matchAll(/'([^']+)'/gu)].map(entry => entry[1]!)
  assert.deepEqual([...OPEN_IN_APP_ICON_MIME_ALLOWLIST].sort(), [...declared].sort())
})
