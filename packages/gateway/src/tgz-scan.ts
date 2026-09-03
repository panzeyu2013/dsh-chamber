/**
 * Bounded tgz metadata inspection for the materialize upload route (design
 * 21 §6.2 — `PUT /chamber/plugins/materialize`; plan Phase 4.4): parse the
 * gzip stream and the ustar 512-byte header blocks INCREMENTALLY with
 * `zlib.createGunzip`, so a hostile archive can never force a full
 * decompression into memory. The upload body is already buffered by the
 * route (≤ 32 MiB), but a zip bomb could still inflate far beyond that —
 * the scan caps both the DECLARED unpacked size (header size fields, with
 * the standard 512-byte padding) and the ACTUAL inflated byte count, and
 * aborts the inflate as soon as either cap trips.
 *
 * Caps (design 21 §6.2 / §6.9): ≤ 4096 entries and ≤ 256 MiB unpacked
 * (the §6.9 engineering default — the desktop tarball builder mirrors it as
 * TARBALL_MAX_UNPACKED_BYTES; plugin-tarball.test.ts pins the lockstep).
 *
 * Header discipline (ustar): each entry = 512-byte header, then
 * `ceil(size/512)*512` data bytes. Fields used: name (bytes 0-99,
 * NUL-terminated), size (bytes 124-135, octal, NUL/space-padded), typeflag
 * (byte 156 — '0'/'5'/'x'/'g'/…; every entry counts against the entry cap,
 * PAX 'x'/'g' headers included — conservative). The classic end-of-archive
 * marker (an all-zero header block) stops the scan early without inflating
 * the rest. Errors (bad gzip magic, gunzip failure, truncated tar) map to
 * 'corrupt'; the route answers 400 with a distinct code per error so the
 * client can tell a broken upload from an archive that exceeded the caps.
 *
 * Pure Node (node:zlib), no dependencies. Returns a promise (the gunzip
 * stream is inherently async); the memory held at any moment is one 512-byte
 * header buffer plus the inflater's own bounded window.
 */

import { createGunzip } from 'node:zlib'

/** Entry-count cap (design 21 §6.2 / §6.9: ≤ 4096 files). */
export const TGZ_MAX_ENTRIES = 4096
/** Declared/actual unpacked byte cap (design 21 §6.9 engineering default:
 * ≤ 256 MiB decompressed — aligned with the desktop tarball builder's
 * TARBALL_MAX_UNPACKED_BYTES mirror). */
export const TGZ_MAX_UNPACKED_BYTES = 256 * 1024 * 1024
/** PAX/entry-name echo bound: firstNames never holds more than this many
 * names (the rest are still counted; error surfacing never needs more). */
const FIRST_NAMES_ECHO_LIMIT = 32
/** Gzip magic bytes (RFC 1952). */
const GZIP_MAGIC = [0x1f, 0x8b] as const

export type TgzScanError = 'not_gzip' | 'corrupt' | 'too_many_entries' | 'too_large'

export type TgzScanResult =
  | { ok: true; entries: number; totalBytes: number; firstNames: string[] }
  | { ok: false; error: TgzScanError }

/** Octal size field: bytes 124-135 (12 bytes), NUL/space padded; empty
 * (all padding) means 0. Non-octal content is not a valid ustar header. */
function parseOctalSize(field: Buffer): number | null {
  const text = field.toString('ascii').replace(/[\0 ]+$/u, '')
  if (text === '') return 0
  if (!/^[0-7]+$/u.test(text)) return null
  // Octal values with the historic 11-digit cap cannot exceed 8 GiB
  // (0o77777777777) — safe in a JS number.
  return parseInt(text, 8)
}

/** Parse one 512-byte ustar header block. Returns null for the all-zero
 * end-of-archive marker, a header record otherwise, or throws on a field
 * that cannot be a real tar header (honest 'corrupt', never a guess). */
function parseTarHeader(block: Buffer): { name: string; size: number; isEnd: boolean } | null {
  let zero = true
  for (const byte of block) {
    if (byte !== 0) {
      zero = false
      break
    }
  }
  if (zero) return { name: '', size: 0, isEnd: true }
  const nameBytes = block.subarray(0, 100)
  const nul = nameBytes.indexOf(0)
  const name = nameBytes.subarray(0, nul === -1 ? 100 : nul).toString('utf8')
  const size = parseOctalSize(block.subarray(124, 136))
  if (size === null) throw new Error('tar header size field is not octal')
  if (size < 0) throw new Error('tar header size field is negative')
  return { name, size, isEnd: false }
}

