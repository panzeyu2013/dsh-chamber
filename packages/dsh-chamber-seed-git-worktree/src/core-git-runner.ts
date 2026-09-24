/**
 * The bounded child_process git runner.
 */
import { GitWorktreeError } from './core-errors.ts'
import type { GitChildProcess, GitCommandResult, GitRunner, GitSpawner } from './core-types.ts'
import { assertSafeGitArgv, fail, safeErrorMessage } from './core-validation.ts'
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

export const HOOK_GUARD: readonly string[] = ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`]

/** Default bounded, shell-free local Git runner. */
export function createLocalGitRunner(spawnGit: GitSpawner = spawn as unknown as GitSpawner): GitRunner {
  return request => new Promise<GitCommandResult>((resolvePromise, rejectPromise) => {
    try {
      if (!isAbsolute(request.cwd)) fail('unsafe-git-cwd', 'Git cwd must be absolute')
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60_000) {
        fail('unsafe-git-limit', 'Git timeout is outside the supported range')
      }
      if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1
        || request.maxOutputBytes > 4 * 1024 * 1024) {
        fail('unsafe-git-limit', 'Git output cap is outside the supported range')
      }
      assertSafeGitArgv(request.args)
    } catch (error) {
      rejectPromise(error)
      return
    }

    // Ambient GIT_DIR/GIT_WORK_TREE/etc. must not redirect an operation away from the
    // validated cwd: rebuild Git-specific variables from policy while retaining the rest.
    // GIT_OPTIONAL_LOCKS=0 suppresses only locks Git documents as optional.
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (key.startsWith('GIT_')) delete environment[key]
    }
    Object.assign(environment, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
      // Hook suppression is injected via the argv -c core.hooksPath guard (HOOK_GUARD),
      // not GIT_CONFIG_* env (lowest priority, overridden by a repo's own core.hooksPath).
      // Filters intentionally remain inside the trusted repository-config boundary.
      GCM_INTERACTIVE: 'never',
      LC_ALL: 'C',
    })

    let child: GitChildProcess
    try {
      child = spawnGit('git', [...HOOK_GUARD, ...request.args], {
        cwd: request.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: environment,
      })
    } catch (error) {
      rejectPromise(new GitWorktreeError('git-spawn-failed', safeErrorMessage(error)))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    let terminationError: unknown
    let timer: NodeJS.Timeout | undefined

    const rejectImmediately = (error: unknown): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      rejectPromise(error)
    }
    const terminateThenReject = (error: unknown): void => {
      if (settled || terminationError !== undefined) return
      terminationError = error
      if (timer !== undefined) clearTimeout(timer)
      // Do not release the caller's common-dir mutex until close proves the Git process
      // exited; filters may have descendants Git cannot portably group-kill.
      try {
        child.kill('SIGKILL')
      } catch {
        // Keep waiting for close: retaining an uncertain operation is safer than an unlocked repo.
      }
    }
    const append = (target: Buffer[], chunk: Buffer): void => {
      if (settled || terminationError !== undefined) return
      bytes += chunk.byteLength
      if (bytes > request.maxOutputBytes) {
        terminateThenReject(new GitWorktreeError('git-output-limit', 'Git output exceeded the bounded response limit'))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    // A spawn error proves no Git operation was admitted, so it rejects immediately.
    child.on('error', (error) => {
      if (terminationError !== undefined) return
      rejectImmediately(new GitWorktreeError('git-spawn-failed', safeErrorMessage(error)))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (terminationError !== undefined) {
        rejectPromise(terminationError)
        return
      }
      resolvePromise({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    timer = setTimeout(() => {
      terminateThenReject(new GitWorktreeError('git-timeout', `Git command exceeded ${request.timeoutMs}ms`))
    }, request.timeoutMs)
    timer.unref()
  })
}

/** One loaded agent row whose value drifted from what upstream declares: the row's
 *  `sessionId` plus the offending value, for a loud snapshot diagnostic. */
