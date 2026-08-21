/**
 * Minimal RFC 6455 frame helpers for the instance-proxy WebSocket heartbeat
 * (design 14 extension — sleep/wake stuck-deep-diving fix).
 *
 * The proxy needs only two things: an encoder for the ping frames it injects
 * downstream (unmasked — the proxy is the ws server to the browser; the
 * browser auto-pongs per RFC, transparently) and a passive scanner that
 * detects the browser's pong frames in its raw byte stream. The scanner never
 * consumes bytes (the splice pipe stays untouched): it skips frames by their
 * declared lengths and reports when a frame with the pong opcode (0xA) starts.
 *
 * The browser's frames are masked (client→server) and, on this downlink-only
 * stream, are pongs; the scanner still handles data frames (masked or not)
 * and extended lengths defensively, so it stays in sync across arbitrary
 * payloads.
 */

export const WS_OPCODE_PING = 0x9
export const WS_OPCODE_PONG = 0xa

/** Max control-frame payload (RFC 6455 §5.5 — 125 bytes). */
export const WS_CONTROL_PAYLOAD_MAX = 125

/**
 * Encode one complete unmasked ping frame (server→client direction).
 * @param payload - ≤ 125 bytes; echoed back by the ponging peer.
 */
export function encodePingFrame(payload: Buffer): Buffer {
  if (payload.length > WS_CONTROL_PAYLOAD_MAX) {
    throw new RangeError(`ping payload exceeds the ${WS_CONTROL_PAYLOAD_MAX}-byte control-frame limit`)
  }
  const header = Buffer.allocUnsafe(2)
  header[0] = 0x80 | WS_OPCODE_PING // FIN + ping
  header[1] = payload.length // no MASK bit (server→client)
  return Buffer.concat([header, payload])
}

/**
 * Incremental pong detector over a byte stream. Push chunks in order; `push`
 * returns true as soon as a pong frame STARTS (its opcode byte is read) —
 * enough for a heartbeat, since a pong is a single complete control frame.
 * The scanner keeps its own frame-position state so it stays correct across
 * arbitrary chunk boundaries and interleaved data frames.
 */
export class PongScanner {
  /** Opcode of the frame currently being read (0 before any byte). */
  private opcode = 0
  /** Waiting for the second header byte of the current frame. */
  private needLengthByte = false
  /** MASK bit of the current frame (mask key + payload are skipped together). */
  private masked = false
  /** Extended-length bytes (2 or 8) still to consume. */
  private extRemaining = 0
  /** Accumulated extended length value. */
  private extValue = 0
  /** Mask+payload bytes still to skip in the current frame. */
  private skipRemaining = 0

  push(chunk: Buffer): boolean {
    let found = false
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]
      if (this.skipRemaining > 0) {
        this.skipRemaining -= 1
        continue
      }
      if (this.extRemaining > 0) {
        this.extValue = this.extValue * 256 + byte
        this.extRemaining -= 1
        if (this.extRemaining === 0) {
          this.skipRemaining = this.extValue + (this.masked ? 4 : 0)
          if (this.skipRemaining === 0) {
            // Zero-length frame via the extended form: complete immediately,
            // the next byte starts a frame.
            this.opcode = 0
          }
        }
        continue
      }
      if (this.needLengthByte) {
        this.needLengthByte = false
        this.masked = (byte & 0x80) !== 0
        const length7 = byte & 0x7f
        if (length7 === 126) {
          this.extRemaining = 2
          this.extValue = 0
          continue
        }
        if (length7 === 127) {
          this.extRemaining = 8
          this.extValue = 0
          continue
        }
        if (length7 === 0 && !this.masked) {
          // Zero-length frame: complete immediately, next byte starts a frame.
          this.opcode = 0
          continue
        }
        this.skipRemaining = length7 + (this.masked ? 4 : 0)
        continue
      }
      // First byte of a frame: opcode + FIN/RSV. A pong frame starts here.
      this.opcode = byte & 0x0f
      if (this.opcode === WS_OPCODE_PONG) found = true
      this.needLengthByte = true
    }
    return found
  }
}
