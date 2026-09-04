import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  RuntimeInstallerSupervisor,
  disposeRuntimeInstaller,
  downloadVerifiedRegistryTarball,
  installRuntimeVersion,
  pruneRuntimeStore,
  scrubInstallEnv,
  verifyRuntimeTreeCriticalFiles,
} from '../src/runtime-installer.ts'
import type { InstallerDeps, RunOptions, RunResult } from '../src/runtime-installer.ts'
import type { RuntimeInstallResolution } from '../src/dsh-runtime-updater.ts'
import { markStorePruneNeeded } from '../src/dsh-runtime-store.ts'

const VERSION = '0.1.1-rc.2'
const TARBALL = Buffer.from('controlled top-level dsh tarball fixture')
const VALID_SRI = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`

/** Bounded wait for pid to be reaped (kill(pid, 0) → ESRCH); zombie reaping
 * is async, so a single-shot ESRCH assertion flaked under CI pauses. */
async function waitForEsrch(pid: number, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`${what} (pid ${pid}) still alive after the reaping window`)
}

function makeBaseDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-rt-installer-'))
}

type BufferWrite = (
  this: FileHandle,
  buffer: Uint8Array,
  offset?: number | null,
  length?: number | null,
  position?: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>

async function withPatchedFileHandleWrite<T>(
  replace: (original: BufferWrite) => BufferWrite,
  run: () => Promise<T>,
): Promise<T> {
  const probe = await open(path.join(makeBaseDir(), 'write-prototype-probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(probe) as { write: FileHandle['write'] }
  await probe.close()
  const original = prototype.write
  prototype.write = replace(original as BufferWrite) as FileHandle['write']
  try {
    return await run()
  } finally {
    prototype.write = original
  }
}

function makeExistingTree(baseDir: string, version: string, valid: boolean): string {
  const tree = path.join(baseDir, 'dsh-runtime', version)
  mkdirSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(path.join(tree, 'sentinel.txt'), 'previous tree')
  writeFileSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// previous')
  writeFileSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version,
  }))
  const criticalFiles = Object.fromEntries([
    'node_modules/@deepseek-ai/dsh/package.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].map(relativePath => [
    relativePath,
    `sha256-${createHash('sha256').update(readFileSync(path.join(tree, relativePath))).digest('base64')}`,
  ]))
  writeFileSync(path.join(tree, 'package.json'), JSON.stringify(valid ? {
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform: `${process.platform}-${process.arch}`, criticalFiles },
  } : { dependencies: {} }))
  return tree
}

function resolution(overrides: Partial<RuntimeInstallResolution> = {}): RuntimeInstallResolution {
  return {
    packageName: '@deepseek-ai/dsh',
    version: VERSION,
    registryOrigin: 'https://registry.npmjs.org',
    tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${VERSION}.tgz`,
    integrity: VALID_SRI,
    ...overrides,
  }
}

const nodeFn = () => ({ file: '/fake/node', args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } })
const downloadOk: InstallerDeps['download'] = async (_resolution, destination) => {
  writeFileSync(destination, TARBALL)
}
const pruneOk = async () => ({ removedFiles: 0, removedDirs: 0 })
const smokeOk: InstallerDeps['smoke'] = async (workDir, version) => {
  const packageDir = path.join(workDir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  writeFileSync(path.join(packageDir, 'lib', 'bin.js'), `console.log(${JSON.stringify(version)})\n`)
}

function depsWithRun(run: InstallerDeps['run']): Partial<InstallerDeps> {
  return { node: nodeFn, run, download: downloadOk, prune: pruneOk, smoke: smokeOk }
}

function okRun(capture: { args: string[][]; opts: RunOptions[] }): InstallerDeps['run'] {
  return async (args, opts) => {
    capture.args.push(args)
    capture.opts.push(opts)
    return { status: 0, stdout: '', stderr: '' }
  }
}

test('installRuntimeVersion: consumes a bound local tarball and pins the registry command', async () => {
  const baseDir = makeBaseDir()
  const capture = { args: [] as string[][], opts: [] as RunOptions[] }
  let downloaded: RuntimeInstallResolution | null = null
  let dependencyAtInstall: string | null = null
  const run: InstallerDeps['run'] = async (args, opts) => {
    capture.args.push(args)
    capture.opts.push(opts)
    dependencyAtInstall = JSON.parse(readFileSync(path.join(opts.cwd, 'package.json'), 'utf8'))
      .dependencies['@deepseek-ai/dsh']
    return { status: 0, stdout: '', stderr: '' }
  }
  await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(run),
      download: async (bound, destination) => {
        downloaded = bound
        writeFileSync(destination, TARBALL)
      },
    },
  })

  assert.deepEqual(downloaded, resolution())
  assert.equal(dependencyAtInstall, 'file:./dsh-runtime-package.tgz')
  assert.deepEqual(capture.args[0], [
    '/fake/node', '--expose-internals', '/pnpm/bin/pnpm.cjs', 'install',
    '--config.node-linker=hoisted',
    '--store-dir', path.join(baseDir, 'dsh-runtime', '.pnpm-store'),
    '--cache-dir', path.join(baseDir, 'dsh-runtime', '.pnpm-cache'),
    '--registry', 'https://registry.npmjs.org',
    '--fetch-retries=0',
  ])
  assert.equal(capture.opts[0]!.env!.NPM_CONFIG_USERCONFIG, path.join(baseDir, 'dsh-runtime', '.npmrc'))
  assert.equal(capture.opts[0]!.env!.HOME, path.join(baseDir, 'dsh-runtime', '.install-home'))
  assert.equal(capture.opts[0]!.env!.XDG_CACHE_HOME, path.join(baseDir, 'dsh-runtime', '.xdg-cache'))
})

