/**
 * CI change classifier (2026-09).
 *
 * The push path runs an expensive chain (install → type checks → every unit
 * suite → builds → gateway pack). A change that touches nothing but prose
 * cannot break any of it, so this classifier decides whether that chain runs at
 * all. The cheap, file-only gates (workflow action pins, i18n pairs, design
 * tokens, upstream-touchpoint registry, release-workflow policy, the tooling
 * unit tests) are NOT classified: they run on every event, so a prose change
 * still gets the gates that can actually see it (i18n drift lives in prose).
 *
 * Direction of the decision is deliberate: the allowlist below names what is
 * *prose*, and everything else — every unknown path, every path outside the
 * allowlist, an empty or unreadable diff — counts as CODE. A classifier bug can
 * therefore waste runner minutes, never skip a gate. Widening the allowlist
 * skips gates, so the release-workflow policy test freezes it: adding a prefix
 * there requires editing that test on purpose.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { argv, env } from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Path prefixes that cannot affect the build/test chain. Keep this list short
 * and literal; `docs/**` is prose, and the checked-in i18n hash record lives
 * under it (its gate is always-run).
 */
export const PROSE_ONLY_PREFIXES = ['docs/']

/** Root-level files that are prose too (matched exactly, not by prefix). */
export const PROSE_ONLY_FILES = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
]

/** Normalize a path for matching: strip a leading `./`, nothing else. */
function normalize(file) {
  return file.replace(/^\.\//, '')
}

function isProse(path) {
  const file = normalize(path)
  // A path that escapes upward is never trusted as prose.
  if (file.split('/').includes('..')) return false
  if (file === '' || file.endsWith('/')) return false
  if (PROSE_ONLY_FILES.includes(file)) return true
  return PROSE_ONLY_PREFIXES.some(prefix => file.startsWith(prefix) && file.length > prefix.length)
}

/**
 * @param {string[]|undefined|null} paths changed file paths (repo-relative)
 * @returns {{code: boolean, reason: string, prose: string[], codePaths: string[]}}
 *   `code: true` means the expensive chain must run.
 */
export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { code: true, reason: 'no changed-path list available — fail-safe: run the full chain', prose: [], codePaths: [] }
  }
  const prose = []
  const codePaths = []
  for (const path of paths) {
    if (typeof path === 'string' && isProse(path)) prose.push(normalize(path))
    else codePaths.push(String(path))
  }
  if (codePaths.length === 0) {
    return { code: false, reason: `prose-only change (${prose.length} file(s), all inside the prose allowlist)`, prose, codePaths }
  }
  const shown = codePaths.slice(0, 3).join(', ')
  return {
    code: true,
    reason: `code change: ${shown}${codePaths.length > 3 ? ` (+${codePaths.length - 3} more)` : ''}`,
    prose,
    codePaths,
  }
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' })
}

/**
 * Read the changed paths for this event. `push` compares the pushed range (a
 * zero/unknown `before` — force push, new branch, tag — is not a diff we can
 * trust, so it fails safe); `pull_request` compares against the base commit.
 * Any git failure fails safe as well.
 */
export function changedPathsForEvent({ eventName, before, after, baseSha }, run = git) {
  const range = (() => {
    if (eventName === 'pull_request') {
      if (!baseSha || !after) return null
      return [baseSha, after]
    }
    if (!before || /^0+$/.test(before)) return null
    if (!after) return null
    return [before, after]
  })()
  if (range === null) return { paths: null, note: 'no trustworthy diff range for this event' }
  const result = run(['diff', '--name-only', ...range])
  if (result.status !== 0) return { paths: null, note: `git diff failed: ${String(result.stderr ?? '').trim().slice(0, 200)}` }
  return {
    paths: String(result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean),
    note: `${range[0].slice(0, 8)}..${range[1].slice(0, 8)}`,
  }
}

function flag(args, name) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function main() {
  const args = argv.slice(2)
  const inlinePaths = flag(args, 'paths')

  let classification
  let note = 'inline path list'
  if (inlinePaths !== undefined) {
    classification = classifyChangedPaths(inlinePaths.split(',').map(part => part.trim()).filter(Boolean))
  } else {
    const diff = changedPathsForEvent({
      eventName: flag(args, 'event') ?? env.GITHUB_EVENT_NAME ?? '',
      before: flag(args, 'before') ?? env.CI_BEFORE ?? '',
      after: flag(args, 'after') ?? env.CI_AFTER ?? env.GITHUB_SHA ?? '',
      baseSha: flag(args, 'base-sha') ?? env.CI_BASE_SHA ?? '',
    })
    note = diff.note
    classification = classifyChangedPaths(diff.paths)
  }

  console.log(`ci change classifier: code=${classification.code} (${classification.reason}) [${note}]`)
  const list = (label, entries) => {
    if (entries.length === 0) return
    console.log(`  ${label}: ${entries.slice(0, 8).join(', ')}${entries.length > 8 ? ` (+${entries.length - 8})` : ''}`)
  }
  list('prose', classification.prose)
  list('code', classification.codePaths)

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `code=${classification.code}\nreason=${classification.reason}\n`)
  }
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) main()
