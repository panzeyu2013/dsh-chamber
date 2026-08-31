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

test('session index waits for readiness, rebuilds its session/list baseline, and reconnects after a failure', async () => {
  let baseUrl: string | null = null
  let listCalls = 0
  const index = createSessionIndex({
    getDshBaseUrl: () => baseUrl,
    logger,
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async (_base: string, method: string, payload?: unknown) => {
      listCalls += 1
      // One transient poll failure must not consume the index: the generation
      // clears and reconnects, then installs a fresh baseline.
      if (listCalls === 2) throw new Error('transient failure')
      return {
        rpcId: `baseline-${listCalls}`,
        result: {
          ok: true,
          value: { items: [{
            sessionId: 'session-baseline', updatedAt: 10, running: false, blank: true, cwd: '/repo',
            projections: { asOfSeq: 0, values: { title: `Title ${listCalls}` } },
          }] },
        },
      }
    }) as any,
  })

  index.start()
  index.start()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(listCalls, 0)
  baseUrl = 'http://127.0.0.1:12345'
  await waitFor(() => index.get('session-baseline')?.title === 'Title 1')
  assert.deepEqual(index.get('session-baseline'), {
    sessionId: 'session-baseline', title: 'Title 1', running: false, blank: true, cwd: '/repo', updatedAt: 10,
  })
  await waitFor(() => index.get('session-baseline')?.title === 'Title 3')
  index.stop()
  index.stop()
  assert.deepEqual(index.list(), [])
})