test('installRuntimeVersion: writes allowBuilds before pnpm and publishes no tarball/PID residue', async () => {
  const baseDir = makeBaseDir()
  let pidDuringRun: string | null = null
  const run: InstallerDeps['run'] = async (_args, opts) => {
    opts.onSpawn?.(424242)
    pidDuringRun = readFileSync(path.join(opts.cwd, 'pid'), 'utf8')
    const yaml = readFileSync(path.join(opts.cwd, 'pnpm-workspace.yaml'), 'utf8')
    for (const name of ['node-pty', 'koffi', 'protobufjs', '@google/genai', '@deepseek-ai/dsh-subprocess-local']) {
      assert.ok(yaml.includes(`${JSON.stringify(name)}: true`), `allowBuilds ${name} must be true`)
    }
    assert.doesNotMatch(yaml, /: false/)
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(run),
  })
  assert.equal(pidDuringRun, '424242', 'work marker records the actual child pid reported by run')
  assert.equal(existsSync(path.join(result.versionTreeDir, 'pid')), false)
  assert.equal(existsSync(path.join(result.versionTreeDir, 'dsh-runtime-package.tgz')), false)
})

test('installRuntimeVersion: rejects unsafe/unbound resolution before download', async () => {
  const baseDir = makeBaseDir()
  let downloads = 0
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution({ version: '../0.1.1' }),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
      download: async () => { downloads += 1 },
    },
  }))
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution({ integrity: 'sha512-invalid' }),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
  }), /integrity/)
  assert.equal(downloads, 0)
})

test('installRuntimeVersion: retries a nonzero install once, then succeeds', async () => {
  const baseDir = makeBaseDir()
  let calls = 0
  const run = async (): Promise<RunResult> => {
    calls += 1
    return calls === 1
      ? { status: 1, stdout: '', stderr: 'transient koffi fetch fail' }
      : { status: 0, stdout: '', stderr: '' }
  }
  const result = await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(run),
  })
  assert.equal(calls, 2)
  assert.equal(result.resolvedVersion, VERSION)
})

test('installRuntimeVersion: retry failure and smoke failure remain loud', async () => {
  const baseDir = makeBaseDir()
  const failedRun = async (): Promise<RunResult> => ({
    status: 1,
    stdout: '',
    stderr: 'ERR_PNPM_IGNORED_BUILDS /abs/path',
  })
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(failedRun),
  }), /dsh runtime install failed/)

  await assert.rejects(installRuntimeVersion({
    baseDir: makeBaseDir(),
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
      smoke: async () => { throw new Error('dsh smoke check failed') },
    },
  }), /dsh smoke check failed/)
})

test('installRuntimeVersion: success publishes exact version/source manifest atomically', async () => {
  const baseDir = makeBaseDir()
  const result = await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(okRun({ args: [], opts: [] })),
  })
  const tree = path.join(baseDir, 'dsh-runtime', VERSION)
  assert.equal(result.versionTreeDir, tree)
  const manifest = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { '@deepseek-ai/dsh': VERSION })
  assert.match(manifest.dsh.platform, /-/)
  assert.equal(manifest.dsh.registryOrigin, 'https://registry.npmjs.org')
  assert.equal(manifest.dsh.integrity, VALID_SRI)
  assert.deepEqual(Object.keys(manifest.dsh.criticalFiles).sort(), [
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/@deepseek-ai/dsh/package.json',
  ])
  for (const [relativePath, digest] of Object.entries(manifest.dsh.criticalFiles as Record<string, string>)) {
    const actual = `sha256-${createHash('sha256').update(readFileSync(path.join(tree, relativePath))).digest('base64')}`
    assert.equal(digest, actual)
  }
})

test('installRuntimeVersion: refuses to overwrite or reuse an already-valid tree before download', async () => {
  const baseDir = makeBaseDir()
  const tree = makeExistingTree(baseDir, VERSION, true)
  let downloads = 0
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
      download: async () => { downloads += 1 },
    },
  }), /already installed and valid/)
  assert.equal(downloads, 0)
  assert.equal(readFileSync(path.join(tree, 'sentinel.txt'), 'utf8'), 'previous tree')
  assert.equal(existsSync(path.join(baseDir, 'dsh-runtime', `${VERSION}.failed`)), false)
})

test('installRuntimeVersion: safely replaces a legacy tree without critical-file digests', async () => {
  const baseDir = makeBaseDir()
  const tree = makeExistingTree(baseDir, VERSION, true)
  const legacy = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8'))
  delete legacy.dsh.criticalFiles
  writeFileSync(path.join(tree, 'package.json'), JSON.stringify(legacy))
  const result = await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
  })
  assert.equal(result.versionTreeDir, tree)
  assert.equal(existsSync(path.join(tree, 'sentinel.txt')), false)
  verifyRuntimeTreeCriticalFiles(tree, VERSION)
})

