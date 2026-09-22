/**
 * Cross-package parity/lockstep gate for the owner-private no-follow filesystem
 * primitives.
 *
 * packages/control-plane/src/private-file.ts and
 * packages/dsh-runtime/src/private-fs.ts are maintained as twins: the gateway
 * state store consumes the
 * dsh-runtime copy, while the control-plane JSON store and the desktop
 * credential facade consume the control-plane copy. This file runs the SAME
 * scenario matrix against both copies and asserts the observable semantics
 * agree; every intentional divergence is registered in DIVERGENCES so it can
 * never drift silently, and the export-surface locks below force a register
 * update whenever either twin grows or loses a counterpart.
 *
 * The comparison normalizes the two published shapes (control-plane throws and
 * uses the native ENOENT for absence; dsh-runtime returns a
 * missing/unsafe/valid discriminated union) into one Outcome status, and
 * asserts on-disk post-conditions (content, permission mode, temp residue,
 * symlink target untouched) independently on each side.
 *
 * Run directly: node packages/control-plane/test/protocol/private-fs-parity.test.ts
 *
 * Platform: POSIX-only scenarios (permission modes, symlink/hard-link
 * adversarial shapes) are skipped on win32 with an explicit note; the shared
 * portable scenarios run everywhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as cp from '../../src/private-file.ts'
import * as rt from '../../../dsh-runtime/src/private-fs.ts'

const POSIX = process.platform !== 'win32'
const POSIX_ONLY: false | string = POSIX ? false : 'POSIX-only semantics (mode bits / symlink / hard link)'

type Status = 'ok' | 'missing' | 'refused' | 'contended'

interface Outcome {
  status: Status
  /** Leaf path whose on-disk state is compared for 'ok' outcomes. */
  path: string
  /** Observed text for read/write scenarios. */
  text?: string
}

function ok(path: string, text?: string): Outcome {
  return text === undefined ? { status: 'ok', path } : { status: 'ok', path, text }
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return undefined
  }
}

function failure(error: unknown): Status {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return 'missing'
  if (code === 'EEXIST') return 'contended'
  return 'refused'
}

/** Run one control-plane-side operation, mapping its throw-based outcome. */
function cpRun(fn: () => string | void, path: string): Outcome {
  try {
    const text = fn()
    return text === undefined ? ok(path) : ok(path, text)
  } catch (error) {
    return { status: failure(error), path }
  }
}

/** Run one dsh-runtime-side operation, mapping its union/throw-based outcome. */
function rtRun(fn: () => string | void, path: string): Outcome {
  try {
    const text = fn()
    return text === undefined ? ok(path) : ok(path, text)
  } catch (error) {
    return { status: failure(error), path }
  }
}

/** A path under the dsh-runtime owned root (<root>/dsh-runtime/<name>). */
function rtLeaf(root: string, name: string): string {
  const base = join(root, 'dsh-runtime')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  return join(base, name)
}

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

function writePrivateFile(path: string, text: string, mode: number): void {
  writeFileSync(path, text, { mode })
  chmodSync(path, mode)
}

/** Assert no leftover temp leaf for this destination (other fixtures may share the directory). */
function assertNoTempResidue(path: string): void {
  const residue = readdirSync(dirname(path)).filter(entry => entry.startsWith('.' + basename(path) + '.tmp-'))
  assert.deepEqual(residue, [], 'temp residue for ' + basename(path))
}

/**
 * Every intentional divergence between the two twins. A scenario marked with
 * one of these ids asserts the divergence explicitly; a scenario matrix that
 * stops covering an entry - or covers an unregistered one - fails below.
 */
