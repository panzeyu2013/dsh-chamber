/**
 * plugin-tarball unit tests (design 21 §6.5, plan Phase 4.6): the desktop
 * plugin-source tarball builder + bounded tgz manifest reader — npm-pack
 * archive layout, honest skips, cap errors with machine codes, the manifest
 * projection, and the TEXTUAL LOCKSTEP tests pinning every cap + the version
 * grammar to the gateway route's own literals.
 * Sibling parts: plugin-sync.test.ts, plugin-sync-remote-read.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { scanTgzMetadata } from '../../../gateway/src/tgz-scan.ts'
import {
  buildPluginTarball,
  classifyPluginPick,
  GATEWAY_PLUGIN_VERSION_PATTERN,
  inspectTgzManifest,
  listTgzManifest,
  PLUGIN_MANIFEST_MAX_BYTES,
  pluginNameFromFolder,
  TARBALL_MAX_ARCHIVE_BYTES,
  TARBALL_MAX_ENTRIES,
  TARBALL_MAX_UNPACKED_BYTES,
} from '../../plugin-tarball.ts'
import { tempDir } from './plugin-sync-fixtures.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')

function write(root: string, relative: string, content: string | Buffer): void {
  const full = join(root, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** A tiny ustar header walker (test-side only) so mode/type assertions are
 *  against the actual archive bytes. The name field is bytes 0-99: a
 *  NUL-terminated shorter name, or the full 100 bytes at the bound (the mode
 *  bytes that follow are never part of it). */
function tarHeaderEntries(tar: Buffer): Array<{ name: string; mode: number; typeflag: string }> {
  const entries: Array<{ name: string; mode: number; typeflag: string }> = []
  let offset = 0
  for (;;) {
    assert.ok(offset + 512 <= tar.length, 'unexpectedly truncated tar')
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const nameField = header.subarray(0, 100)
    const nameNul = nameField.indexOf(0)
    const name = nameField.subarray(0, nameNul === -1 ? 100 : nameNul).toString('utf8')
    const mode = parseInt(header.subarray(100, 107).toString('ascii').replace(/[^\d]/g, ''), 8)
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/u, '')
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8)
    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    entries.push({ name, mode, typeflag })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

/** Test-side single-entry ustar block (name/size/typeflag only — neither
 *  reader validates the checksum). Used ONLY to splice a decoy entry in front
 *  of a REAL `buildPluginTarball` archive; the builder is the only production
 *  writer. */
function ustarEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644', 100, 'ascii')
  header.write('0000000', 108, 'ascii')
  header.write('0000000', 116, 'ascii')
  header.write(body.length.toString(8).padStart(11, '0'), 124, 'ascii')
  header.write('00000000000', 136, 'ascii')
  header[156] = 0x30
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return Buffer.concat([header, padded])
}

/** The audit's shadow archive: a root `package.json` decoy FIRST, then a real
 *  builder archive (whose `package/package.json` pnpm would actually install). */
function prependRootManifestDecoy(archive: Buffer, manifest: { name: string; version: string }): Buffer {
  return gzipSync(Buffer.concat([ustarEntry('package.json', JSON.stringify(manifest)), gunzipSync(archive)]))
}