test('installRuntimeVersion: invalid old tree is backed up until a verified publish commits', async () => {
  const baseDir = makeBaseDir()
  const tree = makeExistingTree(baseDir, VERSION, false)
  const result = await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(okRun({ args: [], opts: [] })),
  })
  assert.equal(result.versionTreeDir, tree)
  assert.equal(existsSync(path.join(tree, 'sentinel.txt')), false)
  assert.equal(readdirSync(path.dirname(tree)).some((name) => name.includes('.publish-backup-')), false)
})

test('installRuntimeVersion: injected publish failure restores the invalid old tree', async () => {
  const baseDir = makeBaseDir()
  const tree = makeExistingTree(baseDir, VERSION, false)
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(okRun({ args: [], opts: [] })),
      rename: (source, destination) => {
        if (path.basename(source).startsWith('.work-') && destination === tree) {
          throw new Error('injected publish rename failure')
        }
        renameSync(source, destination)
      },
    },
  }), /injected publish rename failure/)
  assert.equal(readFileSync(path.join(tree, 'sentinel.txt'), 'utf8'), 'previous tree')
  assert.equal(readdirSync(path.dirname(tree)).some((name) => name.includes('.publish-backup-')), false)
})

test('installRuntimeVersion: injected post-publish verification failure restores the old tree', async () => {
  const baseDir = makeBaseDir()
  const tree = makeExistingTree(baseDir, VERSION, false)
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(okRun({ args: [], opts: [] })),
      verifyPublished: () => { throw new Error('injected digest verification failure') },
    },
  }), /injected digest verification failure/)
  assert.equal(readFileSync(path.join(tree, 'sentinel.txt'), 'utf8'), 'previous tree')
  assert.equal(readdirSync(path.dirname(tree)).some((name) => name.includes('.publish-backup-')), false)
})

test('installRuntimeVersion: published tree is recursively read-only', {
  skip: process.platform === 'win32' ? 'Unix immutable-tree contract' : false,
}, async () => {
  const baseDir = makeBaseDir()
  const result = await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(okRun({ args: [], opts: [] })),
  })
  for (const entryPath of [
    result.versionTreeDir,
    path.join(result.versionTreeDir, 'package.json'),
    path.join(result.versionTreeDir, 'node_modules'),
    path.join(result.versionTreeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]) {
    assert.equal(statSync(entryPath).mode & 0o222, 0, `${entryPath} must have no write bits`)
  }
})

test('verifyRuntimeTreeCriticalFiles: detects post-publication critical-file drift', async () => {
  const baseDir = makeBaseDir()
  const result = await installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(okRun({ args: [], opts: [] })),
  })
  const bin = path.join(result.versionTreeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  chmodSync(bin, 0o600)
  writeFileSync(bin, '// corrupted after publish')
  assert.throws(() => verifyRuntimeTreeCriticalFiles(result.versionTreeDir, VERSION), /digest mismatch/)
})

test('installRuntimeVersion: failure scene is compact, owner-only, and sanitized', async () => {
  const baseDir = makeBaseDir()
  const secret = 'DO_NOT_PERSIST'
  const failedRun = async (): Promise<RunResult> => ({
    status: 1,
    stdout: '',
    stderr: `password=${secret} https://user:${secret}@registry.example/private/pkg?token=${secret} /Users/alice/private/${'x'.repeat(10_000)}`,
  })
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(failedRun),
  }), /dsh runtime install failed/)

  const scene = path.join(baseDir, 'dsh-runtime', `${VERSION}.failed`)
  const recordPath = path.join(scene, 'failure.json')
  const raw = readFileSync(recordPath, 'utf8')
  const record = JSON.parse(raw) as { version: string; stage: string; error: string }
  assert.equal(record.version, VERSION)
  assert.equal(record.stage, 'install')
  assert.doesNotMatch(raw, /DO_NOT_PERSIST|alice|private\/pkg/)
  assert.ok(Buffer.byteLength(raw) < 4_096)
  assert.deepEqual(readdirSync(scene), ['failure.json'])
  assert.equal(statSync(scene).mode & 0o777, 0o700)
  assert.equal(statSync(recordPath).mode & 0o777, 0o600)
  assert.equal(readdirSync(path.dirname(scene)).some((name) => name.startsWith('.work-')), false)
})

test('downloadVerifiedRegistryTarball: verifies SRI and removes mismatching bytes', async () => {
  const dir = makeBaseDir()
  const destination = path.join(dir, 'package.tgz')
  const fetchImpl: typeof fetch = async () => new Response(TARBALL, { status: 200 })
  await downloadVerifiedRegistryTarball(resolution(), destination, {
    signal: new AbortController().signal,
    fetchImpl,
  })
  assert.deepEqual(readFileSync(destination), TARBALL)

  const mismatch = path.join(dir, 'mismatch.tgz')
  await assert.rejects(downloadVerifiedRegistryTarball(
    resolution({ integrity: `sha512-${Buffer.alloc(64, 0x11).toString('base64')}` }),
    mismatch,
    { signal: new AbortController().signal, fetchImpl },
  ), /integrity mismatch/)
  assert.equal(existsSync(mismatch), false)
})