/**
 * Bounded metadata scan of a tgz buffer (see module header). Never throws;
 * always resolves a discriminated result. The input buffer stays owned by
 * the caller; inflated bytes are only counted, never retained.
 */
export function scanTgzMetadata(buffer: Buffer): Promise<TgzScanResult> {
  return new Promise(resolve => {
    if (buffer.length < 2 || buffer[0] !== GZIP_MAGIC[0] || buffer[1] !== GZIP_MAGIC[1]) {
      resolve({ ok: false, error: 'not_gzip' })
      return
    }
    let settled = false
    const finish = (result: TgzScanResult): void => {
      if (settled) return
      settled = true
      gunzip.removeAllListeners()
      try {
        gunzip.destroy()
      } catch {
        // best effort
      }
      resolve(result)
    }

    const gunzip = createGunzip()
    let entries = 0
    let totalBytes = 0
    let inflatedBytes = 0
    const firstNames: string[] = []
    /** Bytes of entry data still to skip before the next header. */
    let skipRemaining = 0
    /** Partial header accumulation across chunk boundaries. */
    const headerParts: Buffer[] = []
    let headerLength = 0

    const consume = (chunk: Buffer): void => {
      let offset = 0
      while (offset < chunk.length) {
        if (skipRemaining > 0) {
          const consumed = Math.min(skipRemaining, chunk.length - offset)
          skipRemaining -= consumed
          offset += consumed
          continue
        }
        const need = 512 - headerLength
        const available = chunk.length - offset
        if (available < need) {
          headerParts.push(chunk.subarray(offset))
          headerLength += available
          offset = chunk.length
          continue
        }
        const block = Buffer.concat(headerParts, headerLength).length === 0
          ? chunk.subarray(offset, offset + 512)
          : Buffer.concat([...headerParts, chunk.subarray(offset, offset + need)], 512)
        headerParts.length = 0
        headerLength = 0
        offset += need

        let header: { name: string; size: number; isEnd: boolean } | null
        try {
          header = parseTarHeader(block)
        } catch {
          finish({ ok: false, error: 'corrupt' })
          return
        }
        if (header === null || header.isEnd) {
          // Classic end-of-archive marker: everything past it is padding.
          finish({ ok: true, entries, totalBytes, firstNames })
          return
        }
        entries += 1
        if (entries > TGZ_MAX_ENTRIES) {
          finish({ ok: false, error: 'too_many_entries' })
          return
        }
        if (firstNames.length < FIRST_NAMES_ECHO_LIMIT) firstNames.push(header.name)
        // Declared footprint: 512-byte header + padded data area.
        totalBytes += 512 + Math.ceil(header.size / 512) * 512
        if (totalBytes > TGZ_MAX_UNPACKED_BYTES) {
          finish({ ok: false, error: 'too_large' })
          return
        }
        skipRemaining = Math.ceil(header.size / 512) * 512
      }
    }

    gunzip.on('data', (chunk: Buffer) => {
      if (settled) return
      inflatedBytes += chunk.length
      if (inflatedBytes > TGZ_MAX_UNPACKED_BYTES) {
        // Actual bytes protect against lying size fields / pathological
        // streams; abort the inflate instead of draining it.
        finish({ ok: false, error: 'too_large' })
        return
      }
      consume(chunk)
    })
    gunzip.on('end', () => {
      if (settled) return
      if (headerLength > 0 || skipRemaining > 0) {
        // Stream ended inside a header block or entry data: the archive is
        // truncated (the gzip stream itself is complete, the tar is not).
        finish({ ok: false, error: 'corrupt' })
        return
      }
      finish({ ok: true, entries, totalBytes, firstNames })
    })
    gunzip.on('error', () => {
      finish({ ok: false, error: 'corrupt' })
    })

    try {
      gunzip.write(buffer)
      gunzip.end()
    } catch {
      finish({ ok: false, error: 'corrupt' })
    }
  })
}
