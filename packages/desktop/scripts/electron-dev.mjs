#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSharedElectronDist, platformExecutableName } from './electron-shared.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const DIST_INDEX = path.join(desktopDir, 'dist', 'index.html');
const forceBuild = process.argv.includes('--build');

// Dev-mode isolation: the dev instance must coexist with a running packaged
// dsh-chamber. The packaged app and a raw `electron .` share the same app
// identity (name "@dsh-chamber/desktop" → same userData), so a plain dev
// launch collides on the single-instance lock and on the default control-plane
// port 17500. The dev launcher therefore runs with its own user-data dir
// (own lock, state, registry, passwords — the packaged app's live state is
// never touched). The control-plane port is chosen by main.ts: dev starts at
// 17520 and auto-backs off to the first free port (parallel worktrees each
// land on their own port); DSH_CHAMBER_CP_PORT pins a fixed port.
const DEV_USER_DATA_DIR = path.join(desktopDir, '.dev-user-data');

function fail(message) {
  console.error(`[electron:dev] ${message}`);
  process.exit(1);
}

async function main() {
  // Shared Electron dist (electron-shared.mjs): ONE binary per machine per
  // version under the platform cache dir — git worktrees and repeated dev
  // runs reuse it instead of downloading/extracting ~300MB each. The zip
  // download is cached by @electron/get, so re-materializing never
  // re-downloads. DSH_CHAMBER_ELECTRON_DIST may point at any existing dist
  // (e.g. a pre-shared-flow local node_modules dist) to skip the cache.
  let electronDist;
  try {
    electronDist = await ensureSharedElectronDist();
  } catch (err) {
    fail(
      `Electron 引导失败：${err instanceof Error ? err.message : String(err)}` +
        '（可设置 DSH_CHAMBER_ELECTRON_DIST 指向现成 dist 目录跳过下载）',
    );
  }
  const electronExecutable = path.join(electronDist.distDir, platformExecutableName());
  if (!existsSync(electronExecutable)) {
    fail(`共享 Electron dist 缺少可执行文件：${electronExecutable}`);
  }

  if (forceBuild || !existsSync(DIST_INDEX)) {
    if (!forceBuild) {
      console.log('[electron:dev] 未找到渲染层构建产物 packages/desktop/dist/index.html，先执行 build:renderer');
    }
    const result = spawnSync('npm', ['run', 'build:renderer'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error || result.status !== 0) {
      fail(`渲染层构建失败（exit ${result.status ?? 'null'}）`);
    }
  }

  // 沙箱 preload 需要纯 CJS 编译产物（dist/preload.cjs，build:preload 生成）；
  // 缺失时先编译（同 build:renderer 的懒构建模式）。
  const PRELOAD_CJS = path.join(desktopDir, 'dist', 'preload.cjs');
  if (!existsSync(PRELOAD_CJS)) {
    console.log('[electron:dev] 未找到 preload 编译产物 dist/preload.cjs，先执行 build:preload');
    const result = spawnSync('node', ['scripts/build-preload.mjs'], {
      cwd: desktopDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error || result.status !== 0) {
      fail(`preload 编译失败（exit ${result.status ?? 'null'}）`);
    }
  }

  // The child env must never force Electron into node mode: a parent environment
  // carrying ELECTRON_RUN_AS_NODE=1 (e.g. a shell launched from a
  // node-in-electron runtime) would make the electron binary run as plain node —
  // the main process would then fail to import the built-in 'electron' module.
  // The dev launcher always wants a real Electron app.
  const childEnv = { ...process.env, DSH_CHAMBER_ELECTRON_DEV: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  console.log(`[electron:dev] Electron dist=${electronDist.distDir}（${electronDist.status}）；可执行文件=${electronExecutable}`);
  console.log(`[electron:dev] dev 隔离：user-data=${DEV_USER_DATA_DIR}（与打包版实例互不冲突；控制面端口由主进程从 17520 自动退避，DSH_CHAMBER_CP_PORT 可固定覆盖）`);

  const electron = spawn(electronExecutable, [`--user-data-dir=${DEV_USER_DATA_DIR}`, '.'], {
    cwd: desktopDir,
    env: childEnv,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });

  function killTree(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGTERM');
        // 升级兜底：launcher 是被监督进程（Electron）的监督者，退出必须确定性
        // 回收它——SIGTERM 1s 后仍活着则 SIGKILL 整个进程组，绝不留下无头
        // Electron（此前 SIGTERM 被 Chromium 消费/忽略时，2s 硬顶 process.exit
        // 会让 detached 的 Electron 残留在后台）。
        const escalate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          }
        }, 1000);
        escalate.unref?.();
        return;
      }
    } catch {}
    try {
      child.kill();
    } catch {}
  }

  let cleaning = false;
  function onSignal(exitCode) {
    if (cleaning) return;
    cleaning = true;
    killTree(electron);
    const timer = setTimeout(() => process.exit(exitCode), 2000);
    electron.once('exit', () => {
      clearTimeout(timer);
      process.exit(exitCode);
    });
  }

  for (const [signal, exitCode] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 })) {
    process.on(signal, () => onSignal(exitCode));
  }

  electron.on('exit', (code, signal) => {
    console.log(`[electron:dev] electron 已退出（code ${code ?? 'null'} signal ${signal ?? 'none'}）`);
    process.exit(typeof code === 'number' ? code : 1);
  });

  electron.on('error', (err) => fail(`无法启动 electron：${err.message}`));
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
