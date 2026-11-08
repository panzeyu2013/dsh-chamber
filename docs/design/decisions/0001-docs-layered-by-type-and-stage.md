# ADR-0001：文档按类型与生命周期分层

- 状态：accepted
- 日期：2026-11-08

## 背景

docs 同时承担设计契约、阶段操作、进度记录与运维手册；文件数量增长后，靠目录前缀与人工记忆定位，阶段清单与设计契约混在一起，引用页容易复制同一事实。需要一套可导航、可验证、可维护的分层。

## 决定

文档按**类型**（Diátaxis：explanation/reference、how-to、status）与**生命周期**（commit / push / release / upgrade / acceptance / ops / maintenance）两轴组织：

- `docs/design/` 按领域分目录，[`INDEX.md`](../INDEX.md) 是唯一设计索引；决策理由进 `design/decisions/` 的 ADR。
- `docs/checklists/` 按主阶段分目录，[`README.md`](../../checklists/README.md) 的阶段矩阵是阶段-门禁-入口的唯一来源。
- `docs/INDEX.md` 是全局导航；写规则在 [`docs/AGENTS.md`](../../AGENTS.md)。
- 文件移动 / 改名必须同批更新索引与所有相对链接；阶段不是路径的同义词，跨阶段引用用链接。

## 被否方案

- **按 commit/push/release 建 design 目录**：否决——同一 design 跨多个阶段，按阶段拆会复制契约；阶段只对 checklist 的主归属有意义。
- **保留扁平目录 + 只加 README 索引**：否决——导航能解决一部分，但索引与文件层级脱节后容易再次漂移；领域目录让 owner 更清楚。
- **一次性把所有 design 内容重写成统一模板**：否决——契约事实风险高；改为先分层与索引，再按领域逐篇收敛。

## 后果

- 迁移成本：所有旧路径链接、脚本/测试硬编码、生成视图需同批更新（本 ADR 不重复清单；以 md-links / registry 门为准）。
- 维护规则：新增文档必须登记索引；被取代 design 标 `superseded`，冻结标 `archived`；ADR 只追加。
- 后续：逐领域重写 design 内容（当前态、单一事实、链接替代复述），不与分层迁移混成一批。
