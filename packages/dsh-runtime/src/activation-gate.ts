/**
 * dsh 运行时激活门控裁决（design 18 §3.4）——纯逻辑、无 electron、无副作用
 * （M3）。探针列表本身（commands/execute 冒烟 / session 只读 list（兼作 host
 * 能力探测；host.describe 已在上游 dsh-v0.1.2-alpha.1 删除）/ graph 通道 /
 * settings RPC / git-worktree 只读 / 数据可读性探测）由 host 侧执行并汇成
 * `ProbeResult[]`；本模块只做裁决，不 spawn、不 fetch、不读盘：
 *
 *   1. `decideVerdict`    —— 探针裁决（pass / observe / fail），含「有界窗口 +
 *                           延迟裁决」语义（§3.4 探测窗口与裁决）；
 *   2. `rollbackTarget`   —— 自动回退目标选择（§3.4 回退目标统一口径，绝不在
 *                           两棵坏树间交替）；
 *   3. `shouldAutoRollback` —— 延迟崩溃分支谓词（§3.4 F7）：restart-exhausted
 *                           且激活树是 override 才触发一次自动回退。
 *
 * 边界（诚实声明，§3.4 激活门控边界）：探针是 host 侧探测；渲染侧（chamber
 * 前端 boot 实例 web 资产）不在门控内。裁决所需的探针结果、elapsed、
 * observedOnce 全部由调用方注入——本模块无跨调用状态，可被 node:test 直接
 * 单测（activation-gate.test.ts）。
 */

/**
 * The activation contract is deliberately closed. An empty/partial probe
 * list must never become a vacuous success when a caller forgets to wire one
 * of the Design 18 compatibility checks.
 *
 * Upstream dsh-v0.1.2-alpha.1 wire (audit W1/W2/W11/W12): all unary methods
 * moved to slash endpoints, `host.describe` was deleted and `workspace.list`
 * became the `workspace/follow` stream, so the probe set keeps only surviving
 * read-only unaries — `session/list` doubles as the host-capability probe.
 * Probe names mirror the wire endpoints (slash form).
 */
export const REQUIRED_ACTIVATION_PROBES = [
  'commands/execute',
  'session/list',
  'clientGraph/graph',
  'settings/describe',
  'gitWorktree/previewCreate',
  'data.settings',
  'data.sessions',
] as const;

/** The chamber host domains (clientGraph/graph + gitWorktree/previewCreate).
 * 2026-12 shape-awareness: the gateway shape only verifies them once a
 * connecting desktop has synced its host packages into the seed cache — a
 * fresh gateway hosts a plain dsh whose activation must pass without them. */
export const HOST_DOMAIN_PROBE_NAMES = [
  'clientGraph/graph',
  'gitWorktree/previewCreate',
] as const;

// Typed subtraction: the filter keeps the literal-typed tuple elements, so a
// typo'd domain name in HOST_DOMAIN_PROBE_NAMES fails to subtract and is
// caught by the reduced-set exact-match checks instead of silently passing.
type RequiredProbeName = typeof REQUIRED_ACTIVATION_PROBES[number]
type HostDomainProbeName = typeof HOST_DOMAIN_PROBE_NAMES[number]
const HOST_DOMAIN_PROBE_NAME_SET = new Set<string>(HOST_DOMAIN_PROBE_NAMES)

/** The reduced probe-name set for a shape that does not carry chamber host
 * domains (gateway without a synced seed cache). */
export const PROBE_NAMES_WITHOUT_HOST_DOMAINS: readonly Exclude<RequiredProbeName, HostDomainProbeName>[] =
  REQUIRED_ACTIVATION_PROBES.filter(name => !HOST_DOMAIN_PROBE_NAME_SET.has(name)) as readonly Exclude<RequiredProbeName, HostDomainProbeName>[];

/** 单条探针结果（host 侧执行汇总；name 用于完整性校验、日志与定位）。 */
export interface ProbeResult {
  /** 探针名（如 'commands/execute' / 'session/list' / 'data.sessions' …）。 */
  name: string;
  /** 探针是否通过；false 时建议附 error 说明失败原因（脱敏，design 18 §6）。 */
  ok: boolean;
  /** 失败原因（可选；仅在 ok === false 时语义有意义）。 */
  error?: string;
}

/** 激活裁决：pass = 探针全过；observe = 窗口内首次失败（延迟裁决）；fail = 回退。 */
export type ActivationVerdict = 'pass' | 'fail' | 'observe';

