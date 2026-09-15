/**
 * Shared helpers for the sidebar's source-text locks.
 *
 * The UI modules of this package (ServerSection / SidebarRoot /
 * ArchiveManagerDialog) value-import React and the dsh client packages, so they
 * cannot be imported in a plain `node test/…` run; their WIRING is therefore
 * pinned by reading their text — the precedent is `test/plugin-kernel/panel-wiring.test.ts`
 * (comments are stripped first, so a lock can never be satisfied by a comment).
 */

import { readFileSync } from 'node:fs'

/** Read one file relative to this support directory. */
export function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

// The comment stripper and the whitespace normalizer are the repository-shared
// implementations; this module keeps its long-standing export names.
export { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/**
 * Whether the text carries CJK ideographs — used to prove a module has no
 * hardcoded Chinese copy left (comments must be stripped first).
 * @param code - comment-free source text.
 * @returns true when any CJK ideograph is present.
 */
export function hasCjk(code: string): boolean {
  return /[\u4e00-\u9fff]/u.test(code)
}
