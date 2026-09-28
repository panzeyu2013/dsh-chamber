# 上游漂移收口计划（batch-3 剩余项）

范围：15 项上游漂移审计（对齐 pin 0.1.7-rc.2）中**仍未落地**的项。I-7（vendor 补丁 retire 检测）、
I-8（registry 桌面 seat 镜像审计）、I-10（运行位写回契约化）、I-11（单飞悬挂有界化）、I-12（谱系压制
与 fail-closed）、I-13（uplink 升级裁决点）、I-14（selection scope 第四类补丁）与工程环境债的
install/artifacts 已落地；能力门
anchors（原 E3）与验证门的 V1/V2 已收口，基线以 git 历史、`docs/design/` 与代码注释为准，本文不复述。
每条 = 判据（源码现状）+ 方案 + 落点 + 关闭判据。上游提案（需 deepseek-harness 侧动作的）另见
[upstream-proposals.md](upstream-proposals.md)。

## 批次三（P2，需实机或下一 pin）

### I-15 实机验收归并
六组矩阵的执行序已归并进 `docs/checklists/gui-acceptance-checklist.md` §4.1（怎么跑/看什么/留什么
证据），**剩余 = 在打包态/真机上各跑一次并留记录**（无新设计，只落记录）：完成未读 P6（STATUS「完成未读对齐 P6 实机验收」）、
归档两段式 + 恢复（design 24；恢复路径实机未跑）、通知行为四缺口（STATUS「通知行为测试缺口四项」）、
运行位校准 60/190/310s（`docs/checklists/session-authority-calibration.md`）；新增项 = I-14 的
selection scope（两个实例各自持久化选择槽，互不覆盖）与 I-12 的谱系压制（主分支闲置等子代理时
完成点/徽标不被误点亮、子代理结束即释放、断连窗口不误报）。

## 已登记待退役块（上游 wire 落地前**不得删**）

| 块 | 规模 | 退役触发（单一来源） |
|---|---|---|
| `packages/dsh-chamber-seed-archive-cleanup/src`（+ ~2490 行测试） | ~1560 行 | `scripts/upstream/capabilities.json` → `sessions.delete(sessionId)` 的 `retireWhen` |
| 归档管理器逐条展开（`ArchiveManagerDialog.tsx` 等） | ~711 行 | `sessions.deleteMany/bulk` 的 `retireWhen` |
| purge 墓碑机制（`purged-convergence/tracker/rows.ts`） | ~588 行 | 同单条 delete |

判据门：`node scripts/upstream/verify-capabilities.mjs`（真实 vendor 源树 6/6 aligned；上游落地即红，
红即按上表退役）。探针已用 `path#symbol` 锚点形态，退役时同批改锚点而非文本。

## 工程环境债（与批次并行）
- 下一 pin 升级时落地「真 `WorkspaceRegistry` + 真 binding」的 lockstep 测试（当前只有 ad-hoc 8/8
  证据；CI 走 node_modules 解析，本地无法验证该路径）。同步复核 vendor 补丁 retire 判定与
  `RETIRED_PATCHES` 的空缺状态（本轮 12 条补丁、0 条退役候选）。另：复核 dsh 运行时的
  `node-addon-require-builtin` 指纹表是否已收录桌面 Electron pin——当前 43.4.0 不在表内，
  Electron flavor 的托管宿主起不来（见 STATUS 设计未决；机制见 design 02 §2.6）。
