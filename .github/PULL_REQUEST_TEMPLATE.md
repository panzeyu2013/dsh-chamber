## Intent

<!-- 解决什么用户/维护者问题？行为如何变化？ -->

## Non-goals

<!-- 哪些邻近行为刻意不在本 PR 范围？仅在范围明确无歧义时写 "None"。 -->

## Affected surfaces

<!-- 涉及哪些 packages、运行时、持久化/外部契约、用户可见状态？解释为何看似相关的运行时不受影响。 -->

## Repository guidance

<!-- 列出本次改动适用的 AGENTS.md 规则、相关设计/进度文档。解释每项为何适用及遵循的关键约束，不要只列文件名。 -->

| Guidance | 为何适用 | 改动如何符合 |
|---|---|---|
|  |  |  |

## Validation

<!-- 报告执行的确切命令/人工检查与结果。说明未验证什么。不得仅凭类型/静态检查声称运行时行为正确。 -->

| Check | Result |
|---|---|
|  |  |

## Upstream touchpoint self-check

<!-- 改动含下列任一项 ⇒ 必须登记/刷新 docs/checklists/upstream-touchpoints.md 与
     scripts/dev/verify-upstream-touchpoints.mjs（漏登 = CI C1/C3 硬失败）： -->

- [ ] 无上游接触面改动（新增 `@deepseek-ai/*` 深导入、改 fork 副本、镜像 wire、新再生物、covered/assembly 行）——或已登记
- [ ] `node scripts/dev/verify-upstream-touchpoints.mjs` 通过（若改动触及触点面）

## Risks and failure behavior

<!-- 覆盖相关失败、回滚、清理、兼容性、安全、性能、数据丢失、跨运行时问题。除非有具体理由，不要写 "None identified"。 -->