test('buildPluginTarball packs a folder in the npm-pack layout with normalized modes and a valid manifest', async () => {
  const fixture = tempDir('plugin-tarball-')
  write(fixture, 'package.json', JSON.stringify({ name: 'my-test-plugin', version: '1.2.3' }))
  write(fixture, 'lib/index.js', 'export const x = 1\n')
  write(fixture, 'assets/data.txt', 'payload')
  mkdirSync(join(fixture, 'docs', 'empty'), { recursive: true })
  const result = await buildPluginTarball(fixture)
  assert.deepEqual(result.manifest, { ok: true, name: 'my-test-plugin', version: '1.2.3' })
  assert.deepEqual(result.entries, ['package/', 'package/assets/', 'package/assets/data.txt', 'package/docs/', 'package/docs/empty/',
    'package/lib/', 'package/lib/index.js', 'package/package.json'])
  assert.deepEqual(result.skipped, [])
  // gzip magic + valid gzip stream.
  assert.equal(result.buffer[0], 0x1f)
  assert.equal(result.buffer[1], 0x8b)
  const entries = tarHeaderEntries(gunzipSync(result.buffer))
  const modes = new Map(entries.map(entry => [entry.name, entry.mode]))
  assert.equal(modes.get('package/package.json'), 0o644)
  assert.equal(modes.get('package/lib/index.js'), 0o644)
  assert.equal(modes.get('package/'), 0o755)
  assert.equal(modes.get('package/docs/empty/'), 0o755)
  assert.equal(entries.find(entry => entry.name === 'package/')?.typeflag, '5')
  assert.equal(entries.find(entry => entry.name === 'package/lib/index.js')?.typeflag, '0')
})
test('buildPluginTarball: the gzip archive roundtrips through listTgzManifest', async () => {
  const fixture = tempDir('plugin-tarball-')
  write(fixture, 'package.json', JSON.stringify({ name: '@scope/dsh-plugin-x', version: '2.0.0-beta.1+build.5' }))
  const result = await buildPluginTarball(fixture)
  assert.deepEqual(listTgzManifest(result.buffer), { name: '@scope/dsh-plugin-x', version: '2.0.0-beta.1+build.5' })
})
test('listTgzManifest returns null for garbage, non-gzip and manifest-less archives — never a guess', async () => {
  assert.equal(listTgzManifest(Buffer.from('not a tarball at all')), null)
  assert.equal(listTgzManifest(Buffer.from([0x1f, 0x8b, 0x00, 0x01])), null)
  const emptyDir = tempDir('plugin-tarball-')
  mkdirSync(join(emptyDir, 'lib'), { recursive: true })
  const result = await buildPluginTarball(emptyDir)
  assert.equal(result.manifest.ok, false, 'a folder without package.json has no manifest')
  assert.equal(listTgzManifest(result.buffer), null, 'an archive without package.json has no manifest')
  assert.deepEqual(result.entries, ['package/', 'package/lib/'])
})
test('buildPluginTarball skips symlinks and node_modules/.git subtrees with honest notes', async () => {
  const fixture = tempDir('plugin-tarball-')
  write(fixture, 'package.json', JSON.stringify({ name: 'skips', version: '1.0.0' }))
  write(fixture, 'real.js', 'x')
  symlinkSync(join(fixture, 'real.js'), join(fixture, 'link.js'))
  write(fixture, 'node_modules/dep/index.js', 'nested install tree')
  write(fixture, '.git/config', '[core]')
  mkdirSync(join(fixture, 'src', '.git'), { recursive: true })
  write(fixture, 'src/.git/HEAD', 'ref: refs/heads/main')
  const result = await buildPluginTarball(fixture)
  assert.ok(!result.entries.some(name => name.includes('link.js') || name.includes('node_modules') || name.includes('.git')),
    `archive must not contain skipped paths: ${result.entries.join(', ')}`)
  assert.deepEqual(result.skipped, ['package/.git/ (.git excluded)', 'package/node_modules/ (node_modules excluded)',
    'package/src/.git/ (.git excluded)', 'package/link.js (symbolic link, not packed)'])
})
test('buildPluginTarball: a symlinked package.json can never contradict the upload headers', async () => {
  const fixture = tempDir('plugin-tarball-')
  write(fixture, 'real-manifest.json', JSON.stringify({ name: 'sym-pkg', version: '1.0.0' }))
  symlinkSync(join(fixture, 'real-manifest.json'), join(fixture, 'package.json'))
  await assert.rejects(buildPluginTarball(fixture), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, 'folder_changed')
    return true
  })
})
test('buildPluginTarball: a relative entry path beyond 100 bytes is an honest path_too_long error', async () => {
  const fixture = tempDir('plugin-tarball-')
  const deep = `dir/${'segment'.repeat(14)}/file.js` // > 100 bytes relative
  write(fixture, deep, 'x')
  write(fixture, 'package.json', JSON.stringify({ name: 'deep-pkg', version: '1.0.0' }))
  await assert.rejects(buildPluginTarball(fixture), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, 'path_too_long')
    assert.match((error as Error).message, /100-byte ustar/)
    return true
  })
})
test('buildPluginTarball: the ustar 100-byte name bound is measured in UTF-8 bytes, not UTF-16 units', async () => {
  // 'package/' (8 bytes) + 30 CJK chars (90 bytes) + suffix. The retired
  // `archivePath.length > 100` check read 40/41 UTF-16 units for these paths,
  // so BOTH "fit" — yet the 101-byte one was silently truncated mid-character
  // inside the 100-byte header name field (archive ≠ reported entries).
  const exactFile = `${'中'.repeat(30)}ab` // archive path: exactly 100 bytes
  const overFile = `${'中'.repeat(30)}abc` // archive path: 101 bytes
  const exactDir = `${'中'.repeat(30)}a/` // archive path: exactly 100 bytes
  const overDir = `${'中'.repeat(30)}ab/` // archive path: 101 bytes
  const atBoundary = tempDir('plugin-tarball-')
  write(atBoundary, exactFile, 'x')
  mkdirSync(join(atBoundary, exactDir), { recursive: true })
  write(atBoundary, 'package.json', JSON.stringify({ name: 'cjk-boundary', version: '1.0.0' }))
  const result = await buildPluginTarball(atBoundary)
  const headerNames = tarHeaderEntries(gunzipSync(result.buffer)).map(entry => entry.name)
  for (const target of [`package/${exactDir}`, `package/${exactFile}`]) {
    assert.equal(Buffer.byteLength(target, 'utf8'), 100, `fixture must sit exactly on the byte bound: ${target}`)
    assert.ok(target.length < 100, 'the retired UTF-16 check would have accepted this path')
    assert.ok(result.entries.includes(target), `entries must report the full 100-byte path: ${target}`)
    assert.ok(headerNames.includes(target), `the header name must be the full 100-byte path, not truncated: ${headerNames.join(', ')}`)
  }
  for (const kind of ['file', 'directory'] as const) {
    const fixture = tempDir('plugin-tarball-')
    const over = kind === 'file' ? overFile : overDir
    if (kind === 'file') write(fixture, over, 'x')
    else mkdirSync(join(fixture, over), { recursive: true })
    write(fixture, 'package.json', JSON.stringify({ name: 'cjk-boundary', version: '1.0.0' }))
    assert.equal(Buffer.byteLength(`package/${over}`, 'utf8'), 101, kind)
    await assert.rejects(buildPluginTarball(fixture), (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'path_too_long', kind)
      assert.match((error as Error).message, /100-byte ustar name field/, kind)
      return true
    })
  }
})
test('buildPluginTarball: injected entry-cap and unpacked-byte limits error with the mirror codes', async () => {
  const many = tempDir('plugin-tarball-')
  for (let index = 0; index < 10; index += 1) write(many, `f${index}.js`, 'x')
  write(many, 'package.json', JSON.stringify({ name: 'cap-pkg', version: '1.0.0' }))
  await assert.rejects(
    buildPluginTarball(many, { limits: { maxEntries: 4 } }),
    (error: unknown) => (error as Error & { code?: string }).code === 'too_many_entries',
  )
  const big = tempDir('plugin-tarball-')
  write(big, 'big.bin', Buffer.alloc(2000, 7))
  write(big, 'package.json', JSON.stringify({ name: 'cap-pkg', version: '1.0.0' }))
  await assert.rejects(
    buildPluginTarball(big, { limits: { maxUnpackedBytes: 1000 } }),
    (error: unknown) => (error as Error & { code?: string }).code === 'too_large',
  )
  const gz = tempDir('plugin-tarball-')
  // True-random content so gzip cannot shrink it under the archive cap.
  write(gz, 'blob.bin', randomBytes(8192))
  write(gz, 'package.json', JSON.stringify({ name: 'cap-pkg', version: '1.0.0' }))
  await assert.rejects(
    buildPluginTarball(gz, { limits: { maxArchiveBytes: 1024 } }),
    (error: unknown) => (error as Error & { code?: string }).code === 'archive_too_large',
  )
})
test('buildPluginTarball: padded-footprint accounting (gateway-scan parity) rejects the raw-bytes acceptance window', async () => {
  // 1 directory + package.json + 6 one-byte files: 8 headers × 512 +
  // padded data. RAW accounting (headers + unpadded body bytes ≈ 4138)
  // fits a 5000-byte bound, but padded accounting (7680 bytes without
  // the end marker, 8704 with it) does not — the padded-vs-raw divergence
  // is what this window pins. The dedicated marker case below pins the
  // 1024-byte end-marker reservation itself.
  const fixture = tempDir('plugin-tarball-')
  write(fixture, 'package.json', JSON.stringify({ name: 'cap-pkg', version: '1.0.0' }))
  for (let index = 0; index < 6; index += 1) write(fixture, `f${index}.js`, 'x')
  await assert.rejects(
    buildPluginTarball(fixture, { limits: { maxUnpackedBytes: 5000 } }),
    (error: unknown) => (error as Error & { code?: string }).code === 'too_large',
  )
})
test('every archive the desktop builder accepts is accepted by the real gateway tgz scan', async () => {
  // A deliberately tight builder bound (default caps would need hundreds
  // of MiB of fixtures). Any archive that passes the builder's padded
  // pre-check must also pass the gateway route's scan with the DEFAULT
  // caps — the two accounting formulas must agree, end marker included.
  const fixture = tempDir('plugin-tarball-')
  for (let index = 0; index < 12; index += 1) write(fixture, `lib/m${index}.js`, `export const m${index} = ${index}\n`)
  write(fixture, 'package.json', JSON.stringify({ name: 'parity-pkg', version: '0.1.0' }))
  const result = await buildPluginTarball(fixture, { limits: { maxUnpackedBytes: 16 * 1024 } })
  const scanned = await scanTgzMetadata(result.buffer)
  assert.deepEqual(
    { ok: scanned.ok, entries: scanned.ok ? scanned.entries : null, error: scanned.ok ? null : scanned.error },
    { ok: true, entries: 15, error: null },
    'a desktop-built archive must always pass the gateway materialize scan (entries: package/ + package/lib/ + package.json + 12 files)',
  )
})
test('a real desktop-built archive with an entry AFTER package/package.json still projects its manifest to the gateway scan', async () => {
  const fixture = tempDir('plugin-tarball-')
  write(fixture, 'package.json', JSON.stringify({ name: 'e2e-capture-pkg', version: '1.2.3' }))
  write(fixture, 'a.js', 'x')
  // Sorted after package.json, so the archive's LAST file entry is zzz.txt —
  // the exact shape the gateway scan used to reject as tgz_invalid.
  write(fixture, 'zzz.txt', 'y')
  const result = await buildPluginTarball(fixture)
  assert.ok(
    result.entries.indexOf('package/zzz.txt') > result.entries.indexOf('package/package.json'),
    'fixture must carry an entry after package/package.json',
  )
  const scanned = await scanTgzMetadata(result.buffer)
  assert.equal(scanned.ok, true)
  if (scanned.ok) {
    assert.deepEqual(scanned.manifest, { name: 'e2e-capture-pkg', version: '1.2.3' })
    assert.equal(scanned.manifestError, undefined)
  }
  assert.deepEqual(listTgzManifest(result.buffer), { name: 'e2e-capture-pkg', version: '1.2.3' })
})
test('the 1024-byte end-of-archive marker is part of the unpacked budget (gateway inflated-bytes parity)', async () => {
  // Same folder shape as the parity test: 15 entries (headers 15×512) +
  // 13 padded file bodies (13×512) = 14336 bytes WITHOUT the two-block
  // end marker, 15360 WITH it. A 15000-byte cap therefore accepts the
  // padded bodies and rejects ONLY because the marker is reserved — this
  // pins the marker accounting itself (the gateway's actual-inflated-bytes
  // guard counts the marker as real inflate output; its declared
  // totalBytes stops at the end marker).
  const fixture = tempDir('plugin-tarball-')
  for (let index = 0; index < 12; index += 1) write(fixture, `lib/m${index}.js`, `export const m${index} = ${index}\n`)
  write(fixture, 'package.json', JSON.stringify({ name: 'marker-pkg', version: '0.1.0' }))
  await assert.rejects(
    buildPluginTarball(fixture, { limits: { maxUnpackedBytes: 15000 } }),
    (error: unknown) => (error as Error & { code?: string }).code === 'too_large',
  )
})
test('buildPluginTarball: non-directory and missing paths are loud errors', async () => {
  const fixture = tempDir('plugin-tarball-')
  const file = join(fixture, 'plain.txt')
  writeFileSync(file, 'x')
  await assert.rejects(buildPluginTarball(file), (error: unknown) => (error as Error & { code?: string }).code === 'not_a_directory')
  await assert.rejects(buildPluginTarball(join(fixture, 'nope')), (error: unknown) => (error as Error & { code?: string }).code === 'unreadable')
})
test('buildPluginTarball manifest validation: name/version whitelists + JSON honesty (shape only)', async () => {
  // The retired domain deny (design 21 §6.11.5): building an upload is SHAPE
  // validation only — an official/chamber-scope package may be packed, staged
  // and uploaded; whether it may be installed is decided by the receiving
  // backend's protected-set judgement (gateway submit / ssh apply), never here.
  const manifestTests: Array<{ pkg: unknown; manifestName: string | null; nameOnly: string | null; errorMatch: RegExp }> = [
    { pkg: { name: 'ok-pkg', version: '1.0.0' }, manifestName: 'ok-pkg', nameOnly: 'ok-pkg', errorMatch: /$/ },
    { pkg: { name: '@dsh-chamber/taken', version: '1.0.0' }, manifestName: '@dsh-chamber/taken', nameOnly: '@dsh-chamber/taken', errorMatch: /$/ },
    { pkg: { name: '@deepseek-ai/taken', version: '1.0.0' }, manifestName: '@deepseek-ai/taken', nameOnly: '@deepseek-ai/taken', errorMatch: /$/ },
    { pkg: { name: 'bad name!', version: '1.0.0' }, manifestName: null, nameOnly: null, errorMatch: /not a safe registry package name/ },
    { pkg: { name: 'ok-pkg', version: 'v1.0.0' }, manifestName: null, nameOnly: 'ok-pkg', errorMatch: /not an exact semver/ },
    { pkg: { name: 'ok-pkg' }, manifestName: null, nameOnly: 'ok-pkg', errorMatch: /not an exact semver/ },
    { pkg: 'not an object', manifestName: null, nameOnly: null, errorMatch: /not valid JSON/ },
    { pkg: '{broken json', manifestName: null, nameOnly: null, errorMatch: /not valid JSON/ },
  ]
  for (const entry of manifestTests) {
    const fixture = tempDir('plugin-tarball-')
    write(fixture, 'package.json', typeof entry.pkg === 'string' ? entry.pkg : JSON.stringify(entry.pkg))
    write(fixture, 'index.js', 'x')
    const result = await buildPluginTarball(fixture)
    assert.equal(result.manifest.ok, entry.manifestName !== null)
    if (entry.manifestName !== null && result.manifest.ok) assert.equal(result.manifest.name, entry.manifestName)
    if (!result.manifest.ok) assert.match(result.manifest.error, entry.errorMatch)
    // pluginNameFromFolder is the NAME-ONLY read (plan §6.5): it applies the
    // registry name whitelist and nothing else (no version, no domain rule).
    assert.equal(pluginNameFromFolder(fixture), entry.nameOnly)
  }
})
test('pluginNameFromFolder: an oversized package.json is refused, a plain-name read succeeds', async () => {
  const fixture = tempDir('plugin-tarball-')
  const path = join(fixture, 'package.json')
  writeFileSync(path, `{"name":"x","version":"1.0.0"}`.padEnd(PLUGIN_MANIFEST_MAX_BYTES + 10, ' '))
  assert.equal(pluginNameFromFolder(fixture), null, 'the 64 KiB read bound must hold')
  writeFileSync(path, JSON.stringify({ name: 'plain-name', version: '0.0.1' }))
  assert.equal(pluginNameFromFolder(fixture), 'plain-name')
})

