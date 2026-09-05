import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROBE_NAMES_WITHOUT_HOST_DOMAINS, REQUIRED_ACTIVATION_PROBES } from '../src/activation-gate.ts'
import {
  SETTINGS_FILE_MAX_BYTES,
  runRuntimeActivationProbes,
  type RuntimeProbeCall,
} from '../src/runtime-probes.ts'

interface Fixture {
  root: string
  dshHome: string
  settingsPath: string
  calls: Array<{ method: string; payload: unknown }>
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-probes-'))
  const dshHome = join(dir, 'dsh-home')
  mkdirSync(dshHome)
  const settingsPath = join(dshHome, 'settings.yaml')
  writeFileSync(settingsPath, 'locale:\n  preference: zh\n')
  return { root: dir, dshHome, settingsPath, calls: [] }
}

function successfulValue(method: string): unknown {
  if (method === 'session/canOpenWorkspacePath') return true
  if (method === 'clientGraph/graph') return { rev: 1, entries: [] }
  if (method === 'settings/describe') return { writable: true, namespaces: [] }
  if (method === 'gitWorktree/previewCreate') {
    return { ok: false, error: { code: 'invalid-input', message: 'input.sourceWorkspaceId is required' } }
  }
  return {}
}

function successfulCall(fx: Fixture): RuntimeProbeCall {
  return async (_base, method, payload, options) => {
    fx.calls.push({ method, payload })
    assert.ok((options?.timeoutMs ?? 0) > 0)
    assert.equal(options?.signal?.aborted, false)
    if (method === 'commands/execute') {
      const error = new Error('missing probe session') as Error & { code: string }
      error.code = 'session/not-found'
      throw error
    }
    return { result: { value: successfulValue(method) } }
  }
}

