# 结构性重构与清理计划（refactor-plan）

> 分类：D · 工程债（重构）｜状态权威：STATUS「结构性重构与清理」条

范围：dsh-chamber 生产代码（packages/**，不含 test/scripts/dist/generated）的结构精简、重复消除与债务门禁。
本文只记**开放工作与仍成立的判据**；已完成基线以 git 历史、代码注释与 `docs/design/` 为准，本文不复述。
**行数单一来源 = `scripts/gates/file-budgets.json`，本文不写数**。用户裁决：**行数删减不强制**，
原 −9,000 指标作废；核心指标 = 消除补丁式修改（根因、单源、先锁后删）。本仓的债务形态是**补丁式修改**
（双权威、state/ref 镜像、成对写、轮询计数），不是重复行。

## 1. 开放工作（按优先级）

| # | 工作 | 现状 | 验收判据 |
|---|---|---|---|
| 1 | renderer **外**三处 state/ref 镜像：`sidebar-root-projection.ts`（useState + serversRef）、`InstanceView.tsx`（activeRef/settledRef）、`DshRuntimeSection.tsx`（confirmLaunchRef） | 未收口（renderer 内 11 对已收口，基线在 git 历史与各 host store 注释） | 渲染值走 useSyncExternalStore 小 store（单源）、事件回调读 store 的 getSnapshot()，删 ref 镜像；不引入状态库/新包 |
| 2 | settings 两分支合流：`DshRuntimeSection` 的 gateway/local 共享 controller | 未动 | runtime-management / 设置桥套件绿；先补 parity 测试再合并 |
| 3 | 逐包棘轮收尾：`file-budgets.json` 的 15 个文件只降不升 | 逐轮下降中 | `verify:file-budgets` + `check:static`/`check:tests` 恒绿 |
| 4 | §5 的审计开放项 | 未动 | 各自条目内 |

## 2. 已核结论（不再排期）

- **跨包逐字重复**：见 §6——既有约束下**可删 0 组**，登记而非强改。
- **vendor 声明成员并集**：上界 ≈100 行、需动 8 个 tsconfig，ROI 低 → 不做（入档）。
- **有意的保留**：安全清理类残留（`.tmp` 残留 / askpass 旧目录 / autostart）保留，不删。

## 3. 门禁与用法

- 证据选择：`node scripts/gates/run-checks.mjs <static|tests|typecheck|full>`（`--list` 看完整计划）
  ——模式名与 ci.yml / release 验证一致，本地通过即同一份证据。
- 本重构相关三门：`verify:import-cycles`（值环 0 + 类型环 allowance——现为空）、`verify:file-budgets`
  （15 个 God 文件只降不升）、`verify:no-dead-exports`（零消费者导出即红）。
- 现状：三门已在 `package.json` / `run-checks.mjs` 注册，但按 2026-09-25 裁决**只在本地跑**（ci.yml / release.yml 不再承载，`static-gate-parity` 的 `STATIC_GATE_EXEMPTIONS` 登记该单侧状态；STATUS「结构性重构与清理」条同记）。

## 4. 边界与不做

- 不新增 utils/抽象包；不引入状态库；不做全仓重写。
- 不动 design 14 会话权威链、上游 fork（dsh-client-connection / dsh-client-web / dsh-api-gateway /
  vendor）、Swift 业务面与已移出项（design 01 §4/§5）。
- 不把"再导出/转发"当成减量；不把格式化折叠当减量。

## 5. 审计开放项（未排期）

- **renderer reconnect 记账**：`App.tsx` 的 `retireSources` 仍缺 `sessionListRefreshAt/Pending`、
  `authoritativeArchiveSet`（同 id 换代泄漏）。收口 = 单一 `reconnectSource(id)` + 生命周期参与者注册表。
- **session-state 语义多实现**：协议在 control-plane（`session-state-protocol.ts` + `session-mux.ts`）、
  gateway（`session-state.ts`）、renderer（`session-facts-source.ts` + `source-mux-facts.ts`）各有一份；
  守卫/助手跨包重复（登记时 `isWatermark` 命中 11 个文件、`isPlainRecord` 7 个），锁步只有源码文本测试；
  `classifyTurnEndWire` 仍与 `classifyTurnEnd` 成对。死面已部分消失（`effectiveReadMark`、
  `SESSION_STATE_PROBE_TIMEOUT_MS` 已不存在），仍在的 `sessionStateNoteKey` / `SESSION_STATE_ROUTES`
  由单测锁住。收口方向 = 共享协议叶子（或生成物）+ 删死面。
- **插件三链路流水线**：local/ssh/gateway 各自 validate→confirm→remove/add→restart→verify；desktop
  `plugin-sync.ts` 与客户端行投影（settings-connections 的 `plugin-model.ts`/`save-host.ts`）仍两套。
  收口方向 = 一个 `PluginMutationPlan` + 三个薄执行器。
- **未纳棘轮的 god 文件**：control-plane `index.ts`/`proxy-forward.ts`/`spawn-dsh.ts`、gateway
  `dispatch.ts`/`plugins.ts`、dsh-runtime 多个 `runtime-*` 文件、desktop `updater.ts`/`main.ts`、Swift
  `MainWindowController`/`AppDelegate`/`BridgeClient`、`install-gateway.sh`——下一轮按包逐个纳入棘轮。
- **死导出门覆盖洞**：client-ui 包整包在 `RUNTIME_LOADED_PACKAGES`（`verify-no-dead-exports.mjs`），
  `./client/**` 不受判；已知零消费者导出 `isFixedSectionId`、`transportTargetChangedSpec`
  （`sourceFingerprintIsCurrent`/`staleOwnedSessionIds`/`orderApplyOps`/`BATCH_FAILURE_POLICY` 已随实现
  消失，勿再寻找）。
- **真实第二实现**：`openPromise` 三态证据在 mobile `session-stall.ts` 与 open-in
  `session-stream-health-probe.ts` 仍是两份；`safeStorage` 访问器 5 份（gateway-provider / host-assembly /
  main / registry-projection / sidecar-ctx）；spec 分类的客户端对照文件（原 `plugin-diff.ts`）已不存在——
  下一轮先重新取证再收口。
- **client/seed god 文件与形态**：`PluginDialog.tsx`（约 32 个 useState）、`ConnectionsSection.tsx`、
  `ServerSection.tsx`（JSX 内派生状态残留）等已在棘轮内；`dsh-chamber-seed-git-worktree/src/core.ts`、
  `dsh-chamber-seed-archive-cleanup/src/core.ts`、`packages/dsh-chamber-client-ui-mobile/src/client/composer.ts`、`packages/dsh-chamber-client-ui-mobile/src/client/styles.ts`、
  `renderer/src/live-graph.ts` 待下一轮裁决是否纳入棘轮。

## 6. 跨包逐字重复复核（口径与结论）

- 口径：多行函数体（≥3 行）逐字相同且跨包为重复；台账只统计较大函数体，两者差异属**口径**而非新增重复。
- 结论：在既有约束（不新增抽象包、不动 fork、不引入反向依赖）下**可删 0 组**，登记而非强改。唯一成组的是
  control-plane `win-probes.ts` ⇄ dsh-runtime `windows-process.ts` 的 parity 锁（`test/protocol/win-probes-parity.test.ts`
  钉住，删除即红）；其余为 3–5 行守卫/错误串助手与 fork 内部重复。

## 7. 未删项与判面/锁步依据（非漏做）

- `sessionStateNoteKey` / `SESSION_STATE_ROUTES`：单测锁住读水位规则与路由字面量；需先做 §5 的 session-state
  协议单源，否则删除只减锁不减实现。（`effectiveReadMark` / `SESSION_STATE_PROBE_TIMEOUT_MS` 已不存在，
  勿再寻找。）
- `pendingStats`（现 control-plane `dsh-client.ts`，原 gateway）：已注释的测试诊断缝，删除即失去 settle-once
  覆盖——属 seam，不是未接线泄漏。（原条目中的 `deferredIntentsFilePath`/`plugins-tasks.ts` 已不存在。）
- `transportTargetChangedSpec`（settings-connections `save-host.ts`）：跨端镜像缝，删除即失去覆盖。
- `dsh-stream-state/swift` 的 Swift 镜像现只剩 `CarrierDecision.swift`；`LoadState` 镜像已按 design 14 §D4 退役，勿再寻找。
- client-ui `./client/**` 仍在死导出门判面之外（整包在 `RUNTIME_LOADED_PACKAGES`）：扩判面需逐包注册客户端半
  seam，独立一轮。
- `safeStorage` 访问器 5 份 / spec 分类两套 / session-row 三转换 / reconnect 第四臂：属 §5 单源条目，需各自先
  补跨端锁步测试。

## 8. 产物新鲜度守卫（G2/G3/G5/G7/G8；未排期）

> 产物新鲜度：`desktop/dist/control-plane/**`（标记守卫）、`gateway/dist/**`（标记守卫）、
> `gateway/host-packages/dsh-chamber-client-ui-mobile/**`、`desktop/dist/preload.cjs`、
> `renderer/src/generated/**` 与 `gateway/dist/index.js`（用包自身 build.mjs 重建-比对）已有「陈旧/缺失 ⇒ 红」的
> 比对门（`scripts/gates/verify-artifact-freshness.mjs` 的 tests/full，经 `ci.yml` 进 CI）；seed `dist/index.js` ×4 +
> `dsh-runtime/dist/index.js` + mobile `dist`/`lib` 的新鲜度归 C8（`scripts/upstream/verify-upstream-touchpoints.mjs`
> 重建-比对，清单单一来源 `scripts/lib/build-artifacts.mjs`）；`scripts/gates/verify-electron-artifacts.mjs`
> 的 macOS 腿/CI 另执行编译产物冒烟。G1=`verify:test-wiring`、G4/G6 同属该门。本节只留仍无守卫的产物与最小
> 守卫建议；开放状态见 `docs/progress/STATUS.md`「产物新鲜度」条，design 21 §7 登记。

### 1. 仍无守卫的产物

|产物|生成者|提交？|当前守卫|陈旧后果|
|---|---|---|---|---|
|`packages/desktop/dist/web/**`|renderer `build`（vite `build.outDir = ../desktop/dist/web`，三处路径契约见 `packages/desktop/scripts/electron-shared.mjs`）|忽略|只有路径契约文本断言（`scripts/electron-shared.test.mjs`）与 CI 的 scoper 标记断言|打包发行旧前端壳（IPC 名/槽位可能漂移）|
|`packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`|`scripts/build-host-graph-package.mjs`（各 seed 包 `dist` cpSync）|忽略|只有行序/outDir 断言（`scripts/release/packaging-manifest-lockstep.test.mjs`）|打包 seed 旧宿主包|
|vendor `allowBuilds` 锁步（根 `pnpm-workspace.yaml` ↔ `packages/dsh-runtime/src/allow-builds.mjs`）|人工同步|提交|无|新增原生依赖漏登或漏 deny 会静默漂移|

`dist/` 整族在 `.gitignore`：干净 checkout 的"缺失"是正常态——首批 host/dsh-runtime/mobile 产物须先由
`pnpm run build:artifacts` 自举，其余按需构建；要防的是本地/打包态的"存在但陈旧"——CI 每次全新构建，看不到这一类。
上表 `scripts/*` 指 `packages/desktop/scripts/*`（Electron 构建脚本；gateway 侧 `packages/gateway/scripts/*`），
非仓库根 `scripts/`。

### 2. 最小守卫建议

- **P0 G2 产物新鲜度登记表**：产物 ↔ 生成者 ↔ 守卫或豁免一张表，门禁断言每个产物都有守卫或显式豁免（§1 全部）。
  成本低–中（表 + 纯函数）；收益：杜绝静默。
- **P0 G8 豁免表**：不需要守卫的产物显式记理由（§1 全部）。成本低；收益：防止 G2 表被"全部豁免"掏空——豁免也要有人签。
- **P1 G3 `.build-manifest.json` 输入摘要**：构建时写 `{inputsHash, toolVersion, outputs[]}`，测试比对；比标记串强——
  无文案产物（web/host-package）也能判。适用全部忽略态产物。成本中（每构建脚本一处 + 比对函数）。
- **P1 G5 `before-pack` 打包前兜底**：既有 `scripts/before-pack.mjs` 断言 `dist/web`、`preload.cjs`、
  `host-*-package`、`control-plane` 存在且不早于其输入（mtime 兜底；fresh checkout 缺失另判）。适用打包闭包。
- **P2 G7 vendor allowBuilds 锁步**：断言根 `pnpm-workspace.yaml` 的 `allowBuilds` 与
  `packages/dsh-runtime/src/allow-builds.mjs` 的 `ALLOW_BUILDS`/`DENY_BUILDS` 镜像关系。成本低；收益：把 AGENTS
  的硬事实从人工同步变成门。

### 3. 开放问题

- 标记串（现状）vs 输入摘要（G3）是否并存值得。
- 失败信息**必须**给重建命令，否则操作者只看到红、不知下一步。
- CI 腿的边界：CI 每次全新构建，"陈旧"只在本地/打包态出现——要真覆盖得在打包作业跑 G5。