// ---------------------------------------------------------------------------
// classifyPluginPick (design 21 §6.5 archive-pick): a picked path becomes a
// source folder, or a ready .tgz archive with its bounded manifest — every
// refusal is a loud structural error naming only the basename.
// ---------------------------------------------------------------------------

test('classifyPluginPick: a directory is a dir source; a ready tgz archive is read with its manifest', async () => {
  const fixture = tempDir('plugin-tarball-')
  // Directory → dir source, no read.
  const dirPick = classifyPluginPick(fixture)
  assert.deepEqual(dirPick, { ok: true, source: { kind: 'dir', path: fixture } })
  // A real plugin source folder packed by the builder → written out as a
  // .tgz → classified as a verbatim archive whose bytes roundtrip.
  write(fixture, 'package.json', JSON.stringify({ name: 'pick-ok-pkg', version: '0.0.1' }))
  write(fixture, 'index.js', 'x')
  const built = await buildPluginTarball(fixture)
  assert.equal(built.manifest.ok, true)
  const archivePath = join(fixture, '..', 'pick-ok-pkg-0.0.1.tgz')
  writeFileSync(archivePath, built.buffer)
  const pick = classifyPluginPick(archivePath)
  assert.equal(pick.ok, true)
  if (pick.ok) {
    assert.equal(pick.source.kind, 'tgz')
    if (pick.source.kind === 'tgz') {
      assert.equal(pick.source.path, archivePath)
      assert.equal(pick.source.name, 'pick-ok-pkg')
      assert.equal(pick.source.version, '0.0.1')
      assert.ok(pick.source.bytes.equals(built.buffer), 'the archive bytes are preserved verbatim')
      assert.deepEqual(listTgzManifest(pick.source.bytes), { name: 'pick-ok-pkg', version: '0.0.1' })
    }
  }
})
test('classifyPluginPick: refusals — missing path, non-tgz file, garbage tgz, empty pick', () => {
  const fixture = tempDir('plugin-tarball-')
  assert.equal(classifyPluginPick('').ok, false)
  const missing = classifyPluginPick(join(fixture, 'nope.tgz'))
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /no longer exists/)
  const plain = join(fixture, 'notes.txt')
  writeFileSync(plain, 'not an archive')
  const notTgz = classifyPluginPick(plain)
  assert.equal(notTgz.ok, false)
  if (!notTgz.ok) assert.match(notTgz.error, /source folder or a \.tgz plugin archive/)
  const garbage = join(fixture, 'garbage.tgz')
  writeFileSync(garbage, randomBytes(256))
  const bad = classifyPluginPick(garbage)
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error, /not a valid plugin archive/)
})
test('classifyPluginPick: an archive beyond TARBALL_MAX_ARCHIVE_BYTES is refused before any read', () => {
  const fixture = tempDir('plugin-tarball-')
  const oversized = join(fixture, 'huge.tgz')
  const fd = openSync(oversized, 'w')
  try {
    // Truncate to cap+1 — no 33 MiB allocation needed; stat is the gate.
    ftruncateSync(fd, TARBALL_MAX_ARCHIVE_BYTES + 1)
  } finally {
    closeSync(fd)
  }
  const pick = classifyPluginPick(oversized)
  assert.equal(pick.ok, false)
  if (!pick.ok) assert.match(pick.error, new RegExp(`beyond the ${TARBALL_MAX_ARCHIVE_BYTES}-byte plugin archive cap`))
})