test('downloadVerifiedRegistryTarball: reports byte progress (declared and undeclared length)', async () => {
  const dir = makeBaseDir()
  const destination = path.join(dir, 'progress.tgz')
  const ticks: Array<{ received: number; total: number | null }> = []
  // Declared content-length: the total rides the progress ticks.
  const withLength = new Response(TARBALL, { status: 200, headers: { 'content-length': String(TARBALL.length) } })
  const fetchImpl: typeof fetch = async () => withLength
  await downloadVerifiedRegistryTarball(resolution(), destination, {
    signal: new AbortController().signal,
    fetchImpl,
    onProgress: (received, total) => ticks.push({ received, total }),
  })
  assert.equal(ticks.at(-1)?.received, TARBALL.length)
  assert.equal(ticks.at(-1)?.total, TARBALL.length)
  assert.ok(ticks.length >= 1, 'at least one progress tick was reported')

  // No content-length: total stays null (indeterminate bar), bytes still tick.
  const noLength = new Response(TARBALL, { status: 200 })
  const fetchImpl2: typeof fetch = async () => noLength
  const ticks2: Array<{ received: number; total: number | null }> = []
  await downloadVerifiedRegistryTarball(resolution(), path.join(dir, 'progress-nolength.tgz'), {
    signal: new AbortController().signal,
    fetchImpl: fetchImpl2,
    onProgress: (received, total) => ticks2.push({ received, total }),
  })
  assert.equal(ticks2.at(-1)?.received, TARBALL.length)
  assert.equal(ticks2.at(-1)?.total, null)
})

test('downloadVerifiedRegistryTarball: retries short writes and advances SRI/progress by persisted bytes', async () => {
  const dir = makeBaseDir()
  const destination = path.join(dir, 'short-write.tgz')
  const ticks: number[] = []
  let writes = 0

  await withPatchedFileHandleWrite((original) => async function (
    buffer,
    offset = 0,
    length = buffer.byteLength - (offset ?? 0),
    position = null,
  ) {
    const actualOffset = offset ?? 0
    const actualLength = length ?? buffer.byteLength - actualOffset
    writes += 1
    return original.call(this, buffer, actualOffset, Math.min(5, actualLength), position)
  }, async () => {
    await downloadVerifiedRegistryTarball(resolution(), destination, {
      signal: new AbortController().signal,
      fetchImpl: async () => new Response(TARBALL, {
        status: 200,
        headers: { 'content-length': String(TARBALL.length) },
      }),
      onProgress: received => ticks.push(received),
    })
  })

  assert.ok(writes > 1, 'the fixture must exercise a short-write retry')
  assert.deepEqual(readFileSync(destination), TARBALL)
  assert.deepEqual(ticks, Array.from(
    { length: Math.ceil(TARBALL.length / 5) },
    (_, index) => Math.min((index + 1) * 5, TARBALL.length),
  ))
})

test('downloadVerifiedRegistryTarball: a zero-byte write fails and removes the partial tarball', async () => {
  const destination = path.join(makeBaseDir(), 'zero-write.tgz')

  await withPatchedFileHandleWrite(() => async function (buffer) {
    return { bytesWritten: 0, buffer }
  }, async () => {
    await assert.rejects(downloadVerifiedRegistryTarball(resolution(), destination, {
      signal: new AbortController().signal,
      fetchImpl: async () => new Response(TARBALL, { status: 200 }),
    }), /write made no progress/)
  })

  assert.equal(existsSync(destination), false)
})

test('RuntimeInstallerSupervisor: bounds output and reports the real child pid', async () => {
  const supervisor = new RuntimeInstallerSupervisor(128, 25)
  let childPid = 0
  const result = await supervisor.run([
    process.execPath,
    '-e',
    "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096))",
  ], {
    cwd: makeBaseDir(),
    onSpawn: (pid) => { childPid = pid },
  })
  assert.ok(childPid > 0)
  assert.equal(result.status, 0)
  assert.equal(Buffer.byteLength(result.stdout), 128)
  assert.equal(Buffer.byteLength(result.stderr), 128)
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stderrTruncated, true)
  assert.equal(supervisor.activeCount, 0)
  await supervisor.dispose()
})

test('RuntimeInstallerSupervisor: abort and timeout reap the child process group', {
  skip: process.platform === 'win32' ? 'Unix process-group contract' : false,
}, async () => {
  const supervisor = new RuntimeInstallerSupervisor(1024, 25)
  const controller = new AbortController()
  let pid = 0
  const running = supervisor.run([
    process.execPath,
    '-e',
    "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)",
  ], {
    cwd: makeBaseDir(),
    signal: controller.signal,
    onSpawn: (value) => { pid = value },
  })
  controller.abort(new Error('test abort'))
  await assert.rejects(running, /test abort/)
  assert.equal(supervisor.activeCount, 0)
  assert.throws(() => process.kill(pid, 0), /ESRCH/)

  await assert.rejects(supervisor.run([
    process.execPath,
    '-e',
    "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)",
  ], {
    cwd: makeBaseDir(),
    timeoutMs: 15,
  }), /timed out/)
  assert.equal(supervisor.activeCount, 0)
  await supervisor.dispose()
})

test('RuntimeInstallerSupervisor: successful direct-child exit still reaps daemonized group descendants', {
  skip: process.platform === 'win32' ? 'Unix process-group contract' : false,
}, async () => {
  const supervisor = new RuntimeInstallerSupervisor(1024, 25)
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' })",
    'process.stdout.write(String(child.pid))',
    'child.unref()',
  ].join(';')
  const result = await supervisor.run([process.execPath, '-e', script], { cwd: makeBaseDir() })
  assert.equal(result.status, 0)
  const descendantPid = Number(result.stdout)
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)
  assert.throws(() => process.kill(descendantPid, 0), /ESRCH/)
  assert.equal(supervisor.activeCount, 0)
  await supervisor.dispose()
})

