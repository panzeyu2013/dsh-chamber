#!/usr/bin/env node
import { copyFileSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneRuntimeArtifacts } from './prune-runtime.mjs';
import { commitBundleSwap, recoverBundleSwap } from './bundle-swap.mjs';
import { ALLOW_BUILDS } from '../allow-builds.mjs';

/**
 * 将 dsh 官方发布包 @deepseek-ai/dsh 安装为本地运行时（方案 B）。
 *
 * 安装即得到完整插件依赖图 + 全部已构建的 lib 产物，无需克隆源码、无需
 * tsc/tsdown 构建、无需 tsx 启动器。控制面以
 * `node <workspace>/node_modules/@deepseek-ai/dsh/lib/bin.js` 为统一入口。
 *
 * 版本策略：
 *   - 默认固定为经验证的精确版本（构建永不解析浮动 tag/range）
 *   - 此版本只属于桌面应用内嵌的本地 runtime，不要求远程 dsh 同版本；
 *     远程实例独立升级，只在连接时做协议能力兼容检查
 *   - 环境变量 DSH_CHAMBER_DSH_VERSION 只接受精确 semver（如 0.1.1-rc.2）
 *     用于显式升级验证；`latest`、range 与 URL 一律拒绝
 *   - 封装完成后 vendor/dsh/package.json 记录实际解析到的精确版本
 *     （dependencies["@deepseek-ai/dsh"]），可复现重建；--force 刷新当前 pin。
 *
 * pnpm 11 默认拦截依赖构建脚本（node-pty 等原生模块需要），通过
 * pnpm-workspace.yaml 的 allowBuilds 白名单放行。本脚本优先使用 PATH 上的
 * 固定 pnpm 11.21.0；PATH 版本不一致时自动以
 * `npx --yes pnpm@11.21.0` 兜底，无需预装 pnpm。
 */

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(pkgDir, 'vendor', 'dsh');
const backup = path.join(pkgDir, 'vendor', '.dsh-backup');
const force = process.argv.includes('--force');
const refreshLockfile = process.argv.includes('--refresh-lockfile');

/**
 * Remove interrupted-build workspaces without racing another live bundler.
 * These directories sit next to the runtime, so leaving one behind can also
 * make an over-broad packager resource rule ship the temporary install tree.
 */
function cleanStaleWorkspaces() {
  const vendorDir = path.dirname(dest);
  if (!existsSync(vendorDir)) return;
  for (const entry of readdirSync(vendorDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^\.dsh-src-(\d+)$/.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      // EPERM means the process exists but is owned by another user.
      alive = error?.code === 'EPERM';
    }
    if (!alive) rmSync(path.join(vendorDir, entry.name), { recursive: true, force: true });
  }
}

cleanStaleWorkspaces();

const recovery = recoverBundleSwap(dest, backup);
if (recovery === 'restored') console.warn('[bundle-dsh] 已恢复上次中断交换前的可用 dsh 封装。');

const DEFAULT_DSH_VERSION = '0.1.1-rc.2';
const BUNDLE_PNPM_VERSION = '11.21.0';
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION = process.env.DSH_CHAMBER_DSH_VERSION ?? DEFAULT_DSH_VERSION;
if (!EXACT_SEMVER.test(VERSION)) {
  console.error(`[bundle-dsh] DSH_CHAMBER_DSH_VERSION 必须是精确 semver，拒绝 ${JSON.stringify(VERSION)}`);
  process.exit(1);
}

/** 允许执行安装脚本的依赖（原生模块/编译步骤）——单一来源常量，见
 *  ../allow-builds.mjs（design 16 §4：与运行期安装器编译产物同源）。 */

const installed = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh');
// 平台感知的幂等跳过：node_modules 内含平台原生二进制（node-pty/sharp/ripgrep），
// 跨平台复用会把错误平台的运行时打进包（如 linux 产物用于 mac 打包）。
const platform = `${process.platform}-${process.arch}`;
if (existsSync(installed) && !force) {
  const recorded = JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8'));
  const recordedVersion = recorded.dependencies?.['@deepseek-ai/dsh'];
  if (recorded.dsh?.platform === platform && recordedVersion === VERSION) {
    console.log(
      `[bundle-dsh] 目标 ${dest} 已封装 @deepseek-ai/dsh@${recorded.dependencies?.['@deepseek-ai/dsh'] ?? '?'}（${platform}），跳过。`,
    );
    console.log(`[bundle-dsh] 使用 --force 重新拉取固定版本 @${VERSION}；升级须显式设置精确 DSH_CHAMBER_DSH_VERSION。`);
    process.exit(0);
  }
  console.warn(
    `[bundle-dsh] 现有封装 ${recordedVersion ?? '未知版本'} / ${recorded.dsh?.platform ?? '未知平台'} 与要求 ${VERSION} / ${platform} 不符，重新封装。`,
  );
}

mkdirSync(path.dirname(dest), { recursive: true });

