import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyPackagedDshRuntime } from './after-pack-adhoc-sign.mjs';

function fixture(platform = 'darwin-arm64', version = '0.1.1-rc.2') {
  const resourcesDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-packaged-runtime-'));
  const runtimeDir = path.join(resourcesDir, 'vendor', 'dsh');
  const dshDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform },
  }));
  writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ version }));
  return resourcesDir;
}

test('packaged runtime verification accepts a complete matching runtime', () => {
  const resourcesDir = fixture();
  try {
    assert.doesNotThrow(() => verifyPackagedDshRuntime(resourcesDir, 'darwin'));
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('packaged runtime verification rejects a missing node_modules payload', () => {
  const resourcesDir = fixture();
  try {
    rmSync(path.join(resourcesDir, 'vendor', 'dsh', 'node_modules'), { recursive: true, force: true });
    assert.throws(
      () => verifyPackagedDshRuntime(resourcesDir, 'darwin'),
      /incomplete packaged dsh runtime/,
    );
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('packaged runtime verification rejects version or platform drift', () => {
  const resourcesDir = fixture('darwin-arm64', '0.1.1-rc.2');
  try {
    const dshManifest = path.join(resourcesDir, 'vendor', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    writeFileSync(dshManifest, JSON.stringify({ version: '0.1.0-rc.7' }));
    assert.throws(() => verifyPackagedDshRuntime(resourcesDir, 'darwin'), /version mismatch/);
    writeFileSync(dshManifest, JSON.stringify({ version: '0.1.1-rc.2' }));
    assert.throws(() => verifyPackagedDshRuntime(resourcesDir, 'win32'), /wrong packaged dsh platform/);
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});
