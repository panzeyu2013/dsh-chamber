/**
 * Win32-only empirical decision gate for the eviction read-only handling
 * (design 21 M2a): does Node's `fs.rm` remove a FILE_ATTRIBUTE_READONLY tree
 * on Windows without an explicit attribute-clearing pass?
 *
 * The runtime installer hardens published trees read-only via
 * chmodSync(readOnlyMode) (runtime-installer.ts); on Windows that chmod maps
 * to the read-only attribute. If rm handles it (Node's rm retries EPERM after
 * clearing attributes on Windows), eviction needs no extra work — this test
 * passing on the Windows CI leg closes that item. If it throws EPERM, the
 * eviction/prune paths must clear attributes first and this test's
 * expectation flips after that implementation.
 *
 * Self-skips on POSIX: attribute semantics differ there (chmod 0o444 never
 * blocks an owner's unlink), so a POSIX run cannot decide the Windows
 * question.
 *
 * Run directly: node packages/dsh-runtime/test/win32-readonly-rm.integration.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test(
  'win32: fs.rm force removes a read-only-marked tree (eviction decision gate)',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ro-rm-'))
    const nested = join(root, 'nested')
    mkdirSync(nested, { recursive: true })
    const files = [join(root, 'a.js'), join(root, 'b.json'), join(nested, 'c.mjs')]
    for (const file of files) writeFileSync(file, 'x')
    try {
      // chmodSync on win32 maps 0o444 to FILE_ATTRIBUTE_READONLY (directories
      // included, mirroring the installer's tree-wide read-only hardening).
      chmodSync(root, 0o444)
      chmodSync(nested, 0o444)
      for (const file of files) chmodSync(file, 0o444)
      rmSync(root, { recursive: true, force: true })
      assert.equal(existsSync(root), false, 'read-only-marked tree removed')
    } catch (error) {
      // Decision gate result: if removal fails here, the eviction/prune paths
      // must clear FILE_ATTRIBUTE_READONLY before rm (design 21 M2a item) —
      // the failure IS the finding. Cleanup is best-effort (runner temp sweep
      // covers leftovers).
      try { chmodSync(root, 0o600) } catch { /* ignore */ }
      try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
      throw error
    }
  },
)
