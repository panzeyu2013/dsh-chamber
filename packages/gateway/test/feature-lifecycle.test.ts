import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcBusinessError, RpcTransportError, type ApiRequest, type ApiResponse, type ServerRequest } from '@dsh-chamber/control-plane'
import { createSessionIndex } from '../src/features/index.ts'
import { AnswerRejectedError, createApprovalNotifier } from '../src/features/notify.ts'
import { MAX_TIMER_DELAY_MS, createScheduler, type ScheduledJob } from '../src/features/schedule.ts'
import { createFeatureHost } from '../src/routes.ts'
import { createGatewayStore } from '../src/store.ts'
import type { GatewaySettingsDoc, GatewayStore, WorktreeStoreRecord } from '../src/store.ts'

const logger = {
  log() {},
  warn() {},
  error() {},
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Fake dsh wire: an HTTP fetch stub that decodes the unary envelope and
 * returns a server-response built from the handler's result. */
function rpcFetch(handler: (method: string, payload: any) => any): typeof globalThis.fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const result = handler(request.method, request.payload)
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

/** A real single-commit git repository on a temp dir. */
async function makeGitRepo(prefix: string): Promise<{ root: string; repo: string }> {
  const rawRoot = await mkdtemp(join(tmpdir(), prefix))
  const root = await realpath(rawRoot)
  const repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', repo], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'gateway-test@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Gateway Test'])
  await writeFile(join(repo, 'README.md'), 'baseline\n')
  execFileSync('git', ['-C', repo, 'add', 'README.md'])
  execFileSync('git', ['-C', repo, 'commit', '-m', 'baseline'], { stdio: 'ignore' })
  return { root, repo }
}

test('session index waits for readiness, rebuilds session.list baseline, and reconnects streams', async () => {
  let baseUrl: string | null = null
  let baselineCalls = 0
  let muxCalls = 0
  let hostCalls = 0
  let releaseFirst!: () => void
  const firstGenerationEnd = new Promise<void>(resolve => { releaseFirst = resolve })
  const index = createSessionIndex({
    getDshBaseUrl: () => baseUrl,
    logger,
    reconnectDelayMs: 5,
    callDsh: (async () => {
      baselineCalls += 1
      return {
        rpcId: `baseline-${baselineCalls}`,
        result: {
          ok: true,
          value: { items: [{
            sessionId: 'session-baseline', updatedAt: 10, running: false, blank: true, cwd: '/repo',
            projections: { asOfSeq: 0, values: { title: 'Baseline' } },
          }] },
        },
      }
    }) as any,
    openStream: async function *(_base, path, signal, onOpen): AsyncGenerator<ServerRequest> {
      const callNumber = path.endsWith('mux') ? ++muxCalls : ++hostCalls
      onOpen?.()
      if (path.endsWith('mux')) {
        yield {
          type: 'server-request', rpcId: `mux-${callNumber}`, method: 'session/projection',
          payload: { sessionId: 'session-baseline', key: 'title', value: `Live ${callNumber}`, seq: callNumber },
        }
      } else {
        yield {
          type: 'server-request', rpcId: `host-${callNumber}`, method: 'host/session-status',
          payload: { sessionId: 'session-baseline', running: true },
        }
      }
      if (callNumber === 1) await firstGenerationEnd
      else if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
  })

  index.start()
  index.start()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(baselineCalls, 0)
  baseUrl = 'http://127.0.0.1:12345'
  await waitFor(() => index.get('session-baseline')?.title === 'Live 1')
  assert.deepEqual(index.get('session-baseline'), {
    sessionId: 'session-baseline', title: 'Live 1', running: true, blank: false, cwd: '/repo', updatedAt: 10,
  })
  releaseFirst()
  await waitFor(() => baselineCalls >= 2 && index.get('session-baseline')?.title === 'Live 2')
  assert.equal(muxCalls >= 2, true)
  assert.equal(hostCalls >= 2, true)
  index.stop()
  index.stop()
  assert.deepEqual(index.list(), [])
})

test('session index open barrier has a watchdog: a hung upgrade cannot wedge the generation forever', async () => {
  let baseUrl: string | null = null
  let baselineCalls = 0
  let attempts = 0
  const index = createSessionIndex({
    getDshBaseUrl: () => baseUrl,
    logger,
    reconnectDelayMs: 5,
    barrierOpenTimeoutMs: 60,
    callDsh: (async () => {
      baselineCalls += 1
      return {
        rpcId: `baseline-${baselineCalls}`,
        result: {
          ok: true,
          value: { items: [{
            sessionId: 'session-recovered', updatedAt: 10, running: false, blank: true, cwd: '/repo',
            projections: { asOfSeq: 0, values: { title: 'Recovered' } },
          }] },
        },
      }
    }) as any,
    openStream: async function *(_base, path, signal, onOpen): AsyncGenerator<ServerRequest> {
      attempts += 1
      if (attempts <= 2) {
        // The upstream accepts the connection but NEVER completes the WS
        // upgrade (no onOpen, no frames). Without the barrier watchdog this
        // generation would buffer forever and /chamber/sessions stay empty.
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        return
      }
      onOpen?.()
      if (path.endsWith('mux')) {
        yield {
          type: 'server-request', rpcId: 'mux-recovered', method: 'session/projection',
          payload: { sessionId: 'session-recovered', key: 'title', value: 'Live', seq: 1 },
        }
      }
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
  })
  index.start()
  baseUrl = 'http://127.0.0.1:12345'
  await waitFor(() => index.get('session-recovered')?.title === 'Live', 3_000)
  assert.ok(attempts >= 3, `the generation recovered through reconnect (attempts=${attempts})`)
  index.stop()
})

test('session index buffers host changes after WS-ready and replays them over the list baseline', async () => {
  let releaseBaseline!: () => void
  const baselineGate = new Promise<void>(resolve => { releaseBaseline = resolve })
  let baselineStarted = false
  let bufferedHostFrame = false
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    reconnectDelayMs: 5,
    callDsh: (async () => {
      baselineStarted = true
      await baselineGate
      return {
        rpcId: 'baseline-race',
        result: { ok: true, value: { items: [{
          sessionId: 'session-race', updatedAt: 50, running: false, blank: true, cwd: '/race',
          projections: { asOfSeq: -1, values: {} },
        }] } },
      }
    }) as any,
    openStream: async function *(_base, path, signal, onOpen): AsyncGenerator<ServerRequest> {
      onOpen?.()
      if (path.endsWith('host')) {
        bufferedHostFrame = true
        yield {
          type: 'server-request', rpcId: 'host-race', method: 'host/session-status',
          payload: { sessionId: 'session-race', running: true },
        }
      }
      if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
  })
  index.start()
  await waitFor(() => baselineStarted && bufferedHostFrame)
  assert.deepEqual(index.list(), [], 'no partial pre-baseline state is published')
  releaseBaseline()
  await waitFor(() => index.get('session-race')?.running === true)
  assert.equal(index.get('session-race')?.blank, false)
  index.stop()
})

test('approval notifier survives initial null readiness and reconnects after stream end', async () => {
  let baseUrl: string | null = null
  let streamCalls = 0
  const approvals: string[] = []
  const notifier = createApprovalNotifier({
    getDshBaseUrl: () => baseUrl,
    logger,
    reconnectDelayMs: 5,
    onApproval: request => approvals.push(request.rpcId),
    onQuestion() {},
    openStream: async function *(): AsyncGenerator<ServerRequest> {
      streamCalls += 1
      yield {
        type: 'server-request', rpcId: `approval-rpc-${streamCalls}`, method: 'approval/requested',
        payload: { sessionId: 's1', approvalId: `a${streamCalls}`, toolName: 'shell' },
      }
    },
  })
  notifier.start()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(streamCalls, 0)
  baseUrl = 'http://127.0.0.1:12345'
  await waitFor(() => streamCalls >= 2)
  assert.equal(approvals.length >= 2, true)
  notifier.stop()
  notifier.stop()
})

test('approval notifier emits valid RpcResult responses and rejects negative receipts', async () => {
  const sent: Array<{ rpcId?: string; result: any }> = []
  let accepted = false
  const notifier = createApprovalNotifier({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    onApproval() {},
    onQuestion() {},
    respondDsh: (async (_base: string, message: { rpcId?: string; result: any }) => {
      sent.push(message)
      return accepted ? { accepted: true } : { accepted: false, reason: 'bad-response' }
    }) as any,
  })
  const approval = { sessionId: 's1', approvalId: 'a1', rpcId: 'approval-rpc', toolName: 'shell' }
  await assert.rejects(notifier.answerApproval(approval, 'allowed-once'),
    (error: unknown) => error instanceof AnswerRejectedError && error.reason === 'bad-response')
  assert.deepEqual(sent[0], {
    rpcId: 'approval-rpc',
    result: { ok: true, value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' } },
  })

  await assert.rejects(notifier.answerQuestion({
    sessionId: 's1', rpcId: 'question-rpc', questions: [],
  }, { answers: [] }), (error: unknown) => error instanceof AnswerRejectedError)
  assert.equal(sent[1]?.result.ok, true)
  accepted = true
  await notifier.answerQuestion({ sessionId: 's1', rpcId: 'question-rpc', questions: [] }, { answers: [] })
})

test('notify answer RPC shapes are locked for approval and question answers', async () => {
  // Regression guard: the answer path is the single dsh respond RPC (the
  // ClientResponse envelope {rpcId, result}); the rpcId echoes the
  // server-request and the result carries the answerable payload. Lock the
  // exact shapes so a future refactor cannot silently drift them.
  const sent: Array<{ rpcId?: string; result: any }> = []
  const notifier = createApprovalNotifier({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    onApproval() {},
    onQuestion() {},
    respondDsh: (async (_base: string, message: { rpcId?: string; result: any }) => {
      sent.push(message)
      return { accepted: true }
    }) as any,
  })
  await notifier.answerApproval(
    { sessionId: 's1', approvalId: 'a1', rpcId: 'approval-rpc', toolName: 'shell' },
    'allowed-once',
  )
  assert.deepEqual(sent[0], {
    rpcId: 'approval-rpc',
    result: { ok: true, value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' } },
  })
  const answer = { answers: [{ id: 'q1', selected: ['a'] }] }
  await notifier.answerQuestion({ sessionId: 's1', rpcId: 'question-rpc', questions: [] }, answer)
  assert.deepEqual(sent[1], {
    rpcId: 'question-rpc',
    result: { ok: true, value: { sessionId: 's1', answer } },
  })
})

test('scheduler detach keeps definitions and start re-arms them', async () => {
  let prompts = 0
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async () => {
      prompts += 1
      return { rpcId: `prompt-${prompts}`, result: { ok: true, value: {} } }
    }) as any,
  })
  scheduler.restore({ id: 'persisted-job', delayMs: 5, intervalMs: 1_000, targetSessionId: 's1', prompt: 'continue' })
  scheduler.start()
  await waitFor(() => prompts >= 1)
  scheduler.stop()
  scheduler.stop()
  assert.equal(scheduler.list().length, 1)
  scheduler.start()
  await waitFor(() => prompts >= 2)
  scheduler.stop()
  assert.equal(scheduler.list()[0]?.id, 'persisted-job')
})

test('scheduler restore tolerates duplicate persisted ids (keeps first, warns) instead of vetoing startup', async () => {
  let prompts = 0
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async () => {
      prompts += 1
      return { rpcId: `prompt-${prompts}`, result: { ok: true, value: {} } }
    }) as any,
  })
  const first = { id: 'dup-job', delayMs: 5, intervalMs: 1_000, targetSessionId: 's1', prompt: 'continue' }
  scheduler.restore(first)
  // A hand-edited schedule.json with a repeated id must not crash the
  // feature host at startup (P2 regression): keep the first definition.
  assert.doesNotThrow(() => scheduler.restore({ ...first }))
  assert.equal(scheduler.list().length, 1)
  scheduler.start()
  await waitFor(() => prompts >= 1)
  scheduler.stop()
  assert.equal(scheduler.list()[0]?.id, 'dup-job')
})

