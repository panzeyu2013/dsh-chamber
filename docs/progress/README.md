# 进度追踪（docs/progress）

> 本目录**五份文档**，职责互斥：**STATUS** = 唯一进度记录；**TODO** = 未排期计划与想法；**deviations** =
> 冻结前的双 flavor 历史登记（Electron 已冻结，不再维护）；**electron-frozen** = Electron flavor 冻结登记
> （范围/归档清单/共享契约/禁用面/复活清单）；本 README = 规则与索引。事实源是 `docs/design/` 与源码；
> 已实现基线以 git 历史、`CHANGELOG.md` 与 `docs/design/` 为准。文档模型与写作规则见 [`docs/AGENTS.md`](../AGENTS.md)；全仓文档地图见 [`docs/INDEX.md`](../INDEX.md)，设计索引见 [`design/INDEX.md`](../design/INDEX.md)，阶段矩阵见 [`checklists/README.md`](../checklists/README.md)。

## 文件与所有权

| 文件 | 只记什么 | 不记什么 | 谁维护 |
|---|---|---|---|
| [STATUS.md](./STATUS.md) | 代码/功能类开放项：待做 / 待裁 / 接受；每条 = 判据 + 指针。**验收 / 发布 / 实机 / 目检 / CI 复核不在此登记**（程序归 `docs/checklists/`） | 计划细节、证据原文、完成叙事、测试计数、过程台账、验收报告 | 协调者单写 |
| [TODO.md](./TODO.md) | 未排期计划与想法：A 上游、B 平台、C 功能、D 工程；触发 / 范围 / 退出 | 进度状态、验收结果、完成记录 | 条目所有者 |
| [deviations.md](./deviations.md) | 冻结前的双 flavor 差异结论与证据（S/T/P/G/D）——**历史参考**，Electron 冻结后不再新增/维护行；Swift-only 差异走 STATUS（例外：design 28 v3 载体的 Swift-only 残余 S-59…S-64 与 T-31 按 2026-11-10 裁决登记） | 待办计划、完成叙事、进度状态 | 协调者（冻结后只读） |
| [electron-frozen.md](./electron-frozen.md) | Electron flavor 冻结登记：冻结范围、归档清单、仍共享契约、禁用面、agent 规则、复活清单（不记进度） | 进度状态、计划细节、完成叙事 | 协调者 |
| README.md | 规则、索引、回写流程 | 业务内容 | 协调者 |

## 状态词（STATUS 条目用这些词描述；同一节可混合，不逐条打标签）

- **待做**：未开始或尚未排期；计划细节在 TODO。
- **待裁**：设计或产品未决。
- **接受**：有意差异或已知降级，不再作为待办。

## STATUS 记录规则（唯一进度记录）

- 只记**开放**项：代码/功能类的未完成 / 部分完成、设计未决、仍成立的必要取舍（不做 / 推迟 / 移出与已知偏差、降级）。
- **验收 / 发布 / 实机 / 目检 / CI 复核类工作不登记**——程序与门禁归 `docs/checklists/`（release / acceptance / upgrade），发布阻断以 `release-checklist` 与 `packaging-closure-checklist` 的 ❌ 项为准（2026-11 用户裁决）。
- **Add**：出现开放工作或登记新偏差时加一条；每条 = 开放事实 + 判据/指针（path、命令、design 引用）。
- **Remove**：工作落地或偏差不再成立即删——已实现基线归 git 历史、`CHANGELOG.md` 与 `docs/design/`，本文件不留「完成」记录。
- **Update**：模块归属、契约或不变量变化时改。除此之外不因其它事情编辑。
- 不写：`✅ 已完成 / 已落地 / 已合入` 叙事、批次或轮次台账、测试计数 / 绿灯清单、commit 哈希、实现过程复述、临时「基线对齐」块——这些属于 `CHANGELOG.md` 发布节。
- 只保留仍有决策价值、且未被 design 或 `CHANGELOG.md` 拥有的内容。

## 更新流程（避免再次分散）

1. **新想法**：按阻塞来源写入 [TODO.md](./TODO.md) 的 A/B/C/D；不写 STATUS。
2. **进入实施**：在 [STATUS.md](./STATUS.md) 建条目（状态 + 判据 + 指针）；TODO 中已排期的计划细节可删除，
   只留触发条件。
3. **状态变化**：只改 STATUS。TODO 与 deviations 不改进度状态。
4. **双 flavor 差异（冻结前历史）**：deviations 冻结后只读，不再新增/维护行；Swift-only 差异与开放项写 [STATUS.md](./STATUS.md)；历史引用仍走退役索引。accepted 不重复登记。**唯一例外**：design 28 v3 载体的 Swift-only 残余（S-59…S-64）与 T-31 重写按 2026-11-10 载体裁决登记在 deviations，供 design/ADR 以 S 号引用；其余仍走 STATUS。
5. **落地或明确不做**：STATUS 删除条目（基线留 git/CHANGELOG/design）；TODO 删除计划；deviations 冻结后不再新增/维护（历史引用留退役索引）。
6. **引用稳定**：跨文件引用用 `TODO.md A§N`、`B§N`、`C§N`、`D§N`，`deviations.md` 的 S/T/P/G/D 编号，
   或 STATUS 的条目名；编号只增不重排。
7. **改文件必同步**：新增/移动/删除条目时同步本索引与全仓引用；`node scripts/gates/checks/verify-md-links.mjs` 必须绿。

### 常见同步点

- 本 README 的索引、TODO 的全局索引与 A 部索引；
- STATUS 中指向 `TODO.md A§…` / `deviations.md` 的指针；
- `docs/design/`、`docs/checklists/` 中的 `TODO.md` 引用；
- `AGENTS.md`、`DEVELOPMENT(.en-US).md` 的目录树与规则；
- 源码注释里引用的进度条目（如 sidebar 的 A§15.1）。

## 索引

- [STATUS.md](./STATUS.md) — 唯一进度记录；按「会话链 / 通知归档 / 客户端设置 / 平台运行时 / 一致性债务」分组，
  另有差异、设计未决、范围决策。
- [TODO.md](./TODO.md) — **A 上游**（提案、漂移、UI 对齐）、**B 平台**（macOS Swift、Windows v1）、
  **C 功能**（账户、subagents、open-in）、**D 工程**（重构、产物守卫、页面性能、多实例常驻）。
- [deviations.md](./deviations.md) — Electron ↔ Swift 偏差登记（**冻结前的历史参考**，含 design 28 v3 载体 Swift-only 残余例外）+ 可达性纪律 + 退役索引。
- [electron-frozen.md](./electron-frozen.md) — Electron flavor 冻结归档：范围、归档清单、仍共享契约、禁用面、
  agent 规则与复活清单；Windows/Linux 桌面腿随之冻结、不发布。

> 历史：已执行计划、已收敛台账与一次性审计按「不保留历史台账」纪律删除，原文存 git 历史；
> 仍开放的内容在 STATUS、TODO 与 design 中，完成态不回写本目录。
