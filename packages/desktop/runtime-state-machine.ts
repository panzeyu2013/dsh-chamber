/**
 * dsh 运行时版本管理状态机（design 17 §3.6 状态转移表）——纯逻辑、零依赖、
 * 无 electron、无副作用（M4 抽纯模块）。只有三个纯函数：`transition`
 * （状态 × 事件 → 状态）、`allowedActions`（终态门：该状态下可见动作）、
 * `isTerminal`（rollback / failed 终态判定）。不碰文件、不碰 IPC、不碰 UI：
 * 控制器（main 进程）注入事件、读相位；settings UI 用 `allowedActions` 渲染
 * 可见动作按钮。
 *
 * 权威转移表（§3.6）：
 *
 *   idle → checking → available → downloading → installing → pending
 *     →（下次启动）applying → applied | rollback | failed
 *   pending → [恢复内建]（清 pending）→ idle
 *   applying → 回退连续失败 → failed（落内建树终态）
 *   applied → 下一周期 checking；rollback/failed → 终态（回滚后可再选）
 *   任意态 → error；error →(check) checking
 *
 * 本模块的简化接线（任务拍板，与 §3.6 的差异在此声明）：
 *   - `available →(install-confirm) installing` 一步到位——download+install 合
 *     并为 installing（install-confirm 同时承担下载触发与安装开始），
 *     `install-done` 从 installing → pending；
 *   - `downloading` 保留在相位集（§3.6「downloading → installing」），但公开
 *     事件不进入 downloading：控制器如要展示「下载中」进度可自行置 downloading
 *     相位，本模块仍为其建模退出边（install-done → pending、error → error），
 *     不会死锁；
 *   - `select-version` 不是事件、仅作为 allowedAction（选当前激活版本为无操作
 *     的 isNoopSelection 守卫是 controller 层语义，§3.6 不转移）。
 *
 * 无效 (state, event) 组合：吸收为原状态（不转移、不抛错）——可见动作由
 * `allowedActions` 门控，控制器对迟到/乱序事件（如 reset-builtin 后的残留
 * probe-pass）做防御性吸收，机器永不崩溃；「未建模边」因此仅指吸收不转移的
 * 组合（见文件尾注释）。
 */

/** dsh 运行时相位（§3.6 状态集，含 downloading/installing 两段安装态）。 */
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
  | { type: 'apply-start' }         // 下次启动应用相位
  | { type: 'probe-pass' }          // → applied
  | { type: 'probe-fail' }          // → rollback
  | { type: 'rollback-exhausted' }  // 回退连续失败 → failed（落内建树终态）
  | { type: 'snapshot-fail' }       // 快照失败（无快照不切指针）→ snapshot-failed
  | { type: 'retry-apply' }         // 从 snapshot-failed 直接重入 applying（不重新 check）
  | { type: 'reset-builtin' }       // 恢复内建（清 pending）
  | { type: 'error' };

/**
 * 转移函数（§3.6 转移表逐条实现）。无效组合吸收为原状态；error 任意态可达。
 */
