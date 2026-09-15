/**
 * Minimal ustar tar/gz fixture builders for the tgz-scan and materialize
 * route tests (design 21 §6.2 caps). Headers carry only the fields the scan
 * reads — name (0-99), octal size (124-135) and typeflag (156); the checksum
 * is left zero (the scanner never validates it). Data areas are zero-padded
 * to 512-byte blocks and the archive ends with the classic two zero blocks.
 */
import { gzipSync } from 'node:zlib'

export interface TarEntrySpec {
  /** Header name (≤ 100 chars; truncated like real tars would be). */
  name: string
  /** Entry content; absent → zero-length file. */
  data?: Buffer | string
  /** Explicit declared size overriding the data length (cap probes need a
   * size field that lies about the payload). */
  declaredSize?: number
  /** ustar typeflag (default '0' regular file). */
  typeflag?: string
}

export interface TarOptions {
  /** Append the two-zero-block end marker (default true). */
  endBlocks?: boolean
  /** Pad declared-but-absent sizes with real zero bytes (default true —
   * set false for cap probes that must never materialize the data). */
  padDeclared?: boolean
}

export function buildTar(entries: TarEntrySpec[], options: TarOptions = {}): Buffer {
  const endBlocks = options.endBlocks !== false
  const padDeclared = options.padDeclared !== false
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name.slice(0, 100), 0, 100, 'utf8')
    const dataBytes = entry.data === undefined ? null : Buffer.from(entry.data)
    const size = entry.declaredSize ?? (dataBytes === null ? 0 : dataBytes.length)
    header.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii')
    header.write(entry.typeflag ?? '0', 156, 1, 'ascii')
    blocks.push(header)
    if (dataBytes !== null && dataBytes.length > 0) {
      const area = Buffer.alloc(Math.ceil(dataBytes.length / 512) * 512)
      dataBytes.copy(area)
      blocks.push(area)
    } else if (size > 0 && padDeclared) {
      blocks.push(Buffer.alloc(Math.ceil(size / 512) * 512))
    }
  }
  if (endBlocks) blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

export function buildTgz(entries: TarEntrySpec[], options: TarOptions = {}): Buffer {
  return gzipSync(buildTar(entries, options))
}

/** A realistic single-file archive: package/package.json with a tiny
 * manifest (what a real `pnpm pack` output would look like, structurally). */
export function buildPluginTgz(overrides: { name?: string; version?: string } = {}): Buffer {
  return buildTgz([
    { name: 'package/', typeflag: '5' },
    {
      name: 'package/package.json',
      data: JSON.stringify({ name: overrides.name ?? 'fixture-plugin', version: overrides.version ?? '1.0.0' }),
    },
  ])
}
