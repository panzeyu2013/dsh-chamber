/**
 * Renderer-side mirrors of the desktop transport metadata gates.
 *
 * These are UX guards only; packages/desktop remains the security/correctness
 * authority and rejects an entire invalid save atomically. The parity test
 * checks these exports against the desktop authority's source declarations
 * without crossing the client plugin's TypeScript rootDir/package boundary.
 */

export const INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/
export const SSH_HOST_PATTERN = /^[a-zA-Z0-9.:\[][a-zA-Z0-9._:\[\]-]*$/
export const SSH_USER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
export const SERVICE_NAME_PATTERN = /^(?!-)[a-zA-Z0-9_.:@-]+$/
export const REMOTE_DSH_HOME_PATTERN = /^~?(?:\/(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._-]+)+$/

export const MAX_INSTANCE_LABEL_CHARS = 128
export const MAX_SSH_HOST_CHARS = 253
export const MAX_SSH_USER_CHARS = 64
export const MAX_SERVICE_NAME_CHARS = 255
export const MAX_REMOTE_DSH_HOME_CHARS = 1024
export const MAX_SSH_PASSWORD_CHARS = 4096