test('scheduler interval prompts are single-flight', async () => {
  let prompts = 0
  let releaseFirst!: () => void
  const firstPrompt = new Promise<void>(resolve => { releaseFirst = resolve })
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async () => {
      prompts += 1
      if (prompts === 1) await firstPrompt
      return { rpcId: `prompt-${prompts}`, result: { ok: true, value: {} } }
    }) as any,
  })
  scheduler.schedule({ delayMs: 0, intervalMs: 1_000, targetSessionId: 's1', prompt: 'continue' })
  scheduler.start()
  await waitFor(() => prompts === 1)
  await new Promise(resolve => setTimeout(resolve, 1_050))
  assert.equal(prompts, 1, 'an unresolved prompt blocks the next interval invocation')
  releaseFirst()
  scheduler.stop()
})

test('scheduler fires session.prompt with the dsh 0.1.1-rc.2 wire shape (mode+content)', async () => {
  // Live finding: the old {sessionId, prompt} payload was rejected by the
  // real wire ("invalid payload for session.prompt") — every scheduled
  // prompt failed validation. The accepted shape is
  // {sessionId, mode:'queue', content:[{type:'text',text}]}.
  const sent: Array<{ method: string; sessionId: string; mode: string; content: unknown }> = []
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async (_base: string, method: string, payload: unknown) => {
      sent.push({ method, ...(payload as { sessionId: string; mode: string; content: unknown }) })
      return { rpcId: 'prompt-1', result: { ok: true, value: {} } }
    }) as any,
  })
  scheduler.schedule({ delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'continue' })
  scheduler.start()
  await waitFor(() => sent.length === 1)
  scheduler.stop()
  assert.equal(sent[0]?.method, 'session.prompt', 'the scheduled prompt targets session.prompt')
  assert.deepEqual(sent[0], {
    method: 'session.prompt',
    sessionId: 's1',
    mode: 'queue',
    content: [{ type: 'text', text: 'continue' }],
  })
})

