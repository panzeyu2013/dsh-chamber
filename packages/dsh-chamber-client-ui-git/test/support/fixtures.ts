/**
 * Shared git-domain fixtures for this package's plain-node suites: the opaque
 * ids/head the RPC decoders correlate on and the preview fields the create
 * saga and the decoder cases both pin. One module so the three suites cannot
 * drift apart on the wire facts they cross-check.
 */
import type { PreviewCreateResult } from '../../src/shared/types.ts'

export const REPO_ID = `repo_${'a'.repeat(64)}`
export const WORKTREE_ID = `worktree_${'b'.repeat(64)}`
export const HEAD = 'c'.repeat(40)

/** The preview facts every case shares; each suite pins its own token. */
export const PREVIEW_BASE: Omit<PreviewCreateResult, 'previewToken'> = {
  expiresAt: 1_800_000_000_000, repoId: REPO_ID,
  commonDir: '/repo/.git', mainPath: '/repo', targetPath: '/feature', branch: 'feature', baseHead: HEAD,
}