test('RuntimeInstallerSupervisor: dispose waits for a stubborn descendant after its group leader exits', {
  skip: process.platform === 'win32' ? 'Unix process-group contract' : false,
  timeout: 10_000,
}, async () => {
  const supervisor = new RuntimeInstallerSupervisor(1024, 250)
  const root = makeBaseDir()
  const descendantRecord = path.join(root, 'descendant-pid')
  let leaderPid = 0
  const script = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' })",
    `writeFileSync(${JSON.stringify(descendantRecord)}, String(child.pid))`,
    'child.unref()',
  ].join(';')
  const running = supervisor.run([process.execPath, '-e', script], {
    cwd: root,
    onSpawn: pid => { leaderPid = pid },
  })
  for (let attempt = 0; attempt < 100 && !existsSync(descendantRecord); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(existsSync(descendantRecord), true)
  const descendantPid = Number(readFileSync(descendantRecord, 'utf8'))
  assert.ok(leaderPid > 0)
  assert.ok(descendantPid > 0)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(leaderPid, 0)
      await new Promise(resolve => setTimeout(resolve, 5))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
      throw error
    }
  }
  assert.throws(() => process.kill(leaderPid, 0), /ESRCH/)

  // The leader is gone, but dispose must still poll and kill the whole PGID.
  await supervisor.dispose()
  const result = await running
  assert.equal(result.status, 0)
  await waitForEsrch(descendantPid, 'disposed descendant')
  assert.equal(supervisor.activeCount, 0)
})

test('RuntimeInstallerSupervisor: onSpawn failure cannot hide a residual writer and preserves evidence', {
  skip: process.platform === 'win32' ? 'Unix process-group contract' : false,
  timeout: 10_000,
}, async () => {
  const supervisor = new RuntimeInstallerSupervisor(1024, 25)
  const injected = supervisor as unknown as {
    terminate: (tracked: unknown) => Promise<void>
  }
  const originalTerminate = injected.terminate.bind(supervisor)
  injected.terminate = async () => {
    throw Object.assign(new Error('runtime installer child process group did not exit'), {
      code: 'ERR_DSH_RESIDUAL_PROCESS_GROUP',
    })
  }
  const root = makeBaseDir()
  const evidence = path.join(root, 'writer-ledger-evidence')
  let writerPid = 0
  await assert.rejects(supervisor.run([
    process.execPath,
    '-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], {
    cwd: root,
    onSpawn: pid => {
      writerPid = pid
      writeFileSync(evidence, String(pid))
      throw new Error('durable writer ledger write failed')
    },
  }), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ERR_DSH_RESIDUAL_PROCESS_GROUP')
    return true
  })
  assert.equal(supervisor.activeCount, 1)
  assert.equal(readFileSync(evidence, 'utf8'), String(writerPid))

  // Restore the real terminator so the test itself leaves no writer behind.
  injected.terminate = originalTerminate
  await supervisor.dispose()
  assert.throws(() => process.kill(writerPid, 0), /ESRCH/)
  assert.equal(supervisor.activeCount, 0)
  assert.equal(readFileSync(evidence, 'utf8'), String(writerPid))
})

test('RuntimeInstallerSupervisor: abort surfaces a quiescence failure without waiting for child close', {
  skip: process.platform === 'win32' ? 'Unix process-group contract' : false,
  timeout: 10_000,
}, async () => {
  const supervisor = new RuntimeInstallerSupervisor(1024, 25)
  const injected = supervisor as unknown as {
    terminate: (tracked: unknown) => Promise<void>
  }
  const originalTerminate = injected.terminate.bind(supervisor)
  injected.terminate = async () => {
    throw Object.assign(new Error('runtime installer child process group did not exit'), {
      code: 'ERR_DSH_RESIDUAL_PROCESS_GROUP',
    })
  }
  const controller = new AbortController()
  let writerPid = 0
  const running = supervisor.run([
    process.execPath,
    '-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], {
    cwd: makeBaseDir(),
    signal: controller.signal,
    onSpawn: pid => { writerPid = pid },
  })
  controller.abort(new Error('abort requested'))
  await assert.rejects(running, (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ERR_DSH_RESIDUAL_PROCESS_GROUP')
    return true
  })
  assert.equal(supervisor.activeCount, 1)
  assert.doesNotThrow(() => process.kill(writerPid, 0))

  // Restore the real proof path so the test itself cannot leak the writer.
  injected.terminate = originalTerminate
  await supervisor.dispose()
  assert.throws(() => process.kill(writerPid, 0), /ESRCH/)
})

test('RuntimeInstallerSupervisor: residual group reaping failure rejects instead of reporting success', async () => {
  const supervisor = new RuntimeInstallerSupervisor(1024, 5)
  const injected = supervisor as unknown as { reapResidualGroup: () => Promise<void> }
  injected.reapResidualGroup = async () => { throw new Error('runtime installer child process group did not exit') }
  await assert.rejects(supervisor.run([
    process.execPath,
    '-e',
    '',
  ], { cwd: makeBaseDir() }), /process group did not exit/)
  // Failed proof remains tracked until dispose independently establishes ESRCH.
  assert.equal(supervisor.activeCount, 1)
  await assert.rejects(supervisor.run([
    process.execPath,
    '-e',
    '',
  ], { cwd: makeBaseDir() }), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ERR_DSH_WRITER_UNSAFE')
    return true
  })
  await supervisor.dispose()
  assert.equal(supervisor.activeCount, 0)
})