// ---------------------------------------------------------------------------
// Archive identity binding (2026-12 audit): pnpm installs the manifest at
// `package/package.json`, so THAT identity is the one the protected-set
// judgement must see — never an archive-order-first decoy.
// ---------------------------------------------------------------------------

test('classifyPluginPick: a stray root package.json can never mask the installed package/package.json identity', async () => {
  const fixture = tempDir('plugin-tarball-')
  const archivePath = join(fixture, 'decoy.tgz')
  write(fixture, 'package.json', JSON.stringify({ name: '@dsh-chamber/taken-seed', version: '9.9.9' }))
  write(fixture, 'index.js', 'x')
  const built = await buildPluginTarball(fixture)
  assert.equal(built.manifest.ok, true)
  // Decoy FIRST in archive order: the retired reader returned the first
  // parseable candidate, i.e. this innocent third-party name — and the ssh /
  // local write faces judged the protected-set on THAT name.
  const decoy = prependRootManifestDecoy(built.buffer, { name: 'innocent-third-party', version: '1.0.0' })
  writeFileSync(archivePath, decoy)
  const pick = classifyPluginPick(archivePath)
  assert.equal(
    pick.ok,
    false,
    pick.ok ? `wrongly accepted as ${pick.source.kind === 'tgz' ? pick.source.name : pick.source.path}` : '',
  )
  if (!pick.ok) {
    assert.ok(pick.error.includes('innocent-third-party'), pick.error)
    assert.ok(pick.error.includes('@dsh-chamber/taken-seed'), pick.error)
  }
  // The bounded reader itself exposes BOTH names structurally.
  const inspection = inspectTgzManifest(readFileSync(archivePath))
  assert.equal(inspection.ok, false)
  if (!inspection.ok && inspection.reason === 'identity_mismatch') {
    assert.deepEqual(inspection.installed, { name: '@dsh-chamber/taken-seed', version: '9.9.9' })
    assert.deepEqual(inspection.declared, { name: 'innocent-third-party', version: '1.0.0' })
  } else {
    assert.fail(`expected identity_mismatch, got ${JSON.stringify(inspection)}`)
  }
})
test('classifyPluginPick: a root package.json alone is still the fallback identity (no installed-path manifest)', () => {
  const archivePath = join(tempDir('plugin-tarball-'), 'root-only.tgz')
  writeFileSync(archivePath, gzipSync(Buffer.concat([
    ustarEntry('package.json', JSON.stringify({ name: 'legacy-root-only', version: '0.1.0' })),
    Buffer.alloc(1024),
  ])))
  const pick = classifyPluginPick(archivePath)
  assert.equal(pick.ok, true, pick.ok ? '' : pick.error)
  if (pick.ok && pick.source.kind === 'tgz') {
    assert.equal(pick.source.name, 'legacy-root-only')
    assert.equal(pick.source.version, '0.1.0')
  }
})

