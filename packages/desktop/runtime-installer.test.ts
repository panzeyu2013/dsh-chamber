/**
 * runtime-installer.ts tests (design 16 §4) — node:test, no real pnpm/node/
 * filesystem install. Every side effect (node/run/prune/smoke) is mocked; the
 * tests assert the pipeline's contract: command construction, work-dir
 * allowBuilds preamble, retry-once, error sanitization, and atomic publish.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installRuntimeVersion, scrubInstallEnv } from './runtime-installer.ts';
import type { InstallerDeps, RunResult } from './runtime-installer.ts';

function makeBaseDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-rt-installer-'));
}

function okRun(capture: { args: string[][]; opts: Array<{ cwd: string; env?: Record<string, string> }> }) {
  return async (args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<RunResult> => {
    capture.args.push(args);
    capture.opts.push(opts);
    return { status: 0, stdout: '', stderr: '' };
  };
}

const nodeFn = () => ({ file: '/fake/node', args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } });
const pruneOk = async () => ({ removedFiles: 0, removedDirs: 0 });
const smokeOk = async () => {};

test('installRuntimeVersion: builds the exact pnpm install command', async () => {
  const baseDir = makeBaseDir();
  const capture = { args: [] as string[][], opts: [] as Array<{ cwd: string; env?: Record<string, string> }> };
  await installRuntimeVersion({
    baseDir, version: '0.1.1-rc.2', registryOrigin: 'https://registry.npmjs.org',
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run: okRun(capture), prune: pruneOk, smoke: smokeOk },
  });
  assert.equal(capture.args.length, 1);
  const args = capture.args[0]!;
  assert.deepEqual(args, [
    '/fake/node', '--expose-internals', '/pnpm/bin/pnpm.cjs', 'install',
    '--config.node-linker=hoisted',
    '--store-dir', path.join(baseDir, 'dsh-runtime', '.pnpm-store'),
    '--cache-dir', path.join(baseDir, 'dsh-runtime', '.pnpm-cache'),
    '--registry', 'https://registry.npmjs.org',
    '--fetch-retries=0',
  ]);
  assert.equal(capture.opts[0]!.env!.NPM_CONFIG_USERCONFIG, path.join(baseDir, 'dsh-runtime', '.npmrc'));
});

test('installRuntimeVersion: writes work-dir preamble (package.json + pnpm-workspace.yaml allowBuilds all true) before pnpm', async () => {
  const baseDir = makeBaseDir();
  const capture = { args: [] as string[][], opts: [] as Array<{ cwd: string; env?: Record<string, string> }> };
  const res = await installRuntimeVersion({
    baseDir, version: '0.1.1-rc.2', registryOrigin: 'https://registry.npmjs.org',
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run: okRun(capture), prune: pruneOk, smoke: smokeOk },
  });
  // The work dir is renamed (atomic publish) to the version tree on success;
  // the preamble files ride the rename, so read them from the published tree.
  const cwd = res.versionTreeDir;
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, { '@deepseek-ai/dsh': '0.1.1-rc.2' });
  const yaml = readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
  // allowBuilds: only `true`, never `false`; the five single-source names.
  for (const name of ['node-pty', 'koffi', 'protobufjs', '@google/genai', '@deepseek-ai/dsh-subprocess-local']) {
    assert.ok(yaml.includes(`${JSON.stringify(name)}: true`), `allowBuilds ${name} must be true`);
  }
  assert.doesNotMatch(yaml, /: false/);
});

test('installRuntimeVersion: rejects an unsafe version string', async () => {
  const baseDir = makeBaseDir();
  await assert.rejects(
    installRuntimeVersion({
      baseDir, version: '../0.1.1', registryOrigin: 'https://registry.npmjs.org',
      pnpmEntry: '/pnpm/bin/pnpm.cjs',
      deps: { node: nodeFn, run: okRun({ args: [], opts: [] }), prune: pruneOk, smoke: smokeOk },
    }),
  );
});

test('installRuntimeVersion: retries once then succeeds', async () => {
  const baseDir = makeBaseDir();
  let calls = 0;
  const run = async (): Promise<RunResult> => {
    calls += 1;
    return calls === 1 ? { status: 1, stdout: '', stderr: 'transient koffi fetch fail' } : { status: 0, stdout: '', stderr: '' };
  };
  const res = await installRuntimeVersion({
    baseDir, version: '0.1.1-rc.2', registryOrigin: 'https://registry.npmjs.org',
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run, prune: pruneOk, smoke: smokeOk },
  });
  assert.equal(calls, 2);
  assert.equal(res.resolvedVersion, '0.1.1-rc.2');
});

test('installRuntimeVersion: retry still failing throws with sanitized detail', async () => {
  const baseDir = makeBaseDir();
  const run = async (): Promise<RunResult> => ({ status: 1, stdout: '', stderr: 'ERR_PNPM_IGNORED_BUILDS /abs/path' });
  await assert.rejects(
    installRuntimeVersion({
      baseDir, version: '0.1.1-rc.2', registryOrigin: 'https://registry.npmjs.org',
      pnpmEntry: '/pnpm/bin/pnpm.cjs',
      deps: { node: nodeFn, run, prune: pruneOk, smoke: smokeOk },
    }),
    /dsh runtime install failed/,
  );
});

test('installRuntimeVersion: smoke failure propagates', async () => {
  const baseDir = makeBaseDir();
  const run = async (): Promise<RunResult> => ({ status: 0, stdout: '', stderr: '' });
  const smoke = async (): Promise<void> => { throw new Error('dsh smoke check failed (exit 0, want 0.1.1-rc.2)'); };
  await assert.rejects(
    installRuntimeVersion({
      baseDir, version: '0.1.1-rc.2', registryOrigin: 'https://registry.npmjs.org',
      pnpmEntry: '/pnpm/bin/pnpm.cjs',
      deps: { node: nodeFn, run, prune: pruneOk, smoke },
    }),
    /dsh smoke check failed/,
  );
});

test('installRuntimeVersion: success publishes atomically with manifest', async () => {
  const baseDir = makeBaseDir();
  const run = async (): Promise<RunResult> => ({ status: 0, stdout: '', stderr: '' });
  const res = await installRuntimeVersion({
    baseDir, version: '0.1.1-rc.2', registryOrigin: 'https://registry.npmjs.org',
    pnpmEntry: '/pnpm/bin/pnpm.cjs',
    deps: { node: nodeFn, run, prune: pruneOk, smoke: smokeOk },
  });
  const tree = path.join(baseDir, 'dsh-runtime', '0.1.1-rc.2');
  assert.equal(res.versionTreeDir, tree);
  assert.ok(existsSync(path.join(tree, 'package.json')));
  const manifest = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { '@deepseek-ai/dsh': '0.1.1-rc.2' });
  assert.match(manifest.dsh.platform, /-/);
});

test('scrubInstallEnv: whitelists pnpm/network vars, scrubs secrets (design 16 §4 source pinning)', () => {
  const env = scrubInstallEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    XDG_CACHE_HOME: '/home/u/.cache',
    HTTP_PROXY: 'http://proxy:8080',
    HTTPS_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost',
    npm_config_registry: 'https://evil.example',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GIT_TOKEN: 'token',
    NODE_ENV: 'production',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.HTTP_PROXY, 'http://proxy:8080');
  assert.equal(env.npm_config_registry, undefined); // npm_config_* scrubbed (MITM surface)
  assert.equal(env.SSH_AUTH_SOCK, undefined); // secret scrubbed
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GIT_TOKEN, undefined);
  assert.equal(env.NODE_ENV, undefined);
});
