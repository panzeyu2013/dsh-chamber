# dsh 0.1.5-rc.2 → 0.1.7-rc.2：升级指南与上游整合方案（合并单一文档）

> 适用对象：**当前 `main`**（`origin/main` = `267272b0`，2026-09-24 17:12「merge: bring the architecture refactor and the goal-hold port into main」；`v0.3.2-beta.6`；架构重构 merge = `38f970f3`（前一轮）+ `267272b0`（本轮）；源码线 pin 仍 `dsh-v0.1.5-rc.2` / `fb2c4b9e`）。
> 目标：一次性推进到 **`dsh-v0.1.7-rc.2`**（`477b4f4205`，2026-09-24；rc.1 = `46a7f68b09` 为上一目标，rc 线增量见 §20；npm `next` 已指 rc.2），并把本分支（`v016-alpha1`）在 0.1.6 上做的**全部修改与决策**按「复用 main / 移植本分支 / 单独立项」三分类吸收进来。
> **2026-09-24 重置**：本分支已重置到该 main，**只保留本计划**；0.1.6 时代的分支侧代码与文档裁决记录保留在 tag **`backup/v016-alpha1-pre-reset`**（`e0093418`，57 提交）。计划中的「冲突面/取件表」统计基于旧 main `745274e7`，执行前须按 §6.2 在新基线上重测，提取来源一律换用该 tag。
> 定位：一次性迁移台账（临时）——§0–§21 是升级执行，§22 是上游可学习/可整合面（原独立文档全文并入）。原「从当前分支路径级取件」（旧 §12）已**移除**（2026-12：main 再次大改，取件表需在新 main 上重导）；R2 的重定位纪律保留，逐项规格见 §12。执行完只把仍未完成项写回 `docs/progress/STATUS.md`，本文件删除或归档到 git 历史。
> **阅读路径**：① 执行者 → §1（基线）→ **§1.6（锚点单一来源）** → §3–§9（阶段）→ §12（逐项规格）→ §13（勾选清单）；② 评审者 → §0（结论）→ §1.5（main 重构影响）→ §10（风险与回滚）→ §14（证据模板）；③ rc 线复核 → §20（alpha.2→rc.1→rc.2 增量）→ **§20.2（rc.2 专项）** → §17（兼容清单）。
> **锚点数字唯一来源 = §1.6**；§15/§16/§20.1 的 0.1.5/alpha.2/rc.1 表是历史基线，执行时以 §1.6/§17/§20.2 为准。
> 详细的分支增量清单与 0.1.6→0.1.7 逐面研究见本文件 §6/§5；更原始的长表可用 `git show 72ee40ce:docs/progress/todo/upstream-0.1.7-upgrade.md` 取回。0.1.6-alpha.2 自身的残留项已并入 §21（原 todo 9 文档已移出）。

## 0. 结论先行

1. **这是一次大跳跃，不是两次小步**：`0.1.5-rc.2 → 0.1.7-rc.2` 上游 **8945 文件、+1348652 / −158079**（3648 commits；到 alpha.2 是 7778、到 rc.1 是 7872；rc.1→rc.2 又 346 commits / 3429 文件 / +136313 / −24518）。**目标已从 alpha.1 经 alpha.2 重钉为 rc.2**（见 §20）。
2. **直接跳跃 = 0.1.6 时代的全部适配 + 10 个 0.1.6 未覆盖的 0.1.7 独有硬破坏（H1–H10）+ 四处门禁重锚**：
   - 十个硬破坏（H1–H10；H7/H8 详见 §17-A，**H10 = rc.2 的 shortcuts 键盘桥，见 §20.2/§12.11**）：`ctx.settingsScope`→`ctx.configForms`；会话头座 `conversation.session.header.leading` 退役（新 `shell.leading`）；`Icon*Outline16`→`*OutlineRegular`；typert remote 装配 **15→23**（rc.2）；api-gateway 客户端半改双向流（`RemoteStreamHandle`/uplink）；connection `rpc.ts` 改相对路由 + 二进制响应。
   - 四处重锚：C9 vendor 补丁锚 **28→13**（rc.1 是 14，rc.2 又断 1）；C10 六锚 + 3 fork；C11 opt-in 族集合 **+6 / −1（白名单 10）**；C4 remote（本分支 19 → 目标 **23**，rc.2 新增 `schedule`，与本条同源）。
3. **`main` 已经自带一条更晚的 Swift/parity 线**（`NativeText` 121 键 + lproj、`ShellPageFacts` 主题/语言跟随、`RendererRecovery`、delta updates、刷新率/overscroll/日志）。因此本分支的 `ShellLocale.swift`、`native-theme-set` 的 **Swift 腿**、以及「窗口形态以外」的呈现机制**不再搬**，只复用 main；本分支只补 Electron 腿与缺失席位。
4. **main 仍保留插件写面**（写面源文件 `plugin-sync.ts`/`plugin-tarball.ts`/`ssh-apply-rows.ts` 仍在；架构重构改了 `plugin-sync.ts`，通道名与结构以新 main 为准），而写面退役是你 2026-09 的既有裁决（§2.1）——本次升级要把这个裁决**重放到 main 上**；唯一的过程选择是「升级内 vs 升级后独立提交」（§2.2-A，建议独立）。
5. **工作量分级（旧 main `745274e7` 实测，2026-12；重置到 `267272b0` 后需按 §1.5.1 重测）**：纯新增可直接取件的 2 项（更新链看门狗的新文件、崩溃诊断）→ 手工合并 8 项（`main.ts` 16、`shell-core.ts` 18、`updater.ts` 3、`update-headless.ts` 4、`AppUpdater.swift` 2、`ShellLog.swift` 3、`FrameCodec.swift` 1、`registry.json`/`registry.test.mjs` 6/8）→ 大冲突 2 项（启动恢复：`AppDelegate.swift` **46** + `main.ts` 16；registry）→ 重写 1 项（文档/门禁）。全仓「两边都改」**187** 文件（62 干净 / 100 冲突 / 374 块），见 §1.5（原 §12.4 冲突热点表已随取件表移除）。
6. **三条阅读入口**（另有文首「阅读路径」）：从 0.1.5 视角的**兼容性必做清单**见 §17（含本指南新增的 H7、H8 与 rc.2 的 H10 三处漏项）；**可学习/可采纳的上游改进**见 §18（含「本轮顺手 6 项」与「明确不做」）。

## 1. 基线事实与口径（执行前必读）

| 事实 | 值 | 证据 |
|---|---|---|
| main | **`267272b0`** = `origin/main`（2026-09-24；`v0.3.2-beta.6`；架构重构两轮 merge = `38f970f3` + `267272b0`）；2026-12 的 **architecture overhaul**（88 提交 / 1390 文件，`695f67c8..745274e7`）与 **2026-09-24 二次前进**（36 提交 / 745 文件，`745274e7..267272b0`）均已并入，见 §1.5/§1.5.1 | `git rev-parse origin/main`、`git rev-list --count 695f67c8..origin/main` |
| main 的源码线 pin | `dsh-v0.1.5-rc.2` = `fb2c4b9e` | `git show main:harness.commit`、`git -C vendor/harness-checkout describe --tags fb2c4b9e` |
| 目标 | **`dsh-v0.1.7-rc.2` = `477b4f4205`**（2026-09-24 21:39，PR #5180；rc.1 = `46a7f68b09` 为上一目标，差异见 §20.2） | `git -C vendor/harness-checkout rev-parse dsh-v0.1.7-rc.2` |
| 跳跃规模 | **8945 文件，+1348652 / −158079**（fb2c4b9e → 477b4f4205，3648 commits；rc.1→rc.2 = 346 commits / 3429 文件 / +136313 / −24518）；`packages` 下 package.json 集合 274 → 321 | `git -C vendor/harness-checkout diff --shortstat fb2c4b9e 477b4f4205` |
| 运行时线（npm） | `dist-tags`: `latest=0.1.5-rc.3`、`next=0.1.7-rc.2`、`alpha=0.1.7-alpha.2` → **必须钉 `0.1.7-rc.2`，不能按 latest/alpha 装** | `npm view @deepseek-ai/dsh dist-tags --json` |
| 参考分支 | 本工作树分支 `v016-alpha1` **已重置到 `origin/main`（`267272b0`）**，只保留本计划；0.1.6 两跳的分支侧内容在 tag `backup/v016-alpha1-pre-reset`（`e0093418`，57 提交；含 `72ee40ce` 迁移台账基线）——它完成了 0.1.6 的两跳与全部决策（`72ee40ce` 为迁移台账基线；取件按路径；原 §12 取件表已移除，待新 main 重导），是本指南「移植清单」的来源 | `git log --oneline origin/main..HEAD`（**48** 提交） |

**三条纪律**：

1. **不要用 `git diff main..HEAD` 当迁移补丁**：main 比旧分支叉点新（到 `745274e7` 为 **170** 提交，到 `267272b0` 为 **206** 提交；含架构重构两轮），两点 diff 会把 main 自己的改动显示成删除。分支净增量用 `git diff origin/main...HEAD`（现为 **246 文件 / +20093 / −25440**；迁移台账基线 `72ee40ce` 为 238 / +18999 / −25319）。
2. **preflight 只支持「当前 pin → tag」**（脚本读本仓 `harness.commit`，无 `--from`）。要拿 0.1.5→0.1.7 的真实结果，用影子 ROOT（`/tmp` 下放 `harness.commit=fb2c4b9e` + 软链 `packages/`、`vendor/harness-checkout`，再跑 `node scripts/upstream/preflight-vendor-pin.mjs dsh-v0.1.7-rc.2 --offline`），本轮已用此法取得 §5 的数字。
3. **升级期禁止手改 gitlink/`harness.commit`**：只走 `scripts/upstream/update-vendor.mjs <tag>`。

## 1.5 main 架构重构后的基线调整（2026-12，执行前必读；§1 的插叙）

2026-12 期间 main 前进 **88 个提交 / 1390 文件（+81967 / −89927，`695f67c8..745274e7`）**，主体是 **architecture overhaul merge（87 提交 / 1389 文件）**；**2026-09-24 再前进 36 提交 / 745 文件（+50125 / −50955，`745274e7..267272b0`），见 §1.5.1**；merge-base 仍是 `82df4c47`，pin 与版本未动（`fb2c4b9e` / `0.3.2-beta.5`）。对本计划的影响：

| 面 | 变化 | 对计划的影响 |
|---|---|---|
| **包拓扑** | `packages/` 20 → 23：新增 `dsh-chamber-client-core`（旧 `sidebar/src/shared` 的 41/43 文件提升而来，9 个消费方）、`dsh-chamber-wire`（host↔client 中立契约，`plugin-row`/`plugin-manifest` 唯一声明）、`dsh-stream-state`（纯 TS reducer 唯一所有者 + Swift 镜像 + `tables.json`） | 取件与 §12 里所有 `sidebar/src/shared/<x>` 路径映射到 `dsh-chamber-client-core/src/<x>`；P1-4/P1-7 的新代码落点改为 client-core/wire/stream-state |
| **搬迁** | sidebar `src/shared/` 整体消失；`client-plugin-loader.ts` → client-core（R059）；`session-fact-reconcile.ts` → client-core 且被重写（A/D）；`archive-purge.ts` → sidebar client；`settings-shell.ts` → client-core；`renderer/runtime-management.ts`、`renderer/svg-resource-scope.ts`、`desktop/gateway-session-test-hooks.ts` 也搬入 | 取件表按路径核对（原 §12.5，已移除）；本分支没改过这些 rename 源，搬迁与分支净增量不直接碰撞 |
| **门禁** | static 11→**18**→**20**（2026-09-24 新增 `verify:import-cycles` 与 `verify:file-budgets`；`verify:no-dead-exports` 与 `scripts/refactor/equivalence.mjs` 旧基线已有）、typecheck 10→**13**、tests 26→**28**、full 47→**59**→**61**；新增 `verify:package-boundaries`（A 禁生产面跨包相对 import、B exports 白名单）、`verify:no-dead-exports`、`verify:upstream-lifecycle-contract`、`verify:ladder-table-parity`、`verify:stream-state-swift-parity`、`verify-artifact-freshness`、`remote-state-injection-matrix`、`refactor/equivalence`、`test:stream-state`、`typecheck:stream-state`、`typecheck:runtime`；`run-checks` 支持 `--jobs N`；registry 判据 C1–C16 → **C1–C16**（C16 = vendor 源消费者双向门，新增 `vendorSourceConsumers` 块，当前唯一登记 `renderer/src/host-graph.ts` ← `dsh-client-modules` 的 `optionalStringArray`/`stripClientSuffix`）；anchors 预算 main 已降到 **665**（本树实测 720 / 预算 743） | §8/§13.5 的验收清单换成新 mode 集合；移植的 `plugin-capability.ts` 必须有真实生产消费方（否则 `verify:no-dead-exports` 红）；H9 修 `host-graph.ts` 时同步 C16 登记；整合后 `--update-budget` 以本树实测重录 |
| **冲突面** | 分支侧 M **187**（**非交集**；对旧 main `745274e7`：76 干净 / 106 冲突 / 391 块，`--diff3`）：**对新 main `267272b0` 为 61 干净 / 121 冲突 / 486 块（默认 401）**，Top 热点 `PluginDialog.tsx` 30/47、`AppDelegate.swift` 28/46、`plugin-sync.ts` 18/31、`main.ts` 16/19（详见 §1.8.1）；`main.ts` 0→**16**、`shell-core.ts` 0→**18**、`plugin-sync.ts` 4→**18**、`PluginDialog.tsx` 0→**27**、gateway `routes.ts` 4→11、gateway `index.ts` 5→10、`registry.test.mjs` 3→8、`registry.json` 2→6 | 原 §12.4 的数字与热点表已随取件表移除；「三方干净」清单作废（只剩 `preload.cts`、`registry.mjs`） |
| **registry** | main 已有 **6** 条 entries：3 fork（connection/web/**api-gateway**）+ `seed.dsh-chamber-seed-open-in` + **`seed.dsh-chamber-client-ui-layout`** + `mirror.dsh-api-session-controller-goal`（2026-09-24 新增）（type=seed，已进 `chamberNamedForks` 与 `touchpoints.fork-mirror.layout` 生成块） | §12.4 改为：**layout 不再新增 `fork.` 条目**，收敛/合并到 main 的 seed 条目；只有 sidebar 需要新登记（并补 `chamberNamedForks`/生成视图） |
| **会话/流** | design 14 §D4 已改写为 `dsh-stream-state`（reducer + `tables.json` + Swift 镜像）口径；新增 `verify:upstream-lifecycle-contract`（钉住 pin 的 host `follow` 无首帧期限 + client `doOpen` 无界 await；上游落地期限即要求退役客户端阶梯） | §12.9/P1-7 先按新 §D4 与 `packages/dsh-stream-state/src/*` 重判「chamber 自研健康臂还剩多少独立面」，再决定移植还是改为消费 reducer 输出 |
| **文档** | main 未新增升级/迁移指南（2026-09-24 新增 `todo/refactor-plan.md`），此前删了 7 份计划/蓝图（`todo/notes/*` 与 `remote-session-state-and-switch.md`）；STATUS 结构不变；`upstream-touchpoints.md` 增 C16 生成块 | 「不要整文件 checkout README/STATUS」的纪律仍然成立；本指南在 main 上不存在，搬过去时手工加索引 |
| **main 仍缺（10/10 未变）** | `shell-locale.ts`、`safe-mode.ts`（控制面+渲染端）、`startup-error.ts`、`update-schedule.ts`、`update-journal.ts`、`primary-runtime-lock.json`、`prepare-python-payload.mjs`、`CrashDiagnostics.swift`、`UpdateStallWatchdogTests.swift`、`plugin-capability.ts` 全部仍缺；`patches/` 与 `patchedDependencies` 仍未纳入 | §7 的 P0–P2 移植清单整体有效；§17-C 的 patch channel 纳入仍是待办 |

**执行口径（重置后）**：本分支已重置到 main，不再有「分支领先」；提取来源 = `backup/v016-alpha1-pre-reset`（vs 新 main `267272b0`：**1559 文件 / +168490 / −125164**，57 提交）。三方冲突统计已按新基线重测：**195 双方触碰 / 169 严格 M∩M / 121 冲突 / 486 块（`--diff3`）**（见 §1.8.1）；旧记录（187/62/100/374）作废；三方 base 仍是 `82df4c47`，原 §12.2 的三方预演命令仍适用（取件表已移除，数字待新 main 重测）。


### 1.5.1 2026-09-24 二次前进：`745274e7` → `267272b0`（36 提交 / 745 文件 / +50125 / −50955）

**主题**：① **architecture refactor merge**——新增门禁 `verify:import-cycles`/`verify:file-budgets`（`verify:no-dead-exports` 与 `scripts/refactor/equivalence.mjs` 旧基线已有）；破坏性清理（删除 pre-v2 credential/input 兼容、legacy catalog migration）；settings-bridge/control-plane/client-core 单源化。② **goal-hold port**——活动 goal 期间挂起完成通知、session 恢复与 stream-evidence 轮、ssh registry health、gateway goal projection 进 session-state wire。③ 文档：新增 `todo/refactor-plan.md`，`docs/design/*` 与 STATUS 同步刷新。

**事实**（实测）：`packages/**/package.json` 23 → 23（无增删）；registry **5 → 6**（+ `mirror.dsh-api-session-controller-goal`）；static **18 → 20**、full **59 → 61**；anchors **662 / 665**（符号锚 registry 22 + docs 126）；pin 仍 `fb2c4b9e`（`harness.commit` 未动）；**本机 gitignored 运行时树仍是旧分支 0.1.6-alpha.2，须先 `pnpm install` + `bundle:dsh --force` 刷新（否则 touchpoints C11 红）**。

**对计划的影响**：
1. **所有取件统计需重测**：§5–§12 的「187 双方都改 / 100 冲突 / 374 块」等旧口径已在 §1.8.1 重测（**195 触碰 / 169 M∩M / 121 冲突 / 486 块**）；提取来源改为 `backup/v016-alpha1-pre-reset`（vs 新 main：**1559 文件 / +168490 / −125164**，57 提交），执行前按 §6.2 的预演方法在新基线上重测。
2. **fork 面**：api-gateway 在 main 已登记为第二实现型 fork（`fork.dsh-api-gateway`，deviation **G43**，约 4600 行补丁面：carrier retry、opening deadline + silent-socket upgrade、journal stall watchdog，基于 `@dsh-chamber/dsh-stream-state`）——与我们分支的「会话流健康臂」（§12.9 / P1-7）重叠，合并时**以 main 的注册为权威**，只补我们独有的部分。
3. **破坏性清理**：pre-v2 credential/input 兼容与 legacy catalog migration 已删；分支侧若有旧路径依赖，按 R2 重定位，不恢复。
4. **新门禁**：提取后必须过 `run-checks static` 的 20 步（含 import-cycles / file-budgets / no-dead-exports）。

## 1.6 锚点值单一来源（rc.2，执行时只读这里）

> §15（0.1.5/alpha.2 细节表）、§16（alpha.2 增量）、§20.1（rc.1 基线）都是**历史基线**；下表是当前值，冲突时以下表为准（证据与命令见 §20.2 与 §17 各行）。

| 锚点 | 当前值（目标 `dsh-v0.1.7-rc.2` = `477b4f4205`） | 落点/动作 |
|---|---|---|
| C4 remote 装配 | **23 / 23**（import 序 ≠ mount 序，6 处差异；`schedule` = import#7 / mount#8） | 重建 §15.1 两表；`typert-remote-contract.mjs` EXPECTED 19 → 23 |
| 图标 | `*OutlineRegular` **79**（rc.2 +`IconArchiveOffOutlineRegular`）；组件 `*Outline16` 为 0；`IconMonitor*Regular` 仍 0（自绘） | §15.2 / §17-H3 |
| H1 设置服务 | `ctx.configForms`（`settingsScope` 全树 0 命中） | §15.3 / §17-H1 |
| H2 会话头座 | `shell.leading`（darwin 且侧栏折叠才挂载）；旧座名 0 命中；**rc.2 另需** `shortcuts` inject/hooks 与 `LayoutController(..., panelInfo)` | §15.4 / §17-H2 / §20.2 |
| H4–H6 | typert 并入 C4；gateway/connection 在 rc.2 **零 diff** → rebase 目标仍为 rc.1 形状 | §17-H4/H5/H6 |
| H7 `settings.launcher` | 座在；owner props = `{wide, openSettings, openOnboarding, settingsOpen, settingsShortcut?}` | §17-H7 |
| H8 plugin-inventory | 只消费 `entries`；管理器类型实际在 `packages/boot/plugin-manager/src/types.ts` | §17-H8 |
| H9 graph 行 | 文档相对；`fileMediaUrl` 另接受 `dsh-app://app/` | §17-H9 |
| **H10 shortcuts 键盘桥（rc.2 新增）** | `window.dshDesktop.keyboard` 必须存在，否则官方 `client/shortcuts` 构造即 throw | §17-H10 / §20.2 / §12.11 |
| C9 vendor 补丁锚 | **13/28**（`ui-conversation/assembly.ts` e2 断） | §17-D / §20.2 |
| C10 发布锚 | **`0.1.7-rc.2`**（六锚 + 3 fork + gitlink；npm `next=0.1.7-rc.2`） | §4.2 / §17-C |
| C11 opt-in 族 | **10（+6/−1）** | §17-D |
| C16 vendor 源消费者集合 | 相等（本仓生成面） | §5.3 / §8 |
| roster insert id | **85**（+time-context/schedule（`disabled`）、+shortcuts/ui-shortcuts（启用）） | §16.2 / §17-D |
| python 载荷锁 | 与 alpha.2/rc.1 **逐字节相同**；provenance `upstreamCommit` → `477b4f4205` | §15.5 / §17-C |
| upstream patches | 7 条同名；`@fortune-sheet/core` 取 **rc.2** 字节 | §17-C |
| 行号锚预算 | 新基线（main `267272b0`）实测 **662 / 665**；旧分支快照为 **720 / 743**——提取本计划/文档后按实测重录（`--update-budget` 只降不升；符号锚现为 registry 22 + docs 126） | §8 |

## 1.7 2026-12 用户裁决备忘（重置后于本文件留档）

> 四项裁决在重置前记录于 `STATUS.md` 范围决策与 design 01/05/15/20/25；完整文本保留在 tag `backup/v016-alpha1-pre-reset`，执行时按本表口径落回 STATUS/design。

| 裁决 | 内容 | 落点 |
|---|---|---|
| seed 自检 | **维持只报不阻断**（不 fail-closed；失效判据 = 出现 silent 装载失败导致用户可见整源降级时重开） | design 09 / STATUS 范围决策 |
| 初始窗口高度 | **按官方形态对齐**：Swift 内容区取官方视口 **1280×772**，放弃 786 折中（转实机核验） | deviations S-49 |
| open-in | **官方 `ui-open-in-app` 行在复合页生效 + 我们保持严格超集**（`chamber-covered.ts` 移除该行、座冲突复验、实机复验） | design 16/20 / §20.2 bump 清单 |
| 设置面 | **方案 A**：壳保留 chamber（不改走官方壳，P4 不做）、字段渲染契约用上游 `settings-form`/`configForms`、内容用各来源原生设置 + chamber 自持 | design 15 §6.5 / §22.2.4 P4 |

## 1.8 2026-09-24 重测：提取面、冲突面与待重新决策清单

> 测量口径：MB = `82df4c47`（merge-base）；ours = tag `backup/v016-alpha1-pre-reset`（`e0093418`）；theirs = `267272b0`；三方 `git merge-file`（默认与 `--diff3` 两口径）。**本节数字取代 §1.5/§5–§12 中一切旧 main 口径统计。**

### 1.8.1 规模与分类（实测）

| 口径 | 值 |
|---|---|
| 分支侧（MB→tag） | 246 文件 / +20111 / −25450（A36 / M187 / D23） |
| main 侧（MB→`267272b0`） | 1511 行 / 1529 路径 / +152601 / −114614 |
| 两点（tag↔main） | 1559 文件 / +168490 / −125164 |
| 双方触碰 | **195** = 169（严格 M∩M）+ 4（分支 M 且 main 删）+ 22（分支删且 main 改） |
| 分支新增且仅分支有 | **36**（可直接取件；含 `CrashDiagnostics.swift`/`startup-error.ts`/`safe-mode.ts`/python 载荷/席位测试等） |
| 分支 M 且 main 未碰 | **14**（三方必 clean，可整文件直取） |
| main 删除 ∩ 分支触碰 | 5（4 个分支 M 的测试 + `fixture.ts` 双方都删） |
| 三方合并（182 个 branch-M） | **61 clean / 121 冲突 / 401 块（默认）/ 486 块（`--diff3`）** |
| 对旧 main `745274e7` 同口径 | 76 clean / 106 冲突 / 331 块（391 `--diff3`） |
| 36 提交的影响 | clean→conflict **15**、conflict→clean 0；+70 块（默认）/+95（`--diff3`）；主因 `28e2eba8` 注释压缩 |
| Top 热点（默认/`--diff3`） | `PluginDialog.tsx` 30/47、`AppDelegate.swift` 28/46、`plugin-sync.ts` 18/31、`main.ts` 16/19、`BridgeClientEdgeIntegrationTests.swift` 15/16、`shell-core.ts` 8/15、`gateway/index.ts` 9/11、`gateway/routes.ts` 8/11、`updater.ts` 7/8、`renderer/shell.ts` 6/6、`registry.json` 9/6、`STATUS.md` 8/10、`bridge-shim.js` 8/8 |

> 旧计划里的「187 双方都改 / 62 干净 / 100 冲突 / 374 块」：**187 实为分支侧 M 计数**（246−36A−23D，非交集）；62/100/374 在旧基线下按任何口径都不可复现（同口径为 76/106/391）。8 个旧热点数可 8/8 复现。旧聚合数字一律作废。

### 1.8.2 主题判定表（新 main 对旧分支工作）

| 主题 | 分支侧规模 | 新 main 对应面 | 判定 |
|---|---|---|---|
| dsh 0.1.6 pin/runtime | 193 文件 +11698/−27699 | 仍 `fb2c4b9e`；目标 rc.2 | **放弃**（只作学习项） |
| 写面退役（C 分层） | ~29 文件 +618/−14164（另 settings-connections 511/−3872） | 写面仍在且被重构改过 | 仅分支有 → **保留**（按新 main 重枚举删除清单） |
| 会话流健康臂 | 5 文件 +171/−41（merge 残留 + FIXME） | `dsh-stream-state` + `Session.resync()` 臂 + G43 | **main 已覆盖**（只留 pin-aware 测试形态） |
| fork 补丁面（connection/web/api-gateway） | 16 / 4 / 4 文件 | 三 fork 已注册（G43） | **main 权威**；在 rc.2 上重新 replay |
| Swift 崩溃诊断 | 565 行 + 28 用例 | 0 命中 | 仅分支有 → **保留** |
| Swift 启动恢复 | AppDelegate +670、`startup-error.ts` | `fatalAlertShown`/`SidecarStartupFailure` | 双方各有 → **合并**（46 块） |
| 窗口形态/几何 | MainWindowController +58、`titleBarOverlay` | 0 命中（两边都仍 786） | 仅分支有 → **保留**（772 待落） |
| 更新链 P0-1 | updater 8 块 + 4 新文件 | `restartWatchdog` + availability | 双方各有 → **合并** |
| 本地化/主题/席位 | `shell-locale.ts`、`native-theme-set`、两席位 | Swift `NativeText`/`ShellPageFacts` 已有；席位 0 | Electron 腿保留 / Swift 腿放弃；席位按 0.1.7 重建 |
| macOS x64 | revert 提交 | 已 arm64-only | **main 已覆盖 → 放弃** |
| python 载荷 | 脚本+锁+测试 | 无；`release.yml` 重写 +781/−263 | 仅分支有 → **在新 release.yml 重落** |
| 设置桥 | 1 文件 +7/−1 | 63 文件完整桥 + design 05 权威 | **main 已覆盖** |
| open-in | 裁决文档（代码未落） | seed/open-in 重写；官方行仍 covered | 双方各有 → **需落代码** |
| 归档 design24 | 1 文件 +13/−13（unarchive 发现） | design 24 重写 + 包重写 | main 覆盖结构；分支发现待 rc.2 复核 |
| registry/roster | 6 文件 +261/−57 | 6 条目 + C16；`registry.mjs` 仍 named⇒seed | 双方各有 → **合并** |
| 通知/goal/桥健康 | 0 | 6+ 提交、design 19 +739 | **main 已覆盖** |
| gui-acceptance W-4a | 3 文件 +59/−2 | 仍 `viewPrefsDelta` | 仅分支有 → **保留**（小改） |
| 文档 R1–R5 | 32 文件 +3042/−336 | 45 文件 +3322/−1209（16 份 design 双改） | 双方各有 → **逐条重判**（3-way docs 18 冲突 / 64 块） |

### 1.8.3 待重新决策清单（需要你裁决）

