#!/usr/bin/env node
/**
 * Materialize the shared runtime core inside the desktop's node_modules before
 * electron-builder scans dependencies (build.beforePack).
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
 */
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = resolve(desktopDir, '..', 'dsh-runtime')
const targetDir = join(desktopDir, 'node_modules', '@dsh-chamber', 'dsh-runtime')

if (!existsSync(sourceDir) || !existsSync(join(sourceDir, 'dist', 'index.js'))) {
  throw new Error(`before-pack: dsh-runtime source missing at ${sourceDir} — run build:dsh-runtime first`)
}

const isLink = existsSync(targetDir) && (lstatSync(targetDir).isSymbolicLink() || !lstatSync(targetDir).isDirectory())
if (isLink) {
  rmSync(targetDir, { recursive: true, force: true })
}
mkdirSync(targetDir, { recursive: true })
cpSync(join(sourceDir, 'package.json'), join(targetDir, 'package.json'))
mkdirSync(join(targetDir, 'dist'), { recursive: true })
cpSync(join(sourceDir, 'dist'), join(targetDir, 'dist'), { recursive: true })
console.log(`[before-pack] materialized @dsh-chamber/dsh-runtime (${isLink ? 'link replaced' : 'refreshed'}) -> ${targetDir}`)
