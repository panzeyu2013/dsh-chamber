# 结构性重构与清理计划（refactor-plan）

范围：dsh-chamber 生产代码（packages/**，不含 test/scripts/dist/generated）的结构精简、重复消除与
债务门禁。本文只记**开放工作**与**实测证据**；已完成基线以 git 历史与代码注释为准。

## 1. 实测基线（本 worktree 实测口径）

行数口径：`packages/*` 下非 test/scripts/dist/generated 的 .ts/.tsx/.cts/.mjs 行数合计。

| 时点 | 生产 LOC | 备注 |
|---|---|---|
| 基线（HEAD 9c5c8493，本轮开工） | 176,296 | 审计口径 |
| 第 1–10 轮（结构拆分/单源/删除） | 176,168 | 唯一一次真实净减（unread v1 兼容层）；App 3,107→2,630 |
| 第 11–15 轮（截止原语 + 5 个单源 store/hook） | 176,395 | 新增模块 ~220 行，同轮删除面净减为正 |

> 用户裁决（第 11 轮）：**行数删减不强制**，行数只作参考；原 −9,000 指标作废。
> 核心指标 = 消除补丁式修改（根因、单源、先锁后删），见 §6。

## 2. 实测证据（为什么"删重复"空间有限）

- 跨包逐字重复：见 §6.1（口径修正后为 31 组多行体，其中 24 组是 3–5 行类型守卫；≥8 行仅 4 组，
  全部为 win-probes parity 锁）；在既有约束（不新增抽象包、不动 fork）下**可删 0 组**。
- 插件三链路（gateway/local/ssh handler）合计 745 行，逐字重复 0 段。
- vendor 契约：8 个 .d.ts，20/27 模块声明唯一，7 个共享 module 的成员互不相交，合并上界 ≈100 行
  （需动 8 个 tsconfig），ROI 低 → 入档。
- God 文件拆分只搬行不删行；真正的减量只能来自删机制/删功能域（用户未授权删功能域）。
- 结论：本仓的债务形态是**补丁式修改**（双权威、state/ref 镜像、成对写、轮询计数），不是重复行。

## 3. 开放工作（按优先级）

| # | 工作 | 当前状态 | 验收判据 |
|---|---|---|---|
| 1 | renderer 容器重写：state/ref 镜像折入 store，删每来源表三处手抄 prune（已迁出 budgets/servers/账本/托管探针；App 现 2,601） | 见下 §3.1（9/11 已收口） | `verify:file-budgets` 棘轮下降；renderer 套件绿；文本锁随实现落点更新 |
| 2 | settings 两分支合流：DshRuntimeSection 的 Gateway/local 共享 controller | 未动 | runtime-management / 设置桥套件绿；先补 parity 测试再合并 |
| 3 | 死补丁退役：A1 F2–F7、writer 闩锁死路、legacy 迁移块 | 第 18 轮按用户裁决删除：ssh 凭据 v1/v2 迁移、gateway-tokens v1/v2 + 旧兄弟文件迁移、catalog v1 迁移、json-store 就地迁移机件、`foldLegacyHostInserts`；安全清理（`.tmp` 残留/askpass 旧目录/autostart）保留 | 每个被删分支先有 regression test（旧文件→`*.corrupt` 断言已补） |
| 4 | vendor 声明成员并集 | 未动（上界 ≈100 行，ROI 低） | 8 个包 typecheck 全绿；`verify:import-cycles` 不新增 |
| 5 | shell-core 拆分 → 解掉最后一个类型环 | **类型面已收口**（seam 类型迁往 host-edges / shell-assembly-ctx / shell-ipc-ctx / registry-projection；shell-core 2,492→1,821，棘轮已下调）；值面（投递状态机/路径解析/运行时解析，至 target 1,600）未动 | allowance 条目已删除；`verify:import-cycles` 类型环 0（已达成）；棘轮继续下降 |
| 6 | 逐包收尾：derive/instance-api/aggregate-store/plugin-sync/gateway-provider/ssh-provider/transport-manager/session-state | 未动 | 见 `scripts/gates/file-budgets.json`；棘轮逐轮下降，`check:static`/`check:tests` 恒绿 |

### 3.1 state/ref 同步镜像清单（11 对全部收口 + 第 16 轮审计补充项）

"一个状态两个权威源 + 手写同步"就是补丁式修改的典型形态。收口方向：**渲染值走
useSyncExternalStore 的小 store（单源），事件回调读 store 的 getSnapshot()，删掉 ref 镜像**；
不引入状态库、不新增包。

| 对 | 状态 | 迁移顺序 |
|---|---|---|
| `remoteRosterSettled` | ✅ `host/roster-gate.ts`（generation 单源；`canReplayRosterIntents(state, ref)` 双权威助手已删除） | 1 |
| `rosterListenerReady` | ✅ 同一 gate 的 `listenerReady`（teardown 只写 ref 不写 state 的旧补丁一并消失） | 1 |
| `workspaceEcho` / `sessionEcho` / `sessionArchive` | ✅ `host/echo-store.ts` 单快照三表；state/ref 三对镜像与三个双写回调删除，identity 守卫由 store 内部承担 | 2 |
| `sessionFacts` / `runtimeFacts` | ✅ `host/facts-store.ts`（App + 四个 hook；渲染期 ref 镜像与"setState + 直接改 ref"双写删除，退役走唯一 `dropSession`） | 2 |
| `remoteStatus` / `remoteInstances` | ✅ `host/remotes-store.ts`（实例表 + 隧道相位单快照；"写 ref 再 setState" 的成对写与渲染期镜像删除） | 3 |
| `activeView` / `paintedView` | ✅ `host/view-store.ts`：select/paint/retire 领域操作；退役回落同拍改两字段（先于 React 提交可见），锁 `test/view-runtime/view-store.test.ts` | 4 |

**第 16 轮独立审计补充**（原清单只统计顶层同名 state/ref 对，审计又找出以下残留）：

- ✅ 已修：`watchdogRuntimeFactsRef`（`use-aggregate-refresh.ts`，runtimeFacts 的渲染期镜像；
  旧反向锁正则大小写不敏感缺口一并补上）→ 改读 `factsStore.getSnapshot().runtime`；
  锁 `facts-store.test.ts` 正则改 `/i`。
- ✅ 已收口：`snapshotSources` → `host/mounted-sources-store.ts`（mark/withdraw/retire/prune
  领域操作；ledger ref 盒与 reducer 的 lifecycle 字段一并删除）；`edgeLedgerRef` +
  `completedBySource` → `host/completed-store.ts`（相等表静默；落盘/渲染/事件读同一快照）。
- **未收口（renderer 外，已登记）**：`sidebar-root-projection.ts`（useState+serversRef 镜像
  chamberBridge store）、`InstanceView.tsx` activeRef/settledRef、`DshRuntimeSection.tsx`
  confirmLaunchRef。
- 派生值镜像（不是双权威：源是 useMemo/state 的派生值，登记备查）：
  `serversPhaseRef`、`watchdogAggregatesRef`、`unverifiedSources`+ref、
  `aggregatesRef`/`serverLabelsRef`、`serversRef`、`prewarmEligibleRef`、
  `harvestCandidatesRef`、`deferredBootRef`。

### 3.2 已修的补丁臂（regression test 已落）

- `healthErrorTick`（1 Hz 计数强制重渲染）→ `host/use-deadline.ts` 截止时刻原语；
  锁：`test/view-runtime/deadline.test.ts`（纯判定 + "tick 不得复活"）。
- unread v1 防御性导入（HEAD 无写入者）→ 删除；锁：`unread-store.test.ts` 的
  "v2 是唯一读取键，v1 载荷即使存在也必须被忽略"。
- 注册表闸门的 state/ref 双权威（`remoteRosterSettled`+`ref`、`rosterListenerReady`+`ref`、
  `canReplayRosterIntents(committed, latest)`）→ `host/roster-gate.ts` 单源 generation 语义；
  锁：`test/lifecycle/roster-gate.test.ts`。
- 三本回声账本的 state/ref 镜像（workspace/session/archive）→ `host/echo-store.ts` 单快照；
  锁：`test/session-state/echo-store.test.ts`。
- facts 两张表的渲染期 ref 镜像（`sessionFacts`/`runtimeFacts`，含两处"setState 后再改 ref"
  与两处 `delete ref.current`）→ `host/facts-store.ts`（App + 四个 hook 单一 store，
  退役收敛到唯一 `dropSession`）；锁：`test/session-state/facts-store.test.ts`。
- 注册表投影的"写 ref 再 setState"成对写（`remoteStatus` 3 处、`remoteInstances` 1 处）
  与渲染期镜像 → `host/remotes-store.ts` 单快照；锁：`test/lifecycle/remotes-store.test.ts`。
- 第 16 轮审计修复：`watchdogRuntimeFactsRef`（第三个 runtimeFacts 权威）删除改读 store；
  `use-deadline` 的 deadline→null 残留 true 与 >2^31ms 提前触发两个洞修复
  （纯判定 `deadlineFired` + 重新武装；锁扩到 stale/null/溢出三例）。
- 门禁负控补线：`verify-file-budgets` 增加 schema 校验（缺 `lines` 等不再静默放行）、
  未知参数判错、`--self-test`；新增 `verify-file-budgets.test.mjs` 与
  `verify-import-cycles.test.mjs`（解析/构图负控 + 真实仓库值环 0）并接入
  `scripts/gates/run-script-tests.mjs` 的 gates 组。
- mounted 来源表的三副本（App state + ledger ref 盒 + reducer lifecycle 字段）→
  `host/mounted-sources-store.ts`（mark/withdraw/retire/prune；reducer 不再携带该字段）；
  锁：`test/lifecycle/mounted-sources-store.test.ts`。
- 完成未读账本的三处读（completedBySource state、edgeLedger ref、落盘闭包）→
  `host/completed-store.ts`（相等表静默、退役/prune 领域操作）；锁：
  `test/session-state/completed-store.test.ts`。
- 视图对的两条渲染期 ref 镜像与"退役写 ref 再 setState"（含 §3.1 第 4 序位）→
  `host/view-store.ts`（select/paint/retire；retire 同一快照改两字段，先于提交可见）；
  锁：`test/view-runtime/view-store.test.ts`；`veil-layering-invariants` 的 8 条文本锁同步改写。
- 兼容审计（第 17 轮）结论登记：5 处旧格式读取器（ssh v2 凭据、无 binding v1、gateway-tokens v1/v2、
  catalog 无版本 v1、ssh-instances 缺 kind/transport）与 `ssh-<id>`/`ssh:<id>` 别名
  （design 17 §2.2 明确保留深链兼容 + 有测试）均有支持窗口/设计理由 → 保留；
  `removeLegacyTmpResidue`/`LEGACY_ASKPASS_DIR_NAME`/旧 autostart 清理为安全卫生项保留；
  `foldLegacyHostInserts` 去掉多余 export（函数本体保留）。
- §4/§5 清理（第 18 轮，删除优先）：5 处悬空 `session-authority-refactor.md` 引用删除；
  control-plane `escapeRegExp` 2→1（`src/regex-escape.ts`）；dsh-runtime `sameIdentity` 3→1
  （`src/file-identity.ts`；private-fs 导出面保持与 control-plane 的 parity 锁不动）；错误文本
  包内单源（control-plane 3→1、client-core 2→1、desktop 去掉 describeError 包装）；
  listener-set 原语（`client-core/src/listener-set.ts`，含 clear）在 9 处 adopt
  （renderer 7 个 host store + git coordinator + open-in choice-store）。
- 已核约束、明确不合并（非漏删）：`isRecord`/`isPlainRecord`/`isWatermark` 与 error text 的
  跨包副本——client-core `wire-common.ts` 明文「零 import、纯浏览器可达」、control-plane
  `session-mux.ts`/`session-state-protocol.ts` 明文「plain node type-strip (no node_modules)
  可加载」、上游 fork 两处禁改；gateway 是唯一无约束的消费者，单为它建 wire 守卫不构成单源。
  client-core 其余 store 的 listener 模式带 hydrate/size/clear 语义，gateway session-state 无
  client-core 依赖，均保留。desktop `pnpm-launcher` 的 pathFor/joinFor/dirnameFor 与
  dsh-runtime 同名件保留（导出它们会打破该模块自述的纯模块面）。
- `README.i18n.yaml` 的 `docs/i18n/README.md` 头由 vendor `translation-pairing-record.ts`
  生成、`dsh-client-connection/README(.zh).md` 的 `docs/config-catalog` 链接是上游 copy 继承
  ——均非本仓可控内容（改后会被覆盖），登记不删。

## 4. 门禁与用法

- 证据选择：`node scripts/gates/run-checks.mjs <static|tests|typecheck|full>`（`--list` 看完整计划）
  ——模式名与 ci.yml / release 验证一致，本地通过即同一份证据。
- 本重构新增三门：
  - `pnpm run verify:import-cycles`：值环 0（硬失败）+ 类型环显式 allowance（当前 1 条，见 §6）；
    负控由 `verify-import-cycles.test.mjs` 自动跑（解析/构图/真实仓库值环 0）；
  - `pnpm run verify:file-budgets`：15 个 God 文件只降不升（`--report` 查看，`--update-budget` 只准降）；
    表结构先经 schema 校验（缺/非整数 `lines` 立即红）、未知参数判错，`--self-test` +
    `verify-file-budgets.test.mjs` 负控；
  - `pnpm run verify:no-dead-exports`：零消费者导出即红（`ENTRYLESS_PACKAGES`/`ENTRYLESS_SEAMS`
    覆盖 desktop/renderer 的无 index 表面）。
- 三门均已登记 `package.json` / `run-checks.mjs` / `ci.yml` / `release.yml`。

## 5. 边界与不做

- 不新增 utils/抽象包；不引入状态库；不做全仓重写。
- 不动 design14 会话权威链、上游 fork（dsh-client-connection / dsh-client-web / dsh-api-gateway /
  vendor）、Swift 业务面与已移出项（design 01 §4/§5）。
- 不把"再导出/转发"当成减量；不把格式化折叠当减量（LOC 对账以基线脚本口径为准）。

## 6. 跨包逐字重复复核（口径修正）

- 多行函数体（≥3 行）逐字相同且跨包：**31 组**；其中 **24 组是 3–5 行**的类型守卫/错误串助手
  （isRecord / isPlainRecord / isWatermark / errorMessage 家族，分布在 control-plane、
  client-core、gateway、renderer、runtime、seed 包）；**≥8 行的只有 4 组**，全部是 control-plane
  win-probes.ts ⇄ dsh-runtime windows-process.ts 的 parity 锁（test/protocol/win-probes-parity.test.ts 钉住）；
  其余 fork 内部重复属不可动面。
- 与台账"7 组"的差异来自**口径**而非本轮新增重复：台账只统计较大函数体，本次把全部多行体计入以
  暴露真实分布。3–5 行守卫若合并需要跨包共享叶子（引入反向依赖）或新增抽象包（违反约束），
  故登记而非强改；parity 锁组由既有测试钉住，删除即红。

## 7. 审计轮增补（本 worktree 实测）

### 7.1 新一轮审计新增开放项（未动；供下一轮排期）

- **renderer usable-facts 三处判定分叉**：`host/servers.ts`（要求 serviceable）vs
  `use-bridge-subscriptions.ts` / `use-unread-notifications.ts/:261`（只看 verdict）；
  verdict=ok + serviceable=false 可达 ⇒ 通知与读水位从未知行推进。收口 = 单一 `isFactsUsable`。
- **renderer reconnect 记账第四份手抄**：`App.tsx` 复制 `use-aggregate-refresh.ts` 三臂
  gate/backoff；`retireSources` 漏 `sessionListRefreshAt/Pending`、`authoritativeArchiveSet`
  （同 id 换代泄漏）。收口 = 单一 `reconnectSource(id)` + 生命周期参与者注册表。
- **session-state 语义三实现**：control-plane `session-state-protocol.ts`+`session-mux.ts`、
  gateway `session-state.ts`、renderer `session-facts-source.ts`+`source-mux-facts.ts`；
  `isWatermark`×3、`isPlainRecord`×3、`classifyTurnEndWire` 复制 `classifyTurnEnd`，
  锁步只有源码文本测试。死面：`SESSION_STATE_PROBE_TIMEOUT_MS` / `effectiveReadMark` /
  `sessionStateNoteKey` / `SESSION_STATE_ROUTES`。收口方向 = 共享协议叶子（或生成物）+ 删死面。
- **插件三链路流水线**：local/ssh/gateway 各自 validate→confirm→remove/add→restart→verify；
  `parseSpec*`×3、x-wildcard 门×2、ssh/gateway 凭据镜像两套手写、dsh CLI 入口解析×3
  （`dsh-runtime/src/dsh-cli-entry.ts` 已是声明单源）。收口 = 一个 `PluginMutationPlan` + 三个薄执行器。
- **未纳棘轮的 god 文件**：control-plane `index.ts`(1577)/`proxy-forward.ts`(1471)/
  `spawn-dsh.ts`(1354)、gateway `plugins-tasks.ts`(1166)/`dispatch.ts`(1139)、dsh-runtime 5 文件
  （合计 7,267）、desktop `updater.ts`(1399)/`main.ts`(1391)、Swift `MainWindowController`(2341)/
  `AppDelegate`(1760)/`BridgeClient`(1676)、`install-gateway.sh`(3804)。下一轮按包逐个纳入棘轮。
- **未判面的死面**：`TransportProvider.kind` 零读且两处注释过时；`ENTRYLESS_PACKAGES` 的
  `ignoreFiles: ['preload.ts']` 应为 `preload.cts`（且 `.cts` 不在扫描面）；gateway
  `plugins-tasks.ts` `deferredIntentsFilePath`、`dsh-client.ts` `pendingStats` 仅测试消费。
- **load-state 镜像簇**：`packages/dsh-stream-state/swift/LoadState.swift` + 4 条 exemption
  无 app 消费者（Swift 壳不编译该文件）。裁决「接线」或「删除镜像 + 门的一半」。
- **STATUS 锚点漂移（复核后修）**：A1 F6 疑已实现（recheck 已用共享 `plugin-graph-classify`）、
  S4 行号、Swift `RendererRecovery` 183 / `RendererHangWatchdog` 111 已超 `181→90`/`105→60` 且无门、
  gateway runtime-manager「2,380 行单闭包」描述已不实。
- **client UI / seed 面（同一轮审计）**：
  - `DshRuntimeSection.tsx` 两分支可量化重复：gateway JSX 1006-1425 vs local 2024-2449，108 行逐字相同、
    最长 19 行；`onApplyRegistry`/`onRetryApply`/`onRetryRestore` 成对手抄 —— 对应 §3 第 2 项，
    收口 = 两个 hook + 一份共享行面板。
  - `PluginDialog.tsx` 66 useState / 5 个各自手写 cancelled 位的加载 effect；`ConnectionsSection.tsx`
    三份近似日志加载器（:330 / :658-699 / :722-754）；`ServerSection.tsx` 是 180 行缩进
    14 空格的"JSX 内派生状态"机械搬迁残留，且顶格 useEffect 落在 hook 块之后。均已在棘轮内，按序做。
  - **未纳棘轮的 client/seed god 文件**：`dsh-chamber-seed-git-worktree/src/core.ts` 2104（单类 60+ 方法、
    4 条删除路径）、`seed-archive-cleanup/src/core.ts` 1178、`mobile/composer.ts` 1187、
    `mobile/styles.ts` 1010、`sidebar/ServerSection.tsx` 1048。
  - **死导出门的覆盖洞**：7 个 client-ui 包全在 `RUNTIME_LOADED_PACKAGES`（整包跳过），而
    `src/index.ts` 只是 4 行 `apply()` 桩 ⇒ `./client/**` 从不受判。已知零消费者导出 6 个：
    `isFixedSectionId`、`sourceFingerprintIsCurrent`、`staleOwnedSessionIds`、`orderApplyOps`、
    `BATCH_FAILURE_POLICY`、`transportTargetChangedSpec`（另 `__resetOpenInChoiceForTests` 为显式测试缝）。
  - **真实第二实现（无锁步）**：client `plugin-diff.ts` 的 spec 分类 vs desktop
    `plugin-sync.ts`，两套语法/两套 reason 表；`openPromise` 三态证据在 mobile
    `session-stall.ts` 与 open-in `session-stream-health-probe.ts` 逐字复制；
    `safeStorage` 访问器手写 5 份。收口优先：openPromise → client-core；spec 分类 → 单一 verdict。

### 7.2 未删项与判面/锁步依据（非漏做）

**未删（有判面或锁步依据，非漏做）：**

- `effectiveReadMark` / `sessionStateNoteKey` / `SESSION_STATE_ROUTES`：单测锁住读水位规则与路由字面量；
  需先做 §3 的 session-state 协议单源，否则删除只减锁不减实现。
- `pendingStats` / `deferredIntentsFilePath` / `transportTargetChangedSpec`：已注释的测试诊断/路径/镜像缝，
  删除即失去 settle-once、持久化路径与跨端镜像覆盖（属 seam，不是未接线泄漏）。
- load-state 镜像簇（`dsh-stream-state/swift/LoadState.swift` + 4 条 exemption）：需裁决「接线到 Swift 壳」
  或「删除镜像 + parity 门的 load 半」；跨语言锁步，未单方面删。
- client-ui `./client/**` 仍在死导出门判面之外（整包在 `RUNTIME_LOADED_PACKAGES`）：扩判面需逐包注册
  客户端半 seam，独立一轮。
- `safeStorage` 访问器 5 份 / spec 分类两套 / session-row 三转换 / reconnect 第四臂：属 §3 单源条目，
  需各自先补跨端锁步测试。

## 8. 产物新鲜度守卫（剩余 G2/G3/G5/G7/G8；未排期）

> 产物新鲜度：`desktop/dist/control-plane/**`（标记守卫）、`gateway/dist/**`（标记守卫）、
> `gateway/host-packages/dsh-chamber-client-ui-mobile/**`、`desktop/dist/preload.cjs`、
> `renderer/src/generated/**` 与 `gateway/dist/index.js`（用包自身 build.mjs 重建-比对）已有「陈旧/缺失 ⇒ 红」的比对门
> （`scripts/gates/verify-artifact-freshness.mjs` 的 tests/full，经 `ci.yml:179` 进 CI；seed `dist/index.js` ×4 +
> `dsh-runtime/dist/index.js` + mobile `dist`/`lib` 的新鲜度归 C8（`scripts/upstream/verify-upstream-touchpoints.mjs`
> 重建-比对，清单单一来源 `scripts/lib/build-artifacts.mjs`）；`scripts/gates/verify-electron-artifacts.mjs`
> 的 macOS 腿/CI 另执行编译产物冒烟。G1=`verify:test-wiring`、G4/G6 同属该门）。本文只留仍无守卫的产物与最小守卫建议；开放状态与失效判据见
> `docs/progress/STATUS.md`「产物新鲜度守卫」条，design 21 §7 登记。想法清单非承诺；落地后按
> `docs/progress/README.md` 移出。

### 1. 仍无守卫的产物

|产物|生成者|提交？|当前守卫|陈旧后果|
|---|---|---|---|---|
|`packages/desktop/dist/web/**`|renderer `build`（vite `build.outDir = ../desktop/dist/web`，三处路径契约见 `packages/desktop/scripts/electron-shared.mjs`）|忽略|只有路径契约文本断言（`scripts/electron-shared.test.mjs`）与 CI 的 scoper 标记断言|打包发行旧前端壳（IPC名/槽位可能漂移）|
|`packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`|`scripts/build-host-graph-package.mjs`（各seed包 `dist` cpSync）|忽略|只有行序/outDir断言（`scripts/release/packaging-manifest-lockstep.test.mjs`）|打包seed旧宿主包|
|vendor `allowBuilds` 锁步（根 `pnpm-workspace.yaml` ↔ `packages/dsh-runtime/src/allow-builds.mjs`）|人工同步|提交|无|新增原生依赖漏登或漏deny会静默漂移|

`dist/` 整族在 `.gitignore`：干净checkout的"缺失"是正常态——首批 host/dsh-runtime/mobile 产物须先由 `pnpm run build:artifacts` 自举，其余按需构建；要防的是本地/打包态的"存在但陈旧"——CI每次全新构建，看不到这一类。

> 表中 `scripts/*` 指 `packages/desktop/scripts/*`（Electron构建脚本；gateway侧 `packages/gateway/scripts/*`），非仓库根 `scripts/`。

### 2. 最小守卫建议

#### P0（成本低、把"没有守卫"变成显式登记）

- **G2产物新鲜度登记表**：产物 ↔ 生成者 ↔ 守卫或豁免一张表，门禁断言每个产物都有守卫或显式豁免（§1全部）。成本低–中（表 + 纯函数）；收益：杜绝静默。
- **G8豁免表**：不需要守卫的产物（每次构建全新、或由C8/门禁覆盖）显式记理由（§1全部）。成本低；收益：防止G2表被"全部豁免"掏空——豁免也要有人签。

#### P1（补强，覆盖剩余产物）

- **G3 `.build-manifest.json` 输入摘要**：构建时写 `{inputsHash, toolVersion, outputs[]}`，测试比对；比标记串强——无文案产物（web/host-package）也能判。适用全部忽略态产物。成本中（每构建脚本一处 + 比对函数）；收益：不依赖"改文案时手工搬标记串"。
- **G5 `before-pack` 打包前兜底**：既有 `scripts/before-pack.mjs` 断言 `dist/web`、`preload.cjs`、`host-*-package`、`control-plane` 存在且不早于其输入（mtime兜底；fresh checkout缺失另判）。适用打包闭包。成本低；收益：开发机没跑测试也不把陈旧产物打进包。

#### P2（纪律/长尾）

- **G7 vendor allowBuilds锁步**：断言根 `pnpm-workspace.yaml` 的 `allowBuilds` 与 `packages/dsh-runtime/src/allow-builds.mjs` 的 `ALLOW_BUILDS`/`DENY_BUILDS` 镜像关系。成本低；收益：AGENTS把它列为硬事实、当前只靠人工同步——新增原生依赖漏登或漏deny会静默漂移。

### 3. 开放问题

- 标记串（现状）vs输入摘要（G3）：标记串便宜可读，但每次改文案要同步移动；两者并存是否值得。
- 失败信息**必须**给重建命令（现有比对门即如此），否则操作者只看到红、不知下一步。
- CI腿的边界：CI每次全新构建，"陈旧"只在本地/打包态出现——要真覆盖得在打包作业跑G5，而非push腿追加构建。
- smoke无PASS腿（见STATUS单列条）：是否在release作业装一次真实dsh运行时跑冒烟；不在本清单范围内。
