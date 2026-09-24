/**
 * Public entry for @dsh-chamber/dsh-stream-state: re-exports every module that is
 * consumer surface; the subpaths stay reachable for the package's own tests only.
 */

export * from './state.ts'
export * from './tables.ts'
export * from './carrier.ts'
export * from './load-state.ts'
export * from './session-authority.ts'
export * from './normalize.ts'
export * from './compare.ts'
export * from './source.ts'
export * from './container.ts'
export * from './presentation.ts'
export * from './ladder.ts'
export * from './async-op.ts'
// Forensics: the ring factory, the detail bound and the port types are consumer surface;
// the sanitizer and the sizing constants stay module-internal.
export {
  FORENSICS_DETAIL_MAX,
  createForensicsRing,
  type ForensicsEntry,
  type ForensicsRing,
  type ForensicsSink,
} from './forensics.ts'
