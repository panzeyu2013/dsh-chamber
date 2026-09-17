// Ad-hoc (re)sign the macOS .app when the build has no Apple Developer ID
// identity configured.
//
// Why this hook exists: with no signing identity, electron-builder skips
// signing entirely (and its afterSign hook too — see
// platformPackager#doSignAfterPack). The packaged app then inherits the stock
// Electron binary's linker ad-hoc signature, whose CodeDirectory claims
// sealed resources that the shipped bundle does not carry ("code has no
// resources but signature indicates they must be present" from
// `codesign --verify`). When the downloaded artifact is quarantined, macOS
// rejects that inconsistent signature state as "app is damaged", which no
// Gatekeeper setting ("allow apps from anywhere") can override — the
// assessment happens at signature-validation time, independent of spctl.
//
// Re-signing the whole bundle ad-hoc makes the signature structurally valid,
// so the app opens on Gatekeeper-relaxed systems. It is NOT a substitute for
// a Developer ID + notarization pipeline (that would also remove the
// right-click/anywhere requirement on default macOS), but it is the correct
// minimal fix for an unsigned build.
//
// Timing: afterPack fires after the app is fully packed into appOutDir and
// before the dmg target is built, so the DMG carries the signed app. If a
// real identity is configured later, electron-builder's sign step runs after
// this hook and replaces the ad-hoc signature — safe to keep unconditional.
// The same stage also corrects electron-builder's generated ATS default:
// chamber needs plaintext HTTP only for its loopback control plane, never a
// process-wide NSAllowsArbitraryLoads grant. This must happen before signing
// because Info.plist is a sealed resource.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_PACKAGE_BUILD_ROWS } from './build-host-graph-package.mjs';

const require = createRequire(import.meta.url);
export const MAC_DISABLE_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';
export const MAC_ENTITLEMENTS_PATH = fileURLToPath(new URL('../resources/entitlements.mac.plist', import.meta.url));

/** The desktop manifest this packaging run ships (single source for the pnpm
 *  pin; build-sidecar.mjs reads the same field — G18). */
export const DESKTOP_MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The pnpm version the packaged extraResources must carry (G18). Read from the
 * desktop manifest so the Electron-side assertion, the Swift sidecar assembly's
 * `copyPnpm` fail-closed check and the manifest cannot drift apart silently.
 */
export const PACKAGED_PNPM_VERSION = DESKTOP_MANIFEST.dependencies?.pnpm ?? null;

