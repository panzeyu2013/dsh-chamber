/**
 * ssh provider password-auth unit tests (design 05 §8): the in-memory
 * password store, the ephemeral askpass helper script (single-quote
 * escaping, host-key `yes` answers, 0600 file, dispose cleanup) and the
 * buildStartEnv surface that wires the password into the ssh spawn without
 * a TTY or the command line. Pure-Node, no real ssh host: the helper's
 * behavior is verified by actually executing it against ssh-style prompts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAskpassScript,
  buildRemoteExecArgv,
  configureSshPasswordStore,
  createAskpassHelper,
  disposeSshAuth,
  getSshPassword,
  resolveWriteTarget,
  setSshPassword,
  sshAuthEnv,
  sshPasswordSupported,
  sshProvider,
  WRITE_FILE_MAX_BYTES,
} from './ssh-provider.ts'
import type { TransportExecDeps, TransportInstanceSpec, TransportStatusProjection, SpawnedProcess } from './transport-provider.ts'

/** A minimal valid ssh spec for provider-surface tests. */
function spec(id: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome: null }
}

test('buildAskpassScript escapes single quotes and keeps password/passphrase prompts apart from host-key confirmations', () => {
  const script = buildAskpassScript("it's-a-pass'word")
  // The password must be embedded sh-safely: every ' becomes '\'' so the
  // literal value survives the shell.
  assert.ok(script.includes(`printf '%s\\n' 'it'\\''s-a-pass'\\''word'`), 'single quotes are escaped for sh')
  // The host-key confirmation branch must answer yes, never the password.
  assert.ok(script.includes('*"yes/no"*'), 'host-key yes/no prompts are matched')
  assert.ok(script.includes('echo yes'), 'host-key prompts answer yes')
  assert.ok(!script.includes("it's-a-pass"), 'the raw password never appears in the host-key branch')
})

test('the askpass helper answers host-key prompts with yes and password prompts with the password', () => {
  const path = createAskpassHelper('t-askpass-1', "s3cr't")
  try {
    const hostKey = spawnSync('sh', [path, 'Are you sure you want to continue connecting (yes/no/[fingerprint])?'], { encoding: 'utf8' })
    assert.equal(hostKey.status, 0)
    assert.equal(hostKey.stdout.trim(), 'yes', 'host-key confirmation answers yes')
    const password = spawnSync('sh', [path, "user@h.example.com's password:"], { encoding: 'utf8' })
    assert.equal(password.status, 0)
    assert.equal(password.stdout, "s3cr't\n", 'password prompt answers the stored password (line-terminated)')
    const passphrase = spawnSync('sh', [path, "Enter passphrase for key '/Users/x/.ssh/id_ed25519':"], { encoding: 'utf8' })
    assert.equal(passphrase.stdout, "s3cr't\n", 'key passphrase prompts reuse the stored password')
    // The helper file is 0600 (owner-only).
    assert.equal(statSync(path).mode & 0o777, 0o600, 'helper is 0600')
  } finally {
    rmSync(path, { force: true })
  }
})

test('createAskpassHelper refuses instance ids outside the registry whitelist', () => {
  assert.throws(() => createAskpassHelper('bad/id', 'pw'), /invalid instance id/)
  assert.throws(() => createAskpassHelper('../escape', 'pw'), /invalid instance id/)
})

test('setSshPassword/getSshPassword round-trip and clear (empty string and null both clear)', () => {
  setSshPassword('t-store-1', 'pw')
  assert.equal(getSshPassword('t-store-1'), 'pw')
  setSshPassword('t-store-1', '')
  assert.equal(getSshPassword('t-store-1'), null, "'' clears")
  setSshPassword('t-store-1', 'pw2')
  setSshPassword('t-store-1', null)
  assert.equal(getSshPassword('t-store-1'), null, 'null clears')
})

test('sshAuthEnv returns the askpass env only when a password is stored', () => {
  setSshPassword('t-env-1', 'pw')
  try {
    const env = sshAuthEnv(spec('t-env-1'))
    assert.ok(env !== null, 'a stored password yields an askpass env')
    assert.equal(env!.SSH_ASKPASS_REQUIRE, 'force', 'askpass is forced (no TTY needed)')
    assert.ok(typeof env!.SSH_ASKPASS === 'string' && env!.SSH_ASKPASS.length > 0)
    assert.ok(existsSync(env!.SSH_ASKPASS!), 'the helper exists before the spawn')
    assert.equal(sshAuthEnv(spec('t-env-2')), null, 'no stored password = key/agent auth (null env)')
  } finally {
    setSshPassword('t-env-1', null)
    disposeSshAuth(spec('t-env-1'))
    disposeSshAuth(spec('t-env-2'))
  }
})