| # | 事项 | 选项 | 建议 |
|---|---|---|---|
| D1 | 写面退役在新 main 上的落法 | (a) 升级完成后独立提交、按新 main 重新枚举删除清单 + 计数锁复核；(b) 与升级同批 | (a)，与 §2.2-A 既有裁决一致 |
| D2 | open-in「官方行生效 + 严格超集」实现时机 | (a) 随本次升级落；(b) 独立 PR 后置 | (a)，否则裁决悬空（依赖新 pin 的 `OpenPathAction`） |
| D3 | 窗口高度 1280×772 落地 | (a) 升级中落 + 实机核验；(b) 等实机后定（暂 786） | (a) |
| D4 | 会话流健康臂权威 | (a) 以 main 的 `Session.resync()` 臂为唯一实现，分支 probe 放弃，pin-aware 测试思路并入 bump 重 derive；(b) 保留分支 fail-closed 作第二保险 | (a)，两套臂会打架 |
| D5 | registry layout 条目 | (a) 收敛到 main 的 `seed.dsh-chamber-client-ui-layout`，只新增 sidebar fork；(b) 保留分支 fork 条目（需撤 main seed） | (a) |
| D6 | C11 opt-in 白名单 | (a) 机制取分支版、最终名单 bump 后按 rc.2 锁重新 derive；(b) 其它 | (a) |
| D7 | 旧分支 0.1.6 pin/runtime 与 fork 补丁面 | (a) 全放弃、只作学习参考，fork 在 rc.2 上重新 replay；(b) 部分保留 | (a) |
| D8 | 是否现在把 §1.8.2 判定表转成新的取件表（重写 §7/§12） | (a) 现在重写；(b) 开工时再重写 | (a) |

### 1.8.4 无需裁决的机械修复（可直接执行）

1. **刷新派生运行时树**（先 `pnpm install` 再 bundle）：当前 gitignored 的 `packages/desktop/vendor/dsh/**` 仍是旧分支的 0.1.6-alpha.2，导致 `verify-upstream-touchpoints` **C11 硬失败**（C10 警告）；直接跑 `bundle:dsh --force` 会因 `@dsh-chamber/dsh-runtime/dist` 缺失而 `ERR_MODULE_NOT_FOUND`——重置后须先 `pnpm install`（必要时构建 `@dsh-chamber/dsh-runtime`）再 bundle，刷新后回 0.1.5-rc.2。
2. 清理未跟踪 `.audit/` 与旧构建产物，使 `git status` 只剩 submodule dirty。
3. `docs/progress/deviations.md` 头部 open 枚举漏 **G43**（实际 open 11 条）——补一条。
4. `AGENTS.md` 仍写 gates C1–C15（现为 C1–C16）——补 C16。
5. `todo/refactor-plan.md` 的 §4/§6 数字滞后（类型环 allowance 实为 0、full 实为 61、God 实为 25,392）——属 main 侧文档，是否顺手修由你定。
6. 计划自身：full 59→**61**、新门禁归属（只有 import-cycles/file-budgets 是 9-24 新增）、§7/§12 旧冲突数字替换。

## 2. 决策现状：分支既有裁决（沿用）+ 2026-12 四项新增裁决（无待决策项）

**先说结论**：分支已有裁决一律沿袭，本指南不重开；2026-12 的四项新裁决（seed 自检维持只报不阻断、窗口高度按官方、open-in 官方行生效 + 严格超集、设置面方案 A）已写入 `docs/progress/STATUS.md` 范围决策（见 `docs/progress/STATUS.md` 范围决策；§22.4.4 记录的是另外四条）——**当前无待你裁决项**。下面 §2.1/§2.2 是分支内既有裁决的索引：

### 2.1 已生效裁决（沿用，不再询问）

| 裁决 | 分支记录（出处） | 在 0.1.5→0.1.7 上的执行含义 |
|---|---|---|
| **C 分层：chamber 无用户插件写面**（2026-09 用户裁决） | design 13 开篇「2026-09 C 分层（用户裁决）：写面的半边已退役」；STATUS「chamber 无用户插件写面（C 分层范围决策，2026-09）」 | **在 main 上重放删除**（写面源文件 + 10 条通道 + 渲染端写面模型），保留全部读面 + `plugin-capability.ts` 能力门；过程选择见 2.2-A |
| **Swift 原生壳 = 权威与上游**（2026-09 裁决） | `docs/progress/deviations.md` §0 权威方向 | 推论：复用 main 更新的 `NativeText`（121 键 + 两 lproj）/`ShellPageFacts`/`RendererRecovery`；我们的 `ShellLocale` 字典与 `native-theme-set` Swift 腿是同一席位的较早形态 → 不搬；Electron 腿照搬 |
| **macOS x64 暂时移除**（2026-12 用户决定） | design 25 §11 决策 B；design 11 §6.1 | 升级期间维持 arm64-only；三个重新引入前置满足前不重提 |
| **P0/P1 清单**（更新链看门狗 / 原生崩溃诊断 / 可用性门 / 运行期恢复框 / 实机 runbook） | 台账 §8.a；你当时回复「按你的执行 P0/P1」 | 全部按 §7 移植，不是新决策 |
| **会话流健康臂保持 fail-closed 降级**（2026-12 处理，含重 derive 条件） | STATUS ⑮ | 默认沿用现状（不抛错、不导航，落到「重新加载」提示臂） |

### 2.2 已按推荐定案（2026-12，都是过程/时机，不是方向）

| # | 事项 | 定案 |
|---|---|---|
| **A** | 已裁决的**写面退役**在本次升级里怎么落 | **升级完成后独立提交**（升级面保持干净可回滚；删除不与 main 文本冲突、会静默生效，独立提交便于逐条核对通道/渲染端） |
| **B** | **pin 时机** | **现在就钉 `0.1.7-rc.2`**（源码线 + 运行时线 `next` 通道）：与你此前「跟最新 tag 走」的节奏一致；npm `next` 已指向 rc.2、`latest` 是 0.1.5-rc.3、`alpha` 停在 0.1.7-alpha.2（见 §20） |
| **C** | 会话流健康臂 | **维持降级** + `FIXME(upstream-pin)`：上游 0.1.7 仍无会话导航/重开面（STATUS ⑮ 已写判据） |

**不需要你回复、按既有裁决执行**：0.1.7 新增的上游插件面按 C 分层原则逐一归类（读面保留 / 写面不引入）；只有出现「新的用户可见写面」或「与既有裁决冲突的新契约」才回来问。其余执行细节见 §7.2（P1）与 §7.3（P2）。
## 3. 阶段 0 · 出发前（只读照面）

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
# 1) 目标 tag 与旧 pin
git -C vendor/harness-checkout fetch origin --tags
OLD=fb2c4b9e; NEW=$(git -C vendor/harness-checkout rev-parse dsh-v0.1.7-rc.2)
# 2) 三条只读基线必须全绿（升级后要复绿）
node scripts/upstream/verify-registry.mjs
node scripts/upstream/check-anchors.mjs --report
node scripts/upstream/verify-upstream-touchpoints.mjs --no-artifact-rebuild
# 3) 影子 ROOT 跑真 0.1.5→0.1.7 preflight（见 §1 纪律 2）
```

- 工作区与构建产物先清干净（`git status` 只允许既有的 submodule dirty）。
- 记住本指南 §5 的 C 门禁红项，升级后逐条重锚而不是关掉判据。

## 4. 阶段 1 · 双线 pin 升级

### 4.1 源码线（构建期 vendor 树）

1. `node scripts/upstream/update-vendor.mjs dsh-v0.1.7-rc.2`（原子：fetch + 校验 → 切 submodule → 写 `harness.commit` → 差量建链 → 重生成锁文件 → frozen 验证）。
2. **gitlink 陷阱**（必踩）：工具只切 submodule HEAD 与 pin、不写 index gitlink，而 `ensure-harness-vendor` 用 index gitlink 对拍 → 差量建链会以 `gitlink=旧 != pin=新` 硬失败。处置：`git add vendor/harness-checkout` 后重跑同一条命令（幂等）；提交时 gitlink 与 pin 同批。
3. `node scripts/dev/ensure-harness-vendor.mjs --check`。
4. 新增 50 个 vendor 包要**手工补 importer 记录**（零依赖成员 `key: {}`），pnpm 11 裁剪后用 `restore-lockfile-vendor-records.mjs` 补回。

### 4.2 运行时线（打包进桌面的 `@deepseek-ai/dsh`）

1. `packages/desktop/scripts/bundle-dsh.mjs` 的钉版 + `pnpm --filter @dsh-chamber/desktop run bundle:dsh -- --force --refresh-lockfile`（版本变化必须 `--refresh-lockfile`）。
2. 冒烟：`node packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version` → `0.1.7-rc.2`。
3. **六锚 + 3 fork 同步**（C10 硬断言，缺一处即红）：`.github/workflows/release.yml` 的 `DSH_CHAMBER_DSH_VERSION`、`scripts/install-gateway.sh` 默认锚、`packages/gateway/package.json` 的 `dshAnchorVersion`、`packages/desktop/scripts/bundle-dsh.mjs` 兜底、`scripts/release/release-preflight.mjs` 的 `FORK_VERSION`、`harness.commit`（工具写）；`packages/dsh-client-connection`/`dsh-client-web`/`dsh-api-gateway` 三个 `package.json`。
4. 注意 main 的 release.yml 还带着 **delta updates** 步骤：rebase 时只改版本行，不要回退 main 的步骤。

## 5. 阶段 2 · 硬破坏与必红清单（编译/启动级）

### 5.1 0.1.7 独有、0.1.6 没覆盖的九项（H1–H9；rc.2 追加 H10，见 §17-H10 / §12.11）

| # | 面 | 0.1.5 现状（main） | 0.1.7 目标 | 动作 |
|---|---|---|---|---|
| H1 | 设置服务改名 | `ctx.settingsScope`（`settings-scope.ts` 的 `super(ctx,'settingsScope')` + `bind({namespace})`）；`packages/settings/settings-file` 存在，`settings.yaml` 是活文档 | `ctx.configForms`（`config-form.ts` + `get<T>(entryId)`）；`settings-file` 删除；`settings.yaml` 首次启动改名为 `settings.yaml.imported` 后一次性导入 Profile | 改 `packages/renderer/src/locale-ownership.ts`、`chamber-entry.ts`（首屏 inject 审计）、`dsh-chamber-client-ui-settings-bridge/src/vendor-modules.d.ts`、`required-extra-rows.test.ts`（6 处）、任何 `ctx.settingsScope` 读取；重 derive `packages/dsh-runtime/src/runtime-probes.ts` 与 `packages/control-plane/src/index.ts` 的 settings.yaml 播种/激活探针 |
| H2 | 会话头座席退役 | 0.1.5 **没有** `conversation.session.header.leading`（该座是 0.1.6 新增；本分支 T2 才引入适配） | `shell.leading`（ui-layout 声明，AppFrame 仅 darwin 折叠时挂载）+ `sidebar.toggle.badge` 仍在 | 侧栏 fork 把 `ctx.slots.inject('conversation.session.header.leading', …)` 改为注册 `shell.leading`；`vendor-modules.d.ts` 同步 ；**rc.2**：inject/hooks 增 `shortcuts` + `LayoutController(..., panelInfo)`（见 §20.2）|
| H3 | 图标改名 | 0.1.5 是 `Icon*Outline16`（47 个，含 `IconPanelLeftOutline16`），`*OutlineRegular` 为 0 | `*Outline16` 为 0，`*OutlineRegular` **79** 个（rc.1 新增 `IconUsersOutlineRegular/Medium`，rc.2 新增 `IconArchiveOffOutlineRegular`） | **28 个符号要改**：21 个 `*Outline16`（chamber 源 16 个文件，含 **5 个** `vendor-modules.d.ts` 与已提交产物）+ **7 个非 16 尺寸族**（`IconChevronRightOutline14`/`IconChevronDownOutline14`/`IconChecklistOutline14`/`IconQuestionOutline14`/`IconSettingsOutline14`/`IconArchiveOutline20`/`IconStopFill16`，alpha.2 已全部移除、各有 `*Regular` 对应，见 §15.2）；**`typecheck` 不兜底**——名字写死在 `vendor-modules.d.ts` 里声明仍在，运行期会变 undefined 组件 |
| H4 | remote 装配 15→**23**（rc.2） | `packages/api/remotes/src/client/index.ts` 169 行 / 15 namespace（main@0.1.5） | **195 行 / 23**（rc.2；alpha.2 是 192/22、alpha.1 是 21，本分支 0.1.6 中间态 19）：`dsh-agent-presets`→`dsh-agent-preset-registry`，新增 account/job/terminal/office-to-pdf/plugin-manager/permission-presets/**plugin-registry-probe**（`ui-plugin-manager/remote`，alpha.2 新增）；**import 序与 mount 序不同**（表见 §15.1） | 重 derive `packages/renderer/scripts/typert-remote-contract.mjs` 的两份有序表（不要只改数字），复核 C4 的 covered/roster 与 `chamber-covered.ts`（新 main 已重写 `host-graph.ts`/`required-extra-rows.ts`，取 H9 时要保住 `registry.json` 的 `vendorSourceConsumers`（C16）登记） |
| H5 | api-gateway 客户端半双向流 | `stream-client.ts` 310 行单向 `open()`；`remoteStreamUrl()` 模块函数（`INTERNAL_BASE` 回落）；protocol 自带 `isRemoteJsonValue` | 480 行（rc.1；其中 `invokeStream`/`RemoteStreamHandle` 实际在 `client/index.ts` 464/543 行）：`invokeStream` 同步返回 `RemoteStreamHandle`（`send/end/dispose/asyncIterator`）+ `ClientUplinkQueue`；`invoke` 走 `descriptor.result.decode`；protocol 新增 item/end 帧并从 typert-protocol 取 `isRemoteJsonValue`；`remote-events` 走 `TypertOwnedValue` | chamber 补丁面（`RemoteStreamMuxClient(basePath)`、实例 `remoteStreamUrl()`、`recoveryOverridesForTransport`、`stream-carrier-fact`）重新落到新文件；`stream-protocol.ts`/`remote-error-codes.ts`（pure）直接照抄 |
| H6 | connection `rpc.ts` 相对路由 + 二进制 | 120 行：`INTERNAL_BASE='http://dsh.internal'` + `resolveBase()`；`RpcStreamOpen(endpoint,payload,signal)`；`index.ts` 自读 `?fixture`（`fixture.ts` 4037 行） | 183 行：`INTERNAL_BASE`/`resolveBase()` 删除，route 为 document-relative `string\|URL` 交给 `RpcFetch`；新增 multipart 二进制解析（`codec:'bytes'`）；`RpcStreamOpen(...,uplink?)`；`fixture.ts` **删除**；`rpc?`/`streamBaseUrl?` 进 `ClientTransportHooks` | 采纳新 rpc.ts；**basePath 前缀必须自己补**（页面在控制面根，document-relative `api/…` 会丢 `/api/i/<id>`）；`carrier-assembly` 的 `streamBaseUrl` 钩子复用 |
| **H7** | **`settings.launcher` 新座** | 0.1.5 无该座 | 0.1.7 新槽（`ui-settings` 声明、`SettingsRoot.tsx` 唯一渲染点、owner props `{wide, openSettings, openOnboarding}`）；新包 `ui-settings-account` 的账号菜单/Sign out **只在这里** | chamber 的设置壳 shadow 了官方 `SettingsRoot` → **必须在壳的 trigger 行渲染来源自己的 `settings.launcher`**（`openSettings` 接壳 open 状态、`openOnboarding` 接壳自己的协调器，无注册者回落自绘 trigger）；详见 §17-A ；**rc.2**：owner props 增 `settingsOpen`/可选 `settingsShortcut`|
| **H8** | **plugin-inventory 结构镜像** | 镜像把 `trust` 当必填（0.1.6 形状） | 0.1.7 删除 `AgentPresetPluginGroup.trust` 并新增 `meta` | 镜像**只消费 `entries`**（`agentPresets` 无渲染消费者 → 整段不解析或失败即忽略），不得因缺 `trust` 整单抛 `invalid preset group`；**不补 `meta`**；详见 §17-A |
| **H9** | **client-module graph 行 URL 改 document-relative** | 0.1.5/0.1.6 的 graph 行 url 以 `/` 开头 | 0.1.7 的 `url` 是**文档相对**（依据 = `packages/client/modules/src/index.ts` 的 document-relative 注释与 `comboReference(...).slice(1)`，非 manifest 原文；`comboReference=comboUrl().slice(1)`） | `packages/renderer/src/host-graph.ts` 只接受 `startsWith('/')`，其余**静默丢弃**且诊断仍报 ok → **不修则 bump 后每实例丢全套 profile 客户端插件（官方 Plugins 页、右栏 tab、terminal、用户插件），能力门仍答 available**；修法：接受两种形态并归一为 `basePath + '/' + url`（`//`/scheme/`../` 仍拒）+ 补 0.1.7 形状回归 | 新 fixture 单测绿 + 实机插件齐全 |

### 5.2 0.1.5→0.1.7 中“本分支 0.1.6 适配已覆盖、但要在新 pin 下复核”的项

- `installConnection(ctx, options)` 拆分与薄 `apply`：0.1.6→0.1.7 对 `index.ts` 零 diff，采纳 0.1.6 已做形状即可。
- `boot.ts` 重写与「`boot-client.ts`/`mount.ts`/`apply-injections.ts` 不镜像」：`mount.ts`/`apply-injections.ts` 与 `boot.ts` 在 0.1.6→0.1.7 零 diff；`boot-client.ts` 只有 +10/−4（`assertEntriesActive` 接 `modules.importError` 文案）——该文件我们本就 dropped，决策继续成立。
- session health 恢复臂：0.1.5 的 `ISessions.open(id)`/`followCurrent` 在 0.1.7 已不存在（0.1.6 起就没了）→ 保留 fail-closed 臂 + `FIXME(upstream-pin)`，只把 pin 字面量/注释改成 0.1.7；契约测试「断言杠杆不存在」继续成立。
- logger exporter Symbol-key 兜底：0.1.5 的 `logger.ts` disposer 本身有 bug（删的是当前计数器），0.1.7 修成 `delete(id)`；`host-log-bridge` 的兜底注册仍正确，只有依据注释要更新。
- archive-cleanup 的 jsonl 文件名/迁移暂存/租约语法：0.1.5→0.1.7 **逐字未变**，但 V4 格式新增了 `assertV4RowAdmission` 等 → 重锚注释与拒绝语义映射。
- 更新链看门狗 / 崩溃诊断 / 安全模式 / C5 载荷：与上游契约弱耦合，原样移植（C5 的 provenance 路径见下）。

### 5.3 会因升级变红的文件（字面量/夹具/契约，不是逻辑坏）

| 门禁 | 现象 | 处置 |
|---|---|---|
| C10 版本锚 | 六锚 + 3 fork 任一旧值即红 | §4.2 同步 |
| C11 运行时族集合 | rc.1：opt-in 白名单 **+5 / −1**；**rc.2：+6 / −1（白名单 10，+`dsh-experimental-auto-review`、−`agent-team-web-profile`）** | 改 `packages/control-plane/src/protected-plugins.ts` 的 `RUNTIME_FAMILY_OPT_IN_ALLOWED` 与注释 + `protected-plugins.test.ts` 夹具 |
| C4 remote 契约 | 19 → **23**（rc.2） | 重 derive `typert-remote-contract.mjs` 双序 + C4 断言 |
| C9 vendor 补丁锚 | 10 文件 / **28 锚中 13 命中、15 断（rc.2；新增断锚 `ui-conversation/assembly.ts` e2，被 `openTurn.set` 打断）**（登记文件 `packages/renderer/scripts/vendor-patches.mjs`）| 断锚：`ui-chat/AssistantMarkdown.tsx`(e0/1/3/4)、`client/file-upload/runtime.ts`(e2/4/5/6)、`session-query/session-log-export/controller.ts`(e1)、`ui-deliverables/present-open.ts`(e1/2)、`ui-chat/AssistantNodeView.tsx`(e0)、`ui-chat/GenericCommandCard.module.css`(e0/1) → 按新上游源码重新落锚 |
| C3/C5 | 新增/删除包与 fork 版本面 | 为 `connection/src/operator-peer.ts`、web 三新文件（`apply-injections`/`boot-client`/`mount`）补分类；3 个 fork `package.json` 版本行 |
| C15 | **仍绿**（已核） | 0.1.7 的 `HoverCard` 关闭臂与 `POINTER_GRACE_MS=200`/`openDelayMs=500` 仍与 chamber 的 `shared/hover-intent.ts` 逐值锁步 |
| 其它 | `python 锁 provenance`、`primary-runtime` 路径、`settings.yaml` 探针、`session V4` 注释 | 见 §7 移植表 |

## 6. 阶段 3 · fork 面 rebase（0.1.5→0.1.7 实测）

影子 preflight（`harness.commit=fb2c4b9e` → `dsh-v0.1.7-alpha.1`，`--offline`；alpha.2 的增量复核见 §16）结果：**pure 6 / 需人工重放 23 / dropped 31；chamber 深引 vendor 变化 170；新增上游包 50、移除 10、新增 client 行 11**。

> 口径警告：影子跑的 base 是 0.1.5、而 chamber 的 fork 副本是 0.1.6 版，所以 "pure" 被低估（例如 `base.css` 会被误标 replay）；**真实工作量取「replay 23 清单 ∩ registry 的 patched 面」**。

### 6.1 pure 6（可直接照抄 0.1.7 版）

`api/gateway/src/remote-error-codes.ts`、`api/gateway/src/stream-protocol.ts`、`connection/src/browser-auth.ts`、`connection/src/http-bridge.ts`、`connection/src/rpc-host.ts`、`connection/src/rpc.ts`。

### 6.2 需人工重放 23

`api/gateway/{package.json, src/client/index.ts, src/client/remote-events.ts, src/client/stream-client.ts}`、`connection/{README*, package.json, src/client/api.ts, src/client/index.ts, src/client/rpc.ts, src/index.ts, tsconfig.client.json, tsconfig.host.json}`、`web/{README*, package.json, src/base.css, src/boot-page.module.css, src/boot.ts, src/index.ts, tsconfig.json}`。

其中与 chamber 补丁直接重叠的两处（**必须先人工合**）：

- `connection/src/client/rpc.ts`：上游删掉 `INTERNAL_BASE`/`resolveBase()` 改成 document-relative、新增 multipart 二进制、`RpcStreamOpen` 加 `uplink` → chamber 的 basePath 前缀改由 `carrier-assembly`/`RpcFetch` 注入。
- `api/gateway/src/client/{index.ts,stream-client.ts}`：上游改双向流（`RemoteStreamHandle`/`ClientUplinkQueue`）→ chamber 的 `RemoteStreamMuxClient(basePath)`、实例 `remoteStreamUrl()`、`stream-carrier-fact` 重新落位。

### 6.3 dropped 31 里需要决策的新文件

`connection/src/operator-peer.ts`、`connection/tests/binary-rpc.host.spec.ts`、`web/src/{apply-injections,boot-client,mount}.ts`、`web/tests/{boot-client,mount}.client.spec.ts`；删除项 `connection/src/client/fixture.ts` + 2 个 fixture 测试（0.1.6 已决定不镜像 `?fixture`）。

### 6.4 深引 seam 与 registry

- chamber 深引的 170 个变化文件按包聚合（ui-primitives / ui-sidebar / ui-layout / ui-renderer 为主）。关键锚点里 **未变**：`Button.tsx`、`ui-renderer/src/client/bindings.tsx`、`ui-layout/src/client/{columns.ts,service.ts,theme-presenter.ts,DocumentTitle.tsx}`、`pointer-grace.ts`；**变了**：`AppFrame.tsx`、`AppFrame.module.css`、`ui-layout/src/client/index.ts`（新座）、`HeaderLeadingControls.tsx`、`ui-renderer/src/client/registry.ts`、`HoverCard.tsx`。
- registry 需要：为新增/删除包补分类、把 `ui-sidebar` fork 条目移植进来（main 已有 **5** 条：3 fork + `seed.dsh-chamber-seed-open-in` + `seed.dsh-chamber-client-ui-layout`；layout 收敛到该 seed，不新增 fork 条目）、生成视图重跑；`registry-views.mjs --write` 后 `verify:registry`。

## 7. 阶段 4 · 把旧分支快照（`backup/v016-alpha1-pre-reset`，0.1.6 时代）的修改与决策移植进来

下表每一项先看 **main 现状**，再决定「复用 main / 移植旧分支快照 / 合并 / 放弃」。冲突数据以 §1.8.1 的新基线实测为准（MB `82df4c47`；ours = 旧分支 tag；theirs = `267272b0`）：**双方触碰 195 / 严格 M∩M 169；182 个可三方合并里 61 干净、121 冲突（默认 401 块、`--diff3` 486 块）**；最重的是 `AppDelegate.swift`(46)、`PluginDialog.tsx`(47)、`plugin-sync.ts`(31)、`main.ts`(19)、`shell-core.ts`(15)、`gateway/src/routes.ts`(11)、`gateway/src/index.ts`(11)、`registry.test.mjs`(8)。（原 §12.4/§12.5 的清单已随取件表移除）。

**关键好消息**：`packages/desktop/main.ts`、`preload.cts`、`updater.ts`、`update-headless.ts`、`AppUpdater.swift`、`FrameCodec.swift`、`ShellLog.swift` 的三方合并**全部 CLEAN**（口径 = 相对**旧 main `695f67c8`** 的三方预演；新 main `267272b0` 下这些文件多数已进入冲突面——`main.ts` 16/19、`updater.ts` 7/8、`shell-core.ts` 8/15 等，见 §1.8.1）。

### 7.1 P0 · 零冲突纯增益（先做）

| 项 | main 现状 | 本分支版本 | 动作 |
|---|---|---|---|
| **更新链看门狗** | `updater.ts` 只有 restart stall watchdog（F4）与 6h 注释；无 check/download idle 看门狗、无 attention/journal/schedule；`update-headless.ts` 只比 base 多注释；**新 main 已改这两个文件（`updater.ts` 3 冲突块、`update-headless.ts` 4 冲突块）** | `update-schedule.ts`（600s±20% jitter / 退避封顶 1h / focus-resume nudge）、`update-journal.ts`（opt-in JSONL）、`updater.ts` 的 check-idle + download-stall 看门狗 + `failureKind` + 前台注意力（E：`app.dock.bounce('critical')` + 宿主 `flashUpdateAttentionWindow` → win32 `flashFrame`；S：`NSApp.requestUserAttention(.criticalRequest)`）、`update-headless.ts` 同源节奏；5 个新用例文件 | 直接移植；`scripts/test.mjs` 有 1 hunk 摩擦（main 加了 pnpm-launcher 用例）→ 合并清单；**不要动 main 的 restart watchdog** |
| **原生崩溃诊断** | main 只有 `RendererRecovery.swift`（renderer 进程重载 + 归因 + deeplink 缓冲），**无** native 未捕获异常/信号处理 | `CrashDiagnostics.swift`（565 行：异常 + 6 信号 → `shell-crash.log` + marker，async-signal-safe，零展示）+ 28 例 + `ShellLog.fileURL(userDataDir:fileName:)` 重载 | 直接移植；两者**互补不重复**（一个管 WebContent 崩溃→reload，一个管壳进程信号→落盘），不要互相取代；`ShellLog.swift` 保留 main 主体 + 加重载 |

### 7.2 P1 · 小冲突（按序做）

