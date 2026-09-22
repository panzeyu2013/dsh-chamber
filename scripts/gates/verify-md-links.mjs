/**
 * Documentation link gate: every relative Markdown link in the tracked
 * documentation set must resolve — the target file must exist, and a `#fragment`
 * onto a Markdown target must name a real heading slug or an explicit anchor.
 *
 * Why it exists: the repository moves files between `docs/design`,
 * `docs/checklists` and `docs/progress` often enough that a link left behind is
 * a silent loss — the reader follows a path that no longer exists and nothing
 * turns red. Two frozen upstream mirrors stay outside the checked set by design
 * (see {@link MIRRORED_DOCUMENTS}); the skip is printed on every run.
 *
 * Usage:
 *   node scripts/gates/verify-md-links.mjs           # gate (exit 1 on a dead link)
 *   node scripts/gates/verify-md-links.mjs --list    # report, never fails
 */

import { existsSync, readFileSync } from 'node:fs'

import { walkFiles } from '../lib/walk.mjs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Documentation roots scanned for relative links. */
export const LINK_SCAN_ROOTS = ['docs', 'packages']

/** Standalone Markdown files at the repository root that are scanned too. */
export const LINK_SCAN_FILES = ['AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'CHANGELOG.md']

/**
 * Directory names never descended into. Besides build output and VCS metadata
 * this includes LOCAL RUNTIME STATE that happens to live under the scan roots:
 * `packages/desktop/.dev-user-data` is a dev instance's own user-data (gitignored
 * by design, `.gitignore`), and its seeded harness notes carry upstream-relative
 * links by construction — scanning it turns any developer's local dev run into
 * hundreds of dead-link reports that CI (which has no such directory) never sees.
 */
// ONE ignore set + one walk for every gate that scans the repository
// (scripts/lib/walk.mjs).
export { IGNORED_DIRECTORIES } from '../lib/walk.mjs'

/**
 * Documents excluded from link checking because their contents are frozen
 * mirrors of upstream files: their internal links are upstream-relative by
 * construction, and C1 (`docs/checklists/upstream-touchpoints.md` §2.1, `pure`)
 * hard-fails if their bytes change. Editing them to satisfy this gate is not an
 * option; the exclusion is printed on every run so it stays visible.
 * @type {ReadonlyMap<string, string>}
 */
export const MIRRORED_DOCUMENTS = new Map([
  ['packages/dsh-client-connection/README.md', 'upstream-pure mirror (C1): links are upstream-relative'],
  ['packages/dsh-client-connection/README.zh.md', 'upstream-pure mirror (C1): links are upstream-relative'],
])

/** Link targets that are never filesystem paths. */
const EXTERNAL_PREFIXES = ['http://', 'https://', 'mailto:', 'data:', 'tel:', 'vscode:', 'ssh:']

/**
 * Markdown links and images: `[text](target)` / `![alt](target)`.
 * Angle-bracket targets and single-quoted titles are tolerated.
 */
export const LINK_PATTERN = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*["')])?\s*\)/gu

/**
 * Strip the inline Markdown that changes a heading's GitHub slug.
 * @param {string} text - raw heading text.
 * @returns {string} text with inline markup removed.
 */
export function stripInlineMarkup(text) {
  return text
    .replace(/<a\s+[^>]*><\/a>/giu, '')
    .replace(/<[^>]+>/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/\*\*([^*]*)\*\*/gu, '$1')
    .replace(/\*([^*]*)\*/gu, '$1')
    .replace(/__([^_]*)__/gu, '$1')
    .replace(/_([^_]*)_/gu, '$1')
}

/**
 * Compute a GitHub-compatible heading slug.
 * @param {string} heading - raw heading text.
 * @returns {string} slug without the duplicate suffix.
 */
export function slugify(heading) {
  const stripped = stripInlineMarkup(heading)
    .trim()
    .toLowerCase()
    .replace(/[{}]/gu, '')
  const kept = []
  for (const character of stripped) {
    if (/[\p{L}\p{N}\s_-]/u.test(character)) kept.push(character)
  }
  return kept.join('').trim().replace(/\s+/gu, '-')
}

/**
 * Collect every anchor a Markdown document exposes: heading slugs (with GitHub
 * duplicate suffixes) and explicit `<a id|name>` targets.
 * @param {string} source - document text.
 * @returns {Set<string>} anchors without the leading `#`.
 */
export function collectAnchors(source) {
  const anchors = new Set()
  const seen = new Map()
  let fenced = false
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const match of line.matchAll(/<a\s+[^>]*(?:id|name)="([^"]+)"/giu)) anchors.add(match[1])
    for (const match of line.matchAll(/\{#([^}]+)\}/gu)) anchors.add(match[1])
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading === null) continue
    const custom = /\{#([^}]+)\}\s*$/u.exec(heading[2])
    if (custom !== null) {
      anchors.add(custom[1])
      continue
    }
    const base = slugify(heading[2])
    if (base === '') continue
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}

/**
 * Walk a directory for Markdown files (shared walk: scripts/lib/walk.mjs).
 * @param {string} root - absolute directory.
 * @returns {string[]} absolute paths.
 */
function walkMarkdown(root) {
  return walkFiles(root, path => path.toLowerCase().endsWith('.md'))
}

/**
 * Collect the documentation set the gate covers.
 * @param {string} repoRoot - repository root.
 * @returns {{ documents: string[], mirrored: string[] }} absolute Markdown paths.
 */
export function collectDocuments(repoRoot) {
  const documents = []
  for (const scanRoot of LINK_SCAN_ROOTS) {
    const absolute = join(repoRoot, scanRoot)
    if (existsSync(absolute)) documents.push(...walkMarkdown(absolute))
  }
  for (const name of LINK_SCAN_FILES) {
    const absolute = join(repoRoot, name)
    if (existsSync(absolute)) documents.push(absolute)
  }
  const unique = [...new Set(documents)].sort()
  const mirrored = []
  const checked = []
  for (const document of unique) {
    const relativePath = relative(repoRoot, document).split(sep).join('/')
    if (MIRRORED_DOCUMENTS.has(relativePath)) mirrored.push(relativePath)
    else checked.push(document)
  }
  return { documents: checked, mirrored }
}

/**
 * Decide whether one link target resolves.
 * @param {object} input - resolution inputs.
 * @param {string} input.sourceFile - absolute path of the linking document.
 * @param {string} input.rawTarget - link target as written.
 * @param {Map<string, Set<string>>} input.anchorCache - memoized anchor sets.
 * @returns {string | null} failure reason, or null when the link resolves.
 */
export function linkFailure({ sourceFile, rawTarget, anchorCache }) {
  const target = rawTarget.trim().replace(/^<|>$/gu, '')
  if (target === '' || target.startsWith('#')) return null
  if (EXTERNAL_PREFIXES.some(prefix => target.toLowerCase().startsWith(prefix))) return null
  if (target.includes('{') || target.includes('}')) return null
  const hashIndex = target.indexOf('#')
  const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? '' : target.slice(hashIndex + 1)
  let decodedPath
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    decodedPath = rawPath
  }
  const absoluteTarget = resolve(dirname(sourceFile), decodedPath)
  if (decodedPath !== '' && !existsSync(absoluteTarget)) return `target does not exist: ${decodedPath}`
  if (fragment === '' || !decodedPath.toLowerCase().endsWith('.md')) return null
  let anchors = anchorCache.get(absoluteTarget)
  if (anchors === undefined) {
    anchors = collectAnchors(readFileSync(absoluteTarget, 'utf8'))
    anchorCache.set(absoluteTarget, anchors)
  }
  let decodedFragment
  try {
    decodedFragment = decodeURIComponent(fragment)
  } catch {
    decodedFragment = fragment
  }
  if (anchors.has(decodedFragment)) return null
  if (decodedFragment.toLowerCase() !== decodedFragment && anchors.has(decodedFragment.toLowerCase())) return null
  return `anchor not found: #${fragment}`
}

/**
 * Collect every dead link in the documentation set.
 * @param {string} repoRoot - repository root.
 * @returns {{ documents: number, links: number, failures: { file: string, line: number, target: string, reason: string }[] }} report.
 */
export function collectLinkFailures(repoRoot) {
  const anchorCache = new Map()
  const failures = []
  let links = 0
  const { documents, mirrored } = collectDocuments(repoRoot)
  for (const document of documents) {
    const lines = readFileSync(document, 'utf8').split(/\r?\n/u)
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(LINK_PATTERN)) {
        links += 1
        const reason = linkFailure({ sourceFile: document, rawTarget: match[1], anchorCache })
        if (reason !== null) {
          failures.push({
            file: relative(repoRoot, document).split(sep).join('/'),
            line: index + 1,
            target: match[1],
            reason,
          })
        }
      }
    }
  }
  return { documents: documents.length, links, failures, mirrored }
}

function main() {
  const listOnly = process.argv.includes('--list')
  const { documents, links, failures, mirrored } = collectLinkFailures(REPO_ROOT)
  if (mirrored.length > 0) {
    console.log(`markdown links: ${mirrored.length} frozen upstream mirror(s) skipped by design:`)
    for (const file of mirrored) console.log(`  - ${file} — ${MIRRORED_DOCUMENTS.get(file)}`)
  }
  if (documents === 0) {
    console.error('markdown links: no documents found — a gate that scans nothing has not passed')
    process.exit(1)
  }
  if (failures.length > 0) {
    const report = failures.map(failure => `  - ${failure.file}:${String(failure.line)} → ${failure.target} (${failure.reason})`)
    if (listOnly) {
      console.log(`markdown links: ${documents} document(s), ${links} link(s), ${failures.length} dead`)
      console.log(report.join('\n'))
      return
    }
    console.error(`markdown links: ${failures.length} dead link(s) across ${documents} document(s):`)
    console.error(report.join('\n'))
    process.exit(1)
  }
  console.log(`markdown links: ${documents} document(s), ${links} relative link(s), all resolve`)
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) main()
