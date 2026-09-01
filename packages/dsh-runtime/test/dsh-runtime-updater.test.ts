/**
 * dsh-runtime-updater.ts 纯逻辑测试（design 18 §3.6 编排守卫）——node:test，
 * 无 electron。覆盖：SingleFlight 单飞互斥（二次 tryBegin false / end 后可再入 /
 * inFlight 态）、isNoopSelection 三态、buildVersionList（active 置顶去重 / latest
 * 标记 / 降序 / cached 标记 / belowBaseline 与基线空不标 / byVersion 缺失跳过）、
 * versionExists（integrity 可空的放宽语义）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SingleFlight,
  bindRuntimeInstallResolution,
  buildVersionList,
  compareRuntimeVersions,
  isNoopSelection,
  versionExists,
} from '../src/dsh-runtime-updater.ts';

const VALID_SRI = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`;

function makeMeta(
  versions: string[],
  latest: string | null,
  tarballFor: (v: string) => string = (v) => `https://registry.npmjs.org/dsh/-/dsh-${v}.tgz`,
  integrityFor: (v: string) => string | null = () => null,
): {
  latest: string | null;
  versions: string[];
  byVersion: ReadonlyMap<string, { version: string; tarball: string; integrity: string | null }>;
  packageName: string;
  origin: string;
} {
  const byVersion = new Map(
    versions.map((v) => [v, { version: v, tarball: tarballFor(v), integrity: integrityFor(v) }]),
  );
  return {
    packageName: '@deepseek-ai/dsh',
    origin: 'https://registry.npmjs.org',
    latest,
    versions,
    byVersion,
  };
}

// ---------------------------------------------------------------------------
// SingleFlight
// ---------------------------------------------------------------------------

test('SingleFlight: tryBegin 首次成功置位，inFlight 为 true', () => {
  const flight = new SingleFlight();
  assert.equal(flight.inFlight, false);
  assert.equal(flight.tryBegin(), true);
  assert.equal(flight.inFlight, true);
});

test('SingleFlight: 在途期间二次 tryBegin 返回 false（互斥，覆盖整个 install 窗口）', () => {
  const flight = new SingleFlight();
  assert.equal(flight.tryBegin(), true);
  assert.equal(flight.tryBegin(), false);
  assert.equal(flight.tryBegin(), false);
  assert.equal(flight.inFlight, true);
});

test('SingleFlight: end 结束在途后可再入（inFlight 回到 false）', () => {
  const flight = new SingleFlight();
  assert.equal(flight.tryBegin(), true);
  flight.end();
  assert.equal(flight.inFlight, false);
  assert.equal(flight.tryBegin(), true, 'end 后应可再次进入在途');
  assert.equal(flight.tryBegin(), false, '再次进入后恢复互斥');
  flight.end();
  assert.equal(flight.inFlight, false);
});

test('SingleFlight: 不在途时调用 end 无副作用，仍可正常 tryBegin', () => {
  const flight = new SingleFlight();
  flight.end();
  assert.equal(flight.inFlight, false);
  assert.equal(flight.tryBegin(), true);
});

// ---------------------------------------------------------------------------
// isNoopSelection
// ---------------------------------------------------------------------------

test('isNoopSelection: chosen 与 active 都非 null 且相等 → true（选择当前激活版本 = 无操作）', () => {
  assert.equal(isNoopSelection('1.2.3', '1.2.3'), true);
});

test('isNoopSelection: chosen 为 null 或 active 为 null → false（三态中的空态）', () => {
  assert.equal(isNoopSelection(null, '1.2.3'), false);
  assert.equal(isNoopSelection('1.2.3', null), false);
  assert.equal(isNoopSelection(null, null), false);
});

test('isNoopSelection: 两者不等 → false', () => {
  assert.equal(isNoopSelection('1.2.3', '2.0.0'), false);
  assert.equal(isNoopSelection('1.2.3', '1.2.3-rc.1'), false);
});

// ---------------------------------------------------------------------------
// buildVersionList
// ---------------------------------------------------------------------------

test('buildVersionList: active 版本置顶且去重（只出现一次）', () => {
  const meta = makeMeta(['0.9.0', '1.0.0', '1.1.0', '2.0.0'], '2.0.0');
  const entries = buildVersionList(meta, { active: '1.0.0', cachedVersions: [], compatibilityBaseline: null });
  assert.deepEqual(
    entries.map((e) => e.version),
    ['1.0.0', '2.0.0', '1.1.0', '0.9.0'],
    'active 应第一个，其余按 semver 降序，active 不重复出现',
  );
  assert.equal(entries[0].version, '1.0.0');
  assert.equal(entries.filter((e) => e.version === '1.0.0').length, 1, 'active 去重');
});

test('buildVersionList: 列表 = active 置顶 + 纯 semver 降序；latest 只留标记、不再钉位（决策 11）', () => {
  // npm dist-tags.latest 可能是低于内建基线的旧版本（2026-10 用户场景：latest=rc.2
  // < 内建 alpha.2）：不得把 latest 钉到第二位，否则无标签解释的乱序。
  const meta = makeMeta(['0.9.0', '1.0.0', '1.1.0', '2.0.0-rc.1', '2.0.0'], '1.0.0');
  const entries = buildVersionList(meta, { active: '2.0.0-rc.1', cachedVersions: [], compatibilityBaseline: null });
  assert.deepEqual(
    entries.map((e) => e.version),
    ['2.0.0-rc.1', '2.0.0', '1.1.0', '1.0.0', '0.9.0'],
    'active 置顶，其余纯降序（latest=1.0.0 不钉位）',
  );
  assert.equal(entries.find((e) => e.version === '1.0.0')?.latest, true, 'latest 标记仍在对应条目上');

  // latest === active：置顶条目本身即 latest，不重复出现。
  const activeIsLatest = buildVersionList(makeMeta(['0.9.0', '1.0.0', '1.1.0', '2.0.0'], '2.0.0'), {
    active: '2.0.0', cachedVersions: [], compatibilityBaseline: null,
  });
  assert.deepEqual(
    activeIsLatest.map((e) => e.version),
    ['2.0.0', '1.1.0', '1.0.0', '0.9.0'],
    'active 即 latest 时仅置顶一次',
  );
  assert.equal(activeIsLatest.filter((e) => e.latest).length, 1);

  // latest 不可列出（无 tarball / 被 yank）：不出现。
  const yanked = {
    latest: '3.0.0',
    versions: ['1.0.0', '2.0.0'],
    byVersion: new Map([
      ['1.0.0', { version: '1.0.0', tarball: 'https://registry.npmjs.org/dsh/-/dsh-1.0.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['2.0.0', { version: '2.0.0', tarball: 'https://registry.npmjs.org/dsh/-/dsh-2.0.0.tgz', integrity: 'sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }],
    ]),
  };
  const yankedEntries = buildVersionList(yanked, { active: '1.0.0', cachedVersions: [], compatibilityBaseline: null });
  assert.deepEqual(
    yankedEntries.map((e) => e.version),
    ['1.0.0', '2.0.0'],
    'latest 不可列出时保持降序，不出现 3.0.0',
  );
});

test('buildVersionList: latest 标记 dist-tags.latest 对应条目，其余为 false；latest 为空恒 false', () => {
  const meta = makeMeta(['1.0.0', '1.1.0', '2.0.0-rc.1', '2.0.0'], '2.0.0');
  const entries = buildVersionList(meta, { active: null, cachedVersions: [], compatibilityBaseline: null });
  const latestEntry = entries.find((e) => e.latest);
  assert.ok(latestEntry, '应恰有一条 latest 标记');
  assert.equal(latestEntry!.version, '2.0.0');
  assert.equal(entries.filter((e) => e.latest).length, 1);

  const noLatest = buildVersionList(
    makeMeta(['1.0.0', '1.1.0'], null),
    { active: null, cachedVersions: [], compatibilityBaseline: null },
  );
  assert.ok(noLatest.every((e) => e.latest === false), 'meta.latest 为 null 时无任何推荐标记');
});

test('buildVersionList: 其余版本按 semver 降序（数字段 + prerelease：release > prerelease、长列表优先）', () => {
  const meta = makeMeta(
    ['1.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.1', '2.0.0-rc.1', '2.0.0', '0.9.0'],
    null,
  );
  const entries = buildVersionList(meta, { active: null, cachedVersions: [], compatibilityBaseline: null });
  assert.deepEqual(
    entries.map((e) => e.version),
    ['2.0.0', '2.0.0-rc.1', '1.0.1', '1.0.0', '1.0.0-alpha.beta', '1.0.0-alpha.1', '1.0.0-alpha', '0.9.0'],
    '数字段降序；同数字段 release 在 prerelease 前；prerelease 长标识符列表优先、纯数字低于字母数字',
  );
});

test('buildVersionList: cached 标记 = version ∈ cachedVersions（离线缓存版本）', () => {
  const meta = makeMeta(['1.0.0', '1.1.0', '2.0.0'], '2.0.0');
  const entries = buildVersionList(meta, {
    active: null,
    cachedVersions: ['1.0.0', '2.0.0'],
    compatibilityBaseline: null,
  });
  const cached = new Map(entries.map((e) => [e.version, e.cached]));
  assert.equal(cached.get('1.0.0'), true);
  assert.equal(cached.get('2.0.0'), true);
  assert.equal(cached.get('1.1.0'), false, '不在 cachedVersions 的不标记');
  assert.ok(entries.every((entry) => !('tarball' in entry) && !('integrity' in entry)), 'IPC projection must not expose supply-chain metadata');
});

test('buildVersionList: belowBaseline 标记低于基线的版本；等于/高于不标；基线为 null 恒 false', () => {
  const meta = makeMeta(['0.9.0', '1.0.0', '1.0.1', '1.1.0'], '1.1.0');
  const entries = buildVersionList(meta, {
    active: null,
    cachedVersions: [],
    compatibilityBaseline: '1.0.0',
  });
  const flags = new Map(entries.map((e) => [e.version, e.belowBaseline]));
  assert.equal(flags.get('0.9.0'), true, '严格低于基线 → 警示');
  assert.equal(flags.get('1.0.0'), false, '等于基线不警示');
  assert.equal(flags.get('1.0.1'), false, '高于基线不警示');
  assert.equal(flags.get('1.1.0'), false);

  const noBaseline = buildVersionList(meta, {
    active: null,
    cachedVersions: [],
    compatibilityBaseline: null,
  });
  assert.ok(noBaseline.every((e) => e.belowBaseline === false), '基线为空时不标任何警示');
});

test('buildVersionList: active remains visible while unusable registry-only entries are skipped', () => {
  const meta = makeMeta(['1.0.0', '1.1.0', '2.0.0', '9.9.9'], '9.9.9');
  // 篡改：9.9.9 从 byVersion 剔除，2.0.0 的 tarball 置空。
  const byVersion = new Map(meta.byVersion);
  byVersion.delete('9.9.9');
  byVersion.set('2.0.0', { version: '2.0.0', tarball: '', integrity: null });
  const entries = buildVersionList(
    { latest: '9.9.9', versions: meta.versions, byVersion },
    { active: '9.9.9', cachedVersions: [], compatibilityBaseline: null },
  );
  assert.deepEqual(
    entries.map((e) => e.version),
    ['9.9.9', '1.1.0', '1.0.0'],
    'active is a local runtime fact and stays first; other registry entries still require a tarball',
  );
  assert.equal(entries[0]?.latest, true, 'the retained active entry may also carry the metadata recommendation');
});

test('buildVersionList: validated cached trees are unioned even after registry yank', () => {
  const meta = makeMeta(['2.0.0', '1.5.0'], '2.0.0');
  const entries = buildVersionList(meta, {
    active: '1.5.0',
    cachedVersions: ['1.5.0', '1.2.3', '0.9.0-rc.1', '../unsafe'],
    compatibilityBaseline: '1.0.0',
  });
  assert.deepEqual(entries.map((entry) => entry.version), [
    '1.5.0',
    '2.0.0',
    '1.2.3',
    '0.9.0-rc.1',
  ]);
  assert.equal(entries.find((entry) => entry.version === '1.2.3')?.cached, true);
  assert.equal(entries.find((entry) => entry.version === '0.9.0-rc.1')?.belowBaseline, true);
  assert.equal(entries.some((entry) => entry.version === '../unsafe'), false);
});

// ---------------------------------------------------------------------------
// versionExists
// ---------------------------------------------------------------------------

test('versionExists: byVersion 有记录且 tarball 非空（含 integrity）→ true', () => {
  const meta = makeMeta(
    ['1.0.0'],
    null,
    (v) => `https://registry.npmjs.org/dsh/-/dsh-${v}.tgz`,
    () => VALID_SRI,
  );
  assert.equal(versionExists(meta, '1.0.0'), true);
});

test('versionExists: 缺 integrity 但有 tarball → false（不可进入安装路径）', () => {
  const meta = makeMeta(['1.0.0'], null);
  assert.equal(meta.byVersion.get('1.0.0')!.integrity, null);
  assert.equal(versionExists(meta, '1.0.0'), false);
});

test('bindRuntimeInstallResolution: binds exact origin + tarball + integrity', () => {
  const meta = makeMeta(['1.0.0'], '1.0.0', undefined, () => VALID_SRI);
  const resolution = bindRuntimeInstallResolution(meta, '1.0.0', 'https://registry.npmjs.org/');
  assert.deepEqual(resolution, {
    packageName: '@deepseek-ai/dsh',
    version: '1.0.0',
    registryOrigin: 'https://registry.npmjs.org',
    tarball: 'https://registry.npmjs.org/dsh/-/dsh-1.0.0.tgz',
    integrity: VALID_SRI,
  });
  assert.ok(Object.isFrozen(resolution));
});

test('bindRuntimeInstallResolution: source change and missing SRI fail closed', () => {
  const meta = makeMeta(['1.0.0'], '1.0.0', undefined, () => VALID_SRI);
  assert.throws(
    () => bindRuntimeInstallResolution(meta, '1.0.0', 'https://registry.npmmirror.com'),
    /源已变更/,
  );
  const missingSri = makeMeta(['1.0.0'], '1.0.0');
  assert.throws(
    () => bindRuntimeInstallResolution(missingSri, '1.0.0', missingSri.origin),
    /integrity/,
  );
});

test('versionExists: 版本不在 byVersion 或 tarball 为空 → false', () => {
  const meta = makeMeta(['1.0.0'], null);
  assert.equal(versionExists(meta, '9.9.9'), false, '不在 byVersion → false');

  const byVersion = new Map(meta.byVersion);
  byVersion.set('2.0.0', { version: '2.0.0', tarball: '', integrity: null });
  assert.equal(
    versionExists({ byVersion }, '2.0.0'),
    false,
    'tarball 为空（registry 有版本但无下载地址）→ false',
  );
  assert.equal(versionExists({ byVersion: new Map() }, '1.0.0'), false, '空 byVersion → false');
});

test('compareRuntimeVersions: supports arbitrarily large numeric identifiers without precision loss', () => {
  assert.equal(compareRuntimeVersions('999999999999999999999.0.0', '2.0.0'), 1);
  assert.equal(compareRuntimeVersions('1.0.0-999999999999999999999', '1.0.0-2'), 1);
  assert.equal(compareRuntimeVersions('1.0.0+one', '1.0.0+two'), 0);
  assert.equal(compareRuntimeVersions('01.0.0', '1.0.0'), null);
});
