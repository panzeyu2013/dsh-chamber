# 上游漂移收口计划（batch-3 剩余项）

> 分类：A · 上游依赖（等 deepseek-harness 落地/对齐；chamber 不等待）｜状态权威：STATUS「上游漂移剩余实机记录」条

范围：15 项上游漂移审计（对齐当前 pin）中**仍未落地**的项。已完成项以 git 历史、`docs/design/` 与代码注释为准，
本文不复述。每条 = 判据（源码现状）+ 方案 + 落点 + 关闭判据。上游提案（需 deepseek-harness 侧动作的）另见
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
  `RETIRED_PATCHES` 的当前状态（按 `packages/renderer/scripts/vendor-patches.mjs` 注册表现值复核；登记时为 2 条退役：ReasoningRow 行 sweep 与 util-values 引擎无关比较）。另：复核 dsh 运行时的
  `node-addon-require-builtin` 指纹表是否已收录桌面 Electron pin——当前 43.4.0 不在表内，
  Electron flavor 的托管宿主起不来（见 STATUS 设计未决；机制见 design 02 §2.6）。

## 未落地：被吞掉的上游新增面的两条升级期检查（待 vendor 物化后实现）

两条都属于「上游新功能落在 chamber 改写/不镜像的面上，静默缺席」这一类。判据（源码现状）：
`packages/renderer/src/required-extra-rows.ts` 的 inject 探针只在**运行期**生效（升级期无门）；
`docs/checklists/upstream-touchpoints.md` §7 第 5 步的侧栏声明差集仍是散文 grep（忘了不会红）。
预检侧的两条口已经落地（`preflight-vendor-pin.mjs`：dropped 面变化带理由 + 名词差集），
下面两条是该类面的判据侧闭口（P4 补 inject 探针的升级期缺口，P3 把散文 grep 脚本化），尚未实现。

- **P4 首屏 inject 闭合（并入 C4，不新增 C 编号）**：对每个首屏 covered 行，读 pin 住的
  vendor client 入口的 inject 面，断言每个成员都由 covered id / factory / 种子词提供；缺失即红
  （rc.2 的 `shortcuts` 事故形态：fiber 停 PENDING、整个壳未注册而 boot 报成功）。
  **阻塞**：inject 面只能从 vendor 各包的 client 入口解析，而本仓没有「包名 → client 入口文件」
  的既有映射（上游 manifest 的 `dsh.client` 字段形状未在本仓任何脚本里被消费过）；
  本 worktree 无 vendor 树 ⇒ 解析器无法用真实锚验证，写错会把 CI 打红。落地前置：在已物化的
  pin 上先写只读探针跑通全部首屏 id（官方 + chamber 版），再固化成纯函数 + 负例（随 `test:upgrade-tools`）。
- **P3 侧栏声明−渲染差集（§7 第 5 步的脚本化）**：上游 `sidebar.*` 声明集 − chamber 侧栏
  声明/渲染集，差集逐条要求「已渲染 / 有意不渲染（带登记理由）/ 上报待裁」。按
  `scripts/upstream/verify-mobile-anchors.mjs` 的 fail-soft + `--require-anchor-root` 严格模式落地。
  **阻塞**：同 P4（无 vendor 树验证提取器）。

关闭判据：两条在某个已物化 pin 的升级里各跑通一次（含严格模式），负例覆盖「上游新增键/成员被
本仓吞掉」与「改名假阳性」两个方向；落地时按 §7 第 5/6 步把散文 grep 换成对脚本的引用。