test('session index atomically replaces the projection: sessions absent from the latest baseline disappear', async () => {
  let releaseFirst!: () => void
  const firstBaselineGate = new Promise<void>(resolve => { releaseFirst = resolve })
  let baselineStarted = false
  let listCalls = 0
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async (_base: string, method: string, payload?: unknown) => {
      listCalls += 1
      if (listCalls === 1) {
        baselineStarted = true
        await firstBaselineGate
        return {
          rpcId: 'baseline-race',
          result: { ok: true, value: { items: [{
            sessionId: 'session-race', updatedAt: 50, running: false, blank: true, cwd: '/race',
            projections: { asOfSeq: -1, values: {} },
          }] } },
        }
      }
      // The next baseline drops session-race (removed upstream): the map is
      // replaced wholesale — no stale session may survive a newer baseline.
      return { rpcId: `list-${listCalls}`, result: { ok: true, value: { items: [] } } }
    }) as any,
  })
  index.start()
  await waitFor(() => baselineStarted)
  assert.deepEqual(index.list(), [], 'no partial pre-baseline state is published')
  releaseFirst()
  await waitFor(() => index.get('session-race') !== undefined)
  await waitFor(() => index.list().length === 0)
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
    onApproval: request => approvals.push(request.approvalId),
    onQuestion() {},
    openRemoteStream: async function *(): AsyncGenerator<unknown> {
      streamCalls += 1
      // 0.1.2 $events stream: ready frame binds the clientId, waterfall
      // frames carry the answerable approval/request.
      yield { type: 'ready', clientId: `client-${streamCalls}`, host: { home: '/home' } }
      yield {
        type: 'waterfall', event: 'approval/request', eventId: `a${streamCalls}`,
        agentId: 's1', request: { toolName: 'shell' },
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

test('approval notifier emits $events/result RPCs and rejects negative receipts', async () => {
  const sent: Array<{ method: string; payload: any }> = []
  let accepted = false
  const notifier = createApprovalNotifier({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    onApproval() {},
    onQuestion() {},
    callDsh: (async (_base: string, method: string, payload: unknown) => {
      sent.push({ method, payload })
      return accepted
        ? { rpcId: 'r', result: { ok: true, value: undefined } }
        : { rpcId: 'r', result: { ok: false, error: { code: 'unknown-event', message: 'bad-response' } } }
    }) as any,
  })
  const approval = { sessionId: 's1', approvalId: 'a1', clientId: 'client-1', toolName: 'shell' }
  await assert.rejects(notifier.answerApproval(approval, 'allowed-once'),
    (error: unknown) => error instanceof AnswerRejectedError)
  assert.deepEqual(sent[0], {
    method: '$events/result',
    payload: { args: { clientId: 'client-1', eventId: 'a1', outcome: { kind: 'result', value: 'allowed-once' } } },
  })

  await assert.rejects(notifier.answerQuestion({
    sessionId: 's1', questionId: 'q1', clientId: 'client-1', questions: [],
  }, { answers: [] }), (error: unknown) => error instanceof AnswerRejectedError)
  assert.equal(sent[1]?.payload.args.eventId, 'q1')
  accepted = true
  await notifier.answerQuestion({ sessionId: 's1', questionId: 'q1', clientId: 'client-1', questions: [] }, { answers: [] })
})

test('notify $events/result RPC shapes are locked for approval and question answers', async () => {
  // Regression guard: the answer path is the single 0.1.2 $events/result RPC
  // ({args:{clientId,eventId,outcome}} — the args keys are the Remote event
  // result fields; the outcome value is the waterfall answer). Lock the exact
  // shapes so a future refactor cannot silently drift them.
  const sent: Array<{ method: string; payload: any }> = []
  const notifier = createApprovalNotifier({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    onApproval() {},
    onQuestion() {},
    callDsh: (async (_base: string, method: string, payload: unknown) => {
      sent.push({ method, payload })
      return { rpcId: 'r', result: { ok: true, value: undefined } }
    }) as any,
  })
  await notifier.answerApproval(
    { sessionId: 's1', approvalId: 'a1', clientId: 'client-1', toolName: 'shell' },
    'allowed-once',
  )
  assert.deepEqual(sent[0], {
    method: '$events/result',
    payload: { args: { clientId: 'client-1', eventId: 'a1', outcome: { kind: 'result', value: 'allowed-once' } } },
  })
  const answer = { answers: [{ id: 'q1', selected: ['a'] }] }
  await notifier.answerQuestion({ sessionId: 's1', questionId: 'q1', clientId: 'client-1', questions: [] }, answer)
  assert.deepEqual(sent[1], {
    method: '$events/result',
    payload: { args: { clientId: 'client-1', eventId: 'q1', outcome: { kind: 'result', value: answer } } },
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

test('scheduler fires session/prompt with the dsh 0.1.2-alpha.2 wire shape (requestId+mode+content)', async () => {
  // Live finding: the old {sessionId, prompt} payload was rejected by the
  // real wire ("invalid payload for session/prompt") — every scheduled
  // prompt failed validation. The accepted shape is
  // {args:{request:{requestId, sessionId, mode:'queue', content:[{type:'text',text}]}}}
  // (the args keys are the @Remote parameter names; requestId is client-minted
  // and echoed on SessionQueuedItem.rpcId).
  const sent: Array<{ method: string; sessionId: string; requestId?: string; mode: string; content: unknown }> = []
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    callDsh: (async (_base: string, method: string, payload: unknown) => {
      // 0.1.2 TypertGatewayService wire: the payload must be the exact
      // `{args:{request:{...}}}` shape keyed by the @Remote parameter name.
      const request = (payload as { args: { request: { sessionId: string; requestId?: string; mode: string; content: unknown } } }).args.request
      sent.push({ method, ...request })
      return { rpcId: 'prompt-1', result: { ok: true, value: {} } }
    }) as any,
  })
  scheduler.schedule({ delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'continue' })
  scheduler.start()
  await waitFor(() => sent.length === 1)
  scheduler.stop()
  assert.equal(sent[0]?.method, 'session/prompt', 'the scheduled prompt targets session/prompt')
  assert.equal(typeof sent[0]?.requestId, 'string', 'session/prompt carries a client-minted requestId')
  assert.ok((sent[0]?.requestId ?? '').length > 0, 'the requestId is non-empty')
  assert.equal(sent[0]?.sessionId, 's1')
  assert.equal(sent[0]?.mode, 'queue')
  assert.deepEqual(sent[0]?.content, [{ type: 'text', text: 'continue' }])
})

test('a deterministic dsh rejection terminates a one-shot job and persists the removal', async () => {
  // RpcBusinessError (result.ok === false: target session deleted, payload
  // refused, …) can never succeed on retry — backing off would spin
  // session/prompt forever. The job must be removed and the removal
  // persisted, unlike transient carrier failures (next test).
  let calls = 0
  const persisted: Array<ScheduledJob[]> = []
  const scheduler = createScheduler({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    onJobRemoval: async intent => {
      persisted.push(scheduler.list().filter(job => job !== intent.job))
      intent.commit()
    },
    callDsh: (async () => {
      calls += 1
      throw new RpcBusinessError({ code: 'session/not-found', message: 'target session deleted' })
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

test('a business rejection that settles after scheduler stop cannot remove or persist either job kind', async () => {
  for (const intervalMs of [null, 1_000] as const) {
    let releasePrompt!: () => void
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve })
    let calls = 0
    let persistedRemovals = 0
    const scheduler = createScheduler({
      getDshBaseUrl: () => 'http://127.0.0.1:12345',
      logger,
      onJobRemoval: async intent => {
        persistedRemovals += 1
        intent.commit()
      },
      callDsh: (async () => {
        calls += 1
        await promptGate
        throw new RpcBusinessError({ code: 'session-not-found', message: 'late rejection' })
      }) as any,
    })
    const job = scheduler.schedule({
      delayMs: 0, intervalMs, targetSessionId: 's1', prompt: 'retain after detach',
    })
    scheduler.start()
    await waitFor(() => calls === 1)
    scheduler.stop()
    releasePrompt()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(persistedRemovals, 0, `${intervalMs === null ? 'one-shot' : 'interval'} late verdict must not persist`)
    assert.equal(scheduler.list()[0], job, `${intervalMs === null ? 'one-shot' : 'interval'} definition remains for reattach`)
  }
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
  scheduleMutate?: (next: ScheduledJob[]) => Promise<void>
  settingsMutate?: (next: Record<string, unknown>) => Promise<void>
  worktreesMutate?: (next: WorktreeStoreRecord[]) => Promise<void>
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
    worktrees: {
      get: () => ({ items: worktrees }),
      mutate: async mutator => {
        const mutation = mutator({ items: worktrees })
        if (mutation.changed) {
          await options.worktreesMutate?.(mutation.next.items)
          worktrees = mutation.next.items
        }
      },
    },
    schedule: {
      get: () => ({ items: schedule }),
      mutate: async mutator => {
        const mutation = mutator({ items: schedule })
        if (mutation.changed) {
          await options.scheduleMutate?.(mutation.next.items)
          schedule = mutation.next.items
        }
      },
    },
    settings: {
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
    assert.equal(restarted.worktrees.get().items[0]?.ownership, 'unverified')
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

test('delayMs=0 is armed only after persistence commits, and a failed admission never prompts', async () => {
  function transport(onPrompt: () => void) {
    return {
      callDsh: (async (_base: string, method: string) => {
        if (method === 'session/prompt') {
          onPrompt()
          return { rpcId: 'prompt', result: { ok: true, value: {} } }
        }
        return { rpcId: 'sessions', result: { ok: true, value: { items: [] } } }
      }) as any,
      openRemoteStream: async function *(
        _base: string,
        _endpoint: string,
        _payload: unknown,
        signal?: AbortSignal,
      ): AsyncGenerator<ServerRequest> {
        if (!signal?.aborted) {
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        }
      },
    }
  }

  let releaseCommit!: () => void
  const commitGate = new Promise<void>(resolve => { releaseCommit = resolve })
  let markCommitStarted!: () => void
  const commitStarted = new Promise<void>(resolve => { markCommitStarted = resolve })
  let durable = false
  let committedPrompts = 0
  const committedHost = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
      scheduleMutate: async () => {
        markCommitStarted()
        await commitGate
        durable = true
      },
    }),
    featureTransport: transport(() => {
      assert.equal(durable, true, 'session.prompt cannot run before the admission is durable')
      committedPrompts += 1
    }),
  })
  committedHost.start()
  const committedResponse = new FakeResponse()
  const committedRequest = committedHost.handle(new FakeRequest('POST', {
    delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'after commit',
  }) as unknown as ApiRequest, committedResponse as unknown as ApiResponse, '/chamber/schedule')
  await commitStarted
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(committedPrompts, 0)
  assert.equal(committedResponse.status, 0, 'the request remains pending on its durable write')
  releaseCommit()
  await committedRequest
  assert.equal(committedResponse.status, 200)
  await waitFor(() => committedPrompts === 1)
  committedHost.stop()

  let releaseFailure!: () => void
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
  let markFailureStarted!: () => void
  const failureStarted = new Promise<void>(resolve => { markFailureStarted = resolve })
  let failedPrompts = 0
  const failedHost = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
      scheduleMutate: async () => {
        markFailureStarted()
        await failureGate
        throw new Error('disk full')
      },
    }),
    featureTransport: transport(() => { failedPrompts += 1 }),
  })
  failedHost.start()
  const failedResponse = new FakeResponse()
  const failedRequest = failedHost.handle(new FakeRequest('POST', {
    delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: 'must not run',
  }) as unknown as ApiRequest, failedResponse as unknown as ApiResponse, '/chamber/schedule')
  await failureStarted
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(failedPrompts, 0)
  releaseFailure()
  await failedRequest
  assert.equal(failedResponse.status, 500)
  assert.equal(failedResponse.json().code, 'persistence_failed')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(failedPrompts, 0, 'a rejected durable admission leaves no armed timer')
  failedHost.stop()
})

test('automatic schedule removal rebases its identity intent after a blocked persistence writer', async () => {
  let releaseSettings!: () => void
  const settingsGate = new Promise<void>(resolve => { releaseSettings = resolve })
  let markSettingsStarted!: () => void
  const settingsStarted = new Promise<void>(resolve => { markSettingsStarted = resolve })
  const scheduleWrites: ScheduledJob[][] = []
  let prompts = 0
  const oldJob: ScheduledJob = {
    id: 'old-job', delayMs: 0, intervalMs: null, targetSessionId: 's-old', prompt: 'old',
  }
  const host = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
      schedule: [oldJob],
      settingsMutate: async () => {
        markSettingsStarted()
        await settingsGate
      },
      scheduleMutate: async next => { scheduleWrites.push([...next]) },
    }),
    featureTransport: {
      callDsh: (async (_base: string, method: string) => {
        if (method === 'session/prompt') {
          prompts += 1
          return { rpcId: 'old-prompt', result: { ok: true, value: {} } }
        }
        return { rpcId: 'sessions', result: { ok: true, value: { items: [] } } }
      }) as any,
      openRemoteStream: async function *(
        _base: string,
        _endpoint: string,
        _payload: unknown,
        signal?: AbortSignal,
      ): AsyncGenerator<ServerRequest> {
        if (!signal?.aborted) {
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        }
      },
    },
  })

  // Occupy the shared persistence tail before arming the restored job. Its
  // completion then queues a removal intent, followed by a new POST.
  const settingsResponse = new FakeResponse()
  const settingsRequest = host.handle(new FakeRequest('PUT', { git: { enabled: true } }) as unknown as ApiRequest,
    settingsResponse as unknown as ApiResponse, '/chamber/settings')
  await settingsStarted
  host.start()
  await waitFor(() => prompts === 1)

  const postResponse = new FakeResponse()
  const postRequest = host.handle(new FakeRequest('POST', {
    delayMs: 60_000, intervalMs: null, targetSessionId: 's-new', prompt: 'new',
  }) as unknown as ApiRequest, postResponse as unknown as ApiResponse, '/chamber/schedule')
  await new Promise(resolve => setTimeout(resolve, 10))
  releaseSettings()
  await Promise.all([settingsRequest, postRequest])

  assert.equal(postResponse.status, 200)
  const newJob = postResponse.json() as ScheduledJob
  assert.deepEqual(scheduleWrites.map(items => items.map(job => job.id)), [[], [newJob.id]],
    'the queued POST snapshots memory only after the old identity is durably removed and committed')
  const listed = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    listed as unknown as ApiResponse, '/chamber/schedule')
  assert.deepEqual(listed.json().items.map((job: ScheduledJob) => job.id), [newJob.id])
  host.stop()
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

