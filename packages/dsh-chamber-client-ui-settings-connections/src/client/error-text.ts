/**
 * The connections surface's error-text projection. The implementation is the
 * shared one (sidebar/src/shared/error-text.ts, 2026-12 single-sourcing pass);
 * this module is kept as the connection-surface import path and re-exports it,
 * so callers and the behavior test below are unchanged.
 */

export { errorMessage } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
