/**
 * ssh provider — part 2: the remote argv whitelist (buildRemoteExecArgv, resolveWriteTarget), the
 * run/write-file channel, stdout/stderr bounding and redacted failure detail. Sibling parts:
 * ssh-provider.test.ts, ssh-provider-endpoint-auth.test.ts (shared TransportExecDeps fake in
 * test/support/ssh-provider-run-deps.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { buildRemoteExecArgv, configureSshPasswordStore, purgeSshAuth, resolveWriteTarget, setSshPassword, sshProvider, RUN_STDOUT_MAX_BYTES, WRITE_FILE_MAX_BYTES } from '../../ssh-provider.ts'
import type { SpawnedProcess, TransportExecDeps } from '../../transport-provider.ts'
import { CHILD_LINE_MAX_CHARS } from '../../bounded-lines.ts'
import { runDeps, spec, specWithHome } from '../support/ssh-provider-run-deps.ts'

// --- design 13 §7.2 exec whitelist tests ---
test('buildRemoteExecArgv refuses every dsh argv (the user plugin write surface is retired)', () => {
  const dshArgvs: string[][] = [
    ['plugin', '--profile', 'web', 'add', '@scope/name@^1.2.3'],
    ['plugin', '--profile', 'web', 'remove', 'name'],
    ['plugin', '--profile', 'web', 'update', 'name'],
    ['--version'],
    [],
  ]
  for (const argv of dshArgvs) {
    assert.equal(
      buildRemoteExecArgv(spec('w1'), { op: 'exec', command: 'dsh', argv }),
      null,
      `refuses dsh ${JSON.stringify(argv)}`,
    )
  }
})
test('buildRemoteExecArgv allows only the two whitelisted cat paths (always under LC_ALL=C)', () => {
  // LC_ALL=C forces the REMOTE coreutils to English regardless of the remote
  // locale — the general fix for localized ENOENT messages (zh_CN 没有那个文件
  // 或目录, ja, fr, …), not a per-language whitelist.
  assert.deepEqual(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/package.json'] }), ['LC_ALL=C', 'cat', '~/.dsh/profiles/web/package.json'])
  assert.deepEqual(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/cordis.patch.yml'] }), ['LC_ALL=C', 'cat', '~/.dsh/profiles/web/cordis.patch.yml'])
  assert.equal(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['/etc/passwd'] }), null, 'refuses arbitrary cat path')
  assert.equal(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/package.json', 'extra'] }), null, 'refuses extra argv')
})
test('resolveWriteTarget allows the seed + patch prefixes and rejects traversal', () => {
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/web/cordis.patch.yml'), '~/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(resolveWriteTarget(spec('w6'), '/etc/passwd'), null, 'refuses arbitrary path')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh-chamber/plugins/pkg-abc123.tgz'), null, 'the materialized-tarball dir is retired')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/web/package.json'), null, 'refuses non-whitelisted profile file')
})
test('resolveWriteTarget honors a custom remoteDshHome', () => {
  assert.equal(resolveWriteTarget(specWithHome('w7', '/opt/dsh'), '/opt/dsh/profiles/web/cordis.patch.yml'), '/opt/dsh/profiles/web/cordis.patch.yml')
  assert.equal(resolveWriteTarget(specWithHome('w7', '/opt/dsh'), '~/.dsh/profiles/web/cordis.patch.yml'), null, 'default-home path rejected when a custom home is set')
})
test('resolveWriteTarget rejects traversal inside the seed subtree (shared SEED_RELATIVE_PATTERN)', () => {
  const seed = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json'
  assert.equal(resolveWriteTarget(spec('w7b'), seed), seed)
  assert.equal(
    resolveWriteTarget(spec('w7b'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/../../etc/passwd'),
    null,
    'dot-dot escapes the seed subtree',
  )
  assert.equal(
    resolveWriteTarget(spec('w7b'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/./package.json'),
    null,
    'self-segment is refused too',
  )
})
test('buildRemoteExecArgv allows the converged seed-subtree cat read (seed hash-skip)', () => {
  const seedPkg = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [seedPkg] }), ['LC_ALL=C', 'cat', seedPkg])
  const seedDist = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [seedDist] }), ['LC_ALL=C', 'cat', seedDist])
  const gitWorktreeDist = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-git-worktree/dist/index.js'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [gitWorktreeDist] }), ['LC_ALL=C', 'cat', gitWorktreeDist])
  assert.equal(
    buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/node_modules/other/pkg.json'] }),
    null,
    'outside the seed subtree refused',
  )
  assert.equal(
    buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/node_modules/@dsh-chamber/../../etc/passwd'] }),
    null,
    'traversal beyond the seed subtree refused',
  )
})
test('buildRemoteExecArgv refuses the retired materialize file: add spec (dsh argv is never whitelisted)', () => {
  for (const specArg of [
    'file:/home/u/.dsh-chamber/plugins/pkg-a1b2c3d4.tgz',
    'file:/home/u/.dsh-chamber/plugins/scope-name-a1b2.tgz',
    'pkg@^1.0.0',
    'file:/etc/passwd',
    'file:~/x.tgz',
    'file:/tmp/evil.tgz',
  ]) {
    assert.equal(
      buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', specArg] }),
      null,
      `refuses dsh plugin add ${specArg}`,
    )
  }
})

// ============================================================================
// write-file flow (design 13 §4.1) — through the real provider surface
// ============================================================================

/** A fake ssh child whose stdin writes are recorded (base64 payloads). */
class FakeRunChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin: { write(chunk: string | Buffer): unknown; end(): unknown }
  stdinWrites: Buffer[] = []
  killCalls: string[] = []
  constructor() {
    super()
    this.stdin = {
      write: (chunk) => { this.stdinWrites.push(Buffer.from(chunk)); return true },
      end: () => {},
    }
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal)
    return true
  }
  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal)
  }
  stdoutWrite(text: string | Buffer) {
    this.stdout.emit('data', Buffer.from(text))
  }
  stderrWrite(text: string) {
    this.stderr.emit('data', Buffer.from(text))
  }
}

