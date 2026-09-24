/**
 * 运行时版本管理状态机——纯逻辑、零依赖、无 electron、无副作用。只有两个纯函数：
 * `transition`（状态 × 事件 → 状态）与 `allowedActions`（终态门：该状态下可见动作）；
 * 控制器注入事件并读相位，settings UI 用 allowedActions 渲染按钮。
 *
 * 简化接线：available --install-confirm--> installing 一步合并 download+install
 * （install-done → pending）；downloading 保留在相位集但公开事件不进入（控制器可自行
 * 展示进度，本模块仍建模其退出边）；select-version 不是事件、仅作 allowedAction；
 * restart-dsh 禁用于安装/激活窗口与 snapshot-failed。
 *
 * 无效 (state, event) 组合吸收为原状态（不转移、不抛错），可见动作由 allowedActions
 * 门控；完整转移一览见文件尾。
 */

/** dsh 运行时相位（含 downloading/installing 两段安装态）。 */
export type RuntimePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'pending'
  | 'applying'
  | 'applied'
  | 'rollback'
  | 'snapshot-failed'
  | 'failed'
  | 'error';

/** 驱动状态机的事件（全部由控制器注入；check-done 携带「是否有可用更新」）。 */
export type RuntimeEvent =
  | { type: 'check' }
  | { type: 'check-done'; available: boolean }
  | { type: 'install-confirm' }
  | { type: 'install-done' }        // → pending（下次启动应用）
  | { type: 'apply-start' }         // 下次启动或立即应用（apply-now）共用该事件 → applying
  | { type: 'probe-pass' }          // → applied
  | { type: 'probe-fail' }          // → rollback
  | { type: 'rollback-exhausted' }  // 回退连续失败 → failed（落内建树终态）
  | { type: 'snapshot-fail' }       // 快照失败（无快照不切指针）→ snapshot-failed
  | { type: 'retry-apply' }         // 从 snapshot-failed 直接重入 applying（不重新 check）
  | { type: 'reset-builtin' }       // 恢复内建（清 pending）
  | { type: 'error' };

/** 转移函数；无效组合吸收为原状态，error 任意态可达。 */
export function transition(state: RuntimePhase, event: RuntimeEvent): RuntimePhase {
  switch (event.type) {
    case 'check':
      // 可再查的稳定态 → checking；checking 自身的再查去重与下载/安装/激活窗口内的检查吸收为原状态。
      switch (state) {
        case 'idle':
        case 'available':
        case 'applied':
        case 'rollback':
        case 'failed':
        case 'error':
          return 'checking';
        default:
          return state;
      }
    case 'check-done':
      if (state !== 'checking') return state;
      return event.available ? 'available' : 'idle';
    case 'install-confirm':
      // Cached/offline rollback and an explicit install are valid from every non-busy
      // phase that exposes the install action, not only available.
      return allowedActions(state).includes('install') ? 'installing' : state;
    case 'install-done':
      if (state === 'installing' || state === 'downloading') return 'pending';
      return state;
    case 'apply-start':
      if (state !== 'pending') return state;
      return 'applying';
    case 'probe-pass':
      if (state !== 'applying') return state;
      return 'applied';
    case 'probe-fail':
      if (state !== 'applying') return state;
      return 'rollback';
    case 'rollback-exhausted':
      if (state !== 'applying') return state;
      return 'failed';
    case 'snapshot-fail':
      if (state !== 'applying') return state;
      return 'snapshot-failed';
    case 'retry-apply':
      // 快照失败后 [重试应用] 直入 applying（不重新 check，必须用户显式触发）。
      if (state !== 'snapshot-failed') return state;
      return 'applying';
    case 'reset-builtin':
      // 恢复内建（清 override/pending）→ idle；无可清之物或安装窗口内的状态吸收为原状态。
      switch (state) {
        case 'pending':
        case 'applying':
        case 'applied':
        case 'rollback':
        case 'snapshot-failed':
        case 'failed':
        case 'error':
          return 'idle';
        default:
          return state;
      }
    case 'error':
      return 'error';
    default:
      // 穷尽：所有 RuntimeEvent.type 均已在上述 case 处理；此处仅防御性吸收。
      return state;
  }
}

/**
 * Privileged startup/rollback orchestration publishes lifecycle outcomes outside
 * the controller's check/install chain: only these explicit edges are allowed, so a
 * stale async projection cannot jump a concurrent check or install into a
 * rollback/failure story. Invalid edges are absorbed and the controller rejects the patch.
 */
