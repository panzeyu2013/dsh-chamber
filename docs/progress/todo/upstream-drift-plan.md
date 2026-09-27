# 上游漂移收口计划（batch-2/3）

范围：15 项上游漂移审计（对齐 pin 0.1.7-rc.2）的**剩余项**。batch-1（I-1…I-6、I-9）与随后的
残留清理已落地，基线以 git 历史、`docs/design/` 与代码注释为准，本文不复述。每条 = 判据（源码现状）
+ 方案 + 落点 + 关闭判据。上游提案（需 deepseek-harness 侧动作的）另见
[upstream-proposals.md](upstream-proposals.md)。

## 批次二（P1，治理/加固，零行为风险）

### I-7 vendor 补丁 retire 检测
- **判据**：`packages/renderer/scripts/vendor-patches.mjs` 的 `VendorPatch` 只有锚点断言；C9 锚点
  未命中即硬失败，**无法区分**「施工错误」与「上游已修 ⇒ 可退役」，修复形态也看不到。
- **方案**：条目加可选 `retireCheck`（上游修复后的文本形状）；C9 锚点未命中时先评估：命中 ⇒ 报
  `retire-candidate`（仍 release-blocking，remediation = 移入 `RETIRED_PATCHES` 的 `ensure` 断言区，
  确保上游修复不回归）；未命中 ⇒ 维持硬失败。三类补丁（`use-chat-reading`、`util-values`、
  `ReasoningRow/assembly` 性能类）各补一条。
- **落点**：`vendor-patches.mjs`、`vendor-patches.test.mjs`（retired/active 两支）、
  `docs/checklists/dsh-upgrade-checklist.md` §1。
- **关闭**：9 个补丁各有 `retireCheck` 或明确的「无退役形态」理由。

### I-8 registry 桌面 seat 镜像覆盖
- **判据**：`scripts/upstream/registry.json` 只有 `mirror.dsh-desktop-update-chain`；实际还镜了
  `data-platform`、`dshDesktop` carrier、native theme、`dshDesktop.keyboard`/keybindings，唯一门
  `packages/desktop/upstream-seats.test.ts` 未进 C5/升级复核面。
- **方案**：对上游 `apps/desktop/src`（59 文件）做覆盖审计，三分类（mirror / different-adopted /
  not-applicable）写入 `docs/checklists/upstream-touchpoints.md`（生成块经
  `node scripts/upstream/registry-views.mjs --write`）；给 registry 补 mirror 条目；把该测试挂进
  注册面/门。
- **关闭**：审计表 + 新 mirror 条目 + 门覆盖。

### I-10 运行位写回契约化（StatusWriteFace）
- **判据**：写回读 `ClientSessions.handleSessionStatus`（不在 `ISessions` 契约）；STATUS
  「会话运行位卡死」⑭ 已登记。
- **方案**：定义 `detectStatusWriteFace(sessions): 'contract' | 'concrete' | 'none'`，executor 只依赖
  该接口：contract 走上游契约（未来落地）/ concrete 走现有成员并 WARN-once / none 退化为只读阶梯
  （不写回，靠 notice）。探测结果进 registry contract-mirror 条目 + 扩测
  `packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts`；
  `upstream-proposals.md` §4 留「契约写面」条目。
- **关闭**：三支各有单测。

## 批次三（P2，需裁决或实机）

### I-11 `session.list` 单飞悬挂有界化（残余面）
- **判据**：原判据「读链无界」经复核**不成立**（读链已有有界期限）；残余 = 官方 store 的单飞悬挂
  ⇒ 永久 loading（STATUS「会话运行位卡死」③；宿主侧需上游超时/受理即回）。
- **方案**：若仍收口，`packages/dsh-chamber-client-core/src/session-fact-reconcile.ts` 与
  `packages/renderer/src/source-mux-facts.ts` 的 unary 兜底加有界 `withDeadline`（同探针 5s 预算），
  超时记 degraded 并放弃本拍；验收 = 注入悬挂夹具单测。

