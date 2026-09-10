import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializeRuntimeCore, restoreRuntimeCoreLink } from './before-pack.mjs';

/** A workspace-shaped fixture: <root>/dsh-runtime + <root>/desktop/node_modules/@dsh-chamber/dsh-runtime link. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-before-pack-'));
  const sourceDir = path.join(root, 'dsh-runtime');
  mkdirSync(path.join(sourceDir, 'dist'), { recursive: true });
  mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
  writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: '@dsh-chamber/dsh-runtime', exports: { types: './src/index.ts' } }));
  writeFileSync(path.join(sourceDir, 'dist', 'index.js'), 'export const runtime = 1\n');
  writeFileSync(path.join(sourceDir, 'src', 'index.ts'), 'export declare const runtime: number\n');
  const targetDir = path.join(root, 'desktop', 'node_modules', '@dsh-chamber', 'dsh-runtime');
  mkdirSync(path.dirname(targetDir), { recursive: true });
  const linkTarget = path.relative(path.dirname(targetDir), sourceDir);
  symlinkSync(linkTarget, targetDir, 'junction');
  return { root, sourceDir, targetDir, linkTarget };
}

test('materialize replaces the workspace link with a dist-only directory', () => {
  const { root, sourceDir, targetDir, linkTarget } = fixture();
  try {
    const result = materializeRuntimeCore({ sourceDir, targetDir, log: () => {} });
    assert.equal(result.replacedLink, true);
    assert.equal(result.linkTarget, linkTarget, 'the replaced link text is reported for a faithful restore');
    assert.equal(lstatSync(targetDir).isSymbolicLink(), false, 'the link must be gone');
    assert.equal(readFileSync(path.join(targetDir, 'dist', 'index.js'), 'utf8'), 'export const runtime = 1\n');
    assert.equal(JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8')).name, '@dsh-chamber/dsh-runtime');
    // the shipped set stays scoped: src/ never enters the materialized tree
    assert.throws(() => readFileSync(path.join(targetDir, 'src', 'index.ts')));
    // a second pass refreshes instead of re-replacing
    const second = materializeRuntimeCore({ sourceDir, targetDir, log: () => {} });
    assert.equal(second.replacedLink, false);
    assert.equal(second.linkTarget, null, 'nothing to restore after the tree arrived materialized');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materialize drops artifacts the current build no longer produces', () => {
  const { root, sourceDir, targetDir } = fixture();
  try {
    materializeRuntimeCore({ sourceDir, targetDir, log: () => {} });
    writeFileSync(path.join(targetDir, 'dist', 'stale.js'), 'export const stale = 1\n');
    materializeRuntimeCore({ sourceDir, targetDir, log: () => {} });
    assert.throws(() => readFileSync(path.join(targetDir, 'dist', 'stale.js')), 'a refreshed tree must match the current build');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore puts the workspace link back, pointing at the workspace package', () => {
  const { root, sourceDir, targetDir, linkTarget } = fixture();
  try {
    const materialized = materializeRuntimeCore({ sourceDir, targetDir, log: () => {} });
    const restored = restoreRuntimeCoreLink({ sourceDir, targetDir, linkTarget: materialized.linkTarget });
    assert.equal(restored.restored, true);
    assert.equal(lstatSync(targetDir).isSymbolicLink(), true, 'the path must be a link again');
    assert.equal(readlinkSync(targetDir), linkTarget, 'the original link text is reused');
    assert.equal(path.resolve(path.dirname(targetDir), readlinkSync(targetDir)), sourceDir);
    // the type surface is reachable again — the exact failure the restore prevents
    assert.equal(readFileSync(path.join(targetDir, 'src', 'index.ts'), 'utf8'), 'export declare const runtime: number\n');
    // idempotent: an existing link is left alone
    assert.deepEqual(restoreRuntimeCoreLink({ sourceDir, targetDir }), { restored: false, reason: 'already a workspace link' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore heals a tree a killed pack left materialized (no link to inspect)', () => {
  const { root, sourceDir, targetDir } = fixture();
  try {
    // simulate a SIGKILLed pack: the directory is real, the link is long gone
    materializeRuntimeCore({ sourceDir, targetDir, log: () => {} });
    assert.equal(materializeRuntimeCore({ sourceDir, targetDir, log: () => {} }).replacedLink, false);
    assert.equal(restoreRuntimeCoreLink({ sourceDir, targetDir }).restored, true, 'the link is recomputed when nothing was recorded');
    assert.equal(lstatSync(targetDir).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore refuses to create a dangling link when the workspace package is gone', () => {
  const { root, sourceDir, targetDir } = fixture();
  try {
    materializeRuntimeCore({ sourceDir, targetDir, log: () => {} });
    rmSync(sourceDir, { recursive: true, force: true });
    assert.deepEqual(restoreRuntimeCoreLink({ sourceDir, targetDir }), { restored: false, reason: `workspace package missing at ${sourceDir}` });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materialize refuses a source without a built runtime', () => {
  const { root, sourceDir, targetDir } = fixture();
  try {
    rmSync(path.join(sourceDir, 'dist'), { recursive: true, force: true });
    assert.throws(
      () => materializeRuntimeCore({ sourceDir, targetDir, log: () => {} }),
      /dsh-runtime source missing/,
    );
    assert.equal(lstatSync(targetDir).isSymbolicLink(), true, 'a refused run must not touch the link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
