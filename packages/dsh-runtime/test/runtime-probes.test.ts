import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROBE_NAMES_WITHOUT_HOST_DOMAINS, REQUIRED_ACTIVATION_PROBES, activationProbeNamesForDomains } from '../src/activation-gate.ts'
import {
  PROBE_TEXT_KEEP_TOKENS,
  SETTINGS_FILE_MAX_BYTES,
  runRuntimeActivationProbes,
  type RuntimeProbeCall,
} from '../src/runtime-probes.ts'
import { sanitizeErrorText } from '../src/sanitize-error.ts'

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
  if (method === 'archiveCleanup/probe') {
    // Design 24 §7 C accept: a well-formed domain carrier with an object value.
    return { ok: true, value: { archived: 0, deletableSessions: 0, deletableSubagents: 0, skippedRunning: 0 } }
  }
  return {}
}

function successfulCall(fx: Fixture): RuntimeProbeCall {
  return async (_base, method, payload, options) => {
    fx.calls.push({ method, payload })
    assert.ok((options?.timeoutMs ?? 0) > 0)
    assert.equal(options?.signal?.aborted, false)
    if (method === 'commands/execute') {
      assertCommandsExecuteArgShape(payload)
      const error = new Error('missing probe session') as Error & { code: string }
      error.code = 'session/not-found'
      throw error
    }
    return { result: { value: successfulValue(method) } }
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The pinned `commands/execute` arg descriptor, as the REAL typert gateway
 *  enforces it: an unknown or missing arg field is rejected with
 *  `gateway/arguments-invalid` before the controller runs. The previous fake
 *  threw session/not-found for ANY payload, which is exactly how the mistyped
 *  `attachments` key (never an upstream wire name) shipped green from the
 *  0.1.3-alpha.1 upgrade onward — a fresh install then failed the activation
 *  probe and its local instance was quarantined (2026-09 real-machine find). */
const COMMANDS_EXECUTE_ARGS = new Set(['agentId', 'line', 'submittedAttachments'])

function assertCommandsExecuteArgShape(payload: unknown): void {
  const args = (payload as { args?: unknown } | undefined)?.args
  assert.ok(typeof args === 'object' && args !== null, 'commands/execute args must be an object')
  const keys = Object.keys(args as Record<string, unknown>)
  const missing = [...COMMANDS_EXECUTE_ARGS].filter(name => !keys.includes(name))
  const unexpected = keys.filter(name => !COMMANDS_EXECUTE_ARGS.has(name))
  if (missing.length === 0 && unexpected.length === 0) return
  const parts = [
    missing.length > 0 ? `missing ${missing.map(name => `"${name}"`).join(', ')}` : '',
    unexpected.length > 0 ? `unexpected ${unexpected.map(name => `"${name}"`).join(', ')}` : '',
  ].filter(part => part !== '')
  const error = new Error(
    `typert gateway: commands/execute: args fields do not match the descriptor: ${parts.join('; ')}`,
  ) as Error & { code: string }
  error.code = 'gateway/arguments-invalid'
  throw error
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
        submittedAttachments: [],
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
test('the commands/execute probe arg name is locked to the pinned upstream signature', async () => {
  // 2026-09 real-machine blocker: the probe sent a mistyped `attachments`
  // (never an upstream wire name) while the runtime declares
  // `submittedAttachments`, so the typert gateway answered
  // gateway/arguments-invalid, the activation probe failed and every fresh
  // install quarantined its local instance — from the 0.1.3-alpha.1 upgrade
  // until the acceptance round found it. Read the vendored signature read-only
  // (the open-in lockstep / C1 discipline) and require the probe payload to
  // carry exactly the upstream third-parameter name, so a vendor rename can
  // never silently desynchronize the probe again.
  const vendorSource = readFileSync(
    join(repoRoot, 'vendor', 'harness-checkout', 'packages', 'interaction', 'commands', 'src', 'index.ts'),
    'utf8',
  )
  const signature = vendorSource.match(/async execute\(\s*agent\s*:[^,]*,\s*line\s*:[^,]*,\s*([A-Za-z_$][\w$]*)\s*:/)
  assert.ok(signature !== null, 'the vendored interaction/commands execute signature must declare agent, line and its third parameter')
  const upstreamArgName = signature![1]!

  const fx = fixture()
  try {
    await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call: successfulCall(fx),
      windowMs: 1_000,
      rpcTimeoutMs: 100,
    })
    const payload = fx.calls.find(entry => entry.method === 'commands/execute')?.payload as
      | { args?: Record<string, unknown> }
      | undefined
    assert.ok(payload?.args !== undefined, 'the probe must call commands/execute')
    assert.deepEqual(
      Object.keys(payload.args).sort(),
      ['agentId', upstreamArgName, 'line'].sort(),
      `the probe must send exactly the pinned upstream arg names (upstream third parameter = "${upstreamArgName}")`,
    )
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a failing probe reports its method name verbatim and still redacts paths', async () => {
  // 2026-09 acceptance finding: the probe error rode the renderer projection as
  // `commands[path]` because the path sanitizer matches `word/word` from inside
  // the token — the failing METHOD disappeared from the only surface that shows
  // a quarantined install. The method name is RPC vocabulary, not path material.
  const fx = fixture()
  try {
    const call: RuntimeProbeCall = async (_base, method, payload) => {
      fx.calls.push({ method, payload })
      if (method === 'commands/execute') {
        const error = new Error(
          'typert gateway: commands/execute: args fields do not match the descriptor (cwd /Users/alice/Library/dsh)',
        ) as Error & { code: string }
        error.code = 'gateway/arguments-invalid'
        throw error
      }
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call,
      windowMs: 1_000,
      rpcTimeoutMs: 100,
    })
    const commands = results.find(result => result.name === 'commands/execute')
    assert.equal(commands?.ok, false)
    assert.match(commands?.error ?? '', /commands\/execute/)
    assert.doesNotMatch(commands?.error ?? '', /commands\[path\]/)
    assert.doesNotMatch(commands?.error ?? '', /Users\/alice/)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('the both-404 legacy diagnosis keeps both method names through a projection pass', async () => {
  // The composed text names the required identity method AND `session/list`,
  // which is deliberately NOT part of REQUIRED_ACTIVATION_PROBES. A projection
  // pass carrying only the required set republishes the legacy name as
  // `session[path]`, so the vocabulary must cover it (2026-09 review).
  const fx = fixture()
  try {
    const notFound = (): never => {
      const error = new Error('HTTP 404') as Error & { status: number }
      error.status = 404
      throw error
    }
    const call: RuntimeProbeCall = async (_base, method, payload) => {
      fx.calls.push({ method, payload })
      if (method === 'session/canOpenWorkspacePath' || method === 'session/list') notFound()
      return { result: { value: successfulValue(method) } }
    }
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call,
      windowMs: 1_000,
      rpcTimeoutMs: 100,
    })
    const identity = results.find(result => result.name === 'session/canOpenWorkspacePath')
    assert.equal(identity?.ok, false)
    const raw = identity?.error ?? ''
    assert.match(raw, /neither session\/canOpenWorkspacePath nor the legacy session\/list method is registered/)
    // the vocabulary is complete for this text …
    assert.match(sanitizeErrorText(raw, PROBE_TEXT_KEEP_TOKENS), /session\/list/)
    // … and a required-set-only pass is exactly what would lose it
    assert.doesNotMatch(sanitizeErrorText(raw, REQUIRED_ACTIVATION_PROBES), /session\/list/)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('the probe text vocabulary covers every required probe name plus the legacy method', () => {
  for (const name of REQUIRED_ACTIVATION_PROBES) {
    assert.equal(PROBE_TEXT_KEEP_TOKENS.includes(name), true, `${name} missing from PROBE_TEXT_KEEP_TOKENS`)
  }
  assert.equal(PROBE_TEXT_KEEP_TOKENS.includes('session/list' as typeof PROBE_TEXT_KEEP_TOKENS[number]), true)
  assert.equal(new Set(PROBE_TEXT_KEEP_TOKENS).size, PROBE_TEXT_KEEP_TOKENS.length, 'no duplicates')
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
    assert.equal(fx.calls.some(entry => entry.method === 'archiveCleanup/probe'), false)
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

test('archiveCleanup/probe accepts only a well-formed domain carrier (design 24 §7 C)', async () => {
  const fx = fixture()
  try {
    // A well-formed business failure means the domain IS mounted but abnormal
    // (binding-pending / registry-unreadable / busy) → fail-closed with the
    // domain answer surfaced, never a protocol success.
    const businessCall: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        const error = new Error('missing') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'archiveCleanup/probe') {
        return { result: { value: { ok: false, error: { code: 'binding-pending', message: 'not wired' } } } }
      }
      return { result: { value: successfulValue(method) } }
    }
    const businessResults = await runRuntimeActivationProbes({ baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call: businessCall })
    assert.equal(businessResults.find(result => result.name === 'archiveCleanup/probe')?.ok, false)
    assert.match(
      businessResults.find(result => result.name === 'archiveCleanup/probe')?.error ?? '',
      /business failure/,
    )

    // A malformed shape (success without an object value) is malformed.
    const malformedCall: RuntimeProbeCall = async (_base, method) => {
      if (method === 'commands/execute') {
        const error = new Error('missing') as Error & { code: string }
        error.code = 'session/not-found'
        throw error
      }
      if (method === 'archiveCleanup/probe') {
        return { result: { value: { ok: true, value: 42 } } }
      }
      return { result: { value: successfulValue(method) } }
    }
    const malformedResults = await runRuntimeActivationProbes({ baseUrl: 'http://127.0.0.1:1', dshHome: fx.dshHome, call: malformedCall })
    assert.equal(malformedResults.find(result => result.name === 'archiveCleanup/probe')?.ok, false)
    assert.match(
      malformedResults.find(result => result.name === 'archiveCleanup/probe')?.error ?? '',
      /malformed probe response/,
    )
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
      'archiveCleanup/probe',
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

test('hostDomainNames derives the exact probe set for partial syncs (design 24 §7 C)', async () => {
  const fx = fixture()
  try {
    // A 2-of-3 gateway sync: only the git-worktree package is seeded.
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call: successfulCall(fx),
      windowMs: 1_000,
      rpcTimeoutMs: 100,
      hostDomainNames: ['gitWorktree/previewCreate'],
    })
    assert.deepEqual(
      results.map(result => result.name),
      [...activationProbeNamesForDomains(['gitWorktree/previewCreate'])],
    )
    assert.ok(results.every(result => result.ok))
    assert.equal(fx.calls.some(entry => entry.method === 'clientGraph/graph'), false)
    assert.equal(fx.calls.some(entry => entry.method === 'archiveCleanup/probe'), false)
    assert.equal(fx.calls.some(entry => entry.method === 'gitWorktree/previewCreate'), true)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('hostDomainNames: an empty list equals the reduced set (no chamber domains)', async () => {
  const fx = fixture()
  try {
    const results = await runRuntimeActivationProbes({
      baseUrl: 'http://127.0.0.1:17510',
      dshHome: fx.dshHome,
      call: successfulCall(fx),
      hostDomainNames: [],
    })
    assert.deepEqual(results.map(result => result.name), [...PROBE_NAMES_WITHOUT_HOST_DOMAINS])
    assert.ok(results.every(result => result.ok))
    assert.equal(fx.calls.some(entry => entry.method === 'archiveCleanup/probe'), false)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('activationProbeNamesForDomains: full list equals REQUIRED; unknown names throw (implementation-review Major-2 fail-loud)', () => {
  assert.deepEqual([...activationProbeNamesForDomains([...REQUIRED_ACTIVATION_PROBES.filter(name => name.includes('/'))].filter(name => ['clientGraph/graph', 'gitWorktree/previewCreate', 'archiveCleanup/probe'].includes(name)))], [...REQUIRED_ACTIVATION_PROBES])
  assert.deepEqual(
    [...activationProbeNamesForDomains([])],
    [...PROBE_NAMES_WITHOUT_HOST_DOMAINS],
  )
  // A drift name (e.g. the pre-2026-12 'archiveCleanup/preview') must FAIL
  // LOUD — silently dropping it would remove the domain from the expected
  // set AND its run legs, letting a dead domain pass activation (fail-open).
  assert.throws(() => activationProbeNamesForDomains(['not-a-domain']), /unknown chamber host probe domain/)
  assert.throws(() => activationProbeNamesForDomains(['archiveCleanup/preview']), /unknown chamber host probe domain/)
})