test('a deterministic dsh rejection terminates a one-shot job and persists the removal', async () => {
  // RpcBusinessError (result.ok === false: target session deleted, payload
  // refused, …) can never succeed on retry — backing off would spin
  // session.prompt forever. The job must be removed and the removal
  // persisted, unlike transient carrier failures (next test).
  let calls = 0
  const persisted: Array<ScheduledJob[]> = []
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    onJobsChanged: async jobs => { persisted.push(jobs) },
    callDsh: (async () => {
      calls += 1
      throw new RpcBusinessError({ code: 'session-not-found', message: 'target session deleted' })
    }) as any,
  })
  scheduler.schedule({ delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'no retry' })
  scheduler.start()
  await waitFor(() => scheduler.list().length === 0 && calls === 1)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(calls, 1, 'a business rejection must not back off and spin')
  assert.deepEqual(persisted.at(-1), [], 'the termination was persisted as a removal')
  scheduler.stop()
})

test('a deterministic dsh rejection stops an interval job', async () => {
  let calls = 0
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async () => {
      calls += 1
      throw new RpcBusinessError({ code: 'invalid-payload', message: 'payload refused' })
    }) as any,
  })
  scheduler.schedule({ delayMs: 0, intervalMs: 1_000, targetSessionId: 's1', prompt: 'stop' })
  scheduler.start()
  await waitFor(() => calls === 1 && scheduler.list().length === 0)
  await new Promise(resolve => setTimeout(resolve, 1_100))
  assert.equal(calls, 1, 'the interval cadence stops after a business rejection')
  scheduler.stop()
})

test('a transport failure keeps the one-shot retry backoff and the job', async () => {
  let calls = 0
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async () => {
      calls += 1
      throw new RpcTransportError('dsh unary: connection is offline', 0, 'connection_offline')
    }) as any,
  })
  scheduler.schedule({ delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'keep retrying' })
  scheduler.start()
  await waitFor(() => calls === 1)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(calls, 1, 'transient failures use the bounded backoff (min 1s), not an immediate spin')
  assert.equal(scheduler.list().length, 1, 'the job is retained for the next backoff attempt')
  scheduler.stop()
})

test('one-shot failures back off and an in-flight cancel cannot resurrect a job', async () => {
  let failures = 0
  const backingOff = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async () => {
      failures += 1
      throw new Error('transient')
    }) as any,
  })
  const failedJob = backingOff.schedule({
    delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'retry safely',
  })
  backingOff.start()
  await waitFor(() => failures === 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(failures, 1, 'delayMs=0 failures use the independent retry backoff')
  backingOff.cancel(failedJob.id)
  backingOff.stop()

  let releaseFailure!: () => void
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
  let inFlightCalls = 0
  const cancelled = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async () => {
      inFlightCalls += 1
      await failureGate
      throw new Error('late failure')
    }) as any,
  })
  const cancelledJob = cancelled.schedule({
    delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'do not resurrect',
  })
  cancelled.start()
  await waitFor(() => inFlightCalls === 1)
  assert.equal(cancelled.cancel(cancelledJob.id), true)
  releaseFailure()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(cancelled.list(), [])
  assert.equal(inFlightCalls, 1)
  cancelled.stop()
})

class FakeRequest extends EventEmitter {
  method: string
  headers: Record<string, string | string[] | undefined> = {}
  url = '/'
  constructor(method: string, body?: unknown) {
    super()
    this.method = method
    queueMicrotask(() => {
      if (body !== undefined) this.emit('data', Buffer.from(JSON.stringify(body)))
      this.emit('end')
    })
  }
}

class FakeResponse extends EventEmitter {
  status = 0
  headers: Record<string, string> = {}
  chunks: string[] = []
  endCalls = 0
  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status
    this.headers = headers
    return this
  }
  write(chunk: string): boolean {
    this.chunks.push(String(chunk))
    return true
  }
  end(chunk?: string): void {
    this.endCalls += 1
    if (chunk !== undefined) this.chunks.push(String(chunk))
    this.emit('finish')
  }
  json(): any { return JSON.parse(this.chunks.join('')) }
}