const LIFECYCLE_PROJECTION_EDGES: Record<RuntimePhase, readonly RuntimePhase[]> = {
  idle: ['applying', 'failed'],
  checking: [],
  available: ['applying', 'failed'],
  downloading: [],
  installing: [],
  pending: ['applying', 'failed'],
  applying: ['idle', 'applied', 'rollback', 'snapshot-failed', 'failed'],
  applied: ['applying', 'failed'],
  rollback: ['applying', 'failed'],
  'snapshot-failed': ['applying', 'failed'],
  failed: ['applying'],
  // `error → idle` is reserved for a writer-fenced maintenance action that clears the
  // disk/quota error without changing the active runtime; reset/switch go through applying.
  error: ['idle', 'applying', 'failed'],
}

export function transitionLifecycleProjection(current: RuntimePhase, next: RuntimePhase): RuntimePhase {
  if (current === next) return current
  return LIFECYCLE_PROJECTION_EDGES[current].includes(next) ? next : current
}

/** 可见动作（终态门，§3.6）：UI 依此渲染按钮；'select-version' 的无操作守卫在 controller。 */
export type RuntimeAction =
  | 'check'
  | 'select-version'
  | 'install'
  | 'apply-now'
  | 'reset-builtin'
  | 'retry-apply'
  | 'retry-restore'
  | 'cleanup-version'
  | 'recover-metadata'
  | 'restore-pre-rollback'
  | 'restart-dsh';

/**
 * 终态门：pending 是待执行事务——[立即应用]（当前会话执行激活事务）＋唯一逃生
 * [恢复内建]；applying 是持久事务临界区，只允许「恢复内建」逃生；idle/available/
 * applied/rollback/failed/error 提供各自稳定态动作（retry-* 由显式 capability 增补）；
 * checking/downloading/installing 在单飞窗口内无可见动作，UI 只显示进度。
 */
export function allowedActions(
  state: RuntimePhase,
  capabilities: {
    canRetryApply?: boolean
    canRetryRestore?: boolean
    canRecoverMetadata?: boolean
  } = {},
): RuntimeAction[] {
  switch (state) {
    case 'idle': {
      const base: RuntimeAction[] = ['check', 'restore-pre-rollback', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'];
      if (capabilities.canRecoverMetadata === true && capabilities.canRetryRestore !== true) {
        base.unshift('recover-metadata');
      }
      return base;
    }
    case 'available':
      return ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'];
    case 'checking':
    case 'downloading':
    case 'installing':
      return [];
    case 'pending':
      // pending 是待执行事务：与下次启动共用 apply-start 事件 + [恢复内建]（逃生）。
      return ['apply-now', 'reset-builtin'];
    case 'applying':
      return ['reset-builtin'];
    case 'applied':
      return ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'];
    case 'rollback': {
      const base: RuntimeAction[] = ['check', 'restore-pre-rollback', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'];
      return capabilities.canRetryRestore === true ? ['retry-restore', ...base] : base;
    }
    case 'failed': {
      const base: RuntimeAction[] = ['check', 'restore-pre-rollback', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'];
      if (capabilities.canRetryRestore === true) base.unshift('retry-restore');
      else if (capabilities.canRecoverMetadata === true) base.unshift('recover-metadata');
      if (capabilities.canRetryApply === true) base.unshift('retry-apply');
      return base;
    }
    case 'snapshot-failed':
      // 快照失败（当前树仍好，未切指针）：[重试应用]（直入 applying）或 [恢复内建]；不自动每启重试。
      return capabilities.canRetryApply === true
        ? ['retry-apply', 'reset-builtin']
        : ['reset-builtin'];
    case 'error':
      return ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'];
  }
}

/*
 * 建模转移一览（其余组合吸收不转移）：
 *   idle --check--> checking
 *   checking --check-done{available:true}--> available / {false}--> idle
 *   available --check--> checking（手动再查） / --install-confirm--> installing
 *   downloading|installing --install-done--> pending
 *   pending --apply-start--> applying（下次启动与 [立即应用] 共用同一事件）
 *   applying --probe-pass--> applied / --probe-fail--> rollback
 *   applying --rollback-exhausted--> failed
 *   applied --check--> checking
 *   rollback|failed --check--> checking / --reset-builtin--> idle
 *   pending/applied/rollback/failed/error --reset-builtin--> idle
 *   applying --reset-builtin--> idle 仅内部事务结果；公开 reset 动作持久入队，不能打断临界区。
 *   error --check--> checking（retry-apply 即 check）；任意态 --error--> error
 */
