/** Minimal UUID source for behavioural suites. */
export function randomUUID() {
  return globalThis.crypto.randomUUID()
}