/** A spawnFn whose fake child fails immediately with `text` on stderr. */
function failingRemote(text: string, code = 1): TransportExecDeps['spawnFn'] {
  return () => {
    const child = new FakeRunChild()
    setImmediate(() => { child.stderrWrite(text); child.simulateExit(code) })
    return child
  }
}

/** Bounded poll for observable side effects (the timeout timer is unref'ed;
 * racing it with a fixed keep-alive flaked under CI stalls). */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${what} did not become true within ${timeoutMs}ms`)
}
test('a run timeout resolves without releasing askpass before the real child exit', async () => {
  configureSshPasswordStore(null)
  const runSpec = spec('t-run-timeout-lease')
  setSshPassword(runSpec.id, 'pw')
  const child = new FakeRunChild()
  let helperPath: string | null = null
  let exited = false
  try {
    const deps = runDeps((_command, _args, options) => {
      helperPath = typeof options.env?.SSH_ASKPASS === 'string' ? options.env.SSH_ASKPASS : null
      return child
    })
    deps.runTimeoutMs = 5
    deps.disconnectGraceMs = 1_000
    const resultPromise = sshProvider.exec!(runSpec, 'run', deps, {
      op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/package.json'],
    })
    // Production timeout timers are intentionally unref'ed: wait on the
    // observable side effect (SIGTERM) instead of racing a fixed keep-alive
    // against CI stalls.
    await waitFor(() => child.killCalls.includes('SIGTERM'), 'the 5ms timeout sent SIGTERM')
    const result = await resultPromise
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /timed out/)
    assert.ok(child.killCalls.includes('SIGTERM'), 'timeout asks the real child to terminate')
    assert.ok(helperPath !== null && existsSync(helperPath), 'promise resolution alone cannot release the live child helper')
    child.simulateExit(143, 'SIGTERM')
    exited = true
    assert.ok(!existsSync(helperPath), 'the later real child exit releases the helper')
  } finally {
    if (!exited) child.simulateExit(143, 'SIGTERM')
    setSshPassword(runSpec.id, null)
    purgeSshAuth(runSpec.id)
  }
})

/**
 * A fake remote host for the `run` channel: records every spawn and answers
 * write-file (`mkdir -p … && base64 -d > …` — decodes the recorded stdin),
 * `cat` (serves the file bytes / ENOENT), `printf %s $HOME` and `dsh`
 * automatically on the next tick. `tamper` overrides the bytes `cat` serves
 * for a path (verification-mismatch tests).
 */
function makeRemoteHost(home = '/home/u') {
  const files = new Map<string, Buffer>()
  const tamper = new Map<string, Buffer>()
  const spawns: Array<{ command: string; args: string[]; child: FakeRunChild }> = []
  const spawnFn = (command: string, args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    const record = { command, args: [...args], child }
    spawns.push(record)
    setImmediate(() => handleRemote(record))
    return child
  }
  function handleRemote(record: { command: string; args: string[]; child: FakeRunChild }) {
    // ssh args: [target, ...remoteArgv] or ['-p', <port>, target, ...remoteArgv]
    const remoteArgv = record.args[0] === '-p' ? record.args.slice(3) : record.args.slice(1)
    const child = record.child
    const joined = remoteArgv.join(' ')
    if (joined.startsWith('mkdir -p ') && joined.includes(' && base64 -d > ')) {
      const target = joined.slice(joined.lastIndexOf('> ') + 2)
      const base64 = child.stdinWrites.map(bytes => bytes.toString('utf8')).join('')
      files.set(target, Buffer.from(base64, 'base64'))
      child.simulateExit(0)
      return
    }
    if (remoteArgv[0] === 'cat' || (remoteArgv[0] === 'LC_ALL=C' && remoteArgv[1] === 'cat')) {
      // The provider runs every remote cat under `LC_ALL=C` (English
      // messages regardless of the remote locale); the bare form covers
      // the write-file read-back fake and legacy shapes.
      const path = remoteArgv[0] === 'cat' ? remoteArgv[1] as string : remoteArgv[2] as string
      const bytes = tamper.get(path) ?? files.get(path)
      if (bytes === undefined) {
        child.stderrWrite(`cat: ${path}: No such file or directory\n`)
        child.simulateExit(1)
      } else {
        child.stdoutWrite(bytes)
        child.simulateExit(0)
      }
      return
    }
    if (remoteArgv[0] === 'printf' && remoteArgv[1] === '%s' && remoteArgv[2] === '$HOME') {
      child.stdoutWrite(home)
      child.simulateExit(0)
      return
    }
    if (remoteArgv[0] === 'dsh') {
      child.simulateExit(0)
      return
    }
    child.stderrWrite(`unknown remote command: ${joined}\n`)
    child.simulateExit(1)
  }
  return { spawns, files, tamper, spawnFn }
}
test('write-file: streams base64 over ssh stdin and verifies the read-back in the BYTE domain', async () => {
  const remote = makeRemoteHost()
  // Binary content with invalid UTF-8 sequences: the lossy `toString('utf8')`
  // view must NOT be what the hash is computed over (hashing the string would
  // corrupt this content with U+FFFD).
  const content = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x81, 0x82, 0x00, 0x01])
  const sha256 = createHash('sha256').update(content).digest('hex')
  const target = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json'
  const result = await sshProvider.exec!(spec('wf1'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path: target,
    contentBase64: content.toString('base64'),
    sha256,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // The fake host stored the decoded bytes verbatim; the write command was a
  // single fixed `mkdir -p … && base64 -d > …` shell template.
  assert.ok(remote.files.get(target)!.equals(content))
  assert.equal(remote.spawns.length, 2, 'one write spawn + one cat read-back spawn')
  assert.ok(remote.spawns[0].args[1].startsWith('mkdir -p ~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph && base64 -d > '))
  // Verification is a streaming digest. Successful write-file calls return
  // status only instead of retaining/decoding a second copy of the payload.
  assert.equal(result.stdoutBytes, undefined)
  assert.equal(result.stdout, undefined)
})
test('write-file: a tampered read-back fails loud (never a fake success)', async () => {
  const remote = makeRemoteHost()
  const content = Buffer.from('hello')
  const path = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json'
  remote.tamper.set(path, Buffer.from('tampered'))
  const result = await sshProvider.exec!(spec('wf2'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path,
    contentBase64: content.toString('base64'),
    sha256: createHash('sha256').update(content).digest('hex'),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /verification failed: remote SHA-256 mismatch/)
})
test('write-file: a payload sha256 mismatch is refused before any spawn', async () => {
  const remote = makeRemoteHost()
  const result = await sshProvider.exec!(spec('wf3'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path: '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json',
    contentBase64: Buffer.from('hello').toString('base64'),
    sha256: '0'.repeat(64),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /content does not match sha256/)
  assert.equal(remote.spawns.length, 0)
})
test('write-file: content over the 50MiB cap is refused before any spawn', async () => {
  const remote = makeRemoteHost()
  const big = Buffer.alloc(WRITE_FILE_MAX_BYTES + 1, 0x61)
  const result = await sshProvider.exec!(spec('wf4'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path: '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json',
    contentBase64: big.toString('base64'),
    sha256: createHash('sha256').update(big).digest('hex'),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /exceeds the .*byte limit/)
  assert.equal(remote.spawns.length, 0, 'no ssh process may spawn for an oversized write')
})
test('run: captured remote stdout is bounded before buffering', async () => {
  const remote = makeRemoteHost()
  const path = '~/.dsh/profiles/web/package.json'
  remote.files.set(path, Buffer.alloc(RUN_STDOUT_MAX_BYTES + 1, 0x61))
  const result = await sshProvider.exec!(spec('wf-stdout-cap'), 'run', runDeps(remote.spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: [path],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /stdout exceeds the .*byte limit/)
  assert.ok(remote.spawns[0].child.killCalls.includes('SIGTERM'), 'oversized producer is terminated')
})
test('run: an unterminated stderr line is bounded and discarded before redaction detail assembly', async () => {
  const child = new FakeRunChild()
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(() => child)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const running = sshProvider.exec!(spec('wf-stderr-cap'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  child.stderrWrite('x'.repeat(CHILD_LINE_MAX_CHARS + 1))
  child.stderrWrite('\nordinary failure\n')
  child.simulateExit(1)
  const result = await running
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /output line dropped/)
    assert.match(result.error, /ordinary failure/)
    assert.ok(result.error.length < 4096, 'failure detail remains bounded')
  }
  assert.ok(logs.some(entry => entry.level === 'error' && entry.message.includes('output line dropped')))
  assert.ok(logs.every(entry => !entry.message.includes('xxxxx')), 'raw overlong stderr never reaches logs')
})
test('run: many newline-delimited stderr lines are bounded while the process is still running', async () => {
  const child = new FakeRunChild()
  const running = sshProvider.exec!(spec('wf-stderr-count-cap'), 'run', runDeps(() => child), {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  for (let index = 0; index < 5_000; index += 1) child.stderrWrite(`failure-${index}\n`)
  child.simulateExit(1)
  const result = await running
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.error.length < 4096, 'detail storage is capped incrementally, not only sliced after join')
    assert.match(result.error, /failure-0/)
  }
})
test('run: a non-zero exit carries the REDACTED remote stderr text (ENOENT → profile not initialized)', async () => {
  const remote = makeRemoteHost()
  const result = await sshProvider.exec!(spec('wf5'), 'run', runDeps(remote.spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /run command failed \(exit 1\)/)
    assert.match(result.error, /No such file or directory/, 'the ENOENT stderr text rides the run error')
  }
})
test('run: a non-quiet failure is logged at ERROR level (loud by default)', async () => {
  const remote = makeRemoteHost()
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(remote.spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wf7'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  assert.equal(result.ok, false)
  assert.ok(
    logs.some(entry => entry.level === 'error' && entry.message.startsWith('run command failed')),
    'the ERROR log line is present for a non-quiet failure',
  )
})
test('run: a QUIET failure keeps the ENOENT error text but suppresses the ERROR log and the stderr INFO echo', async () => {
  const remote = makeRemoteHost()
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(remote.spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wf8'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /run command failed \(exit 1\)/)
    assert.match(result.error, /No such file or directory/, 'the ENOENT stderr text still rides the run error')
  }
  assert.ok(
    !logs.some(entry => entry.level === 'error' && entry.message.startsWith('run command failed')),
    'no ERROR log for a quiet expected failure',
  )
  assert.ok(!logs.some(entry => entry.message.includes('No such file or directory')), 'no raw-stderr INFO echo for a quiet run')
})
test('run: a QUIET ENOENT probe under a `.ssh`-named home stays ENOENT-classified (redacted display still hides the path)', async () => {
  // A whitelist-valid remoteDshHome like /root/.ssh-custom (design 13 §7.2)
  // makes redactSshStderr replace the whole ENOENT line with the redacted
  // summary — the absent-file signal must survive (classified on the RAW
  // stderr), so the plugin-sync caller still reads "file absent", never a
  // loud ssh failure — while the display text still hides the path.
  const spawnFn = failingRemote('cat: /root/.ssh-custom/profiles/web/package.json: No such file or directory\n')
  const result = await sshProvider.exec!(specWithHome('wf9', '/root/.ssh-custom'), 'run', runDeps(spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: ['/root/.ssh-custom/profiles/web/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /No such file or directory/, 'the ENOENT classification survives the `.ssh*` whole-line redaction')
    assert.ok(!result.error.includes('.ssh-custom'), 'the `.ssh`-named home path never rides the error')
    assert.ok(!result.error.includes('/root/'), 'no path material rides the error')
    assert.ok(result.error.includes('[ssh material redacted]'), 'the redacted summary is what is displayed')
  }
})
test('run: a zh_CN-locale ENOENT ("没有那个文件或目录") is classified as absent — a quiet probe, never a loud failure', async () => {
  // Real-world case: coreutils on a zh_CN-locale host
  // prints `没有那个文件或目录` for a missing file. classifyStderr must flag
  // it ENOENT (classified on the RAW line) so the plugin-sync caller reads
  // "file absent" (未注入) instead of a loud ssh failure — while the quiet
  // run stays log-free.
  const spawnFn = failingRemote('cat: ~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-git-worktree/package.json: 没有那个文件或目录\n')
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wzh'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-git-worktree/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /没有那个文件或目录/, 'the zh_CN ENOENT text rides the run error')
  }
  assert.ok(
    !logs.some(entry => entry.level === 'error' && entry.message.startsWith('run command failed')),
    'no ERROR log for a quiet zh_CN ENOENT probe',
  )
  assert.ok(!logs.some(entry => entry.message.includes('没有那个文件或目录')), 'no raw-stderr INFO echo for a quiet run')
})
test('run: a QUIET exec with an auth failure stays LOUD (ERROR log + authentication-failure result)', async () => {
  // quiet suppresses EXPECTED failures only (ENOENT probes) — an auth failure
  // is never expected, so it must still log the ERROR line and return the
  // authentication-failure result, never a generic quieted failure.
  const spawnFn = failingRemote('Permission denied (publickey).\n', 255)
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wf10'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'authentication failure — requires user action')
  assert.ok(
    logs.some(entry => entry.level === 'error' && entry.message.includes('authentication failure detected')),
    'quiet never silences an auth failure — the ERROR line is still logged',
  )
})
test('run: private material in stderr is redacted from the failure detail', async () => {
  const spawnFn = failingRemote('Load key "/Users/alice/.ssh/id_ed25519": invalid format\n')
  const result = await sshProvider.exec!(spec('wf6'), 'run', runDeps(spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(!result.error.includes('/Users/alice/.ssh'), 'the key path never rides the error')
    assert.match(result.error, /\[ssh material redacted\]/)
  }
})
