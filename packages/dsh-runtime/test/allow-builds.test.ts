/**
 * allow-builds.mjs 单一来源常量测试（design 18 §4 R3-2 F6/F7、R3-5 P2-3）——
 * bundle-dsh.mjs 与运行期安装器编译产物必须同源；白名单 miss 是硬失败
 * （ERR_PNPM_IGNORED_BUILDS），此处钉死 6 项精确内容防漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW_BUILDS, DENY_BUILDS, renderAllowBuildsBlock } from '../src/allow-builds.mjs';

test('ALLOW_BUILDS: 可 import 且数组内容正确（6 项，与设计 18 §4 一致）', () => {
  assert.deepEqual(ALLOW_BUILDS, [
    'node-pty',
    'koffi',
    'fs-ext',
    'protobufjs',
    '@google/genai',
    '@deepseek-ai/dsh-subprocess-local',
  ]);
});

test('DENY_BUILDS: 显式否认项（strictDepBuilds 下未列出即硬失败，必须登记）', () => {
  // node-addon-require-builtin rides the published closure (41 lockfile hits)
  // but ships NO install lifecycle script at 0.1.4 — the entry is defensive
  // parity with the upstream pnpm-workspace deny list (2026-09 audit).
  assert.deepEqual(DENY_BUILDS, ['msgpackr-extract', 'node-addon-require-builtin']);
});

test('renderAllowBuildsBlock: 放行项 true、否认项 false，两个生成点共用同一渲染', () => {
  const block = renderAllowBuildsBlock();
  for (const name of ALLOW_BUILDS) assert.ok(block.includes(`${JSON.stringify(name)}: true`), name);
  for (const name of DENY_BUILDS) assert.ok(block.includes(`${JSON.stringify(name)}: false`), name);
  assert.equal(block.split('\n').length, ALLOW_BUILDS.length + DENY_BUILDS.length);
});