| 项 | main 现状 | 动作 |
|---|---|---|
| **Electron 壳文案本地化** | main **完全没有**（`main.ts` 仍硬编码中文：`882`/`778`/`1295`/`1458` 等） | 移植 `packages/desktop/shell-locale.ts` + 用例 + 全部调用点；Swift 侧不引入第二套字典（recovery 键并入 `NativeText`） |
| **registry：sidebar 条目 + layout 口径收敛** | 新 main 有 **5 条**：3 fork + `seed.dsh-chamber-seed-open-in` + **`seed.dsh-chamber-client-ui-layout`**（已进 `chamberNamedForks` 与 `touchpoints.fork-mirror.layout`）；判据 C1–**C16**，新增 `vendorSourceConsumers` 块 | 新登记 `fork.dsh-chamber-client-ui-sidebar`（含 droppedNotes）+ `chamberNamedForks`；**layout 不再新增 `fork.` 条目**，收敛到 main 的 `seed.` 条目；`registry.json` **6 冲突块** + `registry.test.mjs` **8** 手工合（保留 main 的 api-gateway/stream 文本与 C16/生成块）→ `registry-views.mjs --write` |
| **安全模式** | `SAFE_MODE`/`safe-mode` 全 0 命中 | 移植 `control-plane/src/safe-mode.ts` + index/static-serving 注入 `__DSH_CHAMBER_SAFE_MODE__` + `renderer/src/safe-mode.ts` + 3 个锁步用例（三处字面量必须同源） |
| **parity 净新增** | 无 `electronFuses`、无 `contentMinSize`/`titlebarAppearsTransparent`、只有 `onReady(port,shellVersion)` 无比对、无 `titleBarOverlay`、无 `failureKind`、无两 seat、无 `native-theme-set` | 移植：窗口形态 + 880×600、`electronFuses.runAsNode`、`shellVersionMismatchMessage`、win32 caption、`UpstreamUpdateFailureKind`/`failureKind`、`sidebar.toggle.badge` 与（0.1.7 形状的）`shell.leading`、**Electron 腿的** `dsh-chamber:native-theme-set`；窗口形态在 `MainWindowController` 只有 1 hunk 冲突（main 的 theme 函数 vs 分支窗口构造） |
| **python 载荷（C5）** | `primary-runtime` 全 0 命中；0.1.5 **根本没有**上游锁（该锁是 0.1.6 才有） | 移植 `prepare-python-payload.mjs`(+test)、`primary-runtime-lock.json`、`resources/primary-runtime/README.md`、`local-host-self-check.ts`(+test)、package.json `extraResources`/scripts、`NSExceptionAllowsInsecureHTTPLoads` 改名、`dmg.sign`；**provenance 指向 `vendor/harness-checkout/scripts/primary-runtime/lock.json`（0.1.7 新位置）并更新 `upstreamCommit`**；release.yml 1 hunk（保留 main 的 delta updates） |
| **插件能力门（读面）** | main 无 `plugin-capability.ts`；这是 **chamber 自研的读面升级**（三态能力探针 + 渲染端降级），与写面退役是两件事 | **必移植**（既有裁决的保留面）：能力探针 + 渲染端使用点 + 用例 |
| **registry 不变量放宽** | main 的 `registry.mjs` 要求 chamberNamedForks ⇒ type=seed（对单条 seed 先例过拟合） | 移植本分支的放宽（named ⇒ type ∈ {fork,seed}）+ **负例测试**；否则新登记的两条 fork 过不了 schema |
| **会话流健康臂（既有裁决：维持降级）** | main@0.1.5 的杠杆还在（`ISessions.open(id)`/`followCurrent`），但 0.1.7 已删除 → 直接跳跃后必然走降级 | 沿用既有裁决：保留 fail-closed 臂 + `FIXME(upstream-pin)`，只把 pin 字面量/注释按 0.1.7 重锚；**是否现在重 derive 见 §2.2-C（默认不）** |
| **更新可用性门** | main 已有等价语义（`refused(reason:)`/`availabilityError`/`unavailableReason`/`isAvailable`） | **可选**：仅当想要纯函数可测时移植 `availabilityRefusal`；不动 main 语义也行 |

### 7.3 P2 · 大冲突（先定文案源）

| 项 | 冲突面 | 策略 |
|---|---|---|
| **启动失败恢复**（`startup-error.ts` + main.ts 三选/两选 + Swift 恢复框） | `AppDelegate.swift` **46 冲突块集中在此段**（main 侧 143 hunks）；`main.ts` **16 冲突块** | (1) 以 main 的 `NativeText` 为文案源（recovery 键进 main 表 + 两个 lproj），把本分支的 `RecoveryChoices`（一般致命三选 / 锁冲突两选）、单次呈现门、`fatalRuntime`、**先停 supervisor/释放 flock 再呈现**叠上去；(2) main 已有的 `fatalAlertShown` 与本分支 `RecoveryPresentationGate` **合成一个门**（语义重叠，绝不留两套）；(3) main.ts 的 5 个 `fatalMainError` 调用点统一走 `planStartupRecovery`；(4) 复核 `performRecoveryRelaunch` 的清理判据 |
| **Swift recovery 文案键** | `NativeText.swift` + 两个 lproj | 只把「退出 / 重启 / 安全模式重启」等新增键并入 main 表；`ShellLocale.swift` 整体不搬 |
| **窗口形态的 vibrancy/主题** | `MainWindowController.swift`（main 的 `applyAppearance`/`themedBackgroundColor`） | 手工合 1 hunk；**不要**引入 `native-theme-set` 的 Swift 腿 |

### 7.4 明确不要再从本分支搬的东西

1. `ShellLocale.swift` + `ShellLocaleTests.swift`（main 的 `NativeText` 121 键 + lproj + 语言跟随已覆盖）；2. `native-theme-set` 的 Swift 腿（main 的 `ShellPageFacts`/`applyAppearance` 已在做）；3. `RendererRecovery.swift` 不要被 `CrashDiagnostics` 顶掉；4. main 的 fatal 呈现语义不要被第二套门取代；5. main 的 `restartWatchdogMs`（F4）与 `installBlockedReason`；6. main 的 `AppUpdater` 可用性语义；7. main 的门禁现值（`check-anchors` 的文档锚扫描 + `anchors-budget.json` + C1–C16）；8. 版本面（`package.json` 0.3.2-beta.5 / `CHANGELOG.md` / `docs/CHANGELOG.en-US.md` / `docs/i18n-record.json`——本分支 beta.3 同名不同线，已过期）；9. macOS 命名/装配/公证/delta updates/刷新率/overscroll 日志面；10. 插件写面本体（除非 D1 单独立项）。

### 7.5 需要重写的文档

`docs/progress/swift-vs-upstream-differences.md`（main ABSENT）、`docs/checklists/macos-real-machine-checklist.md`（ABSENT）、`scripts/dev/collect-macos-evidence.sh`（ABSENT）——三份都以本分支的旧 Swift 基线为参照，必须按 main 的 NativeText/主题/归因/日志逐行重判；新文档里如写 `file#symbol` 锚会被 main 的 `check-anchors` 扫描 → 用可解析锚或放进 GENERATED 块。

## 8. 阶段 5 · 验证与门禁

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
pnpm run check:full                     # static + typecheck + tests 的主力面
pnpm run build:renderer                 # 首屏/契约面
node scripts/upstream/verify-registry.mjs
node scripts/upstream/check-anchors.mjs
node scripts/upstream/verify-upstream-touchpoints.mjs --no-artifact-rebuild
node scripts/upstream/preflight-vendor-pin.mjs dsh-v0.1.7-rc.2   # 联网版（补 --offline 缺的 npm 发布态）
pnpm run test:sidecar:compiled && pnpm run build:sidecar --skip-node --skip-vendor --skip-host-packages
pnpm run test:release-workflow
```

- **mode 与步骤数（新 main）**：static **18**、typecheck **13**、tests **28**、full **59**（旧 main 是 11/10/26/47）。新增步骤：`verify:package-boundaries`（A 禁生产面跨包相对 import、B exports 白名单）、`verify:no-dead-exports`、`verify:upstream-lifecycle-contract`、`verify:ladder-table-parity`、`verify:stream-state-swift-parity`、`verify-artifact-freshness`、`remote-state-injection-matrix`、`refactor/equivalence`、`test:stream-state`、`typecheck:stream-state`、`typecheck:runtime`。
- `run-checks` 支持 `--jobs N`（全局文件池）；static 是只读的，缺失产物会要求先跑 `build:artifacts`。
- **移植代码的门禁约束**：新入口面必须有生产消费方（`verify:no-dead-exports`）；不得跨包相对 import（`verify:package-boundaries` A）；vendor 深引必须登记在 `registry.json` 的 `vendorSourceConsumers`（C16）——H9 改 `host-graph.ts` 时同步该登记。
- 重点复绿：**C4**（**23** 双序）、**C9**（28→**13** 锚重锚）、**C10**（六锚 + 3 fork）、**C11**（**+6/−1，白名单 10**）、**C16**（vendor 源消费者集合相等）；`--update-budget` 只降不升——main 侧预算已降到 665，本树实测 720 / 预算 743，整合后按本树实测重录。
- 全仓 grep 旧 pin 字面量：`git grep -n -E "0\.1\.5-rc\.2|0\.1\.6-alpha\.[12]|fb2c4b9e|ddefc45" -- ':!vendor' ':!packages/desktop/vendor'`，逐个判「活锚 / 夹具 / 注释」。
- 实机项按 `docs/checklists/macos-real-machine-checklist.md` 与 `docs/checklists/gui-acceptance-checklist.md` 走查（S-48/49/50/10、折叠态+徽标、vibrancy/主题、dmg+Gatekeeper、C4 恢复框+relaunch、Windows 面）。

## 9. 阶段 6 · 记录（只记开放项与规则）

1. `CHANGELOG.md`（+`docs/CHANGELOG.en-US.md`）：**发布时**写，不预先加 `[Unreleased]`；升级叙述按「正式版对上一个正式版的差值」聚合。
2. `docs/progress/STATUS.md`：只留开放项（C 分层写面裁决、实机门、x64 前置、session health 重 derive、python 载荷消费者、C9/C11 重锚残余）。
3. `docs/progress/deviations.md`：S/T 行按 main 现值校准（S-49/T-09 等）；双 flavor 方向（Swift 权威）保留。
4. `docs/checklists/upstream-touchpoints.md`：只跑 `registry-views.mjs --write`，不手改 GENERATED 块。
5. 本指南：执行完删除（或把仍未完成项并入 STATUS）。

## 10. 风险与回滚

| 风险 | 触发 | 缓解 |
|---|---|---|
| gitlink/pin 不一致导致差量建链硬失败 | 只跑一次 update-vendor | 按 §4.1 步骤 2 先 `git add vendor/harness-checkout` 再重跑（幂等） |
| 首屏 roster/covered 漏裁决 | 新增 11 条 client 行 | 先 `typert-remote-contract` + `required-extra-rows` + `chamber-covered` 三处重 derive，再跑 renderer 测试 |
| C9 锚点重锚不彻底 | 上游改了 6 个 patch 文件 | 以 `verify-upstream-touchpoints` 的断锚清单为准逐条落锚，**不得关判据** |
| 双 flavor 机制打架 | 两套 `NSApp.appearance` 写者 / 两套文案字典 | 按既有裁决（§2.1 权威方向）：Swift 只留 main 的 NativeText + ShellPageFacts |
| 写面退役静默生效 | 重放既有裁决（§2.1）时 | 按 §2.2-A 独立提交 + 全量 IPC/bridge 计数锁 + 渲染端模型同步 |
| 回滚 | 升级中途放弃 | 保留升级前 tag/分支；`update-vendor` 双向幂等（回退同理：改回 `harness.commit` 并重跑工具 + `git add` gitlink） |

## 11. 附录

### 11.1 命令速查

```bash
OLD=fb2c4b9e; NEW=477b4f4205; V=dsh-v0.1.7-rc.2
git -C vendor/harness-checkout diff --shortstat $OLD $NEW
git -C vendor/harness-checkout diff --stat $OLD $NEW -- packages/client
node scripts/upstream/preflight-vendor-pin.mjs $V --offline
npm view @deepseek-ai/dsh dist-tags --json
npm view @deepseek-ai/dsh@0.1.7-rc.2 dependencies
```

### 11.2 证据来源（本指南的调研）

- 上游 release：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- 分支持久台账：本仓库提交 `72ee40ce`（`docs/progress/todo/upstream-0.1.7-upgrade.md` 原文，含 T1–T11 增量表、0.1.6→0.1.7 研究、重放清单）。
- 分支增量与 main 的整合裁决来自对 `695f67c8` / merge-base `82df4c47` / `72ee40ce` 的三方只读分析（旧 main `695f67c8` 口径：43 干净 / 25 冲突；新 main `267272b0` 下为 **61 干净 / 121 冲突 / 486 块（`--diff3`，默认 401）**，见 §1.8.1）。
- 直接跳跃 preflight 来自 `/tmp` 影子 ROOT（`harness.commit=fb2c4b9e`），**未改动任何 tracked 文件**。

### 11.3 不确定项

1. 影子 preflight 的 "pure" 被低估（fork 副本是 0.1.6 版）→ 以「replay ∩ registry patched」为准。
2. opt-in 白名单来自 npm 元数据（递归一层），以升级后 bundle 出的锁文件为准（C11 兜底）；`speech-to-text-sensevoice` 的平台门未核。
3. 23 个 replay 文件的实际冲突规模是预测（未真实 rebase）；`ui-sidebar`/`ui-layout` 的深引改动需逐个人工评审。
4. 0.1.6→0.1.7 的 commit 数（1056）来自时间窗口径；submodule 是浅克隆，精确值需 `fetch --unshallow`。
5. 上游无 CHANGELOG.md，发布说明来自 GitHub API 正文，未逐条与 diff 对账。


## 12. 逐项执行规格（步骤 / 验收 / 坑）

> 通用前提：已完成 §4 双线 pin 与 §5 硬破坏修复（否则下面的验收命令会红在与本项无关的地方）。

### 12.1 P0-1 · 更新链看门狗

**目标行为**：检查/下载静默挂起不再永久停住；节奏 600s±20% + 退避封顶 1h + focus/resume nudge；opt-in journal；就绪前台注意力；E 命名失败 `check-network`/`download-network`，S `native-update-stalled:<phase>`。

**步骤**
1. 取件 P0-1 的路径（原 §12.3，清单已移除）（`updater.ts` **3 冲突块**、`update-headless.ts` **4**、`main.ts` **16** 需手工合；`update-schedule.ts`/`update-journal.ts`/`startup-error.ts` 等新文件直接取）。
2. `packages/desktop/scripts/test.mjs` 手工并：保留 main 的条目 + 加入 `updater-watchdog.test.ts`、`updater-main-wiring.test.ts`、`update-schedule.test.ts`、`update-journal.test.ts`。
3. `packages/renderer/src/global.d.ts` 手工并：`UpdateState.failureKind?` 取 `check-network` / `download-network` 两个字面量之一（L3 锁步会校验）。
4. `main.ts`：确认三处接线都在——`powerMonitor.on("resume")` 调 `updateController?.noteActivity("resume")`、`createUpdateController({ … flashFrame: on => flashUpdateAttentionWindow(on, { window: mainWindow }) })`、以及定时器的 `arm/runScheduledCheck` 路径。
5. `macos/Sources/DSHChamber/AppUpdater.swift`：确认 `availabilityRefusal`（可用性门）、`stallWatchdogMs`（checking 60s）/`downloadStallWatchdogMs`（30min）、迟到检查结果抑制、`shouldRaiseUpdateAttention` 均在；`Info.plist.template` 的 `SUScheduledCheckInterval=600`。

**验收**
```bash
node --test packages/desktop/test/desktop-shell/updater-watchdog.test.ts \
  packages/desktop/test/desktop-shell/updater-main-wiring.test.ts \
  packages/desktop/update-schedule.test.ts packages/desktop/update-journal.test.ts
