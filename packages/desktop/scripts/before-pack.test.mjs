import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { materializeRuntimeCore, restoreRuntimeCoreLink } from './before-pack.mjs';

const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./before-pack.mjs', import.meta.url))).href;
const MODULE_PATH = fileURLToPath(new URL('./before-pack.mjs', import.meta.url));

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
  symlinkSync(path.relative(path.dirname(targetDir), sourceDir), targetDir, 'junction');
  // What readlink reports is platform-dependent (Node rewrites a Windows
  // junction target to an absolute path), so the fixture records the REAL
  // value instead of assuming the text it wrote.
  return { root, sourceDir, targetDir, linkTarget: readlinkSync(targetDir) };
}

/** Run the real hook (default export) in a child process that then exits. */
function runHook(sourceDir, targetDir) {
  const script = `
    const mod = await import(process.env.BP_MODULE)
    try {
      await mod.default({ sourceDir: process.env.BP_SOURCE, targetDir: process.env.BP_TARGET, log: (line) => console.log(line) })
    } catch (error) {
      console.error('materialize failed: ' + error.message)
      process.exitCode = 1
    }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, BP_MODULE: MODULE_URL, BP_SOURCE: sourceDir, BP_TARGET: targetDir },
  });
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
    // the original link text is reused (platform-normalized by the OS, so the
    // resolved target is what both platforms must agree on)
    assert.equal(path.resolve(path.dirname(targetDir), readlinkSync(targetDir)), sourceDir);
    assert.equal(readlinkSync(targetDir), linkTarget);
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

test('the packaged hook restores the link when the pack process exits', () => {
  // The exit/signal wiring is the whole point of the hook and only exists in
  // the default export, so it is exercised in a real child process.
  const { root, sourceDir, targetDir, linkTarget } = fixture();
  try {
    const run = runHook(sourceDir, targetDir);
    assert.equal(run.status, 0, `child failed: ${run.stderr}`);
    assert.match(run.stdout, /materialized @dsh-chamber\/dsh-runtime/);
    assert.match(run.stdout, /restored the workspace link/);
    assert.equal(lstatSync(targetDir).isSymbolicLink(), true, 'the link must be back after the process exits');
    assert.equal(readlinkSync(targetDir), linkTarget);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a materialization failure still restores the link (handler armed first)', () => {
  // materializeRuntimeCore clears the link before it copies, so a failure in
  // between must not leave the workspace without it (2026-09 review).
  const { root, sourceDir, targetDir, linkTarget } = fixture();
  try {
    // make the copy fail after the link is already gone
    rmSync(path.join(sourceDir, 'package.json'), { force: true });
    mkdirSync(path.join(sourceDir, 'package.json'));
    const run = runHook(sourceDir, targetDir);
    assert.notEqual(run.status, 0, 'the child must report the materialization failure');
    assert.match(`${run.stdout}${run.stderr}`, /materialize failed/);
    assert.equal(lstatSync(targetDir).isSymbolicLink(), true, 'the link must be restored even though the copy failed');
    assert.equal(readlinkSync(targetDir), linkTarget);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the hook module exports the documented surface', async () => {
  const mod = await import(MODULE_URL);
  assert.equal(typeof mod.default, 'function');
  assert.equal(typeof mod.materializeRuntimeCore, 'function');
  assert.equal(typeof mod.restoreRuntimeCoreLink, 'function');
  assert.equal(typeof mod.registerExitRestore, 'function');
  assert.equal(MODULE_PATH.endsWith(path.join('scripts', 'before-pack.mjs')), true);
});
