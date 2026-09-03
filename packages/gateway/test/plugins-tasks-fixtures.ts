/**
 * Shared orchestrator-test fixtures (plugins-tasks.test.ts): tmp dirs, the
 * profile-manifest writer, and the injectable fake spawn (child/stream
 * twins of the plugins-exec.test.ts harness — kept here so both suites stay
 * independent). Bare helper file — not a test.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import type { SpawnFn, SpawnedChild, SpawnedProcessStream } from '../src/plugins-exec.ts'
import { INSTALLED_PROFILE_DIR, MANAGED_DSH_HOME_DIR } from '../src/plugins-installed.ts'

export function scratchDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Write the managed profile manifest at <dir>/dsh-home/profiles/web/. */
export function writeManifestFixture(stateDir: string, dependencies: Record<string, string>): void {
  const profileDir = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'web', version: '0.0.0', dependencies }, undefined, 2)}\n`, 'utf8')
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

class FakeStream extends EventEmitter {
  emitChunk(chunk: string): void {
    this.emit('data', Buffer.from(chunk, 'utf8'))
  }
}

export class FakeChild implements SpawnedChild {
  pid: number
  stdout: SpawnedProcessStream = new FakeStream()
  stderr: SpawnedProcessStream = new FakeStream()
  readonly signals: NodeJS.Signals[] = []
  readonly killTimes: number[] = []
  closeOnKill = false
  private readonly emitter = new EventEmitter()

  constructor(pid: number) {
    this.pid = pid
  }

  once(event: 'error' | 'close', listener: (...args: any[]) => void): void {
    this.emitter.once(event, listener as (...args: any[]) => void)
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    const resolved = (signal as NodeJS.Signals | undefined) ?? 'SIGTERM'
    this.signals.push(resolved)
    this.killTimes.push(Date.now())
    if (this.closeOnKill) queueMicrotask(() => this.close(null, resolved))
    return true
  }

  stderrLine(line: string): void {
    ;(this.stderr as FakeStream).emitChunk(`${line}\n`)
  }

  stdoutLine(line: string): void {
    ;(this.stdout as FakeStream).emitChunk(`${line}\n`)
  }

  error(error: Error): void {
    this.emitter.emit('error', error)
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emitter.emit('close', code, signal)
  }
}

export interface SpawnCall {
  command: string
  args: string[]
  options: SpawnOptions
  child: FakeChild
}

export function makeSpawnHarness(): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild(9000 + calls.length)
    calls.push({ command, args, options, child })
    return child
  }
  return { spawn, calls }
}
