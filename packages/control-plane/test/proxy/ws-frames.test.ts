/**
 * node:test for the instance-proxy WebSocket frame helpers
 * (`packages/control-plane/src/ws-frames.ts`): ping encoding (unmasked
 * server→client and masked client→server shapes) and the passive pong
 * scanner (partial chunks, interleaved data frames, extended lengths).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ControlFrameScanner, encodePingFrame, PongScanner, WS_CONTROL_PAYLOAD_MAX } from '../../src/ws-frames.ts'
import { pongFrame } from '../support/utils.ts'

/** Build a complete text data frame (opcode 0x1) for scanner fixtures. */
function dataFrame(payload: Buffer, masked: boolean): Buffer {
  const header = Buffer.allocUnsafe(masked ? 6 : 2)
  header[0] = 0x80 | 0x1
  if (!masked) {
    header[1] = payload.length
    return Buffer.concat([header, payload])
  }
  header[1] = 0x80 | payload.length
  const key = Buffer.from([9, 8, 7, 6])
  key.copy(header, 2)
  const maskedPayload = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) maskedPayload[i] = payload[i] ^ key[i % 4]
  return Buffer.concat([header, maskedPayload])
}

/** Build a data frame with an extended (16-bit) length. */
function dataFrameExtLen(payload: Buffer): Buffer {
  assert.ok(payload.length >= 126 && payload.length <= 0xffff)
  const header = Buffer.alloc(4)
  header[0] = 0x80 | 0x1
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

// ── encodePingFrame ───────────────────────────────────────────────────────

test('ws-frames: unmasked ping frame shape (server→client)', () => {
  const payload = Buffer.from('abc')
  const frame = encodePingFrame(payload)
  assert.equal(frame.length, 2 + payload.length)
  assert.equal(frame[0], 0x89) // FIN + ping opcode
  assert.equal(frame[1], payload.length) // no MASK bit
  assert.deepEqual(frame.subarray(2), payload)
})

test('ws-frames: control-frame payload cap is enforced', () => {
  assert.throws(() => encodePingFrame(Buffer.alloc(WS_CONTROL_PAYLOAD_MAX + 1)), RangeError)
  // Exactly at the cap is fine.
  assert.equal(encodePingFrame(Buffer.alloc(WS_CONTROL_PAYLOAD_MAX)).length, 2 + WS_CONTROL_PAYLOAD_MAX)
})

// ── PongScanner ───────────────────────────────────────────────────────────

test('ws-frames: scanner detects an unmasked pong (host → proxy)', () => {
  const scanner = new PongScanner()
  assert.equal(scanner.push(pongFrame(Buffer.from('hi'), false)), true)
})

test('ws-frames: scanner detects a masked pong (browser → proxy)', () => {
  const scanner = new PongScanner()
  assert.equal(scanner.push(pongFrame(Buffer.from('hi'), true)), true)
})

test('ws-frames: scanner skips data frames and finds the trailing pong', () => {
  const scanner = new PongScanner()
  const stream = Buffer.concat([dataFrame(Buffer.from('hello world'), false), pongFrame(Buffer.from('p'), false)])
  assert.equal(scanner.push(stream), true)
})

test('ws-frames: scanner skips a masked data frame then finds the pong', () => {
  const scanner = new PongScanner()
  const stream = Buffer.concat([dataFrame(Buffer.from('hello world'), true), pongFrame(Buffer.from('p'), true)])
  assert.equal(scanner.push(stream), true)
})

test('ws-frames: scanner does not fire on ping frames', () => {
  const scanner = new PongScanner()
  const ping = encodePingFrame(Buffer.from('x'))
  assert.equal(scanner.push(ping), false)
})

test('ws-frames: scanner handles byte-at-a-time chunks (frame boundary splitting)', () => {
  const scanner = new PongScanner()
  const frame = pongFrame(Buffer.from('payload-1234567890'), false)
  let found = false
  for (const byte of frame) {
    if (scanner.push(Buffer.from([byte]))) found = true
  }
  assert.equal(found, true)
})

test('ws-frames: scanner handles a pong split mid-payload across chunks', () => {
  const scanner = new PongScanner()
  const frame = pongFrame(Buffer.from('abcdefghijklmnop'), false)
  // First chunk: header only. Second chunk: part of the payload. Third: rest.
  assert.equal(scanner.push(frame.subarray(0, 2)), true) // opcode seen at frame start
  assert.equal(scanner.push(frame.subarray(2, 7)), false)
  assert.equal(scanner.push(frame.subarray(7)), false)
})

test('ws-frames: scanner stays in sync across a pong followed by more frames', () => {
  const scanner = new PongScanner()
  const pong = pongFrame(Buffer.from('p'), false)
  const tail = dataFrame(Buffer.from('tail data'), false)
  const stream = Buffer.concat([pong, tail])
  assert.equal(scanner.push(stream), true)
  // After the pong+data the scanner must be back at a frame boundary.
  assert.equal(scanner.push(pongFrame(Buffer.from('q'), false)), true)
})

test('ws-frames: scanner skips extended-length (16-bit) data frames', () => {
  const scanner = new PongScanner()
  const big = Buffer.alloc(200, 0x41) // 'A' * 200 → needs the 126 extended form
  const stream = Buffer.concat([dataFrameExtLen(big), pongFrame(Buffer.from('z'), false)])
  assert.equal(scanner.push(stream), true)
})

test('ws-frames: scanner reports a pong inside one multi-frame chunk (data + pong + data)', () => {
  const scanner = new PongScanner()
  const stream = Buffer.concat([
    dataFrame(Buffer.from('one'), false),
    pongFrame(Buffer.from('two'), false),
    dataFrame(Buffer.from('three'), false),
  ])
  assert.equal(scanner.push(stream), true)
})

test('ws-frames: scanner survives a zero-length extended-form frame (no desync)', () => {
  const scanner = new PongScanner()
  // A data frame with length 0 declared via the 126 extended form, followed
  // by a pong: the scanner must stay at a frame boundary (no false pong).
  const empty = Buffer.from([0x80 | 0x1, 126, 0x00, 0x00])
  assert.equal(scanner.push(empty), false)
  assert.equal(scanner.push(pongFrame(Buffer.from('z'), false)), true)
})

// ── ControlFrameScanner: close codes ──────────────────────────────────────

/** Build a close frame (opcode 0x8); masked for browser→proxy fixtures. */
function closeFrame(code: number, reason = '', masked = false): Buffer {
  const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason))
  payload.writeUInt16BE(code, 0)
  payload.write(reason, 2)
  if (!masked) {
    const header = Buffer.from([0x80 | 0x8, payload.length])
    return Buffer.concat([header, payload])
  }
  const key = Buffer.from([1, 2, 3, 4])
  const maskedPayload = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) maskedPayload[i] = payload[i] ^ key[i % 4]
  const header = Buffer.from([0x80 | 0x8, 0x80 | payload.length, ...key])
  return Buffer.concat([header, maskedPayload])
}