function fakeStore(options: {
  scheduleMutate?: () => Promise<void>
  settingsMutate?: (next: Record<string, unknown>) => Promise<void>
  settings?: GatewaySettingsDoc
  schedule?: Array<{
    id: string
    delayMs: number
    intervalMs: number | null
    targetSessionId: string
    prompt: string
  }>
  worktrees?: WorktreeStoreRecord[]
} = {}): GatewayStore {
  let settings: GatewaySettingsDoc = options.settings ?? { schemaVersion: 1, revision: 0 }
  let schedule = options.schedule ?? []
  let worktrees = options.worktrees ?? []
  return {
    gateway: { load: () => ({ channels: [] }), get: () => ({ channels: [] }), mutate: async () => {} },
    worktrees: {
      load: () => ({ items: worktrees }),
      get: () => ({ items: worktrees }),
      mutate: async mutator => { worktrees = mutator({ items: worktrees }).next.items },
    },
    schedule: {
      load: () => ({ items: schedule }),
      get: () => ({ items: schedule }),
      mutate: async mutator => {
        const mutation = mutator({ items: schedule })
        if (mutation.changed) {
          await options.scheduleMutate?.()
          schedule = mutation.next.items
        }
      },
    },
    settings: {
      load: () => settings,
      get: () => settings,
      mutate: async mutator => {
        const mutation = mutator(settings)
        if (mutation.changed) {
          await options.settingsMutate?.(mutation.next as unknown as Record<string, unknown>)
          settings = { ...mutation.next, revision: (settings.revision ?? 0) + 1 }
        }
      },
    },
    getTokenHash: () => null,
    getTokenCredential: () => null,
    setTokenHash() {},
    getJwtSecret: () => 'x'.repeat(64),
    rotateJwtSecret: () => 'y'.repeat(64),
    getPasswordCredential: () => null,
    getPasswordCredentialRecord: () => null,
    setPasswordCredential() {},
    close() {},
    reacquire() {},
  } as GatewayStore
}

const channels = {
  register() {},
  async start() {},
  async stop() {},
  resolve: () => null,
  health: () => 'unknown' as const,
  list: () => [],
}

test('worktree ownership survives gateway-store persistence and reload', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'gateway-ownership-store-'))
  try {
    const store = createGatewayStore(stateDir, logger)
    await store.worktrees.mutate(() => ({
      next: { items: [{
        id: 'recovery-1', workspaceId: 'recovery-1', repo: '/srv/repo', path: '/srv/recovery',
        branch: 'feature/recovery', ownership: 'unverified', state: 'failed', createdAt: 1,
      }] },
      changed: true,
    }))
    // The stateDir exclusive lock must be released before reopening (Phase 1).
    store.close()
    const restarted = createGatewayStore(stateDir, logger)
    assert.equal(restarted.worktrees.load().items[0]?.ownership, 'unverified')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('route does not acknowledge schedule mutation when persistence fails', async () => {
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
      scheduleMutate: async () => { throw new Error('disk full') },
    }),
  })
  const response = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    delayMs: 100, intervalMs: null, targetSessionId: 's1', prompt: 'continue',
  }) as unknown as ApiRequest, response as unknown as ApiResponse, '/chamber/schedule')
  assert.equal(response.status, 500)
  assert.equal(response.json().code, 'persistence_failed')

  const getResponse = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest, getResponse as unknown as ApiResponse, '/chamber/schedule')
  assert.deepEqual(getResponse.json(), { items: [] })
})

test('route persistence is serialized across concurrent settings writes', async () => {
  let starts = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settingsMutate: async () => {
        starts += 1
        if (starts === 1) await firstGate
      },
    }),
  })
  const firstResponse = new FakeResponse()
  const secondResponse = new FakeResponse()
  const first = host.handle(new FakeRequest('PUT', { git: { enabled: true } }) as unknown as ApiRequest,
    firstResponse as unknown as ApiResponse, '/chamber/settings')
  const second = host.handle(new FakeRequest('PUT', { schedule: { enabled: true } }) as unknown as ApiRequest,
    secondResponse as unknown as ApiResponse, '/chamber/settings')
  await waitFor(() => starts === 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(starts, 1)
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(starts, 2)
  assert.equal(firstResponse.status, 200)
  assert.equal(secondResponse.status, 200)
  assert.deepEqual(secondResponse.json().git, { enabled: true })
  assert.deepEqual(secondResponse.json().schedule, { enabled: true })
})

test('settings PUT accepts only exact feature sections and preserves server-owned revision', async () => {
  let writes = 0
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({ settingsMutate: async () => { writes += 1 } }),
  })

  const first = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { git: { enabled: true } }) as unknown as ApiRequest,
    first as unknown as ApiResponse, '/chamber/settings')
  assert.equal(first.status, 200)
  assert.deepEqual(first.json(), { schemaVersion: 1, revision: 1, git: { enabled: true } })

  const second = new FakeResponse()
  await host.handle(new FakeRequest('PUT', {
    notifications: { enabled: false }, schedule: { enabled: true },
  }) as unknown as ApiRequest, second as unknown as ApiResponse, '/chamber/settings')
  assert.equal(second.status, 200)
  assert.deepEqual(second.json(), {
    schemaVersion: 1,
    revision: 2,
    git: { enabled: true },
    notifications: { enabled: false },
    schedule: { enabled: true },
  })

  const noOp = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { git: { enabled: true } }) as unknown as ApiRequest,
    noOp as unknown as ApiResponse, '/chamber/settings')
  assert.equal(noOp.status, 200)
  assert.equal(noOp.json().revision, 2, 'an unchanged partial update does not advance revision')
  assert.equal(writes, 2)
})

test('settings PUT rejects unknown/store-owned fields and malformed section shapes', async () => {
  let writes = 0
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({ settingsMutate: async () => { writes += 1 } }),
  })
  const invalidBodies: unknown[] = [
    null,
    [],
    { revision: 99 },
    { schemaVersion: 99 },
    { unknown: { enabled: true } },
    { git: true },
    { git: null },
    { git: {} },
    { git: { enabled: 'true' } },
    { git: { enabled: true, extra: false } },
    { notifications: { enabled: false, nested: {} } },
    { schedule: { enabled: false }, extra: {} },
  ]
  for (const body of invalidBodies) {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('PUT', body) as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/settings')
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(response.json().code, 'invalid_input')
  }
  assert.equal(writes, 0)

  const get = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    get as unknown as ApiResponse, '/chamber/settings')
  assert.deepEqual(get.json(), { schemaVersion: 1, revision: 0 })
})