const DIVERGENCES = {
  'dir-ancestor-auto-create': {
    note: 'control-plane ensurePrivateDirectoryNoFollow mkdirs missing ancestors recursively; dsh-runtime requires an existing real parent and reports the absent parent as ENOENT (normalized to missing).',
    assert: (a: Outcome, b: Outcome): void => {
      assert.equal(a.status, 'ok', 'control-plane creates the ancestor chain')
      assert.equal(b.status, 'missing', 'dsh-runtime never creates the missing parent chain')
      assert.equal(modeOf(b.path), undefined, 'the dsh-runtime leaf must not exist')
    },
  },
  'dir-mode-require': {
    note: 'existingMode:require is a control-plane-only fail-closed policy; dsh-runtime has no equivalent and tightens by default.',
    assert: (a: Outcome, b: Outcome): void => {
      assert.equal(a.status, 'refused', 'control-plane require refuses a wrong mode')
      assert.equal(b.status, 'ok', 'dsh-runtime tightens instead of refusing')
      assert.equal(modeOf(b.path), 0o700)
    },
  },
  'dir-mode-preserve': {
    note: 'existingMode:preserve keeps an existing loose directory untouched in control-plane; dsh-runtime always tightens to 0700.',
    assert: (a: Outcome, b: Outcome): void => {
      assert.equal(a.status, 'ok')
      assert.equal(b.status, 'ok')
      assert.equal(modeOf(a.path), 0o755, 'control-plane preserve leaves the mode alone')
      assert.equal(modeOf(b.path), 0o700, 'dsh-runtime tightens the existing directory')
    },
  },
  'read-default-tighten-policy': {
    note: 'control-plane read tightens only on an explicit tightenMode; dsh-runtime read tightens to 0600 by default (tightenMode !== false).',
    assert: (a: Outcome, b: Outcome): void => {
      assert.equal(a.status, 'ok')
      assert.equal(b.status, 'ok')
      assert.equal(a.text, b.text)
      assert.equal(modeOf(a.path), 0o644, 'control-plane default read does not change the mode')
      assert.equal(modeOf(b.path), 0o600, 'dsh-runtime default read tightens to 0600')
    },
  },
  'read-result-shape': {
    note: 'control-plane reports absence by throwing the native ENOENT; dsh-runtime returns {kind:missing}. Semantics are the same (absence), the published shape is not.',
    assert: (a: Outcome, b: Outcome): void => {
      assert.equal(a.status, 'missing')
      assert.equal(b.status, 'missing')
    },
  },
  'atomic-write-default-mode': {
    note: 'control-plane atomic write without an explicit mode follows open(2) (0666 filtered by umask); dsh-runtime always publishes 0600.',
    assert: (a: Outcome, b: Outcome): void => {
      assert.equal(a.status, 'ok')
      assert.equal(b.status, 'ok')
      assert.equal(modeOf(b.path), 0o600)
      assert.equal(modeOf(a.path), 0o666 & ~process.umask(), 'control-plane follows the umask-filtered default')
    },
  },
} as const

type DivergenceId = keyof typeof DIVERGENCES