test('pruneRuntimeStore: uses the supervised embedded pnpm and private store paths', async () => {
  const baseDir = makeBaseDir()
  let capturedArgs: string[] | null = null
  let capturedOpts: RunOptions | null = null
  await pruneRuntimeStore({
    baseDir,
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      node: nodeFn,
      run: async (args, opts) => {
        capturedArgs = args
        capturedOpts = opts
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })

  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  assert.deepEqual(capturedArgs, [
    '/fake/node',
    '--expose-internals',
    '/pnpm/bin/pnpm.cjs',
    'store',
    'prune',
    '--store-dir',
    path.join(runtimeDir, '.pnpm-store'),
  ])
  const runOpts = capturedOpts as RunOptions | null
  assert.ok(runOpts)
  assert.equal(runOpts.cwd, runtimeDir)
  assert.equal(runOpts.env?.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(runOpts.env?.NPM_CONFIG_USERCONFIG, path.join(runtimeDir, '.npmrc'))
  assert.equal(runOpts.env?.HOME, path.join(runtimeDir, '.install-home'))
  assert.equal(runOpts.env?.XDG_CACHE_HOME, path.join(runtimeDir, '.xdg-cache'))
  assert.equal(runOpts.signal?.aborted, false)
})

test('pruneRuntimeStore: reclaims .pnpm-cache/.xdg-cache content after a successful prune when the durable request carries cache-reclaim', async () => {
  const baseDir = makeBaseDir()
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const cacheFile = path.join(runtimeDir, '.pnpm-cache', 'metadata', 'registry.json')
  const xdgFile = path.join(runtimeDir, '.xdg-cache', 'dl', 'tarball')
  mkdirSync(path.dirname(cacheFile), { recursive: true })
  mkdirSync(path.dirname(xdgFile), { recursive: true })
  writeFileSync(cacheFile, 'cache-entry')
  writeFileSync(xdgFile, 'xdg-entry')
  markStorePruneNeeded(baseDir, 'cache-reclaim')
  await pruneRuntimeStore({
    baseDir,
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run: async () => ({ status: 0, stdout: '', stderr: '' }) },
  })
  // The cache directories themselves stay (installers keep state inside them).
  assert.equal(existsSync(path.join(runtimeDir, '.pnpm-cache')), true)
  assert.equal(existsSync(path.join(runtimeDir, '.xdg-cache')), true)
  assert.equal(existsSync(cacheFile), false, '.pnpm-cache content is reclaimed')
  assert.equal(existsSync(xdgFile), false, 'nested .xdg-cache content is reclaimed')
})

test('pruneRuntimeStore: leaves the private caches byte-for-byte intact without a cache-reclaim reason', async () => {
  const baseDir = makeBaseDir()
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const cacheFile = path.join(runtimeDir, '.pnpm-cache', 'keep.json')
  mkdirSync(path.dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, 'keep-me')
  markStorePruneNeeded(baseDir, 'explicit-cleanup:1.0.0')
  await pruneRuntimeStore({
    baseDir,
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run: async () => ({ status: 0, stdout: '', stderr: '' }) },
  })
  assert.equal(readFileSync(cacheFile, 'utf8'), 'keep-me',
    'a plain prune must never touch the private caches')
})

test('pruneRuntimeStore: cache reclaim removes a symlink entry itself and never follows it out of the private dirs', {
  skip: process.platform === 'win32' ? 'symlink fixture requires Unix permissions' : false,
}, async () => {
  const baseDir = makeBaseDir()
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const outside = path.join(baseDir, 'outside-cache-target')
  writeFileSync(outside, 'DO_NOT_DELETE')
  const link = path.join(runtimeDir, '.pnpm-cache', 'evil-link')
  mkdirSync(path.dirname(link), { recursive: true })
  symlinkSync(outside, link)
  markStorePruneNeeded(baseDir, 'cache-reclaim')
  await pruneRuntimeStore({
    baseDir,
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run: async () => ({ status: 0, stdout: '', stderr: '' }) },
  })
  assert.equal(existsSync(link), false, 'the symlink entry itself is removed')
  assert.equal(readFileSync(outside, 'utf8'), 'DO_NOT_DELETE', 'the external target is untouched')
})

test('pruneRuntimeStore: a failed prune performs no cache reclamation even with the reason present', async () => {
  const baseDir = makeBaseDir()
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const cacheFile = path.join(runtimeDir, '.pnpm-cache', 'survive.json')
  mkdirSync(path.dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, 'survive')
  markStorePruneNeeded(baseDir, 'cache-reclaim')
  await assert.rejects(pruneRuntimeStore({
    baseDir,
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run: async () => ({ status: 1, stdout: '', stderr: 'boom' }) },
  }), /store prune failed/)
  assert.equal(existsSync(cacheFile), true, 'reclamation only rides a successful prune')
})

