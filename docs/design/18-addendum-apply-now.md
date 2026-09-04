# 18 增补 · dsh 运行时版本「立即应用」（Apply Now）

> **状态：设计定稿（2026-03），已实施，自动化验收门禁全绿。** 本增补是
> `docs/design/18-dsh-runtime-version.md` 决策 #5（「应用时机 = 下次启动」）的受控
> 扩展：在保留「仅下次启动」路径的同时，新增用户可随时触发的「立即应用」动作——
> 在当前会话内执行既有激活事务（停机 → 快照 → 切指针 → spawn 新树 → 探针门控 →
> 裁决/回退），不等待下次启动。本文档为完整设计契约。

## 0. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| D1 | 保留「仅下次启动」路径 | 双动作并存。desktop 天然单按钮（install 即置 pending，pending 行内新增主按钮 [立即应用]）；gateway 双动作（[仅下次启动] 置 pending + [立即应用]，运维窗口语义）。**2026-11 修订**：gateway 设置区段合并为单一方向感知按钮（更新到/切换到 vX，select+apply），「仅下次启动」语义由按钮下 hint 保留；pending 期 [立即应用] 不变 |
| D2 | apply-now 候选 respawn 不计共享 restart 背压窗口（M=5/10min） | 不计入（候选 spawn 走 plane.startLocal()/startImpl，非 restartLocal；`restartTimes` 只在 `triggerRestart` 累计、`stop()`/`start()` 清空——机制已证实，由测试钉死）。回退落内建后的 crash-loop 走既有 restart-exhausted 语义（F7 仅 `state.source==='user'` 触发） |
| D3 | 探针窗口内 gateway 单目标 proxy 转发到候选 | **修复（必做）**：gateway-proxy.ts `resolveTarget`/`handleUpgrade` 增加激活感知门（`canExposeLocal` 谓词，与 instance-proxy.ts:344 对齐）。该暴露在启动路径与 restore-builtin 同样存在，修复一并覆盖，零增量成本 |
| D4 | 是否需要 runtime SSE | MVP 不做，维持 status 轮询（~3s）；SSE 登记为可选增强 |
| S1 | 共享核心是否新增 runImmediateActivation 编排入口 | 不做：两个宿主已有完整编排（desktop runRuntimeStartup、gateway restoreBuiltin 骨架），只补 `ApplyDeps.probe` 的可选 `signal?` 参数 + `runStartupPhase`/`runDelayedRollback` 的可选 signal 透传（事务级 abort 接缝） |
| S2 | gateway status 是否泛化 operation 字段 | 不做：结果可由 phase / connectionState / failure / activeVersion-vs-selectedVersion / operationError / startupBlockedReason 推导；`lastOutcome` 一行透传保留为可选增强 |
| D5 | env 来源与 Windows 平台 | 排除：属版本 mutation，继承既有 env_override_active / platform_read_only 门 |

## 1. 动机与范围

### 1.1 需求
design 18 现行契约：apply 只置 pending，激活事务在下次启动相位执行。用户希望安装/选择完成后立即在当前会话切换到新版本。

### 1.2 范围
目标宿主：desktop 本地实例（完整管理面）、gateway 托管 dsh（/chamber/runtime 面）。
排除：ssh 直连（版本只读）、dsh http 直连（不挂载）、env 来源（DSH_CHAMBER_DSH_PATH / DSH_GATEWAY_DSH_PATH）、Windows（只读平台）。
不做：进程内热切换（物理不可行）、「安装时直接询问是否立即应用」合并流（后续可选）、runtime SSE（D4）。

