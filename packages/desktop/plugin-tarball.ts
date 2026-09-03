/**
 * Desktop plugin-source tarball builder + bounded tgz manifest reader
 * (design 21 §6.5, plan Phase 4.6 — `gateway_plugin_materialize`, folder
 * pick → tarball upload).
 *
 * The gateway's `PUT /chamber/plugins/materialize` route accepts a raw gzip
 * tarball (≤ 32 MiB body, ≤ 4096 entries, ≤ 256 MiB unpacked — the caps this
 * module mirrors as TARBALL_MAX_*; the textual lockstep test
 * plugin-tarball.test.ts pins them to the gateway's own constants so they can
 * never drift). This module builds that archive from a LOCAL plugin SOURCE
 * FOLDER in the npm-pack layout (`package/` root prefix — the layout pnpm
 * expects when the gateway stages the archive and runs `dsh plugin add
 * file:<path>`), and reads the folder's `package.json` in the SAME pass so
 * the uploaded `x-plugin-name`/`x-plugin-version` headers always describe
 * the archive that is actually sent.
 *
 * Deliberate v1 scope:
 * - ustar headers only; entry names are capped at 100 bytes and the 155-byte
 *   prefix field is NOT used — a longer relative path is an honest error
 *   (`path_too_long`) listing the offending file, never a silently
 *   different archive;
 * - symlinks are SKIPPED (recorded in `skipped`) — a plugin tarball must
 *   never carry a link target that could differ on the gateway;
 * - `node_modules/` and `.git/` subtrees are excluded at any depth (the same
 *   content `pnpm pack` would exclude; a registry-style tarball must not
 *   embed another install tree or history);
 * - modes are normalized (0o644 files / 0o755 directories) exactly like the
 *   plan states; mtime = now.
 *
 * Pure Node (node:fs / node:zlib) — no Electron imports, unit-testable
 * standalone. The folder-manifest whitelists are the control-plane shared
 * single source (plugin-spec.ts via control-plane-module.ts), the same
 * source the gateway route validates `x-plugin-name` against.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzip } from 'node:zlib'
import {
  isDeniedPluginName,
  PLUGIN_NAME_PATTERN,
} from './control-plane-module.ts'

// ---------------------------------------------------------------------------
// Caps — exact mirrors of the gateway route / tgz-scan ceilings (design 21
// §6.2 / §6.9; routes.ts MATERIALIZE_MAX_BYTES + tgz-scan.ts TGZ_MAX_ENTRIES
// / TGZ_MAX_UNPACKED_BYTES). plugin-tarball.test.ts pins the literals against
// the gateway sources so the desktop archive can never exceed what the route
// accepts.
// ---------------------------------------------------------------------------

/** Entry-count cap (tar headers incl. directory entries). */
export const TARBALL_MAX_ENTRIES = 4096
/** Unpacked footprint cap: 512-byte header + padded data per entry, exactly
 *  the route scan's `totalBytes` accounting (design 21 §6.9 default: 256 MiB,
 *  mirroring tgz-scan.ts TGZ_MAX_UNPACKED_BYTES). */
export const TARBALL_MAX_UNPACKED_BYTES = 256 * 1024 * 1024
/** Uploaded (gzip) archive cap — the route's MATERIALIZE_MAX_BYTES. */
export const TARBALL_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
/** package.json read cap for the folder manifest (bounded single file). */
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024

/** Strict exact-semver grammar of the gateway's `x-plugin-version` header
 *  (routes.ts PLUGIN_VERSION_PATTERN — module-local there; this is the
 *  desktop-side mirror pinned by plugin-tarball.test.ts). */
export const GATEWAY_PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** Test/injection seam: per-build cap overrides (defaults = the mirrors
 *  above). Only ever smaller — the desktop builder is a friendly pre-check,
 *  the gateway route remains the authority. */
export interface PluginTarballLimits {
  maxEntries?: number
  maxUnpackedBytes?: number
  maxArchiveBytes?: number
}