const work = path.join(pkgDir, 'vendor', `.dsh-src-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// Synchronous exit cleanup covers normal failures and explicit process.exit().
// A hard kill is recovered by cleanStaleWorkspaces() on the next invocation.
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

writeFileSync(
  path.join(work, 'package.json'),
  `${JSON.stringify({ name: 'dsh-embedded-runtime', version: '0.0.0', private: true, dependencies: { '@deepseek-ai/dsh': VERSION } }, undefined, 2)}\n`,
);
writeFileSync(
  path.join(work, 'pnpm-workspace.yaml'),
  `minimumReleaseAge: 0\nallowBuilds:\n${ALLOW_BUILDS.map((name) => `  ${JSON.stringify(name)}: true`).join('\n')}\n`,
);

/**
 * 解析 pnpm 命令：只复用 PATH 上精确匹配的版本；否则以同一精确版本的
 * npx 兜底（自动下载到 npx 缓存，不写入项目依赖）。
 */
function resolvePnpmCommand() {
  const probe = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], {
    stdio: 'pipe',
  });
  if (probe.error) {
    console.log(`[bundle-dsh] 未检测到 pnpm，改用 npx --yes pnpm@${BUNDLE_PNPM_VERSION} 兜底（首次自动下载）。`);
    return ['npx', '--yes', `pnpm@${BUNDLE_PNPM_VERSION}`];
  }
  const raw = String(probe.stdout ?? '').trim();
  if (raw === BUNDLE_PNPM_VERSION) return ['pnpm'];
  console.warn(`[bundle-dsh] 检测到 pnpm ${raw || '?'}（要求 ${BUNDLE_PNPM_VERSION}），改用精确版本 npx 兜底。`);
  return ['npx', '--yes', `pnpm@${BUNDLE_PNPM_VERSION}`];
}

/** 执行命令并在失败时退出；cwd 固定为 work。 */
function run(args, what) {
  console.log(`[bundle-dsh] ${what}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd: work,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`[bundle-dsh] 无法执行 ${args[0]}：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[bundle-dsh] ${what} 失败（exit code ${result.status}），封装未完成`);
    process.exit(1);
  }
}

/**
 * 封装运行期（含布局选择）：
 * - `--config.node-linker=hoisted`：以 pnpm 扁平布局安装（npm 式，无
 *   .pnpm store、无符号链接）。这是 Windows 安装体验的关键：isolated 布局
 *   的符号链接在打包时会被展开成实体副本，NSIS 安装器要逐文件解压
 *   92,070 个条目 / ~1.1GB（实测）；hoisted 布局只有 ~3.3 万真实文件、
 *   无重复展开，解压负担降为约 1/3（dsh 官方发行即 npm 全局安装，扁平布局
 *   是 dsh 已验证的运行形态；控制面冒烟对 hoisted 树实测通过）。
 * 裁剪实现见 ./prune-runtime.mjs（独立模块，可对任意目录直接验证）；
 * 安装后 `node bin.js --version` 冒烟检查兜底裁剪正确性。
 */
const sourceLockfile = path.join(dest, 'pnpm-lock.yaml');
if (!existsSync(sourceLockfile) && !refreshLockfile) {
  console.error('[bundle-dsh] 缺少已提交的 runtime pnpm-lock.yaml；拒绝解析浮动传递依赖。升级时请显式使用 --refresh-lockfile。');
  process.exit(1);
}
if (existsSync(sourceLockfile)) copyFileSync(sourceLockfile, path.join(work, 'pnpm-lock.yaml'));
const pnpmCommand = resolvePnpmCommand();
if (refreshLockfile) {
  run(
    [...pnpmCommand, 'install', '--lockfile-only', '--no-frozen-lockfile'],
    `显式刷新 @deepseek-ai/dsh@${VERSION} runtime lockfile…`,
  );
}
run(
  [...pnpmCommand, 'install', '--frozen-lockfile', '--config.node-linker=hoisted'],
  `按冻结 lockfile 安装 @deepseek-ai/dsh@${VERSION}（hoisted 布局）…`,
);
const pruned = pruneRuntimeArtifacts(work);
console.log(`[bundle-dsh] 清理运行期不需要内容：${pruned.removedFiles} 个文件（含 ${pruned.removedDirs} 个整目录）+ node-pty/mistralai/openai 构建产物`);

const binPath = path.join(work, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(binPath)) {
  console.error('[bundle-dsh] 安装异常：node_modules/@deepseek-ai/dsh/lib/bin.js 不存在');
  process.exit(1);
}

const smoke = spawnSync('node', [binPath, '--version'], {
  cwd: work,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (smoke.status !== 0) {
  console.error(`[bundle-dsh] 冒烟检查失败（exit code ${smoke.status}），封装未完成`);
  process.exit(1);
}

// 记录实际解析到的精确版本 + 封装平台，供可复现重建与排查。
const resolvedVersion = JSON.parse(readFileSync(path.join(work, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
if (resolvedVersion !== VERSION) {
  console.error(`[bundle-dsh] 解析版本不匹配：要求 ${VERSION}，实际 ${resolvedVersion}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(path.join(work, 'package.json'), 'utf8'));
manifest.dependencies = { '@deepseek-ai/dsh': resolvedVersion };
manifest.dsh = { platform };
writeFileSync(path.join(work, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);

commitBundleSwap(work, dest, backup);
console.log(`[bundle-dsh] 封装完成：@deepseek-ai/dsh@${resolvedVersion} -> ${dest}`);