### 1.3 可行性核心事实（已逐点核实）
- 激活事务是任意时刻可调的纯 async 函数 `applyPendingVersion`（apply-phase.ts:627），副作用全经 ApplyDeps，与启动序列零硬耦合；
- 两个宿主早已在运行中执行完整激活事务：desktop `RUNTIME_RESET_BUILTIN`/`RUNTIME_RETRY_APPLY`/F7（main.ts:4446/4471/4058）、gateway `restoreBuiltin`（runtime-manager.ts:1149-1206）；
- 状态机已建模 `pending --apply-start--> applying`（runtime-state-machine.ts:100-102）与生命周期投影边（:157），只是从未被用户动作触发；
- durable journal 幂等补完不依赖「下次启动」（snapshot-store.ts:752-793 的 marker 相位机是普通函数）；
- 停机窗口与串行化现成：`stop()` epoch writer 屏障（local-connection.ts:876-942）、健康单飞（:461/:484/:526）、`restartLocal` 单飞（:965-982）、spawn-dsh SIGTERM→1s→SIGKILL（spawn-dsh.ts:794-810）。

## 2. 总体方案

### 2.1 动作模型（双动作并存）
- 现有路径不动：select/install → pending → 下次启动相位执行事务。
- 新增路径：pending 状态 → [立即应用 vY]（二次确认）→ 当前会话内执行同一事务。
  - 通过 → applied；失败 → 复用既有终态（rollback / snapshot-failed / swap-attempted / restore-incomplete），**零新终态**。

### 2.2 执行序列（两个宿主同一契约）
二次确认 → 门控（pending 存在 ∧ 目标树有效 ∧ connectionState∈{ready,degraded} ∧ 非 env ∧ 非 Windows ∧ mutation 单飞 ∧ writer fence）→ [停机前置] 事务性停止托管 dsh（复用 restartLocal 停机段与健康单飞串行化，禁裸 stopLocal）→ runStartupPhase（快照 → 切指针 → spawn 候选 → 探针门控 ≤60s + 延迟裁决）→ 干净/snapshot-failed → 恢复宿主；其余 blocked（swap-attempted/restore-half/restore-incomplete）→ 保持停机 + startupBlockedReason 投影 + retry 恢复面。

正确性关键：apply-phase 正向路径不调 stopHost（快照在 :219，stopHost 只在回退路径 :331/:437）——会话中执行必须先停机再快照，否则违反「无存活写者的静止拷贝」不变量（snapshotDshHome 自身不查存活写者，snapshot-store.ts:532-558，靠调用方排序保证）。desktop runRuntimeStartup 已无条件 cp.stopLocal()（main.ts:3886），直接复用。

## 3. 共享核心改动（packages/dsh-runtime）

| 改动 | 内容 |
|---|---|
| `ApplyDeps.probe` 补可选 `signal?: AbortSignal`（apply-phase.ts:30） | `ApplyOptions` 增 `signal?`；`delayedVerdict` 与 `continueRollback` 回退探针透传。对齐草图 adapter（runtime-host-adapter.ts:43）与既有实现（runtime-probes.ts:28） |
| **abort 语义（S1 的契约部分）** | 宿主中止 = 事务级取消：`runApplyTransaction`/`continueRollback` 入口检查 `signal.aborted` 即返回定义好的失败结局（`status:'failed'`、`retainPending:true`、`runtimeBlocked:false`、`retryAction:null`、`failureKind:null`，error 明示「已被宿主中止」），零副作用、journal 保留、下次启动幂等续作（与崩溃语义同族）；回退验证探针（可信回退目标/内建落点）经 `rollbackProbeSignal` 不再复用预中止的 signal（回退判卷诚实完成，绝不因一次 abort 伪造「候选+回退目标+内建均失败」终态）；候选探针保持透传（中止立即生效）。`runStartupPhase(deps, signal?)` 与 `runDelayedRollback(deps, monitoring, signal?)` 透传事务级 signal（desktop 三处调用点传 `runtimeOperationAbort?.signal`，probe 闭包尊重第三参——abort 接缝在真实宿主可达）。接缝有专门测试（转发/abort 结局/探针在途 abort 不污染回退判卷且可幂等续作） |
| `StartupDeps.spawnAndProbe` 补可选 `signal?`（runtime-startup.ts:54） | 契约统一；宿主现有 2 参调用继续编译（desktop 的 probe 闭包尊重第三参，signal 由 runStartupPhase 事务级透传） |
| 不做 runImmediateActivation 编排入口 | S1 |
| 不改 journal/override schema | 「立即 vs 下次启动」是宿主决策；writeActivationIntent/queueActivationIntent 已支持运行中排程（dsh-runtime-store.ts:816-944） |
| 不改 activation-gate / snapshot-store / override-lifecycle / runtime-probes / runtime-operation-fence / known-good-monitor / runtime-metadata-recovery / registry-* | 全部已是宿主无关纯函数 |

