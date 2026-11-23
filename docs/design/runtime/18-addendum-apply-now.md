# 18 增补 · dsh 运行时版本「立即应用」（Apply Now）

> **apply-now 立即应用；desktop 本地实例与 gateway 托管 dsh**——本文是 `docs/design/runtime/18-dsh-runtime-version.md` §3.3（应用时机 = 下次启动的异步相位）的受控扩展契约：在保留「仅下次启动」路径的同时，新增用户可随时触发的「立即应用」动作，在当前会话内执行既有激活事务（停机 → 快照 → 切指针 → spawn 新树 → 探针门控 → 裁决/回退），不等待下次启动；开放状态见 design 18 与 TODO。

## 0. 决策与约束（现行契约）

| # | 契约条款 | 约束内容 |
|---|---|---|
| D1 | 双动作并存（「仅下次启动」路径保留） | install/select 置 pending，激活事务由下次启动相位执行；用户另可在 pending 相位触发「立即应用」。desktop 天然单按钮：install 即置 pending，pending 行内提供主按钮 [立即应用]。gateway 设置区段合并为单一方向感知按钮（更新到/切换到 vX，执行 select+apply），「仅下次启动」语义由按钮下 hint 保留；pending 期的 [立即应用] 不变（运维窗口语义） |
| D2 | apply-now 候选 respawn 不计共享 restart 背压窗口（M=5/10min） | 不计入：候选 spawn 走 `plane.startLocal()`/`startImpl`，非 `restartLocal`；`restartTimes` 只在 `triggerRestart` 累计、`stop()`/`start()` 清空（由测试钉死）。回退落内建后的 crash-loop 走既有 restart-exhausted 语义（F7 仅 `state.source==='user'` 触发） |
| D3 | 探针窗口内 gateway 单目标 proxy 转发到候选 | **必做**：gateway-proxy.ts `resolveTarget`/`handleUpgrade` 增加激活感知门（`canExposeLocal` 谓词，与 instance-proxy.ts 对齐）。该暴露在启动路径与 restore-builtin 同样存在，同一修复一并覆盖，零增量成本 |
| D4 | 是否需要 runtime SSE | MVP 不做，维持 status 轮询（~3s）；SSE 登记为可选增强 |
| S1 | 共享核心是否新增 `runImmediateActivation` 编排入口 | 不做：两个宿主已有完整编排（desktop `runRuntimeStartup`、gateway `restoreBuiltin` 骨架），只补 `ApplyDeps.probe` 的可选 `signal?` 参数 + `runStartupPhase`/`runDelayedRollback` 的可选 signal 透传（事务级 abort 接缝） |
| S2 | gateway status 是否泛化 operation 字段 | 不做：结果可由 phase / connectionState / failure / activeVersion-vs-selectedVersion / operationError / startupBlockedReason 推导；`lastOutcome` 一行透传保留为可选增强 |
| D5 | env 来源与 Windows 平台 | 排除：属版本 mutation，继承既有 `env_override_active` / `platform_read_only` 门 |

## 1. 动机与范围

### 1.1 需求
design 18 现行契约：apply 只置 pending，激活事务在下次启动相位执行；需求 = 安装/选择完成后立即在当前会话切换。

### 1.2 范围
目标宿主：desktop 本地实例（完整管理面）、gateway 托管 dsh（/chamber/runtime）。排除：ssh 直连（版本只读）、dsh http 直连（不挂载）、env 来源（DSH_CHAMBER_DSH_PATH / DSH_GATEWAY_DSH_PATH）、Windows。不做：进程内热切换（物理不可行）、「安装时询问是否立即应用」合并流（后续可选）、runtime SSE（§0 D4）。

