/**
 * Build-level smoke test (design 17 §9.4 regression): the gateway esbuild
 * bundle must carry the createRequire banner and import without the
 * "Dynamic require of 'events' is not supported" failure that previously
 * wedged the derived session index / approval streams (live finding, Linux +
 * macOS — ws's static `require('events')` inside its __commonJS wrapper).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const distIndex = join(packageDir, 'dist', 'index.js')

test('gateway dist bundle carries the createRequire banner and imports without a Dynamic require error', async () => {
  // dist/ is gitignored: build on demand so the smoke test works from a
  // clean checkout (the build is a fast esbuild step).
  if (!existsSync(distIndex)) {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: packageDir, stdio: 'ignore' })
  }
  const source = await readFile(distIndex, 'utf8')
  // The banner (scripts/build.mjs) installs a module-scoped require shim so
  // the bundled CJS deps' static requires resolve node builtins normally.
  assert.match(source, /import \{ createRequire \} from 'node:module';/, 'the createRequire banner import is present')
  assert.match(source, /const require = createRequire\(import\.meta\.url\);/, 'the banner require shim is installed')
  // ws's `require("events")` must sit inside its __commonJS wrapper (the
  // transport of the session index and approval streams).
  const eventsRequire = source.indexOf('__require("events")')
  assert.ok(eventsRequire !== -1, 'ws requires node:events inside its commonjs wrapper')
  assert.ok(source.slice(Math.max(0, eventsRequire - 500), eventsRequire).includes('ws/lib/websocket.js'),
    'the events require belongs to the ws websocket module')
  // And the bundle must import cleanly (no "Dynamic require") and expose the
  // public API surface the control plane consumes.
  const module = await import(pathToFileURL(distIndex).href)
  assert.equal(typeof module.createGateway, 'function')
  assert.equal(typeof module.createScheduler, 'function')
})