test('feature routes default disabled with a stable 403 response', async () => {
  const host = createFeatureHost({ getDshBaseUrl: () => null, logger, channels, store: fakeStore() })
  for (const [method, path] of [
    ['GET', '/chamber/git/worktrees'],
    ['POST', '/chamber/git/worktrees'],
    ['DELETE', '/chamber/git/worktrees/ws-disabled'],
    ['GET', '/chamber/schedule'],
    ['POST', '/chamber/schedule'],
    ['DELETE', '/chamber/schedule/job-disabled'],
    ['GET', '/chamber/approvals'],
    ['POST', '/chamber/approvals'],
    ['GET', '/chamber/notifications'],
  ] as const) {
    const response = new FakeResponse()
    await host.handle(new FakeRequest(method) as unknown as ApiRequest,
      response as unknown as ApiResponse, path)
    assert.equal(response.status, 403, `${method} ${path}`)
    assert.deepEqual(response.json(), { error: 'feature_disabled', code: 'feature_disabled' })
  }
})

test('persisted feature settings apply on start and runtime PUT attaches or detaches immediately', async () => {
  let muxStarts = 0
  let streamAborts = 0
  let prompts = 0
  const transport = {
    reconnectDelayMs: 5,
    callDsh: (async (_base: string, method: string) => {
      if (method === 'session.prompt') {
        prompts += 1
        return { rpcId: `prompt-${prompts}`, result: { ok: true, value: {} } }
      }
      return { rpcId: 'session-list', result: { ok: true, value: { items: [] } } }
    }) as any,
    openStream: async function *(
      _base: string,
      path: string,
      signal?: AbortSignal,
      onOpen?: () => void,
    ): AsyncGenerator<ServerRequest> {
      if (path.endsWith('mux')) muxStarts += 1
      onOpen?.()
      if (!signal?.aborted) {
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => {
          streamAborts += 1
          resolve()
        }, { once: true }))
      }
    },
  }

  const restarted = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: {
        schemaVersion: 1,
        revision: 4,
        git: { enabled: true },
        notifications: { enabled: true },
        schedule: { enabled: true },
      },
      schedule: [{
        id: 'restart-job', delayMs: 5, intervalMs: null, targetSessionId: 's1', prompt: 'resume',
      }],
    }),
    featureTransport: transport,
  })
  restarted.start()
  await waitFor(() => muxStarts >= 2 && prompts === 1)
  for (const path of ['/chamber/git/worktrees', '/chamber/schedule', '/chamber/approvals']) {
    const response = new FakeResponse()
    await restarted.handle(new FakeRequest('GET') as unknown as ApiRequest,
      response as unknown as ApiResponse, path)
    assert.equal(response.status, 200, path)
  }
  restarted.stop()

  muxStarts = 0
  streamAborts = 0
  prompts = 0
  const host = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore(),
    featureTransport: transport,
  })
  host.start()
  await waitFor(() => muxStarts === 1)

  const enableNotifications = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { notifications: { enabled: true } }) as unknown as ApiRequest,
    enableNotifications as unknown as ApiResponse, '/chamber/settings')
  assert.equal(enableNotifications.status, 200)
  await waitFor(() => muxStarts >= 2)

  const liveNotifications = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    liveNotifications as unknown as ApiResponse, '/chamber/notifications')
  assert.equal(liveNotifications.status, 200)
  const abortsBeforeDisable = streamAborts
  const disableNotifications = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { notifications: { enabled: false } }) as unknown as ApiRequest,
    disableNotifications as unknown as ApiResponse, '/chamber/settings')
  assert.equal(liveNotifications.endCalls, 1, 'disabling notifications closes existing SSE clients')
  await waitFor(() => streamAborts > abortsBeforeDisable)
  const disabledNotifications = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    disabledNotifications as unknown as ApiResponse, '/chamber/approvals')
  assert.equal(disabledNotifications.status, 403)

  const enableSchedule = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { schedule: { enabled: true } }) as unknown as ApiRequest,
    enableSchedule as unknown as ApiResponse, '/chamber/settings')
  const scheduled = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    delayMs: 80, intervalMs: null, targetSessionId: 's1', prompt: 'later',
  }) as unknown as ApiRequest, scheduled as unknown as ApiResponse, '/chamber/schedule')
  assert.equal(scheduled.status, 200)
  const disableSchedule = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { schedule: { enabled: false } }) as unknown as ApiRequest,
    disableSchedule as unknown as ApiResponse, '/chamber/settings')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(prompts, 0, 'disabling schedule cancels armed timers without deleting definitions')
  const reenableSchedule = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { schedule: { enabled: true } }) as unknown as ApiRequest,
    reenableSchedule as unknown as ApiResponse, '/chamber/settings')
  await waitFor(() => prompts === 1)

  const gitBefore = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    gitBefore as unknown as ApiResponse, '/chamber/git/worktrees')
  assert.equal(gitBefore.status, 403)
  const enableGit = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { git: { enabled: true } }) as unknown as ApiRequest,
    enableGit as unknown as ApiResponse, '/chamber/settings')
  const gitAfter = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    gitAfter as unknown as ApiResponse, '/chamber/git/worktrees')
  assert.equal(gitAfter.status, 200)
  host.stop()
})

test('schedule routes reject timer overflow and accept the exact Node timer boundary', async () => {
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
    }),
  })
  for (const body of [
    { delayMs: MAX_TIMER_DELAY_MS + 1, intervalMs: null, targetSessionId: 's1', prompt: 'overflow' },
    { delayMs: 0, intervalMs: MAX_TIMER_DELAY_MS + 1, targetSessionId: 's1', prompt: 'overflow' },
  ]) {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('POST', body) as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/schedule')
    assert.equal(response.status, 400)
    assert.equal(response.json().code, 'invalid_input')
  }
  for (const body of [
    { delayMs: MAX_TIMER_DELAY_MS, intervalMs: null, targetSessionId: 's1', prompt: 'max delay' },
    { delayMs: 0, intervalMs: MAX_TIMER_DELAY_MS, targetSessionId: 's1', prompt: 'max interval' },
  ]) {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('POST', body) as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/schedule')
    assert.equal(response.status, 200)
  }
  const listed = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    listed as unknown as ApiResponse, '/chamber/schedule')
  assert.equal(listed.json().items.length, 2)
  host.stop()
})

