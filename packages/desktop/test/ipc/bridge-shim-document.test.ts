import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const shim = readFileSync(fileURLToPath(new URL('../../../../macos/Sources/DSHChamber/Resources/bridge-shim.js', import.meta.url)), 'utf8')
const TOKEN = '__DSH_CHAMBER_NATIVE_TOKEN__'

function document(uuid: string) {
  const posted: Array<{ id: number; documentId: string; method: string }> = []
  const events: string[] = []
  const window = {
    crypto: { randomUUID: () => uuid },
    webkit: { messageHandlers: { dshChamber: { postMessage: (value: typeof posted[number]) => posted.push(value) } } },
    dispatchEvent: (event: { type: string }) => { events.push(event.type); return true },
  } as Record<string, unknown>
  runInNewContext(shim, { window, Event: class { readonly type: string; constructor(type: string) { this.type = type } }, console, setTimeout })
  return { window, posted, events }
}

test('a late reply from a prior document cannot settle a reused request id', async () => {
  const old = document('eaf2edfe-7318-46c8-96b9-e9ff421e63d9')
  const fresh = document('f93f9692-6b76-4dd7-b84d-2d42513199d6')
  assert.equal(old.posted[0]?.id, 1)
  assert.equal(fresh.posted[0]?.id, 1)
  assert.notEqual(old.posted[0]?.documentId, fresh.posted[0]?.documentId)
  const resolve = fresh.window.__dshChamberResolve as (...args: unknown[]) => void
  resolve(TOKEN, old.posted[0]?.documentId, 1, { platform: 'wrong' }, null)
  await Promise.resolve()
  assert.equal(fresh.window.dshChamber, undefined)
  resolve(TOKEN, fresh.posted[0]?.documentId, 1, { platform: 'darwin' }, null)
  await Promise.resolve()
  assert.equal((fresh.window.dshChamber as unknown as { platform?: string })?.platform, 'darwin')
})

test('sidecar reset rejects pending invokes and ready announces a new handshake', async () => {
  const page = document('b4d4af79-427b-4d15-af44-3f92d7b6cb9e')
  const resolve = page.window.__dshChamberResolve as (...args: unknown[]) => void
  resolve(TOKEN, page.posted[0]?.documentId, 1, { platform: 'darwin' }, null)
  await Promise.resolve()
  const ready = (page.window.dshChamber as { notifications: { ready(): Promise<unknown> } }).notifications.ready()
  assert.equal(page.posted.at(-1)?.method, 'dsh-chamber:notifications-ready')
  const reset = page.window.__dshChamberBridgeReset as (token: string) => void
  reset(TOKEN)
  await assert.rejects(ready, /bridge not ready/)
  const sidecarReady = page.window.__dshChamberSidecarReady as (token: string) => void
  sidecarReady(TOKEN)
  assert.deepEqual(page.events, ['dsh-chamber:sidecar-ready'])
})
