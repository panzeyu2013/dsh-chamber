/**
 * plugin-tarball unit tests (design 21 §6.5, plan Phase 4.6): the desktop
 * plugin-source tarball builder + bounded tgz manifest reader — archive
 * layout (npm-pack `package/` root, dirs before files, normalized modes),
 * honest skips (symlinks, node_modules/.git), cap errors with machine codes
 * (entries / unpacked footprint / final archive size), the package.json
 * manifest projection (name + strict x-plugin-version grammar +
 * reserved-domain deny), the gzip roundtrip through listTgzManifest, and
 * the TEXTUAL LOCKSTEP tests pinning every cap + the version grammar to the
 * gateway route's own literals (routes.ts MATERIALIZE_MAX_BYTES /
 * PLUGIN_VERSION_PATTERN, tgz-scan.ts TGZ_MAX_ENTRIES /
 * TGZ_MAX_UNPACKED_BYTES) so the desktop archive can never drift past what
 * the upload route accepts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  buildPluginTarball,
  GATEWAY_PLUGIN_VERSION_PATTERN,
  listTgzManifest,
  PLUGIN_MANIFEST_MAX_BYTES,
  pluginNameFromFolder,
  TARBALL_MAX_ARCHIVE_BYTES,
  TARBALL_MAX_ENTRIES,
  TARBALL_MAX_UNPACKED_BYTES,
} from './plugin-tarball.ts'

const ROOT = join(dirname(import.meta.dirname), '..')

interface FixtureFolder {
  path: string
  cleanup(): void
}

function makeFolder(): FixtureFolder {
  const path = mkdtempSync(join(tmpdir(), 'plugin-tarball-'))
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  }
}

function write(root: string, relative: string, content: string | Buffer): void {
  const full = join(root, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** A tiny ustar header walker (test-side only) so mode/type assertions are
 *  against the actual archive bytes. */
function tarHeaderEntries(tar: Buffer): Array<{ name: string; mode: number; typeflag: string }> {
  const entries: Array<{ name: string; mode: number; typeflag: string }> = []
  let offset = 0
  for (;;) {
    assert.ok(offset + 512 <= tar.length, 'unexpectedly truncated tar')
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const nameNul = header.indexOf(0, 0)
    const name = header.subarray(0, nameNul === -1 ? 100 : nameNul).toString('utf8')
    const mode = parseInt(header.subarray(100, 107).toString('ascii').replace(/[^\d]/g, ''), 8)
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/u, '')
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8)
    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    entries.push({ name, mode, typeflag })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function gzipBytes(archive: Buffer): Buffer {
  return gunzipSync(archive)
}

test('buildPluginTarball packs a folder in the npm-pack layout with normalized modes and a valid manifest', async () => {
  const fixture = makeFolder()
  try {
    write(fixture.path, 'package.json', JSON.stringify({ name: 'my-test-plugin', version: '1.2.3' }))
    write(fixture.path, 'lib/index.js', 'export const x = 1\n')
    write(fixture.path, 'assets/data.txt', 'payload')
    mkdirSync(join(fixture.path, 'docs', 'empty'), { recursive: true })
    const result = await buildPluginTarball(fixture.path)
    assert.deepEqual(result.manifest, { ok: true, name: 'my-test-plugin', version: '1.2.3' })
    assert.deepEqual(result.entries, [
      'package/',
      'package/assets/',
      'package/assets/data.txt',
      'package/docs/',
      'package/docs/empty/',
      'package/lib/',
      'package/lib/index.js',
      'package/package.json',
    ])
    assert.deepEqual(result.skipped, [])
    // gzip magic + valid gzip stream.
    assert.equal(result.buffer[0], 0x1f)
    assert.equal(result.buffer[1], 0x8b)
    const entries = tarHeaderEntries(gzipBytes(result.buffer))
    const modes = new Map(entries.map(entry => [entry.name, entry.mode]))
    assert.equal(modes.get('package/package.json'), 0o644)
    assert.equal(modes.get('package/lib/index.js'), 0o644)
    assert.equal(modes.get('package/'), 0o755)
    assert.equal(modes.get('package/docs/empty/'), 0o755)
    assert.equal(entries.find(entry => entry.name === 'package/')?.typeflag, '5')
    assert.equal(entries.find(entry => entry.name === 'package/lib/index.js')?.typeflag, '0')
  } finally {
    fixture.cleanup()
  }
})