test('disposeSshAuth deletes the ephemeral askpass helper', () => {
  setSshPassword('t-env-3', 'pw')
  try {
    const env = sshAuthEnv(spec('t-env-3'))
    assert.ok(env !== null && env!.SSH_ASKPASS !== undefined)
    const path = env!.SSH_ASKPASS
    assert.ok(existsSync(path))
    disposeSshAuth(spec('t-env-3'))
    assert.ok(!existsSync(path), 'helper is deleted on dispose')
    // A later sshAuthEnv (reconnect) writes a FRESH helper.
    const next = sshAuthEnv(spec('t-env-3'))
    assert.ok(next !== null && next!.SSH_ASKPASS !== path, 'a fresh helper replaces the disposed one')
  } finally {
    setSshPassword('t-env-3', null)
    disposeSshAuth(spec('t-env-3'))
  }
})

test('sshPasswordSupported is false on win32 (askpass unreliability gate)', () => {
  assert.equal(sshPasswordSupported(), process.platform !== 'win32')
})

test('configureSshPasswordStore persists to and reloads from the plaintext file (0600, atomic)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    assert.equal(configureSshPasswordStore(file), null, 'missing file = first run, no notice')
    setSshPassword('t-file-1', 'pw-1')
    setSshPassword('t-file-2', 'pw-2')
    assert.ok(existsSync(file), 'file is written on the first set')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'password file is 0600')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { passwords: Record<string, string> }
    assert.equal(parsed.passwords['t-file-1'], 'pw-1')
    assert.equal(parsed.passwords['t-file-2'], 'pw-2')
    // Simulate a restart: reconfigure away (clears the memory map), reload.
    configureSshPasswordStore(null)
    assert.equal(getSshPassword('t-file-1'), null, 'memory cleared by reconfiguration')
    assert.equal(configureSshPasswordStore(file), null, 'reload is clean')
    assert.equal(getSshPassword('t-file-1'), 'pw-1', 'password survives a restart via the file')
    assert.equal(getSshPassword('t-file-2'), 'pw-2')
    // Explicit clear removes the entry from the file too.
    setSshPassword('t-file-1', null)
    const afterClear = JSON.parse(readFileSync(file, 'utf8')) as { passwords: Record<string, string> }
    assert.equal(afterClear.passwords['t-file-1'], undefined, 'cleared entry leaves the file')
    assert.equal(afterClear.passwords['t-file-2'], 'pw-2', 'other entries stay')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt password file is preserved as *.corrupt and fails loud, never silent-empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(file, '{not json')
    const notice = configureSshPasswordStore(file)
    assert.ok(notice !== null && notice.includes('.corrupt'), 'corrupt file reports loudly')
    assert.ok(existsSync(`${file}.corrupt`), 'corrupt file is preserved for forensics')
    assert.equal(getSshPassword('anything'), null, 'store starts empty after a corrupt file')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- design 13 §7.2 exec whitelist tests (M1) ---

function specWithHome(id: string, remoteDshHome: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome }
}

test('buildRemoteExecArgv accepts a whitelisted dsh plugin add/remove', () => {
  assert.deepEqual(
    buildRemoteExecArgv(spec('w1'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', '@scope/name@^1.2.3'] }),
    ['dsh', 'plugin', '--profile', 'web', 'add', '@scope/name@^1.2.3'],
  )
  assert.deepEqual(
    buildRemoteExecArgv(spec('w1'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'remove', 'name'] }),
    ['dsh', 'plugin', '--profile', 'web', 'remove', 'name'],
  )
})

test('buildRemoteExecArgv prepends DSH_HOME when remoteDshHome is set', () => {
  assert.deepEqual(
    buildRemoteExecArgv(specWithHome('w2', '/opt/dsh'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'name@1.2.3'] }),
    ['DSH_HOME=/opt/dsh', 'dsh', 'plugin', '--profile', 'web', 'add', 'name@1.2.3'],
  )
})

