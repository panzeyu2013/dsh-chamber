/**
 * 运行时激活门控裁决——纯逻辑、无 electron、无副作用。探针列表由 host 侧执行并汇成
 * `ProbeResult[]`（commands/execute 冒烟 / 固定小体积身份方法
 * `session/canOpenWorkspacePath`（零参 boolean Remote，绝不读会话数据；老 runtime 树
 * 答 404 时由 host 侧回退 legacy session/list）/ graph 通道 / settings RPC /
 * git-worktree 只读 / archive-cleanup 只读 / 数据可读性）；本模块只做裁决，
 * 不 spawn、不 fetch、不读盘。
 *
 *  1. `decideVerdict` —— 探针裁决（pass / observe / fail），含「有界窗口 + 延迟裁决」；
 *  2. `rollbackTarget` —— 自动回退目标选择（绝不在两棵坏树间交替）；
 *  3. `shouldAutoRollback` —— restart-exhausted 且激活树是 override 时触发一次自动回退。
 *
 * 边界：探针是 host 侧探测，渲染侧不在门控内；裁决输入全部由调用方注入，本模块无跨调用状态。
 */

/**
 * The activation contract is deliberately closed: an empty/partial probe list must
 * never become a vacuous success when a caller forgets to wire a compatibility check.
 *
 * Wire baseline: the pinned upstream tree's surviving read-only unaries (slash-form
 * names; `host.describe` is deleted and `workspace.list` is now a stream). The
 * host-capability role is the fixed-size `session/canOpenWorkspacePath` boolean
 * Remote (pure platform detection, no session data, no Agent activation, no IO), so
 * responses never grow with session count; pre-identity trees answer 404 and are
 * served by the probe layer's legacy session/list fallback. `data.sessions` is
 * deliberately not part of the set: session storage health is not in the contract.
 */
export const REQUIRED_ACTIVATION_PROBES = [
  'commands/execute',
  'session/canOpenWorkspacePath',
  'clientGraph/graph',
  'settings/describe',
  'gitWorktree/previewCreate',
  'archiveCleanup/probe',
  'openInApp/probe',
  'data.settings',
] as const;

/** The chamber host domains (clientGraph/graph + gitWorktree/previewCreate +
 *  archiveCleanup/probe + openInApp/probe). A fresh gateway hosts a plain dsh whose
 *  activation must pass without them; expected domains are derived per spawn from the
 *  actually seeded entries and the typed subtraction below keeps the reduced set in
 *  lockstep. `openInApp/probe` backs a LOCAL-shape-only registry row, so it is never
 *  part of a remote/gateway derived expectation, but stays listed here because the
 *  gateway's load-time pin compares this set wholesale. */
export const HOST_DOMAIN_PROBE_NAMES = [
  'clientGraph/graph',
  'gitWorktree/previewCreate',
  'archiveCleanup/probe',
  'openInApp/probe',
] as const;

// Typed subtraction keeps the literal-typed tuple elements, so a typo'd domain name
// fails to subtract and is caught by the reduced-set exact-match checks.
type RequiredProbeName = typeof REQUIRED_ACTIVATION_PROBES[number]
type HostDomainProbeName = typeof HOST_DOMAIN_PROBE_NAMES[number]
const HOST_DOMAIN_PROBE_NAME_SET = new Set<string>(HOST_DOMAIN_PROBE_NAMES)

/** The reduced probe-name set for a shape that does not carry chamber host domains. */
export const PROBE_NAMES_WITHOUT_HOST_DOMAINS: readonly Exclude<RequiredProbeName, HostDomainProbeName>[] =
  REQUIRED_ACTIVATION_PROBES.filter(name => !HOST_DOMAIN_PROBE_NAME_SET.has(name)) as readonly Exclude<RequiredProbeName, HostDomainProbeName>[];

