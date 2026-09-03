/**
 * Win32-only lifecycle integration tests for the Windows process probes
 * (design 02 §5.1 parity work, M1). These SELF-SKIP on POSIX hosts and run
 * only on the Windows CI leg: they spawn real detached process trees and
 * exercise CIM identity, netstat port ownership, residual-tree discovery and
 * taskkill /T /F tree termination against the real Windows tooling.
 *
 * Fixture-generation note (audit fix, 2026): every path embedded into the
 * generated child script goes through JSON.stringify — a raw Windows
 * tmpdir path (`C:\Users\…\Temp\…`) interpolated into a single-quoted JS
 * literal would be parsed as escape sequences (`\U`, `\r`, …) and silently
 * corrupt the marker path (the tree then never writes its marker and the
 * test times out).
 *
 * Run directly: node packages/control-plane/test/win32-lifecycle.integration.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  hasWindowsResidualTree,
  treeKillWindows,
  windowsIdentity,
  windowsPortOwnedBy,
} from '../src/win-probes.ts'

const CHILD_MARKER = '__dsh_win_probe_child_ready__'
const GRANDCHILD_MARKER = '__dsh_win_probe_grandchild_ready__'

function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      try {
        if (readFileSync(file, 'utf8').length > 0) {
          resolve()
          return
        }
      } catch {
        // not written yet
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${file}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function waitFor(probe: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return probe()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test(
  'win32 lifecycle: CIM identity, netstat ownership, residual tree and taskkill tree kill',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-win-probe-'))
    const markerFile = join(dir, 'child.marker')
    const grandchildMarker = join(dir, 'grandchild.marker')
    const scriptFile = join(dir, 'tree-child.cjs')
    // JSON.stringify is load-bearing: it emits double-quoted literals with
    // correct backslash escaping, so Windows tmpdir paths survive verbatim
    // inside the generated script (both file literals and spawn argv).
    const q = (value: string): string => JSON.stringify(value)
    const grandchildCode =
      `require('node:fs').writeFileSync(process.argv[1], ${q(GRANDCHILD_MARKER)}); setInterval(() => {}, 1000)`
    writeFileSync(
      scriptFile,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        // The grandchild outlives nothing: it writes its own marker and sleeps.
        `const grandchild = spawn(process.execPath, ['-e', ${q(grandchildCode)}, ${q(grandchildMarker)}], { detached: true, windowsHide: true, stdio: 'ignore' });`,
        `writeFileSync(${q(markerFile)}, '${CHILD_MARKER} ' + grandchild.pid);`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    )
    const children: number[] = []
    const child = spawn(process.execPath, [scriptFile], { detached: true, windowsHide: true, stdio: 'ignore' })
    const childPid = child.pid
    assert.ok(childPid !== undefined, 'child spawned')
    children.push(childPid)
    t.after(() => {
      for (const pid of children) {
        try { treeKillWindows(pid) } catch { /* best-effort cleanup */ }
      }
      rmSync(dir, { recursive: true, force: true })
    })
    await waitForFile(markerFile, 15_000)
    const grandchildPid = Number(readFileSync(markerFile, 'utf8').split(' ')[1])
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `grandchild pid readable (${grandchildPid})`)
    children.push(grandchildPid)
    await waitForFile(grandchildMarker, 15_000)

    // CIM identity: the grandchild's stale parent chain still names the child.
    const grandchildIdentity = windowsIdentity(grandchildPid)
    assert.equal(grandchildIdentity.ppid, String(childPid), 'CIM ParentProcessId matches the direct parent')
    assert.ok(grandchildIdentity.command.length > 0, 'CIM CommandLine is readable for a same-elevation child')
    const childIdentity = windowsIdentity(childPid)
    assert.equal(childIdentity.ppid, String(process.pid), 'CIM ParentProcessId matches the test process')

    // Netstat ownership: this process owns a real listening socket.
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const port = address.port
    t.after(() => { server.close() })
    assert.equal(windowsPortOwnedBy(process.pid, port), true, 'netstat credits the listening pid')
    assert.equal(windowsPortOwnedBy(1, port), false, 'netstat does not credit an unrelated pid')

    // Residual tree: the child has a live grandchild descendant.
    assert.equal(hasWindowsResidualTree(childPid), true, 'live descendant detected')

    // taskkill /T /F kills the whole tree at once.
    assert.equal(treeKillWindows(childPid), true, 'first kill signals the tree')
    const bothGone = await waitFor(() => !alive(childPid) && !alive(grandchildPid), 10_000)
    assert.equal(bothGone, true, 'leader and descendant are gone after the tree kill')
    assert.equal(hasWindowsResidualTree(childPid), false, 'no residual descendants remain')
    assert.equal(treeKillWindows(childPid), false, 'a second kill reports nothing to signal (gone)')
    assert.equal(treeKillWindows(grandchildPid), false, 'gone applies to the dead descendant too')
  },
)
