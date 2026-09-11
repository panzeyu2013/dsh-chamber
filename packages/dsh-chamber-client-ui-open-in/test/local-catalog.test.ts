/**
 * Local catalog client tests (design 20 §4.2) — the browser half of the
 * `openInApp` wire.
 *
 * The transport is injected, so everything here runs without an instance, a
 * socket or the DOM: what is pinned is the wire DISCIPLINE — the argument names
 * the host reads, the strict parsing of the `{ok,value}|{ok:false,error}`
 * carrier, the fail-closed reads, the `data:` URL allow-list and the launch
 * error mapping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalCatalog, displayKindOf, type OpenInAppRpcCall } from '../src/client/local-catalog.ts'
import {
  OPEN_IN_APP_APPS_METHOD,
  OPEN_IN_APP_ICON_METHOD,
  OPEN_IN_APP_OPEN_METHOD,
} from '../src/shared/open-in-wire.ts'

interface Recorded {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
}

/** A carrier that answers from a table while recording every call. */
function carrierOf(answers: Readonly<Record<string, unknown>>): {
  readonly call: OpenInAppRpcCall
  readonly calls: Recorded[]
} {
  const calls: Recorded[] = []
  return {
    calls,
    call: async (endpoint, args) => {
      calls.push({ endpoint, args })
      if (!(endpoint in answers)) throw new Error(`unexpected endpoint ${endpoint}`)
      const answer = answers[endpoint]
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

test('load maps the host catalog into local entries', async () => {
  const carrier = carrierOf({ [OPEN_IN_APP_APPS_METHOD]: { ok: true, value: { apps: ['finder', 'terminal', 'vscode'] } } })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.deepEqual(await catalog.load(), [
    { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true },
    { id: 'terminal', displayKind: 'terminal', remoteCapable: false, available: true },
    { id: 'vscode', displayKind: 'vscode', remoteCapable: false, available: true },
  ])
  assert.deepEqual(carrier.calls, [{ endpoint: OPEN_IN_APP_APPS_METHOD, args: {} }])
})

test('load drops malformed ids and duplicates instead of failing the whole read', async () => {
  const carrier = carrierOf({
    [OPEN_IN_APP_APPS_METHOD]: { ok: true, value: { apps: ['finder', '', 42, 'finder', 'terminal'] } },
  })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.deepEqual((await catalog.load()).map(entry => entry.id), ['finder', 'terminal'])
})

test('load is fail-closed for a drifted, failing, refusing or unreachable host', async () => {
  const cases: readonly unknown[] = [
    { ok: true, value: { apps: 'not-an-array' } },
    { ok: true, value: null },
    { ok: false, error: { code: 'unavailable-app', message: 'nope' } },
    { ok: 'yes' },
    null,
    'text',
    new Error('transport failure'),
  ]
  for (const answer of cases) {
    const carrier = carrierOf({ [OPEN_IN_APP_APPS_METHOD]: answer })
    const catalog = createLocalCatalog({ call: carrier.call })
    assert.deepEqual(await catalog.load(), [], `answer ${JSON.stringify(answer)}`)
  }
})

test('icon builds an allow-listed data URL and records the app parameter', async () => {
  const carrier = carrierOf({
    [OPEN_IN_APP_ICON_METHOD]: { ok: true, value: { mime: 'image/png', dataBase64: 'AAAA' } },
  })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.equal(await catalog.icon('finder'), 'data:image/png;base64,AAAA')
  assert.deepEqual(carrier.calls, [{ endpoint: OPEN_IN_APP_ICON_METHOD, args: { app: 'finder' } }])
})

test('icon refuses a media type outside the host output set', async () => {
  const carrier = carrierOf({
    [OPEN_IN_APP_ICON_METHOD]: { ok: true, value: { mime: 'text/html', dataBase64: 'AAAA' } },
  })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.equal(await catalog.icon('finder'), null)
})

test('icon is null for every failure shape', async () => {
  const cases: readonly unknown[] = [
    { ok: false, error: { code: 'icon-unavailable', message: 'none' } },
    { ok: true, value: { mime: 'image/png' } },
    { ok: true, value: { mime: 'image/png', dataBase64: '' } },
    { ok: true, value: {} },
    new Error('transport failure'),
  ]
  for (const answer of cases) {
    const carrier = carrierOf({ [OPEN_IN_APP_ICON_METHOD]: answer })
    const catalog = createLocalCatalog({ call: carrier.call })
    assert.equal(await catalog.icon('finder'), null, `answer ${JSON.stringify(answer)}`)
  }
})

test('launch posts the app and the absolute path in the host argument names', async () => {
  const carrier = carrierOf({ [OPEN_IN_APP_OPEN_METHOD]: { ok: true, value: {} } })
  const catalog = createLocalCatalog({ call: carrier.call })

  await catalog.launch('terminal', '/Users/me/project')
  assert.deepEqual(carrier.calls, [
    { endpoint: OPEN_IN_APP_OPEN_METHOD, args: { app: 'terminal', path: '/Users/me/project' } },
  ])
})

test('launch surfaces the host domain failure and rejects an unrecognizable answer', async () => {
  const failing = carrierOf({
    [OPEN_IN_APP_OPEN_METHOD]: { ok: false, error: { code: 'directory-missing', message: 'directory does not exist: /nope' } },
  })
  await assert.rejects(
    createLocalCatalog({ call: failing.call }).launch('terminal', '/nope'),
    /directory-missing: directory does not exist: \/nope/u,
  )

  const drifted = carrierOf({ [OPEN_IN_APP_OPEN_METHOD]: { value: {} } })
  await assert.rejects(createLocalCatalog({ call: drifted.call }).launch('terminal', '/nope'), /unrecognizable/u)

  const unreachable = carrierOf({ [OPEN_IN_APP_OPEN_METHOD]: new Error('transport failure') })
  await assert.rejects(createLocalCatalog({ call: unreachable.call }).launch('terminal', '/nope'), /transport failure/u)
})

test('displayKindOf groups the families the button dresses', () => {
  assert.equal(displayKindOf('finder'), 'file-manager')
  assert.equal(displayKindOf('explorer'), 'file-manager')
  assert.equal(displayKindOf('filemanager'), 'file-manager')
  assert.equal(displayKindOf('vscode'), 'vscode')
  assert.equal(displayKindOf('vscodeinsiders'), 'vscode')
  assert.equal(displayKindOf('terminal'), 'terminal')
})
