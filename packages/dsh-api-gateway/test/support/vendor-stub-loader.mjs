/**
 * ESM resolver shim for the chamber fork's dependency-free suites.
 *
 * The gateway fork's real modules import a handful of vendor packages whose
 * install does not exist in a bare checkout. The behavioural suites must import
 * the REAL fork modules (a source-text lock cannot catch a runtime bug), so only the
 * vendor leaves are stubbed:
 * RemoteError / the owned-value marker, Deque, randomUUID, the cordis Service
 * registration seam, and the connection barrel's dependency-free recovery policy.
 */
import { fileURLToPath } from 'node:url'

const STUBS = new Map([
  ['@deepseek-ai/dsh-typert-protocol', './stubs/typert-protocol.mjs'],
  ['@deepseek-ai/dsh-deque', './stubs/deque.mjs'],
  ['@deepseek-ai/dsh-util-crypto', './stubs/util-crypto.mjs'],
  // The client-invocation suite imports src/client/index.ts, which also reaches
  // these two: cordis supplies only the Service registration seam, and the
  // connection barrel resolves to the real recovery-policy leaf.
  ['@deepseek-ai/cordis', './stubs/cordis.mjs'],
  ['@deepseek-ai/dsh-client-connection/client', './stubs/client-connection.mjs'],
])

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}

export const RESOLVED_STUB_PATHS = [...STUBS.values()].map(entry => fileURLToPath(new URL(entry, import.meta.url)))