test('buildRemoteExecArgv refuses injection / non-registry specs', () => {
  const bad = [
    '-oProxyCommand=x',
    'name;rm -rf /',
    'name|cat /etc/passwd',
    'name>out',
    'name<in',
    'name*',
    "name'$(x)'",
    'git+https://github.com/a/b',
    'file:../pkg',
    'name@>=1.0.0 <2.0.0',
    'name@1.2.3 || 2.0.0',
    'npm:alias@1.0.0',
  ]
  for (const s of bad) {
    assert.equal(buildRemoteExecArgv(spec('w3'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', s] }), null, `refuses ${JSON.stringify(s)}`)
  }
})

test('buildRemoteExecArgv refuses wrong dsh argv structure', () => {
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'update', 'name'] }), null, 'refuses non-whitelisted action')
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add'] }), null, 'refuses missing spec')
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['other', '--profile', 'web', 'add', 'name'] }), null, 'refuses wrong subcommand')
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'remove', 'name@1.2.3'] }), null, 'remove refuses @version')
})

test('buildRemoteExecArgv allows only the two whitelisted cat paths', () => {
  assert.deepEqual(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/package.json'] }), ['cat', '~/.dsh/profiles/web/package.json'])
  assert.deepEqual(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/cordis.patch.yml'] }), ['cat', '~/.dsh/profiles/web/cordis.patch.yml'])
  assert.equal(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['/etc/passwd'] }), null, 'refuses arbitrary cat path')
  assert.equal(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/package.json', 'extra'] }), null, 'refuses extra argv')
})

test('resolveWriteTarget allows the three prefixes and rejects traversal', () => {
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh-chamber/plugins/pkg-abc123.tgz'), '~/.dsh-chamber/plugins/pkg-abc123.tgz')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/dist/index.js'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/dist/index.js')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/web/cordis.patch.yml'), '~/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(resolveWriteTarget(spec('w6'), '/etc/passwd'), null, 'refuses arbitrary path')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh-chamber/plugins/../evil.tgz'), null, 'refuses dot-dot')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/web/package.json'), null, 'refuses non-whitelisted profile file')
})

test('resolveWriteTarget honors a custom remoteDshHome', () => {
  assert.equal(resolveWriteTarget(specWithHome('w7', '/opt/dsh'), '/opt/dsh/profiles/web/cordis.patch.yml'), '/opt/dsh/profiles/web/cordis.patch.yml')
  assert.equal(resolveWriteTarget(specWithHome('w7', '/opt/dsh'), '~/.dsh/profiles/web/cordis.patch.yml'), null, 'default-home path rejected when a custom home is set')
})

