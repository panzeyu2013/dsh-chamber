/**
 * audit-log unit tests (design 17 §13.4.4, S24): JSONL append semantics,
 * 0600 owner-only mode, size-based rotation to `<file>.1` (old `.1` deleted),
 * and the whitelist serializer — a caller-attached credential field can never
 * reach disk, and an invalid event (missing required fields) writes nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendAuditEvent,
  configureAuditLog,
  AUDIT_LOG_MAX_BYTES,
  type AuditEvent,
} from './audit-log.ts'

const tmpDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').trimEnd().split('\n')
}

function readEvents(file: string): Array<Record<string, string>> {
  return lines(file).map(line => JSON.parse(line) as Record<string, string>)
}

test('appendAuditEvent appends JSONL events in order with the given fields', () => {
  const dir = tmpDir('audit-append-')
  const file = join(dir, 'audit.log')
  const first: AuditEvent = { ts: '2026-01-01T00:00:00.000Z', event: 'transport_phase', sourceId: 'gw-1', kind: 'gateway', transport: 'http', detail: 'ready' }
  const second: AuditEvent = { ts: '2026-01-01T00:00:01.000Z', event: 'credential_set', sourceId: 'gw-1', kind: 'gateway', transport: 'http', detail: 'token' }
  appendAuditEvent({ file }, first)
  appendAuditEvent({ file }, second)
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], first)
  assert.deepEqual(events[1], second)
  // A minimal event (no optional fields) still writes both required fields.
  const minimal = join(dir, 'minimal.log')
  appendAuditEvent({ file: minimal }, { ts: '2026-01-01T00:00:02.000Z', event: 'transport_phase' })
  assert.deepEqual(readEvents(minimal), [{ ts: '2026-01-01T00:00:02.000Z', event: 'transport_phase' }])
  rmSync(dir, { recursive: true, force: true })
})

test('the audit file is created 0600 and a legacy loose mode is tightened on append', () => {
  const dir = tmpDir('audit-mode-')
  const file = join(dir, 'audit.log')
  appendAuditEvent({ file }, { ts: '2026-01-01T00:00:00.000Z', event: 'transport_phase' })
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the audit file is 0600')
  // Simulate a legacy file created loose: the next append must re-tighten it.
  chmodSync(file, 0o644)
  appendAuditEvent({ file }, { ts: '2026-01-01T00:00:01.000Z', event: 'transport_phase' })
  assert.equal(statSync(file).mode & 0o777, 0o600, 'a legacy 0644 file is tightened back to 0600')
  rmSync(dir, { recursive: true, force: true })
})

test('the audit file rotates to <file>.1 once the cap is reached and deletes the old .1', () => {
  const dir = tmpDir('audit-rotate-')
  const file = join(dir, 'audit.log')
  const maxBytes = 120
  const small: AuditEvent = { ts: '2026-01-01T00:00:00.000Z', event: 'a' }
  const big1: AuditEvent = { ts: '2026-01-01T00:00:01.000Z', event: 'b', detail: 'x'.repeat(300) }
  const big2: AuditEvent = { ts: '2026-01-01T00:00:02.000Z', event: 'c', detail: 'y'.repeat(300) }
  const big3: AuditEvent = { ts: '2026-01-01T00:00:03.000Z', event: 'd', detail: 'z'.repeat(300) }
  // Rotation is lazy (checked before the next append): the file may exceed the
  // cap by one event, then the NEXT append rotates it to <file>.1 first.
  appendAuditEvent({ file, maxBytes }, small)
  appendAuditEvent({ file, maxBytes }, big1)
  assert.equal(statSync(file).size >= maxBytes, true)
  assert.deepEqual(readEvents(file), [small, big1], 'the file is now over the cap')
  // First rotation: current file → .1, the new event lands in a fresh file.
  appendAuditEvent({ file, maxBytes }, big2)
  assert.deepEqual(readEvents(`${file}.1`), [small, big1], 'the over-cap file moved to <file>.1')
  assert.deepEqual(readEvents(file), [big2])
  // Second rotation: the old .1 is DELETED, then the current file becomes .1.
  appendAuditEvent({ file, maxBytes }, big3)
  assert.deepEqual(readEvents(`${file}.1`), [big2], 'the old .1 was deleted and replaced by the rotated current file')
  assert.deepEqual(readEvents(file), [big3])
  rmSync(dir, { recursive: true, force: true })
})

test('the serializer is a fixed whitelist: a caller-attached credential field never reaches disk (S24)', () => {
  const dir = tmpDir('audit-secret-')
  const file = join(dir, 'audit.log')
  const PASSWORD = 'correct horse battery staple'
  const TOKEN = 'super-secret-bearer-token'
  const COOKIE = 'dsh_gateway_session=eyJhbGciOiJIUzI1NiJ9.private'
  const event = {
    ts: '2026-01-01T00:00:00.000Z',
    event: 'transport_registered',
    sourceId: 'gw-1',
    kind: 'gateway',
    transport: 'http',
    detail: 'auth:token',
    // Deliberately smuggled secret fields (a buggy/abusive caller) — the
    // serializer must drop every one of them (S24: 绝不包含凭据).
    password: PASSWORD,
    token: TOKEN,
    cookie: COOKIE,
    authorization: `Bearer ${TOKEN}`,
    sessionBody: { transcript: 'private session body' },
  } as unknown as AuditEvent
  appendAuditEvent({ file }, event)
  const events = readEvents(file)
  assert.equal(events.length, 1)
  assert.deepEqual(Object.keys(events[0]).sort(), ['detail', 'event', 'kind', 'sourceId', 'transport', 'ts'])
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(PASSWORD), false)
  assert.equal(raw.includes(TOKEN), false)
  assert.equal(raw.includes(COOKIE), false)
  assert.equal(raw.includes('sessionBody'), false)
  rmSync(dir, { recursive: true, force: true })
})

test('an event missing the required fields writes nothing (loudly, never a partial line)', () => {
  const dir = tmpDir('audit-invalid-')
  const file = join(dir, 'audit.log')
  appendAuditEvent({ file }, { ts: '2026-01-01T00:00:00.000Z' } as AuditEvent)
  appendAuditEvent({ file }, { event: 'transport_phase' } as AuditEvent)
  assert.throws(() => statSync(file), /ENOENT/, 'no file was created for invalid events')
  rmSync(dir, { recursive: true, force: true })
})

test('configureAuditLog is the DI seam: it accepts the file and reports no notice', () => {
  assert.equal(configureAuditLog(join(tmpdir(), 'unused-audit.log')), null)
})

test('the exported cap is 5 MiB per the design contract', () => {
  assert.equal(AUDIT_LOG_MAX_BYTES, 5 * 1024 * 1024)
})
