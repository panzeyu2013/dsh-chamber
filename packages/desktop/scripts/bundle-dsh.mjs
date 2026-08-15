#!/usr/bin/env node
import { existsSync, rmSync, mkdirSync, renameSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 将 dsh 官方发布包 @deepseek-ai/dsh 安装为本地运行时（方案 B）。
 *
 * 安装即得到完整插件依赖图 + 全部已构建的 lib 产物，无需克隆源码、无需
 * tsc/tsdown 构建、无需 tsx 启动器。控制面以
 * `node <workspace>/node_modules/@deepseek-ai/dsh/lib/bin.js` 为统一入口。
 *
 * 版本策略：
 *   - 默认 `latest`（每次构建取 npm 最新发布版）
 *   - 环境变量 DSH_CHAMBER_DSH_VERSION 可固定版本（如 0.1.0-rc.6）做可复现构建
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
 * 清理运行期不需要的内容（安装期/构建期产物）：
 * - node-pty 的构建源料（deps/third_party/src/scripts/typings/binding.gyp）
 *   与异平台预编译归档：node-pty@1.1 的运行时二进制**只随包自带**于
 *   prebuilds/<platform>/pty.node（无 build/Release），loader 按
 *   build/Release → build/Debug → prebuilds/<platform> 顺序加载——因此保留
 *   当前平台的 prebuilds 子目录，只删其余平台（darwin-x64/win32/linux…）
 * - mistralai / openai 的 TS 源码、示例、测试（运行时只用编译产物 esm|lib）
 * - 全树 *.d.ts / *.d.cts / *.d.mts / *.map（类型声明与源码映射，运行期零使用）
 * 版本无关：按 .pnpm 顶层目录名模式查找，找不到（版本重构）时静默跳过，
 * 正确性由安装后的冒烟检查兜底。
 */
function pruneRuntimeArtifacts() {
  const pnpmDir = path.join(work, 'node_modules', '.pnpm')
  const byPrefix = (prefix) => readdirSync(pnpmDir).filter((name) => name.startsWith(prefix))

  for (const dir of byPrefix('node-pty@')) {
    const pkg = path.join(pnpmDir, dir, 'node_modules', 'node-pty')
    for (const sub of ['deps', 'third_party', 'src', 'scripts', 'typings', 'binding.gyp']) {
      rmSync(path.join(pkg, sub), { recursive: true, force: true })
    }
    const prebuilds = path.join(pkg, 'prebuilds')
    if (existsSync(prebuilds)) {
      const current = `${process.platform}-${process.arch}`
      for (const entry of readdirSync(prebuilds)) {
        if (entry !== current) rmSync(path.join(prebuilds, entry), { recursive: true, force: true })
      }
    }
  }
  for (const dir of byPrefix('@mistralai+mistralai@')) {
    const pkg = path.join(pnpmDir, dir, 'node_modules', '@mistralai', 'mistralai')
    for (const sub of ['src', 'examples', 'tests']) rmSync(path.join(pkg, sub), { recursive: true, force: true })
  }
  for (const dir of byPrefix('openai@')) {
    const pkg = path.join(pnpmDir, dir, 'node_modules', 'openai')
    for (const sub of ['src', 'examples', 'tests']) rmSync(path.join(pkg, sub), { recursive: true, force: true })
  }

  let removed = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.d\.(ts|cts|mts)$/.test(entry.name) || entry.name.endsWith('.map')) {
        rmSync(full, { force: true })
        removed += 1
      }
    }
  }
  walk(work)
  console.log(`[bundle-dsh] 清理运行期不需要内容：${removed} 个类型/映射文件 + node-pty/mistralai/openai 构建产物`)
}

run([...resolvePnpmCommand(), 'add', `@deepseek-ai/dsh@${VERSION}`], `pnpm add @deepseek-ai/dsh@${VERSION} …`);
pruneRuntimeArtifacts();

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