test('resolveWriteTarget rejects traversal inside the seed subtree (shared SEED_RELATIVE_PATTERN)', () => {
  const seed = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'
  assert.equal(resolveWriteTarget(spec('w7b'), seed), seed)
  assert.equal(
    resolveWriteTarget(spec('w7b'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/../../etc/passwd'),
    null,
    'dot-dot escapes the seed subtree',
  )
  assert.equal(
    resolveWriteTarget(spec('w7b'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/./package.json'),
    null,
    'self-segment is refused too',
  )
})

test('buildRemoteExecArgv accepts the fixed printf $HOME lookup (materialize remote-home resolution)', () => {
  assert.deepEqual(
    buildRemoteExecArgv(spec('w8'), { op: 'exec', command: 'printf', argv: ['%s', '$HOME'] }),
    ['printf', '%s', '$HOME'],
  )
  assert.equal(buildRemoteExecArgv(spec('w8'), { op: 'exec', command: 'printf', argv: ['%s', 'HOME'] }), null, 'refuses any argv other than the fixed form')
  assert.equal(buildRemoteExecArgv(spec('w8'), { op: 'exec', command: 'printf', argv: ['$HOME', '%s'] }), null)
})

test('buildRemoteExecArgv allows the converged seed-subtree cat read (seed hash-skip)', () => {
  const seedPkg = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [seedPkg] }), ['cat', seedPkg])
  const seedDist = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/dist/index.js'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [seedDist] }), ['cat', seedDist])
  const gitWorktreeDist = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/dist/index.js'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [gitWorktreeDist] }), ['cat', gitWorktreeDist])
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

test('buildRemoteExecArgv accepts the materialize file: add spec, constrained to the materialize dir', () => {
  const ok = buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/home/u/.dsh-chamber/plugins/pkg-a1b2c3d4.tgz'] })
  assert.deepEqual(ok, ['dsh', 'plugin', '--profile', 'web', 'add', 'file:/home/u/.dsh-chamber/plugins/pkg-a1b2c3d4.tgz'])
  // the normalized scoped-name filename form
  assert.ok(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/home/u/.dsh-chamber/plugins/scope-name-a1b2.tgz'] }) !== null)
  // everything else stays refused — plain registry add must still pass untouched
  assert.ok(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'pkg@^1.0.0'] }) !== null)
  assert.equal(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/etc/passwd'] }), null, 'absolute path outside the materialize dir refused')
  assert.equal(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:~/x.tgz'] }), null, '~ mid-word never accepted')
  assert.equal(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/tmp/evil.tgz'] }), null, 'outside .dsh-chamber/plugins refused')
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

/** Minimal TransportExecDeps driving the provider's `run` channel. */
function runDeps(spawnFn: TransportExecDeps['spawnFn']): TransportExecDeps {
  const projection: TransportStatusProjection = {
    kind: 'ssh', phase: 'idle', localPort: null, sshPort: null, remotePort: 3080,
    retryAttempt: 0, requiresUserAction: false, serviceActive: null, remoteDshHome: null,
    logSummary: '',
  }
  return {
    spawnFn,
    execTimeoutMs: 5_000,
    runTimeoutMs: 5_000,
    disconnectGraceMs: 100,
    log: () => {},
    setProjection: () => {},
    projection: () => projection,
  }
}

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
    if (remoteArgv[0] === 'cat') {
      const path = remoteArgv[1] as string
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
  // view must NOT be what the hash is computed over (the pre-fix code hashed
  // the string, so this content always failed with U+FFFD corruption).
  const content = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x81, 0x82, 0x00, 0x01])
  const sha256 = createHash('sha256').update(content).digest('hex')
  const result = await sshProvider.exec!(spec('wf1'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path: '~/.dsh-chamber/plugins/pkg-abc123.tgz',
    contentBase64: content.toString('base64'),
    sha256,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // The fake host stored the decoded bytes verbatim; the write command was a
  // single fixed `mkdir -p … && base64 -d > …` shell template.
  assert.ok(remote.files.get('~/.dsh-chamber/plugins/pkg-abc123.tgz')!.equals(content))
  assert.equal(remote.spawns.length, 2, 'one write spawn + one cat read-back spawn')
  assert.ok(remote.spawns[0].args[1].startsWith('mkdir -p ~/.dsh-chamber/plugins && base64 -d > '))
  // The raw captured bytes ride the result; the string view is lossy (U+FFFD)
  // for binary content — proving the byte-domain verification path.
  assert.ok(result.stdoutBytes !== undefined && result.stdoutBytes.equals(content))
  assert.ok(result.stdout!.includes('\uFFFD'), 'the UTF-8 view is lossy for binary content')
})

test('write-file: a tampered read-back fails loud (never a fake success)', async () => {
  const remote = makeRemoteHost()
  const content = Buffer.from('hello')
  const path = '~/.dsh-chamber/plugins/pkg-abc123.tgz'
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
    path: '~/.dsh-chamber/plugins/pkg-abc123.tgz',
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
    path: '~/.dsh-chamber/plugins/pkg-abc123.tgz',
    contentBase64: big.toString('base64'),
    sha256: createHash('sha256').update(big).digest('hex'),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /exceeds the .*byte limit/)
  assert.equal(remote.spawns.length, 0, 'no ssh process may spawn for an oversized write')
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
    argv: ['~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'],
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
  assert.ok(
    !logs.some(entry => entry.message.includes('No such file or directory')),
    'no raw-stderr INFO echo for a quiet run',
  )
})

test('run: a QUIET ENOENT probe under a `.ssh`-named home stays ENOENT-classified (redacted display still hides the path)', async () => {
  // A whitelist-valid remoteDshHome like /root/.ssh-custom (design 13 §7.2)
  // makes redactSshStderr replace the whole ENOENT line with the redacted
  // summary — the absent-file signal must survive (classified on the RAW
  // stderr), so the plugin-sync caller still reads "file absent", never a
  // loud ssh failure — while the display text still hides the path.
  const spawnFn = (_command: string, _args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    setImmediate(() => {
      child.stderrWrite('cat: /root/.ssh-custom/profiles/web/package.json: No such file or directory\n')
      child.simulateExit(1)
    })
    return child
  }
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

test('run: a QUIET exec with an auth failure stays LOUD (ERROR log + authentication-failure result)', async () => {
  // quiet suppresses EXPECTED failures only (ENOENT probes) — an auth failure
  // is never expected, so it must still log the ERROR line and return the
  // authentication-failure result, never a generic quieted failure.
  const spawnFn = (_command: string, _args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    setImmediate(() => {
      child.stderrWrite('Permission denied (publickey).\n')
      child.simulateExit(255)
    })
    return child
  }
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
  const spawnFn = (_command: string, _args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    setImmediate(() => {
      child.stderrWrite('Load key "/Users/alice/.ssh/id_ed25519": invalid format\n')
      child.simulateExit(1)
    })
    return child
  }
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