test('schedule POST rejects oversized prompts and target session ids with invalid_input', async () => {
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
    }),
  })
  for (const body of [
    { delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'x'.repeat(10_001) },
    { delayMs: 0, intervalMs: null, targetSessionId: 's'.repeat(513), prompt: 'ok' },
  ]) {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('POST', body) as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/schedule')
    assert.equal(response.status, 400)
    assert.equal(response.json().code, 'invalid_input')
  }
  const accepted = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'x'.repeat(10_000),
  }) as unknown as ApiRequest, accepted as unknown as ApiResponse, '/chamber/schedule')
  assert.equal(accepted.status, 200)
  host.stop()
})

test('schedule POST enforces the total job cap', async () => {
  const jobs = Array.from({ length: 1_000 }, (_, i) => ({
    id: `job-${i}`, delayMs: 60_000, intervalMs: null, targetSessionId: 's1', prompt: 'p',
  }))
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
      schedule: jobs,
    }),
  })
  const response = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'one more',
  }) as unknown as ApiRequest, response as unknown as ApiResponse, '/chamber/schedule')
  assert.equal(response.status, 400)
  assert.equal(response.json().code, 'schedule_full')
  host.stop()
})

test('SSE lifetime follows response close, not request close', async () => {
  const enabled = { schemaVersion: 1, revision: 0, notifications: { enabled: true } }
  const host = createFeatureHost({ getDshBaseUrl: () => null, logger, channels, store: fakeStore({ settings: enabled }) })
  const request = new FakeRequest('GET')
  request.headers.accept = 'text/event-stream'
  const response = new FakeResponse()
  await host.handle(request as unknown as ApiRequest, response as unknown as ApiResponse, '/chamber/approvals')
  assert.equal(response.status, 200)
  request.emit('close')
  host.stop()
  assert.equal(response.endCalls, 1, 'request close must not unregister a live SSE response')

  const secondHost = createFeatureHost({ getDshBaseUrl: () => null, logger, channels, store: fakeStore({ settings: enabled }) })
  const secondResponse = new FakeResponse()
  await secondHost.handle(new FakeRequest('GET') as unknown as ApiRequest,
    secondResponse as unknown as ApiResponse, '/chamber/notifications')
  secondResponse.emit('close')
  secondHost.stop()
  assert.equal(secondResponse.endCalls, 0, 'response close unregisters the SSE client before stop cleanup')
})

test('DELETE rejects unverified/legacy ownership and client-controlled delete options', async () => {
  const baseRecord: WorktreeStoreRecord = {
    id: 'ws-recovery', workspaceId: 'ws-recovery', repo: '/srv/repo', path: '/srv/recovery',
    branch: 'feature/recovery', state: 'failed', createdAt: 1,
  }
  for (const ownership of ['unverified', undefined] as const) {
    const record = { ...baseRecord, ...(ownership === undefined ? {} : { ownership }) }
    const host = createFeatureHost({
      getDshBaseUrl: () => null,
      logger,
      channels,
      store: fakeStore({
        settings: { schemaVersion: 1, revision: 0, git: { enabled: true } },
        worktrees: [record],
      }),
    })
    const response = new FakeResponse()
    await host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/git/worktrees/ws-recovery')
    assert.equal(response.status, 409)
    assert.equal(response.json().code, 'unsafe_recovery_record')
  }

  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, git: { enabled: true } },
      worktrees: [{ ...baseRecord, ownership: 'owned' }],
    }),
  })
  const response = new FakeResponse()
  await host.handle(new FakeRequest('DELETE', { deleteBranch: true }) as unknown as ApiRequest,
    response as unknown as ApiResponse, '/chamber/git/worktrees/ws-recovery')
  assert.equal(response.status, 400)
  assert.equal(response.json().code, 'delete_body_not_allowed')
})

