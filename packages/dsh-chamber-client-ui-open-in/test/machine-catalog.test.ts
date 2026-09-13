/**
 * Machine catalog unit tests (design 20 §5, 2026-09-12 revision): the page-level
 * reader of "which apps are installed on this machine, and what do their icons
 * look like". Covered: one probe per page, one icon fetch per id, the serialized
 * batch queue (a refresh must not drop an id it discovers), refresh coalescing,
 * the notification order and the fail-closed wire. Pure node:test — the generic
 * RPC call is injected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMachineCatalog } from '../src/client/machine-catalog.ts'
import type { OpenInAppRpcCall } from '../src/client/local-catalog.ts'
import {
  OPEN_IN_APP_APPS_METHOD,
  OPEN_IN_APP_ICON_METHOD,
  OPEN_IN_APP_OPEN_METHOD,
} from '../src/shared/open-in-wire.ts'

interface WireCalls {
  apps: number
  icons: string[]
  opens: Array<{ app: string; path: string }>
}

interface WireOptions {
  /** Current catalog ids: read per probe so a test can change the machine. */
  apps: () => readonly string[]
  /** Icons the host serves; an absent id answers "no icon" (null). */
  icons?: Readonly<Record<string, { mime: string; dataBase64: string }>>
  /** Per-id gate: the test releases a blocked icon to keep a batch in flight. */
  onIcon?: (appId: string) => Promise<void> | undefined
  /** Every endpoint fails with a host domain error. */
  fail?: boolean
}

const png = (payload: string): { mime: string; dataBase64: string } => ({ mime: 'image/png', dataBase64: payload })

/** The `openInApp/*` host domain at wire level, answering the exact two-level
 *  envelope production carries: the page-level instance client's TRANSPORT
 *  result (`{ok:true, value}`, `callUnary`) wrapping the host domain's own
 *  `{ok,value}|{ok,error}` carrier (`domainResult`). `fail` refuses at the
 *  DOMAIN level — a reachable host whose domain call failed; a transport that
 *  never answers is covered in `local-catalog.test.ts`. */
