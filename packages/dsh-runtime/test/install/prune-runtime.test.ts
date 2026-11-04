/**
 * prune-runtime.mjs 规则测试（design 18 §3.7 / §4.1）——`docs/` 下的 Markdown 是
 * 插件管理器 bundle 详情页的运行时内容（locale `meta.detail` 指名），任意深度保留；
 * `PRUNE_DIR_NAMES` 的附属物目录即使位于 `docs/` 内也整目录删除（已知例外）；
 * `collectDeclaredDetailFiles` 只认上游 `dsh-plugin-detail` 接受的声明，供
 * bundle-dsh 在 prune 前后核对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PRUNE_RULES_REVISION,
  collectDeclaredDetailFiles,
  pruneRuntimeArtifacts,
} from '../../src/prune-runtime.mjs';

/** A throwaway install tree whose paths are written as posix-relative strings. */
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prune-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = (rel: string) => join(root, ...rel.split('/'));
  return {
    root,
    put(rel: string, content = 'x'): string {
      mkdirSync(dirname(at(rel)), { recursive: true });
      writeFileSync(at(rel), content);
      return at(rel);
    },
    has: (rel: string) => existsSync(at(rel)),
  };
}

const locale = (meta: unknown) => JSON.stringify({ meta });

test('pruneRuntimeArtifacts: docs/ 下的 Markdown 任意深度保留（design 18 §3.7）', (t) => {
  const tree = fixture(t);
  const kept = [
    'node_modules/@deepseek-ai/x/docs/DETAIL.md',
    'node_modules/@deepseek-ai/x/docs/DETAIL.zh.md',
    'node_modules/@deepseek-ai/x/docs/notes.markdown',
    'node_modules/@deepseek-ai/x/docs/docs/api/Fetch.md',
    'node_modules/@deepseek-ai/x/Docs/UP.md',
  ];
  const pruned = [
    'node_modules/@deepseek-ai/x/docs/type.d.ts',
    'node_modules/@deepseek-ai/x/docs/x.map',
    'node_modules/@deepseek-ai/x/README.md',
    'node_modules/@deepseek-ai/x/CHANGELOG.md',
  ];
  for (const rel of kept) tree.put(rel, '# doc');
  for (const rel of pruned) tree.put(rel);
  tree.put('node_modules/@deepseek-ai/x/lib/index.js');

  const result = pruneRuntimeArtifacts(tree.root);

  for (const rel of kept) assert.ok(tree.has(rel), `${rel} must survive the prune`);
  for (const rel of pruned) assert.ok(!tree.has(rel), `${rel} must be pruned`);
  assert.ok(tree.has('node_modules/@deepseek-ai/x/lib/index.js'));
  assert.deepEqual(result, { removedFiles: 4, removedDirs: 0 });
});

test('pruneRuntimeArtifacts: 附属物目录在 docs/ 内仍整目录删除（已知例外）', (t) => {
  const tree = fixture(t);
  tree.put('node_modules/@deepseek-ai/x/docs/DETAIL.md');
  tree.put('node_modules/@deepseek-ai/x/docs/test/fixture.md');
  tree.put('node_modules/@deepseek-ai/x/docs/examples/demo.js');

  const result = pruneRuntimeArtifacts(tree.root);

  assert.ok(tree.has('node_modules/@deepseek-ai/x/docs/DETAIL.md'));
  assert.equal(tree.has('node_modules/@deepseek-ai/x/docs/test'), false);
  assert.equal(tree.has('node_modules/@deepseek-ai/x/docs/examples'), false);
  assert.deepEqual(result, { removedFiles: 2, removedDirs: 2 });
});

test('collectDeclaredDetailFiles: 收集存在的合法声明（去重、排序、相对包含 locale 的目录解析）', (t) => {
  const tree = fixture(t);
  const first = tree.put('node_modules/@deepseek-ai/a/docs/DETAIL.md');
  tree.put('node_modules/@deepseek-ai/a/locale/en.json', locale({ detail: 'docs/DETAIL.md' }));
  tree.put('node_modules/@deepseek-ai/a/locale/zh.json', locale({ detail: 'docs/DETAIL.md' }));
  const second = tree.put('node_modules/@deepseek-ai/b/dist/docs/N.md');
  tree.put('node_modules/@deepseek-ai/b/dist/locale/en.json', locale({ detail: 'docs/N.md' }));

  assert.deepEqual(collectDeclaredDetailFiles(tree.root), [first, second].sort());
});

test('collectDeclaredDetailFiles: 畸形声明、不存在的目标与非 JSON locale 文件都跳过', (t) => {
  const tree = fixture(t);
  const only = tree.put('node_modules/@deepseek-ai/a/docs/OK.md');
  const dir = 'node_modules/@deepseek-ai/a/locale';
  tree.put(`${dir}/en.json`, locale({ detail: 'docs/OK.md' }));
  tree.put(`${dir}/scheme.json`, locale({ detail: 'https://example.com/x.md' }));
  tree.put(`${dir}/traversal.json`, locale({ detail: '../escape.md' }));
  tree.put(`${dir}/empty-segment.json`, locale({ detail: 'docs//x.md' }));
  tree.put(`${dir}/extension.json`, locale({ detail: 'docs/x.txt' }));
  tree.put(`${dir}/blank.json`, locale({ detail: '   ' }));
  tree.put(`${dir}/missing.json`, locale({ detail: 'docs/MISSING.md' }));
  tree.put(`${dir}/broken.json`, '{not json');
  tree.put(`${dir}/notes.txt`, locale({ detail: 'docs/OK.md' }));

  assert.deepEqual(collectDeclaredDetailFiles(tree.root), [only]);
});

test('collectDeclaredDetailFiles + prune: docs 内的声明目标存活，docs 外的被裁掉（bundle-dsh 因此失败）', (t) => {
  const tree = fixture(t);
  tree.put('node_modules/@deepseek-ai/a/docs/DETAIL.md');
  tree.put('node_modules/@deepseek-ai/a/locale/en.json', locale({ detail: 'docs/DETAIL.md' }));
  const outside = tree.put('node_modules/@deepseek-ai/b/DETAIL.md');
  tree.put('node_modules/@deepseek-ai/b/locale/en.json', locale({ detail: 'DETAIL.md' }));

  // bundle-dsh 的顺序：先记录声明目标，再裁剪，最后核对删掉了谁。
  const declared = collectDeclaredDetailFiles(tree.root);
  pruneRuntimeArtifacts(tree.root);

  assert.deepEqual(declared.filter((file) => !existsSync(file)), [outside]);
  assert.equal(declared.length, 2);
});

test('PRUNE_RULES_REVISION: 规则集版本显式登记（改规则即改版本与封装跳过语义）', () => {
  assert.equal(PRUNE_RULES_REVISION, 1);
});