test('dirty worktree delete failure rolls the record back to ready with the error and stays retryable', async () => {
  // A dirty worktree makes `git worktree remove` (non-force) fail. The record
  // must not stay stuck in state:'deleting' with an empty error field: roll
  // back to a retryable 'ready' + recorded reason, and a second DELETE must
  // re-enter the saga instead of being deadlocked.
  const fixture = await makeGitRepo('gateway-delete-rollback-')
  const target = join(fixture.root, 'feature-dirty')
  execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', '-b', 'feature/dirty', target], { stdio: 'ignore' })
  await writeFile(join(target, 'dirty.txt'), 'uncommitted change\n')
  const originalFetch = globalThis.fetch
  let sessionListCalls = 0
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        { workspaceId: 'ws-dirty', path: target },
      ] } }
    }
    if (method === 'session.list') {
      sessionListCalls += 1
      return { ok: true, value: { items: [] } }
    }
    throw new Error(`unexpected ${method}`)
  })
  const host = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, git: { enabled: true } },
      worktrees: [{
        id: 'ws-dirty', workspaceId: 'ws-dirty', repo: fixture.repo, path: target,
        branch: 'feature/dirty', ownership: 'owned', state: 'ready', createdAt: 1,
      }],
    }),
  })
  const listWorktrees = async (): Promise<any[]> => {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/git/worktrees')
    return response.json().items
  }
  try {
    const first = new FakeResponse()
    await host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      first as unknown as ApiResponse, '/chamber/git/worktrees/ws-dirty')
    assert.equal(first.status, 500)
    assert.equal(first.json().code, 'git_worktree_remove_failed')
    assert.equal(sessionListCalls, 1, 'the saga reached the live-session guard before git removal')
    let record = (await listWorktrees())[0]
    assert.equal(record?.state, 'ready', 'a dirty-tree failure must not stay stuck in deleting')
    assert.ok(typeof record?.error === 'string' && record.error !== '', 'the failure reason is recorded')
    assert.equal(await realpath(target), target, 'the worktree directory still exists')

    const second = new FakeResponse()
    await host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      second as unknown as ApiResponse, '/chamber/git/worktrees/ws-dirty')
    assert.equal(second.status, 500, 'the second DELETE is still initiated')
    assert.equal(second.json().code, 'git_worktree_remove_failed')
    assert.ok(sessionListCalls >= 2, 'the retry re-entered the delete saga')
    record = (await listWorktrees())[0]
    assert.equal(record?.state, 'ready')
    assert.ok(typeof record?.error === 'string' && record.error !== '')
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('pending interactions dedupe, rejected receipts stay pending, and resolved/reset reach SSE clients', async () => {
  let releaseResolved!: () => void
  const resolvedGate = new Promise<void>(resolve => { releaseResolved = resolve })
  let accepted = false
  const responses: any[] = []
  const host = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, notifications: { enabled: true } },
    }),
    featureTransport: {
      reconnectDelayMs: 5,
      callDsh: (async () => ({
        rpcId: 'session-list', result: { ok: true, value: { items: [] } },
      })) as any,
      respondDsh: (async (_base: string, message: { rpcId?: string; result: any }) => {
        responses.push(message)
        return accepted ? { accepted: true } : { accepted: false, reason: 'bad-response' }
      }) as any,
      openStream: async function *(_base, path, signal, onOpen): AsyncGenerator<ServerRequest> {
        onOpen?.()
        if (path.endsWith('mux')) {
          const requested: ServerRequest[] = [
            {
              type: 'server-request', rpcId: 'approval-rpc', method: 'approval/requested',
              payload: { sessionId: 's1', approvalId: 'a1', toolName: 'shell' },
            },
            {
              type: 'server-request', rpcId: 'question-rpc', method: 'question/requested',
              payload: { sessionId: 's1', questions: [] },
            },
          ]
          for (const frame of [...requested, ...requested]) yield frame
          await resolvedGate
          yield {
            type: 'server-request', rpcId: 'approval-resolved', method: 'approval/resolved',
            payload: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' },
          }
          yield {
            type: 'server-request', rpcId: 'question-resolved', method: 'question/resolved',
            payload: { sessionId: 's1', questionRpcId: 'question-rpc', outcome: 'answered' },
          }
        }
        if (!signal?.aborted) {
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        }
      },
    },
  })
  const sseRequest = new FakeRequest('GET')
  sseRequest.headers.accept = 'text/event-stream'
  const sse = new FakeResponse()
  await host.handle(sseRequest as unknown as ApiRequest, sse as unknown as ApiResponse, '/chamber/approvals')
  host.start()

  const getPending = async (): Promise<any[]> => {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/approvals')
    return response.json().items
  }
  await waitFor(() => sse.chunks.join('').includes('event: question'))
  assert.equal((await getPending()).length, 2, 'replayed duplicate rpcIds are deduplicated')
  assert.equal(sse.chunks.join('').includes('event: pending-reset'), true)

  const malformed = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    rpcId: 'question-rpc', answer: { answers: [{ id: '', selected: [] }] },
  }) as unknown as ApiRequest, malformed as unknown as ApiResponse, '/chamber/approvals')
  assert.equal(malformed.status, 400)
  assert.equal(responses.length, 0, 'malformed answers do not reach dsh')

  for (const body of [
    { rpcId: 'approval-rpc', outcome: 'allowed-once' },
    { rpcId: 'question-rpc', answer: { answers: [] } },
  ]) {
    const rejected = new FakeResponse()
    await host.handle(new FakeRequest('POST', body) as unknown as ApiRequest,
      rejected as unknown as ApiResponse, '/chamber/approvals')
    assert.equal(rejected.status, 409)
    assert.equal(rejected.json().code, 'answer_rejected')
  }
  assert.equal((await getPending()).length, 2, 'negative receipts keep both pending rows')

  accepted = true
  const answered = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    rpcId: 'question-rpc', answer: { answers: [] },
  }) as unknown as ApiRequest, answered as unknown as ApiResponse, '/chamber/approvals')
  assert.equal(answered.status, 200)
  assert.equal(responses.at(-1)?.result.ok, true)
  assert.equal((await getPending()).length, 1)

  releaseResolved()
  await waitFor(() => sse.chunks.join('').includes('event: approval-resolved'))
  assert.deepEqual(await getPending(), [])
  assert.equal(sse.chunks.join('').includes('event: question-resolved'), true)
  host.stop()
})

test('read-only feature routes reject mutating methods and assets support HEAD', async () => {
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, notifications: { enabled: true } },
    }),
  })
  for (const path of ['/chamber/sessions', '/chamber/channels', '/chamber/notifications', '/chamber/', '/chamber/app.js', '/chamber/mobile.html']) {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('POST') as unknown as ApiRequest, response as unknown as ApiResponse, path)
    assert.equal(response.status, 405, path)
  }
  const head = new FakeResponse()
  await host.handle(new FakeRequest('HEAD') as unknown as ApiRequest, head as unknown as ApiResponse, '/chamber/mobile.html')
  assert.equal(head.status, 200)
  assert.equal(head.chunks.join(''), '')
  assert.equal(Number(head.headers['content-length']) > 0, true)
})

test('answering a pending interaction while dsh is not ready answers 503 and keeps the pending row', async () => {
  let baseUrl: string | null = 'http://127.0.0.1:12345'
  const responses: any[] = []
  const host = createFeatureHost({
    getDshBaseUrl: () => baseUrl,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, notifications: { enabled: true } },
    }),
    featureTransport: {
      reconnectDelayMs: 5,
      callDsh: (async () => ({
        rpcId: 'session-list', result: { ok: true, value: { items: [] } },
      })) as any,
      respondDsh: (async (_base: string, message: { rpcId?: string; result: any }) => {
        responses.push(message)
        return { accepted: true }
      }) as any,
      openStream: async function *(_base, path, signal, onOpen): AsyncGenerator<ServerRequest> {
        onOpen?.()
        if (path.endsWith('mux')) {
          yield {
            type: 'server-request', rpcId: 'approval-rpc', method: 'approval/requested',
            payload: { sessionId: 's1', approvalId: 'a1', toolName: 'shell' },
          }
        }
        if (!signal?.aborted) {
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        }
      },
    },
  })
  host.start()

  const getPending = async (): Promise<any[]> => {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/approvals')
    return response.json().items
  }
  const deadline = Date.now() + 1_000
  while ((await getPending()).length === 0) {
    if (Date.now() >= deadline) throw new Error('pending approval never arrived')
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  baseUrl = null
  const unanswered = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    rpcId: 'approval-rpc', outcome: 'allowed-once',
  }) as unknown as ApiRequest, unanswered as unknown as ApiResponse, '/chamber/approvals')
  assert.equal(unanswered.status, 503)
  assert.equal(unanswered.json().code, 'instance_unavailable')
  assert.equal(responses.length, 0, 'a not-ready answer never reaches dsh')
  assert.equal((await getPending()).length, 1, 'the pending row survives a not-ready answer for retry')
  host.stop()
})

