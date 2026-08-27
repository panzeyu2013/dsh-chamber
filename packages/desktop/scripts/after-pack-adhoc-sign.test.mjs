import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAC_DISABLE_LIBRARY_VALIDATION,
  MAC_ENTITLEMENTS_PATH,
  PACKAGED_RUNTIME_MODULES,
  macAdhocSignArgs,
  verifyMacEntitlementsFile,
  verifyPackagedDshRuntime,
  verifyPackagedRuntimeSupport,
  verifySignedMacEntitlements,
} from './after-pack-adhoc-sign.mjs';

const require = createRequire(import.meta.url);

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

function supportFixture() {
  const resourcesDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-packaged-support-'));
  const pnpmDir = path.join(resourcesDir, 'pnpm');
  mkdirSync(path.join(pnpmDir, 'bin'), { recursive: true });
  mkdirSync(path.join(pnpmDir, 'dist'), { recursive: true });
  writeFileSync(path.join(pnpmDir, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.21.0' }));
  writeFileSync(path.join(pnpmDir, 'bin', 'pnpm.cjs'), 'import("./pnpm.mjs")');
  writeFileSync(path.join(pnpmDir, 'bin', 'pnpm.mjs'), 'await import("../dist/pnpm.mjs")');
  writeFileSync(path.join(pnpmDir, 'dist', 'pnpm.mjs'), '');
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  mkdirSync(unpacked, { recursive: true });
  for (const name of PACKAGED_RUNTIME_MODULES) writeFileSync(path.join(unpacked, name), '');
  return resourcesDir;
}

/** Build a real app.asar (like electron-builder does) containing the shared
 * runtime core's dist — or a dist-less one when `includeDist` is false. */
async function withRuntimeCoreAsar(resourcesDir, includeDist = true) {
  const asar = require('@electron/asar');
  const srcDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-asar-src-'));
  const distDir = path.join(srcDir, 'node_modules', '@dsh-chamber', 'dsh-runtime', 'dist');
  mkdirSync(distDir, { recursive: true });
  if (includeDist) writeFileSync(path.join(distDir, 'index.js'), 'export const marker = 1;');
  await asar.createPackage(srcDir, path.join(resourcesDir, 'app.asar'));
  rmSync(srcDir, { recursive: true, force: true });
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

test('packaged runtime support verification accepts pinned pnpm and every runtime module', async () => {
  const resourcesDir = supportFixture();
  try {
    await withRuntimeCoreAsar(resourcesDir);
    assert.doesNotThrow(() => verifyPackagedRuntimeSupport(resourcesDir));
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('packaged runtime support verification rejects a missing shared-core dist inside app.asar', async () => {
  const resourcesDir = supportFixture();
  try {
    await withRuntimeCoreAsar(resourcesDir, false);
    assert.throws(
      () => verifyPackagedRuntimeSupport(resourcesDir),
      /app\.asar is missing node_modules\/@dsh-chamber\/dsh-runtime\/dist\/index\.js/,
    );
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('packaged runtime support verification rejects missing pnpm or runtime modules', () => {
  const resourcesDir = supportFixture();
  try {
    rmSync(path.join(resourcesDir, 'pnpm', 'dist', 'pnpm.mjs'));
    assert.throws(() => verifyPackagedRuntimeSupport(resourcesDir), /incomplete packaged pnpm/);
    writeFileSync(path.join(resourcesDir, 'pnpm', 'dist', 'pnpm.mjs'), '');
    rmSync(path.join(resourcesDir, 'app.asar.unpacked', 'runtime-installer.ts'));
    assert.throws(() => verifyPackagedRuntimeSupport(resourcesDir), /runtime-installer\.ts/);
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('desktop packaging config keeps pnpm and asserted runtime modules in lockstep', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies.pnpm, '11.21.0');
  // The asar verification needs @electron/asar at packaging time.
  assert.ok(manifest.devDependencies['@electron/asar'], '@electron/asar must stay a desktop devDependency');
  for (const name of PACKAGED_RUNTIME_MODULES) {
    assert.ok(manifest.build.files.includes(name), `${name} must be packaged`);
    assert.ok(manifest.build.asarUnpack.includes(name), `${name} must be physically assertable afterPack`);
  }
  const pnpm = manifest.build.extraResources.find((entry) => entry.to === 'pnpm');
  assert.equal(pnpm?.from, 'node_modules/pnpm');
  assert.ok(pnpm?.filter.includes('package.json'));
  assert.ok(pnpm?.filter.includes('bin/pnpm.cjs'));
  assert.ok(pnpm?.filter.includes('bin/pnpm.mjs'));
  assert.ok(pnpm?.filter.includes('dist/**/*'));
});

test('mac signing config and ad-hoc fallback share the explicit native-module entitlements', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.build.mac.entitlements, 'resources/entitlements.mac.plist');
  assert.equal(manifest.build.mac.entitlementsInherit, 'resources/entitlements.mac.plist');
  assert.doesNotThrow(() => verifyMacEntitlementsFile(MAC_ENTITLEMENTS_PATH));
  assert.deepEqual(macAdhocSignArgs('/tmp/dsh-chamber.app'), [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--entitlements',
    MAC_ENTITLEMENTS_PATH,
    '/tmp/dsh-chamber.app',
  ]);
});

test('packaged signature assertion reads codesign output and fails closed without disable-library-validation', () => {
  const calls = [];
  const enabled = (_file, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: '',
      // codesign -d commonly writes display output to stderr; the assertion
      // must inspect both streams rather than accidentally passing only mocks.
      stderr: `<?xml version="1.0"?><plist><dict><key>${MAC_DISABLE_LIBRARY_VALIDATION}</key><true/></dict></plist>`,
    };
  };
  assert.doesNotThrow(() => verifySignedMacEntitlements('/tmp/dsh-chamber.app', enabled));
  assert.deepEqual(calls, [['-d', '--entitlements', ':-', '/tmp/dsh-chamber.app']]);

  const missing = () => ({
    status: 0,
    stdout: '<?xml version="1.0"?><plist><dict/></plist>',
    stderr: '',
  });
  assert.throws(
    () => verifySignedMacEntitlements('/tmp/dsh-chamber.app', missing),
    /disable-library-validation=true/,
  );
  const failed = () => ({ status: 1, stdout: '', stderr: 'not signed' });
  assert.throws(
    () => verifySignedMacEntitlements('/tmp/dsh-chamber.app', failed),
    /codesign exit 1/,
  );
});
