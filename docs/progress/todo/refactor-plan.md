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
| 5 | shell-core 拆分 → 解掉最后一个类型环 | 未动 | allowance 条目删除；`verify:import-cycles` 类型环归 0 |
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

## 6. 终局对账（第 16 轮，本 worktree；核心指标 = 反补丁）

| 验收指标 | 目标 | 终局实测 | 状态 |
|---|---|---|---|
| 生产 LOC | 参考（原 −9,000 指标已由用户改判作废） | 176,296 → **176,395**（新增 5 个单源 store/hook 模块；删除面净减仍为正） | 不验收（仅参考） |
| 值引用环 | 0 | **0**（3 个全断：host-logs⇄spawn-dsh、core-parse⇄core-validation、desktop gateway-provider⇄gateway-session） | 达成（门：verify:import-cycles） |
| 类型环 | 命中显式 allowance | **1**（desktop shell-core ⇄ 8 个 shell-ipc-*，allowance 内写明"须先拆 shell-core"） | 达成（棘轮钉住） |
| 死导出 | 零消费者即红 | **789 index + 796 entryless，0 dead**（5 条 seam 白名单；entryless 覆盖 desktop/renderer） | 达成（门：verify:no-dead-exports） |
| God 文件 | 只降不升 | 15 文件 **28,892**（基线 28,921+）；App 3,107 → **2,601** | 达成（棘轮；14,200 仅为目标值，非验收） |
| 跨包逐字重复 | 与台账相比不增 | 见 §6.1 复核（口径修正：多行体 31 组，其中 24 组为 3–5 行守卫；≥8 行仅 4 组且全部 parity 锁） | 复核（见 §6.1） |
| 补丁链 | 根因修复 + regression test，或登记退役条件与证据 | 已修并对锁 **10 条**：unread v1、healthErrorTick、roster 双权威、回声三镜像、facts 镜像、注册表投影镜像、watchdog runtimeFacts 镜像、mounted 来源表三副本、completed/edge 账本、视图对；**未收口已登记**：renderer 外三处（§3.1）与 legacy fold（缺支持窗口证据） | 达成 |
| 一条规则一处实现 | 单源 | shutdown / isPidAlive / jsonResponse / basenameOf 单源；11 对 state/ref 镜像**全部收口** | 达成 |
| static / tests / full / typecheck | 恒绿 | static **20/20**、tests **21/21**、full **54/54**、typecheck **0 错误** | 达成 |
| 不新增 utils/抽象包 | 约束 | 遵守：新增均为既有包内叶子/hook/store（echo/facts/remotes/roster/deadline） | 达成 |

### 6.1 跨包逐字重复复核（第 16 轮口径）

- 多行函数体（≥3 行）逐字相同且跨包：**31 组**；其中 **24 组是 3–5 行**的类型守卫/错误串助手
  （isRecord / isPlainRecord / isWatermark / errorMessage 家族，分布在 control-plane、
  client-core、gateway、renderer、runtime、seed 包）；**≥8 行的只有 4 组**，全部是 control-plane
  win-probes.ts ⇄ dsh-runtime windows-process.ts 的 parity 锁（test/protocol/win-probes-parity.test.ts 钉住）；
  其余 fork 内部重复属不可动面。
- 与台账"7 组"的差异来自**口径**而非本轮新增重复：台账只统计较大函数体，本次把全部多行体计入以
  暴露真实分布。3–5 行守卫若合并需要跨包共享叶子（引入反向依赖）或新增抽象包（违反约束），
  故登记而非强改；parity 锁组由既有测试钉住，删除即红。

**新增的机械化守卫**（防止已达成分项回退）：verify:import-cycles（值环 0 + 类型环 allowance 棘轮）、
verify:file-budgets（15 文件只降不升）、verify:no-dead-exports（20 个 index 包 + desktop/renderer
796 个 entryless 导出、5 条 seam）。三者均登记于 package.json / run-checks / ci.yml / release.yml。
