/**
 * dsh 运行时版本串预校验（design 16 §4「路径安全」）——纯逻辑，无 electron。
 *
 * registry 返回/用户输入的版本串在进入任何路径（版本树目录名、指针、override、
 * failures 记录）之前必须通过 EXACT_SEMVER 预校验并拒绝 `/`、`\`、`..`
 * （路径穿越面）。本模块与 bundle-dsh.mjs 的 EXACT_SEMVER 保持同一正则
 * （design 16 §4 路径安全与构建期同口径）。
 *
 * 本模块刻意 electron-free，可用 node:test 直接单测（version-safety.test.ts）。
 */
export const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * 版本串是否安全：trim 后精确匹配 EXACT_SEMVER，且不含 `/`、`\`、`..`。
 *
 * 语义上 EXACT_SEMVER 已排除 `/` 与 `\`（字符类不含），`..` 检查是纵深防御
 * （prerelease/build 段允许 `.` 与 `-`，形如 `1.0.0-..` 能过正则但必须拒绝）。
 */
export function isSafeVersion(raw: string): boolean {
  const trimmed = raw.trim();
  if (!EXACT_SEMVER.test(trimmed)) return false;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return false;
  return true;
}

/**
 * 断言版本串安全并返回 trim 后的版本串；不安全则 throw（错误信息含原始串，
 * 便于调用方/日志定位来源）。
 */
export function assertSafeVersion(raw: string): string {
  const trimmed = raw.trim();
  if (!isSafeVersion(trimmed)) {
    throw new Error(
      `不安全的 dsh 运行时版本串 ${JSON.stringify(raw)}：必须是精确 semver（如 0.1.1-rc.2）且不含 /、\\、..`,
    );
  }
  return trimmed;
}