/** Error codes carried by buildPluginTarball rejections (Error.code). */
export type PluginTarballErrorCode =
  | 'not_a_directory'
  | 'unreadable'
  | 'too_many_entries'
  | 'too_large'
  | 'path_too_long'
  | 'archive_too_large'
  | 'folder_changed'

/** Folder `package.json` projection: ok:true carries the name/version that
 *  become the upload headers; ok:false is a loud honest reason. */
export type FolderPluginManifest =
  | { ok: true; name: string; version: string }
  | { ok: false; error: string }

export interface PluginTarballBuildResult {
  /** The gzip-compressed ustar archive (npm-pack layout: `package/` root). */
  buffer: Buffer
  /** tar entry names in archive order (relative ustar paths). */
  entries: string[]
  /** Honest notes for every path that was deliberately not packed
   *  (symlink / node_modules / .git). */
  skipped: string[]
  /** The folder package.json read on the same build pass — null-free
   *  ok:false when absent/unreadable/invalid. */
  manifest: FolderPluginManifest
}

// ---------------------------------------------------------------------------
// ustar header writer
// ---------------------------------------------------------------------------

/** Write an octal field: `length-1` octal digits + NUL (ustar convention). */
function writeOctalField(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0')
  header.write(text, offset, 'ascii')
  header[offset + length - 1] = 0
}

/** One 512-byte ustar v0 header block. `size` is only meaningful for files. */
function ustarHeader(name: string, mode: number, size: number, typeflag: '0' | '5'): Buffer {
  const header = Buffer.alloc(512)
  // name (bytes 0-99): the caller caps at 100 bytes and refuses longer names.
  header.write(name, 0, 'utf8')
  // mode (100-107), uid/gid (108-123) — uid/gid stay 0: the archive is
  // unpacked by pnpm under the gateway user, ownership is not transferable.
  writeOctalField(header, 100, 8, mode)
  writeOctalField(header, 108, 8, 0)
  writeOctalField(header, 116, 8, 0)
  // size (124-135, 12 bytes), mtime (136-147, 12 bytes).
  writeOctalField(header, 124, 12, size)
  writeOctalField(header, 136, 12, Math.floor(Date.now() / 1000))
  // Checksum field is computed with its own area as spaces (148-155).
  header.fill(0x20, 148, 156)
  header[156] = typeflag.charCodeAt(0)
  // ustar magic + version: 'ustar\0' (257-262) + '00' (263-264).
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  // devmajor/devminor (329-346) stay zero.
  let checksum = 0
  for (const byte of header) checksum += byte
  const digits = checksum.toString(8).padStart(6, '0')
  header.write(digits, 148, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

/** Pad a file body to the 512-byte tar block boundary. */
function paddedBlock(body: Buffer): Buffer {
  const padding = (512 - (body.length % 512)) % 512
  return padding === 0 ? body : Buffer.concat([body, Buffer.alloc(padding)])
}

// ---------------------------------------------------------------------------
// Folder manifest reading
// ---------------------------------------------------------------------------

function manifestError(message: string): FolderPluginManifest {
  return { ok: false, error: message }
}

/** Read `<dir>/package.json` as UTF-8 text, bounded to 64 KiB. ok:false for
 *  absent/unreadable/oversized files — never a guessed default. */
function readFolderPackageJson(dirPath: string): { ok: true; text: string } | { ok: false; error: string } {
  const manifestPath = join(dirPath, 'package.json')
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(manifestPath)
  } catch {
    return { ok: false, error: `${manifestPath} is missing — the picked folder is not a plugin source folder` }
  }
  if (!stat.isFile()) {
    return { ok: false, error: `${manifestPath} is not a regular file` }
  }
  if (stat.size > PLUGIN_MANIFEST_MAX_BYTES) {
    return { ok: false, error: `${manifestPath} exceeds the ${PLUGIN_MANIFEST_MAX_BYTES}-byte read bound` }
  }
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return { ok: false, error: `${manifestPath} is unreadable: ${String(error)}` }
  }
  return { ok: true, text }
}

