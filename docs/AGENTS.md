# docs/AGENTS.md — 文档标准

本文件是 dsh-chamber 的唯一文档标准：文档模型、放置规则、写作规则、篇幅与评审、变更流程。常驻仓库规则在 [`AGENTS.md`](../AGENTS.md)（Purpose / Hard Facts / 执行流）；进度记录规则在 [`progress/README.md`](./progress/README.md)；全局文档导航在 [`INDEX.md`](./INDEX.md)。改文档前先读本文件，改完跑第 5 节验证命令。

## 1. 文档模型：类型 × 生命周期

每一层只写一种类型的读者需求（Diátaxis）：教程 / how-to / reference / explanation。本仓对应关系：

| 类型 | 目录 | 写什么 | 不写什么 |
|---|---|---|---|
| Explanation + Reference | [`design/`](./design/INDEX.md) | 现行设计契约：目标、边界、数据结构、协议决定、被否方案 | 进度状态、验收台账、当前版本字面值 |
| Decision records | [`design/decisions/`](./design/decisions/README.md) | 单个架构/跨域决策：背景、决定、被否方案、后果；状态不可变 | 契约正文、进度、实现细节 |
| How-to / runbook | [`checklists/`](./checklists/README.md) | 按阶段执行、可勾选、可复跑的验证步骤 | 版本值、发布叙述、门禁计数 |
| How-to / ops | [`deploy/`](./deploy/deploy-gateway.md) | 部署、回滚、远端实例运维步骤 | 设计理由、发布叙述 |
| Status / records | [`progress/`](./progress/STATUS.md) | 唯一进度记录（STATUS 只记 open 项）、TODO、冻结/归档登记 | 设计契约、可执行步骤 |
| Reference | [`packages/*/README.md`](../packages/control-plane/README.md) | 包契约：职责、边界、模块、测试入口、已知限制 | 设计全文、其他包事项 |
| Entry / mirrors | 根 [`AGENTS.md`](../AGENTS.md)、[`README.md`](../README.md)、[`CONTRIBUTING.md`](../CONTRIBUTING.md)、[`DEVELOPMENT.md`](./DEVELOPMENT.md)、`docs/*.en-US.md` | 用户面与双语镜像 | 内部进度 / 决策叙述 |

**生命周期不是目录**：`commit / push(PR) / release / upstream upgrade / acceptance / ops / maintenance` 只出现在 [`checklists/README.md`](./checklists/README.md) 的阶段矩阵与该阶段清单头部；阶段矩阵是阶段-门禁-入口的唯一来源。design 的生命周期状态只由 [`design/INDEX.md`](./design/INDEX.md) 维护（`current / archived / superseded`）。

## 2. 放置规则：一个事实一个家

- 决策与其理由 → [`design/decisions/`](./design/decisions/README.md) 的 ADR；设计契约正文 → `design/` 的 owning 文档，ADR 只链接契约，不复制。
- 进度 / 偏差 / 冻结清单 → `progress/`；阶段步骤 → `checklists/`；运维步骤 → `deploy/`；包边界 → `packages/*/README.md`；常驻规则 → 根 `AGENTS.md`；文档规则 → 本文件。
- **所有文档必须登记到索引**：新 design 进 [`design/INDEX.md`](./design/INDEX.md)；新 checklist 进 [`checklists/README.md`](./checklists/README.md)；全局入口进 [`INDEX.md`](./INDEX.md)。孤立的 `.md` 文件视为未完成迁移。
- 一处事实只留一处；其余链接过去。怀疑重复时先 `grep` 特征短语。

## 3. 写作规则

- **只写当前状态**：历史、演进、被否方案归 git / `CHANGELOG.md` 发布节 / design 的「被否方案」；不写「本轮 / 批次 / 已落地」叙述。
- **一段一行**：段落不物理折行；表格、列表、代码块保持自身格式。
- **链接代替复述**：引用设计、脚本、单源、索引时给相对链接；锚点用 GitHub slug 或显式 `<a id>`（`verify:md-links` 校验）。
- **禁止手抄目录**：包 / 门 / 脚本 / 阶段 / 触点清单一律指向单源（[`gate-surfaces.json`](../scripts/gates/registry/gate-surfaces.json)、[`registry.json`](../scripts/upstream/registry/registry.json)、[`package.json`](../package.json)、[`checklists/README.md`](./checklists/README.md)），正文只写「去哪看」。
- **进度状态词只属 STATUS**：其他文档不写条目的进度状态词（待做 / 待验收 / 待裁 / 接受；流程动作词如「上报待裁」不在此限）；需要时链接 STATUS 条目。
- **当前版本值只留单源**：tag / commit / 锁文件版本作为现行值不进 design/checklists；引用时指向 `harness.commit`、`packages/desktop/vendor/dsh/pnpm-lock.yaml` 或对应 `package.json`。历史证据例外：为论证契约引用不可变的上游 commit/tag 时标注「历史证据，不随本仓 pin 移动」。
- **不写规格语**：已实现的东西不写「应 / 计划 / 迁移步骤」；未实现的想法放 TODO，设计取舍放 design/ADR。
- **双语规则**：中文主档与 `docs/*.en-US.md` 镜像结构一致（标题层级、围栏数、表格数、注释数，`verify:i18n` 校验）；改一侧同批改另一侧，并由协调者统一 `--write` 重录 [`docs/i18n-record.json`](./i18n-record.json)。
- **给确切事实**：真实命令、路径、默认值、错误文案；不写「大概 / 应该 / 稍后补」。