test('ws-frames: control scanner reports an unmasked close code', () => {
  const scanner = new ControlFrameScanner()
  const hit = scanner.push(closeFrame(1000, 'bye', false))
  assert.equal(hit.close, 1000)
})

test('ws-frames: control scanner unmasks a browser close code', () => {
  const scanner = new ControlFrameScanner()
  const hit = scanner.push(closeFrame(4401, 'auth', true))
  assert.equal(hit.close, 4401)
})

test('ws-frames: control scanner assembles a close frame split across chunks', () => {
  const scanner = new ControlFrameScanner()
  const frame = closeFrame(4002, 'malformed', true)
  let code: number | undefined
  for (const byte of frame) {
    const hit = scanner.push(Buffer.from([byte]))
    if (hit.close !== undefined) code = hit.close
  }
  assert.equal(code, 4002)
})

test('ws-frames: control scanner skips interleaved data frames before the close', () => {
  const scanner = new ControlFrameScanner()
  const hit = scanner.push(Buffer.concat([dataFrame(Buffer.from('tail'), false), closeFrame(1012, '', false)]))
  assert.equal(hit.close, 1012)
})

test('ws-frames: control scanner handles a zero-length close as 1005', () => {
  const scanner = new ControlFrameScanner()
  // RFC 6455 §5.5.1: a close frame with no body has no status code (1005).
  const hit = scanner.push(Buffer.from([0x88, 0x00]))
  assert.equal(hit.close, 1005)
  // The scanner stays in sync for the next frame.
  assert.equal(scanner.push(closeFrame(1000, '', false)).close, 1000)
})

test('ws-frames: control scanner still detects pongs alongside closes', () => {
  const scanner = new ControlFrameScanner()
  const hit = scanner.push(Buffer.concat([pongFrame(Buffer.from('p'), false), closeFrame(1001, '', false)]))
  assert.equal(hit.pong, true)
  assert.equal(hit.close, 1001)
})
