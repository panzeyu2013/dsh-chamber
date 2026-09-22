import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ELECTRON_PAYLOAD_REQUIRED,
  MAC_DISABLE_LIBRARY_VALIDATION,
  MAC_ENTITLEMENTS_PATH,
  MAC_FRAMEWORK_LOCALES_RELATIVE,
  PACKAGED_CLIENT_CLOSURE_SAMPLE,
  PACKAGED_PNPM_VERSION,
  PACKAGED_RUNTIME_MODULES,
  configuredElectronLanguages,
  electronPayloadEntries,
  localeStemMatches,
  macAdhocSignArgs,
  packagedLocaleStems,
  verifyMacEntitlementsFile,
  verifyPackagedDshRuntime,
  verifyPackagedElectronPayload,
  verifyPackagedMacLocales,
  verifyPackagedRuntimeSupport,
  verifySignedMacEntitlements,
} from './after-pack-adhoc-sign.mjs';
// The executed-artifact gate discovers a staged product itself; its discovery
// helper is asserted here so the packaging suite keeps it covered.
import { MAC_APP_ENV, resolvePackagedMacApp } from '../../../scripts/gates/verify-electron-artifacts.mjs';
// Cross-module pin lockstep: the Swift sidecar assembly reads the same
// desktop manifest field, so a drift between the two builds fails HERE.
import { PNPM_PINNED_VERSION } from './build-sidecar.mjs';
// 安装期抽样与本文件的打包期抽样必须一一对应：两个模块不能各写一份
// 名单后各自漂移（.mjs import .ts 运行时由 node 类型擦除支持；typecheck 面
// 不含 scripts/，故这里不会给 tsc 引入 .mjs 声明问题）。
import { RUNTIME_CLIENT_CLOSURE_SAMPLE } from '../runtime-tree-check.ts';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));

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
  // 上游 client-plugin 闭包抽样：真实封装里这些包由 pnpm 安装进
  // node_modules/@deepseek-ai/，fixture 必须造出同一形态，否则"完整运行时"
  // 用例本身就缺件。
  for (const name of PACKAGED_CLIENT_CLOSURE_SAMPLE) {
    const pluginDir = path.join(runtimeDir, 'node_modules', ...name.split('/'));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name, version: '0.1.5-rc.2' }));
  }
  return resourcesDir;
}

function supportFixture() {
  const resourcesDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-packaged-support-'));
  const pnpmDir = path.join(resourcesDir, 'pnpm');
  mkdirSync(path.join(pnpmDir, 'bin'), { recursive: true });
  mkdirSync(path.join(pnpmDir, 'dist'), { recursive: true });
  writeFileSync(path.join(pnpmDir, 'package.json'), JSON.stringify({ name: 'pnpm', version: PACKAGED_PNPM_VERSION }));
  writeFileSync(path.join(pnpmDir, 'bin', 'pnpm.cjs'), 'import("./pnpm.mjs")');
  writeFileSync(path.join(pnpmDir, 'bin', 'pnpm.mjs'), 'await import("../dist/pnpm.mjs")');
  writeFileSync(path.join(pnpmDir, 'dist', 'pnpm.mjs'), '');
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  mkdirSync(unpacked, { recursive: true });
  for (const name of PACKAGED_RUNTIME_MODULES) writeFileSync(path.join(unpacked, name), '');
  return resourcesDir;
}

/** Build a real app.asar containing the complete Electron payload, or
 * omit the named asar-relative entries to prove the assertion fails closed. */