function entitlementEnabled(plistText, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<key>\\s*${escaped}\\s*<\\/key>\\s*<true\\s*\\/>`).test(plistText);
}

/** The committed plist is the source of truth for both signing paths. */
export function verifyMacEntitlementsFile(entitlementsPath = MAC_ENTITLEMENTS_PATH) {
  if (!existsSync(entitlementsPath)) {
    throw new Error(`missing macOS entitlements file: ${entitlementsPath}`);
  }
  const plist = readFileSync(entitlementsPath, 'utf8');
  if (!entitlementEnabled(plist, MAC_DISABLE_LIBRARY_VALIDATION)) {
    throw new Error(`macOS entitlements must enable ${MAC_DISABLE_LIBRARY_VALIDATION}`);
  }
}

/** Exact argv used by the no-identity afterPack fallback. Kept pure so the
 * packaging gate can prove that ad-hoc signing cannot silently drop the
 * native-module entitlement. */
export function macAdhocSignArgs(appPath, entitlementsPath = MAC_ENTITLEMENTS_PATH) {
  return ['--force', '--deep', '--sign', '-', '--entitlements', entitlementsPath, appPath];
}

/** Inspect the signature that will be shipped, rather than trusting config. */
export function verifySignedMacEntitlements(appPath, spawn = spawnSync) {
  const result = spawn('codesign', ['-d', '--entitlements', ':-', appPath], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`unable to read packaged macOS entitlements (codesign exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (!entitlementEnabled(output, MAC_DISABLE_LIBRARY_VALIDATION)) {
    throw new Error(`packaged macOS signature is missing ${MAC_DISABLE_LIBRARY_VALIDATION}=true`);
  }
}

export const PACKAGED_RUNTIME_MODULES = Object.freeze([
  'sanitize-error.ts',
  'dsh-runtime-controller.ts',
]);

/**
 * Runtime-version support must be present on the real filesystem: pnpm is an
 * extraResource and the modules are deliberately asar-unpacked so afterPack
 * can assert the exact bytes that Electron will load.
 */
export function verifyPackagedRuntimeSupport(resourcesDir) {
  const pnpmDir = path.join(resourcesDir, 'pnpm');
  const pnpmManifestPath = path.join(pnpmDir, 'package.json');
  const pnpmEntry = path.join(pnpmDir, 'bin', 'pnpm.cjs');
  const pnpmModuleEntry = path.join(pnpmDir, 'bin', 'pnpm.mjs');
  const pnpmDist = path.join(pnpmDir, 'dist', 'pnpm.mjs');
  if (!existsSync(pnpmManifestPath) || !existsSync(pnpmEntry)
    || !existsSync(pnpmModuleEntry) || !existsSync(pnpmDist)) {
    throw new Error(`incomplete packaged pnpm runtime: expected ${pnpmEntry}, ${pnpmModuleEntry} and ${pnpmDist}`);
  }
  const pnpmManifest = JSON.parse(readFileSync(pnpmManifestPath, 'utf8'));
  // G18: the expectation is the desktop manifest's own pin (the same field the
  // Swift sidecar assembly reads), never a second hardcoded literal.
  if (PACKAGED_PNPM_VERSION === null) {
    throw new Error('desktop package.json has no dependencies.pnpm — the packaged pnpm pin has no source');
  }
  if (pnpmManifest.name !== 'pnpm' || pnpmManifest.version !== PACKAGED_PNPM_VERSION) {
    throw new Error(`wrong packaged pnpm: ${JSON.stringify(pnpmManifest.name)}@${JSON.stringify(pnpmManifest.version)} (expected pnpm@${PACKAGED_PNPM_VERSION})`);
  }

  const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');
  const missing = PACKAGED_RUNTIME_MODULES.filter((name) => !existsSync(path.join(unpackedRoot, name)));
  if (missing.length > 0) {
    throw new Error(`incomplete packaged runtime modules: ${missing.join(', ')}`);
  }

  // The shared runtime core ships INSIDE app.asar as a production dependency
  // (node_modules/@dsh-chamber/dsh-runtime/dist/index.js); a missing or stale
  // dist there would surface as a startup module-not-found, not a build
  // failure. Assert the packed asar explicitly (review fix). Fixture/CI
  // contexts build no asar — a real electron-builder run always does, so the
  // skip is never silent in production packaging.
  const asarPath = path.join(resourcesDir, 'app.asar');
  if (existsSync(asarPath)) {
    const asar = require('@electron/asar');
    const files = asar.listPackage(asarPath);
    const runtimeCoreDist = 'node_modules/@dsh-chamber/dsh-runtime/dist/index.js';
    // listPackage yields entries with a leading '/' (asar-absolute form) on
    // POSIX hosts but backslash separators on Windows hosts (2026-09 beta.2:
    // the file was packed all along — the exact-string comparison missed the
    // Windows path shape). Normalize before comparing.
    const packed = files.some((entry) => {
      const normalized = entry.replace(/\\/g, '/');
      return normalized === runtimeCoreDist || normalized === `/${runtimeCoreDist}`;
    });
    if (!packed) {
      const chamberCount = files.filter((entry) => entry.includes('@dsh-chamber')).length;
      throw new Error(
        `packaged app.asar is missing ${runtimeCoreDist} — rebuild with build:dsh-runtime before dist:desktop `
        + `(asar has ${chamberCount} @dsh-chamber entries; Windows hosts list backslash paths — normalize before comparing)`,
      );
    }
  }
  console.log(`[after-pack-adhoc-sign] runtime installer support verified: pnpm@${pnpmManifest.version}, ${PACKAGED_RUNTIME_MODULES.length} modules`);
}

/**
 * The Electron payload the staged app must carry (G27). `dist/web` is the only
 * static-frontend source main.ts serves (missing → the control plane 404s the
 * shell into a white window, main.ts:1354), `dist/preload.cjs` is loaded
 * fail-closed at window creation (missing → showErrorBox + exit(1),
 * main.ts:832-841), `dist/control-plane/index.js` is the compiled plane the
 * packaged main process imports, and each host package copy carries the seed
 * artifact the local profile needs. The Swift builder fails closed on the same
 * payload (build-swift-app.mjs); this is the Electron-side mirror.
 */
export const ELECTRON_PAYLOAD_REQUIRED = [
  'dist/web/index.html',
  'dist/preload.cjs',
  'dist/control-plane/index.js',
];

/**
 * Every asar-relative path the payload assertion requires: the three fixed
 * entries plus `package.json` + `dist/index.js` for every host package
 * build row (the rows are the single source of the packaged directory names —
 * build-host-graph-package.mjs — so a rename cannot silently drop one).
 * @param {{ outDir: string }[]} [rows] - host package build rows.
 * @returns {string[]} required asar-relative entries, in a stable order.
 */
export function electronPayloadEntries(rows = HOST_PACKAGE_BUILD_ROWS) {
  const hostEntries = rows.flatMap((row) => {
    const base = 'dist/' + path.basename(row.outDir);
    return [`${base}/package.json`, `${base}/dist/index.js`];
  });
  return [...ELECTRON_PAYLOAD_REQUIRED, ...hostEntries];
}

/**
 * Assert the staged Electron app carries the complete runtime payload.
 * Accepts either a packed `app.asar` (electron-builder's default) or the
 * unpacked staged `app/` directory. Missing payload fails closed: a package
 * that lost one of these entries passes every existing check but ships a
 * white screen or a startup abort.
 * @param {string} resourcesDir - `<App>.app/Contents/Resources` (darwin) or `resources` (other platforms).
 * @param {{ asarPath?: string, stagedAppDir?: string, rows?: { outDir: string }[] }} [options] - test seams.
 */
export function verifyPackagedElectronPayload(resourcesDir, options = {}) {
  const required = electronPayloadEntries(options.rows);
  const asarPath = options.asarPath ?? path.join(resourcesDir, 'app.asar');
  const stagedAppDir = options.stagedAppDir ?? path.join(resourcesDir, 'app');
  let hasEntry;
  if (existsSync(asarPath)) {
    const asar = require('@electron/asar');
    const packed = new Set(
      asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/').replace(/^\//, '')),
    );
    hasEntry = (relative) => packed.has(relative);
  } else if (existsSync(stagedAppDir)) {
    hasEntry = (relative) => existsSync(path.join(stagedAppDir, relative));
  } else {
    throw new Error(`no Electron payload to verify under ${resourcesDir} (neither app.asar nor app/ exists)`);
  }
  const missing = required.filter((relative) => !hasEntry(relative));
  if (missing.length > 0) {
    throw new Error(
      `incomplete packaged Electron payload: missing ${missing.join(', ')}`
      + " (web dist / preload / compiled control-plane / host package artifacts must all ship)",
    );
  }
  console.log(
    `[after-pack-adhoc-sign] Electron payload verified: ${required.length} required entries `
    + `(web dist, preload, control-plane, ${required.length - ELECTRON_PAYLOAD_REQUIRED.length} host package files)`,
  );
}

/**
 * Fail the build before distributable targets are created when extraResources
 * did not carry the complete embedded runtime. electron-builder deliberately
 * ignores a FileSet root's `node_modules` child, so this is a required product
 * invariant rather than a CI-only assertion.
 */
export function verifyPackagedDshRuntime(resourcesDir, electronPlatformName) {
  const runtimeDir = path.join(resourcesDir, 'vendor', 'dsh');
  const runtimeManifestPath = path.join(runtimeDir, 'package.json');
  const dshManifestPath = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!existsSync(runtimeManifestPath) || !existsSync(dshManifestPath)) {
    throw new Error(`incomplete packaged dsh runtime: expected ${dshManifestPath}`);
  }
  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'));
  const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'));
  const recordedVersion = runtimeManifest.dependencies?.['@deepseek-ai/dsh'];
  if (recordedVersion !== dshManifest.version) {
    throw new Error(`packaged dsh version mismatch: runtime=${JSON.stringify(recordedVersion)}, package=${JSON.stringify(dshManifest.version)}`);
  }
  const expectedPlatform = electronPlatformName === 'win32' ? 'win32' : electronPlatformName;
  if (typeof runtimeManifest.dsh?.platform !== 'string' || !runtimeManifest.dsh.platform.startsWith(`${expectedPlatform}-`)) {
    throw new Error(`wrong packaged dsh platform: expected ${expectedPlatform}-*, got ${JSON.stringify(runtimeManifest.dsh?.platform)}`);
  }
  console.log(`[after-pack-adhoc-sign] packaged dsh verified: ${recordedVersion} (${runtimeManifest.dsh.platform})`);
}