## 4. 篇幅预算与 slop 检查表

- 根 `AGENTS.md` ≤ 2200 词（`wc -w AGENTS.md`）：超预算先搬家再压缩，不把细节留在常驻上下文。
- `DEVELOPMENT.md`、`checklists/*`、`progress/README.md` 不做硬行数门禁；但新增/改写段落在 PR 里说明替代了哪一段，需要机检时以改动前 `wc -l` 为基线只减不增。
- 新文档前先确认既有层能承载；新建文件必须同时进对应索引（§2）。
- slop：重复规则、历史越界、状态注释、手抄目录、推理过程、段落墙、强调通胀、规格语、当前版本字面值、死链与失效锚点（机械项由 `verify:md-links` 等抓，语义项靠评审）。

## 5. 文档变更流程

1. **定位层**：按 §1/§2 找到唯一家；不确定时先找 owner 文档 / 单源 / ADR。
2. **改 owner 先于改投影**：先改 design / 单源 / 脚本，再改生成的 GENERATED 块（`node scripts/upstream/registry/registry-views.mjs --write`），最后改引用页与索引。
3. **移动 / 改名 / 删除**：同批修所有相对链接、锚点与索引（`docs/INDEX.md`、`design/INDEX.md`、`checklists/README.md`）；被取代的 design 在索引标 `superseded` 并链接新文档，冻结的标 `archived`。
4. **验证**（只读、可离线）：

   ```bash
   node scripts/gates/checks/verify-md-links.mjs           # 相对链接与锚点，退出 0
   node scripts/upstream/registry/registry-views.mjs --check # GENERATED 块与 registry.json 一致
   node scripts/gates/checks/verify-i18n.mjs               # 改过双语对时的结构 / 哈希检查
   node scripts/gates/runners/run-checks.mjs static --list   # 该模式还要跑哪些门
   ```

   `--write` 只重录记录，不证明两侧语义等价；结构对等只覆盖骨架，译文准确性是 review-only。
5. **PR 证据**：Validation 表写实际执行的命令与结果（含 `verify-md-links` 文档数）、未验证什么；契约类改动写「被否方案」；纯文档 PR 仍需列出门禁。

## 6. review-only 义务（绿灯 ≠ 满足）

- 契约类改动是否真权衡过「被否方案」（还考虑过什么、为什么没选它）；跨域决策是否新立或在 ADR 更新 `superseded`。
- 跨包能力边界是否仍守住「接入或服务、绝不重造」：职责在根 `AGENTS.md` 的 Runtime Boundaries 表内有唯一归属，没有把执行面 / 事实权威带进 `control-plane` 或 renderer（根 `AGENTS.md`；[`design/01-overview.md`](./design/01-overview.md) §4/§5）。
- 新 prose 的语义质量：完整命题（actor / 条件 / 模态 / 负面保证）是否保留，推理过程是否被写进结论。
- 双重翻译质量：`verify:i18n` 只证明结构与哈希一致，不证明译文准确。
- 文档与代码是否同一事实：命令、默认值、错误文案以源码与运行时为准，不以旧文档为准。

## 7. 与其它入口的关系

- 常驻规则：根 [`AGENTS.md`](../AGENTS.md)（Purpose / Hard Facts / 执行流）。
- 全局导航：[`docs/INDEX.md`](./INDEX.md)；设计索引：[`design/INDEX.md`](./design/INDEX.md)；阶段矩阵：[`checklists/README.md`](./checklists/README.md)。
- 编辑流程：[`.agents/skills/chamber-doc/SKILL.md`](../.agents/skills/chamber-doc/SKILL.md)。
- 提交前证据：[`CONTRIBUTING.md`](../CONTRIBUTING.md) 的「提交前验证」与 [`.agents/skills/chamber-pre-push/SKILL.md`](../.agents/skills/chamber-pre-push/SKILL.md)。
- 评审流程：[`.agents/skills/chamber-code-review/SKILL.md`](../.agents/skills/chamber-code-review/SKILL.md)。