pnpm --filter @dsh-chamber/desktop run test
pnpm run test:swift     # UpdateStallWatchdogTests + UpdateAvailabilityTests
```

**坑**：① 不要动 main 的 `restartWatchdogMs`（F4 重启停滞看门狗，与本项是两条腿）；② `update-headless.ts` 的 `noteActivity` 门必须与 Electron 同形（elapsed 比较），headless 的 `stop()` 要终局；③ 下载停滞判定**不能**停表或放开检查排除闩（代际闩 + 迟到相位守卫是修过的 bug）。

### 12.2 P0-2 · 原生崩溃诊断

**步骤**：取件 `CrashDiagnostics.swift` + `CrashDiagnosticsTests.swift`；`ShellLog.swift` 手工并（保 main 主体 + `fileURL(userDataDir:fileName:)` 重载）；`AppDelegate` 的三处接线（启动消费 `reportPreviousCrashIfNeeded` → 安装 handler → `applicationWillTerminate` 清 marker）在 0.1.7 版 AppDelegate 上重贴。

**验收**：`pnpm run test:swift`（`CrashDiagnosticsTests` 全绿，含信号路径无 `gmtime_r`、marker `S_IFREG+nlink==1`、`removeMarker` 失败 loud、整数 civil-date 与 oracle 的逐字节锁步）；`swift build --package-path macos` 干净。

**坑**：① 信号 handler 里只能有 async-signal-safe 调用（不要引入任何 Foundation/格式化）；② 不要用 `CrashDiagnostics` 取代 main 的 `RendererRecovery`（进程域不同）；③ release 反汇编核对 `emitSignal`/`renderTimestampPrefix` 无 `malloc`/`objc_msgSend`。

### 12.3 P1-1 · Electron 壳文案本地化

**步骤**：取件 `shell-locale.ts` + 测试；把 main 硬编码的中文文案（启动失败/前端异常/已在运行/控制面启动失败 等）改为 `resolveShellLocale()` 查表；与 Swift 侧的 recovery 文案键保持措辞一致（Swift 走 main 的 `NativeText`）。

**验收**：`pnpm --filter @dsh-chamber/desktop run test`（含 `shell-locale.test.ts`）；`swift test` 的 `NativeTextTests` 仍绿（新增键已在两个 lproj 里）。

**坑**：**不要**把 `ShellLocale.swift` 搬过来（两套字典）；Swift 侧只加 `NativeTextKey`。

### 12.4 P1-2 · registry sidebar 条目 + 不变量放宽

**步骤**：手工三方合 `registry.json`/`registry.mjs`/`registry.test.mjs`（原 §12.3，清单已移除）；新登记 `fork.dsh-chamber-client-ui-sidebar`（`type` 为 fork、`versionAnchor` 为 chamber、droppedNotes 用实测桶数）；**layout 已由 main 登记为 `seed.dsh-chamber-client-ui-layout`，收敛/合并到该条目即可**；补 `chamberNamedForks`；放宽为 named 条目只允许 fork 或 seed，并加负例（named 条目改成 seat 必须红）；跑 `registry-views.mjs --write`。

**验收**：`pnpm run verify:registry`、`pnpm run test:scripts`、`node scripts/upstream/verify-upstream-touchpoints.mjs --no-artifact-rebuild`（C1/C3 对两包给出桶计数）、`run-checks static`。

**坑**：`docs/checklists/upstream-touchpoints.md` 是生成视图，**不要**手改。

### 12.5 P1-3 · 安全模式

**步骤**：取件 `safe-mode.ts`（控制面/渲染端）、`static-serving.ts` 注入、`index.ts` 的 seed 跳过、用例；把三处字面量对齐：Swift/Electron 传入 env `DSH_CHAMBER_SAFE_MODE=1` → 控制面读同一 env → 页面注入 `__DSH_CHAMBER_SAFE_MODE__`；只备份 chamber 自持文件。

**验收**：`packages/control-plane` 的 `static-serving`/`host-graph-seed` 用例 + `packages/renderer` 的 `safe-mode.test.ts` + `startup-recovery.test.ts` 的跨包字面量锁步。

**坑**：普通启动**不得**注入全局名（有断言锁定字节级不变）；env 只认 1。

### 12.6 P1-4 · parity 席位/形态（含 0.1.7 形状修正）

**步骤**：取件窗口形态（`MainWindowController.swift` 1 hunk 手工）、`electronFuses.runAsNode`、ready 帧 `shellVersion` 校验、Windows caption、`failureKind`、两席位（**注册名按 0.1.7**：`shell.leading` + `sidebar.toggle.badge`，见 §15.4）、`native-theme-set` 的 **Electron 腿**。

**验收**：`pnpm run test:swift`（`ShellIdentityTests` 窗口形态断言）、`pnpm --filter @dsh-chamber/desktop run test`（`upstream-seats.test.ts`）、`pnpm --filter @dsh-chamber-client-ui-sidebar run test`（visual-lock）、`node scripts/gates/run-checks.mjs static`。

**坑**：① 窗口的 vibrancy/主题别与 main 的 `applyAppearance` 打架（Swift 腿不搬）；② `Info.plist.template` 保留 main 的版本键；③ 0.1.5 没有 leading 座——我们是**新注册**，0.1.7 换成 `shell.leading` 后必须按 §15.4 的 owner props 形状写。

### 12.7 P1-5 · python 载荷

**步骤**：取件脚本/锁/README/测试/`build-sidecar` 改动/`release-artifacts` 改动；`release.yml` 手工并（保留 main 的 delta updates 与发布步骤，加入 `prepare-python-payload` 与 `--require-python`）；`provenance.structure` 改为 `vendor/harness-checkout/scripts/primary-runtime/lock.json`、`upstreamCommit` 更新为 0.1.7 提交。

**验收**：`node packages/desktop/scripts/prepare-python-payload.test.mjs`、`node packages/desktop/scripts/prepare-python-payload.mjs --dry-run`（无 `--target` 必须 exit 0）、`pnpm run test:release-workflow`、`pnpm run build:sidecar --skip-node --skip-vendor --skip-host-packages`。

**坑**：① 精确 dist-info 校验（同名任意版本必须红）；② `.gitignore` 的 README 否定规则要一起取；③ x64 保持撤回，不要再引入 x64 分片。

### 12.8 P1-6 · 读面能力门（既有裁决的保留面）

**步骤**：取件 `plugin-capability.ts`（三态：可用/受限/不可用）与用例；确认所有读面（`desktop_ssh_plugin_list`/`desktop_local_plugin_list`/seed 图/官方 Plugins 页）仍可用；渲染端在插件页用它做降级展示。

**验收**：该包测试 + `pnpm --filter @dsh-chamber/desktop run test`（IPC 面锁）。

**坑**：这是**读面**改进，与写面退役是两件事；不要顺手把写面删掉或加回来。

### 12.9 P1-7 · 会话流健康臂（按既有裁决维持降级）

**先做**：按 main 的 `dsh-stream-state`（`src/{ladder,session-authority,carrier,tables}.ts`）与 design 14 §D4 新口径重判本臂的剩余独立面（`verify:upstream-lifecycle-contract` 的退役条件）；`session-fact-reconcile.ts` 在 main 已搬到 `packages/dsh-chamber-client-core/src/session-fact-reconcile.ts` 且被重写（其 wiring 测试在 main 已删）。**步骤**：取件 probe/阶梯/契约测试；把 pin 字面量与注释改成 `dsh-v0.1.7-rc.2`；确认阶梯在无杠杆时 fail-closed（不导航、不抛错）并在预算用尽后落 reload 提示。

**验收**：`node --test packages/dsh-chamber-client-ui-open-in/test/session-health/vendor-heal-contract.test.ts`、该包全量测试、`typecheck`。

**坑**：不要为过测试而 skip/删除契约断言；上游仍无 `followCurrent`/`watched`/`ISessions.open(id)`（§15.5 已核）。

> **重判结论（rc.2 锚，已执行）**：本臂在 main 已按 rc.2 口径重推导——唯一自动杠杆 = 具象
> `Session.resync()`（rc.2 的契约入口 `ISessions.binding(id)`，只对 main view 呈现的会话生效），
> 0.1.6 的 stage-move 杠杆随 vendor 会话控制器重写消失。`vendor-heal-contract.test.ts` 同时锁
> CURRENT（rc.2）与 LEGACY（回滚 pin）两形体，验收命令全绿。**分支的 0.1.6 形态不要取件**（会回退
> 已重推导的臂）；残余只是真机抽检，登记在 STATUS ⑫。

### 12.10 P2-1 · 启动失败恢复（最大冲突面）

**步骤**
1. 取件 `startup-error.ts`（`planStartupRecovery`/`resolveStartupRecoveryAction`/`SAFE_MODE_ENV`/`backupChamberStateForRecovery`）与 `startup-recovery.test.ts`。
2. `main.ts`：把 5 个 `fatalMainError` 调用点统一改走 plan（三选；锁冲突两选）；按键语义（默认/Esc = 安全项）。
3. `AppDelegate.swift`（**46 冲突块**；先合 main 骨架）：以 main 的 `NativeText` 为文案源，叠上 `RecoveryChoices`（三选/两选）、`runThreeChoiceRecovery`、`RecoveryPresentationGate`、`fatalRuntime`、**spawn 失败先 `stop()` 释放 flock 再呈现**；main 的 `fatalAlertShown` 与我们的 gate **合成一个门**；清理判据仍走 `canRelaunchAfterCleanup`。
4. `SidecarSupervisor.swift`：确认 `self.supervisor` 在 `start()` 前赋值、catch 里 `recoverFailedStartup` 先停后弹。
5. 三个 Swift 用例（`StartupRecoveryTests`/`RecoveryChoicesTests`/`RuntimeRecoveryTests`）全部取件并适配 main 的 `NativeText` API。


> **执行注记（2026-12 轮次侦察，动工前必读）**：
> ① 本项的**提交顺序约束**：`startup-error.ts` 的三个运行时导出（`isSafeModeEnabled`、
> `resolveStartupRecoveryAction`、`formatStartupFailureDetail`）只有 `main.ts` 接线才会消费——
> 先落模块会被 `verify:no-dead-exports` 判死代码（本轮实测红：3 个导出无生产消费者）。
> 因此 **接线与模块必须同一提交**；纯决策/备份用例可以先跑（去掉 ③ 接线锁与跨语言字面量锁后 8/8 绿）。
> ② main 侧的接线面与分支不同名：main 的 `fatalMainError`（main.ts:57）当前**直接 `app.exit(1)`**
> （计划坑②要的正是把它换成用户三选）；目录锁是 `const chamberLock = acquireChamberLock(...)`
> （main.ts:1006，非模块级句柄，锁冲突点在 :1009 用单键 `showErrorBox`）——重启腿需要先把它提为
> 可释放句柄；main **没有**分支的 `quitCleanupPromise`/`recoveryRelaunchInProgress`，退出清理在
> `before-quit → will-quit`（main.ts:305 注释 + host-assembly 的 quitting 门）——恢复重启腿要复用
> 同一条清理链并做单飞，不能新造第二条。
> ③ 测试拆分：分支用例的 5 条 main.ts 接线锁 + `跨包/跨语言字面量锁步`（env 名 × 控制面/渲染端/
> Swift `AppDelegate`/bridge-shim 四处一致）必须与 Swift 恢复框同批——Swift 壳现在还没有
> `DSH_CHAMBER_SAFE_MODE` 声明（该锁的 Swift 断言本轮实测红）。
> ④ **编辑计划（行号为 2026-12 侦察时的 main，动工时重核）**：
>   1. `chamberLock`（main.ts:1006，函数内 `const`）→ 提为模块级 `chamberLockHandle`（保留 `ok`/`unsupported`
>      判定与 1009 的错误分支），使重启腿能在 `app.exit(0)` 前显式 `release()`（app.exit 不保证 'quit' 事件）。
>   2. main 的 `quitCleanupInProgress`（main.ts:214 布尔位，will-quit :931/#949-977 里用）→ 换成
>      `quitCleanupPromise` 单飞 promise（保留布尔位语义：第二路继续 `preventDefault`），让 `will-quit` 与
>      恢复重启腿共享同一份清理；`before-quit`(:863) / `quit`(:1032) 的既有语义不动。
>   3. 五条 fatal 呈现点改走 `reportFatalStartupFailure`：:655（preload 缺失）、:797（前端加载失败）、
>      :1024（host-root 租约失败）、:1230（控制面启动失败）= 三选 `'startup'`；:1009（目录锁冲突）= 两选
>      `'already-running'`（默认/Esc 落「重启」而不是退出）。`fatalMainError`(:57) 的 uncaught 路径保持
>      `app.exit(1)`（进程已不可信，不能弹框），但删掉单独的 `dialog.showErrorBox` 以免两套呈现门。
>   4. `const safeModeActive = isSafeModeEnabled(process.env)`（装配期快照）+ 一行生效声明 + 建控制面时
>      `safeMode: safeModeActive`（控制面自身也读 env，这里是显式化与日志单源）。
>   5. `applyStartupRecoveryAction`：`'safe-mode-restart'` 必须先 `backupChamberStateForRecovery` 再
>      `process.env[SAFE_MODE_ENV] = '1'`；`'restart'`/`'safe-mode-restart'` 都是 `app.relaunch()` →
>      `await runQuitCleanupChain()` → `chamberLockHandle?.release()` → `app.exit(0)`（顺序即分支用例的
>      4 条 index 断言）。

> ⑤ **Swift 半边编辑计划（2026-12 侦察；TS 半边已落地，生产基线见 `790d2e64`）**：
>   1. 分支 API 面（`AppDelegate` 静态成员，须整体取件并适配）：`RecoveryChoices`（三选/两选）、
>      `RecoveryPhase`（startup/runtime，只改标题后缀）、`startupRecoveryKeyIsSafe`（Return 36 / keypad 76 /
>      Esc 53 都命中安全项）、`recoverySafeButtonIndex = 2`、`startupRecoveryAction(for:choices:)`（未知响应
>      同样落安全项）、`makeStartupRecoveryAlert`（纯构造，按钮序 + `\r` 默认高亮在安全项）、
>      `runThreeChoiceRecovery`、`runStartupRecoveryAlert`/`runRuntimeRecoveryAlert`、`RecoveryPresentationGate`
>      （NSLock 抢单次呈现权）+ `enterRecoveryPresentation`（gate 已置位时只 loud、不 present、不 exit）、
>      `recoverFailedStartup`、`canRelaunchAfterCleanup`/`recoveryCleanupSummary`/`recoveryRelaunchBundleURL`/
>      `recoveryRelaunchEnvironment`、`safeModeEnvironmentKey`/`isSafeModeEnabled`。
>   2. main 侧**替换点**：`fatalAlertShown` + `presentFatalAlert(_:)`（AppDelegate.swift:973-987，单键 +
>      sheet/runModal 后 `exit(1)`）与 `fatalStartup(_:) -> Never`（:1071-1084，单键 runModal + `exit(1)`）
>      全部改走三选；呈现门由静态 bool 收敛到 `RecoveryPresentationGate`（绝不留两套门，计划坑①）。
>   3. **文案源映射**：分支用 `ShellStrings`/`ShellLocaleResolver`（按 design 25 §5.1 不取件），main 用
>      `NativeText`——标题复用既有 `fatal.startupFailedTitle` / `fatal.sidecarAbnormalTitle`，按钮需新增键
>      （退出/重启/安全模式重启；退出可复用 `quit.*`，重启与安全模式重启是本项新增）。
>   4. **relaunch 是新代码**：main 没有 bundle 自重启助手（分支的 `recoveryRelaunchBundleURL` 用 `Process` +
>      `open` 语义重建同 bundle 并注入 `DSH_CHAMBER_SAFE_MODE=1`）；`canRelaunchAfterCleanup` 的判据必须真的
>      看到 `state == .stopped`（计划坑③）。
>   5. `SidecarSupervisor.swift`：确认 `self.supervisor` 在 `start()` 前赋值；spawn 失败的 catch 先
>      `stop()`（释放 flock）再呈现恢复框，绝不持锁弹框。
>   6. 用例：`StartupRecoveryTests`（251 行）/ `RecoveryChoicesTests`（69）/ `RuntimeRecoveryTests`（215）
>      三条整体取件并适配 `NativeText`；随后恢复 TS 侧 `startup-recovery.test.ts` 尾注里的**跨语言字面量锁步**
>      （env 名与页面全局名四处一致——Swift 声明 `DSH_CHAMBER_SAFE_MODE` 后该断言即可转绿）。

**验收**：`pnpm run test:swift` 全绿（含重复 fatal 不 exit、spawn 失败先释放锁、两选/三选映射）；`node --test packages/desktop/test/desktop-shell/startup-recovery.test.ts`；`swift build` 干净。

**坑**：① 绝不留两套呈现门；② 呈现后进程去向只能由用户选择决定（绝不静默 `exit(1)`）；③ `.app` relaunch 的清理判据必须真的 `state == .stopped`；④ 真机键位走查仍开放（runbook §8）。


### 12.11 P0-0 · rc.2 新增阻断（H10 + fork 契约；新分支第一件事）

**步骤**
1. **H10 键盘桥**：在 `packages/desktop/preload.cts` 与 `macos/Sources/DSHChamber/Resources/bridge-shim.js` 的 `dshDesktop` 载体上补 `keyboard`（最小空桥：`subscribe` 返回 no-op disposer）或完整 `keyboard`+`shortcuts`（`<userData>/keybindings.json` 持久化）；两 flavor 形状一致，Swift 侧同步 design 25。
2. **layout fork**：`LayoutController` 的第 3 参 `panelInfo` 上移（官方 `ui-plugin-manager`/`ui-open-in-app` 消费 `ctx.layout.panelInfo`）；补 `sidebar.left.toggle`（Cmd+B）注册与 `shortcuts` inject。
3. **sidebar fork**：补 `shortcuts` inject 与 `injectProps.hooks.shortcuts`（供 `HeaderLeadingControls` 的 `useShortcuts`）；与 `shell.leading` 迁移一并切换。
4. **client-web fork**：把 `window-drag/{regions,recall}.ts` 与 `boot.ts` 的 install/dispose 镜像进 N-ctx boot；`base.css` 拖拽规则同步（Electron macOS hiddenInset 生效，Swift no-op）。
5. **typert 生成面**：`packages/renderer/scripts/typert-remote-contract.mjs` 由 19 一次重 derive 到 23 双序（§15.1 两表须按 rc.2 重建为 23 条，见 §20.2）。

**验收**：Electron 与 Swift 打包态冷启动框架/侧栏挂载（无 `Desktop keyboard bridge unavailable`）；官方插件页与 open-in 在复合页无 throw；Cmd+B 有键帽；`run-checks static` + desktop/swift 相关测试绿。

**坑**：① 不要靠「不写 platform marker」绕过——darwin 折叠几何与 `shell.leading` 都读它；② 两 flavor 的 `dshDesktop` 形状必须一致（design 01 §4 的有界例外）；③ layout fork 的 `panelInfo` 必须给 `provideRoot` 里的官方消费者，晚建即 throw。

## 13. 新分支启动与执行清单（可勾选）

> 这份清单是给「新分支 + 新 agent」的入口；每一步都给了命令与预期输出，红在哪一步就先修那一步，不要跳步。

### 13.0 准备（10 分钟）

- [ ] 取件来源 = tag `backup/v016-alpha1-pre-reset`（旧分支只读；按路径取、**不 cherry-pick**）。
- [ ] `git switch main && git pull`；确认 `git show main:harness.commit` 仍是 `fb2c4b9e`（若 main 已动 pin，先按 §1 重新照面）。
- [ ] `git switch -c upgrade/dsh-0.1.7`；本计划已在当前分支（重置时保留），可直接搬入新分支。
- [ ] 先 `pnpm install`（重置后 `node_modules` 仍是旧树；否则 `bundle:dsh` 会因 `@dsh-chamber/dsh-runtime/dist` 缺失而报错），再记录基线：`node scripts/gates/run-checks.mjs static`（需先 `pnpm run build:artifacts`）、`typecheck`、`tests` 三条结果（作为「升级前绿」的证据）。

### 13.1 pin 双线（§4）

- [ ] `node scripts/upstream/update-vendor.mjs dsh-v0.1.7-rc.2`（预期第一次因 gitlink 不一致失败）。
- [ ] `git add vendor/harness-checkout` 后**重跑同一条命令**（幂等；预期成功）。
- [ ] `node scripts/dev/ensure-harness-vendor.mjs --check` 绿。
- [ ] 运行时线：`bundle-dsh.mjs` 钉版 → `pnpm --filter @dsh-chamber/desktop run bundle:dsh -- --force --refresh-lockfile` → 冒烟 `--version` 输出 `0.1.7-rc.2`。
- [ ] 六锚 + 3 fork 同步（§4.2），`preflight-vendor-pin.mjs dsh-v0.1.7-rc.2`（联网）复跑。

### 13.2 硬破坏（§5，编译/启动级）

- [ ] H1 `ctx.settingsScope` → `ctx.configForms`（按 §15.3 清单逐站点改）。
- [ ] H2 席位 `conversation.session.header.leading` → `shell.leading`；同时补 `shortcuts` inject/hooks（rc.2）。
- [ ] H3 图标 `*Outline16` → `*OutlineRegular`（按映射表）。
- [ ] H4 remote 装配 15 → **23**（两份顺序表；rc.2 +`schedule` = import#7 / mount#8）。
- [ ] H5 api-gateway 客户端半 uplink/`RemoteStreamHandle`。
- [ ] H6 connection `rpc.ts` 相对路由 + 二进制（basePath 自己补）。
- [ ] H7 `settings.launcher` 新座（壳 chrome 渲染点 + `openSettings`/`openOnboarding` 接线；rc.2 另传 `settingsOpen`/`settingsShortcut`）。
- [ ] H8 plugin-inventory 镜像只消费 `entries`（不补 `meta`，不得因缺 `trust` 整单抛错）。
- [ ] H9 图行 URL 归一到 `basePath + '/' + url`（**先于 pin bump**）。
- [ ] **H10 shortcuts 键盘桥（rc.2，阻断级）**：两 flavor preload 补 `dshDesktop.keyboard`（最小空桥或完整 keyboard+shortcuts）；打包态冷启动框架/侧栏能挂载（§12.11 / §17-H10）。
- [ ] **rc.2 fork 契约**：layout `LayoutController(..., panelInfo)` + `sidebar.left.toggle` + `shortcuts` inject；sidebar `shortcuts` inject/hooks；client-web `window-drag/*` 镜像进 N-ctx boot；typert EXPECTED 19 → 23 双序（§12.11）。
- [ ] `pnpm run typecheck` 绿 + `pnpm run build:renderer` 绿。

### 13.3 fork rebase 与门禁重锚（§6）

- [ ] 按 §6.2 replay 清单逐项落位（rc.2 preflight = 12 条人工重放，见 §20.2）；`stream-protocol.ts`/`remote-error-codes.ts` 等 6 个 pure 直接照抄。
- [ ] C9 **命中 13/28、断 15 处**逐条重锚（rc.2；清单见 §5.3/§20.2）。
- [ ] C4 **23** 双序 / C10 六锚 / C11 白名单 **+6−1（10）** 全绿：`verify-upstream-touchpoints --no-artifact-rebuild`。
- [ ] registry 按新 pin 文件清单补分类 + 生成视图重跑。

### 13.4 取件移植（§7 移植表 / §12 逐项规格）

- [ ] P0-1 更新链看门狗（§12.1）→ 四个 JS 用例 + Swift 两套用例绿。
- [ ] P0-2 崩溃诊断（§12.2）→ `test:swift` 绿。
- [ ] P1-1 Electron 文案（§12.3）→ 包测试绿。
- [ ] P1-2 registry 两条 fork + 不变量（§12.4）→ `verify:registry` + `test:scripts` 绿。
- [ ] P1-3 安全模式（§12.5）→ 跨包锁步绿。
- [ ] P1-4 parity 席位/形态（§12.6）→ 三处测试绿。
- [ ] P1-5 python 载荷（§12.7）→ 载荷测试 + `test:release-workflow` 绿。
- [ ] P1-6 读面能力门（§12.8）→ 包测试绿。
- [ ] P1-7 会话流健康臂（§12.9）→ 契约测试绿。
- [ ] P2-1 启动恢复（§12.10）→ Swift 三套件 + `startup-recovery.test.ts` 绿。

### 13.5 全量验证（§8）

- [ ] `pnpm run check:full`（新 main：static 18 + typecheck 13 + tests 28 = 59 步）；`pnpm run build:renderer`；`test:sidecar:compiled`；`test:release-workflow`。
- [ ] 三条只读门禁复绿（registry/anchors/touchpoints，含 C16）；新增门全绿（`verify:package-boundaries`、`verify:no-dead-exports`、`verify:upstream-lifecycle-contract`、`verify:ladder-table-parity`、`verify-artifact-freshness`…以 `--list` 为准）；`python 载荷 --dry-run`；`swift build` + `test:swift`。
- [ ] 旧 pin 字面量全仓 grep，仅剩历史注释/夹具。
- [x] 实机项（runbook）与 GUI 验收按清单走查；**未做项已于 2026-12 登记进 `docs/progress/STATUS.md`**（「实机门禁」清单含本轮从 §21 折入的四项）。

### 13.6 写面退役（既有裁决，独立提交，§2.2-A）

- [ ] 删除写面：源文件 + 通道 + 渲染端写面模型；保留读面 + `plugin-capability.ts`。
- [ ] 重生成桥面产物；全量 IPC/bridge 计数锁；`docs/design/13` 已写明退役。
- [ ] 独立提交，提交信息引用「2026-09 C 分层用户裁决」。

### 13.7 记录与交付（§9）

- [ ] `STATUS.md`：只留开放项（C 分层残余、实机门、x64 前置、会话流重 derive、载荷消费者、C9/C11 重锚残余）。
- [ ] `deviations.md` 按 main 现值校准；`upstream-touchpoints.md` 只由生成器写。
- [ ] CHANGELOG 等发布时写（不加 `[Unreleased]`）。
- [x] 残余项并入 STATUS：§21 的开放面（真机四项 + 两条裁决 + 已裁决不做的 5 项）2026-12 已折进 `STATUS.md`；本指南保留为升级计划的细节来源（不再单独持有开放状态）。PR 按 §14 证据模板填。

## 14. 验收证据模板（填 PR / 交付说明）

1. **意图与范围**：`dsh-v0.1.5-rc.2 → dsh-v0.1.7-rc.2`（源码线 + 运行时线 + 3 fork）；含/不含写面退役（若含，链接独立提交）。
2. **受影响面**：桥面（52+8=60，若写面保留则仍是 69）、runtime 锚六处、fork 三处、renderer 首屏 roster、Swift 框架、python 载荷、macOS/Windows 用户可见行为。
3. **验证**（逐条贴命令 + 结果）：`run-checks static/typecheck/tests`、`check-anchors`、`verify-registry`、`verify-upstream-touchpoints`、`test:release-workflow`、`build:renderer`、`test:sidecar:compiled`、`test:swift`、`preflight-vendor-pin`（联网）。
4. **已否决的替代方案**（若新引入取舍）：例如「按 latest/next 装运行时」「保留旧写面 vs 退役」「Swift 保留本分支字典」；各写 1–2 句为何不选。
5. **回滚**：`harness.commit` 回 `fb2c4b9e` + 重跑 update-vendor（幂等）+ `git add` gitlink；运行时锁 `--refresh-lockfile` 回旧版本。
6. **残余开放项**：指向 `STATUS.md` 条目（会话流重 derive、C9/C11 重锚残余、实机门、x64 前置）。

## 15. 0.1.7 逐面细节附录（历史基线；执行值见 §1.6/§20.2）

> **历史基线提示**：本附录的逐面表以 0.1.5/alpha.2 为基线；rc.1/rc.2 的修订见 §20，**当前锚点值一律以 §1.6 为准**。

> **本节基线为 alpha.2（`00102833df`）**：rc.1 对本节的核对与修订（图标 78、C4/C9/C10、python 锁、roster 等）见 §20；执行前先读 §20。

> 数据来源：`46a7f68b09`（`dsh-v0.1.7-rc.1`；rc.2 修订见 §20.2；§15 各表的锚点基线是 alpha.2 `00102833df`，rc.1 零 diff 见 §20）源码与本仓 `v016-alpha1` 树的只读勘测。

### 15.1 remote 装配两份顺序表（H4）

**数字先对齐**：main@0.1.5 = **15** 个 value import；本分支在 0.1.6 适配到 **19**；0.1.7-alpha.2 = **22**。直接跳跃是 15→22，不能照抄本分支的 19 版顺序表，必须按下面重建。

**value-import 顺序（0.1.7-alpha.2 基线 1–22；alpha.1 无第 10 项；rc.1 逐条相同；rc.2 为 23 条、`schedule` 在 #7，见 §20.2）**：
1 `agentPresetsRemote`（`@deepseek-ai/dsh-agent-preset-registry/remote`，注意改名）· 2 `commandsRemote` · 3 `accountRemote` · 4 `settingsControllerRemote` · 5 `officeToPdfRemote` · 6 `goalsRemote` · 7 `llmRemote` · 8 `dynamicRemote` · 9 `pluginManagerRemote` · **10 `pluginRegistryProbeRemote`（`@deepseek-ai/dsh-client-ui-plugin-manager/remote`，alpha.2 新增）** · 11 `pluginInventoryRemote` · 12 `messageFeedbackRemote` · 13 `permissionPresetsRemote` · 14 `sessionFeedbackRemote` · 15 `fileUploadsRemote` · 16 `sessionReferencesRemote` · 17 `subagentsRemote` · 18 `sessionRemote` · 19 `jobRemote` · 20 `workspaceRemote` · 21 `terminalRemote` · 22 `workspaceFilesRemote`

**apply/mount 顺序（0.1.7-alpha.2 基线 1–22；rc.1 逐条相同；rc.2 为 23 条、`schedule` 在 #8，见 §20.2）**：
1 agentPresetsRemote · 2 commandsRemote · 3 settingsControllerRemote · 4 accountRemote · 5 goalsRemote · 6 llmRemote · 7 dynamicRemote · 8 pluginInventoryRemote · 9 pluginManagerRemote · **10 pluginRegistryProbeRemote** · 11 messageFeedbackRemote · 12 sessionFeedbackRemote · 13 fileUploadsRemote · 14 sessionReferencesRemote · 15 permissionPresetsRemote · 16 subagentsRemote · 17 sessionRemote · 18 jobRemote · 19 workspaceRemote · 20 workspaceFilesRemote · 21 terminalRemote · 22 officeToPdfRemote

**顺序差异**（两份表集合相同、顺序不同；alpha.2/rc.1 为五处，**rc.2 第六处 = `schedule` import#7 / mount#8**）：account↔settingsController；pluginManager↔pluginInventory；permissionPresets↔sessionFeedback；terminal↔workspaceFiles；officeToPdf 从 import 第 5 位挪到 mount 最后一位。`inject=["remote"]`、`apply(ctx)` 结构不变。

### 15.2 图标改名映射（H3）

本仓共 **22 个唯一** `Icon*Outline16` 符号（全仓 28 个文件命中：chamber 源 16 个 + 5 个 `vendor-modules.d.ts` + README/已提交的 `lib/client.js` 产物/文档）。其中 **21 个**按 stem 直接改 `Icon*Outline16 → Icon*OutlineRegular`：

`AgentPreset`、`AlarmClock`、`Branch`、`Close`、`Data`、`Edit`、`Ellipsis`、`FolderOpen`、`Link`、`Loading`、`NewChat`、`PanelLeft`、`Personalization`、`Play`、`Plus`、`ProjectAdd`、`Refresh`、`Search`、`Settings`、`Trash`、`Warning`。

**唯一例外**：`IconMonitorOutline16` —— 0.1.7 的 ui-primitives **没有** `IconMonitorOutlineRegular`（对 monitor/server/host/device/desktop/computer 全零命中）。它在本仓是**自绘导出**（`packages/dsh-chamber-client-ui-sidebar/src/client/icons.tsx`，头注释已自述上游无该字形）→ **保持自绘**，不改名、不替换（若将来要替换，候选：`IconWorkspaceTreeOutlineRegular`/`IconGlobeOutlineRegular`/`IconApiOutlineRegular`/`IconDatabaseOutlineRegular`，需人工确认语义）。

**非 16 尺寸族同样被 0.1.7 移除**（7 个符号、16 个源文件；**`typecheck` 不兜底**——名字写死在 `vendor-modules.d.ts` 里声明仍在，运行期会变 undefined 组件）：

| 本仓符号 | 0.1.7 名 |
|---|---|
| `IconChevronRightOutline14` | `IconChevronRightOutlineRegular` |
| `IconChevronDownOutline14` | `IconChevronDownOutlineRegular` |
| `IconChecklistOutline14` | `IconChecklistOutlineRegular` |
| `IconQuestionOutline14` | `IconQuestionOutlineRegular` |
| `IconSettingsOutline14` | `IconSettingsOutlineRegular` |
| `IconArchiveOutline20` | `IconArchiveOutlineRegular` |
| `IconStopFill16` | `IconStopFillRegular` |

盘点命令（改完复跑应只剩 `IconMonitorOutline16`（自绘保留）与 SVG 资产假命中；vendor 树排除 `ui-settings-account` 的 onboarding SVG）：`git grep -n -E "Icon[A-Za-z0-9]+(Outline|Fill)[0-9]+" -- packages`。

### 15.3 `ctx.settingsScope` → `ctx.configForms` 站点表（H1）

| 站点 | 现状 | 0.1.7 动作 |
|---|---|---|
| `packages/renderer/src/locale-ownership.ts`（`bindLocaleScope`，L205 起） | `ctx.settingsScope?.bind({ namespace: 'locale' })` | 改为 `ctx.configForms?.get('locale')`（`entryId` 即 namespace）；表单面用 `getSnapshot()/subscribe()/set()` |
| 同文件 L71 的 `declare module` 松散声明 | `settingsScope?: { bind… }` | 改为 `configForms?: { get<T>(entryId: string): … }`（与 vendor 面同形） |
| `packages/dsh-chamber-client-ui-settings-bridge/src/vendor-modules.d.ts` | `settingsScope` 面声明 | 改为 `configForms` + `ConfigForm` 面 |
| `packages/renderer/src/locale-ownership.ts` L41 / `chamber-entry.ts` L196-303 / `chamber-covered.ts` L143-302（注释与首屏 inject 审计） | 文案/审计用的 `settingsScope` 字样 | 同步改成 `configForms`（首屏 inject 名单也要改） |
| `packages/renderer/test/frame-chrome/page-language-hook.test.ts`（fake ctx + inject 名单） | `settingsScope.bind` 桩、`inject: [... 'settingsScope']` | 改成 `configForms.get` 桩与注入名 |
| `packages/renderer/test/lifecycle/required-extra-rows.test.ts`（L191/192/200/208/222/429） | 审计表里 `settingsScope` | 改成 `configForms`；新审批的 client 行按 0.1.7 roster 重判 |

> 0.1.7 的入口：`packages/client/ui-settings/src/client/config-form.ts` —— `class ConfigForms extends Service`、`super(ctx, 'configForms')`、`get<T>(entryId): ConfigForm<T>`（按 entryId 记忆化、`namespace = entryId`）；vendor 消费者示例：`client/locale/src/client/index.ts`、`ui-chat/src/client/apply.ts`、`ui-conversation/src/client/apply.ts`、`ui-settings-general/src/client/index.ts`（inject 名都是 `configForms`）。

### 15.4 座席迁移：`conversation.session.header.leading` + `sidebar.toggle.badge`（H2）

**本仓现状**：`packages/dsh-chamber-client-ui-sidebar/src/client/index.ts` 直接复用 vendor 的 `HeaderLeadingControls` 并 `ctx.slots.inject('conversation.session.header.leading', …)`（S-51 用例锁 import/inject/name）；`sidebar.toggle.badge` 是我们在自己的 `contract/slots.ts` 声明的 root 座，由 `SidebarRoot.tsx` 渲染在折叠按钮里（S-52），官方 Web 页面通过 `dshDesktop` 载体把徽标挂进来。

**0.1.7 目标**：

- 会话头 leading 座**已退役**；新座 `shell.leading` 由 `ui-layout` 声明（`'shell.leading': { kind: 'single', scope: 'root' }`，**无 owner 键**），`AppFrame` **仅在 darwin 且侧栏整列折叠时**挂载（`leadingMounted = darwin && sidebarCollapsed`，并发布 `--dsh-frame-leading-clearance`）；occupant 仍是 vendor 的 `HeaderLeadingControls`（props = `PropsRuntime<'shell.leading'> & InjectFace<SidebarRootInjected> & PropsLocale<'sidebar'>`，渲染 reopen + New Session 两个按钮，自身不判平台）。
- 因此侧栏 fork 的动作：把旧 inject 改成 `ctx.slots.inject('shell.leading', () => ctx.slots.register({ name: 'shell.leading', locale: NS, inject: injectProps }, HeaderLeadingControls))`；`vendor-modules.d.ts` 的模块声明照旧；`S-51` 用例改成断言新座名，并**可加**一条「非 darwin 不挂载」的行为断言（参考上游 `app-frame.client.spec.tsx`）。
- `sidebar.toggle.badge` 在 0.1.7 **仍存在**（`ui-sidebar` 侧声明），我们的声明/渲染/`preload.cts` 的 `dshDesktop` 载体与 Swift 的 `bridge-shim.js` 载体**不用动**。

### 15.5 其它已核事实（避免执行时重复调研）

- **会话控制器**：0.1.7 仍无 `followCurrent`/`watched`/`ISessions.open(id)`（新增的 `refreshProjections`/Host 侧 `archived-session-gate` 不能当恢复杠杆）→ §12.9 的降级臂结论不变。
- **cordis logger**：0.1.5 的 disposer 有 bug（删的是当前计数器）、0.1.7 修成 `delete(id)`，0.1.6→0.1.7 **零 diff**；我们的契约测试断言 `delete(id)` 继续成立。
- **python 锁**：0.1.5 **没有**上游锁；0.1.7 在 `scripts/primary-runtime/lock.json`（5 target），mac-arm64 分片与本分支 0.1.6 锁逐项相同（python 3.12.14/20260901、`81a359f1…`、4 轮子、9 纯 py 轮、13 包）→ 内容照搬、provenance 改路径。
- **C9 断锚**：28 锚在 0.1.7 只剩 14 命中（断在 `ui-chat/AssistantMarkdown.tsx`(e0/1/3/4)、`client/file-upload/runtime.ts`(e2/4/5/6)、`session-query/session-log-export/controller.ts`(e1)、`ui-deliverables/present-open.ts`(e1/2)、`ui-chat/AssistantNodeView.tsx`(e0)、`ui-chat/GenericCommandCard.module.css`(e0/1)）；C15（hover 意图）经核仍绿。
- **opt-in 白名单**：+5（`voice-input-bundle`、`speech-to-text`、`speech-to-text-sensevoice`、`api-speech-to-text`、`client-ui-voice-input`）/ −1（`agent-team-web-profile`，npm 只到 0.1.6-alpha.2）。
- **Session 持久化**：jsonl 文件名/迁移暂存/租约语法 0.1.5→0.1.7 逐字未变；0.1.7 新增 V4 的行准入/关系校验 → archive-cleanup 只需重锚注释与 V4 语义映射。

## 16. 0.1.7-alpha.1 → alpha.2 增量与指南复核（2026-09-22 晚）

> **本节口径为 alpha.2（历史）**：目标已由 §20 重钉为 `dsh-v0.1.7-rc.2`；rc.1 对本节的修订见 §20 表。

**一句话**：alpha.2 对 chamber 的**兼容性影响 = 只多一条 remote（C4 21→22）**；其余 §15 锚点逐字未变；另有一批随 vendor 树免费到手的会话/聊天/spill/模块系统修复，以及一条可选采纳的「崩溃报告」能力（见 §18）。

规模与口径：162 commits、869 文件、+21355 / −11052；`npm view @deepseek-ai/dsh@0.1.7-alpha.2` 已发布；**C10 该钉 `0.1.7-alpha.2`**（gitlink `00102833dfaee1da9f48a3a8eae9d34005a75218`），alpha.1 只是上一目标。注意 alpha.2 把运行时依赖范围改成精确版本（dsh 面 `workspace:*` → `0.1.7-alpha.2`；cordis `~4.0.4`、schemastery `~3.18.4`），锁文件必须 `--refresh-lockfile`。

### 16.1 锚点复核（§15 用）

| 锚点 | alpha.1 | alpha.2 | 指南处置 |
|---|---|---|---|
| remote 装配 | 21 | **22**（新增 `pluginRegistryProbeRemote` = `@deepseek-ai/dsh-client-ui-plugin-manager/remote`，import #10 / mount #10） | **已就地更新 §5.1 H4 与 §15.1（rc.1 为 22 条两表；rc.2 再改 23，见 §20.2）** |
| ui-primitives 图标 | 77 个 `*OutlineRegular`，无 monitor | **零 diff** | §15.2 的「`IconMonitorOutline16` 保持自绘」继续成立 |
| `config-form.ts` | `ConfigForms` / `get(entryId)` | **零 diff** | §15.3 不变 |
| `shell.leading` / `AppFrame` 挂载门 / `HeaderLeadingControls` | — | **零 diff** | §15.4 不变；路径事实：座声明在 `ui-layout/src/client/index.ts`（该包无 `contract/slots.ts`），badge 座声明在 `ui-sidebar/src/client/contract/slots.ts` |
| `apps/cli/package.json` deps | 80 条（含 voice-input、agent-team-profile） | **80 条同名**，仅 range 变 | C11 白名单 +5/−1 结论不变 |
| `scripts/primary-runtime/lock.json` | python 3.12.14/20260901、`81a359f1…` | **逐字节相同** | §15.5 不变 |
| fork 面（connection/web/api-gateway/open-in-app/ui-sidebar/ui-layout） | — | **无需重放的源码 diff**（web 仅 `boot-client.ts`(+14) 且我们 dropped；api-gateway 共 7 文件：host 半 `src/index.ts`(+62)、README/package.json/tests/tsconfig.host.json，**client 半源码零改动**，且我们 dropped host 半；ui-layout 仅 `theme-presenter.ts` 注释） | fork 只同步 package.json 版本行/range |
| C9（vendor 补丁锚） | 14/28 | **14/28，断锚集合逐条相同** | 重锚清单不变（§5.3） |
| C11（opt-in 白名单） | +5 / −1 | alpha.2 相同（9 个）；**rc.2 = +6/−1（10，+auto-review/−agent-team-web-profile）** | §5.3 按 rc.2 更新 |

### 16.2 alpha.2 里会**改变工作清单**的三件事

1. **roster 68 → 74 → 81 → 85 行**（rc.2 再 +4：+`time-context`/`schedule`（均 `disabled`）、+`shortcuts`/`ui-shortcuts`（启用）；alpha.2 增量 +9 / −2：+account-controller、agent-preset-registry、cordis-inspect-providers、job-controller、ui-settings-account/-agent-loop/-shell/-subagent/-web-search；−agent-presets、ui-settings-unarchive-sessions）（`packages/bundle/web-app/cordis.patch.yml` 的 `- id:` 计数）→ `packages/renderer/src/required-extra-rows.ts` 的审批表与 `chamber-covered.ts` 必须按 alpha.2 roster 重判（与 §15.3 的 `settingsScope`→`configForms` 是同一张表）。
2. **spill 配置改名**：`maxInlineBytes` → `maxInlineTokens`（`packages/spill/*` 整族）。chamber 自有代码零命中 → **无代码动作**；若任何排障文档提过旧名，改文档。
3. **fatal diagnostics & crash reports**（上游同批四件事）：`installFailLoud` 接管 `uncaughtException`+`unhandledRejection`（Host 面，随 pin 免费到手）；spill 全 best-effort（`SpillOptions.onFailure`）；`apps/desktop` 每次 fatal 先写 owner-only 崩溃报告（`app.getPath(logs)`，保留 10 份，含完整 `util.inspect`、host stderr / renderer console 各 64KiB、版本与 phase）再弹框并在框内给路径；`dsh-client-modules` 对失败 batch **同 URL 重试一次** + 「加载未注册」永不复放 + 每行记录最后一次 import 失败（`ClientModuleLoader.importError`）。chamber 侧的对应动作见 §18-①（crash report 文件）与 §17-D（`boot-tolerance.ts` 文案可跟）。

### 16.3 顺带一提：0.1.5 线也有新 tag

上游新增 `dsh-v0.1.5-rc.3`（main 仍是 `0.1.5-rc.2`）。若升级排期推迟，main 可以在 0.1.5 线内先吃 rc.3；但本指南的**当时目标**是 0.1.6/0.1.7 线（`0.1.7-alpha.2`；现已重钉 rc.2，见 §20），不把 rc.3 当作中间步骤。

## 17. 0.1.5 → 0.1.7-rc.2：chamber 的兼容性改进（必做清单）

> **本节基线为 alpha.2（`00102833df`）**：C10、六锚、npm 与 `upstreamCommit` 的 rc.1/rc.2 值见 §20；C4/C9/C11/roster/图标的 rc.2 修订见 §20.2（C4=23、C9=13/28、C11=10、roster=85、图标 79）；文中的 `§17-Hx` 指 §17-A/B/C/D 表里对应的 H 行，当前锚点值见 §1.6。

这一节把「从 main 的 0.1.5 基线的视角」需要做的兼容动作按面收拢；每条都有动作、验收与证据指向。**注意与 §18 区分**：本节是「不做就坏了/丢了」，§18 是「可选变更好」。

### A. 编译 / 启动即红（9 项：H1–H9，必须同批修；rc.2 的 H10 见 §17-H10）

| # | 兼容项 | 0.1.5 现状 | 0.1.7-rc.2 目标（alpha.2 基线 + rc.1/rc.2 修订见 §20） | 必做动作 | 验收 |
|---|---|---|---|---|---|
| **H1** | 设置服务改名 | `ctx.settingsScope` + `settings-file` 包 | `ctx.configForms.get(entryId)`；`settings-file` 删除；`settings.yaml` 首启改名 `settings.yaml.imported` | 按 §15.3 站点表改生产读取（`locale-ownership.ts` 的 `bindLocaleScope`）、松散声明、settings-bridge `vendor-modules.d.ts`、两个测试的 inject 名单；重 derive 激活探针（`control-plane/src/index.ts` 播种与 `dsh-runtime/src/runtime-probes.ts`） | `typecheck` 绿；`packages/renderer` 与 settings-bridge 测试绿 |
| **H2** | 会话头 leading 座退役 | 0.1.5 **没有**该座（0.1.6 才有） | 新座 `shell.leading`（root、**无 owner 键**；仅 darwin 且侧栏折叠时挂载） | 侧栏 fork 从零注册 `shell.leading`（occupant 仍是 vendor `HeaderLeadingControls`），`vendor-modules.d.ts` 声明同步；`S-51` 用例改断言新座名 | 侧栏 visual-lock 测试绿；实机折叠时 reopen/New Session 出现 |
| **H3** | 图标改名 | 0.1.5 是 `Icon*Outline16`（47 个） | `*Outline16` 为 0、`*OutlineRegular` **79** 个（rc.2） | 按 §15.2 改 **28** 个符号：21 个 `*Outline16`（chamber 源 16 个文件，含 **5 个** `vendor-modules.d.ts` 与提交产物）+ **7 个非 16 尺寸族**（见 §15.2）；`IconMonitorOutline16` 保持自绘；**`typecheck` 不兜底**（声明仍在，运行期 undefined） | 相关包测试绿 + 实机图标无缺口 |
| **H4** | remote 装配 15 → 22 | 169 行 / 15 namespace | 195 行 / **23**（rc.2；import 序 ≠ mount 序，差异 6 处） | 按 §15.1 两表重建 `typert-remote-contract.mjs`；同步 `host-tsconfig` 缓存与生成面；C4 期望值改 23 | C4 与 lockstep 测试绿 |
| **H5** | gateway 客户端半双向流 | 单向 `open()`、`INTERNAL_BASE` 模块函数 | `RemoteStreamHandle`/`ClientUplinkQueue`/item/end 帧、`document.baseURI` 回落 | rebase chamber fork 的 `stream-client.ts`/`client/index.ts`（uplink + basePath 前缀自己补）；`stream-protocol.ts`/`remote-error-codes.ts` 直接照抄并**补 alpha.2 新增的 `gateway/protocol`、`gateway/uplink-overflow` 两码** | gateway/connection 包测试绿 |
| **H6** | connection `rpc.ts` 相对路由 + 二进制 | `INTERNAL_BASE`+`resolveBase()`、`?fixture`、单向流 | document-relative route、multipart 二进制、`RpcStreamOpen(...,uplink?)`、`fixture.ts` 删除 | 采纳新 `rpc.ts`（basePath 由 carrier/`RpcFetch` 注入）；`carrier-assembly` 保持 `streamBaseUrl` 钩子 | connection 包测试 + 端到端冒烟绿 |
| **H7** | **`settings.launcher` 新座（指南此前漏项）** | 0.1.5 无该座 | 新槽（`ui-settings` 声明、`SettingsRoot.tsx` 唯一渲染点、owner props `{wide, openSettings, openOnboarding}`）；0.1.7 新包 `ui-settings-account` 的账号菜单/Sign out **只在这里** | chamber 的设置壳 shadow 了官方 `SettingsRoot` → **必须在壳里渲染来源自己的 `settings.launcher`**：trigger 行渲染 single 座，`openSettings` 接壳的 open 状态、`openOnboarding` 接壳自己的 onboarding 协调器，无注册者时回落现有自绘 trigger；把该座补进「壳 chrome」枚举文档 | pin bump 后打开设置面板：账号菜单出现在 trigger 行且 Sign out 可用 （rc.2：owner props 增 `settingsOpen` 与可选 `settingsShortcut`，渲染时必须传）|
| **H8** | **plugin-inventory 结构镜像（指南此前漏项）** | 镜像按 0.1.6 形状把 `trust` 当必填 | 0.1.7 **删除** `AgentPresetPluginGroup.trust` 并新增 `meta`（包名/描述本地化） | `plugin-inventory-api.ts`：**镜像只消费 `entries`**（`trust` 字段被上游删除后不再解析；`agentPresets` 在 chamber 无渲染消费者，整段不解析或失败即忽略），不得因缺 `trust` 整单抛 `invalid preset group`；**不补 `meta`**（无渲染面）；补一条 0.1.7 形状的用例 | 该包测试绿；对 0.1.7 实例的插件读面不抛错 （rc.2：管理器类型实际在 `packages/boot/plugin-manager/src/types.ts`）|
| **H9** | **图行 URL document-relative（bump 阻断）** | `host-graph.ts` 只收 `/` 开头行 | 0.1.7 的图行 url 为文档相对 | 归一 `basePath + '/' + url`；`//`/scheme/`../` 仍拒；补回归 | 单测绿；实机官方 Plugins 页/terminal/用户插件齐全 （rc.2：`fileMediaUrl` 另接受 `dsh-app://app/`，补丁不得拒绝）|
| **H10** | **shortcuts / desktop 键盘桥（rc.2 新增，阻断级）** | chamber 的 `dshDesktop` 载体只有 `protocolVersion`/`updates`，但两 flavor 都写 `document.documentElement.dataset.platform` | rc.2 新增 `packages/client/shortcuts`：desktop 判据下 `window.dshDesktop.keyboard === undefined` ⇒ 构造即 `throw 'Desktop keyboard bridge unavailable'`；`ui-layout`/`ui-sidebar` 均 inject `shortcuts` | 两 preload（`packages/desktop/preload.cts`、`macos/Sources/DSHChamber/Resources/bridge-shim.js`）实现 `dshDesktop.keyboard`（最小空桥）或完整 `keyboard`+`shortcuts` 持久化桥（`<userData>/keybindings.json`）；Swift 侧同步 design 25 | 打包态冷启动框架/侧栏能挂载；`test:swift` + desktop 壳测试绿 |

### B. 运行时语义兼容（不红但会改变行为/判定）

| 项 | 事实 | 必做动作 |
|---|---|---|
| 会话控制器无恢复杠杆 | 0.1.7 仍无 `followCurrent`/`watched`/`ISessions.open(id)`；新增的 `refreshProjections`/Host 侧 `archived-session-gate` 不是恢复杠杆 | 沿用既有裁决：fail-closed 降级 + `FIXME(upstream-pin)` 重锚到 0.1.7；契约测试保持「断言杠杆不存在」 |
| 归档会话的**步进准入** | 0.1.7 新增 `archived-session-gate`（对已归档会话及其 subagent 血缘拒绝 `agent/pre-step`），0.1.6 宿主没有 | 零代码：在 design 24 与 STATUS 记「归档即终止 = 宿主 ≥ 0.1.7 的能力」，并把该实机验收标注为**必须在 ≥0.1.7 托管实例上跑** |
| `settings.yaml` 语义 | 0.1.7 首启导入后改名 `settings.yaml.imported` | 重 derive chamber 的播种/激活探针（H1 同批）；探针不得再把原文件存在当作活配置 |
| session 持久化 V4 | jsonl 文件名/迁移暂存/租约语法逐字未变；新增 V4 行准入/关系校验 | archive-cleanup seed 只需重锚注释与 V4 拒绝语义映射；不要引入上游迁移包（理由见 §18） |
| **会话列表水印（新增事实面）** | 0.1.7 的 `session.list` 行带 `projections.values` 的 `kind`（`sequenced`/`cached`）与 `asOfSeq`；chamber 探针已读该结构但丢掉了这两个字段 | 探针行补 `projectionKind`/`projectionAsOfSeq`，**仅当 `kind === 'sequenced'`** 才跨 L1 轮次比较（`cached` 行不可判）；据此把 STATUS ② 的 asOfSeq 对账从「需 fork 交付统计」降为「复用现有 N=2 探针」 |
| **会话契约锁的两处预期红（升级门）** | 0.1.7 删除 `updateCatalogActivity`；status mutation 变为 `{kind:'status',sessionId,running,agentAvailable:true}` | `packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts` 的两条断言按 design 14 §D4 重推（三处写→两处写），**不得把断言改绿**；同批清 `open-in` 的 jobs 测试假面（`SessionListState` 已无 `jobs`/`subagentsByParent`） |
| fatal 面变化 | Host 侧 `installFailLoud`、spill best-effort、失败 batch 重试一次 + 每行错误记录随 pin 免费到手；`apps/desktop` 的 crash report 不可复用（官方 Electron 应用） | ① 跟进 `packages/dsh-client-web/src/boot-tolerance.ts` 的旧文案（上游 audit 已带错误文本，而该文件是我们 dropped 的 `boot-client.ts` 的替代实现）；② crash report 文件见 §18-① |
| Web 重启恢复 | 0.1.7-alpha.2 把 Remote WS 门在应用就绪上（`durable web queue recovery` 收窄） | 升级后重审 chamber 的 `restart-window-reload.ts`/会话流降级臂是否可放宽（登记为评估，不默认改） |
| **`dshDesktop` 载体 presence（已裁决：保持上游）** | 0.1.7 里 `dshDesktop` 存在即激活 Desktop 账号 UI（`ui-settings-account` 以 `loginSource=desktop` 调 startSignIn），并**自动抑制 DeepSeek API key 凭证 onboarding**（`ui-settings-models`）；我方两 flavor 都暴露载体且无 `dshPlatform` | **2026-12 裁决：保持**（官方 Electron 桌面同样暴露该载体）：接受账号面激活与首启凭证抑制；S-52/design 注「presence ≠ 能力真值」；**不扩载体能力、不 fork `ui-settings-models`** | 实机验证 local/ssh/gateway 三来源登录并记录 |
| **隐私口径（已裁决：保持上游）** | chamber 只设 `DSH_TELEMETRY_DISABLED=1`（**关闭 base profile 已挂载的 `session-telemetry-otel` 行**，默认 FEEDBACK_ONLY→disabled）；上游 base profile 默认挂载 `session-log-deepseek`（canonical 会话日志后缀含消息文本/工具参数随官方请求上传） | **2026-12 裁决（不影响 chamber 功能的行为一律与上游一致）**：保持该贡献者默认启用，**不写** `disabled` patch；只修正我们自己的口径（design 02 §环境固定 + STATUS） | 口径更新；失效判据 = 上游移除该 OTel 行或新增默认上传通道时重新裁决 |

### C. 打包 / 发布兼容

| 项 | 必做动作 |
|---|---|
| 双线 pin | `update-vendor.mjs dsh-v0.1.7-rc.2`（gitlink 陷阱见 §4.1；rc.2 已发布到 npm `next`）；运行时 `bundle:dsh --force --refresh-lockfile`；**六锚 + 3 fork** 全部改 `0.1.7-rc.1`；npm 只钉 rc.1（`latest` = 0.1.5-rc.3） |
| python 载荷 | 内容照搬；`provenance.structure` 改 `vendor/harness-checkout/scripts/primary-runtime/lock.json`、`upstreamCommit` 改 rc.2 提交（`477b4f4205`）；`--require-python` 语义不变 |
| release workflow | 保留 main 的 delta updates 与发布步骤，只叠加 python 载荷与版本行（P1-5 的手工合并点；原 §12.3 清单已移除） |
| 上游 workspace 变化 | 上游 root lock 与 `pnpm-workspace.yaml` 文件本身不搬（chamber 重生成自己的 vendor 锁），但 **`patches/*` 与 `patchedDependencies` 按下一行纳入** |
| **上游 pnpm patch channel** | 上游 `pnpm-workspace.yaml` 有 7 个 patch（`patches/*`，含 node-pty 的 `DSH_NODE_PTY_SPAWN_HELPER` 与 pi-ai 流式修复；目标 pin 新增 exceljs/fortune-sheet×2/pi-ai） | 我方 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 的 `patchedDependencies` **为 0**、仓内无 `patches/` → 上游修复在我方封装态**不生效** | **2026-12 裁决：纳入**（与上游逐字一致）——`bundle-dsh` 生成 `patchedDependencies` + 携带 `patches/`；node-pty 用补丁而非 env 替代；升级 checklist 增「上游 patch 集合变化」；登记为可重锚触点 | 产物含 `patchedDependencies`；终端/流式行为与上游一致 |

### D. 门禁与契约跟进（升级后必绿）

| 门禁 | alpha.2 值 | 动作 |
|---|---|---|
| C4 | **23**（双序，rc.2） | 重建两份顺序表（§15.1） |
| C9 | 28 锚中 14 命中（14 断） | 按 §5.3 断锚清单逐条重锚（登记文件 `packages/renderer/scripts/vendor-patches.mjs`）|
| C10 | `0.1.7-rc.2`（`477b4f4205`） | 六锚 + 3 fork + gitlink |
| C11 | rc.1 = 9（+5/−1）；**rc.2 = 10（+6/−1）** | 更新 `RUNTIME_FAMILY_OPT_IN_ALLOWED` 与注释/用例 |
| roster | **68**（main 0.1.5）→ **74**（本分支 0.1.6-alpha.2）→ **81**（alpha.2）→ **85**（rc.2：+time-context/schedule（disabled）、+shortcuts/ui-shortcuts（启用），insert 段 `- id:` 计数）；增量 **+9 / −2**：+account-controller、agent-preset-registry、cordis-inspect-providers、job-controller、ui-settings-account/-agent-loop/-shell/-subagent/-web-search；−agent-presets、ui-settings-unarchive-sessions | `required-extra-rows.ts` 审批表 + `chamber-covered.ts` 按 alpha.2 重判（含删除行 `ui-settings-unarchive-sessions` 的注释与 design 24 恢复面假设）；`host-graph.ts` 降级注释同步 |
| 其它 | — | pin 字面量全仓 grep（§8）；`verify:upstream-touchpoints` 的 C1/C3/C5/C12 按新 pin 重跑 |
| **registry patches 字段** | alpha.2 上游 `patches/*`（7 条） | registry 增 `patches` 字段并登记「上游 patch 集合变化」为可重锚触点（同步 §17-C 的纳入动作） |
| **python 载荷精确集合断言** | 上游 `smoke.py` 断言 installed_names == expected ∪ {pip} | 把「精确发行版集合」断言移植进静态 `--verify`（读 dist-info 名，不执行）；执行式 smoke 见 §18.1 |

## 18. 0.1.5 → 0.1.7：chamber 可学习的改进（评估清单，**不是**兼容性必做项）

这一节回答「上游这一年做了什么值得我们变更好的事」。每条给上游证据、chamber 现状、可采纳动作、价值/代价与建议。**与 §17 的区别**：§17 是「不做就坏」，这里是「做了更好」。

| # | 能力 | 上游证据 | chamber 现状 | 建议 |
|---|---|---|---|---|
| 1 | **fatal crash report（落盘 + 框内给路径）** | `.agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md`；`apps/desktop/src/crash-report.ts`（保留 10 份、renderer console 64KiB、error 段 256KiB、落 `app.getPath(logs)`） | Electron 腿只有 console + Crashpad minidump；启动框只显示尾 8 行/1200 字符（`startup-error.ts`）；Swift 腿已有 `CrashDiagnostics.swift`（原生信号/异常 → `shell-crash.log`） | **本轮顺手（排在 §12.10 启动恢复之后接线）**：fatal（main/host/renderer/web-boot）先写 `<userData>/logs/crash-*.log`（版本+phase+完整 `util.inspect`+renderer console 尾）再弹框，框内单独一行给路径；**不违反** STATUS 的「不做页面展示」裁决（那条禁的是投影到设置页） |
| 2 | **settings 声明式配置形态（`configForms`）** | `config-form.ts`（`ConfigForms`/`whileServed`/`mutate`）；`.agents/notes/implemented/architecture/2026-09-17-settings-pages-as-companion-packages.md` | 设置壳只注册 `sidebar.settings`（shadow 官方 SettingsRoot，priority −1000）与 `settings.section`（per-source 台账）；官方 Plugins 配置页**已免费**（壳渲染来源自己 ctx 的台账与标准座） | **不采纳**：把 chamber 自持分节改成 `configForms` 等于给「attach & serve」的控制面新增对实例配置的**写权威**（C 分层冲突），跨 origin 不是障碍、信任边界才是。H7 的 `settings.launcher` 属兼容性必做（§17-H7） |
| 3 | **plugin-inventory / plugin-manager 读面数据源** | `packages/host/plugin-inventory`（只读 `pluginInventory/list`，0.1.7 加 `meta`、删 `trust`）；`plugin-manager` 写面 + 新 remote `plugin-registry-probe` | 已消费该 wire 的镜像（`plugin-inventory-api.ts`，H8 要修）；能力门 `plugin-capability.ts` 现在只看自建 seed 的 client graph | **A（必做）= H8**；**B（下轮评估）**：能力门增加 `pluginInventory/list` 数据源，让未种子/远程实例也能给出确定判词（需一条「Loader 行存在 ⇒ client half 送出」的行为断言）；**不采纳**写面（C 分层）  **（本条已被 §22.4.5 第 3 条取代：能力门不新增数据源/判据）**|
| 4 | **cordis volatile 配置引用 + loader 事件** | `docs/cordis-api/inherited.md`、`.agents/notes/implemented/architecture/2026-09-18-volatile-config-references.md`（值变化不 remount） | chamber 的 seed overlay 只渲染 `- insert:` + `id`/`name`，**不携带任何 config 值** | **不做**：volatile 无作用对象；且它要求 HMR/profile reconcile 才到 `Entry.update`，「重启生效」的既有诚实语义更值钱 |
| 5 | **remote 双向流 / 二进制传输 / `readBytes`** | `.agents/notes/.../2026-09-19-remote-duplex-stream.md`、`2026-09-17-workspace-file-binary-transfer.md`（`maxFileBytes` 32 MiB） | 控制面代理已是**形状无关流式直通**（任意方法 + WS 双向 splice + SSE，300 MiB 体量上限，mux 路径同名且已在转发名单） | **代理层不动**（无需改动）；**客户端半必做 = H5**；**下轮评估**：把上游文件级 open-in（默认应用打开/显示位置）并入 chamber 的 open-in fork + seed（design 20 目前把该面列为不做，属新面需重开裁决） |
| 6 | **`archived-session-gate` 宿主守卫** | `packages/api/session-controller/src/archived-session-gate.ts`（0.1.7-alpha.1 起） | chamber 无 pre-step 守卫；seed 只做内容清理 | **零代码采纳（登记 + 验收口径）**：归档即终止 = 宿主 ≥0.1.7 的能力；把 STATUS 的实机验收标注为必须在 ≥0.1.7 实例上跑；**不采纳**自研守卫（重复宿主能力） |
| 7 | **agent-preset 家族 + skill 模板** | `packages/preset/agent-preset(-registry)`（随包 `skills/` 模板）、`ui-agent-preset` 客户端面 | chamber 已预载/覆盖该客户端行；preset 座（`conversation.hero.agentPreset`、`settings.section#agent-presets`）都不在 chamber 的 fork 里 | **零成本随 pin 到手**；唯一动作 = C4/typert 契约里把 `dsh-agent-presets` 改名为 `dsh-agent-preset-registry` 并补新行（已并入 §15.1/H4） |
| 8 | **新包（skill-office / tool-workspace-dependencies / mcp-resources / atomic-write / workflow-ptc）** | 只有 `tool-workspace-dependencies` 是 0.1.7 新包；其余 0.1.6 已在 | chamber 自有 packages/docs 对这些零命中；`atomicWritePrivateFileNoFollow` 自带 file+parent fsync | **全部不引入**：都是宿主执行面（pin bump 免费，复刻即重复能力，违 AGENTS「never re-implements an execution surface」）；`atomic-write` 上游自述**不 fsync**，替换会丢崩溃持久性；唯一动作 = python 锁 provenance 重锚（§17-C） |
| 9 | **session-format-v4 迁移工具 / catalog-migration** | `packages/session/session-format-v3-to-v4`（0.1.7 首发的**内容级**迁移包） | seed 镜像文件名/暂存/租约语法（`binding.ts`）；`registry.json` 无 archive 条目；design 24 §11 所称「锁步测试」**实际不存在** | **不换实现**（层级不匹配：迁移包无文件名 API；常量不导出；0.1.7 首发 ⇒ 旧宿主裸 import 会加载期硬失败；0.1.7 未解锁删除面）。**本轮顺手采纳**：给镜像加**构建期门**（在 `registry.json` 注册 archive-cleanup 的宿主面 touchpoint，或加一条读 `vendor/harness-checkout/packages/session/session-persistence-jsonl/src/{format,generation,lease}.ts` 断言 4 条语法），并把 design 24 §10#8「布局知识零复制」的措辞改成与实现一致 |
| 10 | **`scripts/primary-runtime/{prepare.ts,smoke.py}`** | 0.1.7-alpha.1 新增目录；执行式 smoke（import numpy/pandas + `pip check`） | chamber 自写 `prepare-python-payload.mjs`（纯 node 内置、离线 `--verify`、fail-closed、node 归属锁步） | **不替换**（工具链契约/离线验证面/平台矩阵/node 归属/签名投放五处不同）；**下轮或顺手采纳**：在签名后的 bundle 上补一步执行式 smoke（`…/python3 -I -B -c "import numpy,pandas"` + `-m pip check`），补「结构完整但 import 失败」盲区 |
| 11 | **base.css 的 darwin 拖拽带** | `packages/client/web/src/base.css` 两条 no-drag；真正的 drag 面在 `AppFrame.module.css`/`SidebarRoot.module.css`；0.1.7 新增 `app-region-styles` 门禁 | chamber 的 `dsh-client-web/src/base.css` 与 0.1.6 逐字节相同；Swift 腿用 AppKit（WKWebView 不支持 `-webkit-app-region`） | **随 pin bump 一起做**（不是单独移植）：重拷 base.css + 同步 vendor 门禁 + 给壳层三层浮层（`session-stall-layer`/`boot-gap-layer`/`fatal-overlay`，都在 `#root` 内、无 portal）补 no-drag；同时更新 design 25 §5.0 的 E/S 对照 |
| 12 | **发布说明其它条目** | 四份 release notes（0.1.6-alpha.1/alpha.2、0.1.7-alpha.1/alpha.2）；区间新增 implemented notes 82 篇（英文 .md 口径：ddefc45 → 00102833df；含中文共 164；§22.7 记 81 篇是同区间另一计数口径，执行时不作硬判据） | 跑官方前端 ⇒ 会话滚动/分页、过程组折叠、后台命令唤醒、Web 重启重连等**多数免费到手** | **要跟的两类**：① `host-graph.ts` 降级注释 + `upstream-touchpoints.md` 登记行；② 首屏 roster 74→81→85（rc.2） 的重判（§17-D）。**无 chamber 代码**：voice input（opt-in 默认关，仅白名单同步）、spill 改名（零引用）、账号登录（H7 已覆盖入口） |

### 18.1 本轮/近期的顺手项（以方案路线图为准）

**bump 前**：① H9 图行 URL 归一（§5.1）；② 上游 pnpm patch channel 纳入（§17-C）；③ 证据采集器修正包（`shell.log` 改名、崩溃记录内容、Crashpad 统计、版本头/分享警示、DiagnosticReports 模式、`describeFatalError`、记录 `source`/`phase`）；④ python 载荷 manifest 兼容 + provenance 重锚 + 分段激活登记；⑤ `THIRD_PARTY_NOTICES` 覆盖随包载荷；⑥ i18n 门禁 glob 化 + stale sidecar 处置。

**随 bump**：见 §17、§20 与 §22.4.2（含探针水印、契约锁两红、fork 补丁重推、roster 重判、registry 镜像触点/patches 字段、载荷精确集合断言、**subagent 浏览官方面继承 + 旧代实例验收 + 死声明清理**）。

**bump 后一轮**：Electron fatal crash report 文件 + 框内路径（§18 行 1；排在 §12.10 之后）；archive-cleanup 语法镜像的构建期门（§18 行 9）；签名 bundle 上的执行式 python smoke（§18 行 10）；以及设置面统一的 P0–P3（§22.2.4）。

> **完整优化方案**：设置面统一的 7 方案裁决、诊断/引导/插件读面/会话流/更新链/载荷/工程实践/UI 的 60+ 条机会、路线图与四条已裁决决策，见本文件 §22（bump 阻断项 H9 与上游 pnpm patch channel 已并入 §5.1/§17）。

### 18.2 明确不做（含一句话理由）

| 项 | 理由 |
|---|---|
| 崩溃事实投影到设置页 / 上报 | STATUS 既有裁决（需新页面/桥面契约，与 C 分层「页面面不变」冲突）；本轮只补落盘文件 + 框内路径 |
| `disableAllPlugins`/`sanitizeProfile` | C4 既有裁决；替代动作 = 安全模式重启（已实现） |
| 把 chamber 自持设置分节改成 `configForms` | 会给控制面新增对实例配置的写权威（C 分层冲突） |
| 引入 `pluginManager` 写面 | C 分层 2026-09 用户裁决 |
| cordis volatile 热更新 | seed overlay 不携带 config 值，无作用对象 |
| 控制面/gateway 代理层为双向流做改动 | 已足够（形状无关直通 + WS splice + 300 MiB 上限） |
| 自研 archived-session pre-step 守卫 | 重复宿主原生能力（0.1.7 默认在场） |
| 自研 agent preset 配置/编辑面 | 客户端面 + skill 模板随 pin 零成本获得 |
| 引入 skill-office / mcp-resources / workflow-ptc / tool-workspace-dependencies | 宿主执行面；chamber 不运行上游 desktop-host |
| 用上游 `atomic-write` 替换 chamber 原语 | 上游自述不 fsync，替换会丢崩溃持久性 |
| 用上游迁移工具/catalog 替换 seed 语法镜像 | 层级不匹配 + 不可达 + 版本闸门（旧宿主加载期硬失败）+ 删除面未解锁 |
| 用 `prepare.ts` 替换 `prepare-python-payload.mjs` | 工具链契约/离线验证/平台矩阵/node 归属/签名投放五处不同 |
| 本轮单独移植 base.css darwin 规则 | Swift 腿 no-op；Electron 腿需随 pin bump 才有意义 |


> 与 §22.4.5 的「明确不做」是两套不同集合（此处偏升级期，方案偏整合面），互为补充；§22.4.5 里对 `tool-workspace-dependencies.parsePrimaryRuntime` 的引用只作为**格式兼容目标**，不引入该包。

## 19. 设计文档改写清单（R1–R5，2026-12）

设计语料的规则基准是 `docs/design/01-overview.md` **§6（R1–R5）**。本分支已完成/仍待如下：

| 文档 | 本轮已完成 | 仍待 |
|---|---|---|
| `01-overview.md` | §6 R1–R5 在位；**包拓扑权威表补三行**（`packages/dsh-chamber-client-core` / `dsh-chamber-wire` / `dsh-stream-state`，2026-12 补进 `AGENTS.md`「Runtime Boundaries」——设计 01 无独立拓扑表） | — |
| `13-remote-plugin-management.md` | §8（wire 单源、能力门数据源、C 分层）在位 | 按 registry 的 C14 判据措辞复核（未做） |
| `15-chamber-settings-page.md` | **§6 完整桥修订补写**（所选来源 ctx 的 `settings.section` 账本 + 渲染绑定座位 + staged 保存 + `settings.launcher` + 源模型，2026-12） | — |
| `05-connection-manager.md` | 2026-12 更新块 + 路径重定位在位；**§5/§7 设置桥正文改写为完整桥口径**（2026-12） | — |
| `25-macos-swift-native-shell.md` | 2026-12 更新块 + `shell.leading` 席位名在位；崩溃记录/采集器口径已同步（§5.4） | 隐私/载体口径已复核（2026-12 裁决：载体保持现状、隐私只更新口径入 design 02）；上游重写段落的人工合未做 |
| `06` / `14` / `20` / `24` | `sidebar/src/shared` → `dsh-chamber-client-core` 路径重定位已在位 | **已核实**：14 §D4 已是 `dsh-stream-state` 口径；06/20/24 均已含 `dsh-chamber-client-core` 落点（2026-12 核） |
| `deviations.md` | §0 R1 对齐登记纪律在位 | 逐行复核「对齐类」行（未做） |
| `02` / `09` / `11` / `17` / `18` / `19` / `21` / `22` / `23` | 02 隐私口径、11 更新相位对比已按 R1/R5 落笔（2026-12） | R3（落点/深引）与 R5（图标/remote/双向流）逐条对齐；09/17/18/19/21/22/23 未逐条复核 |

**执行口径**：上表「仍待」必须在**新分支**上、以 main 的当前版本为基线做——**不要**把本分支的旧版本文档整文件覆盖过去；只有 main 未改过的段落才可直接取本分支版本（判据：`git diff 695f67c8 origin/main -- <doc>` 为空或仅无关改动；695f67c8 = 迁移台账基线，非当前 main `745274e7`）。

## 20. 0.1.7-alpha.2 → rc.1 → rc.2 增量与目标重钉（2026-09-23/24）

> **2026-09-24 更新（上游再前进）**：上游已发 **`dsh-v0.1.7-rc.2` = `477b4f4205`**（PR #5180，2026-09-24 21:39）；`rc.1 → rc.2` = **346 commits / 3429 文件 / +136313 / −24518**，npm 已发布（`next=0.1.7-rc.2`）⇒ **双线都可钉 rc.2**。**rc.2 的专项审计与全部修订见 §20.2**（C4=23、图标 79、C9=13/28、C11=10、roster=85；新增阻断 **H10 / shortcuts 键盘桥**与 layout/sidebar fork 扩展）；下方 §20.1 是 rc.1 基线。

### 20.1 rc.1 基线（2026-09-23）

**rc.1 = `dsh-v0.1.7-rc.1` = `46a7f68b09`**（2026-09-23 21:03，PR #5073）。npm：`next=0.1.7-rc.1`（已发布）、`latest=0.1.5-rc.3`、`alpha=0.1.7-alpha.2` → **运行时线钉 rc.1**。距 alpha.2 = 156 commits / 933 文件（+13851 / −3101）；`0.1.5-rc.2 → rc.1` = **7872 文件 / +1206215 / −127437**。

rc.1 对 §15/§16/§17 的修订（逐条执行）：

| # | 位置 | 修订 |
|---|---|---|
| 1 | §15.2 / §16.1 图标 | `*OutlineRegular` **77 → 78**（rc.1 新增 `IconUsersOutlineRegular/Medium`）；FillRegular 仍 10；monitor/server/host/device 仍 0 命中 → 「`IconMonitorOutline16` 保持自绘」不变 |
| 2 | §15.1 / §17-H4 / C4 | rc.1 仍 **22**；**rc.2 起 23**（+`dsh-schedule`，import#7 / mount#8，两序差异 6 处，见 §20.2）；rc.1 只多一个 type-only 再导出 `IncompatiblePlugin`（`@deepseek-ai/dsh-plugin-manager/types`），文件 192→193 行 |
| 3 | §5.3 / §15.5 / §17-D C9 | 仍 **14/28、断锚集合相同**；但 **`ui-chat/AssistantMarkdown.tsx` 在 rc.1 又变**（改为委托本区间新增的 `fileMediaUrl`：先 `decodeURIComponent`，`base = document.baseURI`）→ 该 patch 的 5 条必须**按 rc.1 文本重新派生**（alpha.2 文本下只剩 e2 命中）；断锚清单补「文本基线 = rc.1」 |
| 4 | §17-H5 | rc.1 又改 `gateway/src/client/stream-client.ts`（+8/−2：uplink 的 `stopped` 改为每次 read 重建 + finally 清空，修「长寿命流保留已消费数据」）→ fork rebase **以 rc.1 为基线**；`stream-protocol.ts`/`remote-error-codes.ts` 零 diff |
| 5 | §17-H6 | `connection/src/client/rpc.ts` 与 `src/index.ts` 在 rc.1 **零 diff** → 仍以 alpha.2 形状为 rebase 目标 |
| 6 | §15.3 / §17-H1/H2/H7 | `config-form.ts`、`shell.leading` + AppFrame 挂载门、`sidebar.toggle.badge` rc.1 全零 diff → 站点表与 H7 结论不变 |
| 7 | §15.5 python 锁 / §17-C | `scripts/primary-runtime/lock.json` 与整目录**逐字节相同**（node 24.21.0、python 3.12.14/20260901、5 target、每 target 4 wheels） |
| 8 | §16.1 / §17-D C11 | rc.1：CLI deps 80 条名称集合不变、C11 = **9（+5/−1）**；**rc.2：deps 81（+auto-review）、C11 = 10（+6/−1）**（见 §20.2） |
| 9 | §16.2 / §17-D roster | `packages/bundle/web-app/cordis.patch.yml` 与 alpha.2 **逐字节相同**（insert 段 81 个 id）→ 74→81→**85** 的重判：rc.2 追加 `time-context`/`schedule`（`disabled`）与 `shortcuts`/`ui-shortcuts`（启用），见 §20.2 |
| 10 | 新增面（随 bump） | `tool.call.toolview` 契约扩展：owner 变相位 props（`PreparingToolCall \| StartedToolCall`）+ `hookContext`/`inject`；vendor extra row `ui-cordis` 新增 `CordisPreparingRow.tsx`。chamber 无自有注册者；registry/文档若登记该座契约，按 rc.1 形状登记 |
| 11 | 新增面（随 bump） | vendor `subagent-catalog` 的 `order` 由 `30` 改 **`-30`**；`session-stream-health-seat.ts` 的注释「vendor rows sit at -10 / 10 / 20」过期（实际 −30/−20/−10，chamber chip 为 0）→ 随 bump 改注释 |
| 12 | 新增面（随 bump） | 新增 `fileMediaUrl`（`packages/util/workspace-path`）并被 `AssistantMarkdown`/`ChatView`/`documentpreview` 采用 → 与 **H9 的 document-relative 归一同一批**处理 |
| 13 | §17-C patch channel | 7 条 `patchedDependencies` 集合不变，但 `@fortune-sheet/core`、`@fortune-sheet/react` 两个 patch **内容变了**（+46/−2、+38/−4）→ 纳入时取 **rc.1 字节** |
| 14 | §17-H8 | `plugin-manager/types` 新增 `IncompatiblePlugin`；`trust` 删除结论不变，但 rc.1 的兼容性拒绝路径成型（`app-boot/{compatibility-preflight,plugin-compatibility,profile-compatibility}`、`apps/cli/src/plugin.ts` +66/−6）→ 镜像的拒绝理由/错误面按 rc.1 复核 |
| 15 | §15.5 基线注 | §15/§16 的锚点表写作基线是 **alpha.2**；本工作树的 vendor pin 是 **0.1.6-alpha.2**（`ddefc45fbc`），从当前 pin 起跳要叠加 §17 的全部内容（**执行基线 = main 的 pin `fb2c4b9e`**；本工作树 pin `ddefc45fbc` 只用于工作树侧直达数字，见 §20.2 注） |
| 16 | 发布说明口径 | rc.1 的 release body 是 **0.1.5-rc.3 → rc.1 的聚合**（prerelease），**不能当 alpha.2→rc.1 的 delta**；真 delta = 156 commits 的主题（工具三相位/文件准备进度、图片预览、过程四档模式、gateway 双向流「已消费数据不保留」修复、插件兼容性预检+类型化拒绝、Office 随包、Excel 手势、子智能体术语） |

> **subagent 浏览**：上游的「在侧边栏打开 Subagent 会话」面（`ui-subagent` 会话头 catalog 树 + 右栏 `subagentchat` tab + `@` 源 + 只读 composer）从 0.1.6-alpha.2 起就在官方 `ui-subagent`/`ui-sidebar-right` 里，**不在我们 fork 的 `ui-sidebar`**（rc.1 对 ui-sidebar 只有版本行）；继承动作见 §18.1、§22.3.8 与 design 06 §4.7；官方形态 = 会话头 catalog + **右侧栏** `subagentchat`（官方左栏不显示 subagent 会话），**chamber 裁决不在左栏新增呈现（2026-12）**。

### 20.2 rc.1 → rc.2 增量（2026-09-24；346 commits / 3429 文件 / +136313 / −24518）

**发布与可钉性**：`dsh-v0.1.7-rc.2` = `477b4f4205`（PR #5180，2026-09-24 21:39）；**npm 已发布**，`dist-tags.next = 0.1.7-rc.2`（`npm view @deepseek-ai/dsh@0.1.7-rc.2 version` 可解析）⇒ **源码线与运行时线都可钉 rc.2**（rc.1 审计期间曾因未发布而无法钉，现已解除）。从当前 pin（0.1.6-alpha.2 `ddefc45fbc`）直达 rc.2 = **6783 文件 / +511548 / −135822 / 20019 commits**；`packages/**/package.json` 303 → 326（**+5 包**：`client/shortcuts`、`client/ui-shortcuts`、`llm/llm-deepseek-account`、`llm/llm-deepseek-api-key`、`util/code-language`；`llm/llm-deepseek` 拆为后两者）。
>
> **基线注**：本节「从当前 pin `ddefc45fbc` 直达 rc.2 = 20019 commits / 6783 文件」是**工作树基线**（浅克隆下 commit 计数不可比）；**新分支的执行基线是 main 的 pin `fb2c4b9e`（0.1.5-rc.2）**，其 0.1.5 视角口径见 §6 影子 preflight。

**主题**：定时任务/提醒（`ui-schedule` +20488、`schedule` +8297；roster 行默认 `disabled`）、**快捷键系统**（新 `client/shortcuts` + `ui-shortcuts`，roster **启用**）、账号/API-Key 双入口拆分（`ui-settings-account` +6214、`session.initializeDefaultModel` + 2 个新错误码）、交互原语（`MenuSurface`/`ShortcutKeys`/`useModalLayer`/focus/input-modality）、**macOS 窗口拖动契约重做**（`client/web/src/window-drag/{regions,recall}.ts` + `base.css`；`AppFrame` 删除 `data-shell-leading-band`/`ConversationMarker`）、官方桌面壳（tray/keybindings/退出确认/后台通知——chamber 不搬）、插件安装失败面修复、会话/流修复（代理对截断、atomic-write 锁接管、Windows junction）。

**锚点值锁（rc.2）**：

| 锚点 | rc.1 | **rc.2** | 动作 |
|---|---|---|---|
| C4 remote 装配 | 22 / 22 | **23 / 23**（+`@deepseek-ai/dsh-schedule`，import#7 / mount#8；两序差异 6 处） | §15.1 两表按 23 重建；`typert-remote-contract.mjs` 的 EXPECTED 19 → 23 |
| 图标 `*OutlineRegular` | 78 | **79**（+`IconArchiveOffOutlineRegular`）；FillRegular 10；monitor/server/host/device 仍 0 | §15.2/§17-H3 改 79；盘点时排除 `ui-settings-account` 的 onboarding SVG（内含 `IconBrowseOutline16` 假命中） |
| configForms / `shell.leading` / badge | 零 diff | **本面零 diff** | §15.3/§15.4 站点表照用 |
| C9 vendor patch 锚 | 14/28 | **13/28**（`ui-conversation/assembly.ts` e2 被 rc.2 的 `openTurn.set(...)` 打断） | 重锚取 rc.2 文本 |
| C11 experimental 族 | 9（+5/−1） | **10（+6/−1）**（+`dsh-experimental-auto-review`，−`agent-team-web-profile`） | §17-D 白名单 10 |
| roster insert id | 81 | **85**（+`time-context`/`schedule`（`disabled`）、+`shortcuts`/`ui-shortcuts`（启用）） | 74→81→85 重判；`chamber-covered.ts` 注释复核 |
| python 锁 | — | **逐字节相同** | 仅 provenance `upstreamCommit` → `477b4f4205` |
| upstream patches | 7 条 | 7 条同名，仅 `@fortune-sheet/core` +8/−2 | 纳入取 **rc.2 字节** |
| H5 gateway / H6 connection | rc.1 有变更 | **rc.2 零 diff** | rebase 目标仍为 rc.1 形状 |
| 座席 | — | **+2**（`sidebar.session.row.leading`/`.hover`，ui-workspace）；无退役 | 随 bump 免费；设计 06 自绘侧栏不消费则仅记录 |
| `settings.launcher` owner props | — | 增 `settingsOpen` + 可选 `settingsShortcut` | H7 渲染时传新 props |
| `fileMediaUrl` | http(s) | 接受 `dsh-app://app/` | H9 补丁不得拒绝该 scheme |