## 4. desktop 宿主改动（packages/desktop）

### 4.1 IPC 与动作
- `ipc-events.ts` 新增 `RUNTIME_APPLY_NOW` 常量；`preload.cts` `runtimeApi()` 新增 `applyNow`（镜像测试 ipc-surface-mirror.test.ts B8 强制 handle 集 == invoke 集）。
- `runtime-state-machine.ts`（desktop shim 指向 dsh-runtime）：`RuntimeAction` 增 `'apply-now'`；`allowedActions('pending')` 扩为 `['apply-now', 'reset-builtin']`。
- `main.ts` 新 handler（**F1：不持有跨事务 fence 租约**——runRuntimeStartup 内部自取 `'runtime:startup'` 租约，外层持有必死锁；采用 RUNTIME_RETRY_APPLY 同款入口模式）：
  - 门控为纯函数 `evaluateApplyNowGate`（`packages/desktop/apply-now-gate.ts`，零副作用，矩阵测试覆盖）——顺序：busy（operation/fence 单飞）→ env → not-allowed（非 pending 相位 / managementSupported=false）→ blocked → not-ready（connectionState 非 ready/degraded）→ no-pending（`pending ?? journalTarget ?? overridePending` 三源全空，**F5：防无事务空重启循环**）→ snapshot-failed（走 retry-apply）→ invalid-tree（目标树预检，防注定失败的停启循环）→ ok(target)。
  - 确认对话框前后各调用一次同一 gate（两处输入构造完全同构，覆盖 TOCTOU）；原生二次确认 `confirmRuntimeMutation`（复用 :4099-4107）；拒绝路径返回现状。
  - 确认后 `await runRuntimeStartup()`——事务窗口即既有 `phase:'applying'` + `runtimeBlocked:true` 投影（:3890-3899），`publishApplyOutcome` 负责终态。
- renderer `runtime-management.ts`：`RuntimeAction`/`RuntimeSurface.applyNow()`/`BASE_ACTIONS['pending']` 同步；**pending+hasOverride===false 时隐藏 apply-now**（与 reset-builtin 的 hasOverride 过滤对称，杜绝 UI⊄main）；runtime-lockstep.test.ts 精确相等断言强制 renderer ⊆ main（先红后绿）。

### 4.2 门控与互斥（全部复用既有机制）
- 健康自动重启交错：restartLocal 单飞 + `canSpawn` 门（local-connection.ts:323-329）——事务窗口内健康机「进程死亡即重启」被抑制。
- 双 spawn：startPromise/restartPromise 单飞 + stop() epoch writer 屏障。
- applying 期间其它动作：`runtimeActionAllowed`（main.ts:4230-4259）与 `allowedActions('applying')=['reset-builtin']` 既有。
- 崩溃安全：无新窗口——journal 相位幂等续作；候选孤儿由启动 reaper 回收（control-plane 既有）。

### 4.3 known-good 语义
无不利影响：applied 时 recordProbePass（apply-phase.ts:595）+ noteBoot（main.ts:3960-3961）——「≥1 boot」当场满足，24h 连续健康从 apply 时刻起算；回退目标不变。

## 5. gateway 宿主改动（packages/gateway）

