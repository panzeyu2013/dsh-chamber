#!/usr/bin/env node
import { existsSync, rmSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneRuntimeArtifacts } from './prune-runtime.mjs';

/**
 * 将 dsh 官方发布包 @deepseek-ai/dsh 安装为本地运行时（方案 B）。
 *
 * 安装即得到完整插件依赖图 + 全部已构建的 lib 产物，无需克隆源码、无需
 * tsc/tsdown 构建、无需 tsx 启动器。控制面以
 * `node <workspace>/node_modules/@deepseek-ai/dsh/lib/bin.js` 为统一入口。
 *
 * 版本策略：
 *   - 默认 `latest`（每次构建取 npm 最新发布版）
 *   - 环境变量 DSH_CHAMBER_DSH_VERSION 可固定版本（如 0.1.0-rc.8）做可复现构建
 *   - 封装完成后 vendor/dsh/package.json 记录实际解析到的精确版本
 *     （dependencies["@deepseek-ai/dsh"]），可复现重建；--force 刷新到最新。
 *
 * pnpm 11 默认拦截依赖构建脚本（node-pty 等原生模块需要），通过
 * pnpm-workspace.yaml 的 allowBuilds 白名单放行。本脚本优先使用 PATH 上的
 * pnpm（需 ≥11），缺失或版本过旧时自动以 `npx --yes pnpm@11` 兜底，无需
 * 预装 pnpm。
 */

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(pkgDir, 'vendor', 'dsh');
const force = process.argv.includes('--force');

const VERSION = process.env.DSH_CHAMBER_DSH_VERSION ?? 'latest';

/** 允许执行安装脚本的依赖（原生模块/编译步骤）。 */
const ALLOW_BUILDS = [
  'node-pty',
  'koffi',
  'protobufjs',
  '@google/genai',
  '@deepseek-ai/dsh-subprocess-local',
];

const installed = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh');
// 平台感知的幂等跳过：node_modules 内含平台原生二进制（node-pty/sharp/ripgrep），
// 跨平台复用会把错误平台的运行时打进包（如 linux 产物用于 mac 打包）。
const platform = `${process.platform}-${process.arch}`;
if (existsSync(installed) && !force) {
  const recorded = JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8'));
  if (recorded.dsh?.platform === platform) {
    console.log(
      `[bundle-dsh] 目标 ${dest} 已封装 @deepseek-ai/dsh@${recorded.dependencies?.['@deepseek-ai/dsh'] ?? '?'}（${platform}），跳过。`,
    );
    console.log('[bundle-dsh] 使用 --force 重新拉取（默认 @latest）或设置 DSH_CHAMBER_DSH_VERSION 固定版本。');
    process.exit(0);
  }
  console.warn(
    `[bundle-dsh] 现有封装平台 ${recorded.dsh?.platform ?? '未知'} 与当前 ${platform} 不符，重新封装。`,
  );
}

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}
mkdirSync(path.dirname(dest), { recursive: true });

const work = path.join(pkgDir, 'vendor', `.dsh-src-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

writeFileSync(
  path.join(work, 'package.json'),
  `${JSON.stringify({ name: 'dsh-embedded-runtime', version: '0.0.0', private: true }, undefined, 2)}\n`,
);
writeFileSync(
  path.join(work, 'pnpm-workspace.yaml'),
  `minimumReleaseAge: 0\nallowBuilds:\n${ALLOW_BUILDS.map((name) => `  ${JSON.stringify(name)}: true`).join('\n')}\n`,
);

/**
 * 解析 pnpm 命令：优先 PATH 上的 pnpm（需 ≥11 支持 allowBuilds 白名单），
 * 缺失或过旧时用 npx 兜底（自动下载到 npx 缓存，不写入项目依赖）。
 */
function resolvePnpmCommand() {
  const probe = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], {
    stdio: 'pipe',
  });
  if (probe.error) {
    console.log('[bundle-dsh] 未检测到 pnpm，改用 npx --yes pnpm@11 兜底（首次自动下载）。');
    return ['npx', '--yes', 'pnpm@11'];
  }
  const raw = String(probe.stdout ?? '').trim();
  const major = Number(raw.split('.')[0]);
  if (Number.isFinite(major) && major >= 11) return ['pnpm'];
  console.warn(`[bundle-dsh] 检测到 pnpm ${raw || '?'}（需 ≥11），改用 npx --yes pnpm@11。`);
  return ['npx', '--yes', 'pnpm@11'];
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
run(
  [...resolvePnpmCommand(), 'add', `@deepseek-ai/dsh@${VERSION}`, '--config.node-linker=hoisted'],
  `pnpm add @deepseek-ai/dsh@${VERSION}（hoisted 布局）…`,
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
const manifest = JSON.parse(readFileSync(path.join(work, 'package.json'), 'utf8'));
manifest.dependencies = { '@deepseek-ai/dsh': resolvedVersion };
manifest.dsh = { platform };
writeFileSync(path.join(work, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);

renameSync(work, dest);
console.log(`[bundle-dsh] 封装完成：@deepseek-ai/dsh@${resolvedVersion} -> ${dest}`);
