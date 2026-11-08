# docs/AGENTS.md — 文档标准

本文件是 dsh-chamber 的唯一文档标准：文档分层、写作规则、篇幅预算、评审 slop 检查表与文档变更流程。常驻仓库规则在 [`AGENTS.md`](../AGENTS.md)（Purpose / Hard Facts / 执行流），进度记录规则在 [`docs/progress/README.md`](progress/README.md)；本文件不重复它们。改文档前先读本文件，改完跑第 5 节的验证命令。

## 1. 文档分层：一个事实一个家

每个事实只有一个家；别处链接过去，不复制。按下表选区：

| 层 | 写什么 | 不写什么 |
|---|---|---|
| 根 [`AGENTS.md`](../AGENTS.md) | 常驻 orders：每个 session 都必须在上下文里的规则（Purpose / Hard Facts / 固定执行流），每条尽量 ≤3 行并链接其家；超长只能留链接 | 叙述、示例、某次改动过程、可机械查到的索引 |
| [`.agents/skills/`](../.agents/skills/) | 可复用工作流：编辑 / 送检 / 评审的步骤与命令 | 设计契约、进度状态、可机械核对的清单 |
| [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) | 贡献者地图：架构总览 / 环境 / 运行 / 构建打包 / CI 发布 / 仓库结构 / 脚本索引 | 设计契约正文、进度状态、发布叙述 |
| [`docs/design/`](design/01-overview.md) | 现行设计契约：目标、边界、数据结构、协议决定；契约变更时同一 PR 在 owning 文档补「被否方案」 | 进度状态、验收台账、**当前**版本字面值（历史证据见 §2） |
| [`docs/checklists/`](checklists/release-checklist.md) | 仅 procedure：按序执行、可勾选的验证步骤 | 版本值（tag / commit / 基线快照）、某次发布的叙述、门禁计数 |
| [`docs/progress/STATUS.md`](progress/STATUS.md) | 唯一进度记录，只记 open 项（未完成 / 待验收 / 待裁 / 接受 + 判据与指针） | 不写什么、如何增删改见 [`progress/README.md`](progress/README.md) |
| [`docs/progress/TODO.md`](progress/TODO.md) | 未排期计划与想法（A 上游 / B 平台 / C 功能 / D 工程 + 触发 / 范围 / 退出） | 进度状态、验收结果 |
| [`docs/progress/deviations.md`](progress/deviations.md) | 冻结前的双 flavor 差异结论与证据（S/T/P/G/D；冻结后只读历史参考） | 待办计划；open 项进度只在 STATUS |
| [`docs/progress/electron-frozen.md`](progress/electron-frozen.md) | Electron flavor 冻结唯一登记面：范围 / 归档清单 / 仍共享契约 / 禁用面 / 复活清单（历史参考） | 进度状态、计划细节、完成叙事 |
| [`progress/README.md`](progress/README.md) | 进度体系规则、状态词、更新与回写流程 | 业务内容 |
| [`docs/deploy/`](deploy/deploy-gateway.md) | 运维操作手册（Gateway 部署、远程 dsh 实例持久化） | 设计理由（归 design）、发布叙述 |
| [`packages/*/README.md`](../packages/control-plane/README.md) | 包契约：职责、边界（做什么 / 不做什么）、主要模块、测试入口、已知限制 | 设计全文、其他包事项、可机械查到的清单 |
| 生成块 / GENERATED | 机器单源的两个投影（[`registry.json`](../scripts/upstream/registry.json) → `registry-views.mjs --write`；[`gate-surfaces.json`](../scripts/gates/gate-surfaces.json) → `gate-workflow-views.mjs` 的 workflow 标记块） | 手改；只改单源再重生成 |
| [`README.md`](../README.md)、[`CHANGELOG.md`](../CHANGELOG.md)、`docs/*.en-US.md` | 用户面与双语镜像 | 内部进度 / 决策叙述 |

放置规则：决策 → design；进度 → STATUS；未排期 → TODO；运维 → deploy；包契约 → 包 README；常驻规则 → 根 AGENTS.md；文档规则 → 本文件；冻结范围 / 归档清单 / 复活清单 → `progress/electron-frozen.md`。

## 2. 写作规则

- **只写当前状态**：历史、演进、被否方案归 git / `CHANGELOG.md` 发布节 / design 的「被否方案」；不写「本轮 / 批次 / 已落地」叙述。
- **一个事实一个家**：怀疑重复时先 grep 特征短语；留一处，其余改成链接。
- **一段一行**：段落不物理折行（编辑器软换行）；表格、列表、代码块保持自身格式。
- **链接代替复述**：引用设计 / 脚本 / 单源时给相对链接；锚点用 GitHub slug 或显式 `<a id>`（`verify:md-links` 校验）。
- **禁止手抄目录**：包清单、门清单、脚本清单、上游触点表一律指向单源（[`gate-surfaces.json`](../scripts/gates/gate-surfaces.json)、[`registry.json`](../scripts/upstream/registry.json)、`package.json`），正文只写「去哪看」。
- **条目的进度状态词只属 STATUS**：其他文档不写条目的进度状态词（待做 / 待验收 / 待裁 / 接受；流程动作词如「上报待裁」不在此限）；需要时链接 STATUS 条目。
- **当前版本值只留单源**：tag / commit / 锁文件版本作为**现行值**不进 checklists；引用时指向 `harness.commit`、`packages/desktop/vendor/dsh/pnpm-lock.yaml` 或对应 `package.json`。**历史证据例外**：为了论证契约而引用不可变的上游 commit/tag（如某次上游修复）允许写进 design，但必须标注「历史证据，不随本仓 pin 移动」，不得据此让读者把它当成现行 pin。
- **不写规格语**：已实现的东西不写「应 / 计划 / 迁移步骤」；未实现的想法放 TODO，设计取舍放 design。
- **双语规则**：中文主档与 `docs/*.en-US.md` 镜像必须结构一致（标题层级、围栏数、表格数、注释数，`verify:i18n` 校验）；改一侧必须同批改另一侧，并经 `pnpm run verify:i18n -- --write` 重录（[`docs/i18n-record.json`](i18n-record.json) 由协调者在收尾统一重录）。
- **给确切事实**：写真实命令、路径、默认值、错误文案；不写「大概 / 应该 / 稍后补」。

