/**
 * SSH stdin lifecycle (P0-2): a write-file payload must never crash main when the child is
 * already gone (EPIPE) or closes its stdin early, and a stdin failure must never mask the exit
 * classification (auth/host-key) or the timeout. The settlement priority is
 * exit > timeout > stdin failure; this suite drives the real provider surface
 * (sshProvider.exec 'run' -> write-file) against fake ssh children.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type { SpawnOptions } from 'node:child_process'
import type { SpawnedProcess } from '../../transport-provider.ts'
import { sshProvider } from '../../ssh-provider.ts'
import { runDeps, spec } from '../support/ssh-provider-run-deps.ts'

/** write-file target whitelist entry (the seed package manifest). */
const TARGET = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json'

/** A fake ssh child whose stdin is a real EventEmitter (so error/close can be emitted). */
class FakeStdinChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin: EventEmitter & { write(chunk: string | Buffer): unknown; end(): unknown }
  stdinWrites: Buffer[] = []
  stdinEnded = false
  killCalls: NodeJS.Signals[] = []
  constructor() {
    super()
    this.stdin = Object.assign(new EventEmitter(), {
      write: (chunk: string | Buffer) => { this.stdinWrites.push(Buffer.from(chunk)); return true },
      end: () => { this.stdinEnded = true },
    })
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal)
    return true
  }
  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal)
  }
  stderrWrite(text: string) {
    this.stderr.emit('data', Buffer.from(text))
  }
}

function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

function writeFilePayload() {
  const content = Buffer.from('hello')
  return {
    op: 'write-file' as const,
    path: TARGET,
    contentBase64: content.toString('base64'),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

test('a stdin EPIPE never masks the auth classification of a following exit 255', async () => {
  const child = new FakeStdinChild()
  const deps = runDeps((_command: string, _args: readonly string[], _options: SpawnOptions) => child)
  const resultPromise = sshProvider.exec!(spec('t-stdin-auth'), 'run', deps, writeFilePayload())
  setImmediate(() => {
    // EPIPE first, THEN the auth stderr + exit — the exit classification must win.
    child.stdin.emit('error', epipe())
    child.stderrWrite('Permission denied (publickey).\n')
    child.simulateExit(255)
  })
  const result = await resultPromise
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /authentication failure/)
  assert.equal(child.stdinWrites.length, 1, 'the payload was written exactly once')
  assert.equal(child.stdinEnded, true, 'stdin is ended even on the failure path')
})

test('a stdin EPIPE with a child that never exits resolves as the timeout', async () => {
  const child = new FakeStdinChild()
  const deps = runDeps((_command: string, _args: readonly string[], _options: SpawnOptions) => child)
  deps.runTimeoutMs = 25
  deps.disconnectGraceMs = 10
  const resultPromise = sshProvider.exec!(spec('t-stdin-timeout'), 'run', deps, writeFilePayload())
  setImmediate(() => { child.stdin.emit('error', epipe()) })
  const result = await resultPromise
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /timed out/)
  assert.ok(child.killCalls.includes('SIGTERM'), 'the timeout still signals the child')
})

test('a stdin failure is not reported as a delivered payload on an otherwise clean exit', async () => {
  const child = new FakeStdinChild()
  const deps = runDeps((_command: string, _args: readonly string[], _options: SpawnOptions) => child)
  const resultPromise = sshProvider.exec!(spec('t-stdin-clean'), 'run', deps, writeFilePayload())
  setImmediate(() => {
    child.stdin.emit('error', epipe())
    child.simulateExit(0)
  })
  const result = await resultPromise
  assert.equal(result.ok, false, 'exit 0 is not a failure classification, so stdin failure settles the run')
  if (!result.ok) assert.match(result.error, /stdin write failed: write EPIPE/)
})

test('a stdin close AFTER the payload write is normal completion', async () => {
  const writes: Buffer[] = []
  let spawnCount = 0
  const deps = runDeps((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    spawnCount += 1
    const child = new FakeStdinChild()
    if (spawnCount === 1) {
      // write-file: receive the payload, close stdin normally, exit 0.
      setImmediate(() => {
        writes.push(...child.stdinWrites)
        child.stdin.emit('close')
        child.simulateExit(0)
      })
    } else {
      // read-back cat: serve exactly what was written (verification passes).
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(writes.map(bytes => bytes.toString('utf8')).join(''), 'base64'))
        child.simulateExit(0)
      })
    }
    return child
  })
  const result = await sshProvider.exec!(spec('t-stdin-close'), 'run', deps, writeFilePayload())
  assert.equal(result.ok, true, 'a close after end() is completion, never a failure')
  assert.equal(spawnCount, 2, 'write + read-back')
  const decoded = Buffer.from(writes.map(bytes => bytes.toString('utf8')).join(''), 'base64').toString('utf8')
  assert.equal(decoded, 'hello')
})
