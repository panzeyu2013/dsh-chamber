/**
 * Production read-path lockstep for the page-level machine catalog
 * (2026-09-13): the catalog must answer installed apps and their real icons
 * when it is wired EXACTLY as `packages/renderer/src/shell.ts` wires it — the
 * REAL page-level instance client (`getInstanceClient('local').callUnary`,
 * with its URL, envelope and rpcId handling) against a stubbed fetch that
 * answers the host domain's own bytes.
 *
 * Why this file exists: the exchange carries TWO envelope levels — the Typert
 * TRANSPORT result (`{ok:true,value}`) and, inside `value`, the host domain's
 * own `domainResult` carrier (`packages/dsh-chamber-seed-open-in/src/core.ts`).
 * A client that reads only one level still satisfies every stub-fed unit test
 * (whose doubles answered the domain carrier directly) while answering an EMPTY
 * catalog in production — the running app showed no Finder and no application
 * icons for exactly that reason, with no error anywhere. `local-catalog.ts`
 * now reads both levels and its unit tests stub the real two-level shape; this
 * file goes one step further and drives the REAL instance client, so the seam
 * itself cannot drift again.
 *
 * Why HERE and not in the open-in package: this is the renderer's seam
 * (`shell.ts` builds the page's one catalog), and the renderer's tsconfig has
 * no package `rootDir`, which is what lets a test import the sidebar's wire
 * client AND the open-in client module in one process (the same cross-package
 * reach `shell.test.ts` already uses). The source lock at the end keeps the
 * behavioural half honest: the moment `shell.ts` stops handing `callUnary` to
 * `createMachineCatalog`, this test must be revisited instead of quietly
 * testing a fiction. It matches comment-stripped source (`source-text.ts`), so
 * prose cannot satisfy it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createMachineCatalog } from '../../dsh-chamber-client-ui-open-in/src/client/machine-catalog.ts'
import {
  OPEN_IN_APP_APPS_METHOD,
  OPEN_IN_APP_ICON_METHOD,
} from '../../dsh-chamber-client-ui-open-in/src/shared/open-in-wire.ts'
import { getInstanceClient } from '../../dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts'
import { normalize, stripComments } from './source-text.ts'

interface HostTable {
  /** Ids the host's catalog resolution found, in menu order. */
  readonly apps: readonly string[]
  /** Icons the host extracted; an absent id answers the `icon-unavailable` domain error. */
  readonly icons?: Readonly<Record<string, { readonly mime: string; readonly dataBase64: string }>>
}

interface StubHost {
  /** Every request, as `{method, pathname}` in arrival order. */
  readonly calls: Array<{ method: string; pathname: string }>
  restore(): void
}

/**
 * Answer the instance's generic-RPC route with the exact bytes the host
 * produces: the transport envelope (`type`/`rpcId` echo) whose `result.value`
 * is the `domainResult` carrier of the called `openInApp/*` method.
 */
function stubHost(table: HostTable): StubHost {
  const realFetch = globalThis.fetch
  const calls: Array<{ method: string; pathname: string }> = []
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      rpcId?: unknown
      method?: unknown
      payload?: { args?: Record<string, unknown> }
    }
    const method = String(request.method)
    calls.push({ method, pathname: url.pathname })
    const args = request.payload?.args ?? {}
    let domain: unknown
    if (method === OPEN_IN_APP_APPS_METHOD) {
      domain = { ok: true, value: { apps: [...table.apps] } }
    } else if (method === OPEN_IN_APP_ICON_METHOD) {
      const icon = table.icons?.[String(args.app)]
      domain = icon === undefined
        ? { ok: false, error: { code: 'icon-unavailable', message: `no icon for ${String(args.app)}` } }
        : { ok: true, value: icon }
    } else {
      throw new Error(`the page asked for an endpoint this stub does not serve: ${method}`)
    }
    const envelope = { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: domain } }
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

test('the shell wiring reads the installed catalog and its real icons through the real instance client', async () => {
  const host = stubHost({
    apps: ['finder', 'vscode', 'terminal'],
    icons: { finder: { mime: 'image/png', dataBase64: 'RklOREVS' } },
  })
  try {
    // The production expression, verbatim from `machineCatalogForPage()`.
    const machine = createMachineCatalog({
      call: (endpoint, args, signal) => getInstanceClient('local').callUnary(endpoint, args, signal),
    })
    await machine.refresh()

    assert.deepEqual(machine.entries()?.map(entry => entry.id), ['finder', 'vscode', 'terminal'],
      'the installed catalog must survive the transport envelope')
    assert.equal(machine.iconUrl('finder'), 'data:image/png;base64,RklOREVS',
      'the extracted icon must survive the transport envelope')
    assert.equal(machine.iconUrl('terminal'), null, 'a host that serves no artwork caches the absence')
    assert.deepEqual([...new Set(host.calls.map(call => call.pathname))].sort(), [
      `/api/i/local/api/${OPEN_IN_APP_APPS_METHOD}`,
      `/api/i/local/api/${OPEN_IN_APP_ICON_METHOD}`,
    ], 'the machine catalog reads the LOCAL instance over the page-level base path')
    assert.deepEqual([...new Set(host.calls.map(call => call.method))].sort(),
      [OPEN_IN_APP_APPS_METHOD, OPEN_IN_APP_ICON_METHOD].sort())
  } finally {
    host.restore()
  }
})

test('the page-level wiring this test drives is still the shell\'s own', () => {
  const shell = normalize(stripComments(
    readFileSync(fileURLToPath(new URL('../src/shell.ts', import.meta.url)), 'utf8'),
  ))
  // The machine catalog's transport: the page-level instance client pinned to
  // `local`, handed to `createMachineCatalog` as its `call`.
  assert.ok(
    shell.includes(normalize(stripComments(
      "createMachineCatalog({ call: (endpoint, args, signal) => getInstanceClient('local').callUnary(endpoint, args, signal), })",
    ))),
    'shell.ts must keep wiring the LOCAL instance client\'s callUnary into createMachineCatalog',
  )
})