function wire(options: WireOptions): { call: OpenInAppRpcCall; calls: WireCalls } {
  const calls: WireCalls = { apps: 0, icons: [], opens: [] }
  /** A transport success carrying one host domain answer. */
  const answered = (value: unknown): unknown => ({ ok: true, value: { ok: true, value } })
  const refused: unknown = {
    ok: true,
    value: { ok: false, error: { code: 'probe-failed', message: 'the host refused' } },
  }
  return {
    calls,
    call: async (endpoint, args) => {
      if (options.fail === true) return refused
      if (endpoint === OPEN_IN_APP_APPS_METHOD) {
        calls.apps += 1
        return answered({ apps: [...options.apps()] })
      }
      if (endpoint === OPEN_IN_APP_ICON_METHOD) {
        const app = String(args.app)
        calls.icons.push(app)
        await options.onIcon?.(app)
        const icon = options.icons?.[app]
        return answered(icon === undefined ? null : icon)
      }
      if (endpoint === OPEN_IN_APP_OPEN_METHOD) {
        calls.opens.push({ app: String(args.app), path: String(args.path) })
        return answered({})
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    },
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('machine catalog: one boot probe, one icon fetch per id, never re-requested', async () => {
  const w = wire({ apps: () => ['finder', 'vscode'], icons: { finder: png('FINDER') } })
  const machine = createMachineCatalog({ call: w.call })
  await settle()
  assert.deepEqual(machine.entries()?.map(entry => entry.id), ['finder', 'vscode'])
  assert.deepEqual([...w.calls.icons].sort(), ['finder', 'vscode'])
  assert.equal(machine.iconUrl('finder'), 'data:image/png;base64,FINDER')
  assert.equal(machine.iconUrl('vscode'), null, 'a host with no artwork caches the absence')

  await machine.refresh()
  assert.equal(w.calls.apps, 2, 'refresh re-probes the catalog')
  assert.deepEqual([...w.calls.icons].sort(), ['finder', 'vscode'],
    'a refresh must not re-request icons the boot cache already answered')
})

test('machine catalog: a refresh during an in-flight icon batch must not drop the ids it discovers', async () => {
  // The first icon call blocks, so the boot probe's batch is still in flight
  // when the refresh (menu open / window focus) discovers a new application.
  const ids = ['finder']
  // EVERY call for the first id waits on the SAME gate: a regression that
  // re-requests an already-answered id then fails on the assertion below
  // instead of deadlocking the suite on a promise nobody releases.
  // The resolver is collected in an array rather than a narrowed `let`: this
  // file type-checks under `pnpm run typecheck:open-in` (a CI gate), and the
  // executor's assignment is invisible to the checker's narrowing, which types
  // a bare `let gate: (() => void) | null = null` as `null` → `never` here.
  const openGate: Array<() => void> = []
  const gate = new Promise<void>((resolve) => { openGate.push(resolve) })
  const w = wire({
    apps: () => ids,
    icons: { finder: png('FINDER'), vscode: png('VSCODE') },
    onIcon: (appId) => (appId === 'finder' ? gate : undefined),
  })
  const machine = createMachineCatalog({ call: w.call })
  await settle()
  assert.deepEqual(w.calls.icons, ['finder'], 'the boot probe starts the first batch')
  ids.push('vscode')
  const refresh = machine.refresh()
  await settle()
  for (const release of openGate.splice(0)) release()
  await refresh
  assert.deepEqual(w.calls.icons, ['finder', 'vscode'],
    'the id the refresh discovered is fetched too, and the answered id is not re-requested')
  assert.equal(machine.iconUrl('vscode'), 'data:image/png;base64,VSCODE')
})

test('machine catalog: concurrent refreshes share one probe', async () => {
  const w = wire({ apps: () => ['finder'] })
  const machine = createMachineCatalog({ call: w.call })
  await settle()
  assert.equal(w.calls.apps, 1)
  await Promise.all([machine.refresh(), machine.refresh()])
  assert.equal(w.calls.apps, 2, 'both callers ride the same in-flight probe')
})

test('machine catalog: subscribers hear the ids first, then the pixels', async () => {
  const w = wire({ apps: () => ['finder'], icons: { finder: png('FINDER') } })
  const machine = createMachineCatalog({ call: w.call })
  const seen: Array<{ entries: number; finder: string | null }> = []
  machine.subscribe(() => {
    seen.push({ entries: machine.entries()?.length ?? 0, finder: machine.iconUrl('finder') })
  })
  await settle()
  assert.ok(seen.length >= 2, 'the catalog and every icon batch notify')
  assert.deepEqual(seen[0], { entries: 1, finder: null }, 'the app list lands before its icon')
  assert.deepEqual(seen[seen.length - 1], { entries: 1, finder: 'data:image/png;base64,FINDER' })
})

test('machine catalog: a failing host is an empty catalog, null icons and a rejecting launch', async () => {
  const w = wire({ apps: () => [], fail: true })
  const machine = createMachineCatalog({ call: w.call })
  await settle()
  assert.deepEqual(machine.entries(), [], 'fail-closed: an unreachable host is no app list')
  assert.equal(machine.iconUrl('finder'), null)
  await assert.rejects(() => machine.launch('finder', '/home/user/ws'),
    /probe-failed/, 'only a launch rejects — that is the outcome the user must see')
})

test('machine catalog: launch rides the host domain with the app id and path', async () => {
  const w = wire({ apps: () => ['finder'] })
  const machine = createMachineCatalog({ call: w.call })
  await machine.launch('finder', '/home/user/ws')
  assert.deepEqual(w.calls.opens, [{ app: 'finder', path: '/home/user/ws' }])
})