### 5.1 新路由 `POST /chamber/runtime/apply-now`
- 202 接受即返回（镜像 restart 语义，runtime-routes.ts:222-243）；异步 job 经 status() 轮询。
- **同步 preflight（202 前的唯一权威门）**：路由在发 202 前调用 manager 的同步 `applyNowPreflight()`，任何同步门失败都以 409/403 先于 202 返回（杜绝「202 + 仅日志 + 轮询永不 settle」）。preflight 与 applyNow 共用同一门面（路由与直接调用语义一致），preflight 在 202 前完成 F2 arm（202 丢失时退化为「下次启动应用」，无害）。
- 同步拒门：
  - 409 `runtime_recovery_required`：recovery 相位（snapshot-failed/swap-attempted/restore-blocked）——`recoveryGateRefusal` 对 `'apply-now'` 特判：**普通 pending 允许 apply-now**（这是本动作的语义前提），recovery 相位仍拒绝（只走各自 retry；restore-builtin 仅限 pending/健康选择——2026 audit R2 收窄）；
  - 409 `runtime_busy`（installing/applying/restart 在途、已有 apply-now 在途；`assertMutationIdle` 已并入 `applyNowInFlight`，与 mutationInProgress 语义对齐）；
  - 409 `env_override_active`、403 `platform_read_only`；
  - 409 `no_selection`（preflight 内**失效过滤**的目标解析：pending 与未失效 chosenVersion 双空）；
  - 409 `invalid_target`（目标树不存在）；
  - 409 `noop_target`（`target === currentPointerVersion()` 且无在途事务 journal（missing 或 intent 相位）——防无版本变更的空停→快照→spawn→探针循环；不阻断 prepared/switched 等崩溃续作）；
  - 409 `runtime_busy`（connectionState 非 ready/degraded，镜像 restart :233-237；restart-exhausted 无专门拒绝，该门自然覆盖，D2）。
- manager `applyNow()`（restoreBuiltin 骨架的 version-switch 对偶）：
  - **F2**：目标 = pending（有则用之）否则未失效 chosenVersion；仅 chosenVersion 时须先按 apply() 的 journal-first 顺序补写 `writeActivationIntent({targetVersion, targetIsBuiltin:false, manualRollback, intentKind:'version-switch'})` → `writeOverride({...pending: target, selectedOnly:false, lastOutcome:null, lastError:null})`（runStartupPhase 要求 effectivePending === targetVersion，runtime-startup.ts:338-346）；**不可复用 assertNoPending()**；**manualRollback 镜像 apply() 的降级公式**（`current !== null && compareRuntimeVersions(target, current) === -1`——降级 apply-now 与 apply()+下次启动路径语义一致，含 pre-rollback 数据 stash）；
  - `beginActivation` → `await plane.stopLocal()` → `executeStartupTransaction()` → `endActivation` → 干净/snapshot-failed 时 `plane.startLocal()` + `refreshLocalExposure()`；
  - blocked（swap-attempted/restore-half/restore-incomplete）保持 gateway 存活 + `startupBlockedReason` 投影 + retry 恢复（blocked-but-alive，index.ts:257-262）；
  - **F3**：202 异步 job 的失败必须投影进 manager 状态（`operationError`/`startupBlockedReason`，镜像 restart() :1237-1243），不能只落日志；`applyNowInFlight` 访问器供路由与 status 使用。
- 现有 `POST /chamber/runtime/apply`（置 pending，同步 200）不动。

### 5.2 结果投影（S2：零 schema 改动）
- 窗口期：status().phase==='applying'（runtime-manager.ts:836，activationInProgress 驱动）+ connectionState 诚实降级 stopped/starting。
- 成功：phase 离开 applying 且 connectionState∈{ready,degraded}，并且本次会清零/重写的
  `startupBlockedReason`/`operationError` 为空、`restoreOutcome∈{null,none,complete}`。
  `failure` 是跨动作保留的最近失败诊断，不能把历史记录误判为本次 apply-now 失败。
- 已更新 vs 已回退：activeVersion == selectedVersion → 更新成功；否则已回退。
- 失败：startupBlockedReason / operationError / 非成功 restoreOutcome 投影，走既有终态；
  `failure` 仅展示诊断，不单独决定 poll settle。
- 可选增强：一行透传 override.lastOutcome。
- settings-bridge 轮询端 `pollRemoteRuntimeUntilSettled` 强制调用者显式传
  `select|apply-now` expectation：select 保留安装任务语义，apply-now 才执行上述 live
  connection/恢复窗口判定；实例切换或组件卸载通过 AbortSignal 取消旧轮询。