**rc.2 新增的 chamber 破坏点（bump 前必须处理）**：

- **H10 · shortcuts / desktop 键盘桥（阻断级）**：`packages/client/shortcuts` 在 `document.documentElement.dataset.platform` 已写且 `window.dshDesktop.keyboard === undefined` 时直接 `throw 'Desktop keyboard bridge unavailable'`；chamber 两 flavor 都写该 marker（`packages/desktop/preload.cts` 与 `macos/Sources/DSHChamber/Resources/bridge-shim.js`），而我们的 `dshDesktop` 载体只有 `protocolVersion`/`updates` ⇒ bump 后 Electron 与 Swift 的框架/侧栏（`ui-layout`/`ui-sidebar` 均 inject `shortcuts`）**不挂载**。动作：两 preload 实现 `dshDesktop.keyboard`（最小空桥让服务可构造）或完整 `keyboard`+`shortcuts` 持久化桥（`<userData>/keybindings.json`）；Swift 侧同步 design 25。
- **layout fork 契约（H2 扩展）**：rc.2 `LayoutController` 需第 3 参 `panelInfo`，且官方 `ui-plugin-manager`（`ctx.layout.panelInfo.subscribe`）与 `ui-open-in-app`（`getSnapshot`）消费它；我方 fork 仍是 2 参 → 运行期 throw。另 `ui-layout` 新增 `sidebar.left.toggle`（Cmd+B）命令与 `shortcut-locales.ts`，fork 替代上游 apply 后需补注册并 inject `shortcuts`。
- **sidebar fork（H2 扩展）**：`ui-sidebar` inject 增 `shortcuts`、`HeaderLeadingControls` 增 `useShortcuts`（消费 `injectProps.hooks.shortcuts`）；迁移 `shell.leading` 时必须同时提供 shortcuts catalog，否则 occupant 运行期报错。
- **client-web fork（随 bump）**：`window-drag/{regions,recall}.ts` + `boot.ts` 安装 `installWindowDragRecall` + `base.css` 拖拽规则；chamber 的 N-ctx boot 必须显式纳管（Electron macOS hiddenInset；Swift WKWebView 为 no-op）。
- **typert 生成面**：本仓 `packages/renderer/scripts/typert-remote-contract.mjs` 现硬编码 19（连 rc.1 都红）→ bump 时一次重 derive 到 23 双序。

