/**
 * Minimal RFC 6455 frame helpers for the instance-proxy WebSocket splice.
 *
 * - encodePingFrame / encodeCloseFrame: the unmasked control frames the proxy
 *   injects downstream;
 * - ControlFrameScanner: one passive pass over a leg's raw bytes that reports
 *   pongs (liveness) and close codes (attribution). It never consumes bytes —
 *   the splice pipe stays untouched.
 *
 * Close frames may be masked (browser → proxy) or unmasked (host → proxy), may
 * be split across arbitrary chunk boundaries, and may sit between fragmented
 * data frames (RFC 6455 §5.4 allows control frames there). The scanner keeps
 * its own frame state and skips payloads by declared length.
 */

import { createHash } from 'node:crypto'

export const WS_OPCODE_PING = 0x9
export const WS_OPCODE_PONG = 0xa
export const WS_OPCODE_CLOSE = 0x8

/** Max control-frame payload (RFC 6455 §5.5 — 125 bytes). */
export const WS_CONTROL_PAYLOAD_MAX = 125

/** RFC 6455 §4.2.2 accept token: base64(SHA1(key + GUID)). */
export function secWebSocketAccept(key: string): string {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
}

/** Encode one complete unmasked ping frame (server→client); payload ≤ 125
 *  bytes, echoed back by the ponging peer. */
export function encodePingFrame(payload: Buffer): Buffer {
  if (payload.length > WS_CONTROL_PAYLOAD_MAX) {
    throw new RangeError(`ping payload exceeds the ${WS_CONTROL_PAYLOAD_MAX}-byte control-frame limit`)
  }
  const header = Buffer.allocUnsafe(2)
  header[0] = 0x80 | WS_OPCODE_PING // FIN + ping
  header[1] = payload.length // no MASK bit (server→client)
  return Buffer.concat([header, payload])
}

/** Encode one complete unmasked close frame (server→client). */
export function encodeCloseFrame(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8')
  if (reasonBytes.length > WS_CONTROL_PAYLOAD_MAX - 2) {
    throw new RangeError('close reason exceeds the control-frame payload limit')
  }
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
  payload.writeUInt16BE(code, 0)
  reasonBytes.copy(payload, 2)
  const header = Buffer.allocUnsafe(2)
  header[0] = 0x80 | WS_OPCODE_CLOSE
  header[1] = payload.length
  return Buffer.concat([header, payload])
}

export interface ControlFrameHit {
  /** A pong frame started in this chunk. */
  readonly pong: boolean
  /** A complete close frame's code, if one completed in this chunk. */
  readonly close?: number
}

type ScanStage = 'header1' | 'header2' | 'ext2' | 'ext8' | 'mask' | 'payload'

export class ControlFrameScanner {
  private stage: ScanStage = 'header1'
  private opcode = 0
  private masked = false
  private extBytes = 0
  private extValue = 0
  private maskKey = Buffer.alloc(4)
  private maskIndex = 0
  private payloadRemaining = 0
  private payloadConsumed = 0
  private closeBytes: number[] = []
  private pendingClose: number | undefined

  push(chunk: Buffer): ControlFrameHit {
    let pong = false
    let close: number | undefined
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index]
      switch (this.stage) {
        case 'header1': {
          this.opcode = byte & 0x0f
          if (this.opcode === WS_OPCODE_PONG) pong = true
          this.stage = 'header2'
          break
        }
        case 'header2': {
          this.masked = (byte & 0x80) !== 0
          const length7 = byte & 0x7f
          this.maskIndex = 0
          this.payloadConsumed = 0
          this.closeBytes = []
          if (length7 === 126) {
            this.stage = 'ext2'
            this.extBytes = 2
            this.extValue = 0
          } else if (length7 === 127) {
            this.stage = 'ext8'
            this.extBytes = 8
            this.extValue = 0
          } else {
            this.beginPayload(length7)
          }
          break
        }
        case 'ext2':
        case 'ext8': {
          this.extValue = this.extValue * 256 + byte
          this.extBytes -= 1
          if (this.extBytes === 0) this.beginPayload(this.extValue)
          break
        }
        case 'mask': {
          this.maskKey[this.maskIndex] = byte
          this.maskIndex += 1
          if (this.maskIndex === 4) {
            if (this.payloadRemaining === 0) this.finishFrame()
            else this.stage = 'payload'
          }
          break
        }
        case 'payload': {
          const unmasked = this.masked ? byte ^ this.maskKey[this.payloadConsumed % 4] : byte
          if (this.opcode === WS_OPCODE_CLOSE && this.closeBytes.length < 2) this.closeBytes.push(unmasked)
          this.payloadConsumed += 1
          this.payloadRemaining -= 1
          if (this.payloadRemaining === 0) this.finishFrame()
          break
        }
      }
    }
    if (this.pendingClose !== undefined) {
      close = this.pendingClose
      this.pendingClose = undefined
    }
    return { pong, close }
  }

  private beginPayload(length: number): void {
    this.payloadRemaining = length
    this.payloadConsumed = 0
    this.closeBytes = []
    if (length === 0) {
      // A masked empty frame still carries the 4-byte mask key.
      if (this.masked) {
        this.maskIndex = 0
        this.stage = 'mask'
        return
      }
      this.finishFrame()
      return
    }
    this.stage = this.masked ? 'mask' : 'payload'
  }

  private finishFrame(): void {
    if (this.opcode === WS_OPCODE_CLOSE) this.pendingClose = closeCodeOf(this.closeBytes)
    this.stage = 'header1'
    this.opcode = 0
    this.masked = false
    this.payloadRemaining = 0
    this.extBytes = 0
    this.extValue = 0
    this.closeBytes = []
  }
}

function closeCodeOf(bytes: readonly number[]): number {
  if (bytes.length === 0) return 1005
  if (bytes.length < 2) return 1002
  return ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff)
}

/** Backwards-compatible pong detector used by the browser-leg heartbeat. */
export class PongScanner {
  private readonly scanner = new ControlFrameScanner()
  push(chunk: Buffer): boolean {
    return this.scanner.push(chunk).pong
  }
}
