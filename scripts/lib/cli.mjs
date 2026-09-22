/**
 * Shared CLI helpers for the scripts toolbox: the `sleep` / `readJson`
 * one-liners that had repeated copies across scripts (P2-20 of the
 * 13-scripts audit).
 */
import { readFileSync } from 'node:fs'

/** Promise that resolves after `ms` milliseconds. */
export const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/** Parse a JSON file (absolute or repo-relative to the process cwd). */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