## 3. 篇幅目标

- 根 `AGENTS.md` ≤ 2200 词（`wc -w AGENTS.md`）：常驻上下文预算；超预算先搬家（把细节移到其家并留链接）再压缩。
- `docs/DEVELOPMENT.md`、`docs/checklists/*`、`docs/progress/README.md` 不做硬性行数门禁：新增或改写段落必须在 PR 说明它替代 / 搬家了哪一段，行数增长要给理由（review-only）；需要机检时以改动前的 `wc -l` 为基线、只减不增。
- 预算属于评审义务：抬预算需在 PR 里说明这些词为何必须留在该层；文档规模不为「讲全」服务，为「可检索、可执行」服务。
- 新建文档前先确认既有层能否承载；新建文件必须登记到该层可达入口：贡献者入口 [`DEVELOPMENT.md`](DEVELOPMENT.md) 文档导航、用户入口根 [`README.md`](../README.md) 文档表、进度规则入口 [`progress/README.md`](progress/README.md)（至少一处）。

## 4. 评审 slop 检查表

- 重复规则：同一规则在两处出现（grep 特征短语确认）；
- 历史越界：当前态文档里出现「曾经 / 已不再 / 本轮 / 批次 / 已落地」；
- 状态注释：「已实现 / 未来会 / 待补」散落在 design、deploy、包 README；
- 手抄目录：包 / 门 / 脚本 / 触点 / 状态清单与源码或生成块可机械核对；
- 推理过程：控制流叙述、测试走查、评审往返、方案论证写进了结论文档；
- 段落墙：一段塞多条规则与插入语；
- 强调通胀：满篇加粗 / 大写 /「关键」；
- 规格语：已发货文档里的应 / 计划 / 验收标准；
- 当前版本字面值：checklist 或普通文档把 tag / commit / 锁版本当**现行值**抄写（design 里标注「历史证据」的不可变上游坐标不在此列）；
- 死链与失效锚点（`verify:md-links` 抓机械错误，评审仍要判断链接是否指向正确 owner）。

## 5. 文档变更流程

1. **定位层**：按第 1 节选择唯一家；不确定时先找 owning design / 单源，再决定写还是只加链接。
2. **改 owner 先于改投影**：先改 design / 单源 / 脚本，再改生成的 GENERATED 块（`node scripts/upstream/registry-views.mjs --write`），最后改引用页。
3. **更新引用**：移动 / 改名 / 删除时同批修所有相对链接与锚点，覆盖 README、DEVELOPMENT、progress、design、checklists。
4. **验证**（只读、可离线）：
   ```bash
   node scripts/gates/verify-md-links.mjs           # 相对链接与锚点，退出 0
   node scripts/upstream/registry-views.mjs --check # GENERATED 块与 registry.json 一致
   pnpm run verify:i18n                             # 改过双语对时的结构 / 哈希检查
   node scripts/gates/run-checks.mjs static --list   # 该模式还要跑哪些门
   ```
   > `--write` 只是重录记录；它不证明两侧语义等价——译文准确性是 review-only 义务（§6），结构对等也只覆盖骨架（标题层级 / 围栏 / 表格 / 注释）。
5. **PR 证据**：Validation 表写实际执行的命令与结果（含 `verify-md-links` 报告文档数）、未验证什么；契约类改动写「被否方案」；纯文档 PR 仍需列出跑过的门。

## 6. review-only 义务（绿灯 ≠ 满足）

以下没有脚本能判断，评审必须逐条检查；[`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) 已把它们列为勾选项：

- 契约类改动是否真权衡过「被否方案」（还考虑过什么、为什么没选它）；
- 跨包能力边界是否仍守住「接入或服务、绝不重造」：职责在根 `AGENTS.md` 的 Runtime Boundaries 表内有唯一归属，跨包依赖走既有 seam，没有把执行面 / 事实权威带进 `control-plane` 或 renderer（根 `AGENTS.md` Purpose / Runtime Boundaries；[`design/01-overview.md`](design/01-overview.md) §4/§5）；
- 新 prose 的语义质量：完整命题（actor / 条件 / 模态 / 负面保证）是否保留，推理过程是否被写进了结论；
- 双语翻译质量：`verify:i18n` 只证明结构与哈希一致，不证明译文准确；
- 文档与代码是否同一事实：命令、默认值、错误文案以源码与运行时为准，不以旧文档为准。

## 7. 与其它入口的关系

- 常驻规则：[根 `AGENTS.md`](../AGENTS.md)（Purpose / Hard Facts / 执行流）；本文件只管文档结构与写作。
- 编辑流程：[`.agents/skills/chamber-doc/SKILL.md`](../.agents/skills/chamber-doc/SKILL.md)。
- 提交前证据：[`CONTRIBUTING.md`](../CONTRIBUTING.md) 的「测试」「提交前验证」，以及 [`.agents/skills/chamber-pre-push/SKILL.md`](../.agents/skills/chamber-pre-push/SKILL.md)。
- 评审流程：[`.agents/skills/chamber-code-review/SKILL.md`](../.agents/skills/chamber-code-review/SKILL.md)。
