/**
 * dsh 运行时版本管理（design 16）——编排守卫纯逻辑（M2）。纯逻辑、无 electron、
 * 无 spawn / fetch / IPC，可用 node:test 直接单测（dsh-runtime-updater.test.ts）。
 *
 * 本模块只承担「守卫」职责（design 16 §3.6「单飞与幂等」 + §5 数据流）：
 *
 *   - SingleFlight：切换单飞守卫，覆盖整个 install 窗口（含 apply 全程）；
 *   - isNoopSelection：选择当前激活版本 = 无操作（选当前版本无动作）；
 *   - buildVersionList：版本选择器列表（当前版本置顶 + dist-tags.latest 推荐
 *     标记 + 其余 semver 降序 + 离线缓存版本标记 + 兼容基线以下警示）；
 *   - versionExists：版本存在门禁（design 16 §5「版本存在门禁（integrity）」）——
 *     语义放宽为只要求 byVersion 记录存在且 tarball 非空，integrity 可空
 *     （简略 packument 可能缺 integrity；完整性校验由安装层对顶层 tarball 负责）。
 *
 * 数据面（存储/指针/override）见 dsh-runtime-store.ts，安装/下载不在本模块。
 */
import { EXACT_SEMVER } from './version-safety.ts';

/**
 * 单飞守卫（design 16 §3.6「单飞守卫覆盖整个 install 窗口」）：整个切换流程
 * （安装 + apply 全程）只能有一个在途。tryBegin 成功置位返回 true；已有在途
 * 返回 false；end 结束在途后允许再入。
 */
export class SingleFlight {
  private busy = false;

  /** 尝试进入在途：已有在途 → false；否则置位并返回 true。 */
  tryBegin(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  /** 结束在途（无论是否在途都安全；不在途时调用无副作用）。 */
  end(): void {
    this.busy = false;
  }

  /** 是否有在途切换。 */
  get inFlight(): boolean {
    return this.busy;
  }
}

/**
 * 「选择当前激活版本 = 无操作」（design 16 §3.6）：chosen 与 active 都非 null
 * 且相等 → true；chosen null（未选）、active null（无激活版本）或两者不等 → false。
 */
export function isNoopSelection(chosen: string | null, active: string | null): boolean {
  return chosen !== null && active !== null && chosen === active;
}

/** 版本选择器条目（design 16 §3.6 前端显示规格 A.2）。 */
export interface VersionListEntry {
  version: string;
  tarball: string;
  integrity: string | null;
  /** dist-tags.latest 推荐标记（meta.latest 为 null 或不在列表时恒 false）。 */
  latest: boolean;
  /** 离线缓存版本标记：version ∈ cachedVersions。 */
  cached: boolean;
  /** 兼容基线以下警示：compatibilityBaseline 非空且 version 严格低于基线。 */
  belowBaseline: boolean;
}

/**
 * 解析精确 semver 为数字段 + prerelease 标识符数组（build metadata 不参与
 * 排序优先级）。非法串（不匹配 EXACT_SEMVER）→ null。
 */
function parseSemverTriple(
  v: string,
): { major: number; minor: number; patch: number; prerelease: string[] } | null {
  if (!EXACT_SEMVER.test(v)) return null;
  const plus = v.indexOf('+');
  const withoutBuild = plus === -1 ? v : v.slice(0, plus);
  const dash = withoutBuild.indexOf('-');
  const nums = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  const [major, minor, patch] = nums.split('.').map((segment) => Number(segment));
  return { major, minor, patch, prerelease: pre === '' ? [] : pre.split('.') };
}

/**
 * 升序 semver 比较（自实现，无 semver 依赖；design 16 §6「精确 semver」口径）：
 *
 *   - 数字段 major/minor/patch 逐段比较；
 *   - 数字段相等时：release > prerelease（升序时 prerelease 靠前）；
 *   - prerelease 标识符按 semver 规则：纯数字按数值、字母数字按 ASCII 字典序、
 *     纯数字 < 字母数字；标识符列表长者优先级更高（1.0.0-alpha < 1.0.0-alpha.1）；
 *   - build metadata（+ 段）不参与优先级；
 *   - 非法串（不匹配 EXACT_SEMVER）排最后（恒大于合法串），保证列表不因
 *     脏数据崩溃。`..` 类纵深防御不在本模块（见 version-safety.isSafeVersion）。
 */
function semverCompareAsc(a: string, b: string): number {
  const pa = parseSemverTriple(a);
  const pb = parseSemverTriple(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  const aPre = pa.prerelease.length > 0;
  const bPre = pb.prerelease.length > 0;
  if (aPre !== bPre) return aPre ? -1 : 1; // 升序：release 在后，prerelease 在前
  const common = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < common; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx - dy;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1; // 纯数字 < 字母数字
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII 字典序
    }
  }
  return pa.prerelease.length - pb.prerelease.length; // 列表长者优先级更高
}