**preflight（当前 pin → rc.2，只读预演）**：fork 面 **pure 12 / 需人工重放 12 / dropped 29**；chamber 深引变化 **191 文件**；新增上游包 25 / 移除 4；**新增 client 行 9**（shortcuts、ui-shortcuts、settings-account/-agent-loop/-shell/-subagent/-web-search、job-controller、experimental-client-ui-voice-input）；12 条重放 = `api/gateway`×3、`client/connection`×4、`client/web`×5。


## 21. 0.1.6-alpha.2 自身的残留项（并入自 todo 9，2026-12）

> 原 `docs/progress/todo/upstream-0.1.6-alpha.2-upgrade.md`（todo 9）的已完成记录已按 README 纪律移出（基线在 git 历史）；其**仍未做**的项并入本节。0.1.7 bump 时这些项要一并复判。
>
> **2026-12 收尾**：本节的开放面已折进 `docs/progress/STATUS.md`（真机/目检四项入「实机门禁」；两条裁决与已裁决不做的 5 项入「范围决策与必要取舍」）——本节保留为细节来源，状态以 STATUS 为准。：有的被 0.1.7 取代，有的随 bump 自然重做。

- **seed 自检缺包是否阻断实例（2026-12 裁决：维持只报不阻断）**：现状「只报不阻断」（design 09「本地实例的启动期自检」）；要阻断的话落点是该 check 的 `gap` 判定。0.1.7 复判：rc.1 的 `compatibility-preflight`/`profile-compatibility`（`packages/boot/app-boot`）成型后，同类判定是否由上游承担。
- **组件工厂 + local slots（推迟）**：`registerFactory`/`renderFactorySlot`/`useFactorySlot` + `SlotFactoryMap`——正是 settings 桥/面板镜像目前手写的事（用来源 ctx 的座位渲染外来组件）。触发条件：下次动 settings 桥或 `panel-source.ts`，或上游弃用现有座位约定；本轮设置面 P0–P4（§22.2）就是该触发点的候选载体。
- **跨代 profile 对账**：真实 runtime 切换时执行——`resolveBundleDir` 是 installation-first；两个 agent-team profile 包在实例官方 Plugins 页「关→开」重应用一次，由管理器按安装代重写 manifest + lock；本地 seed 的 `--patch` overlay 每次 spawn 前重算（内容哈希幂等跳过），下次重启即自愈；`ensureSeedPackage` 只容忍剪除、不允许把父目录换成符号链接。同一批处理 **`.dsh-module-fallback`**（「自动删除不做」的裁决把它挂进本对账）：切到不可变版本树时与该代 opt-in 包一起处理（整目录交给上游 profile reconcile 或按代删除），切换后核对 seed 重播。证据：STATUS 的「0.1.6 剩余实机门禁」第②条与 design 09 的 `ensureSeedPackage` 语义。0.1.7 把 runtime 线从 0.1.6 跳到 rc.2，此项随之成为切换前置。
- **官方 Plugins 页窗口内目检**：低层事实已闭环（`clientGraph/graph` 含 `ui-plugin-manager`、`listBundles` 报 200）；只差重建后应用内目检——与 §13 的 GUI 验收合并。
- **gateway 就地升级（真实 Linux 主机）**：`install-gateway.sh update` 未在真实 Linux 上验；本机隔离实例的新/旧双锚已验，裸网关四行响亮跳过是设计事实。老实例代际歪斜下的**诚实降级提示**（旧 pin 实例缺新命名空间时的文案）同批验收，记录保留在 STATUS 的 0.1.6 剩余实机门禁条。
- **0.1.6 代移动端真机抽检 + 右栏终端 tab 目检**：与 §13/§17 的实机项合并；0.1.7 代移动端随 bump 重做。
- **已裁决不做的 5 项**（`session/writer-held` 承接、`sidebar.toggle.badge` 重放、`workspace-tree` 分组认领、`.dsh-module-fallback` 自动删除、外部仓 `dsh-chamber-mcp` 的 `plugins.bundle.config` 迁移）：结论与触发条件保留在 git 历史与 design 21 §6.11/§7、design 09；本轮不变。


## 22. 上游可学习/可整合面（原 `todo/chamber-upstream-integration-opportunities.md` 全文并入；原 §0–§9 → 22.0–22.9）

> 编号说明：本节小节编号为 `22.x`（原文档 §0–§9 的映射）；升级执行部分是**本文件 §0–§21**，正文引用写作「指南 §N」；外部文档（design/checklist）保持各自编号；`§22.0-1…4` 指 §22.0 内的第 1–4 条。


> 状态：**建议稿（未执行）**。基线：chamber `v016-alpha1`（HEAD 以 `git rev-parse --short HEAD` 为准）、上游目标 `dsh-v0.1.7-rc.2`（`477b4f4205`）、main `745274e7`（`v0.3.2-beta.6`（tag 未 fetch；`git describe` = `v0.3.2-beta.5-122-g745274e7`）；架构重构后；0.1.5-rc.2 pin）。
> 本节是升级指南的**附加面**（原独立文档，2026-12 全文并入）：回答「升级之后，我们还能把哪些事做得更好/更省」；**执行顺序仍以本文件 §0–§21 为准**。

### 22.0 结论摘要

**四条「立即处理」**（不是可选项）：

1. **P0 · 图行 URL 归一（bump 阻断）**：0.1.7 把 client-module graph 的 `url` 改成 **document-relative**，而 `packages/renderer/src/host-graph.ts` 只接受以 `/` 开头的行，其余**静默丢弃**且诊断仍报 `ok`。不修：pin bump 后每个实例丢全套 profile 客户端插件（官方 Plugins 页、右栏 tab、terminal、用户插件），而能力门仍答 available（死指引）。成本 S（一个函数 + fixture + 3 处注释），**必须先于 pin bump**。
2. **潜伏正确性 · 上游 pnpm patch channel 在我方封装态不生效**：`packages/desktop/vendor/dsh/pnpm-lock.yaml` 的 `patchedDependencies` 条目为 0、仓内无 `patches/`，而上游把 `node-pty`（`DSH_NODE_PTY_SPAWN_HELPER`，注释点名 external embedded-runtime consumer）与 `@earendil-works/pi-ai`（流式工具调用 partial JSON）的修复都放在该通道；目标 pin 再新增 4 个 patch（exceljs、fortune-sheet ×2、pi-ai）。当前 pin 已是潜伏缺口。需先取证封装态（终端/流式解析）是否真失效，再把 patch channel 纳入 bundle 生成与升级腿。成本中。
3. **边界裁决 · `dshDesktop` 载体 presence 的副作用**：0.1.7 里 `dshDesktop` 存在即激活 Desktop 账号 UI（`ui-settings-account`，以 `loginSource:'desktop'` 调 `account.startSignIn`），并**自动抑制 DeepSeek API key 凭证 onboarding**（`ui-settings-models`：`credentialOnboarding && !('dshDesktop' in globalThis)`）；我方两 flavor 都暴露该载体且没有 `dshPlatform`。**2026-12 裁决：保持上游行为**（接受账号面激活与首启凭证抑制，验证三来源登录；不扩载体、不 fork 组件）。
4. **边界裁决 · 隐私口径不完整**：chamber 只用 `DSH_TELEMETRY_DISABLED=1`（只关 `session-telemetry-otel`），而上游 base profile 默认挂载 `session-log-deepseek`（默认启用，把 canonical session 日志后缀含消息文本/工具参数作为 `dsh_session_log` 随官方请求上传）。**2026-12 裁决：保持上游默认**（不写 `disabled` patch），只修正我们自己的口径（`DSH_TELEMETRY_DISABLED=1` 关闭的是 base profile **已挂载**的 `session-telemetry-otel` 行，不覆盖该贡献者）。

**设置面统一的结论**（用户直接提问）：「统一」只有两个不违既有裁决的落点——**统一渲染契约**（字段 schema/控件/密钥存在性语义）与**统一 chamber 侧的源模型**（把 chamber 全局页升格为与实例分节同构的内部 section）。**统一权威是不可行的**：上游 settings 是「实例内」体系（namespace = 该实例 profile 某 plugin entry 的 id，写落该实例 profile 的 Cordis patch），而 chamber 自持设置是「应用级」单份（`<userData>/chamber-settings.json`），两者没有合法的共享持久层（design 01 §2 P2、design 15 D3、C 分层三条裁决已把权威钉死）。推荐 **方案 5 + 6 为主干、方案 2 全面采用（上游 staged 保存语义）、方案 7 仅跟踪**（详见 §22.2；裁决以 §22.4.4 为准）。**2026-12 用户裁决（方案 A）**：设置壳**保留 chamber**（不改走官方壳），字段渲染契约用上游 `settings-form`/`configForms`，内容用各来源原生设置 + chamber 自持——即本推荐；**P4 不做**（见 §22.2.4）。

**其它面的收敛**：60+ 条机会经判据过滤后，**本轮/近期 6 项（§22.4.1）**、**随 bump 11 项（§22.4.2）**、**下轮一轮（§22.4.3）**、**明确不做 13 项（§22.4.5）**。

### 22.1 分析口径与判据

三条裁决与一条纪律是本方案的过滤器，任何与此冲突的「优化」直接否决：

| 判据 | 内容 | 出处 |
|---|---|---|
| **P2 · 配置平面按实例权威** | 控制面只透传、不融合、不做权威副本 | design 01 §2 P2 |
| **D3 · 两组永不交叉** | chamber 全局设置绝不进任何实例 dsh home；实例配置不投影到 chamber 固定入口 | design 15 §D3 |
| **C 分层** | chamber 无用户插件写面，只读面 + 能力门 | STATUS（2026-09 用户裁决） |
| **AGENTS 边界** | host-native capabilities 留在 dsh 主机与前端；控制面 attach & serve，绝不重实现执行面；凭据/连接密钥不进渲染端/日志/持久层 | AGENTS.md |

附加的工程判据：**减少自研面**（优先用上游能力）、**可回退**（单阶段单 commit）、**可登记**（新的上游依赖进 registry/anchors）、**不新增运行期依赖**。

### 22.2 设置面统一：chamber 自持设置 × 上游 configForms/settings

#### 22.2.1 两侧事实

**chamber 侧**（详见 design 05 §5/§8、design 15）：

- 设置桥以 `chamber-shell` priority `-1000` shadow `sidebar.settings`，自绘 chrome + **服务器下拉**；面板渲染**选中来源自己 boot ctx** 的 `settings.section` 台账与该 ctx 的座（`settings-source-face.ts` + `bridge-outlet.tsx`）；固定入口 `__connections`/`__general`；每来源的 `dsh-runtime`（order 31）由本包在实例 ctx 注册。
- chamber 自持设置全部在**主进程** `<userData>/chamber-settings.json`（0600 原子写、损坏保留 `*.corrupt`）：窗口关闭行为、开机自启、防休眠、退出确认、`vscodeOpenInNewWindow`、`registryOrigin`（信任锚）、通知偏好、`sessionTodo`、更新状态、dsh 运行时版本/回退；连接元数据在 `ssh-instances.json`/`catalog.json`，**连接密钥**只在主进程内存 + 0600 镜像（safeStorage 优先），渲染端只见 write-only 空输入。
- 实例事实（models/presets/plugins/locale/主题/第三方分节）权威在**该实例的 dsh home**，现状已由「渲染来源自己的台账」统一。
- 纯 UI 偏好（侧栏宽度/折叠/排序）在页面 localStorage；语言/主题留给实例。

**上游 0.1.7 侧**：

- namespace = **该实例 profile 里某个 plugin entry 的 id**；读 `ctx.remote.settings.describe`（一律 redact secrets），写 `settings.mutate` → ConfigEditor 写该实例 profile 的 Cordis patch；wire 形状 `SettingsNamespaceView{autoGenerate,ns,schema,value,base?,user?,applies,secrets[{path,set}],revision}` / `SettingsPathOpView`。
- `ctx.configForms.get(entryId)` / `whileServed(namespaces, register)`；`status` 只有 `loading|ready|unavailable`；`persistence = isLoopback ? 'host' : 'memory'`（chamber 页面是 loopback ⇒ 全来源 host 模式）。
- **可复用资产**：`packages/client/ui-primitives/src/settings-form/*`（`SettingsFormModel` + `SettingsForm`/`SettingsValueField`/`SettingsSecretField`，接受结构化 scope，官方 shell/agent-loop/subagent/web-search 四页都在用）；`SettingsSecretView{path,set}` 的 **write-only 密钥存在性**语义。
- 没有任何进程外/HTTP 路径可以注册 namespace；没有 schema 驱动的通用渲染器（上游已拒绝）。

#### 22.2.2 七个方案与裁决