/** Full folder manifest: name (registry whitelist + reserved-domain deny) and
 *  version (the route's x-plugin-version grammar). */
function readFolderPluginManifest(dirPath: string): FolderPluginManifest {
  const raw = readFolderPackageJson(dirPath)
  if (!raw.ok) return manifestError(raw.error)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.text)
  } catch {
    return manifestError(`${join(dirPath, 'package.json')} is not valid JSON`)
  }
  const record = parsed as Record<string, unknown>
  const name = typeof record?.name === 'string' ? record.name : ''
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    return manifestError('package.json name is not a safe registry package name')
  }
  if (isDeniedPluginName(name)) {
    return manifestError('package.json name is in the reserved domain (@deepseek-ai/* and @dsh-chamber/* cannot be installed through the plugin model)')
  }
  const version = typeof record?.version === 'string' ? record.version : ''
  if (!GATEWAY_PLUGIN_VERSION_PATTERN.test(version)) {
    return manifestError('package.json version is not an exact semver (the gateway x-plugin-version grammar: major.minor.patch[±prerelease/build])')
  }
  return { ok: true, name, version }
}

/**
 * Read the `name` field of `<folder>/package.json` (≤ 64 KiB); null when the
 * file is absent/unreadable or the name fails the shared registry-name
 * whitelist. The full (name + version + reserved-domain) form is what
 * buildPluginTarball validates internally.
 */