### 5.3 gateway-proxy 激活感知（D3，必做）
- `GatewayProxyDeps` 增 `canExposeLocal?: () => boolean`；`resolveTarget`（gateway-proxy.ts:87-94）与 `handleUpgrade`（:175-180）增加激活门：激活事务在途（candidate 已 spawn、探针未裁决）时返回 503 `instance_unavailable`。
- index.ts 直接复用既有谓词 `() => runtimeManager === null || !runtimeManager.activationInProgress()`（:195）。
- 理由：探针只覆盖 host 侧、渲染侧兼容不在门控内（design 18 §3.4），未裁决候选不得服务在线用户；该修复同时覆盖启动路径与 restore-builtin 的既有同类暴露。

### 5.4 单进程与回收
owner.json no-follow O_EXCL + token/inode 单进程不变量不受影响；stop() 在等待 startup
continuation 前先触发 manager lifecycle abort，并 drain apply-now/F7/install 等完整 writer
promise 后才释放 owner/state lock——apply-now 在途收到 stop → journal 保留中断相位 →
下次启动 blocked-but-alive + retry，旧 job 不得在新 owner 进入后继续写。

### 5.5 /chamber/ 浏览器页（§6.4 配套）
`routes.ts` 的 /chamber/ 管理页同步实现 apply-now：runtime controls 区新增 `Apply now` 按钮（`runtime-apply-now`）与 `Applying… restarting` 窗口状态文案，经既有 `runtimeAction` 单飞 + 3s status 轮询；按钮禁用逻辑与相位/connectionState/env/read-only 门对应；硬编码英文、CSP 兼容（无内联事件），不属 i18n 面。

## 6. 状态机与 UI

### 6.1 状态 × 动作矩阵差异（零新终态）
| 状态 | 现状动作 | 新动作 |
|---|---|---|
| pending | [恢复内建] 唯一 | [立即应用 vY]（主）+ [恢复内建]（次）；[重启 dsh] 仍禁用（RUNTIME_RESTART busyPhase 已含 pending，main.ts:4184-4185） |
| applying | [恢复内建] | 不变（可见但 durable queued） |
| 其余状态 | 不变 | 不变 |
| env 源 | mutation 禁用 | 不变（env 禁立即应用；[重启 dsh] 仍可用） |

实现面：runtime-state-machine.ts 的 allowedActions pending 分支 + renderer runtime-management.ts BASE_ACTIONS 同步（含 hasOverride=false 时隐藏 apply-now）；runtime-lockstep.test.ts 精确相等断言是天然强制同步点。

### 6.2 诚实信号纪律（窗口期）
- desktop：phase='applying' + runtimeBlocked=true + runtimeBlockedReason；connections 卡 runtimeBlocksLocalStart 门控（runtime-management.ts:622-631）。
- gateway：connectionState 诚实降级 stopped/starting，runtime 面不随 ready detach（design 18 §9.3），窗口全程可轮询。
- resolve ≠ success：探针失败/回退/restore-half 必须走终态文案，绝不显示「已更新」。
- 点击后立即置 busy 并禁用整组，防同帧双击。

### 6.3 文案草案（zh / en）
- 二次确认对话框（desktop 原生 `confirmRuntimeMutation`；gateway settings-bridge 走 UI `window.confirm`，浏览器页为服务端动作无确认）：
  - zh 标题：立即切换到 v{version}？正文：dsh 将立即重启并切换到 v{version}（约 30–90 秒）。进行中的会话会中断，你的数据不受影响；若切换失败，dsh 会自动回滚并保留现场。确认/取消：立即应用并重启 / 取消。
  - en：Switch to v{version} now? / dsh will restart immediately and switch to v{version} (about 30–90 seconds). In-progress sessions will be interrupted; your data is unaffected. If the switch fails, dsh rolls back automatically and retains the recovery state. / Apply and restart / Cancel.
