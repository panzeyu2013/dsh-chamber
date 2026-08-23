import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GatewayOrchestrationApi,
  buildGatewayQuestionAnswer,
  gatewayChamberBasePath,
} from '../src/client/gateway-orchestration-api.ts'

test('gateway orchestration derives a bounded same-origin path from canonical gateway source ids', () => {
  assert.equal(gatewayChamberBasePath('gateway-prod_1'), '/api/i/gateway-prod_1/chamber')
  for (const sourceId of ['ssh-prod', 'gateway-', 'gateway-../prod', '/gateway-prod', 'https://gateway-prod']) {
    assert.throws(() => gatewayChamberBasePath(sourceId), /Invalid gateway source id/)
  }
})

test('gateway orchestration projects only documented non-secret settings and uses final route shapes', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = []
  const responses = new Map<string, unknown>([
    ['/api/i/gateway-prod/chamber/settings', {
      schemaVersion: 1,
      revision: 7,
      git: { enabled: true },
      notifications: { enabled: false },
      schedule: { enabled: true },
      token: 'must-not-escape',
      nestedSecret: { password: 'must-not-escape' },
    }],
    ['/api/i/gateway-prod/chamber/sessions', { items: [{
      sessionId: 's-1', title: 'Build', running: true, blank: false, cwd: '/repo', updatedAt: 42,
      metadata: { transcript: 'not part of the UI projection' },
    }] }],
    ['/api/i/gateway-prod/chamber/approvals', { items: [
      { kind: 'approval', sessionId: 's-1', approvalId: 'a-1', rpcId: 'rpc-a', toolName: 'Bash', reason: 'needs access' },
      { kind: 'question', sessionId: 's-1', rpcId: 'rpc-q', questions: [{
        id: 'mode', header: 'Mode', question: 'Choose', multiSelect: false,
        options: [{ label: 'safe', description: 'Safe mode' }, { label: 'fast' }],
      }] },
    ] }],
    ['/api/i/gateway-prod/chamber/schedule', { items: [{
      id: 'job-1', delayMs: 1_000, intervalMs: null, targetSessionId: 's-1', prompt: 'continue',
    }] }],
    ['/api/i/gateway-prod/chamber/git/worktrees', { items: [{
      id: 'w-1', workspaceId: 'ws-1', path: '/repo-wt', branch: 'feature', ownership: 'owned', state: 'ready', createdAt: 99,
    }] }],
  ])

  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input)
    calls.push({ path, init })
    if (init.method === 'PUT') {
      return Response.json({ revision: 8, git: { enabled: false }, notifications: { enabled: true }, schedule: { enabled: false } })
    }
    if (init.method === 'POST') return Response.json({ answered: true })
    const body = responses.get(path)
    assert.notEqual(body, undefined, `unexpected request ${path}`)
    return Response.json(body)
  }

  const api = new GatewayOrchestrationApi('gateway-prod', fakeFetch)
  const settings = await api.settings()
  assert.deepEqual(settings, {
    schemaVersion: 1,
    revision: 7,
    git: { enabled: true },
    notifications: { enabled: false },
    schedule: { enabled: true },
  })
  assert.equal('token' in settings, false)
  assert.equal('nestedSecret' in settings, false)

  assert.deepEqual(await api.sessions(), [{
    sessionId: 's-1', title: 'Build', running: true, blank: false, cwd: '/repo', updatedAt: 42,
  }])
  const interactions = await api.interactions()
  assert.equal(interactions.length, 2)
  assert.equal(interactions[1]?.kind, 'question')
  assert.equal((interactions[1] as { questions: unknown[] }).questions.length, 1)
  assert.equal((await api.schedule())[0]?.id, 'job-1')
  assert.equal((await api.worktrees())[0]?.workspaceId, 'ws-1')

  await api.updateSettings({
    git: { enabled: false }, notifications: { enabled: true }, schedule: { enabled: false },
  })
  await api.answerApproval('rpc-a', 'allowed-once')
  await api.answerQuestion('rpc-q', { answers: [{ id: 'mode', selected: ['safe'] }] })

  const put = calls.find(call => call.init.method === 'PUT')
  assert.deepEqual(JSON.parse(String(put?.init.body)), {
    git: { enabled: false }, notifications: { enabled: true }, schedule: { enabled: false },
  })
  const posts = calls.filter(call => call.init.method === 'POST').map(call => JSON.parse(String(call.init.body)))
  assert.deepEqual(posts, [
    { rpcId: 'rpc-a', outcome: 'allowed-once' },
    { rpcId: 'rpc-q', answer: { answers: [{ id: 'mode', selected: ['safe'] }] } },
  ])
  for (const call of calls) {
    assert.match(call.path, /^\/api\/i\/gateway-prod\/chamber\//)
    assert.equal(new Headers(call.init.headers).has('authorization'), false, 'renderer must never carry a gateway token')
    assert.equal(call.init.credentials, 'same-origin')
  }
})

test('question answer builder follows the gateway vocabulary and rejects stale option state', () => {
  const answer = buildGatewayQuestionAnswer({
    kind: 'question', sessionId: 's-1', rpcId: 'rpc-q', questions: [
      { id: 'single', question: 'one', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'multi', question: 'many', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
    ],
  }, {
    single: ['b', 'a', 'stale'],
    multi: ['x', 'x', 'stale', 'y'],
  }, {
    single: '  detail  ',
  })
  assert.deepEqual(answer, { answers: [
    { id: 'single', selected: ['b'], custom: 'detail' },
    { id: 'multi', selected: ['x', 'y'] },
  ] })
})

test('gateway orchestration fails loud on proxy status and malformed rows', async () => {
  const unavailable = new GatewayOrchestrationApi('gateway-prod', async () =>
    Response.json({ code: 'instance_unavailable' }, { status: 503 }))
  await assert.rejects(() => unavailable.sessions(), /HTTP 503, instance_unavailable/)

  const malformed = new GatewayOrchestrationApi('gateway-prod', async () =>
    Response.json({ items: [{ sessionId: 's-1', running: true }] }))
  await assert.rejects(() => malformed.sessions(), /malformed session.blank/)
})