// ---------------------------------------------------------------------------
// Textual lockstep against the gateway route literals (the desktop cannot
// import the gateway package — reading the SOURCE keeps the mirrors honest).
// ---------------------------------------------------------------------------

const gatewayRoutesSource = readFileSync(join(ROOT, 'packages', 'gateway', 'src', 'routes.ts'), 'utf8')
const gatewayTgzScanSource = readFileSync(join(ROOT, 'packages', 'gateway', 'src', 'tgz-scan.ts'), 'utf8')

test('TARBALL_MAX_ARCHIVE_BYTES stays locked to routes.ts MATERIALIZE_MAX_BYTES', () => {
  const match = /MATERIALIZE_MAX_BYTES = (\d+) \* 1024 \* 1024/.exec(gatewayRoutesSource)
  assert.ok(match !== null, 'routes.ts MATERIALIZE_MAX_BYTES literal not found')
  assert.equal(TARBALL_MAX_ARCHIVE_BYTES, Number(match[1]) * 1024 * 1024)
})
test('TARBALL_MAX_ENTRIES / TARBALL_MAX_UNPACKED_BYTES stay locked to tgz-scan.ts caps', () => {
  const entries = /export const TGZ_MAX_ENTRIES = (\d+)/.exec(gatewayTgzScanSource)
  assert.ok(entries !== null, 'tgz-scan.ts TGZ_MAX_ENTRIES literal not found')
  assert.equal(TARBALL_MAX_ENTRIES, Number(entries[1]))
  const bytes = /export const TGZ_MAX_UNPACKED_BYTES = (\d+) \* 1024 \* 1024/.exec(gatewayTgzScanSource)
  assert.ok(bytes !== null, 'tgz-scan.ts TGZ_MAX_UNPACKED_BYTES literal not found')
  assert.equal(TARBALL_MAX_UNPACKED_BYTES, Number(bytes[1]) * 1024 * 1024)
})
test('GATEWAY_PLUGIN_VERSION_PATTERN stays locked to routes.ts PLUGIN_VERSION_PATTERN', () => {
  const line = gatewayRoutesSource.split('\n').find(sourceLine => sourceLine.includes('PLUGIN_VERSION_PATTERN = /'))
  assert.ok(line !== undefined, 'routes.ts PLUGIN_VERSION_PATTERN literal not found')
  const open = line.indexOf('/')
  const close = line.lastIndexOf('/')
  assert.ok(open !== -1 && close > open, 'routes.ts PLUGIN_VERSION_PATTERN is not a /regex/ literal')
  const literal = line.slice(open + 1, close)
  assert.equal(new RegExp(literal).source, GATEWAY_PLUGIN_VERSION_PATTERN.source)
})
