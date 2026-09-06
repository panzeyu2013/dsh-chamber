/**
 * Restore-marker wire basename below `dsh-runtime`. snapshot-store (snapshot
 * restore, marker writer/remover) and runtime-metadata-recovery (archives the
 * same name as opaque evidence) share this single source.
 *
 * Deliberately NOT re-exported by index.ts (dist-sync lockstep); module-local
 * imports only.
 */
export const RESTORE_MARKER_BASENAME = 'restore-in-progress'
