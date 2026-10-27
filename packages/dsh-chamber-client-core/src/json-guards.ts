/**
 * Browser-side face of the shared JSON guards in
 * @dsh-chamber/dsh-chamber-wire/json-guards. One definition each: a guard re-typed
 * per package drifts on the first fix.
 *
 * HARD DISCIPLINE: this file declares nothing; a wire-face change updates this name
 * list and nothing else. No `export *` (verify-no-dead-exports resolves named
 * re-exports only).
 */
export { isPlainRecord, isRecord, isWatermark } from '@dsh-chamber/dsh-chamber-wire/json-guards'