async function withPayloadAsar(resourcesDir, omit = []) {
  const asar = require('@electron/asar');
  const srcDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-payload-asar-'));
  for (const relative of electronPayloadEntries()) {
    if (omit.includes(relative)) continue;
    const target = path.join(srcDir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, relative.endsWith('.html') ? '<!doctype html><title>dsh-chamber</title>' : 'export {};');
  }
  await asar.createPackage(srcDir, path.join(resourcesDir, 'app.asar'));
  rmSync(srcDir, { recursive: true, force: true });
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

test('startup and packaging closure samples stay in lockstep (S4)', () => {
  assert.deepEqual(
    RUNTIME_CLIENT_CLOSURE_SAMPLE.map((entry) => entry.split('/').slice(0, 3).join('/')),
    PACKAGED_CLIENT_CLOSURE_SAMPLE.map((name) => `node_modules/${name}`),
    'runtime-tree-check.ts 的安装期抽样与 after-pack-adhoc-sign.mjs 的打包期抽样必须一一对应',
  );
});

test('packaged runtime verification rejects a missing upstream client-plugin closure entry (S4)', () => {
  const resourcesDir = fixture();
  try {
    rmSync(path.join(resourcesDir, 'vendor', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-right'),
      { recursive: true, force: true });
    assert.throws(
      () => verifyPackagedDshRuntime(resourcesDir, 'darwin'),
      /missing upstream client plugins @deepseek-ai\/dsh-client-ui-sidebar-right/,
      '缺 sidebarRight 唯一 provider 的封装不得通过 afterPack',
    );
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
    rmSync(path.join(resourcesDir, 'app.asar.unpacked', 'dsh-runtime-controller.ts'));
    assert.throws(() => verifyPackagedRuntimeSupport(resourcesDir), /dsh-runtime-controller\.ts/);
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('packaged runtime support verification rejects a pnpm version drift against the manifest pin (G18)', () => {
  const resourcesDir = supportFixture();
  try {
    writeFileSync(path.join(resourcesDir, 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: '0.0.0-drift' }));
    assert.throws(
      () => verifyPackagedRuntimeSupport(resourcesDir),
      /wrong packaged pnpm: "pnpm"@"0\.0\.0-drift" \(expected pnpm@/,
    );
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

/** Escape one literal path for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('electronPayloadEntries covers web dist, preload, control-plane and every host package (G27)', () => {
  const entries = electronPayloadEntries();
  for (const fixed of ELECTRON_PAYLOAD_REQUIRED) {
    assert.ok(entries.includes(fixed), `${fixed} must be a required payload entry`);
  }
  // Four host package rows × (package.json + dist/index.js).
  assert.equal(entries.length, ELECTRON_PAYLOAD_REQUIRED.length + 8);
  assert.deepEqual([...new Set(entries)], entries, 'required entries must be unique');
  assert.ok(entries.includes('dist/host-graph-package/dist/index.js'));
  assert.ok(entries.includes('dist/host-open-in-package/package.json'));
});

test('packaged Electron payload verification accepts a complete asar and fails closed per missing entry (G27)', async () => {
  // Every critical artifact is load-bearing: web dist → shell, preload → the
  // fail-closed window path, control-plane → the packaged plane import, host
  // package dist → the local seed. Each omission must name the missing entry.
  for (const omit of [
    [],
    ['dist/web/index.html'],
    ['dist/preload.cjs'],
    ['dist/control-plane/index.js'],
    ['dist/host-graph-package/dist/index.js'],
  ]) {
    const resourcesDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-payload-asar-'));
    try {
      await withPayloadAsar(resourcesDir, omit);
      if (omit.length === 0) {
        assert.doesNotThrow(() => verifyPackagedElectronPayload(resourcesDir));
      } else {
        assert.throws(
          () => verifyPackagedElectronPayload(resourcesDir),
          new RegExp('incomplete packaged Electron payload: missing ' + escapeRegExp(omit[0])),
          `a build missing ${omit[0]} must fail closed`,
        );
      }
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  }
});

test('packaged Electron payload verification accepts the unpacked staged app dir, rejects an empty resources dir (G27)', () => {
  const resourcesDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-payload-staged-'));
  try {
    assert.throws(
      () => verifyPackagedElectronPayload(resourcesDir),
      /no Electron payload to verify/,
      'neither app.asar nor app/ must be loud, never a pass',
    );
    const appDir = path.join(resourcesDir, 'app');
    for (const relative of electronPayloadEntries()) {
      const target = path.join(appDir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, relative.endsWith('.html') ? '<!doctype html>' : 'export {};');
    }
    assert.doesNotThrow(() => verifyPackagedElectronPayload(resourcesDir));
    rmSync(path.join(appDir, 'dist', 'preload.cjs'));
    assert.throws(
      () => verifyPackagedElectronPayload(resourcesDir),
      /dist\/preload\.cjs/,
      'the staged-dir arm must apply the same required set',
    );
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('a real staged release app, when present, satisfies the payload assertion (loud skip otherwise) (G27)', () => {
  // The fixture tests above pin the assertion; this leg proves the assertion
  // against the REAL electron-builder output when a pack has run. Absence is a
  // loud SKIP, never a silent green: in CI the windows packaging rehearsal and
  // the release legs run afterPack, which calls the same function fail-closed.
  const releaseDir = fileURLToPath(new URL('../release', import.meta.url));
  const candidates = []
  if (existsSync(releaseDir)) {
    for (const entry of readdirSync(releaseDir)) {
      for (const relative of [
        path.join(entry, 'dsh-chamber.app', 'Contents', 'Resources', 'app.asar'),
        path.join(entry, 'resources', 'app.asar'),
        path.join(entry, 'dsh-chamber.app', 'Contents', 'Resources', 'app'),
        path.join(entry, 'resources', 'app'),
      ]) {
        const candidate = path.join(releaseDir, relative)
        if (existsSync(candidate)) candidates.push(candidate)
      }
    }
  }
  if (candidates.length === 0) {
    console.log(`SKIP: no staged Electron release app under ${releaseDir} — the payload assertion ran against fixtures here and runs fail-closed inside afterPack on a real pack`)
    return
  }
  for (const candidate of candidates) {
    if (candidate.endsWith('app.asar')) {
      verifyPackagedElectronPayload(path.dirname(candidate), { asarPath: candidate });
    } else {
      verifyPackagedElectronPayload(path.dirname(candidate), { stagedAppDir: candidate });
    }
  }
});

test('desktop packaging config keeps pnpm and asserted runtime modules in lockstep', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // No second hardcoded literal — the packaged assertion, the Swift sidecar
  // assembly and the manifest all read/compare the same dependencies.pnpm.
  assert.equal(PACKAGED_PNPM_VERSION, manifest.dependencies.pnpm);
  assert.equal(PNPM_PINNED_VERSION, manifest.dependencies.pnpm, 'the Swift sidecar build must read the same pin');
  // The asar verification needs @electron/asar at packaging time.
  assert.ok(manifest.devDependencies['@electron/asar'], '@electron/asar must stay a desktop devDependency');
  for (const name of PACKAGED_RUNTIME_MODULES) {
    const sourceGlob = name.endsWith('.mjs') ? '*.mjs' : name.endsWith('.cts') ? '*.cts' : '*.ts';
    assert.ok(manifest.build.files.includes(name) || manifest.build.files.includes(sourceGlob), `${name} must be packaged`);
    assert.ok(manifest.build.asarUnpack.includes(name), `${name} must be physically assertable afterPack`);
  }
  const pnpm = manifest.build.extraResources.find((entry) => entry.to === 'pnpm');
  assert.equal(pnpm?.from, 'node_modules/pnpm');
  assert.ok(pnpm?.filter.includes('package.json'));
  assert.ok(pnpm?.filter.includes('bin/pnpm.cjs'));
  assert.ok(pnpm?.filter.includes('bin/pnpm.mjs'));
  assert.ok(pnpm?.filter.includes('dist/**/*'));
});

test('beta builder config inherits the complete stable package config and changes only the publish channel', async () => {
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js');
  const resolved = await getConfig(projectDir, 'electron-builder.beta.yml', null);

  // The desktop manifest version is the released chamber version; asserting the
  // LITERAL would break on every bump. The release
  // preflight pins every chamber package to the root version, so compare
  // against that single source instead.
  const rootVersion = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  assert.equal(manifest.version, rootVersion);
  assert.equal(resolved.appId, manifest.build.appId);
  assert.equal(resolved.productName, manifest.build.productName);
  assert.equal(resolved.afterPack, manifest.build.afterPack);
  assert.deepEqual(resolved.mac, manifest.build.mac);
  assert.deepEqual(resolved.asarUnpack, manifest.build.asarUnpack);
  assert.deepEqual(resolved.extraResources, manifest.build.extraResources);
  assert.deepEqual(resolved.files, [{ filter: manifest.build.files }]);
  assert.deepEqual(resolved.publish, [{
    provider: 'github',
    owner: 'panzeyu2013',
    repo: 'dsh-chamber',
    channel: 'beta',
  }]);
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

/** 合成一个 electron-builder 形状的 mac .app：framework 的 .lproj/<locale>.pak。 */
function macAppFixture(locales = ['en', 'zh_CN'], { localePakBytes = 64 } = {}) {
  const appPath = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-mac-app-'));
  const localesDir = path.join(appPath, MAC_FRAMEWORK_LOCALES_RELATIVE);
  for (const stem of locales) {
    mkdirSync(path.join(localesDir, `${stem}.lproj`), { recursive: true });
    writeFileSync(path.join(localesDir, `${stem}.lproj`, 'locale.pak'), Buffer.alloc(localePakBytes, 1));
  }
  return appPath;
}

test('locale matcher mirrors app-builder-lib and accepts Electron underscore spellings (A1/F3)', () => {
  // app-builder-lib's matcher: exact, or wanted.startsWith(language + '-'/'_').
  assert.equal(localeStemMatches('en', 'en-US'), true, 'en.lproj is Electron shipping for en-US');
  assert.equal(localeStemMatches('zh_cn', 'zh_CN'), true, 'the fixed config form');
  assert.equal(localeStemMatches('zh_cn', 'zh-CN'), true, 'BCP-47 spelling names the same language');
  assert.equal(localeStemMatches('zh', 'zh_CN'), true, 'a zh resource satisfies the zh_CN request only through prefix');
  assert.equal(localeStemMatches('zh_cn', 'zh-TW'), false, 'traditional Chinese is a different resource');
  assert.equal(localeStemMatches('', 'zh_CN'), false);
  assert.equal(localeStemMatches('en', ''), false);
});

test('packaged locale stems list .lproj dirs and tolerate an absent framework dir', () => {
  const appPath = macAppFixture(['en', 'zh_CN', 'ja']);
  try {
    const stems = packagedLocaleStems(path.join(appPath, MAC_FRAMEWORK_LOCALES_RELATIVE));
    assert.deepEqual(stems.map((entry) => entry.name).sort(), ['en', 'ja', 'zh_CN']);
    assert.deepEqual(packagedLocaleStems(path.join(appPath, 'missing')), []);
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

test('packaged locale assertion passes when every declared locale survives (A1/F3)', () => {
  for (const wanted of [['en-US', 'zh_CN'], ['en-US', 'zh-CN']]) {
    const appPath = macAppFixture(['en', 'zh_CN']);
    try {
      assert.deepEqual(verifyPackagedMacLocales(appPath, { wantedLanguages: wanted }).checked, wanted);
    } finally {
      rmSync(appPath, { recursive: true, force: true });
    }
  }
});

test('packaged locale assertion fails closed when electronLanguages deleted a declared locale (A1 regression)', () => {
  // The failure shape: config says zh-CN while app-builder-lib deletes zh_CN.lproj.
  const appPath = macAppFixture(['en']);
  try {
    assert.throws(
      () => verifyPackagedMacLocales(appPath, { wantedLanguages: ['en-US', 'zh_CN'] }),
      /lost configured locale resources: zh_CN[\s\S]*framework \.lproj on disk: \[en\]/,
    );
    assert.throws(
      () => verifyPackagedMacLocales(appPath, { wantedLanguages: ['en-US', 'zh-CN'] }),
      /build\.electronLanguages entries in Electron's own spelling/,
    );
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

test('packaged locale assertion rejects an empty locale.pak and a missing framework dir', () => {
  const emptyPakApp = macAppFixture(['en', 'zh_CN'], { localePakBytes: 0 });
  try {
    assert.throws(
      () => verifyPackagedMacLocales(emptyPakApp, { wantedLanguages: ['zh_CN'] }),
      /zh_CN .*locale\.pak/,
    );
  } finally {
    rmSync(emptyPakApp, { recursive: true, force: true });
  }
  const bareApp = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-mac-bare-'));
  try {
    assert.throws(
      () => verifyPackagedMacLocales(bareApp, { wantedLanguages: ['zh_CN'] }),
      /lost configured locale resources/,
    );
  } finally {
    rmSync(bareApp, { recursive: true, force: true });
  }
});

test('no declared electronLanguages means no cleanup: the locale assertion is a no-op', () => {
  const appPath = macAppFixture(['en']);
  try {
    assert.deepEqual(verifyPackagedMacLocales(appPath, { wantedLanguages: [] }), { checked: [] });
    assert.deepEqual(configuredElectronLanguages({ build: {} }), []);
    assert.deepEqual(configuredElectronLanguages({ build: { electronLanguages: [' en-US ', '', 'zh_CN'] } }),
      ['en-US', 'zh_CN']);
    // electron-builder resolves platformSpecificBuildOptions.electronLanguages
    // BEFORE the top-level list — the mac leg overrides with the real .lproj
    // basenames (underscore) while win/linux keep the hyphenated .pak spelling.
    assert.deepEqual(
      configuredElectronLanguages({ build: { electronLanguages: ['zh-CN'], mac: { electronLanguages: ['zh_CN'] } } }),
      ['zh_CN'],
    );
    assert.deepEqual(
      configuredElectronLanguages({ build: { electronLanguages: ['zh-CN'], mac: { electronLanguages: ['zh_CN'] } } }, 'win32'),
      ['zh-CN'],
    );
    // The shipped manifest is the gate's expectation source: whatever it
    // declares must be well-formed for both platform resolutions (the mac leg
    // reads build.mac.electronLanguages, win/linux the top-level list).
    for (const platform of ['darwin', 'win32']) {
      const declared = configuredElectronLanguages(undefined, platform);
      assert.ok(Array.isArray(declared));
      assert.ok(declared.every((entry) => entry !== '' && entry.trim() === entry),
        `build.electronLanguages entries for ${platform} must be non-empty trimmed strings`);
    }
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

test('afterPack runs the packaged locale assertion on darwin products', () => {
  const source = readFileSync(new URL('./after-pack-adhoc-sign.mjs', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('export default async function afterPackAdhocSign'));
  assert.match(hook, /verifyPackagedMacLocales\(appPath\)/,
    'the darwin afterPack hook must run the locale assertion fail-closed');
});

test('executed-artifact gate discovers the staged mac product (or an explicit override)', () => {
  const releaseDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-release-'));
  try {
    assert.equal(resolvePackagedMacApp({}, releaseDir), null, 'an empty output dir stages no product');
    mkdirSync(path.join(releaseDir, 'win-unpacked', 'dsh-chamber.app'), { recursive: true });
    assert.equal(resolvePackagedMacApp({}, releaseDir), null, 'a win32 product is not a mac product');
    const appPath = path.join(releaseDir, 'mac-arm64', 'dsh-chamber.app');
    mkdirSync(appPath, { recursive: true });
    assert.equal(resolvePackagedMacApp({}, releaseDir), appPath);
    assert.equal(resolvePackagedMacApp({ [MAC_APP_ENV]: appPath }, releaseDir), appPath);
    assert.throws(
      () => resolvePackagedMacApp({ [MAC_APP_ENV]: path.join(releaseDir, 'gone.app') }, releaseDir),
      /points at a missing app bundle/,
      'an explicitly named product that vanished must fail, never silently skip',
    );
    assert.equal(resolvePackagedMacApp({}, path.join(releaseDir, 'absent')), null);
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
});

test('a real staged mac product, when present, satisfies the locale assertion (loud skip otherwise) (A1/F3)', () => {
  const releaseDir = fileURLToPath(new URL('../release', import.meta.url));
  let appPath = null;
  if (existsSync(releaseDir)) {
    for (const entry of readdirSync(releaseDir)) {
      const candidate = path.join(releaseDir, entry, 'dsh-chamber.app');
      if (entry.startsWith('mac') && existsSync(candidate)) { appPath = candidate; break; }
    }
  }
  if (appPath === null) {
    console.log(`SKIP: no staged mac product under ${releaseDir} — the locale assertion ran against fixtures here and runs fail-closed inside afterPack on a real pack`);
    return;
  }
  assert.doesNotThrow(() => verifyPackagedMacLocales(appPath));
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
