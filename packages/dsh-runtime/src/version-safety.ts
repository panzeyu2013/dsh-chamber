/**
 * dsh 运行时版本串预校验——纯逻辑，无 electron。registry 返回/用户输入的版本串在进入任何
 * 路径（版本树目录名、指针、override、failures 记录）之前必须通过 EXACT_SEMVER 预校验并
 * 拒绝 `/`、`\`、`..`；本模块与 bundle-dsh.mjs 的 EXACT_SEMVER 保持同一正则。
 *
 * 本模块同时是 semver 优先级比较的唯一实现（compareSemverAsc）：registry metadata 排序、
 * 选择器列表排序与 compareRuntimeVersions 都消费它，避免第二套比较器在预发布/build
 * metadata 上漂移。
 */
export const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * 版本串是否安全：trim 后精确匹配 EXACT_SEMVER，且不含 `/`、`\`、`..`。
 * EXACT_SEMVER 已排除前两者与单独的 `.` 标识符；`..` 检查是纵深防御（版本串可能来自
 * 不可信输入，防范任何未来正则放宽）。
 */
export function isSafeVersion(raw: string): boolean {
  const trimmed = raw.trim();
  if (!EXACT_SEMVER.test(trimmed)) return false;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return false;
  return true;
}

/** 断言版本串安全并返回 trim 后的串；不安全则 throw（错误信息含原始串，便于定位来源）。 */
export function assertSafeVersion(raw: string): string {
  const trimmed = raw.trim();
  if (!isSafeVersion(trimmed)) {
    throw new Error(
      `不安全的 dsh 运行时版本串 ${JSON.stringify(raw)}：必须是精确 semver（X.Y.Z[-prerelease]）且不含 /、\\、..`,
    );
  }
  return trimmed;
}

/** 解析精确 semver 为数字段 + prerelease 标识符数组（build metadata 不参与优先级）；
 *  非法串（不匹配 EXACT_SEMVER）→ null。 */
function parseSemverTriple(
  v: string,
): { major: string; minor: string; patch: string; prerelease: string[] } | null {
  if (!EXACT_SEMVER.test(v)) return null;
  const plus = v.indexOf('+');
  const withoutBuild = plus === -1 ? v : v.slice(0, plus);
  const dash = withoutBuild.indexOf('-');
  const nums = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  const [major, minor, patch] = nums.split('.') as [string, string, string];
  return { major, minor, patch, prerelease: pre === '' ? [] : pre.split('.') };
}

/** 纯数字标识符按数值比较：先比长度再比字典序，避免 Number() 精度损失。 */
function compareNumericText(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * 升序 semver 优先级比较（全包唯一实现）：数字段逐段比较；数字段相等时 release >
 * prerelease；prerelease 标识符按 semver 规则（纯数字按数值、字母数字按 ASCII 字典序、
 * 纯数字 < 字母数字，列表长者优先级更高）；build metadata 不参与；非法串排最后
 * （恒大于合法串），保证列表不因脏数据崩溃。
 */
export function compareSemverAsc(a: string, b: string): number {
  const pa = parseSemverTriple(a);
  const pb = parseSemverTriple(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  for (const [left, right] of [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch],
  ] as const) {
    const compared = compareNumericText(left, right);
    if (compared !== 0) return compared;
  }
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
      const compared = compareNumericText(x, y);
      if (compared !== 0) return compared;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1; // 纯数字 < 字母数字
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII 字典序
    }
  }
  return pa.prerelease.length - pb.prerelease.length; // 列表长者优先级更高
}
