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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
  console.log(`[after-pack-adhoc-sign] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('[after-pack-adhoc-sign] signature verified');
}
