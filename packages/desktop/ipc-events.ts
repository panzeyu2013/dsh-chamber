/**
 * Desktop IPC channel names — the single source for MAIN-process senders.
 *
 * `SYSTEM_RESUME_EVENT` is also referenced (as the same literal) by
 * preload.cts: the preload build contract is a self-contained single file
 * (build-preload.mjs), so it cannot import this module — the duplication is
 * deliberate and pinned by ipc-surface-mirror.test.ts.
 *
 * The renderer-side twin lives in
 * packages/dsh-client-connection/src/client/index.ts (same literal; the two
 * processes cannot share one module).
 */
export const SYSTEM_RESUME_EVENT = 'dsh-chamber:system-resume'
