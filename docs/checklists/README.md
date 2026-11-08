# 检查清单阶段矩阵

> 本文件是**阶段 → 门禁 → 清单入口的唯一来源**：每份 checklist 只属于一个主阶段目录，跨阶段引用用链接，不复制步骤。阶段是元数据，不是自由文本。新增 / 删除 / 改主阶段时同批更新本矩阵与 [`../INDEX.md`](../INDEX.md) 的链接。

## 阶段矩阵

| 阶段 | 触发 | 入口 | 自动化 / 证据 | 退出标准 |
|---|---|---|---|---|
| commit | 本地任意编辑 | [`CONTRIBUTING.md`](../../CONTRIBUTING.md)「提交前验证」+ [`.agents/skills/chamber-pre-push`](../../.agents/skills/chamber-pre-push/SKILL.md) | 按改动面选 `node scripts/gates/runners/run-checks.mjs static --list` 的 local-only 子集 + 受影响包测试 | 触碰面无红；不要求全量 |
| push / PR | 开或更新 PR | [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md) + [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | `node scripts/gates/runners/run-checks.mjs <static\|tests\|typecheck>`（按 diff 选）；文档改动加 `verify-md-links` / `verify-i18n` / `registry-views --check` | 最终 HEAD 上的证据完整 |
| release | 版本 bump | [`release/release-checklist.md`](./release/release-checklist.md) + [`release/packaging-closure-checklist.md`](./release/packaging-closure-checklist.md) | `release-preflight`、全量套件、CI dry-run；CHANGELOG 仅在发版时写 | 清单内所有 ❌ 清零；tag / 构建 / 发布验证通过 |
| upstream upgrade | 改 pin / 升级 dsh | [`upgrade/dsh-upgrade-checklist.md`](./upgrade/dsh-upgrade-checklist.md) + [`upgrade/upstream-touchpoints.md`](./upgrade/upstream-touchpoints.md) §7 + [`upgrade/pin-alignment-checklist.md`](./upgrade/pin-alignment-checklist.md) | `update-vendor.mjs`、`verify-upstream-touchpoints`、`verify-registry`、`check-anchors`、`verify-capabilities`、回归套件 | 触点 / 锚点 / registry / 回归全绿；偏差进 STATUS |
| acceptance | UI、桥或远程行为变化 | [`acceptance/gui-acceptance-checklist.md`](./acceptance/gui-acceptance-checklist.md) + [`acceptance/remote-browser-acceptance.md`](./acceptance/remote-browser-acceptance.md) + [`acceptance/session-authority-calibration.md`](./acceptance/session-authority-calibration.md) | macOS 真机 / 目检 / 走查；linux 绿灯不替代 | 证据可复核；未覆盖项显式登记 |
| ops | 部署 / 故障 | [`../deploy/deploy-gateway.md`](../deploy/deploy-gateway.md) + [`../deploy/remote-dsh-instance.md`](../deploy/remote-dsh-instance.md) | 部署 / 回滚脚本与健康检查 | 服务恢复，或按步骤回滚 |
| maintenance | 每发版 / 季度 | [`../INDEX.md`](../INDEX.md) + [`../design/INDEX.md`](../design/INDEX.md) + 本页 | 索引状态复核、过期 / superseded / archived 清理 | 无过期契约、无重复清单、索引可达 |

## 文件头部契约（唯一一处）

每份 checklist 以 `# 标题` 开头，紧随一段元数据列表（保持在文件顶部；**不写版本值**）：

```markdown
- 阶段：<上表主阶段之一>
- 触发：<什么时候必须跑>
- Owner：<对该阶段结果负责的角色>
- Timebox：<一次执行的目标时长>
- 退出标准：<可复核的完成条件>
- 自动化入口：<命令或脚本链接；门清单指向 scripts/gates/registry/gate-surfaces.json>
- 证据：<保留在哪里 / 如何复核>
```

元数据之后写：范围与判据指针（判据权威在 design / STATUS / 源码，本文件只固定流程）→ 可执行步骤（按依赖排序）→ 失败处置 / 记录纪律。跨阶段的判据用链接引用，不复制。

## 步骤写法

- 每条步骤 = **一条命令**或**一个可观察判据**；机械检查尽量交给脚本，清单只保留判断、跨系统验收与人工证据。
- 命令从单源读值，不手抄门清单 / 包清单 / 版本值：门清单见 [`scripts/gates/registry/gate-surfaces.json`](../../scripts/gates/registry/gate-surfaces.json)，上游触点见 [`scripts/upstream/registry/registry.json`](../../scripts/upstream/registry/registry.json)。
- 步骤变更不改判据放行：判据变了先改 owning design / 单源 / 脚本，清单只跟指针（[docs/AGENTS.md](../AGENTS.md) §2）。
- 清单不记录历史与进度：历史归 `CHANGELOG.md` 与 git，进度归 [`../progress/STATUS.md`](../progress/STATUS.md)。
- 冻结面（Electron / Windows / Linux 桌面腿）不写成现行义务：步骤标注 **ARCHIVED** 并指 [`../progress/electron-frozen.md`](../progress/electron-frozen.md)；默认发布只走 macOS Swift + 共享契约。

## 维护

- 新增 / 删除 / 改主阶段：同批更新本矩阵、阶段目录与 [`../INDEX.md`](../INDEX.md) 链接；孤立文件视为未登记。
- 每次 release / upgrade 前试跑相关清单；过期步骤与失效入口在当次 PR 删除，不留「历史上用过」的步骤。
- GENERATED 块（[`upgrade/upstream-touchpoints.md`](./upgrade/upstream-touchpoints.md) §2/§9）只改单源再重生成，禁止手改（`node scripts/upstream/registry/registry-views.mjs --check` 是保鲜门）。
- 清单自身的验证：`node scripts/gates/checks/verify-md-links.mjs` 退出 0。
