/**
 * Official host-catalog adapter unit tests (Batch 3 Phase 2): the per-entry
 * base-path scoping, the id → presentation-family mapping, the fail-closed
 * read, and the launch carrier. Pure node:test — the fetcher and origin are
 * injected, so nothing touches the network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOfficialCatalog, displayKindOf } from '../src/client/official-catalog.ts'

interface Call {
  url: string
  init?: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

test('official catalog: apps read is scoped to the per-entry base path', async () => {
  const calls: Call[] = []
  const catalog = createOfficialCatalog({
    basePath: '/api/i/ssh-dev',
    origin: 'http://127.0.0.1:30800',
    fetcher: async (input, init) => {
      calls.push({ url: String(input), init })
      return jsonResponse({ apps: ['finder', 'vscode', 'cursor', 'terminal'] })
    },
  })
  const entries = await catalog.load()
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:30800/api/i/ssh-dev/open-in-app/apps'])
  assert.deepEqual(entries.map(entry => entry.id), ['finder', 'vscode', 'cursor', 'terminal'])
  assert.deepEqual(entries.map(entry => entry.displayKind), ['file-manager', 'vscode', 'cursor', 'terminal'])
  assert.deepEqual(entries.map(entry => entry.remoteCapable), [false, false, false, false])
  assert.deepEqual(entries.map(entry => entry.available), [true, true, true, true])
})

test('official catalog: a trailing slash normalizes away and an empty base path keeps the stock origin', async () => {
  const calls: string[] = []
  const stock = createOfficialCatalog({
    basePath: '',
    origin: 'http://host',
    fetcher: async (input) => { calls.push(String(input)); return jsonResponse({ apps: [] }) },
  })
  await stock.load()
  const slashed = createOfficialCatalog({
    basePath: '/api/i/local/',
    origin: 'http://host',
    fetcher: async (input) => { calls.push(String(input)); return jsonResponse({ apps: [] }) },
  })
  await slashed.load()
  assert.deepEqual(calls, ['http://host/open-in-app/apps', 'http://host/api/i/local/open-in-app/apps'])
})

test('official catalog: a refusing, unreachable or malformed host reads as an empty catalog', async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => jsonResponse({ apps: ['vscode'] }, 403),
    async () => { throw new Error('network down') },
    async () => jsonResponse({ apps: 'vscode' }),
    async () => jsonResponse({ nope: [] }),
  ]
  for (const fetcher of cases) {
    const catalog = createOfficialCatalog({ basePath: '/api/i/local', origin: 'http://host', fetcher })
    assert.deepEqual(await catalog.load(), [], 'fail-closed: no official channel, never a thrown UI')
  }
})

test('official catalog: non-string and empty catalog ids are dropped, not guessed', async () => {
  const catalog = createOfficialCatalog({
    basePath: '',
    origin: 'http://host',
    fetcher: async () => jsonResponse({ apps: ['vscode', '', 42, null, 'finder'] }),
  })
  assert.deepEqual((await catalog.load()).map(entry => entry.id), ['vscode', 'finder'])
})

test('official catalog: icon URLs are prefixed and percent-encoded', () => {
  const catalog = createOfficialCatalog({ basePath: '/api/i/local', origin: 'http://host' })
  assert.equal(catalog.iconUrl('vscode'), 'http://host/api/i/local/open-in-app/icon/vscode')
  assert.equal(catalog.iconUrl('weird/id'), 'http://host/api/i/local/open-in-app/icon/weird%2Fid')
})

test('official catalog: launch POSTs the exact payload and rejects loudly on failure', async () => {
  const calls: Call[] = []
  const okCatalog = createOfficialCatalog({
    basePath: '/api/i/local',
    origin: 'http://host',
    fetcher: async (input, init) => {
      calls.push({ url: String(input), init })
      return jsonResponse({ ok: true })
    },
  })
  await okCatalog.launch('vscode', '/home/user/ws')
  assert.equal(calls[0]?.url, 'http://host/api/i/local/open-in-app/open')
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json')
  assert.equal(calls[0]?.init?.body, JSON.stringify({ app: 'vscode', path: '/home/user/ws' }))

  const failing = createOfficialCatalog({
    basePath: '',
    origin: 'http://host',
    fetcher: async () => jsonResponse({ code: 'nope' }, 500),
  })
  await assert.rejects(() => failing.launch('vscode', '/home/user/ws'), /open failed: HTTP 500/)
})

test('official catalog: the display-family mapping covers the file-manager and vscode families only', () => {
  assert.equal(displayKindOf('finder'), 'file-manager')
  assert.equal(displayKindOf('explorer'), 'file-manager')
  assert.equal(displayKindOf('filemanager'), 'file-manager')
  assert.equal(displayKindOf('vscode'), 'vscode')
  assert.equal(displayKindOf('vscodeinsiders'), 'vscode')
  assert.equal(displayKindOf('cursor'), 'cursor')
  assert.equal(displayKindOf('terminal'), 'terminal')
})
