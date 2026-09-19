# 进度追踪（docs/progress）

> 本目录只放三类东西：**唯一进度记录**（`STATUS.md`）、**双 flavor 偏差登记**（`deviations.md`）、
> **未实现功能想法**（`todo/`，每条一个文件）。事实源是 `docs/design/`（详细设计）与各 `packages/*`
> 源码；已实现基线以 git 历史、`CHANGELOG.md` 与 `docs/design/` 为准，不在此复述实现过程。

## 目录结构

```
docs/progress/
├── README.md      # 本文档：目录、更新纪律与 todo 索引
├── STATUS.md      # 唯一进度记录：未完成/部分完成（含实机门禁）、设计未决、范围决策与必要取舍
├── deviations.md  # Electron ↔ Swift 双 flavor 偏差登记（S/T/P/G/D 条目）+ 可达性纪律与盘点
└── todo/          # 未实现功能想法（每条一个文件；设计定稿或落地即移出，不保留历史台账）
```

## 更新纪律

1. **STATUS.md 单写者**：由协调者维护，不允许并行 agent 直接写。它只记**仍开放**的东西——未完成/
   部分完成（含真实设备/打包态门禁）、设计未决、仍成立的取舍（不做/推迟/移出、已知偏差与降级）。
   不记完成态、测试计数、提交哈希、轮次/批次台账与实现过程（口径见 `AGENTS.md`）。
2. **对照事实源**：状态判定以源码为准（`packages/*`、`macos/`），不以设计文档预期为准；设计与实现
   有出入时以源码为准并同步修正设计文档。
3. **实现变更必须回写**：源码改动落地后若涉及开放项或取舍，更新 STATUS.md——只记录**变化**；
   条目一旦落地或不再成立就删除（基线留在 git 历史、`CHANGELOG.md` 与 `docs/design/`）。
4. **偏差双写位置**：仍成立的取舍进 STATUS.md；属双 flavor 的进 `deviations.md` 并在 STATUS 留一行指针。
   `deviations.md` 是偏差/取舍的可检索登记表，不替代 STATUS 的进度职责。
5. **todo 粒度**：每条 todo 停留在想法/待设计级（动机、现状对照、开放问题）；设计一旦定稿（形成契约）
   即移入 `docs/design/0X-*.md` 并从本表移除；落地或明确不做的项移出（结论进 STATUS）。

## todo 索引

| 文件 | 主题 | 状态 |
|---|---|---|
| [upstream-proposals.md](todo/upstream-proposals.md) | 四条上游提案：N-壳宿主持久化 selection 的 scope、设置面声明式贡献通道（T3）、已归档会话的 wire 草案（根治 design 24 域）、会话事实通道的静默丢帧自愈（design 14 §D4 的根治面） | 上游提案，未排期；chamber 侧不等待 |
| [windows-v1.md](todo/windows-v1.md) | Windows v1 剩余外部门禁（M0–M6）+ 基线登记口径（原 windows-baseline.md）+ 取舍指针（权威在 design 23 §5 / STATUS） | 待真实 Windows runner / 实机 / 产物 |
| [open-in-superset-batches.md](todo/open-in-superset-batches.md) | open-in 超集分批 S1/S2/S3（S4 不做）+ S3/S4 降级留档形态 | 未排期（实机验收清单在 STATUS） |
| [product-freshness-guards.md](todo/product-freshness-guards.md) | 产物新鲜度守卫：2026-12 产物普查 + G2–G8 最小守卫建议（P0/P1/P2；G1 已落地 `verify:test-wiring`） | 想法，未排期；缺口现状登记在 STATUS |
| [subagents-in-sidebar.md](todo/subagents-in-sidebar.md) | session 的 subagents 在侧边栏中的显示（嵌套子层级/跨会话总览） | 想法，未设计 / 未排期 |
| [macos-swift-v1.md](todo/macos-swift-v1.md) | macOS Swift 原生壳：双端验收协议（W1–W7 判定 / 性能 A/B / 中止点 A1–A8）+ WBS W-01…W-32 编号索引 | 代码面已落地；外部门禁状态在 STATUS |

> 历史：本目录曾同时存在 `performance-baseline.md`（测量台账）、`windows-baseline.md`（M0 基线）、
> `todo/electron-swift-parity-audit.md`（211 KB 审计台账）与 `todo/audit-2026-12-findings.md`（审计发现台账）
> 等执行台账：其仍开放的内容已分别并入 `STATUS.md`（性能实测门禁/审计发现）与 `deviations.md`（双 flavor
> 接入缺口、门禁与覆盖缺口），台账本体按「已执行计划不留在工作文档」的纪律删除，原文保存于 git 历史。