/** 默认探测窗口（§3.4「默认 ≤60s 超时」），毫秒。 */
export const DEFAULT_PROBE_WINDOW_MS = 60_000;

/**
 * 探针裁决（§3.4「探测窗口与裁决」）：
 *
 *   - 全部探针 ok（含空列表，空真）→ 'pass'；
 *   - 任一 fail：
 *       · 已 observe 过一次（opts.observedOnce）仍 fail → 'fail'——延迟裁决后
 *         再失败才回退，observe 只给一次二次确认窗口；
 *       · 首次失败 → 'observe'——§3.4「超时不立即判失败，进入继续观察 + 延迟
 *         裁决（给慢迁移二次确认窗口），再失败才回退」；窗口只约束单次探针时长
 *         （调用方用 elapsedMs 判超时），不改变「首败必 observe」的口径。
 *
 * `observedOnce` 由调用方传入「本激活已裁决过一次 observe」（本函数纯函数、
 * 不维护跨调用状态）；观察一次后若探针恢复全 ok，仍 'pass'（只有「仍失败」
 * 才 fail）。
 */
export function decideVerdict(
  probes: ProbeResult[],
  opts: {
    elapsedMs: number
    windowMs?: number
    observedOnce?: boolean
    /** Test/forward-compatibility seam; production uses the closed default. */
    expectedNames?: readonly string[]
  },
): ActivationVerdict {
  const expected = opts.expectedNames ?? REQUIRED_ACTIVATION_PROBES;
  const windowMs = opts.windowMs ?? DEFAULT_PROBE_WINDOW_MS;
  const counts = new Map<string, number>();
  for (const probe of probes) counts.set(probe.name, (counts.get(probe.name) ?? 0) + 1);
  const exactSet = probes.length === expected.length
    && expected.every((name) => counts.get(name) === 1)
    && probes.every((probe) => expected.includes(probe.name));
  const withinWindow = Number.isFinite(opts.elapsedMs)
    && opts.elapsedMs >= 0
    && Number.isFinite(windowMs)
    && windowMs > 0
    && opts.elapsedMs <= windowMs;
  if (exactSet && withinWindow && probes.every((p) => p.ok)) return 'pass';
  if (opts.observedOnce === true) return 'fail';
  return 'observe';
}

/** `rollbackTarget` 的输入：切换前后版本事实（全部由调用方从存储/探针注入）。 */
export interface RollbackTargetOptions {
  /** 切换前活跃版本（指针切换前的版本；null = 无切换前版本，如首次安装）。 */
  previousVersion: string | null;
  /** 切换前版本是否曾探针通过或为 known-good（§3.4 回退目标口径）。 */
  previousWasKnownGood: boolean;
  /** 最近 known-good 版本（known-good 维护推进后的当前值；null = 尚无）。 */
  knownGoodVersion: string | null;
}

/**
 * 自动回退目标（§3.4「回退目标（统一口径）」）：自动回退目标 = 切换前版本（若
 * 其曾探针通过或为 known-good），否则最近 known-good；都无 → null（落内建树 +
 * 响亮终态）。
 *
 * 优先级：
 *   1. previousVersion 非空且（previousWasKnownGood 或 previousVersion ===
 *      knownGoodVersion）→ previousVersion；
 *   2. 否则 → knownGoodVersion；
 *   3. 都无 → null。
 *
 * 返回值只会是 previousVersion（当它可信任）或 knownGoodVersion 或 null，绝不
 * 会是别的树——绝不在两棵坏树间交替。
 */
export function rollbackTarget(opts: RollbackTargetOptions): string | null {
  const { previousVersion, previousWasKnownGood, knownGoodVersion } = opts;
  if (previousVersion !== null && (previousWasKnownGood || previousVersion === knownGoodVersion)) {
    return previousVersion;
  }
  return knownGoodVersion;
}

/**
 * 延迟崩溃分支（§3.4 F7）谓词：restart-exhausted（窗口内 M=5 次重启，设计 02
 * §3.6；**注意与连续探活失败阈值 N=20 的宿主重启区分**——那是宿主重启，不是
 * 版本回退）且激活树是 override → 触发一次自动回退（复用本路径，作为状态机
 * 分支）。
 *
 * 纯谓词 = 两标志的合取；「触发一次」的幂等（回退后不再重复）由调用方状态机
 * 保证（回退后清除 override / 置位回退尝试标记）。
 */
export function shouldAutoRollback(restartExhausted: boolean, activeIsOverride: boolean): boolean {
  return restartExhausted && activeIsOverride;
}