/**
 * Expected activation set for a shape carrying EXACTLY the given chamber host domains:
 * the closed base set plus every listed domain, in REQUIRED order. Unknown names FAIL
 * LOUD — silently dropping a listed domain would shrink its probe row out of the
 * expected set AND the run legs, letting a dead/unmounted chamber domain pass
 * activation until the sidebar 404s (fail-open); unknown names come from our own
 * seed/probe metadata, so they are cross-package drift and must surface. The full list
 * equals REQUIRED_ACTIVATION_PROBES, an empty list equals PROBE_NAMES_WITHOUT_HOST_DOMAINS.
 */
export function activationProbeNamesForDomains(domains: readonly string[]): readonly string[] {
  // Fail LOUD on an unrecognized domain: ignoring it would drop its probe row from the
  // expected set and the run legs, letting a dead domain pass activation until the sidebar 404s.
  const unknown = domains.filter(name => !HOST_DOMAIN_PROBE_NAME_SET.has(name))
  if (unknown.length > 0) {
    throw new Error(`unknown chamber host probe domain(s): ${[...new Set(unknown)].join(', ')}`)
  }
  const wanted = new Set<string>(domains)
  return REQUIRED_ACTIVATION_PROBES.filter(
    name => !HOST_DOMAIN_PROBE_NAME_SET.has(name) || wanted.has(name),
  )
}

/** 单条探针结果（host 侧执行汇总；name 用于完整性校验、日志与定位）。 */
export interface ProbeResult {
  /** 探针名（如 'commands/execute' / 'session/canOpenWorkspacePath' / 'data.settings' …）。 */
  name: string;
  /** 探针是否通过；false 时建议附 error 说明失败原因（脱敏，design 18 §6）。 */
  ok: boolean;
  /** 失败原因（可选；仅在 ok === false 时语义有意义）。 */
  error?: string;
}

/** 激活裁决：pass = 探针全过；observe = 窗口内首次失败（延迟裁决）；fail = 回退。 */
export type ActivationVerdict = 'pass' | 'fail' | 'observe';

/** 默认探测窗口（≤60s），毫秒。 */
export const DEFAULT_PROBE_WINDOW_MS = 60_000;

/**
 * 探针裁决：全部 ok（含空列表，空真）→ 'pass'；任一 fail 且已 observe 过一次
 * （opts.observedOnce）→ 'fail'；首次失败 → 'observe'——超时不立即判失败，给慢迁移
 * 一次二次确认窗口，再失败才回退。窗口只约束单次探针时长（调用方用 elapsedMs 判超时），
 * 不改变「首败必 observe」的口径；观察一次后恢复全 ok 仍 'pass'。
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
 * 自动回退目标：切换前版本（若其曾探针通过或为 known-good），否则最近 known-good；
 * 都无 → null（落内建树 + 响亮终态）。
 *
 * 优先级：1. previousVersion 非空且（previousWasKnownGood 或 === knownGoodVersion）
 * → previousVersion；2. 否则 knownGoodVersion；3. 都无 → null。返回值只会是
 * previousVersion（当它可信任）或 knownGoodVersion 或 null——绝不在两棵坏树间交替。
 */
export function rollbackTarget(opts: RollbackTargetOptions): string | null {
  const { previousVersion, previousWasKnownGood, knownGoodVersion } = opts;
  if (previousVersion !== null && (previousWasKnownGood || previousVersion === knownGoodVersion)) {
    return previousVersion;
  }
  return knownGoodVersion;
}

/**
 * 延迟崩溃分支谓词：restart-exhausted（窗口内 M=5 次重启；注意与连续探活失败阈值
 * N=20 的宿主重启区分）且激活树是 override → 触发一次自动回退。纯谓词 = 两标志的
 * 合取；「触发一次」的幂等（回退后不再重复）由调用方状态机保证。
 */
export function shouldAutoRollback(restartExhausted: boolean, activeIsOverride: boolean): boolean {
  return restartExhausted && activeIsOverride;
}
