# 进度追踪（docs/progress）

> 本目录只放三类东西：**唯一进度记录**（`STATUS.md`）、双flavor偏差登记（`deviations.md`）、
> 未实现功能想法（`todo/`，每条一个文件）。事实源是 `docs/design/` 与各 `packages/*` 源码；已实现基线以git历史、
> `CHANGELOG.md` 与 `docs/design/` 为准，不在此复述实现过程。

## 目录结构

```
docs/progress/
├── README.md      # 本文档：目录、更新纪律与 todo 索引
├── STATUS.md      # 唯一进度记录：未完成/部分完成（含实机门禁）、设计未决、范围决策与必要取舍
├── deviations.md  # Electron ↔ Swift 双 flavor 偏差登记（S/T/P/G/D 条目）+ 可达性纪律与盘点
└── todo/          # 未实现功能想法（每条一个文件；设计定稿或落地即移出，不保留历史台账）
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
5. todo粒度：每条todo停留在想法/待设计级（动机、现状对照、开放问题）；设计定稿（形成契约）即移入
   `docs/design/0X-*.md` 并从本表移除；落地或明确不做的项移出（结论进STATUS）。

## todo 索引

|文件|主题|状态|
|---|---|---|
|[upstream-proposals.md](todo/upstream-proposals.md)|五条上游提案：N-壳宿主selection scope、设置面声明式贡献通道（T3）、归档会话wire草案（design 24根域）、静默丢帧自愈（design 14 §D4根治面）、图标资源 id 实例私有化（design 05 §4.2）|上游提案，未排期；chamber侧不等待|
|[windows-v1.md](todo/windows-v1.md)|Windows v1剩余外部门禁（M0–M6）+ 基线登记口径（原windows-baseline.md）+ 取舍指针（权威在design 23 §5/STATUS）|待真实Windows runner/实机/产物|
|[deferred-features.md](todo/deferred-features.md)|延后功能（未排期想法）：侧边栏 subagents 显示；open-in 超集分批 S1/S2/S3（S4 不做）与 S3/S4 降级留档形态|未排期（open-in 实机验收清单在STATUS）|
|[macos-swift-v1.md](todo/macos-swift-v1.md)|macOS Swift原生壳：双端验收协议（W1–W7判定/性能A/B/中止点A1–A8）+ WBS W-01…W-32编号索引|代码面已落地；外部门禁状态在STATUS|
|[refactor-plan.md](todo/refactor-plan.md)|结构性重构与清理计划：开放工作（按优先级）、门禁与用法、边界与不做、跨包重复普查口径、未删项与判面/锁步依据、产物新鲜度守卫（§8：G2/G3/G5/G7/G8）|未闭合（开放项与判据在STATUS「结构性重构与清理」条）|

> 历史：`performance-baseline.md`、`windows-baseline.md`、`todo/electron-swift-parity-audit.md`（211 KB）与 `todo/audit-2026-12-findings.md`
> 等执行台账已按「已执行计划不留在工作文档」删除；仍开放内容并入 `STATUS.md` 与 `deviations.md`，原文存git历史。
> 另：`todo/remote-session-state-and-switch.md`（已实施计划）与 `todo/notes/` 六份蓝图（remote-state
> 实现蓝图的执行记录）按同一纪律删除——契约由 design 17 §10.7/§20、design 06 §4.2、design 19 §3.3/§3.7
> 与 `packages/*` 源码/测试承接，仍开放的实机/CI 验收项并入 `STATUS.md`「远端完成未读 / 切源体验」条。