/** @param {import('app-builder-lib').AfterPackContext} context */
export default async function afterPackAdhocSign(context) {
  const appName = context.packager.appInfo.productFilename;
  const resourcesDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  verifyPackagedDshRuntime(resourcesDir, context.electronPlatformName);
  verifyPackagedRuntimeSupport(resourcesDir);
  verifyPackagedElectronPayload(resourcesDir);
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false',
    infoPlist,
  ], { stdio: 'inherit' });
  const arbitraryLoads = execFileSync('plutil', [
    '-extract',
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    'raw',
    '-o',
    '-',
    infoPlist,
  ], { encoding: 'utf8' }).trim();
  if (arbitraryLoads !== 'false') {
    throw new Error(`failed to disable NSAllowsArbitraryLoads (got ${JSON.stringify(arbitraryLoads)})`);
  }
  console.log('[after-pack-adhoc-sign] ATS restricted to declared loopback exceptions');
  verifyMacEntitlementsFile();
  console.log(`[after-pack-adhoc-sign] ad-hoc signing ${appPath}`);
  execFileSync('codesign', macAdhocSignArgs(appPath), { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  verifySignedMacEntitlements(appPath);
  console.log(`[after-pack-adhoc-sign] signature verified (${MAC_DISABLE_LIBRARY_VALIDATION}=true)`);
}
