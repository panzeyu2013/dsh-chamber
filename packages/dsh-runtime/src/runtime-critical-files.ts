/**
 * Design 18 install-format critical files (design 18 §4 publish format).
 *
 * Single owner of the version-tree relative-path list whose byte digests the
 * runtime store (validateVersionTree, read side) and the runtime installer
 * (publish-side digest computation + verifyRuntimeTreeCriticalFiles, write
 * side) both enforce, so the two ends of the format can never drift apart.
 * The helpers below are deliberately free of user-visible messages: each
 * caller maps the deterministic outcomes onto its own error surface.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/** Exact relative paths inside a version tree whose integrity the manifest's
 *  digest record covers. */
export const CRITICAL_RUNTIME_FILES = [
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
] as const

export type CriticalRuntimeFile = typeof CRITICAL_RUNTIME_FILES[number]

/** Digest wire shape: `sha256-` + standard base64 (43 chars + trailing `=`). */
export const CRITICAL_FILE_DIGEST_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/

export type CriticalFileOpenResult =
  | { kind: 'file'; path: string }
  | { kind: 'not-regular-file' }
  | { kind: 'escapes-tree' }

/** No-follow regularity + realpath containment check against the already
 *  resolved tree root. Deterministic negatives are returned; IO failures
 *  throw, so each caller's existing catch boundary decides how they surface.
 *  Mirrors the read/write sides' shared escape predicate
 *  (`..` + platform separator + absolute). */
export function openCriticalRuntimeFile(rootReal: string, candidate: string): CriticalFileOpenResult {
  const info = lstatSync(candidate)
  if (!info.isFile() || info.isSymbolicLink()) return { kind: 'not-regular-file' }
  const fileReal = realpathSync(candidate)
  const fromRoot = relative(rootReal, fileReal)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    return { kind: 'escapes-tree' }
  }
  return { kind: 'file', path: candidate }
}

/** `sha256-<base64>` digest of a file's bytes. Containment/regularity checks
 *  are the caller's responsibility (see openCriticalRuntimeFile). */
export function sha256FileDigest(filePath: string): string {
  return `sha256-${createHash('sha256').update(readFileSync(filePath)).digest('base64')}`
}