### I-12 子代理事实/完整性（P5）
- **判据**：facts 行已带 `subagentCount`，但没有 `session/list` lineage 父子关系、没有「有 durable
  输出的子代」压制表、上游完整性信号缺席时没有 fail-closed。
- **方案**：用官方 `session/list` 的 lineage 字段构父子关系，只把有 durable 输出的子代纳入压制表；
  信号缺席时 fail-closed（抑制而非误报）。落点 `source-mux-facts.ts` + `completion-observation.ts`；
  验收 = unit + 实机。上游侧见 `upstream-proposals.md` §7。

### I-13 api-gateway uplink 半边（G43）
- **判据**：带 uplink 的 descriptor 同步抛错（`client-uplink-rejection.test.ts`），fail-loud 已接受。
- **方案**：维持 fail-loud，在 registry/checklist 加「uplink 是否进运行时闭包」的升级裁决点；真机出现
  需求再重放 rc.2 客户端半边。

### I-14 selection scope（上游提案 §1）
- **判据**：`createSnapshotStore` 的 persist 名是页面级单键，N-ctx 跨实例污染；当前只有 client 侧回显
  缓解（无法根治，store 属 vendor 树且不在三个 fork 副本内）。
- **方案（可选根治）**：新增**第 4 类 vendor 补丁**（「多实例正确性」）把 persist 名 scoped
  （`dsh.sessions.current.<chamberBasePath>`），并保证 `current === undefined` 只清本 scope；需维护者
  扩展 `vendor-patches.mjs` 头部的三类准入裁决。备选 = 维持现有回显缓解。
- **关闭**：裁决 + 补丁 `retireCheck`（上游传 scope 即退役）。

### I-15 实机验收归并
四组矩阵各留一组实机记录（无新设计，只落记录）：
完成未读 P6（STATUS「完成未读对齐 P6 实机验收」）、归档两段式 + 恢复（design 24；恢复路径实机未跑）、
通知行为四缺口（STATUS「通知行为测试缺口四项」）、运行位校准 60/190/310s
（`docs/checklists/session-authority-calibration.md`）。

## 已登记待退役块（上游 wire 落地前**不得删**）

| 块 | 规模 | 退役触发（单一来源） |
|---|---|---|
| `packages/dsh-chamber-seed-archive-cleanup/src`（+ ~2490 行测试） | ~1560 行 | `scripts/upstream/capabilities.json` → `sessions.delete(sessionId)` 的 `retireWhen` |
| 归档管理器逐条展开（`ArchiveManagerDialog.tsx` 等） | ~711 行 | `sessions.deleteMany/bulk` 的 `retireWhen` |
| purge 墓碑机制（`purged-convergence/tracker/rows.ts`） | ~588 行 | 同单条 delete |

判据门：`node scripts/upstream/verify-capabilities.mjs`（真实 vendor 源树 6/6 aligned；上游落地即红，
红即按上表退役）。

## 工程环境债（与批次并行）
- `pnpm install`（react/react-dom/esbuild/zod/…）解锁 4 个 react 测试与官方包套件；聚合
  `node scripts/gates/run-checks.mjs static|tests` 另需 `pnpm run build:artifacts`（9 个产物）。
- 下一 pin 升级时落地「真 `WorkspaceRegistry` + 真 binding」的 lockstep 测试（当前只有 ad-hoc 8/8
  证据；CI 走 node_modules 解析，本地无法验证该路径）。
- 能力门探针由纯文本匹配升级为 `path#symbol` 锚点解析（复用 `check-anchors` 的声明解析）。

## 验证面缺类（本轮审计残留的规则化提案）
- **现状**：`verify:no-dead-exports` 只判「经 package entry 可达的**运行时**导出」⇒ type-only 导出
  （本轮人工收窄 11 个）与「仅测试引用」的导出（`PendingSession`、`PENDING_SESSION_TTL_MS`/
  `PENDING_ARCHIVE_TTL_MS`/`PENDING_MAX_AGE_MS` 这类 pin 常量）都不被判。
- **提案**：门加一条「仅测试引用的导出须在脚本内 allowlist 给出一句理由」；type-only 面是否纳入判定
  待裁决（类型常作文档面，误报风险高）。