test('pruneRuntimeStore: rejects a symlinked .npmrc without truncating its target or spawning pnpm', {
  skip: process.platform === 'win32' ? 'symlink fixture requires Unix permissions' : false,
}, async () => {
  const baseDir = makeBaseDir()
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'dsh-rt-installer-npmrc-outside-'))
  const target = path.join(outsideDir, 'user-npmrc')
  writeFileSync(target, 'registry=https://private.example/\n_authToken=DO_NOT_TRUNCATE\n', { mode: 0o644 })
  chmodSync(target, 0o644)
  const targetBefore = statSync(target)
  const npmrc = path.join(runtimeDir, '.npmrc')
  symlinkSync(target, npmrc)
  let runCalls = 0

  await assert.rejects(pruneRuntimeStore({
    baseDir,
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      node: nodeFn,
      run: async () => {
        runCalls += 1
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  }), /单链接普通文件/)

  assert.equal(runCalls, 0)
  assert.equal(lstatSync(npmrc).isSymbolicLink(), true)
  assert.deepEqual(statSync(target), targetBefore)
  assert.equal(readFileSync(target, 'utf8'), 'registry=https://private.example/\n_authToken=DO_NOT_TRUNCATE\n')
})

test('installRuntimeVersion: rejects a symlinked runtime root before download and leaves outside state untouched', {
  skip: process.platform === 'win32' ? 'symlink fixture requires Unix permissions' : false,
}, async () => {
  const baseDir = makeBaseDir()
  const outsideRoot = mkdtempSync(path.join(tmpdir(), 'dsh-rt-installer-root-outside-'))
  const sentinel = path.join(outsideRoot, 'sentinel')
  writeFileSync(sentinel, 'outside-runtime-root', { mode: 0o644 })
  const before = statSync(sentinel)
  symlinkSync(outsideRoot, path.join(baseDir, 'dsh-runtime'))
  let downloads = 0

  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
      download: async () => { downloads += 1 },
    },
  }), /不安全/)

  assert.equal(downloads, 0)
  assert.deepEqual(statSync(sentinel), before)
  assert.equal(readFileSync(sentinel, 'utf8'), 'outside-runtime-root')
  assert.deepEqual(readdirSync(outsideRoot), ['sentinel'])
})

test('pruneRuntimeStore: rejects failures without leaking registry URL secrets', async () => {
  const secret = 'DO_NOT_EXPOSE'
  const pathSecret = 'PATH_CAPABILITY'
  let failure: unknown
  try {
    await pruneRuntimeStore({
      baseDir: makeBaseDir(),
      pnpmEntry: '/pnpm/bin/pnpm.cjs',
      deps: {
        node: nodeFn,
        run: async () => ({
          status: 1,
          stdout: '',
          stderr: `request failed: https://user:password@registry.example/${pathSecret}?token=${secret}`,
        }),
      },
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /store prune failed/)
  assert.doesNotMatch(failure.message, /password|DO_NOT_EXPOSE|PATH_CAPABILITY/)
})

test('scrubInstallEnv: keeps network basics (incl. lowercase proxy vars) and drops npm config/secrets', () => {
  const env = scrubInstallEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    XDG_CACHE_HOME: '/home/u/.cache',
    HTTP_PROXY: 'http://proxy:8080',
    HTTPS_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost',
    http_proxy: 'http://lower-proxy:8080',
    https_proxy: 'http://lower-proxy:8080',
    no_proxy: 'localhost,internal',
    all_proxy: 'http://all-proxy:8080',
    npm_config_registry: 'https://evil.example',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GIT_TOKEN: 'token',
    NODE_ENV: 'production',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, undefined)
  assert.equal(env.XDG_CACHE_HOME, undefined)
  assert.equal(env.HTTP_PROXY, 'http://proxy:8080')
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080')
  assert.equal(env.NO_PROXY, 'localhost')
  // Lowercase proxy variables are deliberately whitelisted (design 18 §9.1
  // proxy seam; many HTTP toolchains only honour the lowercase forms).
  assert.equal(env.http_proxy, 'http://lower-proxy:8080')
  assert.equal(env.https_proxy, 'http://lower-proxy:8080')
  assert.equal(env.no_proxy, 'localhost,internal')
  assert.equal(env.all_proxy, undefined)
  assert.equal(env.npm_config_registry, undefined)
  assert.equal(env.SSH_AUTH_SOCK, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.GIT_TOKEN, undefined)
  assert.equal(env.NODE_ENV, undefined)
})

test('installRuntimeVersion preserves work/PID evidence when a child process group cannot be reaped', async () => {
  const baseDir = makeBaseDir()
  const groupError = Object.assign(new Error('runtime installer child process group did not exit'), {
    code: 'ERR_DSH_RESIDUAL_PROCESS_GROUP',
  })
  await assert.rejects(installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(async (_args, opts) => {
        opts.onSpawn?.(process.pid)
        throw groupError
      }),
    },
  }), /process group did not exit/)
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  const work = readdirSync(runtimeDir).find(name => name.startsWith('.work-'))
  assert.ok(work !== undefined)
  assert.equal(readFileSync(path.join(runtimeDir, work!, 'pid'), 'utf8'), String(process.pid))
})