| # | 方案 | 机制 | 裁决 | 关键理由 |
|---|---|---|---|---|
| 1 | chamber 变官方壳伴生包（去 shadow） | 删 shadow 注册；chamber 页面注册为实例 `settings.section` | **不做** | 丢服务器下拉与多来源设置入口；全部来源不可达时连接页不可达；N-ctx 首启门回归（隐藏壳 blank 会话会把 `settings.onboarding` 对话框冒到当前视图）；远端来源会出现「打开配置文件」（`isLoopback` 恒真）且必然在远端失败 |
| 2 | 保留壳，采用上游字段套件 | `SettingsFormModel` + `SettingsValueField/SecretField` 渲染 chamber 设置 | **采纳（全面采用上游 staged 语义）** | 标量/密钥/布尔一律用 `SettingsForm` 的编辑草稿 → Save/Discard；字段呈现/重置/只读文案与官方一致（2026-12 裁决） |
| 3 | configForms 形状的 chamber namespace | 3a 真 Host 插件 + profile entry；3b 控制面代答；3c 实例 ctx 注册页面 + 控制面数据通道 | **不做**（3a/3b）；3c 仅作方案 1 前置 | 3a 会把桌面设置写进每个实例 dsh home（发散 + 跨信任边界，远端可改桌面行为）；3b 上游无注册缝；3c 依赖方案 1 且自带同样回归 |
| 4 | 并入 dsh 设置文档 | 共享 settings 存储 | **否决** | 每实例副本必然发散；违 P2/D3；gateway store 2026-12 已裁掉 settings documents；无只读 namespace 能力（`writable` 硬编码 true） |
| 5 | **统一源模型** | 壳的数据源抽象为 `SettingsSource`：`InstanceSource`（现有 face 注册表）+ `ChamberSource`（页面级内部台账，`__connections`/`__general` 与未来 chamber 分节同构） | **推荐主干**（6–10 人日） | 零权威变化；保留固定入口的全部优点（离线可用、与选中来源无关）；全部改动落在 chamber 自研包内；台账仅内部使用，不构成新插件 API 粗估；分阶段口径见 §22.2.4|
| 6 | **统一只读展示 + 字段 schema** | chamber 内部「设置描述符」`{id,group,label,kind,value,authority,scope,writeChannel}` + 上游原语渲染；密钥用存在性语义；实例只读镜像标注权威 | **推荐**（4–7 人日） | 每个字段显式声明权威与写通道；secret 永不上行；与 design 15「控件用官方原语」一致；是方案 2/5 的粘合剂 粗估；分阶段口径见 §22.2.4|
| 7 | 设置贡献清单协议（上游议价） | 推动 `dsh.client.contributes.settings` + 最小设置面服务契约 | **仅跟踪**（原型 2–5 人日） | 只作议价/保险；2026-12 完整桥接后 chamber 已不再需要它作为前置 |

**推荐组合（2026-12 定案）**：**5 + 6 为主干**，**2 全面采用**（staged），**7 跟踪**；**1/3/4 不做**，**schema 驱动通用渲染器不做**，**为保 shadow 而 fork `ui-settings-general` 不做**（shadow 是官方支持机制）。

#### 22.2.3 分类表：哪些统一、哪些必须分开

| 类别 | 典型项 | 统一到哪里 | 权威/存储 | 写路径 |
|---|---|---|---|---|
| 连接密钥 | SSH 密码、gateway token | **只统一「存在性展示 + write-only 输入」语义** | 主进程内存 + 0600 镜像 | 单事务 IPC；永不回渲染端/日志 |
| 控制面/桌面事实 | 窗口行为、自启、防休眠、退出确认、`registryOrigin`、通知、todo、更新状态 | 统一**呈现**（描述符 + 上游字段套件） | `<userData>/chamber-settings.json` | `dsh-chamber:settings-set` IPC（乐观 overlay + 深合并） |
| 实例事实 | models/presets/plugins/locale/主题/第三方分节 | **现状即统一**：渲染来源自己 ctx 的台账与该 ctx 的座 | 该实例 dsh home / gateway | 该实例自己的 `remote.settings` |
| 连接管理事实 | 主机元数据、连接状态、插件只读清单 | chamber 专属页（`__connections`） | `ssh-instances.json`/`catalog.json`/能力门 | 控制面 REST + IPC |
| dsh 运行时 | 版本/回退/恢复 | chamber 专属分节（`dsh-runtime`，order 31） | local=主进程；gateway=`/chamber/runtime` | 主进程 / 反代 |
| 纯 UI 偏好 | 侧栏宽度/折叠/排序 | chamber 页内（localStorage） | 页面 | 页面 store |
| 语言/主题 | — | **留给实例** | 该实例 locale namespace | 该实例设置 |
| 网关部署配置 | bind/auth/TLS/CORS/publicOrigin | **不统一**（运维面） | gateway CLI/env + stateDir 凭据 | 运维 |

#### 22.2.4 迁移步骤（分阶段、可回退、不改持久化格式）

| 阶段 | 内容 | 成本 | 门禁 |
|---|---|---|---|
| **P0** | 冻结 shadow 契约与固定入口集合的测试；新增 `settings-source-model.ts`/`settings-descriptors.ts` 骨架（纯类型 + 纯函数） | 0.5–1 人日 | `run-checks static` + settings-bridge 测试/typecheck |
| **P1** | 方案 5：`__connections`/`__general` 走 `ChamberSource` 台账，壳改派发；`InstanceSource` 路径零变化 | 3–5 人日 | navigation + visual-lock |
| **P2** | 方案 6+2：字段描述符 + 上游字段套件渲染标量/密钥；`registryOrigin` 等文本字段 staged（带校验 + 响亮失败）；**布尔同样 staged**（2026-12 裁决） | 2–4 人日 | `verify:i18n` + settings 测试 |
| **P3** | 密钥存在性展示（`SettingsSecretSpec` 同形），补测试证明密钥值不可能经渲染端读回 | 1–2 人日 | 安全测试 + bridge 成员锁 |
| **P4（2026-12 裁决：不做）** | 改走官方壳（方案 1/3c）的 dev-only 实验分支；用户裁决选 **A（壳保留 chamber、契约上游、内容原生）**，本行不执行；仅在放弃自持设置/多来源桥时重开 | 8–13 人日 | — |

#### 22.2.5 设置面明确不做

1. 方案 4（并入 dsh 设置文档）；2. 方案 3a（真 namespace）；3. 方案 3b（控制面代答）；4. 方案 1（去 shadow）；5. schema 驱动通用渲染器；6. 把 `ChamberSource` 做成用户插件 API；7. 凭据进渲染端/日志/实例文档；8. 为保 shadow 而 fork `ui-settings-general`。

#### 22.2.6 设置面不确定项（需实测）

1. 官方壳在 chamber 复合入口下取消 shadow 的运行时可行性（需 dev 探针，只有走方案 1 才需要）；2. `ctx.remote.$host.isLoopback` 在 local/ssh/gateway 三源的真实值（决定 open-document 与 host/memory 模式）；3. N-ctx 下官方壳文档级对话框的冒泡与 launcher 串扰；4. `settings-form` 套件在后续 pin 的稳定性（须登记 upstream-touchpoints/anchors）；5. ~~staged vs 即时保存的产品裁决~~（已裁决：全面 staged）；6. 密钥存在性提示是否需安全评审（只展示 set 布尔）；7. Swift 腿同读 `chamber-settings.json`（`StartupSettings.swift`）与桥面 57 成员锁不得破坏；8. 旧版（<0.1.7）直连实例的官方设置写行为实测。

### 22.3 全清单（按面，已过滤既有裁决）

> 口径：只列**新面**（升级指南 §17/§18 已覆盖的 H1–H8、crash-report、pluginInventory、volatile、atomic-write、prepare.ts、base.css 拖拽带、python provenance、roster 74→81→85（rc.2）、会话 heal 降级等不重复）。"建议"取值：**本轮做 / 随 bump / 下轮 / 不做 / 裁决**。

#### 22.3.1 诊断与证据链

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| 采集器仍读改名前的 `native-shell.log`（实机两文件并存时把过期文件当证据通过） | `ShellLog.swift` `fileName="shell.log"` | `scripts/dev/collect-macos-evidence.sh` 多处；本机 logs/ 两文件并存 | 改读 `shell.log`/`shell.log.1`；旧文件标「不作证据」 | **本轮做** |
| 采集器不呈现崩溃记录内容、漏「上次异常退出」 | 上游框内点名证据文件 + 完整 inspect | 采集器只 `ls -la`；fatal 行模式无该串 | 打印 `shell-crash.log` 尾 1–3 行；模式补该串 | **本轮做** |
| Crashpad minidump 零覆盖、无保留、原始内存 | 上游本地崩溃面=可读报告文件 | `crashReporter.start`；实测 296 个 `.dmp` | 只列 count/最新/总字节 + 「不得外发」；保留策略立项 | **本轮做**（采集侧） |
| 渲染端 console 证据通道 | 上游 `console-message(error)` 有界环 64KiB | Electron 零 hook；Swift 有但打包态强制关 | Electron 加 error 级有界环；Swift 下轮 | **本轮做**（E 腿） |
| fatal 错误描述丢 `code/syscall/path/cause` | 上游 `util.inspect` depth 4 | `describeUnknownError` 只有 message/name | 新增有界 `describeFatalError`，只进本地报告 | **本轮做** |
| 启动失败面只给最后 8 行/1200 字符且不点完整日志路径（探测失败清单另有 600 字符上限 `runtime-probe-detail.ts`，与 stderr 无关） | 上游 64KiB stderr 进报告 | 完整 stderr 只在 `sidecar.log`，文案不提 | 文案追加「完整 stderr：<userData>/logs/sidecar.log」 | 下轮 |
| 记录 schema 缺 `source`/`phase` | 上游报告含 source/phase | `CrashDiagnostics` 只有 kind/name/signo/pid/version | 记录体加 `phase=startup\|running`、`source=native-shell` | **本轮做** |
| 采集器无版本/构建头、无分享警示、DiagnosticReports 模式过期 | 上游报告头 + CLI WARNING | 采集器只有 uname/sw_vers；模式仍 `DSHChamber` | 打印 bundle 版本；加警示；模式放宽 | **本轮做** |
| 写失败诚实性：记录写不进仍报「记录：<path>」 | 上游失败返回 undefined → 框内不给路径 | 无论 `logFD` 是否可用都给路径 | 区分「不可用/从未写入/为空」 | 下轮 |
| GPU/Utility 退出、renderer 终止原因只进 console | 上游 `did-fail-load`/renderer reason 进报告 | `child-process-gone`/renderer 终止只 console | 并入同一报告（不新开日志面） | 下轮 |

#### 22.3.2 引导与模块加载

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| **图行 URL 改 document-relative**（P0，见 §22.0-1） | `client/modules/src/index.ts` `comboReference=comboUrl().slice(1)`；manifest 注明 relative to the document | `host-graph.ts（图行 URL 白名单处）` 只收 `/` 开头、其余 warn+continue；诊断仍 ok | 接受两种形态，归一 `basePath + "/" + url`；`//`/scheme/`../` 仍拒；补 0.1.7 形状回归 | **随 bump（先于 bump）** |
| rev 语义换代（per-process nonce 删除，改元数据哈希） | manifest artifactRevision + README | 注释与「恢复圈」仍按 nonce 语义 | 注释随 URL 修复改；恢复圈去留单独立项 | 下轮 |
| `importError` 文案跟进（指南 §17-B 已登记，这里补范围） | `system.ts` recordingImportError；`boot-client.ts` 报 message | `boot-tolerance.ts（sweep 文案处）` 仍旧串「see console」 | 用 `modules.importError(name)?.message` 作 detail | **本轮做** |
| extra 行「加载成功但未注册/apply 失败」对 App 不可见 | 上游命名该判定并让 boot 失败 | tolerated 行仅 `console.error` | 复用既有 per-source diagnostic 通道回灌 | 下轮 |
| 上游 batch 重试语义**不可移植**到 extra 行 | `arrive()` 同 URL 重试 + 重复工厂 throw | chamber 行 `url===initialUrl`，忽略 batches | 保留；bump 记录写明「不要改成消费 batches」 | **不做**（登记） |
| renderer ambient 镜像缺 `importError` 成员 | `manifest.ts` 新增必填 `importError(id)` | `vendor-modules.d.ts` 自述漂移 tsc 不抓 | 与上一同批补可选成员 | **本轮做** |
| roster 跟进机制缺口：没有门读 pin | `cordis.patch.yml` 的 `- id:` 计数 | 审计表靠手工重跑 | 加一条读 pin 的 id 集对账门 | 下轮 |
| 共享 loader 内核死面（install seam/挂载记账/graph 缓存只写） | —（chamber 自建） | 生产消费者 0，替代者=完整桥接 | 删除或标注「无消费者」 | 下轮 |
| chamber 不 await `__DSH_BOOT_READY__`（声明性偏差） | `client/web/src/boot.ts`（0.1.6→0.1.7 零 diff） | 同步读 `__DSH_BOOT__` | 不实现；注释/registry 记「chamber 自己就是 bootstrap」 | **不做**（记录） |
| bump 预检：深引路径与 helper 仍在 | `client/manifest.ts` 仍导出 `optionalStringArray`/`stripClientSuffix`（chamber `host-graph.ts` 深引这两者），`packages/client/modules/package.json` 的 exports 0.1.6→0.1.7 未动 | — | 把「深引路径 + 两 helper + exports 不变」写进 bump 预检（否则会做无谓的 import 改写） | **随 bump** |
| extra 行永远拿不到 `importError`（防外推） | `system.ts` 只对 loader 行记录 `recordingImportError`，`row === undefined` 的行不进该记录 | chamber 的 extra 行 `row===undefined` | 记录判定：探针文案收益**不能**外推到 extra 行，那要靠 per-source diagnostic 通道 | **不做**（登记） |

#### 22.3.3 插件读面与能力门

> 2026-12 更新：main 新增 `packages/dsh-chamber-wire`，`plugin-row`/`plugin-manifest` 已是 host↔client **唯一声明**（C14）；下表的镜像类动作改为「消费 wire 面」，不要造第二份结构。

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| H8 收敛修法：镜像只消费 `entries`，**不补** `meta`/`trust` | `plugin-inventory/src/types.ts` 0.1.7 无 `trust`、新增 `meta` | `plugin-inventory-api.ts` 把 `trust` 当必填、解析整份 presets；对话框已不渲染通用插件行 | 删掉永不显示的 presets 解析（失败即忽略）；补 0.1.7 形状用例 | **本轮做**（修正 §17-H8） |
| 能力门判词在启动窗口永久停在 unknown | `web-app/cordis.patch.yml` 的 plugin-manager 行=唯一事实 | effect 依赖只有 `[officialPageSourceId]`，reloadNonce 不触发重探 | 订阅 source phase，转 serving/reloadNonce 变化时重探一次 | **本轮做** |
| `managementAvailable` 不能替代行判据 | `plugin-inventory/src/index.ts`；官方消费者 | 镜像丢弃该字段 | 不新增判据，理由写进注释/design 05 | **本轮做**（注释） |
| SSH 目标拿不到 live Loader 状态（同一代理对 `dsh-<id>` 可读 `pluginInventory/list`） | `plugin-inventory` entries/fiberPhase | 对话框只对 gateway/http 有 sourceId | 对 SSH 也 POST 合并显示（只做展示、不落盘） | 下轮 |
| `clientGraph` seed 仍必要、返回面已最小 | 上游无替代 Remote（graph 只是宿主服务） | `dsh-chamber-seed-client-graph` 只读 `clientGraph/graph` | 不动作；结论入 design 09 | **本轮做**（记录） |
| `chamber-covered.ts` 第 (2) 条理由不成立（covered 不会滤掉能力门所读的图） | 上游 roster | 注释写了该理由 | 改注释，保留理由 1/3 | 下轮 |
| `pluginRegistryProbe.fastest()` = npm 镜像延迟探测（只服务安装对话框） | `ui-plugin-manager/README.md`；唯一消费者 | chamber 无消费者（C 分层后无写面） | 不接入（连来源标注也不做） | **不做** |
| inventory wire 缺 version/层归属/受保护/注入态 | README「No layer attribution or mutation」 | 自建 `plugin-sync.ts` 的读面更宽 | 不动作；把它定位为 live 面色 | **不做**（记录） |

#### 22.3.4 会话 / 流恢复

> 2026-12 更新：main 已建 `packages/dsh-stream-state`（reducer + `tables.json` + Swift 镜像）并改写 design 14 §D4；下表的自研臂/判定先按 §22.9.1 重新判「是否改为消费 reducer」。

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| list 行已带可判别水印（`kind`+`asOfSeq`），探针收到却丢掉 | `api/session-controller/src/types.ts`；host `list.ts` | 探针读 `summary.projections.values` 但 `asOfSeq` 零引用 | 探针补 `projectionKind/projectionAsOfSeq`，仅 `sequenced` 才跨 L1 比较 | **随 bump** |
| 写回链两处上游事实变了 ⇒ vendor 锁**必然两红**（`updateCatalogActivity` 删除；status mutation 新增 `agentAvailable`） | `manager.ts` 0.1.7 | `vendor-session-fact-contract.test.ts` | 按 design 14 D4 重推锁，**不得改绿断言** | **随 bump（升级门）** |
| L1 对账臂上游未覆盖 | `connection.generation`→`refreshList` 仍下推 running | chamber 自持 `session-liveness.ts` + `session-fact-reconcile.ts` | 不改 | **保留** |
| 单飞悬挂仍是缺口 | `manager.ts` 清除点有限 | L2 不依赖 store 收敛 | 不改；维持 STATUS | **保留** |
| L2 reconnect 杠杆在，但 0.1.7 让 connection fork 必须重推 | `connection.admit()` 取代 `requestRejection`、`client/rpc.ts` +89、二进制 multipart | fork 的 `api-path.ts`/`client/rpc.ts` 等 | 按上游 diff 重推 + lockstep | **随 bump** |
| 对话流健康臂 error/churn 子臂仍必需（上游 stream carrier 逐字节相同） | `remote-stream.ts` 0.1.7 未治因 | fork patch 2 + chip churn | 保留；`stream-client.ts` 补丁重推 | **保留 + 随 bump** |
| heal 子臂在 0.1.7 仍恒不成立；发现非契约替代杠杆 `Session.resync()` | `ISessions` 仍无 `open(id)`；`resync()` 公开非契约、唯一调用者是 `configureSubagent` | probe 仍带 `FIXME(upstream-pin)` | 二选一：(a) 用 `resync()` 重推 error/loading 臂（加深非契约依赖）；(b) 删 heal 只留提示 | 下轮 |
| loading 子臂、重启窗口 reload、pending-open-queue 均无上游替代 | `openState` 仍在；无运行时客户端插件装载；无 durable 客户端队列 | chamber 三条自持 | 不改（合并登记） | **保留** |
| 控制面 jobs 面整体消失，chamber 不消费 | 0.1.7 删 `SessionControlBaseline.jobs` | 仅测试假面引用 | 升级时清测试假面 | **随 bump** |

#### 22.3.5 更新链

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| **前提纠错**：上游 0.1.7 **有**完整 electron-updater 链（coordinator/journal/schedule/error/attention/http-executor），chamber 更新链自述镜像 | `apps/desktop/src/update-*.ts`；`apps/`、`patches/` 无 Sparkle | `updater.ts`/`update-journal.ts`/`update-schedule.ts` 头注自述镜像；registry 无镜像触点 | registry 加一条「上游更新链镜像触点」；T-04 补「上游无 Sparkle，S 腿为自建」 | **本轮做**（登记） |
| 安装前准备被拒 = 可恢复（回 `ready`），失败分 `failedOperation`/准备三分类 | `apps/desktop/src/ipc.ts`、`update-coordinator.ts` | chamber 相位集无 verifying/ready，只有两分类 | **评估结论：不纳入**（2026-12）——`downloaded` ≡ 上游 `ready`；`verifying` 在 electron-updater 内无独立行为面；`failureKind` 两分类 +「重启失败保持相位 + 一次性 `restartFailureText`」已覆盖 `failedOperation`/`preparationFailure` 的决策面。决策正文入 design 11 §3.2；`technicalDetails` 留主进程 | **已评估**（记录，不改代码） |
| journal 文件卫生：schemaVersion/pid/0600/进程唯一文件名 | `apps/desktop/src/update-journal.ts` | 固定文件名、无 schemaVersion/pid | 加上三个字段与 0600/唯一名；保留自禁用 | **本轮做**（小） |
| 上游用「替换 electron-updater 传输」实现有界静默连接 | `update-http-executor.ts`；同名 env | chamber 用外部 watchdog + 忽略迟到事件 | **不替换**（私有属性注入，Electron 升级即碎）；写成 accepted deviation | **本轮做**（登记） |
| 注意力「每目标一次 + 焦点即清」的测试证据 | `update-attention.ts` | chamber 已有语义，缺测试证据 | 补测试；Notification 不接 | 下轮 |

#### 22.3.6 载荷与打包

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| **载荷消费者的上游锚点已迁移**（旧路径在目标 pin 不存在） | `scripts/primary-runtime/lock.json`、`packages/skill/tool-workspace-dependencies`、`apps/desktop-host/src/index.ts` | `prepare-python-payload.mjs` 与锁文件逐字引用已消失路径 | 重锚到上述三处 | **随 bump** |
| 我方 `runtime.json` 与唯一消费者解析器不兼容（实测四个变体） | `tool-workspace-dependencies` 的 `parsePrimaryRuntime` 要 `desktopVersion` + legacy `components.numpy/pandas` | 我方 manifest 无 `desktopVersion`；实测：as-is FAIL、+desktopVersion FAIL、+components OK | manifest 补 `desktopVersion` 与 legacy components（或改上游顶形态，保留 `format/payload` 供 `--verify`） | **随 bump** |
| 目标 pin 新增 sdk-app 激活门（未设 env 时禁用两行） | `packages/bundle/sdk-app/cordis.patch.yml` | chamber 固定 `--profile web`，全树零引用该 env | 登记「web profile 下无消费者」为有意；触发复核条件写明 | **本轮做**（登记） |
| overlay patch 写入器扩展（`config`/`disabled` 行） | app-boot `readProfilePatches` 支持任意 `PatchOptions` | `cordis-inserts.ts` 只渲染 `- insert:` + id/name | 只有出现**功能需要**（如未来 sdk profile 的 python 载荷行、gateway patch 写入器）才扩展；**隐私关闭不再需要**（2026-12 裁决保持上游） | 下轮 |
| 上游是执行式冒烟（import 检查 + Office 往返 + 精确发行版集合） | `scripts/primary-runtime/prepare.ts`/`smoke.py` | 我方只有静态 `--verify` | ①把「精确集合」断言移植进静态 `--verify`；②可选 `--execute`（仅本机目标） | ①**随 bump**；②下轮 |
| 锁坐标漂移：上游 node 24.21.0 vs 我方 24.18.1（与 sidecar pin 锁步） | `scripts/primary-runtime/lock.json` | 我方锁 24.18.1 + `PINNED_NODE_SHA256` | 升级时同批决定是否连升 node 载荷 | 下轮 |

#### 22.3.7 工程实践 / 文档

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| **上游 pnpm patch channel 在我方封装态不生效**（见 §22.0-2） | `pnpm-workspace.yaml` 7 个 patch；`patches/*` | 我方 runtime lock `patchedDependencies` = 0、无 `patches/` | 先取证 → bundle 生成 `patchedDependencies` + 携带 patches 目录（或宿主注入 env）；把「上游 patch 集合变化」列入升级 checklist | **本轮做（取证+纳入）** |
| i18n 门禁：上游有 glob 作用域 + 结构签名；我方手写 5 对 + 纯字节哈希 | `scripts/verify-translation-pairing.ts` | `verify-i18n.mjs` 手写 5 对，镜像可整段缺失而全绿 | ①glob + 排除清单 + 「新 pair 未登记即红」；②结构对等签名 | ①**本轮做**；②下轮 |
| 我方携带 6 个上游 `.i18n.yaml` sidecar，其中 4 个已 stale | 上游 sidecar 契约 | fork README 已非上游镜像 | 删除或纳入门禁重录（二选一） | **本轮做** |
| workspace range 政策（`workspace:*`/`~`，拒 caret）；我方 fork 76 处 caret | `.agents/notes/implemented/process/2026-09-22-workspace-release-ranges.md` | 6 个副本/分叉全 caret | 升级 checklist 加「按上游政策归位」+ 轻量断言 | 本轮评估 |
| `THIRD_PARTY_NOTICES` 覆盖不到随包载荷（CPython + 13 个 python 发行版 + node） | 上游生成器读 primary-runtime lock + PYTHON_METADATA，且 `--check` 是门 | 我方生成器只看 npm；CI 只查「生成物==提交」⇒ 门恒绿 | 生成器读 `primary-runtime-lock.json`，补 CPython/node 条目 | **本轮做** |
| 上游 `.agents/notes/implemented/<kind>/*` 的决策笔记格式（Problem/Decision/Consequences） | 81–82 篇新增（口径见 §20.1 第 12 行） | chamber 用 design + STATUS | 可选：新决策沿用该三段式（不改造旧文档） | 下轮 |

#### 22.3.8 UI / 交互

| 机会 | 上游证据 | chamber 现状 | 动作 | 建议 |
|---|---|---|---|---|
| `shell.leading` 座（= 指南 §17-A 的 H2）与 `HeaderLeadingControls` 契约迁移 | `ui-layout/src/client/index.ts`；`HeaderLeadingControls.tsx` props 改 `PropsRuntime<shell.leading>` | layout fork 无该座；sidebar fork 仍注册已删除槽 | fork 新增声明+挂载点并迁移注册点 | **随 bump** |
| `--dsh-frame-top-clearance` / 76px 拖拽带 / `data-animating` | `AppFrame.module.css`；`Menu/Modal.module.css`、`overlay-top-margin.ts` | fork 无这些规则；自有三浮层在 `#root` 内 | **已裁决：不采纳**（2026-12）——上游顶带服务 `#root` 之外的系统级浮层；chamber 三处自有浮层都在 `#root` 内、窗口拖拽由 Electron 壳的拖拽矩形 + `installWindowDragRecall` 负责，故顶带没有消费面（理由入 design 05 §2；`leading` 侧 `--dsh-frame-leading-clearance` 照旧计价） | **已裁决** |
| base.css 新增 darwin 菜单填充（透明窗禁 backdrop-filter） | `packages/client/web/src/base.css` 新增 40 行 | 我方副本与 0.1.6 逐字节相同 | 随 bump 同步（含菜单填充段） | **随 bump** |
| 上游 `patchedDependencies`/`patches/` 无移植路径（= §22.0-2 的 UI 面） | `patches/*` +1062 行 | 无 `patches/` | update-vendor/ensure-harness-vendor 增加 patches 记录与移植，或显式记录不移植理由 | **随 §22.0-2** |
| 两条 120Hz sweep 补丁：`GenericCommandCard` 的 `dsh-command-row-sweep` 规则被上游删除（**组件本身仍在**）、`ReasoningRow` 规则保留 | 目标 pin `GenericCommandCard.module.css` grep sweep = 0 | `vendor-patches.mjs` 两条都登记 | 退役 GenericCommandCard 条目；ReasoningRow 随 C9 重锚 | **随 bump** |
| vendor patch 目标漂移面 8/10 | ddefc45→00102833df numstat | 10 个目标文件 | bump 预排重锚预算；perf 类补丁重锚须重跑 A/B | **随 bump** |
| `dshDesktop` 载体 presence 副作用（见 §22.0-3、§22.0-4） | `ui-settings-account`、`ui-settings-models`、`ui-sidebar-browser` | 两 flavor 都暴露载体、无 `dshPlatform` | 裁决 + 验证；S-52 注释补「presence ≠ 能力真值」 | **裁决** |
| Excel/xls 预览随 runtime line 到来 | `ui-sidebar-documentpreview/excel/*`；新依赖与 CDN tarball | runtime 锁无 fortune-sheet；前端无 CSP 头 | runtime line 升级时单独验收 chunk/worker/许可 | 下轮 |
| typert Remote 生成面自动跟随新命名空间 | `api/remotes/src/client/index.ts` 新增 account/job/pluginRegistryProbe | `gen-typert-remotes.mjs` 从上游 assembly 派生 | bump 常规重跑 + 契约测试 | **随 bump** |
| registry fork 分类注释变味（仍写已删除的座名）；registry 无 patches 字段 | registry entries | 注释写 `conversation.session.header.leading` | bump 时更新文本 + 登记 patches 移植 | **随 bump** |
| **subagent 浏览官方面（rc.1 起可用）** | `ui-subagent`（座 `conversation.session.header.lineage` + `conversation.session.header.actions#subagent-catalog`（rc.1 order 由 30 改 −30）+ 右栏 `subagentchat` tab + `@` 源 + 只读 composer）；宿主 `ui-sidebar-right`（`ctx.sidebarRight`）；数据 `projectionsBySession[..].values.subagentCatalog`，刷新 `ISessions.refreshProjections` | 左栏只有计数圆环（`runningSubagents`），无 subagent 行；`ui-subagent` 在 `CHAMBER_COVERED_IDS`、`ui-sidebar-right` 是 extra row；早期调研文档的「宿主无逐项事实面」断言已过时（该 todo 已按裁决移出） | **随 bump 继承**（0 chamber 代码）：头 catalog/右栏 tab/`@` 源随附；S 级清理（删 `vendor-modules.d.ts` 死声明、registry C16/roster 复判）；**代际门**列入旧代实例验收 | 左栏呈现**已裁决不做**（2026-12：对齐官方右侧栏形态；见 design 06 §4.7 与 STATUS 范围决策） |

#### 22.3.9 CLI / 网关

| 机会 | 建议 |
|---|---|
| 上游 CLI 0.1.7 只加 `--dump-config-schema`，无 serve/remote/account 新命令 | **不做**（控制面只 attach & serve，不代管 host profile） |
| `boot/config-editor` + config-schema：chamber 无写配置面 | **不做**（保持不采纳记录同步） |

