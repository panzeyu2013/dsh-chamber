/**
 * allow-builds.mjs 单一来源常量测试（design 18 §4 R3-2 F6/F7、R3-5 P2-3）——
 * bundle-dsh.mjs 与运行期安装器编译产物必须同源；白名单 miss 是硬失败
 * （ERR_PNPM_IGNORED_BUILDS），此处钉死 5 项精确内容防漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW_BUILDS } from '../src/allow-builds.mjs';

test('ALLOW_BUILDS: 可 import 且数组内容正确（5 项，与设计 18 §4 一致）', () => {
  assert.deepEqual(ALLOW_BUILDS, [
    'node-pty',
    'koffi',
    'protobufjs',
    '@google/genai',
    '@deepseek-ai/dsh-subprocess-local',
  ]);
});