export function pluginNameFromFolder(folderPath: string): string | null {
  const raw = readFolderPackageJson(folderPath)
  if (!raw.ok) return null
  try {
    const record = JSON.parse(raw.text) as { name?: unknown }
    return typeof record?.name === 'string' && PLUGIN_NAME_PATTERN.test(record.name) ? record.name : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Walk + archive build
// ---------------------------------------------------------------------------

/** Directory subtrees deliberately excluded from a plugin source archive
 *  (same content pnpm pack would drop). */
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git'])

function tarError(code: PluginTarballErrorCode, message: string): Error & { code: PluginTarballErrorCode } {
  return Object.assign(new Error(message), { code })
}

/**
 * Build a gzip-compressed ustar tarball of a local plugin source folder
 * (npm-pack `package/` layout). Rejects (Error.code ∈ PluginTarballErrorCode)
 * when the folder is not a directory, a file is unreadable, a relative entry
 * path exceeds the 100-byte ustar name field, or any cap (entries / unpacked
 * footprint / final archive bytes) is exceeded — never a silently truncated
 * or oversized archive.
 *
 * The walk emits directories before their contents (files ordered inside
 * each directory); symlinks and `node_modules`/`.git` subtrees are skipped
 * and recorded in `skipped`. The folder's package.json is read in the same
 * pass and returned as `manifest`; if its bytes change between that read and
 * the archive write the build fails with `folder_changed` (the upload
 * headers must always describe the archive actually sent).
 *
 * `opts.limits` lets tests inject smaller caps.
 */
export function buildPluginTarball(
  dirPath: string,
  opts?: { limits?: PluginTarballLimits },
): Promise<PluginTarballBuildResult> {
  const limits: Required<PluginTarballLimits> = {
    maxEntries: opts?.limits?.maxEntries ?? TARBALL_MAX_ENTRIES,
    maxUnpackedBytes: opts?.limits?.maxUnpackedBytes ?? TARBALL_MAX_UNPACKED_BYTES,
    maxArchiveBytes: opts?.limits?.maxArchiveBytes ?? TARBALL_MAX_ARCHIVE_BYTES,
  }
  return new Promise((resolve, reject) => {
    try {
      const built = buildSync(dirPath, limits)
      gzip(built.tar, (error, buffer) => {
        if (error !== null) {
          reject(error)
          return
        }
        if (buffer.length > limits.maxArchiveBytes) {
          reject(tarError('archive_too_large', `the packed archive is ${buffer.length} bytes, beyond the ${limits.maxArchiveBytes}-byte upload cap`))
          return
        }
        resolve({ buffer, entries: built.entries, skipped: built.skipped, manifest: built.manifest })
      })
    } catch (error) {
      reject(error)
    }
  })
}

function buildSync(
  dirPath: string,
  limits: Required<PluginTarballLimits>,
): { tar: Buffer; entries: string[]; skipped: string[]; manifest: FolderPluginManifest } {
  let rootStat: ReturnType<typeof statSync>
  try {
    rootStat = statSync(dirPath)
  } catch {
    throw tarError('unreadable', `cannot read the picked folder ${dirPath}: it is missing or unreadable`)
  }
  if (!rootStat.isDirectory()) {
    throw tarError('not_a_directory', `the picked path ${dirPath} is not a directory`)
  }

  // Manifest read FIRST (single pass) — the walk below packs the same
  // package.json it validated, or fails with folder_changed.
  const manifest = readFolderPluginManifest(dirPath)
  const manifestBytes = manifest.ok ? readFileSync(join(dirPath, 'package.json')) : null

  const blocks: Buffer[] = []
  const entries: string[] = []
  const skipped: string[] = []
  let entryCount = 0
  let unpackedBytes = 0
  /** Whether the validated `package/package.json` was actually packed as a
   *  regular file (a symlinked/unreadable manifest must never produce an
   *  archive that contradicts the upload headers). */
  let manifestPacked = false

  const trackEntry = (headerName: string): void => {
    entryCount += 1
    unpackedBytes += 512
    if (entryCount > limits.maxEntries) {
      throw tarError('too_many_entries', `the folder packs more than ${limits.maxEntries} archive entries`)
    }
    if (unpackedBytes > limits.maxUnpackedBytes) {
      throw tarError('too_large', `the folder unpacks beyond the ${limits.maxUnpackedBytes}-byte bound`)
    }
    entries.push(headerName)
  }

  const addFile = (archivePath: string, body: Buffer): void => {
    if (archivePath.length > 100) {
      throw tarError('path_too_long', `archive entry path exceeds the 100-byte ustar name field: ${archivePath}`)
    }
    const header = ustarHeader(archivePath, 0o644, body.length, '0')
    trackEntry(archivePath)
    unpackedBytes += body.length
    if (unpackedBytes > limits.maxUnpackedBytes) {
      throw tarError('too_large', `the folder unpacks beyond the ${limits.maxUnpackedBytes}-byte bound`)
    }
    blocks.push(header, paddedBlock(body))
  }

  const addDirectory = (archivePath: string): void => {
    if (archivePath.length > 100) {
      throw tarError('path_too_long', `archive entry path exceeds the 100-byte ustar name field: ${archivePath}`)
    }
    trackEntry(archivePath)
    blocks.push(ustarHeader(archivePath, 0o755, 0, '5'))
  }

  /** Recursive emission: directory header first, then its children
   *  (directories before files, each ordered by name). */
  const emitDirectory = (diskDir: string, archiveDir: string): void => {
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = readdirSync(diskDir, { withFileTypes: true })
    } catch (error) {
      throw tarError('unreadable', `cannot read ${diskDir}: ${String(error)}`)
    }
    const dirs = dirents.filter(entry => entry.isDirectory())
    const files = dirents.filter(entry => !entry.isDirectory())
    const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const dirent of [...dirs.sort(byName), ...files.sort(byName)]) {
      const childDisk = join(diskDir, dirent.name)
      const childArchive = `${archiveDir}${dirent.name}`
      if (dirent.isSymbolicLink()) {
        // A symlink target is a machine-local fact — never transferable into
        // a plugin tarball (the gateway would unpack whatever it points at).
        skipped.push(`${childArchive} (symbolic link, not packed)`)
        continue
      }
      if (dirent.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(dirent.name)) {
          skipped.push(`${childArchive}/ (${dirent.name} excluded)`)
          continue
        }
        addDirectory(`${childArchive}/`)
        emitDirectory(childDisk, `${childArchive}/`)
        continue
      }
      if (!dirent.isFile()) {
        // Sockets/FIFOs/devices cannot ride a plugin tarball either.
        skipped.push(`${childArchive} (not a regular file, not packed)`)
        continue
      }
      let body: Buffer
      try {
        body = readFileSync(childDisk)
      } catch (error) {
        throw tarError('unreadable', `cannot read ${childDisk}: ${String(error)}`)
      }
      // The manifest bytes were captured before the walk; if the folder's
      // package.json changed in between, the archive no longer matches the
      // manifest that names the upload — honest failure, never a mismatch.
      if (childArchive === 'package/package.json') {
        if (manifestBytes !== null && !body.equals(manifestBytes)) {
          throw tarError('folder_changed', 'the folder changed while it was being packed (package.json); re-run the materialize pick')
        }
        manifestPacked = true
      }
      addFile(childArchive, body)
    }
  }

  addDirectory('package/')
  emitDirectory(dirPath, 'package/')
  if (manifest.ok && !manifestPacked) {
    // The manifest was readable through a symlink or a second read but the
    // archive carries no regular package.json — the upload headers would
    // describe a package the archive does not contain.
    throw tarError('folder_changed', 'the folder package.json is not a regular file that could be packed; re-run the materialize pick')
  }

  // Classic end-of-archive marker: two all-zero blocks.
  blocks.push(Buffer.alloc(512), Buffer.alloc(512))
  return { tar: Buffer.concat(blocks), entries, skipped, manifest }
}

