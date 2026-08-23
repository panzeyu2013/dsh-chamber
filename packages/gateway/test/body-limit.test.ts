import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createFeatureHost } from '../src/routes.ts'
import { createGatewayStore } from '../src/store.ts'

class Request extends EventEmitter {
  method = 'PUT'
  headers: Record<string, string | undefined> = {}
}

class Response extends EventEmitter {
  status = 0
  chunks: string[] = []
  writeHead(status: number): this { this.status = status; return this }
  write(chunk: string): boolean { this.chunks.push(String(chunk)); return true }
  end(chunk?: string): void { if (chunk !== undefined) this.chunks.push(String(chunk)); this.emit('finish') }
  json(): any { return JSON.parse(this.chunks.join('')) }
}

test('oversized feature bodies enter drain-only mode and never retain later chunks', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-body-limit-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const host = createFeatureHost({
    getDshBaseUrl: () => null,
    logger: { log() {}, warn() {}, error() {} },
    store: createGatewayStore(stateDir, { log() {}, warn() {}, error() {} }),
    channels: {
      register() {}, async start() {}, async stop() {}, resolve: () => null,
      health: () => 'unknown', list: () => [],
    },
  })
  const req = new Request()
  const res = new Response()
  const handled = host.handle(req as unknown as ApiRequest, res as unknown as ApiResponse, '/chamber/settings')

  req.emit('data', Buffer.alloc(1024 * 1024 + 1))
  const poison = Object.defineProperty({}, 'length', {
    get() { throw new Error('a post-limit chunk was inspected') },
  })
  assert.doesNotThrow(() => req.emit('data', poison))
  req.emit('end')
  assert.equal(await handled, true)
  assert.equal(res.status, 400)
  assert.equal(res.json().code, 'body_too_large')
})