/** 降序比较：升序结果取反（semverCompareAsc(b, a)）。 */
function semverCompareDesc(a: string, b: string): number {
  return semverCompareAsc(b, a);
}

/** 单条候选版本是否可入列表：byVersion 有记录、tarball 非空且为精确 semver。 */
function isListable(
  v: string,
  byVersion: ReadonlyMap<string, { version: string; tarball: string; integrity: string | null }>,
): boolean {
  const record = byVersion.get(v);
  return record !== undefined && record.tarball.length > 0 && EXACT_SEMVER.test(v);
}

/**
 * 构建版本选择器列表（design 16 §3.6 A.2 显示规格）：
 *
 *   1. active 版本置顶（存在且可列出则第一个，并从其余列表中去重，只出现一次）；
 *   2. latest 标记 dist-tags.latest 对应的那一个（不改变位置，仅置标记）；
 *   3. 其余按 semver 降序（自实现简单降序比较，见 semverCompareAsc）；
 *   4. cached 标记 = version ∈ cachedVersions（离线缓存版本）；
 *   5. belowBaseline = compatibilityBaseline 非空且 version 严格低于基线
 *      （基线为空或不合法则不标）；基线相等不算 below；
 *   6. byVersion 缺失（或 tarball 为空）的版本条目跳过——version 必须能在
 *      byVersion 找到 tarball，否则不出现。
 */
export function buildVersionList(
  meta: {
    latest: string | null;
    versions: string[];
    byVersion: ReadonlyMap<string, { version: string; tarball: string; integrity: string | null }>;
  },
  opts: { active: string | null; cachedVersions: string[]; compatibilityBaseline: string | null },
): VersionListEntry[] {
  const byVersion = meta.byVersion;
  const emitted = new Set<string>();
  const entries: VersionListEntry[] = [];

  const makeEntry = (v: string): VersionListEntry => {
    const record = byVersion.get(v)!;
    const baseline = opts.compatibilityBaseline;
    const belowBaseline =
      baseline !== null && EXACT_SEMVER.test(baseline) && semverCompareAsc(v, baseline) < 0;
    return {
      version: v,
      tarball: record.tarball,
      integrity: record.integrity,
      latest: meta.latest !== null && v === meta.latest,
      cached: opts.cachedVersions.includes(v),
      belowBaseline,
    };
  };

  // 1. active 置顶（存在则第一个；后续从其余列表剔除，天然去重）。
  if (opts.active !== null && isListable(opts.active, byVersion)) {
    entries.push(makeEntry(opts.active));
    emitted.add(opts.active);
  }

  // 2/3. 其余按 semver 降序（去重 + 跳过不可列出条目）。
  const rest = [...meta.versions]
    .filter((v) => !emitted.has(v) && isListable(v, byVersion))
    .sort(semverCompareDesc);
  for (const v of rest) {
    if (emitted.has(v)) continue; // meta.versions 内的重复项
    emitted.add(v);
    entries.push(makeEntry(v));
  }

  return entries;
}

/**
 * 版本存在门禁（design 16 §5「版本存在门禁」）：version 在 byVersion 中且
 * tarball 非空 → true，否则 false。integrity 可空——简略 packument 可能缺
 * integrity，门禁只验证版本真实存在于 registry 且可下载；完整性校验由安装层
 * 对顶层 tarball 负责（§6「完整性：顶层 tarball integrity（壳门禁）」）。
 */
export function versionExists(
  meta: {
    byVersion: ReadonlyMap<string, { version: string; tarball: string; integrity: string | null }>;
  },
  version: string,
): boolean {
  const record = meta.byVersion.get(version);
  return record !== undefined && record.tarball.length > 0;
}

/**
 * 离线缓存版本列表（design 16 §3.6 A.2「自由回滚的 UI 基础」）：registry 元数据
 * 不可得时（check 失败 → lastMeta null），用本地已装版本树构建选择器列表——全部
 * 标记 `cached`、无 tarball/integrity/latest/belowBaseline，active 置顶。这样断网
 * /镜像挂时用户仍可回滚到任一已缓存版本。
 */
export function buildCachedVersionList(cachedVersions: string[], active: string | null): VersionListEntry[] {
  const entries: VersionListEntry[] = [];
  const seen = new Set<string>();
  const add = (v: string): void => {
    if (seen.has(v)) return;
    seen.add(v);
    entries.push({ version: v, tarball: '', integrity: null, latest: false, cached: true, belowBaseline: false });
  };
  if (active !== null) add(active);
  for (const v of cachedVersions) add(v);
  return entries;
}