export function transition(state: RuntimePhase, event: RuntimeEvent): RuntimePhase {
  switch (event.type) {
    case 'check':
      // idle/available/applied/rollback/failed/error → checking；其余（checking
      // 再查、单飞去重；downloading/installing/pending/applying 终态门挂起
      // 周期/手动检查，§3.6「apply 期间挂起周期/手动检查」）吸收为原状态。
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
      // Cached/offline rollback and an explicit install are valid from every
      // non-busy phase that exposes the install action, not only available.
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
      // §3.6 R3-3 UX-P1-F4：快照失败后 [重试应用] 直接重入 applying（不重新
      // check，不自动每启重试——必须用户显式触发）。
      if (state !== 'snapshot-failed') return state;
      return 'applying';
    case 'reset-builtin':
      // 恢复内建（清 override/pending）→ idle。idle/checking/available 无可清
      // 之物（无 override 可删），吸收；downloading/installing 在安装窗口内无
      // 可见动作（allowedActions = ['none']，单飞守卫），同样吸收。
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
 * Privileged startup/rollback orchestration publishes lifecycle outcomes from
 * outside the controller's check/install event chain. Keep those edges
 * explicit: a stale async projection must not jump a concurrent check or
 * install directly into a rollback/failure story. Invalid edges are absorbed
 * as the current phase; DshRuntimeController rejects the accompanying patch.
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
  // `error → idle` is reserved for a successful writer-fenced maintenance
  // action that clears the disk-accounting/quota error without changing the
  // active runtime. Reset/switch transactions still go through applying.
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
  | 'reset-builtin'
  | 'retry-apply'
  | 'retry-restore'
  | 'cleanup-version'
  | 'recover-metadata';

/**
 * 终态门（§3.6）：
 *   - pending 可恢复内建；applying 是持久事务临界区，所有新动作禁用；
 *   - idle/checking/available 允许 check + select-version（available 加 install）；
 *   - downloading/installing 在安装窗口内无可见动作（单飞守卫覆盖整个 install
 *     窗口，UI 只显示进度，即 'none'）；
 *   - applied/rollback/failed 允许 check + select-version（回滚后可再选）+
 *     reset-builtin；
 *   - error 允许 retry-apply（= check）+ reset-builtin。
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
      const base: RuntimeAction[] = ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'];
      if (capabilities.canRecoverMetadata === true && capabilities.canRetryRestore !== true) {
        base.unshift('recover-metadata');
      }
      return base;
    }
    case 'available':
      return ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'];
    case 'checking':
    case 'downloading':
    case 'installing':
      return [];
    case 'pending':
      return ['reset-builtin'];
    case 'applying':
      return ['reset-builtin'];
    case 'applied':
      return ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'];
    case 'rollback': {
      const base: RuntimeAction[] = ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'];
      return capabilities.canRetryRestore === true ? ['retry-restore', ...base] : base;
    }
    case 'failed': {
      const base: RuntimeAction[] = ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'];
      if (capabilities.canRetryRestore === true) base.unshift('retry-restore');
      else if (capabilities.canRecoverMetadata === true) base.unshift('recover-metadata');
      if (capabilities.canRetryApply === true) base.unshift('retry-apply');
      return base;
    }
    case 'snapshot-failed':
      // 快照失败（当前树仍好，未切指针）：可 [重试应用]（直入 applying）或
      // [恢复内建]；不再自动每启重试（§3.6 R3-3 UX-P1-F4）。
      return capabilities.canRetryApply === true
        ? ['retry-apply', 'reset-builtin']
        : ['reset-builtin'];
    case 'error':
      return ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'];
  }
}

/**
 * 终态判定（§3.6）：rollback / failed 为终态（落内建树，等用户动作）；applied
 * 非终态（下一周期可 checking）。
 */
export function isTerminal(state: RuntimePhase): boolean {
  return state === 'rollback' || state === 'failed';
}

/*
 * 建模转移一览（覆盖 §3.6 全部边；其余组合吸收不转移）：
 *   idle --check--> checking
 *   checking --check-done{available:true}--> available
 *   checking --check-done{available:false}--> idle
 *   available --check--> checking                          （手动再查）
 *   available --install-confirm--> installing              （简化：合并 download+install）
 *   downloading --install-done--> pending                  （外部置相位后的退出边）
 *   installing --install-done--> pending
 *   pending --apply-start--> applying
 *   applying --probe-pass--> applied
 *   applying --probe-fail--> rollback
 *   applying --rollback-exhausted--> failed
 *   applied --check--> checking                            （下一周期）
 *   rollback --check--> checking / --reset-builtin--> idle （回滚后可再选）
 *   failed --check--> checking / --reset-builtin--> idle
 *   pending/applied/rollback/failed/error --reset-builtin--> idle
 *   applying --reset-builtin--> idle is an internal transaction outcome only;
 *     the public reset action is durably queued and cannot interrupt the
 *     active critical section.
 *   error --check--> checking                              （retry-apply 即 check）
 *   任意态 --error--> error
 */
