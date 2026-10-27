/**
 * JSON guards shared by every chamber wire consumer (host, gateway, renderer, desktop).
 * One definition each: a guard that is re-typed per package drifts on the first fix.
 */

/** Narrow an untrusted value to any non-array object (prototype not judged). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an untrusted value to a plain JSON object. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A non-negative safe-integer watermark (host or observer clock domain). */
export function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