test('buildPluginTarball: the gzip archive roundtrips through listTgzManifest', async () => {
  const fixture = makeFolder()
  try {
    write(fixture.path, 'package.json', JSON.stringify({ name: '@scope/dsh-plugin-x', version: '2.0.0-beta.1+build.5' }))
    const result = await buildPluginTarball(fixture.path)
    assert.deepEqual(listTgzManifest(result.buffer), { name: '@scope/dsh-plugin-x', version: '2.0.0-beta.1+build.5' })
  } finally {
    fixture.cleanup()
  }
})

test('listTgzManifest returns null for garbage, non-gzip and manifest-less archives — never a guess', async () => {
  assert.equal(listTgzManifest(Buffer.from('not a tarball at all')), null)
  assert.equal(listTgzManifest(Buffer.from([0x1f, 0x8b, 0x00, 0x01])), null)
  const emptyDir = makeFolder()
  try {
    mkdirSync(join(emptyDir.path, 'lib'), { recursive: true })
    const result = await buildPluginTarball(emptyDir.path)
    assert.equal(result.manifest.ok, false, 'a folder without package.json has no manifest')
    assert.equal(listTgzManifest(result.buffer), null, 'an archive without package.json has no manifest')
    assert.deepEqual(result.entries, ['package/', 'package/lib/'])
  } finally {
    emptyDir.cleanup()
  }
})

test('buildPluginTarball skips symlinks and node_modules/.git subtrees with honest notes', async () => {
  const fixture = makeFolder()
  try {
    write(fixture.path, 'package.json', JSON.stringify({ name: 'skips', version: '1.0.0' }))
    write(fixture.path, 'real.js', 'x')
    symlinkSync(join(fixture.path, 'real.js'), join(fixture.path, 'link.js'))
    write(fixture.path, 'node_modules/dep/index.js', 'nested install tree')
    write(fixture.path, '.git/config', '[core]')
    mkdirSync(join(fixture.path, 'src', '.git'), { recursive: true })
    write(fixture.path, 'src/.git/HEAD', 'ref: refs/heads/main')
    const result = await buildPluginTarball(fixture.path)
    assert.ok(!result.entries.some(name => name.includes('link.js') || name.includes('node_modules') || name.includes('.git')),
      `archive must not contain skipped paths: ${result.entries.join(', ')}`)
    assert.deepEqual(result.skipped, [
      'package/.git/ (.git excluded)',
      'package/node_modules/ (node_modules excluded)',
      'package/src/.git/ (.git excluded)',
      'package/link.js (symbolic link, not packed)',
    ])
  } finally {
    fixture.cleanup()
  }
})

test('buildPluginTarball: a symlinked package.json can never contradict the upload headers', async () => {
  const fixture = makeFolder()
  try {
    write(fixture.path, 'real-manifest.json', JSON.stringify({ name: 'sym-pkg', version: '1.0.0' }))
    symlinkSync(join(fixture.path, 'real-manifest.json'), join(fixture.path, 'package.json'))
    await assert.rejects(buildPluginTarball(fixture.path), (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'folder_changed')
      return true
    })
  } finally {
    fixture.cleanup()
  }
})

test('buildPluginTarball: a relative entry path beyond 100 bytes is an honest path_too_long error', async () => {
  const fixture = makeFolder()
  try {
    const deep = `dir/${'segment'.repeat(14)}/file.js` // > 100 bytes relative
    write(fixture.path, deep, 'x')
    write(fixture.path, 'package.json', JSON.stringify({ name: 'deep-pkg', version: '1.0.0' }))
    await assert.rejects(buildPluginTarball(fixture.path), (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'path_too_long')
      assert.match((error as Error).message, /100-byte ustar/)
      return true
    })
  } finally {
    fixture.cleanup()
  }
})

