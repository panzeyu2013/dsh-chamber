#!/usr/bin/env node
/**
 * Hermetic Design 18 runtime-install acceptance harness.
 *
 * The only network endpoint is a loopback node:http registry. The harness
 * packs a dependency-free @deepseek-ai/dsh fixture locally, serves an
 * abbreviated packument without dist-tags.latest, redirects both metadata
 * and tarball requests, then runs the production metadata -> source binding
 * -> SRI download -> pnpm file install -> prune/smoke -> immutable publish
 * chain. It intentionally stays out of test:desktop because it exercises a
 * real pnpm child process and filesystem publish transaction.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fetchRegistryMetadata } from '../registry-metadata.ts'
import { bindRuntimeInstallResolution } from '../dsh-runtime-updater.ts'
import {
  installRuntimeVersion,
  verifyRuntimeTreeCriticalFiles,
} from '../runtime-installer.ts'

const VERSION = '9.8.7'
const OLDER_VERSION = '9.8.6'
const PACKAGE_NAME = '@deepseek-ai/dsh'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '../../..')
const PNPM_ENTRY = path.join(REPOSITORY_ROOT, 'packages', 'desktop', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

function fail(message) {
  throw new Error(message)
}

function makeOwnedTreeWritable(root) {
  if (!existsSync(root)) return
  const visit = (entryPath) => {
    const info = lstatSync(entryPath)
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      chmodSync(entryPath, info.mode | 0o700)
      for (const entry of readdirSync(entryPath)) visit(path.join(entryPath, entry))
    } else if (info.isFile()) {
      chmodSync(entryPath, info.mode | 0o600)
    }
  }
  visit(root)
}

function removeOwnedTree(root) {
  if (!existsSync(root)) return
  makeOwnedTreeWritable(root)
  rmSync(root, { recursive: true, force: true })
}

function runChecked(file, args, options = {}) {
  const result = spawnSync(file, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    fail(`${path.basename(file)} ${args[0] ?? ''} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function packFixture(root) {
  if (!existsSync(PNPM_ENTRY)) {
    fail(`embedded pnpm is missing at ${PNPM_ENTRY}; run pnpm install first`)
  }
  const fixtureDir = path.join(root, 'fixture')
  const packDir = path.join(root, 'packed')
  mkdirSync(path.join(fixtureDir, 'lib'), { recursive: true })
  mkdirSync(packDir, { recursive: true })
  writeFileSync(path.join(fixtureDir, 'package.json'), `${JSON.stringify({
    name: PACKAGE_NAME,
    version: VERSION,
    type: 'module',
    files: ['lib'],
    bin: { dsh: 'lib/bin.js' },
  }, null, 2)}\n`)
  writeFileSync(path.join(fixtureDir, 'lib', 'bin.js'), [
    '#!/usr/bin/env node',
    `if (process.argv.includes('--version')) console.log(${JSON.stringify(VERSION)})`,
    `else console.error('fixture only supports --version')`,
    '',
  ].join('\n'), { mode: 0o755 })

  runChecked(process.execPath, [PNPM_ENTRY, 'pack', '--pack-destination', packDir], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      CI: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    },
  })
  const tarballs = readdirSync(packDir).filter((entry) => entry.endsWith('.tgz'))
  assert.deepEqual(tarballs.length, 1, `fixture pack should produce exactly one tarball, got ${tarballs.join(', ')}`)
  const tarballPath = path.join(packDir, tarballs[0])
  const bytes = readFileSync(tarballPath)
  return {
    bytes,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') fail('fake registry did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

async function close(server, sockets) {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  await new Promise((resolve) => server.close(() => resolve()))
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-fake-registry-'))
  const baseDir = path.join(tempRoot, 'user-data')
  const sockets = new Set()
  let origin = ''
  let fixture
  const hits = {
    metadataRedirect: 0,
    metadata: 0,
    tarballRedirect: 0,
    tarball: 0,
    pnpmMetadata: 0,
    unexpected: [],
  }
  let abbreviatedAccept = false

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && requestUrl.pathname === '/@deepseek-ai/dsh') {
      hits.metadataRedirect += 1
      abbreviatedAccept = request.headers.accept === 'application/vnd.npm.install-v1+json'
      response.writeHead(302, { location: '/@deepseek-ai/dsh-redirect' })
      response.end()
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === '/@deepseek-ai/dsh-redirect') {
      hits.metadata += 1
      const document = {
        // Deliberately no dist-tags.latest: the parser must recommend max semver.
        versions: {
          [OLDER_VERSION]: {
            dist: {
              tarball: `${origin}/@deepseek-ai/dsh/-/dsh-${OLDER_VERSION}.tgz`,
              integrity: fixture.integrity,
            },
          },
          [VERSION]: {
            dist: {
              tarball: `${origin}/@deepseek-ai/dsh/-/dsh-${VERSION}.tgz`,
              integrity: fixture.integrity,
            },
          },
        },
      }
      const body = Buffer.from(JSON.stringify(document))
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(body.length),
      })
      response.end(body)
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === `/@deepseek-ai/dsh/-/dsh-${VERSION}.tgz`) {
      hits.tarballRedirect += 1
      response.writeHead(302, { location: `/@deepseek-ai/dsh/-/dsh-${VERSION}-final.tgz` })
      response.end()
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === `/@deepseek-ai/dsh/-/dsh-${VERSION}-final.tgz`) {
      hits.tarball += 1
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(fixture.bytes.length),
      })
      response.end(fixture.bytes)
      return
    }
    // pnpm 11 performs a best-effort self update-notifier lookup against the
    // explicitly selected registry. Keep it loopback-only and prove the
    // install does not depend on that lookup by returning a hard 404.
    if (request.method === 'GET' && requestUrl.pathname === '/pnpm') {
      hits.pnpmMetadata += 1
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"offline fixture"}')
      return
    }
    hits.unexpected.push(`${request.method ?? '?'} ${requestUrl.pathname}`)
    response.writeHead(503, { 'content-type': 'text/plain' })
    response.end('unexpected fake-registry request')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  try {
    fixture = packFixture(tempRoot)
    origin = await listen(server)
    const metadata = await fetchRegistryMetadata(PACKAGE_NAME, {
      origin,
      timeoutMs: 10_000,
    })
    assert.equal(metadata.origin, origin)
    assert.equal(metadata.latest, VERSION, 'missing latest must fall back to max semver')
    assert.deepEqual(metadata.versions, [VERSION, OLDER_VERSION])
    assert.equal(abbreviatedAccept, true, 'metadata request must use the abbreviated packument media type')

    const resolution = bindRuntimeInstallResolution(metadata, metadata.latest, origin)
    assert.equal(resolution.tarball, `${origin}/@deepseek-ai/dsh/-/dsh-${VERSION}.tgz`)
    assert.equal(resolution.integrity, fixture.integrity)

    const result = await installRuntimeVersion({
      baseDir,
      resolution,
      pnpmEntry: PNPM_ENTRY,
      timeoutMs: 120_000,
    })
    verifyRuntimeTreeCriticalFiles(result.versionTreeDir, VERSION)
    const publishedManifest = JSON.parse(readFileSync(path.join(result.versionTreeDir, 'package.json'), 'utf8'))
    assert.equal(publishedManifest.dependencies?.[PACKAGE_NAME], VERSION)
    assert.equal(publishedManifest.dsh?.registryOrigin, origin)
    assert.equal(publishedManifest.dsh?.integrity, fixture.integrity)
    assert.equal(existsSync(path.join(result.versionTreeDir, 'dsh-runtime-package.tgz')), false)

    const runtimeBin = path.join(result.versionTreeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const runtimeVersion = runChecked(process.execPath, [runtimeBin, '--version'], {
      cwd: result.versionTreeDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    }).stdout.trim()
    assert.equal(runtimeVersion, VERSION)
    assert.ok(hits.pnpmMetadata === 0 || hits.pnpmMetadata === 1, 'pnpm notifier must not retry')
    assert.deepEqual({ ...hits, pnpmMetadata: 0 }, {
      metadataRedirect: 1,
      metadata: 1,
      tarballRedirect: 1,
      tarball: 1,
      pnpmMetadata: 0,
      unexpected: [],
    })

    console.log(`[runtime-fake-registry] PASS ${PACKAGE_NAME}@${VERSION}`)
    console.log(`[runtime-fake-registry] abbreviated metadata + latest fallback + 302 + SRI + pnpm file install + publish verified`)
    console.log(`[runtime-fake-registry] loopback requests: metadata=2 tarball=2 pnpm-notifier=${hits.pnpmMetadata} unexpected=0`)
  } finally {
    await close(server, sockets)
    removeOwnedTree(tempRoot)
  }
}

main().catch((error) => {
  console.error(`[runtime-fake-registry] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
