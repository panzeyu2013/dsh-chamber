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