### 1.3 可行性依据（机制事实）
- 激活事务是任意时刻可调的纯 async 函数 `applyPendingVersion`，副作用全经 `ApplyDeps`，与启动序列零硬耦合；
- 两个宿主早已在运行中执行完整激活事务：desktop `RUNTIME_RESET_BUILTIN`/`RUNTIME_RETRY_APPLY`/F7、gateway `restoreBuiltin`；
- 状态机已建模 `pending --apply-start--> applying` 与生命周期投影边（常规用户动作不直接触发该边）；
- durable journal 幂等补完不依赖「下次启动」（`snapshot-store` marker 相位机即普通函数）；
- 停机窗口与串行化现成：`stop()` epoch writer 屏障、健康单飞、`restartLocal` 单飞、spawn-dsh SIGTERM→1s→SIGKILL。

## 2. 总体方案

### 2.1 动作模型（双动作并存）
- 现有路径不动：select/install → pending → 下次启动相位执行事务。
- 新增路径：pending 状态 → [立即应用 vY]（二次确认）→ 当前会话内执行同一事务。
  - 通过 → applied；失败 → 复用既有终态（rollback / snapshot-failed / swap-attempted / restore-incomplete），**零新终态**。

### 2.2 执行序列（两个宿主同一契约）
二次确认 → 门控（pending 存在 ∧ 目标树有效 ∧ connectionState∈{ready,degraded} ∧ 非 env ∧ 非 Windows ∧ mutation 单飞 ∧ writer fence）→ [停机前置] 事务性停止托管 dsh（复用 restartLocal 停机段与健康单飞串行化，禁裸 stopLocal）→ runStartupPhase（快照 → 切指针 → spawn 候选 → 探针门控 ≤60s + 延迟裁决）→ 干净/snapshot-failed → 恢复宿主；其余 blocked（swap-attempted/restore-half/restore-incomplete）→ 保持停机 + startupBlockedReason 投影 + retry 恢复面。

正确性关键：apply-phase 正向路径只在快照（`deps.snapshot`）之后跑回退时才调 `stopHost`（仅回退路径）——会话中执行必须先停机再快照，否则违反「无存活写者的静止拷贝」不变量（`snapshotDshHome` 不查存活写者，靠调用方排序保证）。desktop `runRuntimeStartup` 已无条件 `cp.stopLocal()`，直接复用。

一句话总结：「立即应用」= 复用既有激活事务与 `restartLocal` 停机窗口、在 pending 相位新增用户触发的执行入口（共享核心只补 signal 参数、gateway 侧补 proxy 激活门与同步 preflight 拒门见 §3/§5）；失败零新终态、崩溃安全零新窗口。

## 3. 共享核心改动（packages/dsh-runtime）

| 改动 | 契约（实现细节以源码为单源） |
|---|---|
| `ApplyDeps.probe` / `StartupDeps.spawnAndProbe` 补可选 `signal?: AbortSignal`（`apply-phase.ts` / `runtime-startup.ts`） | 事务级 abort 接缝：`runStartupPhase(deps, signal?)`/`runDelayedRollback(deps, monitoring, signal?)` 透传；宿主中止 = 事务级取消。 |
| abort 语义（§0 S1 契约部分） | 入口检查 `signal.aborted` 即返回定义好的失败结局（`status:'failed'`、`retainPending:true`、`runtimeBlocked:false`、`retryAction:null`、`failureKind:null`，error 明示「已被宿主中止」）：零副作用、journal 保留、下次启动幂等续作；回退验证探针经 `rollbackProbeSignal` 不复用预中止 signal（绝不伪造「候选+回退+内建均失败」终态）；候选探针透传、中止立即生效。 |
| 不做 `runImmediateActivation` 编排入口；不改 journal/override schema 与 activation-gate/snapshot-store/override-lifecycle/runtime-probes 等纯函数模块 | §0 S1；「立即 vs 下次启动」是宿主决策（`writeActivationIntent`/`queueActivationIntent` 已支持运行中排程，`dsh-runtime-store.ts`）。 |

