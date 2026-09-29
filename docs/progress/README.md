# 进度追踪（docs/progress）

> 本目录只放三类东西：**唯一进度记录**（`STATUS.md`）、双flavor偏差登记（`deviations.md`）、
> 未实现想法与开放计划（`todo/`，按阻塞来源分四类、每条一个文件）。事实源是 `docs/design/` 与各 `packages/*` 源码；已实现基线以git历史、
> `CHANGELOG.md` 与 `docs/design/` 为准，不在此复述实现过程。

## 目录结构

```
docs/progress/
├── README.md      # 本文档：目录、更新纪律与 todo 索引
├── STATUS.md      # 唯一进度记录：未完成/部分完成（含实机门禁）、设计未决、范围决策与必要取舍
├── deviations.md  # Electron ↔ Swift 双 flavor 偏差登记（S/T/P/G/D 条目）+ 可达性纪律与盘点
└── todo/          # 未实现想法与开放计划（每条一个文件；设计定稿或落地即移出，不保留历史台账）
    ├── upstream/    # A 上游依赖：等 deepseek-harness 落地或与之对齐的提案/计划
    ├── platform/    # B 平台与外部门禁：真机 / runner / 凭据 / 产物
    ├── features/    # C 未实现功能想法（chamber 自研）
    └── engineering/ # D 工程债：重构与性能
```

## 更新纪律

1. STATUS.md单写者：协调者维护，不允许并行agent直接写。只记仍开放项：未完成/部分完成（含真实
   设备/打包态门禁）、设计未决、仍成立的取舍（不做/推迟/移出、已知偏差与降级）；不记完成态、测试计数、
   提交哈希、轮次/批次台账与实现过程（口径见 `AGENTS.md`）。
2. 对照事实源：状态判定以源码为准（`packages/*`、`macos/`），不以设计预期为准；设计与实现有出入以源码为准
   并同步修正设计文档。
3. 实现变更**必须**回写：源码改动落地后若涉及开放项或取舍，更新STATUS.md——只记变化；条目落地或不再
   成立即删除（基线留git历史、`CHANGELOG.md` 与 `docs/design/`）。
4. 偏差双写位置：仍成立的取舍进STATUS.md；属双flavor的进 `deviations.md` 并在STATUS留一行指针。
   `deviations.md` 是偏差/取舍的可检索登记表，不替代STATUS的进度职责。
5. todo粒度与分类：每条todo停留在想法/待设计级（动机、现状对照、开放问题），按**阻塞来源**归入
   `upstream/`（等上游落地或对齐）、`platform/`（真机/runner/凭据/产物）、`features/`（chamber 自研功能想法）、
   `engineering/`（工程债：重构/性能），分类行写在文件头部。设计定稿（形成契约）即移入 `docs/design/0X-*.md`
   并从本表移除；落地或明确不做的项移出（结论进STATUS）；**不记执行过程、完成态与轮次/批次台账**（基线留 git 历史与 design）。
   新增/移动/删除文件时同步本索引与全仓引用。

## todo 索引

> 分类 = **阻塞来源**；每份文件头部有同一分类行。优先级与触发条件在各文件头与 STATUS 对应条。

### A · 上游依赖（等 deepseek-harness 落地或与之对齐；chamber 不等待）

|文件|主题|状态|
|---|---|---|
|[upstream-proposals.md](todo/upstream/upstream-proposals.md)|十一条上游提案（N-壳 selection scope、设置面声明式贡献通道 T3、归档 wire 草案、静默丢帧自愈、图标资源 id 实例私有、子代理生命周期、载波 open episode 身份、桌面专属家族门、bundle rev 内容派生、座席声明可转移、会话状态只读观察者与未读事实）|上游提案，未排期；chamber 侧不等待|
|[upstream-drift-plan.md](todo/upstream/upstream-drift-plan.md)|上游漂移剩余项：I-12/I-14/I-15 的判据/方案/关闭、已登记待退役块（触发 = capabilities.json retireWhen）、工程环境债|未排期（需实机或下一 pin）|
|[upstream-ui-parity-plan.md](todo/upstream/upstream-ui-parity-plan.md)|上游 UI 对齐：schedule 事实、置顶序/时间列/快捷键、面板入口（来源级下挂）等条目的裁决与关闭条件|面板入口（来源级下挂）已裁（design 05 §2 / 06 §4.7）；其余逐条判定（§1 = 待裁，§2 = 维持的差异与裁决）|

### B · 平台与外部门禁（真机 / runner / 凭据 / 产物）

|文件|主题|状态|
|---|---|---|
|[macos-swift-v1.md](todo/platform/macos-swift-v1.md)|macOS Swift 原生壳 companion：双端验收协议（W1–W7 判定/性能 A/B/中止点 A1–A8）+ WBS 索引|M5 实机门在 STATUS|
|[windows-v1.md](todo/platform/windows-v1.md)|Windows v1 剩余外部门禁（M0–M6）+ 基线登记口径 + 取舍指针（权威在 design 23 §5/STATUS）|待真实 Windows runner/实机/产物|

### C · 未实现功能想法（chamber 自研）

|文件|主题|状态|
|---|---|---|
|[account-login.md](todo/features/account-login.md)|账户/登录面（DeepSeek 账号 + 余额）：宿主能力已在跑，缺口 = 客户端分节 + 控制面 `/oauth/callback`；含方案 A/B、里程碑与门|**低优先，未排期**（触发 = 要用官方账号凭据/额度）|
|[deferred-features.md](todo/features/deferred-features.md)|延后功能：侧栏 subagents 显示；open-in 超集分批 S1/S2/S3（S4 与「复制 ssh/深链」已裁不做，结论在 STATUS）|未排期|

### D · 工程债（重构 / 性能）

|文件|主题|状态|
|---|---|---|
|[refactor-plan.md](todo/engineering/refactor-plan.md)|结构性重构与清理（只留开放面）：renderer 外三处 state/ref 镜像、settings 两分支合流、逐包棘轮、审计开放项、跨包重复口径、产物新鲜度守卫（§8）|未闭合（判据在 STATUS「结构性重构与清理」条）|
|[page-perf-p2.md](todo/engineering/page-perf-p2.md)|页面侧性能 P2 残项（侧栏 T2、factAt 量化、前置仪表）|推迟中（实机项在 STATUS「性能遗留」）|

> 历史：已执行计划、已收敛台账与一次性审计按「不保留历史台账」纪律删除（含早期 baseline、审计与升级线、
> remote-state 蓝图等），原文存 git 历史；仍开放的内容并入 `STATUS.md`、`deviations.md` 与 `docs/design/`。
> 已完成的部分不再入档——todo 只记「未实现/待裁」与「维持的差异」，完成态回写 design 或删除。