test('feature mutation quiescence fences admission, drains the full write, and reopens on start', async () => {
  let markWriteStarted!: () => void
  const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve })
  let releaseWrite!: () => void
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
  let writes = 0
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settingsMutate: async () => {
        writes += 1
        if (writes === 1) {
          markWriteStarted()
          await writeGate
        }
      },
    }),
  })
  host.start()

  const admittedResponse = new FakeResponse()
  const admitted = host.handle(new FakeRequest('PUT', { git: { enabled: true } }) as unknown as ApiRequest,
    admittedResponse as unknown as ApiResponse, '/chamber/settings')
  await writeStarted

  let drainSettled = false
  const draining = host.quiesce().then(() => { drainSettled = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(drainSettled, false, 'quiescence waits for the complete admitted persistence transaction')

  const fencedResponse = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { schedule: { enabled: true } }) as unknown as ApiRequest,
    fencedResponse as unknown as ApiResponse, '/chamber/settings')
  assert.equal(fencedResponse.status, 503)
  assert.equal(fencedResponse.json().code, 'gateway_stopping')
  assert.equal(writes, 1, 'a fenced mutation never reaches persistence')

  releaseWrite()
  await admitted
  await draining
  assert.equal(admittedResponse.status, 200)
  assert.equal(drainSettled, true)

  host.stop()
  host.start()
  const restartedResponse = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { schedule: { enabled: true } }) as unknown as ApiRequest,
    restartedResponse as unknown as ApiResponse, '/chamber/settings')
  assert.equal(restartedResponse.status, 200, 'the next start generation reopens mutation admission')
  assert.equal(writes, 2)
  host.stop()
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
  let listCalls = 0
  const transport = {
    reconnectDelayMs: 5,
    callDsh: (async (_base: string, method: string) => {
      if (method === 'session/prompt') {
        prompts += 1
        return { rpcId: `prompt-${prompts}`, result: { ok: true, value: {} } }
      }
      if (method === 'session/list') listCalls += 1
      return { rpcId: 'session-list', result: { ok: true, value: { items: [] } } }
    }) as any,
    openRemoteStream: async function *(
      _base: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): AsyncGenerator<unknown> {
      // The notifier opens the $events stream; the session index opens the
      // session/control stream. Both hang until aborted (feature detach
      // counts the abort).
      muxStarts += 1
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
  // muxStarts === 2: the session index opens the session/control stream AND
  // the approval notifier opens the $events stream (0.1.2 wire); the
  // persisted schedule fires once.
  await waitFor(() => muxStarts === 2 && prompts === 1 && listCalls >= 1)
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
  listCalls = 0
  const host = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore(),
    featureTransport: transport,
  })
  host.start()
  // All flags off: the session index still starts (it opens the
  // session/control stream), the notifier does not attach.
  await waitFor(() => muxStarts === 1)

  const enableNotifications = new FakeResponse()
  await host.handle(new FakeRequest('PUT', { notifications: { enabled: true } }) as unknown as ApiRequest,
    enableNotifications as unknown as ApiResponse, '/chamber/settings')
  assert.equal(enableNotifications.status, 200)
  await waitFor(() => muxStarts === 2)

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