test('approval notifier rejects answers with a coded instance_unavailable error while not ready', async () => {
  const notifier = createApprovalNotifier({
    getDshBaseUrl: () => null,
    logger,
    onApproval() {},
    onQuestion() {},
    respondDsh: (async () => ({ accepted: true })) as any,
  })
  const approval = { sessionId: 's1', approvalId: 'a1', rpcId: 'approval-rpc', toolName: 'shell' }
  await assert.rejects(notifier.answerApproval(approval, 'allowed-once'),
    (error: unknown) => (error as { code?: string })?.code === 'instance_unavailable')
  await assert.rejects(notifier.answerQuestion({ sessionId: 's1', rpcId: 'q', questions: [] }, { answers: [] }),
    (error: unknown) => (error as { code?: string })?.code === 'instance_unavailable')
})

test('browser orchestration assets are CSP-safe, secret-blind, and keep settings JSON wire unchanged', async () => {
  const host = createFeatureHost({ getDshBaseUrl: () => null, logger, channels, store: fakeStore() })

  const page = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    page as unknown as ApiResponse, '/chamber/')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /^text\/html/)
  assert.equal(page.headers['cache-control'], 'no-store')
  const csp = page.headers['content-security-policy']
  assert.equal(csp.split(';').map(value => value.trim()).find(value => value.startsWith('script-src')), "script-src 'self'")
  const html = page.chunks.join('')
  assert.match(html, /<script defer src="\/chamber\/app\.js"><\/script>/)
  assert.match(html, /id="runtime-title"/)
  assert.match(html, /id="runtime-version"/)
  assert.match(html, /id="runtime-restart"/)
  assert.match(html, /id="runtime-apply-now"/, 'the apply-now button exists (design 18 addendum §6.4)')
  assert.match(html, />Apply now<\/button>/)
  assert.equal([...html.matchAll(/<script\b([^>]*)>/g)].every(match => /\bsrc=/.test(match[1] ?? '')), true,
    'the page has no inline script body')

  const script = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    script as unknown as ApiResponse, '/chamber/app.js')
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /^application\/javascript/)
  const source = script.chunks.join('')
  assert.doesNotThrow(() => new Function(source), 'the served classic script must parse')
  for (const path of [
    '/chamber/settings', '/chamber/sessions', '/chamber/approvals',
    '/chamber/schedule', '/chamber/git/worktrees', '/chamber/runtime/status',
    '/chamber/runtime/versions', '/chamber/runtime/select', '/chamber/runtime/apply',
    '/chamber/runtime/apply-now', '/chamber/runtime/rollback', '/chamber/runtime/restore-builtin',
    '/chamber/runtime/retry-apply', '/chamber/runtime/retry-restore',
    '/chamber/runtime/restart', '/chamber/runtime/registry',
  ]) assert.match(source, new RegExp(path.replaceAll('/', '\\/')))
  // Secret-blind (design 17 §10.4): the dashboard persists nothing (no web
  // storage), never reads Authorization headers, and never injects secret
  // values via innerHTML. The Phase 3 Credentials panel necessarily speaks of
  // "token" (labels + /auth/change-token) and reveals a rotated token ONCE in
  // a readonly textarea — the guard is about storage/header persistence and
  // injection, not the literal word.
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|authorization)\b/i)
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/)
  assert.match(source, /AUTH_PATHS\.changeToken/, 'the panel drives the runtime token change endpoint')
  assert.match(source, /cred-token-value/, 'the panel reveals the rotated token in the readonly textarea')
  assert.match(source, /credentials: 'same-origin'/)
  assert.match(source, /method: 'PUT'/)
  assert.match(source, /outcome: 'allowed-once'/)
  assert.match(source, /answer: \{ answers: answers \}/)
  assert.match(source, /dsh-chamber-gateway-runtime/,
    'the dashboard refuses a non-gateway status payload instead of rendering unrelated JSON')
  assert.match(source, /setInterval\(function \(\) \{ void loadRuntimeStatus\(\); \}, 3000\)/,
    'runtime status keeps polling independently while the dsh-derived feature host is down')
  assert.match(source, /payload\.error/,
    'runtime action failures render the authenticated API error instead of only a status code')
  assert.match(source, /row\.phase === 'installing'/,
    'the standalone dashboard disables mutations throughout the install single-flight')
  assert.match(source, /row\.phase === 'pending'/,
    'the standalone dashboard mirrors the pending terminal gate')
  assert.match(source, /runtime-apply-now'\)\.disabled/,
    'apply-now is wired into the control-disable matrix (design 18 addendum §6.4)')
  assert.match(source, /row\.selectedVersion !== row\.activeVersion/,
    'apply-now enablement mirrors the SERVER-persisted selection (row.selectedVersion), not the dropdown value (P2 review fix)')
  assert.doesNotMatch(source, /applyNowAvailable = row !== null && \(row\.phase === 'pending' \|\| \(selected !== null && selected !== row\.activeVersion\)\)/,
    'the stale dropdown-based apply-now enablement is gone')
  assert.match(source, /RUNTIME_PATHS\.applyNow/,
    'the apply-now click handler posts through the runtime single-flight action machinery')
  assert.match(source, /Applying… restarting/,
    'the activation window renders the honest applying/restarting status copy (§6.3)')
  assert.match(source, /runtime-restore'\)\.disabled = baseMutationBlocked/,
    'restore-builtin remains the sole pending escape instead of inheriting the pending block')

  const head = new FakeResponse()
  await host.handle(new FakeRequest('HEAD') as unknown as ApiRequest,
    head as unknown as ApiResponse, '/chamber/app.js')
  assert.equal(head.status, 200)
  assert.equal(head.chunks.join(''), '')
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(source))

  const settings = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    settings as unknown as ApiResponse, '/chamber/settings')
  assert.equal(settings.headers['content-type'], 'application/json')
  assert.deepEqual(settings.json(), { schemaVersion: 1, revision: 0 })
})
