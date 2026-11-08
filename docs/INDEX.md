# docs 文档地图

> 本仓文档的唯一全局入口。只做导航与分层说明，不复制事实；每个事实的 owner 在下层索引或单源里。

## 入口与规范

| 入口 | 内容 |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | 常驻仓库规则：Purpose / Hard Facts / 执行流 |
| [`docs/AGENTS.md`](./AGENTS.md) | 文档标准：类型、放置、写作、篇幅、变更流程 |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | 贡献流程、提交前验证、commit 规范 |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | 环境、运行、构建、CI、仓库结构 |
| [`README.md`](../README.md) | 用户面入口 |
| [`.agents/skills/`](../.agents/skills) | 可复用工作流（文档 / 送检 / 评审） |

## 设计（Explanation + Reference）

- [`design/INDEX.md`](./design/INDEX.md)：27 篇现行/归档设计的分层索引（领域 × 状态 × owner）。
- [`design/01-overview.md`](./design/01-overview.md)：设计总览（定位、收拢原则、移出项、全局原则）。
- [`design/decisions/`](./design/decisions/README.md)：ADR 决策记录（背景 / 决定 / 被否方案 / 后果）。

## 检查清单（How-to / 阶段）

阶段与门禁的单一来源是 [`checklists/README.md`](./checklists/README.md)；按阶段进入：

| 阶段 | 入口 |
|---|---|
| commit / push(PR) | [阶段矩阵](./checklists/README.md) + [`CONTRIBUTING.md`](../CONTRIBUTING.md) / [`.agents/skills/chamber-pre-push`](../.agents/skills/chamber-pre-push/SKILL.md) |
| release | [`release/release-checklist.md`](./checklists/release/release-checklist.md) + [`release/packaging-closure-checklist.md`](./checklists/release/packaging-closure-checklist.md) |
| upstream upgrade | [`upgrade/dsh-upgrade-checklist.md`](./checklists/upgrade/dsh-upgrade-checklist.md) + [`upgrade/upstream-touchpoints.md`](./checklists/upgrade/upstream-touchpoints.md) + [`upgrade/pin-alignment-checklist.md`](./checklists/upgrade/pin-alignment-checklist.md) |
| acceptance | [`acceptance/gui-acceptance-checklist.md`](./checklists/acceptance/gui-acceptance-checklist.md) + [`acceptance/remote-browser-acceptance.md`](./checklists/acceptance/remote-browser-acceptance.md) + [`acceptance/session-authority-calibration.md`](./checklists/acceptance/session-authority-calibration.md) |
| ops | [`deploy/`](./deploy/deploy-gateway.md) |

## 进度、证据与冻结面

- [`progress/STATUS.md`](./progress/STATUS.md)：唯一 open 进度记录；规则见 [`progress/README.md`](./progress/README.md)。
- [`progress/TODO.md`](./progress/TODO.md)：未排期计划。
- [`progress/deviations.md`](./progress/deviations.md)：冻结前双 flavor 差异结论（只读历史参考）。
- [`progress/electron-frozen.md`](./progress/electron-frozen.md)：Electron 冻结登记面（范围 / 共享契约 / 禁令 / 复活清单）。

## 运维

- [`deploy/deploy-gateway.md`](./deploy/deploy-gateway.md)：Gateway 部署。
- [`deploy/remote-dsh-instance.md`](./deploy/remote-dsh-instance.md)：远程 dsh 实例持久化。

## 包契约与其它

- 各包职责与测试入口：[`packages/*/README.md`](../packages/control-plane/README.md)（包清单以 `packages/` 目录为准，不在此手抄）。
- 生成块单源：[`scripts/upstream/registry.json`](../scripts/upstream/registry.json) → `registry-views.mjs`；[`scripts/gates/gate-surfaces.json`](../scripts/gates/gate-surfaces.json) → `gate-workflow-views.mjs`。
- 双语镜像：`docs/*.en-US.md` 与中文主档成对，结构由 [`verify-i18n`](../scripts/gates/verify-i18n.mjs) 校验。

## 双语镜像

- [README.en-US.md](./README.en-US.md)
- [CONTRIBUTING.en-US.md](./CONTRIBUTING.en-US.md)
- [DEVELOPMENT.en-US.md](./DEVELOPMENT.en-US.md)
- [CHANGELOG.en-US.md](./CHANGELOG.en-US.md)
- [THIRD_PARTY_NOTICES.en-US.md](./THIRD_PARTY_NOTICES.en-US.md)
- [deploy/remote-dsh-instance.en-US.md](./deploy/remote-dsh-instance.en-US.md)
