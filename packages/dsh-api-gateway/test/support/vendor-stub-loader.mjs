/**
 * ESM resolver shim for the chamber fork's dependency-free suites.
 *
 * The gateway fork's real modules import a handful of vendor packages whose
 * install does not exist in a bare checkout. The behavioural suites must import
 * the REAL fork modules (a source-text lock cannot catch a runtime bug), so only the
 * vendor leaves are stubbed:
 * RemoteError (error identity only), Deque and randomUUID.
 */
import { fileURLToPath } from 'node:url'

const STUBS = new Map([
  ['@deepseek-ai/dsh-typert-protocol', './stubs/typert-protocol.mjs'],
  ['@deepseek-ai/dsh-deque', './stubs/deque.mjs'],
  ['@deepseek-ai/dsh-util-crypto', './stubs/util-crypto.mjs'],
])

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}

export const RESOLVED_STUB_PATHS = [...STUBS.values()].map(entry => fileURLToPath(new URL(entry, import.meta.url)))
