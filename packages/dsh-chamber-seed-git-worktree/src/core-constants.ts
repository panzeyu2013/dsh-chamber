/**
 * Bundle constants and capacity limits; core.ts re-exports the public names so the
 * package/test import surface stays stable.
 */

/** Bounded read for the worktree `.git` pointer file (gitdir lines are tiny;
 *  a hostile or corrupt pointer must never be read whole into memory). */
export const GIT_DIR_POINTER_MAX_BYTES = 4096

export const READ_TIMEOUT_MS = 10_000
export const MUTATION_TIMEOUT_MS = 30_000
export const READ_OUTPUT_CAP = 1024 * 1024
export const MUTATION_OUTPUT_CAP = 256 * 1024
export const PREVIEW_TTL_MS = 5 * 60_000
export const OPERATION_TTL_MS = 24 * 60 * 60_000
export const SNAPSHOT_DEADLINE_MS = 20_000
/** Discovery cache TTL: rev-parse / worktree-list / show-ref results are reused within
 *  this window while the registry signature is unchanged; STATUS (dirty) always runs
 *  fresh and mutations clear the caches. */
export const DISCOVERY_TTL_MS = 30_000
export const SNAPSHOT_WALL_TIMEOUT_MS = 25_000
export const MAX_WORKSPACES = 128
export const MAX_REPOSITORIES = 64
export const MAX_WORKTREES_PER_REPOSITORY = 128
export const MAX_TOTAL_WORKTREES = 256
export const MAX_AGENTS = 4_096
export const MAX_SESSIONS_PER_WORKSPACE = 4_096
export const MAX_TOTAL_SESSION_MEMBERSHIPS = 16_384
export const SNAPSHOT_STATUS_TIMEOUT_MS = 1_500
export const MAX_PATH_LENGTH = 4_096
export const MAX_PREVIEWS = 512
export const MAX_OPERATIONS = 2_048