**§3.1 门控组合不共享（契约）**：两宿主共享**执行序列**（停机前置 → 快照 → 切指针 → spawn → 探针门控，由共享核心承载），但门控组合是各自边界策略、**保留双份**：desktop 多 snapshot-failed 分流与 TOCTOU 二次门；gateway 多 journal-corrupt 与 no-op 门、公网面错误码。差异与理由以源码为单源（`packages/desktop/apply-now-gate.ts` ↔ `packages/gateway/src/runtime/versions.ts` 的 applyNowPreflight / `runtime-refusals.ts`）；被否方案（收敛为共享函数 + 宿主开关）的取舍保留在 §0 S1 与 design 17 §2.3「共享函数 + 布尔开关」纪律。

## 4. desktop 宿主改动（packages/desktop）

### 4.1 IPC 与动作
- `RUNTIME_APPLY_NOW` 常量 + preload `runtimeApi().applyNow`（镜像测试 `test/ipc/ipc-surface-mirror.test.ts` 强制 handle 集 == invoke 集）；`RuntimeAction` 增 `'apply-now'`，`allowedActions('pending') = ['apply-now','reset-builtin']`。
- `main.ts` handler 用纯函数 `evaluateApplyNowGate`（`packages/desktop/apply-now-gate.ts`，顺序 busy→env→not-allowed→blocked→not-ready→no-pending→snapshot-failed→invalid-tree→ok）确认前后各调一次（TOCTOU）；确认后 `await runRuntimeStartup()`（**不持有跨事务 fence 租约**）。
- renderer 同步 `RuntimeAction`/`applyNow()`/`BASE_ACTIONS['pending']`；pending 且 `hasOverride===false` 时隐藏 apply-now（与 reset-builtin 过滤对称）；`test/runtime/runtime-lockstep.test.ts` 强制 renderer ⊆ main。

### 4.2 门控与互斥（全部复用既有机制）
健康自动重启交错 = `restartLocal` 单飞 + `canSpawn` 门；双 spawn = `startPromise`/`restartPromise` 单飞 + `stop()` epoch writer 屏障；applying 期间仅 `reset-builtin`；崩溃安全无新窗口（journal 幂等续作 + 启动 reaper 回收候选孤儿）。

### 4.3 known-good 语义
applied 时 `recordProbePass`+`noteBoot` 当场满足「≥1 boot」，24h 连续健康从 apply 起算；回退目标不变。

## 5. gateway 宿主改动（packages/gateway）

### 5.1 新路由 `POST /chamber/runtime/apply-now`
- 202 接受即返回（镜像 restart，`runtime-routes.ts`），异步 job 经 `status()` 轮询；**同步 preflight 是 202 前唯一权威门**：任何同步门失败以 409/403 先于 202 返回，202 前完成 pending arm（丢失时退化为下次启动应用）。
- 同步拒门（错误码为契约）：`409 runtime_recovery_required`（recovery 相位；普通 pending 允许 apply-now）、`409 runtime_busy`（installing/applying/restart/已有 apply-now 在途/connectionState 非 ready-degraded）、`409 env_override_active`、`403 platform_read_only`、`409 no_selection`（失效过滤后双空）、`409 invalid_target`（树不存在）、`409 noop_target`（active===target 且无在途事务 journal）。
- manager `applyNow()`（restoreBuiltin 的 version-switch 对偶）：目标 = pending（优先）否则未失效 chosenVersion；后者按 apply() journal-first 补写 `writeActivationIntent` + `writeOverride`（不可复用 `assertNoPending()`）；manualRollback 镜像 apply() 降级公式（含 pre-rollback 数据 stash）。
- 执行 = `beginActivation` → `plane.stopLocal()` → `executeStartupTransaction()` → `endActivation` → 干净/snapshot-failed 恢复 `startLocal()`+`refreshLocalExposure()`；blocked 保持 gateway 存活 + `startupBlockedReason` + retry（blocked-but-alive）；202 异步 job 失败必须投影 `operationError`/`startupBlockedReason`（不能只落日志）。
- 现有 `POST /chamber/runtime/apply`（置 pending，同步 200）不动。

