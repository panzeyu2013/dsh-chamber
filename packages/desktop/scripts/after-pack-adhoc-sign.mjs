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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
 * 上游 client-plugin 闭包抽样（S4 P1，2026-12 Windows 复核）。sidebarRight 行的
 * 唯一 provider 是 `@deepseek-ai/dsh-client-ui-sidebar-right`，chat / resources
 * 是该行首屏的注入面；`extraResources` 的 `node_modules/**` 是无界 glob，
 * 部分安装（长路径 / Defender 中断 / pnpm 提前退出）丢包时旧断言全绿、前端
 * 静默降级成永久 pending——这里按包 manifest 抽样 fail-closed。启动期对安装树
 * 的同款抽样见 runtime-tree-check.ts（RUNTIME_CLIENT_CLOSURE_SAMPLE；两表由
 * packages/desktop/test/local-state/runtime-tree-check.test.ts 锁步）。
 */
export const PACKAGED_CLIENT_CLOSURE_SAMPLE = Object.freeze([
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-ui-chat',
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
 * macOS .app 里 Electron 语言资源所在目录（每个 `.lproj` 子目录带一个
 * `locale.pak`）。electron-builder 的 ElectronFramework.removeUnusedLanguagesIfNeeded
 * 只扫描两个目录：`Contents/Resources` 与 framework 的 Versions/A/Resources；
 * 真正的 Chromium 文案资源在后者（顶层只有空的 `en.lproj` 占位）。
 */
export const MAC_FRAMEWORK_LOCALES_RELATIVE = path.join(
  'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources',
);

/**
 * desktop manifest 对 darwin 生效的 `electronLanguages`（trim；空 = 不做清理）。
 *
 * 复刻 electron-builder 的取值顺序（ElectronFramework.removeUnusedLanguagesIfNeeded：
 * `platformSpecificBuildOptions.electronLanguages || config.electronLanguages`）：
 * mac 腿可以（也必须）用 `build.mac.electronLanguages` 覆盖顶层值——mac 的目录名是
 * `zh_CN.lproj`（下划线），win/linux 的 `.pak` 才是连字符 `zh-CN`。
 */
export function configuredElectronLanguages(manifest = DESKTOP_MANIFEST, platform = 'darwin') {
  const declared = platform === 'darwin'
    ? manifest?.build?.mac?.electronLanguages ?? manifest?.build?.electronLanguages
    : manifest?.build?.electronLanguages;
  if (!Array.isArray(declared)) return [];
  return declared.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
}

/** 磁盘上的 `.lproj` 基名（保留原名用于拼路径，另给小写 stem 用于匹配）。 */
export function packagedLocaleStems(localesDir) {
  if (!existsSync(localesDir)) return [];
  return readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.lproj'))
    .map((entry) => {
      const name = entry.name.slice(0, -'.lproj'.length);
      return { name, stem: name.toLowerCase() };
    });
}

/**
 * 一个磁盘 stem（小写）是否满足一个配置语言的期望：复刻 app-builder-lib 的
 * ElectronFramework matcher（`wanted === language` / `wanted.startsWith(language + '-')`
 * / `wanted.startsWith(language + '_')`），并额外把配置里的 BCP-47 连字符写法归一化
 * 为下划线再比一次（`zh-CN` 与 `zh_CN` 指同一语言，Electron 的目录名是后者）。
 *
 * 注意这不是"把 bug 放行"：A1 的失败形态是目录被 electron-builder **物理删除**——
 * 本函数只决定一个真实存在的 .lproj 能否满足配置项，物理缺失由调用方断言。
 */
export function localeStemMatches(stem, wanted) {
  const normalized = wanted.trim().toLowerCase();
  if (normalized === '' || stem === '') return false;
  if (normalized === stem || normalized.startsWith(`${stem}-`) || normalized.startsWith(`${stem}_`)) return true;
  const canonical = normalized.replace(/-/g, '_');
  return canonical === stem || canonical.startsWith(`${stem}_`) || stem.startsWith(`${canonical}_`);
}

/**
 * 2026-12 A1 回归门禁：用户包必须真的带出 `build.electronLanguages` 声明的每个
 * 语言资源。app-builder-lib 的 matcher 是"精确/前缀"匹配，过去配置写 `zh-CN`
 * 而 Electron 目录名是 `zh_CN` ⇒ `zh_CN.lproj/locale.pak`（569KB）被静默删除，
 * 中文系统上 Chromium 级文案回退英文，且没有任何门禁看得见（这份断言只能跑在
 * 真实 .app 上——dist 没有 .lproj）。
 *
 * 期望值取自 manifest 自身（单源），所以删掉某个语言是有意的配置变更、不会被误
 * 报；而"配置声明了却消失在包里"永远 FAIL。
 * @param appPath - `<App>.app` 绝对路径。
 * @param {{ wantedLanguages?: string[], localesDir?: string }} [options] - 测试接缝。
 * @returns `{ checked: string[] }`。
 */
export function verifyPackagedMacLocales(appPath, options = {}) {
  const wanted = (options.wantedLanguages ?? configuredElectronLanguages())
    .map((entry) => String(entry).trim())
    .filter((entry) => entry !== '');
  if (wanted.length === 0) {
    console.log('[after-pack-adhoc-sign] no build.electronLanguages declared — electron-builder removes nothing, every locale ships');
    return { checked: [] };
  }
  const localesDir = options.localesDir ?? path.join(appPath, MAC_FRAMEWORK_LOCALES_RELATIVE);
  const stems = packagedLocaleStems(localesDir);
  const missing = [];
  for (const language of wanted) {
    const match = stems.find((entry) => localeStemMatches(entry.stem, language));
    if (match === undefined) {
      missing.push(language);
      continue;
    }
    const pak = path.join(localesDir, `${match.name}.lproj`, 'locale.pak');
    if (!existsSync(pak) || statSync(pak).size === 0) missing.push(`${language} (${pak})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `packaged macOS app lost configured locale resources: ${missing.join(', ')} — `
      + `framework .lproj on disk: [${stems.map((entry) => entry.name).join(', ')}]. `
      + "app-builder-lib's electronLanguages matcher deletes every .lproj whose lowercase name is not "
      + "an exact/prefix match for the configured language (A1: 'zh-CN' can never match Electron's "
      + "'zh_CN'), so a declared locale silently disappears from the user bundle. "
      + "Write build.electronLanguages entries in Electron's own spelling (en-US / zh_CN).",
    );
  }
  console.log(`[after-pack-adhoc-sign] packaged locales verified: ${wanted.join(', ')} (${stems.length} .lproj dirs on disk)`);
  return { checked: wanted };
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
  // 上游 client-plugin 闭包抽样：缺一个包时 pnpm 安装/打包全绿，前端却只在
  // 运行期静默少一行（sidebarRight 的唯一 provider 就在抽样里）。
  const missingPlugins = PACKAGED_CLIENT_CLOSURE_SAMPLE.filter((name) =>
    !existsSync(path.join(runtimeDir, 'node_modules', name, 'package.json')));
  if (missingPlugins.length > 0) {
    throw new Error(
      `incomplete packaged dsh runtime: missing upstream client plugins ${missingPlugins.join(', ')} `
      + '(extraResources node_modules/** is an unbounded glob — a partial install ships silently and the '
      + 'sidebarRight/chat/resources rows never load; re-run bundle:dsh with the pinned pnpm)',
    );
  }
  console.log(
    `[after-pack-adhoc-sign] packaged dsh verified: ${recordedVersion} (${runtimeManifest.dsh.platform}, `
    + `${PACKAGED_CLIENT_CLOSURE_SAMPLE.length} upstream client plugins)`,
  );
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
  // A1/F3 门禁：electronLanguages 静默删资源只在真实 .app 上可见（dist 没有
  // .lproj），所以在打包阶段断言"用户包内确实带出每个声明的 locale 资源"。
  verifyPackagedMacLocales(appPath);
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