test('real probe runner executes the closed read-only set with bounded RPCs', async () => {
  const fx = fixture()
  try {
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call: successfulCall(fx),
      windowMs: 1_000,
      rpcTimeoutMs: 100,
    })
    assert.deepEqual(results.map(result => result.name), [...REQUIRED_ACTIVATION_PROBES])
    assert.ok(results.every(result => result.ok))
    const command = fx.calls.find(entry => entry.method === 'commands/execute')
    assert.deepEqual(command?.payload, {
      args: {
        agentId: '__dsh_chamber_missing_session_probe__',
        line: 'dsh-chamber-activation-probe',
        images: [],
      },
    })
    assert.deepEqual(fx.calls.find(entry => entry.method === 'session/canOpenWorkspacePath')?.payload, { args: {} })
    assert.deepEqual(fx.calls.find(entry => entry.method === 'settings/describe')?.payload, { args: {} })
    assert.deepEqual(fx.calls.find(entry => entry.method === 'clientGraph/graph')?.payload, { args: {} })
    assert.deepEqual(fx.calls.find(entry => entry.method === 'gitWorktree/previewCreate')?.payload, { args: { input: {} } })
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})
test('the identity probe accepts value false; the closed set never reads session data', async () => {
  // 2026 probe-contract: value true AND value false are both healthy — only
  // method presence / protocol / controller assembly are under test, and no
  // probe may re-read the session list (its response grows with session data).
  const fx = fixture()
  try {
    const call: RuntimeProbeCall = async (_base, method) => {
      fx.calls.push({ method, payload: {} })
      if (method === 'commands/execute') {
        const error = new Error('missing probe session') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'session/canOpenWorkspacePath') return { result: { value: false } }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({ baseUrl: 'http://127.0.0.1:17510', dshHome: fx.dshHome, call })
    assert.ok(results.every(result => result.ok))
    // The session list must never be read by the probe layer.
    assert.equal(fx.calls.some(entry => entry.method === 'session/list'), false)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('settings/describe rides a per-call 16 MiB response cap (aligned with SETTINGS_FILE_MAX_BYTES)', async () => {
  const fx = fixture()
  try {
    const seenCaps = new Map<string, number>()
    const call: RuntimeProbeCall = async (_base, method, _payload, options) => {
      seenCaps.set(method, options?.maxResponseBytes ?? 0)
      if (method === 'commands/execute') {
        const error = new Error('missing probe session') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({ baseUrl: 'http://127.0.0.1:17510', dshHome: fx.dshHome, call })
    assert.ok(results.every(result => result.ok))
    // Only settings/describe gets the widened cap; every other probe keeps
    // the carrier's default (0 = no per-call cap passed).
    assert.equal(seenCaps.get('settings/describe'), SETTINGS_FILE_MAX_BYTES)
    assert.equal(seenCaps.get('session/canOpenWorkspacePath'), 0)
    assert.equal(seenCaps.get('clientGraph/graph'), 0)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('identity 404 falls back to the legacy session/list probe and fires the warn sink', async () => {
  const fx = fixture()
  const warnings: string[] = []
  try {
    const call: RuntimeProbeCall = async (_base, method, _payload, _options) => {
      fx.calls.push({ method, payload: {} })
      if (method === 'commands/execute') {
        const error = new Error('missing probe session') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'session/canOpenWorkspacePath') {
        // A carrier 404 = the runtime tree does not register the identity
        // method (the control-plane unary client attaches status to its
        // transport errors).
        const error = new Error('not found') as Error & { status?: number }
        error.status = 404
        throw error
      }
      if (method === 'session/list') return { result: { value: { items: [{ sessionId: 's1' }] } } }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call,
      warn: line => warnings.push(line),
    })
    // The probe row keeps the identity-method name and passes via the legacy
    // fallback — old-tree activation/rollback stays exactly as before.
    const session = results.find(result => result.name === 'session/canOpenWorkspacePath')
    assert.equal(session?.ok, true)
    assert.equal(fx.calls.some(entry => entry.method === 'session/list'), true, 'legacy fallback ran')
    assert.equal(warnings.length, 1, 'the legacy fallback is never silent')
    assert.match(warnings[0], /404/)
    assert.match(warnings[0], /session\/list/)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('identity 404 with a failing legacy fallback fails the probe row (no silent downgrade)', async () => {
  const fx = fixture()
  const warnings: string[] = []
  try {
    const call: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        const error = new Error('missing probe session') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'session/canOpenWorkspacePath' || method === 'session/list') {
        const error = new Error('not found') as Error & { status?: number }
        error.status = 404
        throw error
      }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call,
      warn: line => warnings.push(line),
    })
    const session = results.find(result => result.name === 'session/canOpenWorkspacePath')
    assert.equal(session?.ok, false)
    // The double-404 row carries the explicit combined message (no raw
    // carrier text, no paths — closed constant wording).
    assert.match(session?.error ?? '', /neither session\/canOpenWorkspacePath nor the legacy session\/list method is registered \(HTTP 404\)/)
    assert.equal(warnings.length, 0, 'a fallback that did not succeed never warns')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('identity 404 with a legacy answer lacking the {items} list fails the row (old shape check restored)', async () => {
  // The pre-migration session/list activation row rejected a value without
  // the {items} session list ('malformed session list'); the legacy fallback
  // restores that check — an ok:true envelope without the list is a damaged
  // host, not a healthy old tree, and the fallback warn never fires.
  const fx = fixture()
  const warnings: string[] = []
  try {
    const call: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        const error = new Error('missing probe session') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'session/canOpenWorkspacePath') {
        const error = new Error('not found') as Error & { status?: number }
        error.status = 404
        throw error
      }
      if (method === 'session/list') return { result: { value: { ok: true } } }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call,
      warn: line => warnings.push(line),
    })
    const session = results.find(result => result.name === 'session/canOpenWorkspacePath')
    assert.equal(session?.ok, false, 'a legacy answer without items must fail the row')
    assert.match(session?.error ?? '', /malformed session list/)
    assert.equal(warnings.length, 0, 'a fallback that did not succeed never warns')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('identity 404 with a legacy 503 failure propagates the carrier error (no warn)', async () => {
  const fx = fixture()
  const warnings: string[] = []
  try {
    const call: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        const error = new Error('missing probe session') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'session/canOpenWorkspacePath') {
        const error = new Error('not found') as Error & { status?: number }
        error.status = 404
        throw error
      }
      if (method === 'session/list') {
        const error = new Error('service down') as Error & { status?: number }
        error.status = 503
        throw error
      }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call,
      warn: line => warnings.push(line),
    })
    const session = results.find(result => result.name === 'session/canOpenWorkspacePath')
    assert.equal(session?.ok, false)
    assert.match(session?.error ?? '', /service down/)
    assert.equal(warnings.length, 0, 'only a SUCCESSFUL legacy fallback warns')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a non-404 identity failure never downgrades to the legacy session-data probe', async () => {
  const fx = fixture()
  try {
    const call: RuntimeProbeCall = async (_base, method) => {
      fx.calls.push({ method, payload: {} })
      if (method === 'commands/execute') {
        const error = new Error('missing probe session') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'session/canOpenWorkspacePath') {
        const error = new Error('gated') as Error & { status?: number }
        error.status = 401
        throw error
      }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({ baseUrl: 'http://127.0.0.1:17510', dshHome: fx.dshHome, call })
    assert.equal(results.find(result => result.name === 'session/canOpenWorkspacePath')?.ok, false)
    assert.equal(fx.calls.some(entry => entry.method === 'session/list'), false, '401 never falls back')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})


test('hostDomains=false returns the reduced set and never invokes the chamber host domains (2026-12 shape)', async () => {
  const fx = fixture()
  try {
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call: successfulCall(fx),
      windowMs: 1_000,
      rpcTimeoutMs: 100,
      hostDomains: false,
    })
    // Exactly the reduced set, in contract order — no synthetic rows.
    assert.deepEqual(results.map(result => result.name), [...PROBE_NAMES_WITHOUT_HOST_DOMAINS])
    assert.ok(results.every(result => result.ok))
    // The chamber host domains must never be invoked in this shape.
    assert.equal(fx.calls.some(entry => entry.method === 'clientGraph/graph'), false)
    assert.equal(fx.calls.some(entry => entry.method === 'gitWorktree/previewCreate'), false)
    // The rest of the closed set still runs.
    assert.ok(fx.calls.some(entry => entry.method === 'session/canOpenWorkspacePath'))
    assert.ok(fx.calls.some(entry => entry.method === 'settings/describe'))
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a malformed identity value and unreadable settings fail explicit probes', async () => {
  const fx = fixture()
  try {
    writeFileSync(fx.settingsPath, Buffer.from([0xff]))
    const call: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        const error = new Error('missing') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'session/canOpenWorkspacePath') return { result: { value: {} } }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({ baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call })
    const failed = new Set(results.filter(result => !result.ok).map(result => result.name))
    assert.ok(failed.has('session/canOpenWorkspacePath'))
    assert.ok(failed.has('data.settings'))
    assert.equal(results.find(result => result.name === 'commands/execute')?.ok, true)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('commands and git probes accept only their statically side-effect-free miss paths', async () => {
  const fx = fixture()
  try {
    const call: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        return { result: { value: { commandId: 'unexpected-execution' } } }
      }
      if (method === 'gitWorktree/previewCreate') {
        return { result: { value: { ok: true, value: { previewToken: 'unexpected' } } } }
      }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call,
    })
    assert.equal(results.find(result => result.name === 'commands/execute')?.ok, false)
    assert.equal(results.find(result => result.name === 'gitWorktree/previewCreate')?.ok, false)

    const wrongBusinessCode: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        const error = new Error('generic miss') as Error & { code: string }
        error.code = 'not_found'
        throw error
      }
      return { result: { value: successfulValue(method) } }
    }
    const wrongCodeResults = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call: wrongBusinessCode,
    })
    assert.equal(wrongCodeResults.find(result => result.name === 'commands/execute')?.ok, false)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('settings.yaml size is rejected from fstat before any unbounded read', async () => {
  const fx = fixture()
  try {
    // Sparse growth avoids allocating the attacker-controlled file size in the test too.
    truncateSync(fx.settingsPath, SETTINGS_FILE_MAX_BYTES + 1)
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call: successfulCall(fx),
    })
    const settings = results.find(result => result.name === 'data.settings')
    assert.equal(settings?.ok, false)
    assert.match(settings?.error ?? '', /unexpectedly large/)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('settings.yaml rejects directories and symlinks instead of following non-regular inputs', async () => {
  for (const kind of ['directory', 'symlink'] as const) {
    const fx = fixture()
    try {
      rmSync(fx.settingsPath)
      if (kind === 'directory') {
        mkdirSync(fx.settingsPath)
      } else {
        const target = join(fx.root, 'outside-settings.yaml')
        writeFileSync(target, 'locale: {}\n')
        symlinkSync(target, fx.settingsPath)
      }
      const results = await runRuntimeActivationProbes({
        baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call: successfulCall(fx),
      })
      assert.equal(results.find(result => result.name === 'data.settings')?.ok, false, kind)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  }
})

test('probe layer enforces per-RPC and whole-window timeouts when call ignores its signal', async () => {
  const fx = fixture()
  try {
    const never: RuntimeProbeCall = () => new Promise(() => {})
    const startedAt = Date.now()
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1',
      dshHome: fx.dshHome,
      call: never,
      windowMs: 80,
      rpcTimeoutMs: 10,
    })
    assert.ok(Date.now() - startedAt < 500, 'ignored AbortSignal must not hang the runner')
    for (const name of [
      'commands/execute', 'session/canOpenWorkspacePath',
      'clientGraph/graph', 'settings/describe', 'gitWorktree/previewCreate',
    ]) {
      assert.equal(results.find(result => result.name === name)?.ok, false, name)
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a pre-aborted whole-window signal prevents every RPC invocation', async () => {
  const fx = fixture()
  try {
    const controller = new AbortController()
    controller.abort(new Error('cancel before probe'))
    let calls = 0
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1',
      dshHome: fx.dshHome,
      signal: controller.signal,
      call: async () => {
        calls += 1
        return { result: { value: {} } }
      },
    })
    assert.equal(calls, 0)
    assert.ok(results.every(result => !result.ok))
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('settings errors are path-redacted and projected error text is bounded', async () => {
  const fx = fixture()
  try {
    rmSync(fx.settingsPath)
    const call: RuntimeProbeCall = async (_base, method) => {
      if (method === 'session/canOpenWorkspacePath') {
        throw new Error(`failed at '${fx.root}/Secret Folder/${'x'.repeat(4_000)}'`)
      }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call,
    })
    const hostError = results.find(result => result.name === 'session/canOpenWorkspacePath')?.error ?? ''
    const settingsError = results.find(result => result.name === 'data.settings')?.error ?? ''
    assert.ok(hostError.length <= 2_000)
    assert.equal(hostError.includes(fx.root), false)
    assert.match(hostError, /\[path\]/)
    assert.equal(settingsError.includes(fx.root), false)
    assert.match(settingsError, /^settings\.yaml could not be opened(?: \([A-Z0-9_]+\))?$/)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('timeout options reject fractional and timer-overflow values', async () => {
  const fx = fixture()
  try {
    await assert.rejects(runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call: successfulCall(fx), windowMs: 1.5,
    }), /timer-safe integer/)
    await assert.rejects(runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call: successfulCall(fx), rpcTimeoutMs: 2_147_483_648,
    }), /timer-safe integer/)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})