test('buildPluginTarball: injected entry-cap and unpacked-byte limits error with the mirror codes', async () => {
  const many = makeFolder()
  try {
    for (let index = 0; index < 10; index += 1) write(many.path, `f${index}.js`, 'x')
    write(many.path, 'package.json', JSON.stringify({ name: 'cap-pkg', version: '1.0.0' }))
    await assert.rejects(
      buildPluginTarball(many.path, { limits: { maxEntries: 4 } }),
      (error: unknown) => (error as Error & { code?: string }).code === 'too_many_entries',
    )
  } finally {
    many.cleanup()
  }

  const big = makeFolder()
  try {
    write(big.path, 'big.bin', Buffer.alloc(2000, 7))
    write(big.path, 'package.json', JSON.stringify({ name: 'cap-pkg', version: '1.0.0' }))
    await assert.rejects(
      buildPluginTarball(big.path, { limits: { maxUnpackedBytes: 1000 } }),
      (error: unknown) => (error as Error & { code?: string }).code === 'too_large',
    )
  } finally {
    big.cleanup()
  }

  const gz = makeFolder()
  try {
    // True-random content so gzip cannot shrink it under the archive cap.
    write(gz.path, 'blob.bin', randomBytes(8192))
    write(gz.path, 'package.json', JSON.stringify({ name: 'cap-pkg', version: '1.0.0' }))
    await assert.rejects(
      buildPluginTarball(gz.path, { limits: { maxArchiveBytes: 1024 } }),
      (error: unknown) => (error as Error & { code?: string }).code === 'archive_too_large',
    )
  } finally {
    gz.cleanup()
  }
})

test('buildPluginTarball: non-directory and missing paths are loud errors', async () => {
  const fixture = makeFolder()
  try {
    const file = join(fixture.path, 'plain.txt')
    writeFileSync(file, 'x')
    await assert.rejects(buildPluginTarball(file), (error: unknown) => (error as Error & { code?: string }).code === 'not_a_directory')
    await assert.rejects(buildPluginTarball(join(fixture.path, 'nope')), (error: unknown) => (error as Error & { code?: string }).code === 'unreadable')
  } finally {
    fixture.cleanup()
  }
})

test('buildPluginTarball manifest validation: name/version whitelists + reserved-domain deny + JSON honesty', async () => {
  const manifestTests: Array<{ pkg: unknown; manifestName: string | null; nameOnly: string | null; errorMatch: RegExp }> = [
    { pkg: { name: 'ok-pkg', version: '1.0.0' }, manifestName: 'ok-pkg', nameOnly: 'ok-pkg', errorMatch: /$/ },
    { pkg: { name: '@dsh-chamber/taken', version: '1.0.0' }, manifestName: null, nameOnly: '@dsh-chamber/taken', errorMatch: /reserved domain/ },
    { pkg: { name: '@deepseek-ai/taken', version: '1.0.0' }, manifestName: null, nameOnly: '@deepseek-ai/taken', errorMatch: /reserved domain/ },
    { pkg: { name: 'bad name!', version: '1.0.0' }, manifestName: null, nameOnly: null, errorMatch: /not a safe registry package name/ },
    { pkg: { name: 'ok-pkg', version: 'v1.0.0' }, manifestName: null, nameOnly: 'ok-pkg', errorMatch: /not an exact semver/ },
    { pkg: { name: 'ok-pkg' }, manifestName: null, nameOnly: 'ok-pkg', errorMatch: /not an exact semver/ },
    { pkg: 'not an object', manifestName: null, nameOnly: null, errorMatch: /not valid JSON/ },
    { pkg: '{broken json', manifestName: null, nameOnly: null, errorMatch: /not valid JSON/ },
  ]
  for (const entry of manifestTests) {
    const fixture = makeFolder()
    try {
      write(fixture.path, 'package.json', typeof entry.pkg === 'string' ? entry.pkg : JSON.stringify(entry.pkg))
      write(fixture.path, 'index.js', 'x')
      const result = await buildPluginTarball(fixture.path)
      assert.equal(result.manifest.ok, entry.manifestName !== null)
      if (entry.manifestName !== null && result.manifest.ok) assert.equal(result.manifest.name, entry.manifestName)
      if (!result.manifest.ok) assert.match(result.manifest.error, entry.errorMatch)
      // pluginNameFromFolder is the NAME-ONLY read (plan §6.5): the
      // reserved-domain deny is full-manifest validation, not name-only.
      assert.equal(pluginNameFromFolder(fixture.path), entry.nameOnly)
    } finally {
      fixture.cleanup()
    }
  }
})

test('pluginNameFromFolder: an oversized package.json is refused, a plain-name read succeeds', async () => {
  const fixture = makeFolder()
  try {
    const path = join(fixture.path, 'package.json')
    writeFileSync(path, `{"name":"x","version":"1.0.0"}`.padEnd(PLUGIN_MANIFEST_MAX_BYTES + 10, ' '))
    assert.equal(pluginNameFromFolder(fixture.path), null, 'the 64 KiB read bound must hold')
    writeFileSync(path, JSON.stringify({ name: 'plain-name', version: '0.0.1' }))
    assert.equal(pluginNameFromFolder(fixture.path), 'plain-name')
  } finally {
    fixture.cleanup()
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
