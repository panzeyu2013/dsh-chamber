#!/usr/bin/env node
/**
 * Design 18 macOS packaged-runtime acceptance smoke.
 *
 * Usage:
 *   node runtime-mac-packaged-smoke.mjs [--app /path/to/dsh-chamber.app]
 *     [--runtime-tree /path/to/a/runtime/tree]
 *
 * Without --app the script searches packages/desktop/release/{mac,mac-arm64,
 * mac-universal}. A missing build is reported as SKIP, never PASS. An explicit
 * missing/invalid path is a usage error. The smoke requires macOS because it
 * executes the packaged Mach-O and inspects its codesign entitlements.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '../../..')
const DEFAULT_RELEASE_DIR = path.join(REPOSITORY_ROOT, 'packages', 'desktop', 'release')

function usage() {
  return 'usage: pnpm run acceptance:runtime:mac-packaged -- [--app /path/to/dsh-chamber.app] [--runtime-tree /path/to/runtime-tree]'
}

function parseArgs(argv) {
  let app = null
  let runtimeTree = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true, app, runtimeTree }
    if (argument === '--app' || argument === '--runtime-tree') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a path`)
      if (argument === '--app') app = path.resolve(value)
      else runtimeTree = path.resolve(value)
      index += 1
      continue
    }
    if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    if (app !== null) throw new Error(`unexpected positional argument: ${argument}`)
    app = path.resolve(argument)
  }
  return { help: false, app, runtimeTree }
}

function discoverApp() {
  if (!existsSync(DEFAULT_RELEASE_DIR)) return []
  const results = []
  for (const directory of readdirSync(DEFAULT_RELEASE_DIR, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^mac(?:-|$)/.test(directory.name)) continue
    const container = path.join(DEFAULT_RELEASE_DIR, directory.name)
    for (const entry of readdirSync(container, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) results.push(path.join(container, entry.name))
    }
  }
  return results.sort()
}

function assertDirectory(target, label) {
  if (!existsSync(target)) throw new Error(`${label} does not exist: ${target}`)
  if (!statSync(target).isDirectory()) throw new Error(`${label} is not a directory: ${target}`)
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    ...options,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${path.basename(file)} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function resolveExecutable(appPath) {
  const executableDir = path.join(appPath, 'Contents', 'MacOS')
  assertDirectory(executableDir, 'packaged executable directory')
  const candidates = readdirSync(executableDir)
    .map((name) => path.join(executableDir, name))
    .filter((entry) => {
      try { return statSync(entry).isFile() } catch { return false }
    })
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one packaged executable in ${executableDir}, found ${candidates.length}`)
  }
  return candidates[0]
}

function runPackagedNode(executable, args, cwd) {
  return run(executable, ['--expose-internals', ...args], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
}

function assertDisableLibraryValidation(appPath) {
  run('codesign', ['--verify', '--deep', '--strict', appPath])
  const result = run('codesign', ['-d', '--entitlements', ':-', appPath])
  const entitlementText = `${result.stdout}\n${result.stderr}`
  assert.match(
    entitlementText,
    /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/,
    'packaged app signature must enable com.apple.security.cs.disable-library-validation',
  )
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[runtime-mac-packaged] ERROR ${error.message}`)
    console.error(usage())
    process.exitCode = 2
    return
  }
  if (args.help) {
    console.log(usage())
    return
  }

  let appPath = args.app
  if (appPath !== null) {
    try {
      assertDirectory(appPath, 'explicit .app path')
      if (!appPath.endsWith('.app')) throw new Error(`explicit app path must end in .app: ${appPath}`)
    } catch (error) {
      console.error(`[runtime-mac-packaged] ERROR ${error.message}`)
      process.exitCode = 2
      return
    }
  } else {
    const discovered = discoverApp()
    if (discovered.length === 0) {
      console.log(`[runtime-mac-packaged] SKIP no packaged .app under ${DEFAULT_RELEASE_DIR}; run pnpm run dist:desktop:mac or pass --app`)
      return
    }
    if (discovered.length > 1) {
      console.error(`[runtime-mac-packaged] ERROR multiple packaged apps found; select one with --app:\n${discovered.join('\n')}`)
      process.exitCode = 2
      return
    }
    appPath = discovered[0]
  }

  if (process.platform !== 'darwin') {
    console.log(`[runtime-mac-packaged] SKIP requires macOS to execute and codesign-inspect ${appPath}`)
    return
  }

  const resourcesDir = path.join(appPath, 'Contents', 'Resources')
  const executable = resolveExecutable(appPath)
  const pnpmDir = path.join(resourcesDir, 'pnpm')
  const pnpmEntry = path.join(pnpmDir, 'bin', 'pnpm.cjs')
  const pnpmManifestPath = path.join(pnpmDir, 'package.json')
  if (!existsSync(pnpmEntry) || !existsSync(pnpmManifestPath)) {
    throw new Error(`packaged pnpm is incomplete under ${pnpmDir}`)
  }
  const pnpmManifest = JSON.parse(readFileSync(pnpmManifestPath, 'utf8'))
  const pnpmVersion = runPackagedNode(executable, [pnpmEntry, '--version'], resourcesDir).stdout.trim()
  assert.equal(pnpmVersion, pnpmManifest.version, 'packaged Electron must execute the embedded pnpm entry')

  const runtimeTree = args.runtimeTree ?? path.join(resourcesDir, 'vendor', 'dsh')
  assertDirectory(runtimeTree, 'runtime tree')
  const runtimeManifest = JSON.parse(readFileSync(path.join(runtimeTree, 'package.json'), 'utf8'))
  const dshManifestPath = path.join(runtimeTree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const dshBin = path.join(runtimeTree, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(dshManifestPath) || !existsSync(dshBin)) throw new Error(`runtime tree is incomplete: ${runtimeTree}`)
  const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'))
  assert.equal(runtimeManifest.dependencies?.['@deepseek-ai/dsh'], dshManifest.version)

  const probeDir = mkdtempSync(path.join(tmpdir(), 'dsh-packaged-koffi-'))
  const probePath = path.join(probeDir, 'probe.cjs')
  try {
    writeFileSync(probePath, [
      "const { createRequire } = require('node:module')",
      "const path = require('node:path')",
      "const runtimeTree = process.argv[2]",
      "const runtimeRequire = createRequire(path.join(runtimeTree, 'package.json'))",
      "const koffi = runtimeRequire('koffi')",
      "if (koffi === null || (typeof koffi !== 'object' && typeof koffi !== 'function')) throw new Error('koffi returned no module')",
      "console.log('koffi-loaded')",
      '',
    ].join('\n'), { mode: 0o600 })
    const koffiOutput = runPackagedNode(executable, [probePath, runtimeTree], runtimeTree).stdout.trim()
    assert.equal(koffiOutput, 'koffi-loaded', 'koffi native module must load under packaged Electron-as-node')
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }

  const dshVersion = runPackagedNode(executable, [dshBin, '--version'], runtimeTree).stdout.trim()
  assert.equal(dshVersion, dshManifest.version, 'packaged Electron must spawn the selected runtime CLI')
  assertDisableLibraryValidation(appPath)

  console.log(`[runtime-mac-packaged] PASS app=${appPath}`)
  console.log(`[runtime-mac-packaged] pnpm=${pnpmVersion} koffi=require-ok dsh=${dshVersion}`)
  console.log('[runtime-mac-packaged] codesign disable-library-validation=true')
}

main().catch((error) => {
  console.error(`[runtime-mac-packaged] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
