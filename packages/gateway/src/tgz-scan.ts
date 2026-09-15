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
 * Identity projection (2026-12 review, design 21 §6.2/§6.11): the route judges
 * the CLIENT-ASSERTED `x-plugin-name`/`x-plugin-version` headers, so the archive's
 * own `package/package.json` is captured (bounded, ≤ 64 KiB) here and the route
 * requires it to AGREE with the headers. Without this, a caller could upload an
 * archive whose real name is a protected/official one while declaring an
 * innocent third-party name — pnpm installs the ARCHIVE's name, and that name
 * then lands in the profile as a DIRECT dependency (exempt from the post-install
 * verifier), i.e. the exact shadow the protected set exists to prevent.
 * 2026-12 audit fix: the capture CLOSES at the end of the candidate's own data
 * area (a real archive carries entries after `package/package.json`, and their
 * data must not be appended to the JSON), the oversize flag is per candidate
 * (never sticky) and the capture is bounded by TGZ_MANIFEST_MAX_BYTES — the
 * LAST candidate wins, matching the entry pnpm's extraction overwrites.
 *
 * Pure Node (node:zlib), no dependencies. Returns a promise (the gunzip
 * stream is inherently async); the memory held at any moment is one 512-byte
 * header buffer, the bounded manifest capture, plus the inflater's own window.
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
    /** null when the archive carries no readable npm-pack manifest; `manifestError`
     *  says why (the route refuses such an upload — the asserted identity cannot be
     *  verified). */
    manifest: TgzManifestProjection | null
    manifestError?: 'missing' | 'invalid' | 'oversized'
  }
  | { ok: false; error: TgzScanError }

/** Manifest capture bound (the same order as the desktop manifest reader). */
export const TGZ_MANIFEST_MAX_BYTES = 64 * 1024

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
    /**
     * Bounded capture of the npm-pack `package/package.json` (see the module
     * header). The state is PER CANDIDATE: every candidate header resets it
     * (an oversized candidate is never sticky, and the LAST candidate wins —
     * pnpm's tar extraction overwrites, so the last entry is what installs).
     * Capture stops at the end of the candidate's own data area
     * (`manifestRemaining` reaches 0) — later entries' data must never leak
     * into the JSON. `manifestParts === null` = the current candidate has no
     * readable manifest.
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
        // Only the candidate's declared data bytes were captured — never the
        // 512-block padding tail, never a later entry's data. A manifest may
        // still declare its own trailing NUL/space bytes inside that size, so
        // strip them before parsing.
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
          // New candidate: the previous capture is closed for good. An
          // oversized candidate is recorded WITHOUT buffering a single byte
          // (the capture bound the module header promises), and it is not
          // sticky — a later readable candidate replaces it entirely.
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
