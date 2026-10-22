# 进度追踪（docs/progress）

> 本目录四份文档，职责互斥：**STATUS** = 唯一进度记录；**TODO** = 未排期计划与想法；**deviations** = 双 flavor
> 差异结论与证据；本 README = 规则与索引。事实源是 `docs/design/` 与源码；已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/` 为准。

## 文件与所有权

| 文件 | 只记什么 | 不记什么 | 谁维护 |
|---|---|---|---|
| [STATUS.md](STATUS.md) | 所有开放项的状态：未完成 / 待验收 / 待裁 / 接受；每条 = 判据 + 指针 | 计划细节、证据原文、完成叙事、测试计数、批次台账 | 协调者单写 |
| [TODO.md](TODO.md) | 未排期计划与想法：A 上游、B 平台、C 功能、D 工程；触发 / 范围 / 退出 | 进度状态、验收结果、完成记录 | 条目所有者 |
| [deviations.md](deviations.md) | 双 flavor 差异结论与证据（S/T/P/G/D）；accepted 为主；open 行的进度以 STATUS 为准 | 待办计划、完成叙事 | 两侧维护者 |
| README.md | 规则、索引、回写流程 | 业务内容 | 协调者 |

## 状态词（STATUS 条目用这些词描述；同一节可混合，不逐条打标签）

- **待做**：未开始或尚未排期；计划细节在 TODO。
- **待验收**：实现完成，缺实机 / 打包态 / CI 证据。
- **待裁**：设计或产品未决。
- **接受**：有意差异或已知降级，不再作为待办。

## 更新流程（避免再次分散）

1. **新想法**：按阻塞来源写入 [TODO.md](TODO.md) 的 A/B/C/D；不写 STATUS。
2. **进入实施/验收**：在 [STATUS.md](STATUS.md) 建条目（状态 + 判据 + 指针）；TODO 中已排期的计划细节可删除，
   只留触发条件。
3. **状态变化**：只改 STATUS。TODO 与 deviations 不改进度状态。
4. **双 flavor 差异**：结论与证据写 [deviations.md](deviations.md)；open 项在 STATUS 留一行指针；accepted 不重复登记。
5. **落地或明确不做**：STATUS 删除条目（基线留 git/CHANGELOG/design）；TODO 删除计划；deviations 移入退役索引。
6. **引用稳定**：跨文件引用用 `TODO.md A§N`、`B§N`、`C§N`、`D§N`，`deviations.md` 的 S/T/P/G/D 编号，
   或 STATUS 的条目名；编号只增不重排。
7. **改文件必同步**：新增/移动/删除条目时同步本索引与全仓引用；`node scripts/gates/verify-md-links.mjs` 必须绿。

### 常见同步点

- 本 README 的索引、TODO 的全局索引与 A 部索引；
- STATUS 中指向 `TODO.md A§…` / `deviations.md` 的指针；
- `docs/design/`、`docs/checklists/` 中的 `TODO.md` 引用；
- `AGENTS.md`、`DEVELOPMENT(.en-US).md` 的目录树与规则；
- 源码注释里引用的进度条目（如 sidebar 的 A§15.1）。

## 索引

- [STATUS.md](STATUS.md) — 唯一进度记录；按「会话链 / 通知归档 / 插件设置 / 实机门禁 / 平台发布 / 工程债」分组，
  另有差异、设计未决、范围决策。
- [TODO.md](TODO.md) — **A 上游**（提案、漂移、UI 对齐、升级管线）、**B 平台**（macOS Swift、Windows v1）、
  **C 功能**（账户、subagents、open-in）、**D 工程**（重构、产物守卫、页面性能）。
- [deviations.md](deviations.md) — Electron ↔ Swift 偏差登记 + 可达性纪律 + 退役索引。

> 历史：已执行计划、已收敛台账与一次性审计按「不保留历史台账」纪律删除，原文存 git 历史；
> 仍开放的内容在 STATUS、TODO 与 design 中，完成态不回写本目录。
