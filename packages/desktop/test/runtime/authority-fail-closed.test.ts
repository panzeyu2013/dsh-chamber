/**
 * Desktop authority fail-closed lockstep (Phase B B3; fallback audit 2.2/2.3).
 *
 * resolveActiveRuntime() is the synchronous spawn-time resolver: corrupt OR
 * unreadable (EACCES/EIO) current/override material must fail closed with a
 * blockedReason, never alias "no override / no pointer" and never hand back
 * the bundled workspace as a runnable fallback. The corrupt/valid/missing
 * paths get real-filesystem fixtures here; the unknown path needs chmod 000,
 * which root and win32 cannot express, so it carries the same skip fixture
 * dsh-runtime's own store tests use. The controller's injected State seam
 * covers unknown deterministically in dsh-runtime-controller.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveActiveRuntime } from '../../shell-core.ts';

const BUILTIN = '/builtin/dsh';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-authority-'));
}

/** The runtime root as the authority readers expect it (real 0700 dir). */
function runtimeDir(baseDir: string): string {
  const dir = join(baseDir, 'dsh-runtime');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Run with DSH_CHAMBER_DSH_PATH cleared, restoring the previous value. */
function withoutEnvOverride<T>(fn: () => T): T {
  const previous = process.env.DSH_CHAMBER_DSH_PATH;
  delete process.env.DSH_CHAMBER_DSH_PATH;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_CHAMBER_DSH_PATH;
    else process.env.DSH_CHAMBER_DSH_PATH = previous;
  }
}

test('no selection metadata resolves the bundled workspace without a block', () => {
  const base = freshBase();
  try {
    withoutEnvOverride(() => {
      assert.deepEqual(resolveActiveRuntime(base, BUILTIN), {
        path: BUILTIN,
        version: null,
        source: 'bundled',
        blockedReason: null,
      });
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a corrupt current pointer blocks builtin resolution instead of aliasing it', () => {
  const base = freshBase();
  try {
    const dir = runtimeDir(base);
    writeFileSync(join(dir, 'current'), '{not-json', { mode: 0o600 });
    withoutEnvOverride(() => {
      const resolved = resolveActiveRuntime(base, BUILTIN);
      assert.equal(resolved.path, null, 'a corrupt pointer must not spawn the builtin tree');
      assert.equal(resolved.version, null);
      assert.equal(resolved.source, 'bundled');
      assert.match(resolved.blockedReason ?? '', /current pointer is corrupt/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a corrupt override blocks resolution instead of aliasing no-override', () => {
  const base = freshBase();
  try {
    const dir = runtimeDir(base);
    writeFileSync(join(dir, 'override.json'), '{not-json', { mode: 0o600 });
    withoutEnvOverride(() => {
      const resolved = resolveActiveRuntime(base, BUILTIN);
      assert.equal(resolved.path, null);
      assert.equal(resolved.version, null);
      assert.match(resolved.blockedReason ?? '', /override metadata is corrupt/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** Deterministic EACCES fixture: chmod 000 blocks a non-root POSIX reader,
 *  while root (and win32 mode semantics) cannot express the failure. */
const noPermissionFixture = {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
    ? 'requires a non-root POSIX host (chmod 000 must block the reader)'
    : false,
};

test('an unreadable runtime root blocks resolution (unknown, not missing)', noPermissionFixture, () => {
  const base = freshBase();
  const dir = runtimeDir(base);
  chmodSync(dir, 0o000);
  try {
    withoutEnvOverride(() => {
      const resolved = resolveActiveRuntime(base, BUILTIN);
      assert.equal(resolved.path, null, 'unreadable selection material must never spawn builtin');
      assert.equal(resolved.version, null);
      assert.match(resolved.blockedReason ?? '', /override metadata is unreadable/);
    });
  } finally {
    chmodSync(dir, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});