test('schedule POST rejects empty or oversized prompts and target session ids with invalid_input', async () => {
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
    }),
  })
  for (const body of [
    { delayMs: 0, intervalMs: null, targetSessionId: '', prompt: 'ok' },
    { delayMs: 0, intervalMs: null, targetSessionId: 's1', prompt: '' },
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

test('persisted schedules with empty target session ids or prompts are isolated on restore', async () => {
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, schedule: { enabled: true } },
      schedule: [
        { id: 'empty-target', delayMs: 60_000, intervalMs: null, targetSessionId: '', prompt: 'ok' },
        { id: 'empty-prompt', delayMs: 60_000, intervalMs: null, targetSessionId: 's1', prompt: '' },
        { id: 'valid', delayMs: 60_000, intervalMs: null, targetSessionId: 's1', prompt: 'ok' },
      ],
    }),
  })
  const response = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    response as unknown as ApiResponse, '/chamber/schedule')
  assert.deepEqual(response.json().items.map((item: ScheduledJob) => item.id), ['valid'])
  host.stop()
})

test('persisted schedule recovery enforces the same total job cap as POST admission', async () => {
  const jobs = Array.from({ length: 1_001 }, (_, i) => ({
    id: `restored-${i}`, delayMs: 60_000, intervalMs: null, targetSessionId: 's1', prompt: 'p',
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
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    response as unknown as ApiResponse, '/chamber/schedule')
  assert.equal(response.json().items.length, 1_000)
  assert.equal(response.json().items.at(-1).id, 'restored-999')
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

test('concurrent schedule POSTs cannot exceed the total job cap', async () => {
  const jobs = Array.from({ length: 999 }, (_, i) => ({
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
  const firstResponse = new FakeResponse()
  const secondResponse = new FakeResponse()
  const requestBody = {
    delayMs: 60_000, intervalMs: null, targetSessionId: 's1', prompt: 'last slot',
  }
  await Promise.all([
    host.handle(new FakeRequest('POST', requestBody) as unknown as ApiRequest,
      firstResponse as unknown as ApiResponse, '/chamber/schedule'),
    host.handle(new FakeRequest('POST', requestBody) as unknown as ApiRequest,
      secondResponse as unknown as ApiResponse, '/chamber/schedule'),
  ])

  assert.deepEqual([firstResponse.status, secondResponse.status].sort(), [200, 400])
  const rejected = firstResponse.status === 400 ? firstResponse : secondResponse
  assert.equal(rejected.json().code, 'schedule_full')
  const listed = new FakeResponse()
  await host.handle(new FakeRequest('GET') as unknown as ApiRequest,
    listed as unknown as ApiResponse, '/chamber/schedule')
  assert.equal(listed.json().items.length, 1_000)
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
  assert.equal(response.endCalls, 0, 'request close does not unregister or end the streaming response')
  host.stop()
  assert.equal(response.endCalls, 1, 'feature-host stop closes the still-live SSE response exactly once')

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

test('concurrent worktree DELETE holds one exact lease across the complete retryable saga', async () => {
  const fixture = await makeGitRepo('gateway-delete-lease-')
  const target = join(fixture.root, 'feature-delete-lease')
  execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', '-b', 'feature/delete-lease', target], { stdio: 'ignore' })

  let markDeletingPersistStarted!: () => void
  const deletingPersistStarted = new Promise<void>(resolve => { markDeletingPersistStarted = resolve })
  let releaseDeletingPersist!: () => void
  const deletingPersistGate = new Promise<void>(resolve => { releaseDeletingPersist = resolve })
  let markWorkspaceDeleteStarted!: () => void
  const workspaceDeleteStarted = new Promise<void>(resolve => { markWorkspaceDeleteStarted = resolve })
  let releaseWorkspaceDelete!: () => void
  const workspaceDeleteGate = new Promise<void>(resolve => { releaseWorkspaceDelete = resolve })
  let markFailurePersistStarted!: () => void
  const failurePersistStarted = new Promise<void>(resolve => { markFailurePersistStarted = resolve })
  let releaseFailurePersist!: () => void
  const failurePersistGate = new Promise<void>(resolve => { releaseFailurePersist = resolve })
  let markRemovalPersistStarted!: () => void
  const removalPersistStarted = new Promise<void>(resolve => { markRemovalPersistStarted = resolve })
  let releaseRemovalPersist!: () => void
  const removalPersistGate = new Promise<void>(resolve => { releaseRemovalPersist = resolve })

  let deletingPersistCalls = 0
  let failurePersistCalls = 0
  let removalPersistCalls = 0
  let workspaceDeleteCalls = 0
  let workspaceDeleted = false
  const host = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, git: { enabled: true } },
      worktrees: [{
        id: 'ws-delete-lease', workspaceId: 'ws-delete-lease', repo: fixture.repo, path: target,
        branch: 'feature/delete-lease', ownership: 'owned', state: 'ready', createdAt: 1,
      }],
      worktreesMutate: async next => {
        const record = next.find(item => item.workspaceId === 'ws-delete-lease')
        if (next.length === 0 && removalPersistCalls++ === 0) {
          markRemovalPersistStarted()
          await removalPersistGate
        } else if (record?.state === 'deleting' && record.error === undefined && deletingPersistCalls++ === 0) {
          markDeletingPersistStarted()
          await deletingPersistGate
        } else if (record?.state === 'deleting' && typeof record.error === 'string' && failurePersistCalls++ === 0) {
          markFailurePersistStarted()
          await failurePersistGate
        }
      },
    }),
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    let result: unknown
    // 0.1.2 wire: workspace facts derive from session/list cwds (workspace.list
    // was deleted upstream) and deletes ride workspace/delete.
    if (request.method === 'session/list') {
      result = { ok: true, value: { items: [
        { sessionId: 's-main', cwd: fixture.repo, running: false },
        ...(workspaceDeleted ? [] : [{ sessionId: 's-delete-lease', cwd: target, running: false }]),
      ] } }
    } else if (request.method === 'workspace/delete') {
      workspaceDeleteCalls += 1
      if (workspaceDeleteCalls === 1) {
        markWorkspaceDeleteStarted()
        await workspaceDeleteGate
        result = { ok: false, error: { code: 'temporary', message: 'try again' } }
      } else {
        workspaceDeleted = true
        result = { ok: true, value: { deleted: true } }
      }
    } else {
      throw new Error(`unexpected ${request.method}`)
    }
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch

  const expectConflict = async (phase: string): Promise<void> => {
    const response = new FakeResponse()
    await host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      response as unknown as ApiResponse, '/chamber/git/worktrees/ws-delete-lease')
    assert.equal(response.status, 409, phase)
    assert.equal(response.json().code, 'worktree_delete_in_progress', phase)
  }

  let firstDelete: Promise<boolean> | undefined
  let retryDelete: Promise<boolean> | undefined
  try {
    const firstResponse = new FakeResponse()
    firstDelete = host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      firstResponse as unknown as ApiResponse, '/chamber/git/worktrees/ws-delete-lease')

    await deletingPersistStarted
    await expectConflict('the lease starts before the deleting intent commits')
    releaseDeletingPersist()

    await workspaceDeleteStarted
    await expectConflict('the lease spans external workspace/Git mutations')
    releaseWorkspaceDelete()

    await failurePersistStarted
    await expectConflict('the lease spans failure-outcome persistence')
    releaseFailurePersist()
    await firstDelete
    assert.equal(firstResponse.status, 500)
    assert.equal(firstResponse.json().code, 'workspace_delete_failed')
    await assert.rejects(realpath(target), { code: 'ENOENT' })

    const retryResponse = new FakeResponse()
    retryDelete = host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      retryResponse as unknown as ApiResponse, '/chamber/git/worktrees/ws-delete-lease')
    await removalPersistStarted
    await expectConflict('the lease spans successful removal persistence')
    releaseRemovalPersist()
    await retryDelete
    assert.equal(retryResponse.status, 200)
    assert.deepEqual(retryResponse.json(), { deleted: true })
    assert.equal(workspaceDeleteCalls, 2)

    const afterRelease = new FakeResponse()
    await host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      afterRelease as unknown as ApiResponse, '/chamber/git/worktrees/ws-delete-lease')
    assert.equal(afterRelease.status, 404, 'the exact finally release cannot leak a completed lease')
    assert.equal(afterRelease.json().code, 'not_found')
  } finally {
    releaseDeletingPersist()
    releaseWorkspaceDelete()
    releaseFailurePersist()
    releaseRemovalPersist()
    await Promise.allSettled([firstDelete, retryDelete].filter((value): value is Promise<boolean> => value !== undefined))
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
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
  // 0.1.2 wire: session/list (slash) cwds are both the derived workspace-path
  // source and the session-liveness source. The main workspace and the dirty
  // worktree each carry a non-running session.
  globalThis.fetch = rpcFetch(method => {
    if (method === 'session/list') {
      sessionListCalls += 1
      return { ok: true, value: { items: [
        { sessionId: 's-main', running: false, cwd: fixture.repo },
        { sessionId: 's-dirty', running: false, cwd: target },
      ] } }
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
    // session/list (slash) serves the workspace-fact derivation (initial +
    // mutation-adjacent recheck) and the live-session guard before git removal.
    assert.equal(sessionListCalls, 3, 'the saga reached the live-session guard before git removal')
    let record = (await listWorktrees())[0]
    assert.equal(record?.state, 'ready', 'a dirty-tree failure must not stay stuck in deleting')
    assert.ok(typeof record?.error === 'string' && record.error !== '', 'the failure reason is recorded')
    assert.equal(await realpath(target), target, 'the worktree directory still exists')

    const second = new FakeResponse()
    await host.handle(new FakeRequest('DELETE') as unknown as ApiRequest,
      second as unknown as ApiResponse, '/chamber/git/worktrees/ws-dirty')
    assert.equal(second.status, 500, 'the second DELETE is still initiated')
    assert.equal(second.json().code, 'git_worktree_remove_failed')
    assert.ok(sessionListCalls >= 5, 'the retry re-entered the delete saga')
    record = (await listWorktrees())[0]
    assert.equal(record?.state, 'ready')
    assert.ok(typeof record?.error === 'string' && record.error !== '')
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('pending interactions dedupe, rejected receipts stay pending, and resolved/reset reach SSE clients', async () => {
  let accepted = false
  const responses: Array<{ method: string; payload: any }> = []
  const host = createFeatureHost({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger,
    channels,
    store: fakeStore({
      settings: { schemaVersion: 1, revision: 0, notifications: { enabled: true } },
    }),
    featureTransport: {
      reconnectDelayMs: 5,
      callDsh: (async (_base: string, method: string, payload: unknown) => {
        if (method === '$events/result') {
          responses.push({ method, payload })
          return accepted
            ? { rpcId: 'r', result: { ok: true, value: undefined } }
            : { rpcId: 'r', result: { ok: false, error: { code: 'unknown-event', message: 'bad-response' } } }
        }
        return { rpcId: 'session-list', result: { ok: true, value: { items: [] } } }
      }) as any,
      openRemoteStream: async function *(): AsyncGenerator<unknown> {
        // 0.1.2 $events stream: one ready frame, then the answerable
        // waterfalls (replayed twice — dedupe must keep one pending row each).
        yield { type: 'ready', clientId: 'client-1', host: { home: '/home' } }
        const requested: unknown[] = [
          {
            type: 'waterfall', event: 'approval/request', eventId: 'a1', agentId: 's1',
            request: { toolName: 'shell' },
          },
          {
            type: 'waterfall', event: 'user-questions/request', eventId: 'q1', agentId: 's1',
            request: { sessionId: 's1', questions: [] },
          },
        ]
        for (const frame of [...requested, ...requested]) yield frame
        await new Promise<void>(resolve => undefined)
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
  assert.equal((await getPending()).length, 2, 'replayed duplicate eventIds are deduplicated')
  assert.equal(sse.chunks.join('').includes('event: pending-reset'), true)

  const malformed = new FakeResponse()
  await host.handle(new FakeRequest('POST', {
    id: 'q1', answer: { answers: [{ id: '', selected: [] }] },
  }) as unknown as ApiRequest, malformed as unknown as ApiResponse, '/chamber/approvals')
  assert.equal(malformed.status, 400)
  assert.equal(responses.length, 0, 'malformed answers do not reach dsh')

  for (const body of [
    { id: 'a1', outcome: 'allowed-once' },
    { id: 'q1', answer: { answers: [] } },
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
    id: 'q1', answer: { answers: [] },
  }) as unknown as ApiRequest, answered as unknown as ApiResponse, '/chamber/approvals')
  assert.equal(answered.status, 200)
  assert.equal(responses.at(-1)?.payload.args.eventId, 'q1')
  // 0.1.2 wire: resolution is answer-driven — the row clears immediately.
  assert.equal((await getPending()).length, 1)

  await host.handle(new FakeRequest('POST', {
    id: 'a1', outcome: 'allowed-once',
  }) as unknown as ApiRequest, new FakeResponse() as unknown as ApiResponse, '/chamber/approvals')
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
      callDsh: (async (_base: string, method: string, payload: unknown) => {
        if (method === '$events/result') responses.push({ method, payload })
        return { rpcId: 'r', result: { ok: true, value: undefined } }
      }) as any,
      openRemoteStream: async function *(
        _base: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ): AsyncGenerator<unknown> {
        yield { type: 'ready', clientId: 'client-1', host: { home: '/home' } }
        yield {
          type: 'waterfall', event: 'approval/request', eventId: 'a1', agentId: 's1',
          request: { toolName: 'shell' },
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
    id: 'a1', outcome: 'allowed-once',
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
  })
  const approval = { sessionId: 's1', approvalId: 'a1', clientId: 'client-1', toolName: 'shell' }
  await assert.rejects(notifier.answerApproval(approval, 'allowed-once'),
    (error: unknown) => (error as { code?: string })?.code === 'instance_unavailable')
  await assert.rejects(notifier.answerQuestion({ sessionId: 's1', questionId: 'q', clientId: 'client-1', questions: [] }, { answers: [] }),
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
  assert.match(source, /result\.durability === 'unknown'/,
    'a token published before a durability error is still shown once with an explicit storage warning')
  assert.match(source, /disk durability could not be confirmed/)
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