test('disposeRuntimeInstaller: aborts and awaits an active download before cleanup returns', async () => {
  const baseDir = makeBaseDir()
  let notifyStarted!: () => void
  const started = new Promise<void>((resolve) => { notifyStarted = resolve })
  const installation = installRuntimeVersion({
    baseDir,
    resolution: resolution(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: {
      ...depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
      download: async (_bound, _destination, { signal }) => {
        notifyStarted()
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
  })
  const rejection = assert.rejects(installation, /runtime installer is shutting down/)
  await started
  await disposeRuntimeInstaller()
  await rejection
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  assert.equal(readdirSync(runtimeDir).some((name) => name.startsWith('.work-')), false)
})

test('disposeRuntimeInstaller reopens the DEFAULT supervisor for a same-process restart (gateway stop → start)', async () => {
  // Review-fix regression: the module latch used to reset in `finally`, but
  // the default supervisor's `disposing` flag stayed true, so every later
  // install/prune through the DEFAULT runner was rejected forever with
  // 'runtime installer is shutting down' — exactly the gateway stop→start
  // scenario the comment claimed to fix. This test exercises the DEFAULT
  // runner (no deps.run injection): a post-dispose prune must reach the pnpm
  // child (which fails fast on its own — process.execPath as the pnpm entry
  // is not a pnpm script), NOT the supervisor latch.
  await disposeRuntimeInstaller()
  await assert.rejects(
    pruneRuntimeStore({ baseDir: makeBaseDir(), pnpmEntry: process.execPath }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.doesNotMatch(message, /runtime installer is shutting down/, 'the default supervisor must be OPEN after a proven disposal')
      assert.match(message, /store prune failed/)
      return true
    },
  )
  // A second full cycle (stop → start → stop) stays safe too.
  await disposeRuntimeInstaller()
  await assert.rejects(
    pruneRuntimeStore({ baseDir: makeBaseDir(), pnpmEntry: process.execPath }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.doesNotMatch(message, /runtime installer is shutting down/)
      return true
    },
  )
})

test('createOperationDeadline refuses new operations with the writer-safety code while disposal is in flight', async () => {
  // Round-4 coverage: the runtimeInstallerDisposing gate must carry the same
  // ERR_DSH_WRITER_UNSAFE classification as the supervisor's disposing guard
  // (owners switch on the code, not the message).
  const disposing = disposeRuntimeInstaller() // sets the latch synchronously
  await assert.rejects(
    installRuntimeVersion({
      baseDir: makeBaseDir(),
      resolution: resolution(),
      pnpmEntry: '/pnpm/bin/pnpm.cjs',
      deps: depsWithRun(async () => ({ status: 0, stdout: '', stderr: '' })),
    }),
    (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'ERR_DSH_WRITER_UNSAFE')
      assert.match(error instanceof Error ? error.message : String(error), /runtime installer is shutting down/)
      return true
    },
  )
  await disposing
  // The latch is released by the completed disposal; the supervisor reopens.
  await assert.rejects(
    pruneRuntimeStore({ baseDir: makeBaseDir(), pnpmEntry: process.execPath }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.doesNotMatch(message, /runtime installer is shutting down/)
      return true
    },
  )
})

test('failed installer disposal stays poisoned, drains injected runners, and only a successful retry reopens entries', async () => {
  const baseDir = makeBaseDir()
  let notifyRunStarted!: () => void
  const runStarted = new Promise<void>((resolve) => { notifyRunStarted = resolve })
  let releaseRun!: () => void
  const release = new Promise<void>((resolve) => { releaseRun = resolve })
  const activePrune = pruneRuntimeStore({
    baseDir,
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(async () => {
      notifyRunStarted()
      await release
      return { status: 0, stdout: '', stderr: '' }
    }),
  })
  await runStarted

  const proofFailure = Object.assign(new Error('injected writer proof failure'), {
    code: 'ERR_DSH_WRITER_UNSAFE',
  })
  let disposalSettled = false
  const firstDispose = disposeRuntimeInstaller({
    beforeReset: () => { throw proofFailure },
  })
  void firstDispose.then(
    () => { disposalSettled = true },
    () => { disposalSettled = true },
  )

  await Promise.resolve()
  assert.equal(disposalSettled, false, 'a failed disposal tail does not skip the active operation drain')
  releaseRun()
  await assert.rejects(activePrune, /runtime installer is shutting down/)
  await assert.rejects(firstDispose, /injected writer proof failure/)

  let poisonedRunCalled = false
  await assert.rejects(
    pruneRuntimeStore({
      baseDir: makeBaseDir(),
      pnpmEntry: '/pnpm/bin/pnpm.cjs',
      deps: depsWithRun(async () => {
        poisonedRunCalled = true
        return { status: 0, stdout: '', stderr: '' }
      }),
    }),
    (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'ERR_DSH_WRITER_UNSAFE')
      assert.match(error instanceof Error ? error.message : String(error), /quiescence is unproven/)
      return true
    },
  )
  assert.equal(poisonedRunCalled, false, 'the shared entry gate rejects injected runners too')

  const retryA = disposeRuntimeInstaller()
  const retryB = disposeRuntimeInstaller()
  assert.equal(retryA, retryB, 'concurrent retry disposal calls share one proof')
  await retryA

  let reopenedRunCalled = false
  await pruneRuntimeStore({
    baseDir: makeBaseDir(),
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: depsWithRun(async () => {
      reopenedRunCalled = true
      return { status: 0, stdout: '', stderr: '' }
    }),
  })
  assert.equal(reopenedRunCalled, true)
})
