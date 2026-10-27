/**
 * wiring-sources.ts — the App wiring frame used by the source-text locks.
 *
 * The locks assert presence/absence of policy symbols across the renderer frame. When
 * the frame was a hand-written concatenation, a newly extracted hook simply fell out of
 * it and every doesNotMatch assertion became vacuously true. This helper therefore
 * ENUMERATES the seam directory: App.tsx plus every app-hooks module, sorted. Adding a
 * hook cannot escape the frame; the caller chooses only which extra files join.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const RENDERER_SRC = new URL('../../src/', import.meta.url)

/** Every app-hooks module (the orchestration seams), file names only, sorted. */
export function appHookFiles(): string[] {
  const dir = fileURLToPath(new URL('app-hooks/', RENDERER_SRC))
  const files = readdirSync(dir).filter(name => name.endsWith('.ts')).sort()
  if (files.length === 0) throw new Error('app-hooks/ is empty: the wiring frame would lock nothing')
  return files
}

/** One renderer source file, comment-stripped (so a prose mention never satisfies a lock). */
export function readWiringSource(relative: string): string {
  return stripComments(readFileSync(fileURLToPath(new URL(relative, RENDERER_SRC)), 'utf8'))
}

/**
 * The frame: App.tsx + every app-hooks module + caller-named extras.
 * @param extra - renderer-relative paths that must join the frame (e.g. a domain module
 *   the lock was written against).
 */
export function appWiringFrame(extra: readonly string[] = []): { text: string; files: string[] } {
  const files = ['App.tsx', ...appHookFiles().map(name => 'app-hooks/' + name), ...extra]
  return { text: files.map(readWiringSource).join(String.fromCharCode(10)), files }
}