interface Scenario {
  name: string
  posixOnly?: boolean
  cp: (root: string) => Outcome
  rt: (root: string) => Outcome
  divergence?: DivergenceId
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'ensure directory: create a fresh leaf (0700 on POSIX)',
    cp: root => cpRun(() => cp.ensurePrivateDirectoryNoFollow(join(root, 'state')), join(root, 'state')),
    rt: root => rtRun(() => rt.ensurePrivateDirectoryNoFollow(rtLeaf(root, 'state')), rtLeaf(root, 'state')),
  },
  {
    name: 'ensure directory: an existing loose directory is tightened',
    cp: root => {
      const path = join(root, 'state')
      mkdirSync(path, { mode: 0o755 })
      chmodSync(path, 0o755)
      return cpRun(() => cp.ensurePrivateDirectoryNoFollow(path), path)
    },
    rt: root => {
      const path = rtLeaf(root, 'state')
      mkdirSync(path, { mode: 0o755 })
      chmodSync(path, 0o755)
      return rtRun(() => rt.ensurePrivateDirectoryNoFollow(path), path)
    },
  },
  {
    name: 'ensure directory: a symlinked final component is refused and never adopted',
    posixOnly: true,
    cp: root => {
      const real = join(root, 'real')
      mkdirSync(real, { mode: 0o700 })
      chmodSync(real, 0o700)
      const link = join(root, 'state')
      symlinkSync(real, link, 'dir')
      const outcome = cpRun(() => cp.ensurePrivateDirectoryNoFollow(link), link)
      assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink must survive the refusal')
      assert.equal(modeOf(real), 0o700, 'the link target must not be chmod-ed through the link')
      return outcome
    },
    rt: root => {
      const base = join(root, 'dsh-runtime')
      const real = join(root, 'real')
      mkdirSync(base, { recursive: true, mode: 0o700 })
      mkdirSync(real, { mode: 0o700 })
      chmodSync(real, 0o700)
      const link = join(base, 'state')
      symlinkSync(real, link, 'dir')
      const outcome = rtRun(() => rt.ensurePrivateDirectoryNoFollow(link), link)
      assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink must survive the refusal')
      assert.equal(modeOf(real), 0o700, 'the link target must not be chmod-ed through the link')
      return outcome
    },
  },
  {
    name: 'ensure directory: a regular-file leaf is refused and left intact',
    cp: root => {
      const path = join(root, 'state')
      writeFileSync(path, 'keep')
      const outcome = cpRun(() => cp.ensurePrivateDirectoryNoFollow(path), path)
      assert.equal(readText(path), 'keep')
      return outcome
    },
    rt: root => {
      const path = rtLeaf(root, 'state')
      writeFileSync(path, 'keep')
      const outcome = rtRun(() => rt.ensurePrivateDirectoryNoFollow(path), path)
      assert.equal(readText(path), 'keep')
      return outcome
    },
  },
  {
    name: 'read: a missing leaf is absence (never a fake empty document)',
    cp: root => cpRun(() => cp.readPrivateFileNoFollow(join(root, 'data.json')).value, join(root, 'data.json')),
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      return rtRun(() => {
        const outcome = rt.readPrivateFileNoFollow(path, 4096)
        if (outcome.kind === 'valid') return outcome.raw
        throw Object.assign(new Error('not valid'), { code: outcome.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'read: a valid 0600 leaf returns identical text',
    cp: root => {
      const path = join(root, 'data.json')
      writePrivateFile(path, '{"v":1}', 0o600)
      return cpRun(() => cp.readPrivateFileNoFollow(path).value, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      writePrivateFile(path, '{"v":1}', 0o600)
      return rtRun(() => {
        const outcome = rt.readPrivateFileNoFollow(path, 4096)
        if (outcome.kind === 'valid') return outcome.raw
        throw Object.assign(new Error('not valid'), { code: outcome.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'read: a symlinked leaf is refused and the target is never read or rewritten',
    posixOnly: true,
    cp: root => {
      const target = join(root, 'target.json')
      const link = join(root, 'data.json')
      writePrivateFile(target, 'secret', 0o600)
      symlinkSync(target, link)
      const outcome = cpRun(() => cp.readPrivateFileNoFollow(link).value, link)
      assert.equal(readText(target), 'secret')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      return outcome
    },
    rt: root => {
      const target = join(root, 'target.json')
      const link = rtLeaf(root, 'data.json')
      writePrivateFile(target, 'secret', 0o600)
      symlinkSync(target, link)
      const outcome = rtRun(() => {
        const result = rt.readPrivateFileNoFollow(link, 4096)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, link)
      assert.equal(readText(target), 'secret')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      return outcome
    },
  },
  {
    name: 'read: a hard-linked leaf (nlink > 1) is refused',
    posixOnly: true,
    cp: root => {
      const path = join(root, 'data.json')
      writePrivateFile(path, 'multi', 0o600)
      linkSync(path, join(root, 'other-link'))
      return cpRun(() => cp.readPrivateFileNoFollow(path).value, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      writePrivateFile(path, 'multi', 0o600)
      linkSync(path, join(root, 'other-link'))
      return rtRun(() => {
        const result = rt.readPrivateFileNoFollow(path, 4096)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'read: a directory leaf is refused as unsafe',
    cp: root => {
      const path = join(root, 'data.json')
      mkdirSync(path)
      return cpRun(() => cp.readPrivateFileNoFollow(path).value, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      mkdirSync(path)
      return rtRun(() => {
        const result = rt.readPrivateFileNoFollow(path, 4096)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'read: a leaf over the read bound is refused by both',
    cp: root => {
      const path = join(root, 'data.json')
      writePrivateFile(path, '0123456789', 0o600)
      return cpRun(() => cp.readPrivateFileNoFollow(path, { maxBytes: 4 }).value, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      writePrivateFile(path, '0123456789', 0o600)
      return rtRun(() => {
        const result = rt.readPrivateFileNoFollow(path, 4)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'read: a loose 0644 leaf is tightened under each side explicit/default policy',
    cp: root => {
      const path = join(root, 'data.json')
      writePrivateFile(path, 'tight', 0o644)
      return cpRun(() => cp.readPrivateFileNoFollow(path, { tightenMode: 0o600 }).value, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      writePrivateFile(path, 'tight', 0o644)
      return rtRun(() => {
        const result = rt.readPrivateFileNoFollow(path, 4096)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'read: a symlinked parent directory is refused',
    posixOnly: true,
    cp: root => {
      const real = join(root, 'real')
      mkdirSync(real, { mode: 0o700 })
      const parent = join(root, 'parent')
      symlinkSync(real, parent, 'dir')
      return cpRun(() => cp.readPrivateFileNoFollow(join(parent, 'data.json')).value, join(parent, 'data.json'))
    },
    rt: root => {
      const base = join(root, 'dsh-runtime')
      const real = join(base, 'real')
      mkdirSync(base, { recursive: true, mode: 0o700 })
      mkdirSync(real, { mode: 0o700 })
      const parent = join(base, 'parent')
      symlinkSync(real, parent, 'dir')
      return rtRun(() => {
        const result = rt.readPrivateFileNoFollow(join(parent, 'data.json'), 4096)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, join(parent, 'data.json'))
    },
  },
  {
    name: 'atomic write: replaces/creates the leaf with no temp residue',
    cp: root => {
      const path = join(root, 'state.json')
      return cpRun(() => {
        cp.atomicWritePrivateFileNoFollow(path, 'v1', { mode: 0o600 })
        assertNoTempResidue(path)
        return readText(path)
      }, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'state.json')
      return rtRun(() => {
        rt.atomicWriteRuntimeFileNoFollow(root, path, 'v1')
        assertNoTempResidue(path)
        return readText(path)
      }, path)
    },
  },
  {
    name: 'atomic write: overwrites an existing loose leaf atomically',
    cp: root => {
      const path = join(root, 'state.json')
      writePrivateFile(path, 'old', 0o644)
      return cpRun(() => {
        cp.atomicWritePrivateFileNoFollow(path, 'new', { mode: 0o600 })
        assertNoTempResidue(path)
        return readText(path)
      }, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'state.json')
      writePrivateFile(path, 'old', 0o644)
      return rtRun(() => {
        rt.atomicWriteRuntimeFileNoFollow(root, path, 'new')
        assertNoTempResidue(path)
        return readText(path)
      }, path)
    },
  },
  {
    name: 'atomic write: a symlinked destination is refused and the target kept',
    posixOnly: true,
    cp: root => {
      const target = join(root, 'target.json')
      const link = join(root, 'state.json')
      writePrivateFile(target, 'keep', 0o600)
      symlinkSync(target, link)
      const outcome = cpRun(() => cp.atomicWritePrivateFileNoFollow(link, 'new', { mode: 0o600 }), link)
      assert.equal(readText(target), 'keep')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assertNoTempResidue(link)
      return outcome
    },
    rt: root => {
      const target = join(root, 'target.json')
      const link = rtLeaf(root, 'state.json')
      writePrivateFile(target, 'keep', 0o600)
      symlinkSync(target, link)
      const outcome = rtRun(() => rt.atomicWriteRuntimeFileNoFollow(root, link, 'new'), link)
      assert.equal(readText(target), 'keep')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assertNoTempResidue(link)
      return outcome
    },
  },
  {
    name: 'exclusive create: publishes the leaf exactly once',
    cp: root => {
      const path = join(root, 'fresh.json')
      return cpRun(() => {
        cp.createPrivateFileExclusiveNoFollow(path, 'first', { mode: 0o600 })
        return readText(path)
      }, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'fresh.json')
      return rtRun(() => {
        rt.createRuntimeFileExclusiveNoFollow(root, path, 'first')
        return readText(path)
      }, path)
    },
  },
  {
    name: 'exclusive create: an existing leaf is EEXIST contention, not a rewrite',
    cp: root => {
      const path = join(root, 'fresh.json')
      writePrivateFile(path, 'existing', 0o600)
      const outcome = cpRun(() => { cp.createPrivateFileExclusiveNoFollow(path, 'second', { mode: 0o600 }) }, path)
      assert.equal(readText(path), 'existing')
      return outcome
    },
    rt: root => {
      const path = rtLeaf(root, 'fresh.json')
      writePrivateFile(path, 'existing', 0o600)
      const outcome = rtRun(() => rt.createRuntimeFileExclusiveNoFollow(root, path, 'second'), path)
      assert.equal(readText(path), 'existing')
      return outcome
    },
  },
  {
    name: 'exclusive create: a symlinked leaf is EEXIST contention and the target is kept',
    posixOnly: true,
    cp: root => {
      const target = join(root, 'target.json')
      const link = join(root, 'fresh.json')
      writePrivateFile(target, 'keep', 0o600)
      symlinkSync(target, link)
      const outcome = cpRun(() => { cp.createPrivateFileExclusiveNoFollow(link, 'second', { mode: 0o600 }) }, link)
      assert.equal(readText(target), 'keep')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      return outcome
    },
    rt: root => {
      const target = join(root, 'target.json')
      const link = rtLeaf(root, 'fresh.json')
      writePrivateFile(target, 'keep', 0o600)
      symlinkSync(target, link)
      const outcome = rtRun(() => rt.createRuntimeFileExclusiveNoFollow(root, link, 'second'), link)
      assert.equal(readText(target), 'keep')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      return outcome
    },
  },
  {
    name: 'remove: deletes a verified leaf',
    cp: root => {
      const path = join(root, 'gone.json')
      writePrivateFile(path, 'x', 0o600)
      return cpRun(() => {
        cp.removePrivateFileNoFollow(path)
        assert.equal(modeOf(path), undefined, 'leaf must be gone')
      }, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'gone.json')
      writePrivateFile(path, 'x', 0o600)
      return rtRun(() => {
        rt.removeRuntimeFileNoFollow(root, path)
        assert.equal(modeOf(path), undefined, 'leaf must be gone')
      }, path)
    },
  },
  {
    name: 'remove: a missing leaf is an idempotent no-op',
    cp: root => cpRun(() => cp.removePrivateFileNoFollow(join(root, 'gone.json')), join(root, 'gone.json')),
    rt: root => rtRun(() => rt.removeRuntimeFileNoFollow(root, rtLeaf(root, 'gone.json')), rtLeaf(root, 'gone.json')),
  },
  {
    name: 'remove: a symlinked leaf is refused and left in place',
    posixOnly: true,
    cp: root => {
      const target = join(root, 'target.json')
      const link = join(root, 'gone.json')
      writePrivateFile(target, 'keep', 0o600)
      symlinkSync(target, link)
      const outcome = cpRun(() => cp.removePrivateFileNoFollow(link), link)
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assert.equal(readText(target), 'keep')
      return outcome
    },
    rt: root => {
      const target = join(root, 'target.json')
      const link = rtLeaf(root, 'gone.json')
      writePrivateFile(target, 'keep', 0o600)
      symlinkSync(target, link)
      const outcome = rtRun(() => rt.removeRuntimeFileNoFollow(root, link), link)
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assert.equal(readText(target), 'keep')
      return outcome
    },
  },
  {
    name: 'sync directory: a real directory commits on both sides',
    cp: root => cpRun(() => cp.syncPrivateDirectoryNoFollow(root), root),
    rt: root => rtRun(() => rt.syncPrivateDirectoryNoFollow(root), root),
  },
  {
    name: 'sync directory: a symlinked directory is refused by both',
    posixOnly: true,
    cp: root => {
      const real = join(root, 'real')
      mkdirSync(real, { mode: 0o700 })
      chmodSync(real, 0o700)
      const link = join(root, 'link')
      symlinkSync(real, link, 'dir')
      const outcome = cpRun(() => cp.syncPrivateDirectoryNoFollow(link), link)
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      return outcome
    },
    rt: root => {
      const base = join(root, 'dsh-runtime')
      mkdirSync(base, { recursive: true, mode: 0o700 })
      const real = join(base, 'real')
      mkdirSync(real, { mode: 0o700 })
      chmodSync(real, 0o700)
      const link = join(base, 'link')
      symlinkSync(real, link, 'dir')
      const outcome = rtRun(() => rt.syncPrivateDirectoryNoFollow(link), link)
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      return outcome
    },
  },
  {
    name: 'sync directory: a missing directory is absence on both sides',
    cp: root => cpRun(() => cp.syncPrivateDirectoryNoFollow(join(root, 'missing')), join(root, 'missing')),
    rt: root => {
      const base = join(root, 'dsh-runtime')
      mkdirSync(base, { recursive: true, mode: 0o700 })
      return rtRun(() => rt.syncPrivateDirectoryNoFollow(join(base, 'missing')), join(base, 'missing'))
    },
  },
  {
    name: 'DIVERGENCE: missing ancestors are auto-created only by control-plane',
    divergence: 'dir-ancestor-auto-create',
    cp: root => cpRun(() => cp.ensurePrivateDirectoryNoFollow(join(root, 'a', 'b', 'c')), join(root, 'a', 'b', 'c')),
    rt: root => {
      const base = join(root, 'dsh-runtime')
      mkdirSync(base, { recursive: true, mode: 0o700 })
      return rtRun(() => rt.ensurePrivateDirectoryNoFollow(join(base, 'a', 'b', 'c')), join(base, 'a', 'b', 'c'))
    },
  },
  {
    name: 'DIVERGENCE: existingMode=require refuses a wrong mode (control-plane only)',
    divergence: 'dir-mode-require',
    cp: root => {
      const path = join(root, 'state')
      mkdirSync(path, { mode: 0o755 })
      chmodSync(path, 0o755)
      return cpRun(() => cp.ensurePrivateDirectoryNoFollow(path, 0o700, { existingMode: 'require' }), path)
    },
    rt: root => {
      const path = rtLeaf(root, 'state')
      mkdirSync(path, { mode: 0o755 })
      chmodSync(path, 0o755)
      return rtRun(() => rt.ensurePrivateDirectoryNoFollow(path), path)
    },
  },
  {
    name: 'DIVERGENCE: existingMode=preserve leaves a loose directory untouched (control-plane only)',
    divergence: 'dir-mode-preserve',
    cp: root => {
      const path = join(root, 'state')
      mkdirSync(path, { mode: 0o755 })
      chmodSync(path, 0o755)
      return cpRun(() => cp.ensurePrivateDirectoryNoFollow(path, 0o700, { existingMode: 'preserve' }), path)
    },
    rt: root => {
      const path = rtLeaf(root, 'state')
      mkdirSync(path, { mode: 0o755 })
      chmodSync(path, 0o755)
      return rtRun(() => rt.ensurePrivateDirectoryNoFollow(path), path)
    },
  },
  {
    name: 'DIVERGENCE: default read tightening differs (explicit vs implicit)',
    divergence: 'read-default-tighten-policy',
    cp: root => {
      const path = join(root, 'data.json')
      writePrivateFile(path, 'loose', 0o644)
      return cpRun(() => cp.readPrivateFileNoFollow(path).value, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      writePrivateFile(path, 'loose', 0o644)
      return rtRun(() => {
        const result = rt.readPrivateFileNoFollow(path, 4096)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'DIVERGENCE: absence is a throw in control-plane and a union member in dsh-runtime',
    divergence: 'read-result-shape',
    cp: root => cpRun(() => cp.readPrivateFileNoFollow(join(root, 'missing.json')).value, join(root, 'missing.json')),
    rt: root => {
      const path = rtLeaf(root, 'data.json')
      return rtRun(() => {
        const result = rt.readPrivateFileNoFollow(path, 4096)
        if (result.kind === 'valid') return result.raw
        throw Object.assign(new Error('not valid'), { code: result.kind === 'missing' ? 'ENOENT' : 'EUNSAFE' })
      }, path)
    },
  },
  {
    name: 'DIVERGENCE: default atomic-write mode policy differs (umask vs 0600)',
    divergence: 'atomic-write-default-mode',
    cp: root => {
      const path = join(root, 'state.json')
      return cpRun(() => {
        cp.atomicWritePrivateFileNoFollow(path, 'v1')
        return readText(path)
      }, path)
    },
    rt: root => {
      const path = rtLeaf(root, 'state.json')
      return rtRun(() => {
        rt.atomicWriteRuntimeFileNoFollow(root, path, 'v1')
        return readText(path)
      }, path)
    },
  },
]

function assertScenario(scenario: Scenario, a: Outcome, b: Outcome): void {
  if (scenario.divergence !== undefined) {
    DIVERGENCES[scenario.divergence].assert(a, b)
    return
  }
  assert.equal(
    a.status,
    b.status,
    scenario.name + ': status parity (control-plane=' + a.status + ', dsh-runtime=' + b.status + ')',
  )
  if (a.status !== 'ok') return
  if (a.text !== undefined || b.text !== undefined) {
    assert.equal(a.text, b.text, scenario.name + ': text parity')
  }
  if (POSIX) {
    assert.equal(modeOf(a.path), modeOf(b.path), scenario.name + ': mode parity')
  }
}

for (const scenario of SCENARIOS) {
  test(scenario.name, { skip: scenario.posixOnly === true ? POSIX_ONLY : false }, () => {
    const cpRoot = mkdtempSync(join(tmpdir(), 'dsh-fs-parity-cp-'))
    const rtRoot = mkdtempSync(join(tmpdir(), 'dsh-fs-parity-rt-'))
    try {
      const a = scenario.cp(cpRoot)
      const b = scenario.rt(rtRoot)
      assertScenario(scenario, a, b)
    } finally {
      rmSync(cpRoot, { recursive: true, force: true })
      rmSync(rtRoot, { recursive: true, force: true })
    }
  })
}

test('the scenario matrix covers every registered divergence exactly once', () => {
  const counts = new Map<string, number>()
  for (const scenario of SCENARIOS) {
    if (scenario.divergence === undefined) continue
    counts.set(scenario.divergence, (counts.get(scenario.divergence) ?? 0) + 1)
  }
  for (const [, count] of counts) assert.equal(count, 1, 'a divergence must be covered by exactly one scenario')
  assert.deepEqual([...counts.keys()].sort(), Object.keys(DIVERGENCES).sort(),
    'the matrix and the divergence register must name the same ids')
})

test('the concrete shapes behind the read-result-shape divergence stay as registered', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fs-parity-shape-'))
  try {
    const cpPath = join(root, 'missing.json')
    assert.throws(
      () => cp.readPrivateFileNoFollow(cpPath),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      'control-plane keeps the native ENOENT for absence',
    )
    const rtPath = rtLeaf(root, 'missing.json')
    assert.deepEqual(rt.readPrivateFileNoFollow(rtPath, 4096), { kind: 'missing' },
      'dsh-runtime keeps the missing union member for absence')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * Export-surface lockstep. Both twins still carry their own names for the same
 * primitive; the moment either side adds, renames or drops a value export the
 * pair lists below no longer match and this test fails, forcing the register
 * (and the parity matrix) to be updated deliberately.
 */
test('the shared primitive surface and the one-sided extras are exactly as registered', () => {
  const shared = [
    ['ensurePrivateDirectoryNoFollow', 'ensurePrivateDirectoryNoFollow'],
    ['readPrivateFileNoFollow', 'readPrivateFileNoFollow'],
    ['atomicWritePrivateFileNoFollow', 'atomicWriteRuntimeFileNoFollow'],
    ['createPrivateFileExclusiveNoFollow', 'createRuntimeFileExclusiveNoFollow'],
    ['removePrivateFileNoFollow', 'removeRuntimeFileNoFollow'],
    // Both copies export the directory-sync primitive under the same name.
    ['syncPrivateDirectoryNoFollow', 'syncPrivateDirectoryNoFollow'],
  ] as const
  // append/leaf/rotation primitives sit on top of the parity-tested core;
  // dsh-runtime does not carry them, so they are control-plane extras —
  // registered here so the twin cannot grow a same-named copy without this
  // gate failing.
  const cpOnly = [
    'assertPrivateLeafStatNoFollow',
    'inspectPrivateLeafNoFollow',
    'noFollowOpenFlag',
    'openPrivateAppendNoFollow',
    'privateIdentityOf',
    'rotatePrivateFileRingNoFollow',
    'samePrivateIdentity',
    'writePrivateFdAll',
  ] as const
  const rtOnly = [
    'PRIVATE_RUNTIME_DIR_MODE',
    'PRIVATE_RUNTIME_FILE_MODE',
    'resolveNoFollowFlags',
    'openPrivateNoFollowSync',
    'createPrivateDirectoryNoFollow',
    'runtimeRootPath',
    'ensureRuntimeRootNoFollow',
    'assertRuntimeRootNoFollow',
    'ensureRuntimeSubdirectoryNoFollow',
    'quarantineRuntimeFileNoFollow',
    // dsh-runtime extras.
    'PrivateNoFollowOpenError',
    'classifyPrivateFileNoFollow',
    'openPrivateNoFollowReadAsync',
    'syncPrivateFileNoFollow',
    // Read-material classification (fail-closed runtime metadata): the
    // dsh-runtime side reads EACCES/EIO as its own state, so both new names
    // are registered here and must not grow a control-plane twin silently.
    'isUnreadableFsError',
    'readPrivateFileStateNoFollow',
  ] as const
  for (const [cpName, rtName] of shared) {
    assert.equal(typeof (cp as Record<string, unknown>)[cpName], 'function', 'control-plane export ' + cpName)
    assert.equal(typeof (rt as Record<string, unknown>)[rtName], 'function', 'dsh-runtime export ' + rtName)
  }
  for (const name of cpOnly) {
    assert.equal(typeof (cp as Record<string, unknown>)[name], 'function', 'control-plane-only export ' + name)
    assert.equal((rt as Record<string, unknown>)[name], undefined, 'dsh-runtime must not grow ' + name + ' without registering it')
  }
  for (const name of rtOnly) {
    assert.notEqual((rt as Record<string, unknown>)[name], undefined, 'dsh-runtime-only export ' + name)
    assert.equal((cp as Record<string, unknown>)[name], undefined, 'control-plane must not grow ' + name + ' without registering it')
  }
  const expectedCp = [...shared.map(pair => pair[0]), ...cpOnly].sort()
  const expectedRt = [...shared.map(pair => pair[1]), ...rtOnly].sort()
  assert.deepEqual(Object.keys(cp).sort(), expectedCp, 'the control-plane export set changed - update the register')
  assert.deepEqual(Object.keys(rt).sort(), expectedRt, 'the dsh-runtime export set changed - update the register')
})
