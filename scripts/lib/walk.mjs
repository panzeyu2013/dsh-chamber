/**
 * Repository file walking — ONE walk for the gates that scan the repository
 * (verify-test-wiring.mjs, verify-md-links.mjs, run-script-tests.mjs).
 *
 * IGNORED_DIRECTORIES names directories that never hold sources: build output, VCS metadata,
 * dependency trees and local dev runtime state. Two names are deliberately NOT
 * in it: 'lib' (scripts/lib/ and package lib/ trees are real source/content —
 * ignoring the name would hide scripts/lib/test-manifest.test.mjs from the script-test
 * manifest check) and any other directory that can legitimately hold sources. A
 * caller whose scan root
 * legitimately contains a directory named like one of those (scripts/release/ is
 * a real source directory, while 'release' is electron-builder output elsewhere)
 * passes its own `ignoredDirs` set instead — see SCRIPT_TEST_IGNORED_DIRECTORIES
 * in run-script-tests.mjs: applying the union there would silently drop every
 * scripts/release/** test (locked by run-script-tests.test.mjs).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'release',
  '.git',
  '.desktop-build',
  'coverage',
  '.dev-user-data',
])

/**
 * Absolute paths of every file under `root` matching `predicate`, skipping the
 * ignore set, sorted.
 * @param {string} root - absolute directory to walk.
 * @param {(path: string) => boolean} predicate - receives absolute file paths.
 * @param {{ ignoredDirs?: Iterable<string>, extraIgnored?: string[] }} [options] - the
 *   ignore set (default: the repo-wide union) plus caller additions.
 * @returns {string[]} sorted absolute paths.
 */
export function walkFiles(root, predicate, { ignoredDirs = IGNORED_DIRECTORIES, extraIgnored = [] } = {}) {
  const ignored = new Set([...ignoredDirs, ...extraIgnored])
  const found = []
  const visit = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue
        visit(path)
        continue
      }
      if (entry.isFile() && predicate(path)) found.push(path)
    }
  }
  visit(root)
  return found.sort()
}

