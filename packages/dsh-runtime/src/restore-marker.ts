/**
 * Restore-marker wire basename below `dsh-runtime`, shared by snapshot-store (marker
 * writer/remover) and runtime-metadata-recovery (archives the same name as opaque evidence).
 * Deliberately NOT re-exported by index.ts (dist-sync lockstep).
 */
export const RESTORE_MARKER_BASENAME = 'restore-in-progress'
