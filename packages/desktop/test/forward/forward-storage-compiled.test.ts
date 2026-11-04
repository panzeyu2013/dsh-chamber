/**
 * Compiled-control-plane storage path (packaged sidecar shape).
 *
 * The source-path default-storage test uses the workspace control-plane through
 * the pnpm link. This test sets DSH_CHAMBER_SIDECAR_COMPILED=1 so
 * control-plane-module resolves ./dist/control-plane/index.js — the artifact the
 * Swift sidecar ships — and exercises the real 0600 stores through it. Skip when
 * the artifact is absent (a plain test run without build:control-plane).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_CHAMBER_SIDECAR_COMPILED = '1'

const { createRemoteForwardService } = await import('../../remote-forward-service.ts')
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'
import type { ForwardPortAllocator, ForwardListenerProbe } from '../../remote-forward-manager.ts'
import type { ForwardSpawnProcessHandle } from '../../remote-forward-service.ts'

const SOURCE_ID = 'dsh-web-1'
const FINGERPRINT = 'a'.repeat(64)
const ARTIFACT = new URL('../../dist/control-plane/index.js', import.meta.url)

function makeContext(dir: string, instance: TransportInstanceSpec): ShellIpcCtx {
  const deps = {
    ipc: { handle: (): void => {} },
    ctx: {
      localDshHome: path.join(dir, 'state', 'dsh-home'),
      transportManager: { listInstances: () => [instance] },
    },
    edges: {
      openExternal: async (): Promise<void> => {},
      showMessage: async (): Promise<number> => 0,
    },
  }
  return {
    deps,
    captureVscodeSource: () => null,
    matchesNotificationSource: () => true,
    ownsNotificationSource: () => true,
  } as unknown as ShellIpcCtx
}

const ports: ForwardPortAllocator = {
  async isFree(): Promise<boolean> { return true },
  async ephemeral(): Promise<number> { return 40_000 },
}
const probe: ForwardListenerProbe = async (): Promise<boolean> => true

test('compiled control-plane: packaged storage creates owner-only files', {
  skip: !existsSync(ARTIFACT) ? 'dist/control-plane/index.js absent; run build:control-plane' : false,
}, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-forward-compiled-'))
  try {
    const instance: TransportInstanceSpec = {
      id: 'web-1', label: 'web-1', kind: 'dsh', transport: 'ssh',
      host: 'dev.example.com', user: 'root', sshPort: null, remotePort: 17520,
      serviceName: null, remoteDshHome: null, insecureHttp: false,
    }
    const child: ForwardSpawnProcessHandle = {
      pid: 4242,
      stderr: null,
      on: (): unknown => undefined,
      kill: (): boolean => true,
    }
    const service = createRemoteForwardService(makeContext(dir, instance), {
      dataDir: dir,
      ports,
      probe,
      spawn: () => child,
      startTime: async (): Promise<string> => 'linux:1',
      stopProcess: (): void => {},
      authLease: () => null,
      platform: 'linux',
      reapOnStart: false,
      probeTimeoutMs: 0,
      probeIntervalMs: 1,
    })
    const requested = await service.request({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port: 5173 })
    assert.equal(requested.ok, true, JSON.stringify(requested))
    if (!requested.ok) return
    for (const name of ['remote-browser-namespaces.json', 'forward-children.json', 'remote-browser-enabled.json']) {
      assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600, name + ' must be 0600')
    }
    await service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