- 按钮/hint：pending 主按钮「立即应用 v{version} / Apply now v{version}」；pending hint 注明「切换将在下次启动生效；如需立即生效，点击『立即应用』（dsh 会短暂重启，约 30–90 秒）」；applying 窗口状态行「应用 dsh v{version}… 正在重启 / Applying dsh v{version}… restarting」。**2026-11 修订（方向感知合并按钮）**：gateway 设置区段的「仅下次启动」按钮已与独立「回滚到」按钮合并为单一方向感知主按钮——升级「更新到 vX / Update to vX」、降级「切换到 vX / Switch to vX」（`dshRuntimeActionUpdate`/`dshRuntimeActionSwitch`），执行 select+apply（apply 服务端按方向计算 manualRollback，与 desktop install 同构）；按钮下 hint（`dshRuntimeApplyNextLaunchHint`）保留「下次启动生效」语义。desktop 本地区段同步采用 更新到/切换到 文案。
- 口径：30–90 秒取就绪窗口；诚实注明探针可能延长（≤60s + 延迟裁决）。

### 6.4 i18n 新增 key（命名空间 dsh-chamber.settings.bridge，locales.ts：zh 为 key 集源、en 为 Record<keyof typeof zh>）
dshRuntimeApplyNowAction / dshRuntimeApplyNowActionWithVersion / dshRuntimeApplyNowConfirmTitle / dshRuntimeApplyNowConfirmBody / dshRuntimeApplyNowConfirmAction / dshRuntimeApplyNowHint / dshRuntimeStatusApplyingNow（7 个；`dshRuntimeApplyNextLaunchOnly` 已于 2026-11 随合并按钮移除，替代为方向感知文案 `dshRuntimeActionUpdate`/`dshRuntimeActionSwitch` + hint key `dshRuntimeApplyNextLaunchHint`）。注：`dshRuntimeApplyNowConfirmAction` 由 desktop 原生对话框以硬编码中文交付（main 进程无 i18n，与全部既有原生对话框一致），i18n key 保留为契约占位。/chamber/ 浏览器页（§5.5）硬编码英文，不属 i18n 面。

## 7. 风险登记
| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 快照一致性（运行中 DSH_HOME 有存活写者） | 中 | 高 | 先事务停机再快照（复用 restartLocal 停机段，禁裸 stopLocal）；测试注入「停机后仍有写者」 |
| R2 | 崩溃窗口（停机/快照/切指针/探针中途） | 低-中 | 高 | journal + restore-in-progress marker 幂等续作（既有）；补「运行中 entry 崩溃」重放测试 |
| R3 | 健康机把停机当「进程死亡」自动重启 → 双 spawn | 高 | 高 | 复用 stop() 的 stopping/epoch 串行化与 canSpawn 门（既有机制） |
| R4 | restart-exhausted 语义混用（apply-now respawn 误计窗口 / F7 误触发） | 中 | 中-高 | D2 明确不计窗口；F7 只对 applied-monitoring + override 触发；测试钉死两层语义 |
| R5 | known-good 24h 语义被缩短 | 低 | 中 | 时钟注入测试证明不缩短 |
| R6 | gateway 停机窗口（数秒–90s）在线用户 503 | 高（多用户） | 中 | 反代显式 503 + 状态行预告；前端重连归入 STATUS 既有门禁 |
| R7 | install 未完成时 apply-now | 低（UI 已禁用） | 中 | runtime_busy 409 + 测试 |
| R8 | 磁盘不足（快照 ENOSPC） | 低 | 高 | 复用 snapshot-failed 出口 + retry-apply |
| R9 | 候选树被在线用户提前消费（gateway proxy 窗口转发） | 中 | 中 | D3：gateway-proxy 激活门（必做） |
| R10 | abort 语义误用（宿主中止被放大为回退/内建失败终态） | 低（潜伏接缝） | 中 | abort = 事务级取消 + 回退验证探针不复用预中止 signal + 接缝测试钉死 |