### 5.2 结果投影（§0 S2：零 schema 改动）
- 窗口期：`status().phase==='applying'`（`activationInProgress`）+ connectionState 诚实降级 stopped/starting。成功：phase 离开 applying 且 connectionState∈{ready,degraded}、`startupBlockedReason`/`operationError` 空、`restoreOutcome∈{null,none,complete}`；`failure` 只作跨动作诊断、不单独决定 poll settle；activeVersion==selectedVersion → 更新成功，否则已回退。
- 失败：startupBlockedReason/operationError/非成功 restoreOutcome 投影走既有终态。可选增强：一行透传 `override.lastOutcome`。settings-bridge 轮询端 `pollRemoteRuntimeUntilSettled` 显式传 `select|apply-now` expectation（select 保留安装任务语义），实例切换/卸载经 AbortSignal 取消旧轮询。

### 5.3 gateway-proxy 激活感知（§0 D3，必做）
`GatewayProxyDeps` 增 `canExposeLocal?: () => boolean`；`resolveTarget` 与 `handleUpgrade`（`gateway-proxy.ts`）在激活事务在途（候选已 spawn、探针未裁决）时返回 503 `instance_unavailable`；index.ts 复用 `() => runtimeManager === null || !runtimeManager.activationInProgress()`。理由：探针只覆盖 host 侧，未裁决候选不得服务在线用户（启动路径与 restore-builtin 同款暴露，同一修复覆盖）。

### 5.4 单进程与回收
`owner.json` 单进程不变量不受影响；`stop()` 等 startup continuation 前先触发 manager lifecycle abort，drain apply-now/F7/install 等 writer promise 后才释放 owner/state lock——apply-now 在途收到 stop → journal 保留中断相位 → 下次启动 blocked-but-alive + retry，旧 job 不得在新 owner 进入后继续写。

### 5.5 /chamber/ 浏览器页
`routes.ts` 管理页同步实现 apply-now：`Apply now` 按钮（`runtime-apply-now`）+ `Applying… restarting` 文案，经既有 `runtimeAction` 单飞 + 3s status 轮询；禁用与相位/connectionState/env/read-only 门对应；硬编码英文、CSP 兼容、不属 i18n 面。

## 6. 状态机与 UI

### 6.1 状态 × 动作矩阵差异（零新终态）
| 状态 | 现状动作 | 新增动作 |
|---|---|---|
| pending | [恢复内建] 唯一 | [立即应用 vY]（主）+ [恢复内建]（次）；[重启 dsh] 仍禁用（`RUNTIME_RESTART` busyPhase 已含 pending） |
| applying | [恢复内建] | 不变（可见但 durable queued） |
| 其余状态 | 不变 | 不变 |
| env 源 | mutation 禁用 | 不变（env 禁立即应用；[重启 dsh] 仍可用） |

实现面：`runtime-state-machine.ts` `allowedActions` pending 分支 + renderer `runtime-management.ts` `BASE_ACTIONS` 同步（§4.1；`hasOverride=false` 时隐藏）；`test/runtime/runtime-lockstep.test.ts` 精确相等断言是天然强制同步点。

### 6.2 诚实信号纪律（窗口期）
- desktop：`phase='applying'` + `runtimeBlocked=true` + `runtimeBlockedReason`；connections 卡 `runtimeBlocksLocalStart` 门控（`runtime-management.ts`）。
- gateway：connectionState 诚实降级 stopped/starting，runtime 面不随 ready detach（design 18 §9.3），窗口全程可轮询。
- resolve ≠ success：探针失败/回退/restore-half 必须走终态文案，绝不显示「已更新」。
- 点击后立即置 busy 并禁用整组，防同帧双击。

