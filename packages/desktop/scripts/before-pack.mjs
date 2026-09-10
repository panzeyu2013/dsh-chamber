#!/usr/bin/env node
/**
 * electron-builder beforePack hook: materialize the shared runtime core
 * inside the desktop's node_modules as a real directory before the
 * dependency scan (build.beforePack → this module's default export).
 *
 * Why: electron-builder's dependency pack follows pnpm workspace links on
 * macOS (symlinks) but misses them on Windows (junctions) — the packaged
 * app.asar lacked node_modules/@dsh-chamber/dsh-runtime/dist/index.js and the
 * afterPack asar assertion failed the Windows release leg (2026-09 beta.2).
 * Replacing the link with a real directory makes the pack deterministic on
 * every platform without depending on link semantics.
 *
 * The copy is scoped to the shipped artifact set (dist + package.json); src/
 * and test/ never enter the app.
 *
 * The replacement is REVERTED when this process exits — on success, on a
 * failed/interrupted pack (SIGINT/SIGTERM/SIGHUP), and also when the tree
 * arrived already materialized (a previous pack that was SIGKILLed cannot run
 * handlers, so the next pack heals it). Without that restore the working tree
 * keeps a dist-only directory where pnpm had a workspace link, so the shared
 * runtime loses its type surface and the NEXT build/typecheck fails with
 * `TS7016 … implicitly has an 'any' type`; neither `pnpm install
 * --frozen-lockfile` nor a rerun repairs it, because pnpm already sees the path
 * as satisfied (observed in the 2026-09 acceptance round: a pack that timed out
 * mid-artifact left exactly that state behind).
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SOURCE_DIR = resolve(desktopDir, '..', 'dsh-runtime')
const DEFAULT_TARGET_DIR = join(desktopDir, 'node_modules', '@dsh-chamber', 'dsh-runtime')

/** `lstat` that tolerates a missing path (and does NOT follow links, so a
 *  dangling link is still reported as a link). */
function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch {
    return null
  }
}

/**
 * Replace the workspace link (or refresh an earlier materialization) with a
 * real dist-only directory.
 * @param root0 - materialize inputs.
 * @param root0.sourceDir - workspace package to copy from.
 * @param root0.targetDir - node_modules path electron-builder must see.
 * @param root0.log - sink for the one-line progress note.
 * @returns what happened, so callers (and tests) can assert it.
 */
export function materializeRuntimeCore({
  sourceDir = DEFAULT_SOURCE_DIR,
  targetDir = DEFAULT_TARGET_DIR,
  log = console.log,
} = {}) {
  if (!existsSync(sourceDir) || !existsSync(join(sourceDir, 'dist', 'index.js'))) {
    throw new Error(`before-pack: dsh-runtime source missing at ${sourceDir} — run build:dsh-runtime first`)
  }
  const before = lstatOrNull(targetDir)
  const linkTarget = before?.isSymbolicLink() ? readlinkSync(targetDir) : null
  // Always rebuild from scratch: a refreshed tree must not keep files the
  // current build no longer produces (the pack ships whatever is here).
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  cpSync(join(sourceDir, 'package.json'), join(targetDir, 'package.json'))
  mkdirSync(join(targetDir, 'dist'), { recursive: true })
  cpSync(join(sourceDir, 'dist'), join(targetDir, 'dist'), { recursive: true })
  log(`[before-pack] materialized @dsh-chamber/dsh-runtime (${linkTarget === null ? 'refreshed' : 'link replaced'}) -> ${targetDir}`)
  return { replacedLink: linkTarget !== null, linkTarget }
}

/**
 * Put back the workspace link pnpm had at `targetDir`.
 * @param root0 - restore inputs.
 * @param root0.targetDir - the materialized directory to replace.
 * @param root0.sourceDir - workspace package the link must resolve to.
 * @param root0.linkTarget - the exact link text observed before materializing
 *   (pnpm writes a relative link); recomputed when absent.
 * @returns whether a link was (re)created, plus the reason when it was not.
 */
export function restoreRuntimeCoreLink({
  targetDir = DEFAULT_TARGET_DIR,
  sourceDir = DEFAULT_SOURCE_DIR,
  linkTarget = null,
} = {}) {
  if (lstatOrNull(targetDir)?.isSymbolicLink()) {
    return { restored: false, reason: 'already a workspace link' }
  }
  if (!existsSync(sourceDir)) {
    // Never create a dangling link: without the workspace package there is
    // nothing to point at, so leave the tree as the pack left it.
    return { restored: false, reason: `workspace package missing at ${sourceDir}` }
  }
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  symlinkSync(linkTarget ?? relative(dirname(targetDir), sourceDir), targetDir, 'junction')
  return { restored: true }
}

/** Restore bookkeeping: the hook registers once per process and keeps the
 *  exact link text the first materialization replaced (pnpm writes a relative
 *  link; reusing it is faithful even if that shape changes). */
let restoreState = null
let restoreRegistered = false

function restoreLink(log = console.log, errorLog = console.error) {
  try {
    const result = restoreRuntimeCoreLink(restoreState ?? {})
    if (result.restored) log(`[before-pack] restored the workspace link -> ${DEFAULT_TARGET_DIR}`)
    else if (result.reason !== 'already a workspace link') errorLog(`[before-pack] workspace link not restored: ${result.reason}`)
  } catch (error) {
    errorLog(`[before-pack] failed to restore the workspace link: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param log - sink for the restore note. */
export function registerExitRestore(log = console.log) {
  if (restoreRegistered) return { registered: false }
  restoreRegistered = true
  // electron-builder keeps running in THIS process, so one exit hook covers the
  // failed/interrupted pack.
  process.once('exit', () => restoreLink(log))
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => {
      restoreLink(log)
      process.exit(code)
    })
  }
  return { registered: true }
}

export default async function beforePack() {
  const state = materializeRuntimeCore()
  restoreState ??= { linkTarget: state.linkTarget }
  restoreState.linkTarget ??= state.linkTarget
  // Registered even when the tree already arrived materialized: that is how a
  // SIGKILLed pack (whose handlers cannot run) is healed by the next one.
  registerExitRestore()
}
