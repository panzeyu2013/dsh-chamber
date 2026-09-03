/**
 * tgz-scan tests (design 21 §6.2 materialize upload caps; plan Phase 4.4):
 * the bounded incremental gunzip + ustar header scan — entry/name/size
 * accounting, PAX counting, the two cap refusals (≤ 4096 entries, ≤ 256 MiB
 * unpacked incl. padding), end-marker early exit and the corrupt family
 * (bad gzip magic, broken gzip streams, truncated tars).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  scanTgzMetadata,
  TGZ_MAX_ENTRIES,
  TGZ_MAX_UNPACKED_BYTES,
} from '../src/tgz-scan.ts'
import { buildTar, buildTgz } from './tgz-fixtures.ts'

test('scan: not gzip (plain bytes / empty buffer) → not_gzip', async () => {
  assert.deepEqual(await scanTgzMetadata(Buffer.from('plain text, not gzip')), { ok: false, error: 'not_gzip' })
  assert.deepEqual(await scanTgzMetadata(Buffer.alloc(0)), { ok: false, error: 'not_gzip' })
})

test('scan: broken gzip stream (magic present, deflate truncated) → corrupt', async () => {
  const whole = gzipSync(Buffer.from('x'.repeat(4096)))
  const truncated = whole.subarray(0, 16)
  assert.equal(truncated[0], 0x1f)
  assert.equal(truncated[1], 0x8b)
  assert.deepEqual(await scanTgzMetadata(truncated), { ok: false, error: 'corrupt' })
})

test('scan: single file entry reports entries/name/padded footprint', async () => {
  const tgz = buildTgz([{ name: 'package/package.json', data: '{"name":"a"}' }])
  const result = await scanTgzMetadata(tgz)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.entries, 1)
    assert.deepEqual(result.firstNames, ['package/package.json'])
    // 512 header + one padded 512 data block.
    assert.equal(result.totalBytes, 1024)
  }
})

test('scan: NUL-terminated names, multiple entries and cross-entry sizes add up', async () => {
  const tgz = buildTgz([
    { name: 'dir/', typeflag: '5' },
    { name: 'dir/a.js', data: 'x'.repeat(700) }, // two padded blocks
    { name: 'dir/b.js', data: '' },
  ])
  const result = await scanTgzMetadata(tgz)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.entries, 3)
    assert.deepEqual(result.firstNames, ['dir/', 'dir/a.js', 'dir/b.js'])
    // dir: header only (1024 total with size 0? no: 512 header + 0) — every
    // entry contributes 512 header + padded data.
    assert.equal(result.totalBytes, 512 * 3 + 512 * 2)
  }
})

test('scan: PAX x entries count against the caps and their sizes add in (conservative)', async () => {
  const tgz = buildTgz([
    { name: 'PaxHeaders.0/pkg', typeflag: 'x', data: 'comment="c"\n'.padEnd(140) },
    { name: 'pkg/index.js', data: 'x'.repeat(80) },
  ])
  const result = await scanTgzMetadata(tgz)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.entries, 2)
    assert.equal(result.firstNames.length, 2)
    // 2 headers (1024) + 140→padded 512 + 80→padded 512.
    assert.equal(result.totalBytes, 1024 + 512 + 512)
  }
})

test('scan: declared size beyond the unpacked cap trips too_large before the data exists', async () => {
  const tgz = buildTgz(
    [{ name: 'big.bin', declaredSize: TGZ_MAX_UNPACKED_BYTES + 1 }],
    { padDeclared: false },
  )
  assert.deepEqual(await scanTgzMetadata(tgz), { ok: false, error: 'too_large' })
})

test('scan: entry count beyond the cap trips too_many_entries', async () => {
  const entries = Array.from({ length: TGZ_MAX_ENTRIES + 1 }, (_unused, index) => ({
    name: `f-${index}.js`,
    data: '',
  }))
  const tgz = buildTgz(entries, { padDeclared: false })
  assert.deepEqual(await scanTgzMetadata(tgz), { ok: false, error: 'too_many_entries' })
})

test('scan: exactly at the entry cap is accepted (4096 headers, no data)', async () => {
  const entries = Array.from({ length: TGZ_MAX_ENTRIES }, (_unused, index) => ({
    name: `f-${index}.js`,
    data: '',
  }))
  const tgz = buildTgz(entries, { padDeclared: false })
  const result = await scanTgzMetadata(tgz)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.entries, TGZ_MAX_ENTRIES)
    assert.equal(result.firstNames.length, 32, 'firstNames echo is bounded')
  }
})

test('scan: gzip of non-tar garbage → corrupt (truncated header at stream end)', async () => {
  assert.deepEqual(await scanTgzMetadata(gzipSync(Buffer.from('just some words, not a tar'))), { ok: false, error: 'corrupt' })
})

test('scan: truncated tar inside a complete gzip (header or data cut) → corrupt', async () => {
  const full = buildTar([{ name: 'package/package.json', data: '{"name":"a"}' }])
  const cutHeader = gzipSync(full.subarray(0, 400)) // mid-header
  assert.deepEqual(await scanTgzMetadata(cutHeader), { ok: false, error: 'corrupt' })

  const bigger = buildTar([{ name: 'package/data.bin', data: 'x'.repeat(3000) }])
  const cutData = gzipSync(bigger.subarray(0, 512 + 900)) // mid-data
  assert.deepEqual(await scanTgzMetadata(cutData), { ok: false, error: 'corrupt' })
})

test('scan: end marker stops the scan early (trailing garbage after the zero blocks is ignored)', async () => {
  const tgz = buildTgz([{ name: 'a.js', data: 'x' }])
  // Append a second gzip member's worth of garbage — the first member ends
  // at the zero blocks; the scan must resolve before touching it.
  const multi = Buffer.concat([tgz, gzipSync(Buffer.from('second member garbage'))])
  const result = await scanTgzMetadata(multi)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.entries, 1)
    assert.equal(result.totalBytes, 1024)
  }
})