// ---------------------------------------------------------------------------
// Bounded tgz manifest reader (roundtrip verification + future archive-pick
// flows): gunzip + locate `package/package.json` (or a root `package.json`)
// and read ≤ 64 KiB of its text. Null on any structural failure — never a
// guessed manifest.
// ---------------------------------------------------------------------------

const TGZ_MANIFEST_CANDIDATES = ['package/package.json', 'package.json']

export interface TgzPackageManifest {
  name: string
  version: string
}

/** Parse a gzip tar archive and read its package manifest (npm-pack
 *  layout). Bounded: gunzip is capped at TARBALL_MAX_UNPACKED_BYTES and the
 *  manifest entry text at 64 KiB. Returns null when the buffer is not a
 *  gzip/tar stream, the archive is truncated, or no parseable
 *  package.json entry exists. */
export function listTgzManifest(archive: Buffer): TgzPackageManifest | null {
  let tar: Buffer
  try {
    // Inflate bound: the desktop archive builder itself emits ≤
    // TARBALL_MAX_UNPACKED_BYTES of tar (headers included), plus the
    // two-block end marker — the small margin keeps the largest legal
    // desktop-built archive readable while still refusing zip-bomb growth.
    tar = gunzipSync(archive, { maxOutputLength: TARBALL_MAX_UNPACKED_BYTES + 4 * 1024 * 1024 })
  } catch {
    return null
  }
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every(byte => byte === 0)) break
    const nul = header.indexOf(0, 0)
    const nameEnd = nul === -1 ? 100 : nul
    const name = header.subarray(0, nameEnd).toString('utf8')
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/u, '')
    const size = sizeField === '' || !/^[0-7]+$/u.test(sizeField) ? null : parseInt(sizeField, 8)
    if (size === null) return null
    const padded = Math.ceil(size / 512) * 512
    const body = tar.subarray(offset, offset + size)
    if (padded > tar.length - offset) return null
    offset += padded
    const typeflag = String.fromCharCode(header[156])
    if (typeflag === '0' || typeflag === '\0') {
      if (TGZ_MANIFEST_CANDIDATES.includes(name)) {
        if (size > PLUGIN_MANIFEST_MAX_BYTES) return null
        const candidate = parseTgzManifestText(body.toString('utf8'))
        if (candidate !== null) return candidate
        // Fall through: a malformed preferred entry never shadows a valid
        // candidate encountered later.
      }
    }
  }
  return null
}

function parseTgzManifestText(text: string): TgzPackageManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown>
  const name = typeof record?.name === 'string' && record.name !== '' ? record.name : null
  const version = typeof record?.version === 'string' && record.version !== '' ? record.version : null
  return name === null || version === null ? null : { name, version }
}
