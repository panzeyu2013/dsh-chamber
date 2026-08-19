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
import path from 'node:path';

/** @param {import('app-builder-lib').AfterPackContext} context */
export default async function afterPackAdhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
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
