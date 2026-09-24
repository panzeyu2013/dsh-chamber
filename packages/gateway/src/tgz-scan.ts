/**
 * Bounded tgz metadata inspection for the materialize upload route: gzip and
 * the ustar 512-byte header blocks are parsed INCREMENTALLY, so a hostile
 * archive can never force a full decompression into memory. Both the DECLARED
 * unpacked size and the ACTUAL inflated byte count are capped and the inflate
 * aborts as soon as either cap trips (≤ 4096 entries, ≤ 256 MiB).
 *
 * Identity: the archive's own `package/package.json` (bounded, ≤ 64 KiB) must
 * AGREE with the client-asserted x-plugin-name/-version — otherwise an upload
 * could install a protected/official name as a DIRECT dependency (exempt from
 * the post-install verifier). The LAST candidate wins; oversize is never sticky.
 */

import { createGunzip } from 'node:zlib'

/** Entry-count cap. */
export const TGZ_MAX_ENTRIES = 4096
/** Declared/actual unpacked byte cap — mirrored by the desktop tarball builder. */
export const TGZ_MAX_UNPACKED_BYTES = 256 * 1024 * 1024
/** Error-echo bound: firstNames keeps at most this many names (the rest still count). */
const FIRST_NAMES_ECHO_LIMIT = 32
const GZIP_MAGIC = [0x1f, 0x8b] as const

/** Scan outcome; distinct codes let the route answer 400 per cause. */
export type TgzScanError = 'not_gzip' | 'corrupt' | 'too_many_entries' | 'too_large'

/** The archive's own package identity (`package/package.json`, npm-pack layout). */
export interface TgzManifestProjection {
  name: string
  version: string
}

export type TgzScanResult =
  | {
    ok: true
    entries: number
    totalBytes: number
    firstNames: string[]
    /** null when no readable npm-pack manifest exists; `manifestError` says why
     *  (the route refuses such an upload). */
    manifest: TgzManifestProjection | null
    manifestError?: 'missing' | 'invalid' | 'oversized'
  }
  | { ok: false; error: TgzScanError }

export const TGZ_MANIFEST_MAX_BYTES = 64 * 1024

/** Octal size field: bytes 124-135, NUL/space padded (all padding = 0);
 * non-octal content is not a valid ustar header. */
function parseOctalSize(field: Buffer): number | null {
  const text = field.toString('ascii').replace(/[\0 ]+$/u, '')
  if (text === '') return 0
  if (!/^[0-7]+$/u.test(text)) return null
  // The historic 11-digit octal cap cannot exceed 8 GiB — safe in a JS number.
  return parseInt(text, 8)
}

/** Parse one 512-byte ustar header block: null for the all-zero end marker, a
 * header record otherwise, or a throw on an impossible field (honest 'corrupt'). */
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

/** Bounded metadata scan of a tgz buffer (see module header). Never throws;
 * always resolves a discriminated result; inflated bytes are only counted. */
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
    /** Entry data bytes still to skip before the next header. */
    let skipRemaining = 0
    /** Partial header accumulation across chunk boundaries. */
    const headerParts: Buffer[] = []
    let headerLength = 0
    /**
     * Bounded capture of `package/package.json`. The state is PER CANDIDATE:
     * every candidate header resets it (oversize never sticky, LAST wins —
     * pnpm's extraction overwrites). Capture stops at the end of the candidate's
     * own data area, so later entries never leak in. `manifestParts === null` =
     * the current candidate has no readable manifest.
     */
    let manifestParts: Buffer[] | null = null
    let manifestCaptured = 0
    /** Bytes of the CURRENT candidate's declared size still to capture. */
    let manifestRemaining = 0
    let manifestOversized = false
    const manifestOf = (): { manifest: TgzManifestProjection | null; manifestError?: 'missing' | 'invalid' | 'oversized' } => {
      if (manifestOversized) return { manifest: null, manifestError: 'oversized' }
      if (manifestParts === null) return { manifest: null, manifestError: 'missing' }
      try {
        // Only the candidate's declared data bytes were captured. The manifest
        // may declare trailing NUL/space bytes inside that size — strip them.
        const text = Buffer.concat(manifestParts).subarray(0, manifestCaptured).toString('utf8').replace(/[\0\s]+$/u, '')
        const parsed: unknown = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { manifest: null, manifestError: 'invalid' }
        }
        const record = parsed as Record<string, unknown>
        const name = record.name
        const version = record.version
        if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
          return { manifest: null, manifestError: 'invalid' }
        }
        return { manifest: { name, version } }
      } catch {
        return { manifest: null, manifestError: 'invalid' }
      }
    }
    const finishOk = (): void => {
      const identity = manifestOf()
      finish({
        ok: true,
        entries,
        totalBytes,
        firstNames,
        manifest: identity.manifest,
        ...(identity.manifestError === undefined ? {} : { manifestError: identity.manifestError }),
      })
    }

    const consume = (chunk: Buffer): void => {
      let offset = 0
      while (offset < chunk.length) {
        if (skipRemaining > 0) {
          const consumed = Math.min(skipRemaining, chunk.length - offset)
          if (manifestRemaining > 0 && manifestParts !== null) {
            const capture = Math.min(manifestRemaining, consumed)
            manifestParts.push(Buffer.from(chunk.subarray(offset, offset + capture)))
            manifestCaptured += capture
            manifestRemaining -= capture
          }
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
          finishOk()
          return
        }
        if (header.name === 'package/package.json' || header.name === './package/package.json') {
          // New candidate: the previous capture is closed for good. An oversized
          // candidate is recorded WITHOUT buffering a byte, and it is not sticky.
          manifestParts = null
          manifestCaptured = 0
          manifestRemaining = 0
          manifestOversized = header.size > TGZ_MANIFEST_MAX_BYTES
          if (!manifestOversized) {
            manifestParts = []
            manifestRemaining = header.size
          }
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
        // Actual bytes protect against lying size fields: abort instead of draining.
        finish({ ok: false, error: 'too_large' })
        return
      }
      consume(chunk)
    })
    gunzip.on('end', () => {
      if (settled) return
      if (headerLength > 0 || skipRemaining > 0) {
        // Stream ended inside a header block or entry data: the tar is truncated.
        finish({ ok: false, error: 'corrupt' })
        return
      }
      finishOk()
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