#### 22.3.10 跨面（本清单第一手复核）

| 机会 | 建议 |
|---|---|
| roster 精确增量：**+9**（account-controller、agent-preset-registry、cordis-inspect-providers、job-controller、ui-settings-account、ui-settings-agent-loop、ui-settings-shell、ui-settings-subagent、ui-settings-web-search）**−2**（agent-presets、**ui-settings-unarchive-sessions**） | **随 bump**（重判审计表 + `chamber-covered.ts` 注释 + design 24 的恢复面假设） |
| 0.1.7 新增两条 gateway 故障码 `gateway/protocol`、`gateway/uplink-overflow`；我方 fork 副本缺且无映射 | **随 bump**（并入 H5 照抄清单） |

### 22.4 路线图

#### 22.4.1 现在（pin bump **之前**，都是小改但阻断级）

| # | 事项 | 面 | 成本 | 验收 |
|---|---|---|---|---|
| 1 | **`host-graph.ts` 接受 document-relative 图行 URL**（H9） | 引导 | S | 新 fixture 回归 + 0.1.7 形状单测；bump 后实机确认官方 Plugins 页/terminal/用户插件齐全 |
| 2 | **上游 pnpm patch channel 取证并纳入封装/升级腿** | 打包 | M | 取证结论 + bundle 产物含 `patchedDependencies` 或显式「不移植」裁决；升级 checklist 增条目 |
| 3 | **证据采集器修正包**（shell.log 改名、崩溃记录内容、Crashpad 统计、版本头、分享警示、DiagnosticReports 模式、`describeFatalError`、记录 `source/phase`） | 诊断 | S | `collect-macos-evidence.sh` 在真机输出含正确文件与警示 |
| 4 | **python 载荷 manifest 兼容 + 锚点重锚 + 分段激活登记** | 载荷 | S | 上游 `parsePrimaryRuntime` 解析通过（四个变体测试）+ provenance 指向新路径 |
| 5 | **`THIRD_PARTY_NOTICES` 覆盖随包载荷** | 打包 | S | 生成器输出含 CPython/python 发行版/node 条目，`--check` 复跑一致 |
| 6 | **i18n 门禁 glob 化 + stale sidecar 处置** | 工程 | S | 新 pair 未登记即红；4 个 stale sidecar 删除或重录 |

#### 22.4.2 随 bump（升级腿的一部分）

| # | 事项 | 关联 |
|---|---|---|
| 1 | `importError` 文案 + ambient 镜像成员 | §22.3.2 |
| 2 | 探针补 `projectionKind/projectionAsOfSeq` | §22.3.4 |
| 3 | vendor 契约锁预期的两红按 design 14 D4 重推；清 jobs 测试假面 | §22.3.4 |
| 4 | connection fork（`api-path.ts`/`client/rpc.ts`）+ gateway `stream-client.ts` 补丁重推；补两条 gateway 故障码 | §22.3.4、§22.3.10 |
| 5 | `shell.leading` 座、base.css 菜单填充、vendor-patches 两条 sweep 与 8/10 漂移重锚 | §22.3.8 |
| 6 | roster 重判（+9/−2；rc.2 再 +4，见 §20.2）+ `chamber-covered.ts` 注释 + design 24 恢复面假设 | §22.3.10 |
| 7 | registry 镜像触点登记 + patches 字段 + fork 注释更新 | §22.3.5、§22.3.8 |
| 8 | payload 执行式「精确集合」断言进静态 `--verify` | §22.3.6 |
| 9 | subagent 浏览官方面继承（`ui-subagent` 头 catalog + 右栏 `subagentchat`）+ 代际验收 + 删 `vendor-modules.d.ts` 死声明 + registry C16/roster 复判 | §22.3.8 |
| 10 | bump 期文本复核：`STATUS.md` 的 `settingsScope` 行（locale/ui-theme 首屏）、`deviations.md` 的 S-51/D16、`upstream-touchpoints.md` 的旧座名 — 随 bump 改成 `configForms`/`shell.leading` | 本节 |
| 11 | open-in 官方行生效 + 严格超集复验：`chamber-covered.ts` 移除 `@deepseek-ai/dsh-client-ui-open-in-app`；座冲突复验（官方 `conversation.session.header.utilities` id `open-in-app` order −10 vs 我们的插件）；design 16/20 改写 | §22.9.3 |

#### 22.4.3 bump 之后一轮

- **设置面统一（方案 5 + 6，方案 2 全面采用 staged）**：P0 骨架 → P1 源模型 → P2 描述符/字段套件 → P3 密钥存在性（§22.2.4，共 7–12 人日）。
- **能力门重探**（source phase 转移即重探一次）；**SSH live 判词**（`pluginInventory/list` 合并展示）。
- **`Session.resync()` 二选一**（重推 heal 臂 vs 删臂只留提示）；**恢复圈去留**（rev 语义换代后重估）。
- **extra 行不可见问题**回灌 per-source diagnostic；**roster 对账门**（读 pin 的 id 集）。
- **更新链相位/failedOperation 评估**；**注意力测试证据**。
- **`dshDesktop` 与隐私裁决的落地**：载体保持现状（无需代码）；隐私侧只更新口径（无需 overlay 写入器扩展）。
- **i18n 结构对等签名**；**workspace range 政策**归位；**node 载荷 vs sidecar pin** 同批决定。
- **共享 loader 内核死面清理**；**`--dsh-frame-top-clearance` 拖拽带**决策；**Excel 预览随 runtime line 验收**。

#### 22.4.4 已裁决（2026-12 用户裁决）

> 用户裁决：「**对于不影响我们功能的，应该保持和上游的行为一致**。」以下四项据此定案（细节见 §22.7）；为 chamber 功能必须保留的偏离见 §22.8。

| # | 决策 | 裁决 | 落地动作 |
|---|---|---|---|
| 1 | 隐私口径（`session-log-deepseek`） | **保持上游默认**（不写 `disabled: true` patch）：该贡献者是上游行为，chamber 不干预 | 只修正我们自己的口径：design 02 §环境固定 + STATUS 说明「`DSH_TELEMETRY_DISABLED=1` 仅作用于 shipped profile 已挂载的 `session-telemetry-otel` 行，不覆盖 `session-log-deepseek`；观测行为与上游一致」 |
| 2 | `dshDesktop` 载体 presence | **保持上游行为**（官方 Electron 桌面同样暴露该载体）：账号面激活、首启 API-key 凭证步骤被抑制 | S-52/design 注「载体 presence ≠ 能力真值」；实机验证 local/ssh/gateway 三来源的账号登录；**不扩载体能力、不 fork `ui-settings-models`** |
| 3 | 设置保存语义 | **采用上游 staged 语义**（`SettingsForm`：编辑草稿 → Save/Discard，离开丢弃） | 设置面方案 2 从「选择性采纳」改为「全面采用」；字段呈现/重置/只读文案与官方一致 |
| 4 | 上游 pnpm patch channel | **纳入**（与上游逐字一致） | `bundle-dsh` 生成 `patchedDependencies` + 携带 `patches/`；node-pty 用补丁而非 env 替代；升级 checklist 增「上游 patch 集合变化」；登记为可重锚触点 |

> 唯一保留的偏离 = **chamber 自身功能需要**（N-ctx 壳、代理、设置壳多来源下拉、双 flavor、更新链、崩溃诊断、安全模式、python 载荷、只读插件面等，见 §22.8.2）。

#### 22.4.5 明确不做（13 条，含理由；与指南 §18.2 是两套互补集合）

| 项 | 理由 |
|---|---|
| 用上游 `arrive()`/`batches` 统一 extra 行装载 | 批脚本必然混入已覆盖 id，`register()` 重复即 throw，每次 boot 必炸 |
| 删自建 sweep/probe 改调 `assertEntriesActive` | 它只看 `loader.entries()`，而 composite 首屏是直接 `ctx.plugin()` 的子纤维；且缺 toleratedIds/reportFatal 两轴 |
| 用 `pluginInventory/list` 的 entries/`managementAvailable` 当能力门数据源 | Loader 行存在 ≠ client bundle 可服务；更弱谓词会让 available 变猜测 |
| 接入 `pluginRegistryProbe.fastest()` 做「最快安装源」展示 | 无安装流程消费者；会让宿主对公网探测并把宿主网络拓扑当 chamber 事实 |
| 在插件对话框渲染 `meta`（title/description/icon） | 对话框已不渲染通用插件行；正确修法是镜像只消费 `entries` |
| 实现 `dshDesktop.browser`/`<webview>` | 新增执行面，超出「attach & serve」；web iframe 回退已可用 |
| 引入 `configForms`/`config-editor` 的 chamber 写面 | 会给控制面新增对实例配置的写权威（C 分层冲突） |
| 把 Excel/文档预览收进 chamber 自建构建 | 一批新运行时依赖 + CDN tarball + 上千行补丁的许可/供应链面；随 runtime line 即可 |
| 用 `refreshProjections`/`resync()` 替代 L1 探针、把 `agentAvailable` 当能力门 | 投影不含 running；`resync()` 非契约且需观感裁决；`agentAvailable` 与同帧 running 同源 |
| 整套移植上游 update 相位/`technicalDetails`、注入 `httpExecutor` 私有字段、给 journal 加事件流、实现强制更新 | 会撕开已锁定的投影与两 flavor 相位裁剪；私有属性注入升级即碎；强制更新已裁决不再提 |
| crash 事实投影到设置页/上报、minidump 进证据包或外发、改用 `app.getPath(logs)` 第三日志树、用上游 `prepare.ts` 替换我方脚本 | 破坏「本地/owner-only/仅致命框时写」的 carve-out；制造第三日志树；引入 desktop 载体形状 |
| 新增 CLI 的 account/remote/config 命令或渲染端账号/凭据面 | 上游 CLI 本就没有；凭据不进渲染端/日志/持久层是硬约束 |
| 把 `Rejected alternatives` 变成机械门禁 | AGENTS.md 明示它是 review-only；机械门只会产出形式主义 |

### 22.5 证据索引

- **设置面**：chamber `packages/dsh-chamber-client-ui-settings-bridge/**`、`packages/dsh-chamber-client-ui-settings-connections/**`、`packages/dsh-chamber-client-core/src/settings-shell.ts`、`packages/desktop/chamber-settings.ts`；上游 `packages/client/ui-settings*/**`、`packages/settings/settings/src/index.ts`、`packages/api/settings-controller/src/index.ts`、`packages/client/ui-primitives/src/settings-form/**`；决策 `.agents/notes/implemented/architecture/2026-09-17-settings-pages-as-companion-packages.md`。
- **P0 图行 URL**：上游 `packages/client/modules/src/index.ts`（comboReference）、`client/manifest.ts`（url relative to the document）、note `2026-09-14-web-document-relative-app-routes.md`；chamber `packages/renderer/src/host-graph.ts`（只收 `/` 开头）与 `test/.../host-graph.test.ts` fixture；子代理实跑探针复现（0.1.6 形态 → `/api/i/local/plugins/…`；0.1.7 形态 → 丢弃 + `dropping non-root-relative bundle url`）。
- **patch channel**：上游 `pnpm-workspace.yaml`（7 patches）、`patches/*`、`patches/node-pty@*.patch` 的 `DSH_NODE_PTY_SPAWN_HELPER` 注释；chamber `packages/desktop/vendor/dsh/pnpm-lock.yaml`（`patchedDependencies` = 0）、无 `patches/`。
- **边界裁决**：上游 `packages/client/ui-settings-account/src/client/index.ts`、`ui-settings-models/src/client/index.ts`（载体判据）、`packages/bundle/base/cordis.patch.yml`（`session-log-deepseek`）、`packages/boot/app-boot/src/profile-context.ts`（telemetry patch 只关 OTel）、`packages/bundle/base/README.md`；chamber `packages/desktop/preload.cts`、`macos/.../bridge-shim.js`、`packages/control-plane/src/spawn-dsh.ts`（只设 `DSH_TELEMETRY_DISABLED`）。
- **其余面**：见 §22.3 每行「上游证据」列；各条的命令行证据已内联在表格里（工作过程报告不入库）。

### 22.6 与升级指南的关系

- 指南 §17 是「不做就坏」的兼容清单；本节 §22.3 中标注 **随 bump** 的条目应并入该清单（本节已把 **H9 图行 URL** 与 patch channel 两条同步进去）。
- 指南 §18 是「可学习」评估清单；本节是它的展开与裁决版：§22.4.1/§22.4.2 替换 §18.1 的「本轮顺手 6 项」，§22.4.4 的 4 条裁决升级为显式待办。
- 本节一旦落地执行，按仓库纪律：仍未完成项进 `STATUS.md`，实现后的基线进 git/`CHANGELOG`，不在本节保留「已完成」叙述。

### 22.7 四条决策的详细说明与裁决

#### 22.7.1 隐私口径：`session-log-deepseek` 是否关闭

**事实**：上游 base profile（`packages/bundle/base/cordis.patch.yml`）默认挂载 `session-log-deepseek`，其 README 写明 `enabled` 默认 true；`bundle/base/README.md` 明说「默认开启的 DeepSeek session-log contributor 仍是独立请求路径」。它把 canonical session 日志的**后缀**（含消息文本与工具参数）作为 `dsh_session_log` 随 DeepSeek 官方请求上传。`DSH_TELEMETRY_DISABLED=1` 只让 `app-boot` 生成 `session-telemetry-otel` 的 disable patch（`profile-context.ts` 的 `TELEMETRY_ROW_ID` + `resolveTelemetryPatch`），**不覆盖** `session-log-deepseek`；`host-product-telemetry-otel` 是另一个包、shipped profile 不挂载，与本裁决无关。

**chamber 现状**：`packages/control-plane/src/spawn-dsh.ts` 只设 `DSH_TELEMETRY_DISABLED=1`，gateway 同源，design 02 的隐私口径也按「已禁用遥测」表述 → **口径与实际不符**。

**影响面**：local 实例＝数据从用户机器发出；SSH 实例＝数据从**远端主机**发出（远端 owner 的合规面）；gateway＝同源。

**选项**：

| 选项 | 做法 | 成本 | 代价/风险 |
|---|---|---|---|
| A 关闭（**已被否**，见下方裁决：保持上游默认 B） | 在 chamber 的 profile overlay 写 `- id: session-log-deepseek / disabled: true` | 需扩展 overlay 写入器（目前只渲染 `- insert:` + id/name，不支持 `disabled`/`config`）；写入器扩展**同时解锁** sdk-app 的 python 载荷行与未来的 gateway patch 写入器 | 上游若改名/合并该行，需要重锚（登记为 touchpoint）；关闭官方日志贡献可能影响官方支持的诊断能力 |
| B 保持 + 改文档承认 | 更新 design 02 口径，明说会话日志后缀仍随官方请求上传 | 0 | 产品承诺与用户预期不一致；企业/隐私敏感用户不可接受 |
| C 默认关闭 + 开关 | A 的写入器扩展 + chamber 设置页一个布尔（需设置面方案 5/6 落地） | 中 | 写入器已扩展后增量很小；开关语义按 §22.7.3 裁决 |

**裁决（2026-12）**：**保持上游默认**（B）——不写 `disabled` patch，只修正口径；`DSH_TELEMETRY_DISABLED=1` 关闭的是 base profile 已挂载的 `session-telemetry-otel` 行。


#### 22.7.2 `dshDesktop` 载体 presence

**事实**：`dshDesktop` 是 chamber 给官方前端注入的载体（Electron `preload.cts`、Swift `bridge-shim.js`），`protocolVersion: 1`，只带 `updates`。上游 0.1.7 用它做多个 Desktop-only 判据：

- `ui-settings-account`：`apply` 首行 `if (!('dshDesktop' in globalThis)) return` → 在 chamber 里**被激活**；登录走 `ctx.remote.account.startSignIn(locale, callbackOrigin, 'desktop')`，`callbackOrigin` 取 `__DSH_TRANSPORT__.streamBaseUrl` 的 origin 或 `window.location.origin`（即经我方代理的实例 origin）。
- `ui-settings-models`：`credentialOnboarding = configured.credentialOnboarding && !('dshDesktop' in globalThis)` → 首启的 **API key 凭证步骤被自动抑制**（上游 README 明说这是 Electron preload 标记的效果，且 host 配置只能再关不能重开）。
- `ui-sidebar-browser` 需要 `carrier.browser`（我们没有 → 回落 iframe）；`ui-settings-general` 用 `carrier.protocolVersion === 1 ? updates : …`（我们正常）。

**影响**：账号面被点亮但 chamber 没有 `dshPlatform` 内嵌腿——`loginSource: 'desktop'` 在「实例经代理 + 浏览器回调到本地 loopback origin」下的可用性**需实测**（SSH 远端尤其：回调 origin 可回，但账号落在远端实例的凭据存储里）。API-key onboarding 被抑制：用户不会在首启看到输入步骤（models 设置页仍可配置，需实测确认）。

**选项**：(a) **接受账号面并验证**（保持载体；文档写清 onboarding 变化；若 desktop 登录在代理下不可用，补偿为引导到 models 设置页）；(b) 不暴露载体——与 S-52 折叠徽标冲突（`updates` 是官方徽标的数据源），不可取；(c) 扩载体能力（`browser`/`dshPlatform`）——新增 webview/IPC 执行面，违 AGENTS 边界，**不做**；(d) fork `ui-settings-models` 关掉抑制——违复用纪律，不做。


**裁决（2026-12）**：**保持上游行为**——接受账号面激活与首启 API-key 凭证抑制；实机验证三来源登录；不扩载体能力、不 fork 组件。

#### 22.7.3 设置布尔开关的保存语义

**现状**：chamber 设置页的开关是**乐观即时保存**（点击立刻本地生效 + IPC 写入；`settings-store.ts` 头注写明这是闪烁修复的产物）。上游伴生页一律用 `SettingsForm`（staged：编辑草稿 → Save/Discard，离开丢弃；`unavailable/readOnly` 文案由页面提供）。

**影响**：全面 staged ⇒ 自启/防休眠/退出确认等开关变成「点保存才生效」，与官方设置页一致；chamber 的 IPC 没有 revision 栅栏（last-write-wins + 深合并），staged 可减少中途半写；Swift 腿同读 `chamber-settings.json`，**两种语义都不影响文件格式**。

**选项**：A **混合**（布尔即时、需要校验的文本/路径字段 staged）——**未采用**（见裁决）；B 全面 staged——最一致但要改手感；C 全即时 + 只用上游控件渲染——一致性与官方最远。


**裁决（2026-12）**：**采用上游 staged 语义**（`SettingsForm` 的 Save/Discard），字段呈现与官方一致。

#### 22.7.4 上游 pnpm patch channel 是否纳入

**事实**：上游用 `patchedDependencies`（0.1.6 3 个 → 0.1.7 **7 个**）。与我方运行期相关的是：

- `node-pty@1.2.0-beta.15`：spawn-helper 定位改为「优先 `DSH_NODE_PTY_SPAWN_HELPER`，否则 `process.execPath + '-spawn-helper'`」，补丁注释点名 **external embedded-runtime consumer**（正对应我们这种嵌入式 runtime）。
- `@earendil-works/pi-ai@0.85.1`：删除多个 provider 流式增量中的 `block.arguments = parseStreamingJson(...)`（避免流式解析 partial JSON 的开销/异常）。
- 目标 pin 新增 `@earendil-works/pi-ai`（补丁化）、`exceljs@4.4.0`、`@fortune-sheet/core+react@1.0.4`（Excel 预览，随 runtime line）。

**chamber 现状**：`bundle-dsh.mjs` 以 hoisted linker 生成工作区并安装，lock 提交在 `packages/desktop/vendor/dsh/pnpm-lock.yaml`；该 lock 的 `patchedDependencies` = **0**、仓内无 `patches/` ⇒ 上游修复在封装态不生效（当前 pin 已如此）。`node-pty` 与 `@earendil-works/pi-ai` **都在**我方 runtime lock 里（经 `dsh-llm-pi-ai` 与终端功能使用）。

**选项**：

| 选项 | 做法 | 成本 | 说明 |
|---|---|---|---|
| (a) 纳入 patch channel | bundle 时把 `patches/` 拷入工作区 + 在生成的 workspace/lock 声明 `patchedDependencies`；升级 checklist 加「上游 patch 集合变化」 | 中 | 与上游逐字一致；patch 文件需随版本锁定/重取 |
| (b) 等价替代 | node-pty 不改包：spawn dsh 时注入 `DSH_NODE_PTY_SPAWN_HELPER`（指向 runtime 树的 helper）；pi-ai 无 env 等价物（要么补丁要么接受） | 小 | 只解决一条；仍需登记另一条的影响 |
| (c) 有影响才移植 | 先取证：① `pty.node` 与 `spawn-helper` 在打包 runtime 树里是否同目录（同目录则旧逻辑可用）；② pi-ai 流式解析在我方使用中是否实际触发问题 | 小（取证） | 只在确有影响时做 (a)/(b)，否则在 registry 记录「已核实无影响」 |



**裁决（2026-12）**：**纳入**——`bundle-dsh` 生成 `patchedDependencies` + 携带 `patches/`；node-pty 用补丁而非 env 替代；登记「上游 patch 集合」为可重锚触点。

### 22.8 行为对齐原则与偏离分类（2026-12 用户裁决）

**原则**：凡不影响 chamber 自身功能的差异，一律与上游行为一致；只有为 chamber 功能必须的偏离才保留，且必须登记理由与证据。

#### 22.8.1 按此原则「对齐」的项（原「可选/评估」状态升级为「对齐」）

- **随 bump**：`shell.leading` 座、base.css（含透明窗菜单填充段）、`--dsh-frame-top-clearance`/拖拽带、vendor-patch 重锚（含退役上游已删的 sweep 条目）、roster 重判（+9/−2）、typert 生成面、registry fork 注释、payload provenance 与 manifest 兼容。
- **本轮/近期**：上游 pnpm patch channel（§22.4.4-4）、`importError` 文案、journal 的 `schemaVersion`/`pid`/0600/唯一文件名、`THIRD_PARTY_NOTICES` 覆盖随包载荷、i18n 门禁形态（glob + 结构签名）、测试假面清理、session 探针的 `kind/asOfSeq` 事实面。
- **下轮**：更新相位与 `failedOperation` 语义、registry 的「上游更新链镜像触点」登记、workspace range 政策（`workspace:*`/`~`）。

#### 22.8.2 为 chamber 功能而保留的偏离（登记，不因原则取消）

N-ctx 复合壳与 per-entry basePath 桥；控制面反向代理与鉴权边界；双 flavor（Swift 权威）；设置壳的多来源服务器下拉与固定入口（`__connections`/`__general`）；chamber 自持设置存储（`chamber-settings.json`）；更新链（Electron + Sparkle 双腿）；原生崩溃诊断（`CrashDiagnostics.swift`）；安全模式；python 载荷；插件只读面与能力门（C 分层）；`host-graph` 的 extra 行预载与容忍通道；会话流健康臂（上游未治因）；重启窗口 reload 与 pending-open 队列；chamber 磁盘锁与 userData 根；`dshDesktop` 载体本身（S-52 徽标的数据源）。

#### 22.8.3 待复核（原则不直接判定）

1. 三来源（local/ssh/gateway）的账号登录可用性（`loginSource: desktop` 经代理）；2. 若上游某 profile 开始挂载 `session-telemetry-otel`，`DSH_TELEMETRY_DISABLED` 的取舍需重新裁决；3. `Session.resync()` 非契约杠杆是否接入；4. 拖拽带与壳层三浮层的 no-drag 交互。



### 22.9 main 架构重构（2026-12）后的重新判定

main 在 2026-12 前进 **88 提交 / 1390 文件**（`695f67c8` → `745274e7`；其中架构重构 merge = `38f970f3`，即 87 提交 / 1389 文件），把一批本方案「下轮评估」的东西**自己落地了**，同时收紧了新代码的落点规则。执行本方案前先按本节重新判定，避免重复实现或写错位置。

#### 22.9.1 main 已自落的可学习面（原「下轮」项 → 改为「消费 main」）

| 原机会项 | main 的落地 | 本方案的新动作 |
|---|---|---|
| 会话/流的载波与加宽账本、静默判定、阶梯（§22.3.4 多行） | 新包 `packages/dsh-stream-state`：纯 TS reducer 唯一所有者 + `tables.json` 阈值单一来源 + Swift 镜像；`verify:ladder-table-parity`、`verify:stream-state-swift-parity`、`verify:upstream-lifecycle-contract` 三门；design 14 §D4 已改写为该口径 | 先判定 chamber 自研健康臂（`session-stream-health*`）还剩多少独立面：能消费 reducer 输出的部分改为消费；`heal` 子臂的「上游无期限」前提由 `verify:upstream-lifecycle-contract` 钉住 |
| 插件行/清单的双份声明（§22.3.3 H8 相关） | 新包 `packages/dsh-chamber-wire`：`plugin-manifest`/`plugin-row`/`runtime-status` 是 host↔client 唯一声明；C14 点名 control-plane/client-core/preload/renderer/settings-connections 只引用不重声明 | H8 的「镜像只消费 `entries`」要改成**消费 wire 面**，不要再造第二份结构镜像 |
| 共享客户端核心的落点混乱（§22.2/§22.3 多处） | 新包 `packages/dsh-chamber-client-core`：旧 `sidebar/src/shared` 的 41/43 文件提升而来；`verify:package-boundaries`（A 禁跨包相对 import、B exports 白名单） | 新增/移植的共享代码落 client-core 并用命名 exports 面；不要跨包相对 import（门会红） |
| 入口面的死代码（§22.4.1-⑥ i18n、§22.4.2 若干） | `verify:no-dead-exports`（每个入口面必须有生产消费方）；`verify:artifact-freshness`（四类产物陈旧即红） | 移植 `plugin-capability.ts` 等新入口面时必须同时落地真实使用点；产物类门让「忘记重建生成物」变成红灯 |
| 阈值/状态的校准与取证（§22.3.4） | `docs/checklists/session-authority-calibration.md`（真机校准清单）、`dsh-stream-state/scripts`（差分回放器 + `DIVERGENCE.md`） | 校准类真机项直接并入该清单体系，不另建 |

#### 22.9.2 落点与登记规则（新代码必须遵守）

1. **代码落点**：共享客户端代码 → `dsh-chamber-client-core`；host↔client 契约 → `dsh-chamber-wire`；会话/流状态算法 → `dsh-stream-state`（阈值只写 `tables.json`）；不要再写 `sidebar/src/shared/`（该目录在 main 已不存在）。
2. **边界门**：生产源禁止跨包相对 import（含 type import）；`exports` 面显式白名单、不许 `*`；vendor 深引只能走 `registry.json` 的 `vendorSourceConsumers`（C16）登记。
3. **registry**：判据 C1–**C16**；`chamberNamedForks` 在 main 已含 `packages/dsh-chamber-client-ui-layout`（登记为 `seed.dsh-chamber-client-ui-layout`）——**不要**再新增 `fork.` 版 layout 条目，改为收敛到 main 的 seed 条目；只有 `packages/dsh-chamber-client-ui-sidebar` 需要新登记。
4. **冲突面**：分支侧 M 187（对旧 main 76 干净 / 106 冲突 / 391 块；对 **新 main `267272b0`**：**61 干净 / 121 冲突 / 486 块**，§1.8.1），原取件表的 70 条路径里 25 条冲突（136 块；原表已移除）；详见本文件 §1.5（原 §12.4/§12.5 清单已移除）。
5. **main 删除的文件/路径 = 重定位，不加回**：`82df4c47..origin/main` 删了 71 个文件，与分支改动的交集 5 个（4 个测试 + 双方都删的 fixture）——按 R2 把我们的改动搬到（原 §12.5 清单已移除） main 的替代落点（`chamber-lock.test.ts`、`plugin-sync.test.ts`、`test/transport/*`），或只保留「删除写面断言」这一删除动作本身；引用 `sidebar/src/shared/...` 的 10 个文件在合并时保留 main 的 `dsh-chamber-client-core` 引用。

#### 22.9.3 本方案路线图的修订

- §22.4.1（本轮 6 项）与 §22.4.2（随 bump 9 项）**不受影响**（main 未替我们落地任何一条：10/10 仍缺，`patches/` 仍未纳入）。
- §22.4.3（下轮一轮）先去掉「已由 main 自落」的项（流状态/阶梯/边界门/线格式），把「会话/流健康臂的重判」提到最前。
- 新增前置：任何新代码先过 `verify:package-boundaries` 与 `verify:no-dead-exports` 的落点/消费方检查。
- 新增（rc.1 复核）：官方 `ui-open-in-app` 已扩出文件级打开（右栏文档预览 `OpenPathAction` + `session.canOpenWorkspacePath()`；官方 catalog 含 cursor/vscodeinsiders/windsurf），而 chamber 把官方整行抑制 ⇒ 已裁决（2026-12）：**官方行生效、我们保持严格超集**（见 STATUS 范围决策与 design 20 顶部 2026-12 修订）；执行项 = `chamber-covered.ts` 移除该行 + 座冲突复验 + 实机复验。
