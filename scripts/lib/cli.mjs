/**
 * Shared CLI helpers for the scripts toolbox: the `sleep` / `readJson` /
 * flag-value one-liners that had 7 / 2 / several copies (P2-20 of the
 * 13-scripts audit).
 *
 * `flagValue` is the STRICT form (a missing value throws so the caller can turn
 * it into a usage error, exit 2 — scripts/README.md §分类规则 2);
 * `flagValueOr` keeps the historical "fallback" shape where a flag is optional.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Promise that resolves after `ms` milliseconds. */
export const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/** Parse a JSON file (absolute or repo-relative to the process cwd). */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Value of `--name <value>`.
 * @throws when the flag is present without a value — callers print usage + exit 2.
 */
export function flagValue(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(name + ' needs a value')
  return value
}

/** Value of `--name <value>`, or `fallback` when the flag is absent. */
export function flagValueOr(args, name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value === undefined ? fallback : value
}

/**
 * Is this module the process entry point? The repo's import-guard idiom, shared
 * so a scripts-toolbox CLI never grows its own URL comparison (2026-12).
 * @param importMetaUrl - the module's `import.meta.url`.
 * @param argv1 - the candidate entry path (defaults to `process.argv[1]`).
 * @returns true when this module is the entry point.
 */
export function isCliEntry(importMetaUrl, argv1 = process.argv[1]) {
  return argv1 !== undefined && importMetaUrl === pathToFileURL(resolve(argv1)).href
}

/**
 * Run one scripts-toolbox CLI entry point: parse the argv, print the usage block
 * on --help (exit 0), run the tool, and project any failure as
 * `[<label>] 失败：<message>` + exit 1. The two packaging entries carried this
 * epilogue verbatim (2026-12 M13 single-sourcing pass).
 *
 * The log/error/exit/argv seams exist so the epilogue itself is unit-testable.
 * @param args.label - the failure-message label (e.g. 'build-sidecar').
 * @param args.usage - the usage lines printed on --help, in order.
 * @param args.parse - argv → options; must answer { help: true } for --help.
 * @param args.run - the tool, given the parsed options.
 */
export async function runCliTool({
  label,
  usage,
  parse,
  run,
  argv = process.argv.slice(2),
  log = line => console.log(line),
  error = line => console.error(line),
  exit = code => process.exit(code),
}) {
  try {
    const options = parse(argv)
    if (options.help === true) {
      for (const line of usage) log(line)
      return exit(0)
    }
    await run(options)
  } catch (err) {
    error(`[${label}] 失败：${err instanceof Error ? err.message : String(err)}`)
    return exit(1)
  }
}