## 8. 测试计划
- 8.1 共享核心（test:runtime，FakeHostAdapter + 时钟注入）：运行态激活序列（stop → snapshot → switchPointer → probe → 判卷）；崩溃注入 ×4 相位幂等续作（无第二份 post-migration 快照）；时钟推进（探针窗口 + 延迟裁决——首探针全 ok 但越过窗口 → observe → 二次探针；known-good 24h + 1 boot）；单飞矩阵（intent journal latch / queueActivationIntent 幂等）；restart-exhausted 两层语义（F7 与判卷不双回退）；apply-now 快照失败 → snapshot-failed + retry-apply；fake adapter 固化为 canonical 夹具；signal 接缝测试（原样转发 / 预 abort 立即失败且零副作用 / 回退前 abort 不污染回退判卷）。
- 8.2 desktop（test:desktop / test:control-plane）：健康交错（停机段不触发「进程死亡即重启」、applying 期间 canStartLocal 拒绝）；restart-exhausted（回退落内建 crash-loop M 次 → 终态；恢复需 start()）；handler 行为测试（`apply-now-gate.ts` 纯门函数矩阵：busy/env/相位/blocked/connectionState/F5 三源/snapshot-failed/invalid-tree/ok 优先级）；lockstep 矩阵更新；D2 窗口归属测试（候选 spawn 不计窗口、健康重启计窗口、stop/start 清窗）。
- 8.3 gateway（test:gateway）：202+poll（phase=applying + connectionState=stopped 窗口全程可轮询）；feature detach/attach（version-switch 版）；同步拒门矩阵（recovery/pending/installing/applying/restart 在途/env/Windows/no_selection（失效过滤）/invalid_target（树缺失）/noop_target（无变更）/runtime_busy（connectionState）——全部断言先于 202 同步返回）；proxy 激活门（探针窗口内 HTTP/WS 显式 503）；apply-now 失败投影（F3）；applyNowInFlight 单飞（select/apply/rollback/restoreBuiltin/restart 全拒）；F2 降级 arm manualRollback=true；浏览器页资产断言（按钮/路径/窗口文案）。
- 8.4 UI（test:settings-bridge）：动作矩阵（apply-now 在 pending 可见、busy 期禁用、env/managementSupported=false 隐藏、hasOverride=false 隐藏）；connectionState 矩阵含 degraded 正向放行；与 restart-dsh 的 busy 互斥；i18n key 集对齐（Record 类型 + verify:i18n）。

## 9. 验收门禁
- 9.1 自动化：test:runtime / test:control-plane / test:desktop / test:gateway / test:settings-bridge / typecheck:runtime / typecheck:gateway / typecheck:settings-bridge / verify:i18n / build:preload / build:gateway。
- 9.2 实机（并入 STATUS design 18 既有清单，不新建孤立门禁）：macOS 打包态 .app 运行中「立即应用」全链；Linux server gateway 生产 TLS 下 POST apply-now → 202 → 停机窗口轮询 → 探针 → 故障注入回退；restartLocal() 真实 1s grace × 健康计时器交错；Gateway restart 窗口前端重连；Windows 仅验证只读投影。

## 10. 分期实施
| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 本文档入 docs/design/ + STATUS 登记 | 评审通过 |
| P1 | 共享核心：probe signal + abort 语义 + fake adapter 固化 + 运行态激活测试（8.1） | test:runtime 全绿 |
| P2 | desktop：IPC + 纯门函数 + pending 动作 + lockstep + 健康交错测试（8.2） | test:desktop / test:control-plane 全绿 |
| P3 | gateway：apply-now 路由（preflight 拒门）+ proxy 激活门 + 409 矩阵 + 浏览器页（8.3） | test:gateway 全绿 |
| P4 | UI：按钮/文案/i18n/轮询扩展 + settings-bridge 测试（8.4） | test:settings-bridge + verify:i18n 全绿 |
| P5 | 实机门禁（9.2） | STATUS 登记结果 |

一句话总结：本设计把「立即应用」定义为——复用既有激活事务与 restartLocal 停机窗口、在 pending 相位新增一个用户触发的执行入口；共享核心只补一个 signal 参数（含 abort 事务级取消语义），gateway 侧补一个 proxy 激活门与同步 preflight 拒门，其余全部是既有原语的组合；失败路径零新终态，崩溃安全零新窗口。