### 6.3 文案（zh / en）
- 二次确认（desktop main 原生 `confirmRuntimeMutation`；settings-bridge 面板确认与 gateway 重启统一走应用内官方 `Modal`；无二次确认的浏览器页动作按 design 17 §10.3 分档）：zh/en 标题「立即切换到 v{version}？」+ 正文「dsh 将立即重启并切换到 v{version}（约 30–90 秒）。进行中的会话会中断，你的数据不受影响；若切换失败，dsh 会自动回滚并保留现场。」+ 确认「立即应用并重启 / Apply and restart」。
- 按钮/hint：pending 主按钮「立即应用 v{version} / Apply now v{version}」；hint 注明「切换将在下次启动生效；如需立即生效，点击『立即应用』（dsh 会短暂重启，约 30–90 秒）」；applying 状态行「应用 dsh v{version}… 正在重启 / Applying dsh v{version}… restarting」。
- **方向感知合并按钮**：gateway 设置区段「仅下次启动」与独立「回滚到」合并为单一方向感知主按钮（升级「更新到 vX」/降级「切换到 vX」，`dshRuntimeActionUpdate`/`dshRuntimeActionSwitch`，执行 select+apply 并按方向算 manualRollback）；desktop 本地区段同文案；`dshRuntimeApplyNextLaunchHint` 保留「下次启动生效」语义。
- 口径：30–90 秒取就绪窗口；探针可能延长（≤60s + 延迟裁决）。

### 6.4 i18n key（命名空间 `dsh-chamber.settings.bridge`；`locales.ts`：zh 为 key 集源、en 为 `Record<keyof typeof zh>`）
key 集：dshRuntimeApplyNowAction / dshRuntimeApplyNowActionWithVersion / dshRuntimeApplyNowConfirmTitle / dshRuntimeApplyNowConfirmBody / dshRuntimeApplyNowConfirmAction / dshRuntimeApplyNowHint / dshRuntimeStatusApplyingNow（`dshRuntimeApplyNextLaunchOnly` 随方向感知合并按钮移除，替代为 `dshRuntimeActionUpdate`/`dshRuntimeActionSwitch` + hint key `dshRuntimeApplyNextLaunchHint`）。`dshRuntimeApplyNowConfirmAction` 由 desktop 原生对话框硬编码中文交付（main 无 i18n，与既有原生对话框一致），key 保留为契约占位。/chamber/ 浏览器页（§5.5）硬编码英文，不属 i18n 面。

## 7. 风险与不变量

| # | 风险 | 概率 | 影响 | 强制缓解（现行契约） |
|---|---|---|---|---|
| R1 | 快照一致性（运行中 DSH_HOME 有存活写者） | 中 | 高 | 先事务停机再快照（复用 restartLocal 停机段，禁裸 stopLocal）；测试注入「停机后仍有写者」 |
| R2 | 崩溃窗口（停机/快照/切指针/探针中途） | 低-中 | 高 | journal + restore-in-progress marker 幂等续作（既有）；「运行中 entry 崩溃」重放测试 |
| R3 | 健康机把停机当「进程死亡」自动重启 → 双 spawn | 高 | 高 | 复用 stop() 的 stopping/epoch 串行化与 canSpawn 门（既有机制） |
| R4 | restart-exhausted 语义混用（apply-now respawn 误计窗口 / F7 误触发） | 中 | 中-高 | §0 D2 明确不计窗口；F7 只对 applied-monitoring + override 触发；测试钉死两层语义 |
| R5 | known-good 24h 语义被缩短 | 低 | 中 | 时钟注入测试证明不缩短 |
| R6 | gateway 停机窗口（数秒–90s）在线用户 503 | 高（多用户） | 中 | 反代显式 503 + 状态行预告；前端重连归入既有连接恢复契约 |
| R7 | install 未完成时 apply-now | 低（UI 已禁用） | 中 | `runtime_busy` 409 + 测试 |
| R8 | 磁盘不足（快照 ENOSPC） | 低 | 高 | 复用 snapshot-failed 出口 + retry-apply |
| R9 | 候选树被在线用户提前消费（gateway proxy 窗口转发） | 中 | 中 | §0 D3：gateway-proxy 激活门（必做） |
| R10 | abort 语义误用（宿主中止被放大为回退/内建失败终态） | 低（潜伏接缝） | 中 | abort = 事务级取消 + 回退验证探针不复用预中止 signal + 接缝测试钉死 |

## 8. 测试计划

测试判据与执行见 [release-checklist](../../checklists/release/release-checklist.md)。
