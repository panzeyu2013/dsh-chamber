# 进度追踪（docs/progress）

> 本目录**五份文档**，职责互斥：**STATUS** = 已停用（2026-11-23 用户裁决：不记录开放项/进度状态）；**TODO** =
> 未排期计划与想法；**deviations** = 冻结前的双 flavor 历史登记（Electron 已冻结，不再维护）；**electron-frozen** =
> Electron flavor 冻结登记（范围/归档清单/共享契约/禁用面/复活清单）；本 README = 规则与索引。事实源是
> `docs/design/` 与源码；已实现基线以 git 历史、`CHANGELOG.md` 与 `docs/design/` 为准。文档模型与写作规则见
> [`docs/AGENTS.md`](../AGENTS.md)；全仓文档地图见 [`docs/INDEX.md`](../INDEX.md)，设计索引见
> [`design/INDEX.md`](../design/INDEX.md)，阶段矩阵见 [`checklists/README.md`](../checklists/README.md)。

## 文件与所有权

| 文件 | 只记什么 | 不记什么 | 谁维护 |
|---|---|---|---|
| [STATUS.md](./STATUS.md) | **已停用**（2026-11-23 用户裁决）：只保留停用声明，不记录开放项/进度状态 | 开放/完成/进度/验收/偏差登记 | 不再维护 |
| [TODO.md](./TODO.md) | 未排期计划与想法：A 上游、B 平台、C 功能、D 工程；触发 / 范围 / 退出 | 进度状态、验收结果、完成记录 | 条目所有者 |
| [deviations.md](./deviations.md) | 冻结前的双 flavor 差异结论与证据（S/T/P/G/D）——**历史参考**，Electron 冻结后只读；例外：design 28 v3 载体的 Swift-only 残余 S-59…S-64 与 T-31 按 2026-11-10 裁决登记 | 待办计划、完成叙事、进度状态 | 协调者（冻结后只读） |
| [electron-frozen.md](./electron-frozen.md) | Electron flavor 冻结登记：冻结范围、归档清单、仍共享契约、禁用面、agent 规则、复活清单（不记进度） | 进度状态、计划细节、完成叙事 | 协调者 |
| README.md | 规则、索引、回写流程 | 业务内容 | 协调者 |

## STATUS 已停用（2026-11-23 用户裁决）

- `STATUS.md` **不再记录开放项 / 进度状态**；历史状态登记已移除（原文存 git 历史），文件只保留停用声明。
- **开放工作的家**：设计契约、仍成立的必要取舍与已知限制写 owning design（`docs/design/0X-*.md` 的当前契约、「已知限制」与「被否方案」）；未排期 / 未定稿的计划与想法写 [TODO.md](./TODO.md)；验收 / 发布 / 实机 / 目检 / CI 复核程序归 [`docs/checklists/`](../checklists/README.md)（release / acceptance / upgrade）；冻结面与历史偏差见 [electron-frozen.md](./electron-frozen.md) 与 [deviations.md](./deviations.md)。
- **不写**：完成 / 落地叙事、测试计数 / 绿灯清单、批次或轮次台账、commit 哈希、实现过程复述——这些属于 `CHANGELOG.md` 发布节或 git 历史。
- 需要了解当前进度时，读 owning design 的当前契约与 TODO 的触发条件；本目录**没有**「唯一进度记录」。

## 更新流程（避免再次分散）

1. **新想法**：按阻塞来源写入 [TODO.md](./TODO.md) 的 A/B/C/D。
2. **进入实施**：设计定稿写 owning design（`docs/design/`）；TODO 中已排期的计划细节可删除，只留触发条件。
3. **状态变化**：不另设进度记录——落地或明确不做即删 TODO 计划，设计始终只写当前契约（历史归 git / `CHANGELOG.md`）。
4. **双 flavor 差异（冻结前历史）**：deviations 冻结后只读，不再新增/维护行；Swift-only 差异与开放项写 owning design。**唯一例外**：design 28 v3 载体的 Swift-only 残余（S-59…S-64）与 T-31 重写按 2026-11-10 载体裁决登记在 deviations，供 design/ADR 以 S 号引用。
5. **引用稳定**：跨文件引用用 `TODO.md A§N`、`B§N`、`C§N`、`D§N`，`deviations.md` 的 S/T/P/G/D 编号，或 owning design 的章节号；编号只增不重排。
6. **改文件必同步**：新增/移动/删除条目时同步本索引与全仓引用；`node scripts/gates/checks/verify-md-links.mjs` 必须绿。

### 常见同步点

- 本 README 的索引与 TODO 的全局索引；`docs/design/`、`docs/checklists/` 的 `TODO.md` 引用；`AGENTS.md`、`DEVELOPMENT(.en-US).md` 的目录树与规则；源码注释里引用的计划条目（如 sidebar 的 A§15.1）。

## 索引

五份文档的职责与唯一家见上方「文件与所有权」表；本 README 只保留规则、回写流程与索引本身。

> 历史：已执行计划、已收敛台账与一次性审计按「不保留历史台账」纪律删除，原文存 git 历史；
> 仍开放的内容在 owning design 与 TODO 中，完成态不回写本目录。
