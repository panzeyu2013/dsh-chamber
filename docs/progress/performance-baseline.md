# Performance 基线记录（T0 实测与合成测量，P0–P2 完成态）

状态：**完成（2026-09，P0–P2 已执行；进度见 STATUS.md）**。本文档是性能整改
（T1–T6 + 卫生批）的测量锚点与决策台账——只记录数据、方法与定案，不写过程日志。

## 0. 计划与决策台账（重建记录）

已批准方案全文在会话切换中缺失；本工作树按仓库痕迹（design 05 注记 / perf 脚本 /
测量数据 / 用户消息摘要）重建执行，用户授权"按现有痕迹重建并执行"。定案编号沿用
痕迹中的 D 编号（D4–D6 未见任何痕迹，按缺号登记）；凡引用痕迹推断材料（历史会话
数据等）处就地标注出处：

| 决策 | 任务 | 定案 |
|---|---|---|
| D1 | T1 | **A**：卸几何 veil——骨架不再模仿 dsh 布局几何（rail 56 + sidebar 224 = 280px 假几何与 layout-store 持久化的真实侧栏宽失配），改全屏同底色 veil + spinner（design 05 §4 注记） |
| D2 | T5（用户闸口确认）| M1 = 主进程**事务证据刷新调度**收口：进度相位跳过全树磁盘遍历（D7），终态相位永远现场重走 |
| D3 | T6（用户闸口确认）| H3 = 主 bundle 求值长任务归因**实验**：探针 + 懒加载边界审计（不预设必改） |
| D7 | T5 | 终态一次：downloading/installing/applying 相位复用最近完整磁盘投影（D8 节流器之上再砍事务中间步全树遍历）；终态/content 相位（idle/pending/failed/error/rollback/applied 等）与无相位调用一律 coalescer 完整刷新 |
| D8 | T3 | 组合方案：**异步分批单遍遍历 + 节流/单飞/终态一次**（`runtimeDiskSummaryAsync` + `createCoalescedRefresher`，跨 desktop/gateway 两 owner 同一原语） |

T2（键控单槽合并）、T4（置顶写回防抖）语义由代码注释/设计注记钉死（view-transition.ts
头注、view-prefs.ts 防抖窗注释），此处不重复。

## 1. 环境与方法

| 项 | 值 |
|---|---|
| 实测载体 | dev Electron v43.4.0-darwin-arm64（共享平台缓存 dist；`--user-data-dir=packages/desktop/.dev-user-data`；`--remote-debugging-port=9333`）；渲染目标 = dev 控制面 17520/"DSH 本地构建" |
| 实机 dsh | 内建 vendor runtime `@deepseek-ai/dsh@0.1.2-rc.1`（本地实例自动就绪；host 插件已播种） |
| 采集手段 | CDP `Runtime.evaluate` + `PerformanceObserver('longtask'/'layout-shift'/'paint'/'resource')` 早期注入（buffered）；UI 驱动 = 合成 MouseEvent；磁盘 = 合成 fixture（`disk-walk-baseline.mjs`） |
| 脚本 | `scripts/perf/{cdp-lib,boot-measure,switch-measure,eval-measure,disk-walk-baseline}.mjs`（README 见同目录）；数据落 `scripts/perf/data/*.json` |
| 复测命令 | boot：`node scripts/perf/boot-measure.mjs 3 --out ...`；切换：`switch-measure.mjs`（cycles / `--rapid N`）；归因：`eval-measure.mjs`；磁盘：`disk-walk-baseline.mjs [--async]` |

**环境差异警告（2026-09 实测钉死）**：长任务绝对值随启动环境漂移——同一构建在
不同会话/沙箱/GPU 条件下"每启恰 2 个长任务"与"第 2 轮起 0 个"两种形态都出现过。
**前后对照只在同环境 A/B 内可信**；跨环境绝对值不可比。另：沙箱化启动会令
Chromium sandbox 初始化失败（子进程全崩）→ dev 实例需 `--no-sandbox`；更早的基线
会话在非沙箱（danger-full-access）下采集，两者都如实记录于各表。CDP 导航竞态下
同一 ws 跨 reload 偶发挂起 → 轮询/汇总已加 4s 超时守卫、eval-measure 每 run 新建
连接（T6 实测修复）。

## 2. 场景① 启动（骨架 → 内容）

原始基线（非沙箱会话，改造前 HEAD 语义等价构建）：

| run | wall | 长任务数 | 最长 | 前二 | CLS | 骨架 |
|---|---|---|---|---|---|---|
| 1 | 1137ms | 2 | 100ms | [100,81] | 0 | 可见 |
| 2 | 1063ms | 2 | 91ms | [91,74] | 0 | 可见 |
| 3 | 1068ms | 2 | 97ms | [97,61] | 0 | 可见 |

T1 后中间态（同会话）：1093/1067/1085ms，2×96–100ms 长任务，CLS 0——T1 未引入可测
变化。**同环境 A/B（本次整改采集，同一 dev 实例仅换构建产物 reload）**：

| arm | wall（中位） | 长任务形态 | CLS | 数据 |
|---|---|---|---|---|
| PRE-P0（HEAD 骨架+链式 VT） | 890ms（run1 1162） | run1 2×(105,97)，run2/3 0 | 0.001–0.002 | boot-pre-p0.json |
| AFTER-T1+T2（veil+键控单槽） | 888ms（run1 1140） | 4/6 run 0 长任务，其余 1–2×80–97（均在 run1） | 0.001–0.002 | boot-after-t2.json / -t2b.json |

要点：同环境 A/B 中 T1+T2 相对 PRE 无回归、wall 中位持平（~888ms 对 ~890ms）；
两 arm 的 CLS 均 0.001–0.002（原始基线的精确 0 来自彼时会话环境，非代码差异——
同环境 PRE arm 同样非零）。veil 的失配面（曾拖宽侧栏实例的 settle 主区左缘位移）
在此环境不可触发，属真实机项（§7-1）。

完成态烟测（2026-09 review 补登）：`boot-after-final.json`（18:38Z 独立会话，晚于
全部 A/B 与曲线采集，跑在含 T3/T5 主进程改动的最终构建上）run1 1032ms/2×54-51ms、
run2 895ms/0 长任务、CLS 0.001——与 A/B 采集**非同环境、不作直接比较**，仅证明
最终构建冷启无回归/无错误（dev 日志零应用错误）。review 修复轮后的烟测
（boot-after-review.json / boot-after-review2.json，新会话环境、亦不作直接比较）：
1140–1199ms、每启 2 长任务、CLS 0、日志零错误——view-transition 键控单槽的
直通路径统一（review P2 硬化）未破坏冷启/切换面。

## 3. 场景② 跨来源切换 / 场景③ 连点 ×10

本环境形态（关键修正，与原始结论一致）：来源头/工作区行为**同文档热切换**——无骨架、
无长任务、CLS≈0；chamber 的 view-transition 切换路径（冷挂载 shell）需真实会话/冷 ctx
激活，自动化不越此线。同环境 A/B：

| 指标 | PRE-P0 | AFTER-T1+T2 |
|---|---|---|
| 场景③ rapid×10：长任务 / CLS / 点击窗 / 末击→安静 | 0 / 0.002 / 921ms / 1ms | 0 / 0.001 / 928ms / 1ms |
| 场景② A→B→A×2：骨架窗 / 长任务 / CLS | （同形态，无骨架无长任务） | 全程 0 长任务、CLS 0.001、即时安静 |

结论：热切换面两 arm 等价（预期内——该路径不经过 chamber view-transition）；T2 的
单槽合并收益面（在途过渡期间的连点收敛 ≤2 节）只能在冷挂载切换路径触发 → 真实机项
（§7-2）。数据：rapid-pre-p0 / rapid-after-t2 / switch-after-t2.json。

## 4. 场景④ 断连/恢复（transport 面）

与原始结论一致，未随 P0–P2 改动（transport 主进程状态机事件驱动，本次未触碰）：
远程网关实例间歇性 degraded 观察窗内无新长任务、CLS=0。本机 dev 环境 15:32Z 起
`test` 网关源 ready——场景②③测量即复用该就绪窗口。

## 5. T3 磁盘统计遍历曲线（合成，改造前/后 A/B）

真实锚点：打包版 `<userData>/dsh-runtime` 868 项 ≈ 10.8–16.9ms/遍（无害量级；
出自上版文档的历史采集，无独立数据文件【重建：历史会话数据】）。
合成 fixture（.pnpm-store 形态：深层嵌套 + 符号链接 + 硬链接去重面；每点 5 遍
中位/最大；**同一轮次先后测量**，杜绝跨会话漂移）：

| 近似条目数 | 改造前 runtimeDiskSummary（同步，多遍重叠遍历） | 改造后 runtimeDiskSummaryAsync（异步单遍） | Δ |
|---|---|---|---|
| 8,500 | 427ms | 503ms | +18% |
| 34,000 | 2,050ms | 2,130ms | +4% |
| 136,000 | 9,491ms | 10,209ms | +8% |
| 425,000 | 50,995ms（max 57.3s） | 42,182ms（max 43.7s） | **−17%** |

数据：disk-walk-baseline.json（impl=sync）/ disk-walk-after-t3.json（impl=async）。

结论与定案依据：异步单遍在中小规模因 promise/线程池开销比同步略慢（±4–18%）、
在 42.5 万项规模因消除重叠遍历反超 17%；**决定性收益不是墙钟而是不冻结**——同步
版单遍即把进程钉死 0.5–51s（425k 项本轮同轮 sync 实测 51.0s；更早的原始基线会话
数据 425k→34.6s/遍、事务 9+ 调用点、868 项真实布局 10.8–16.9ms 出自上版文档/历史
采集，与本轮非同环境、仅作量级参考【重建：历史会话数据】），异步版逐批让渡事件
循环（onVisited/yield 测试钉死），配合 coalescer 把突发合并为在途 1 遍 + 终态补跑
1 遍。真实布局 868 项下两实现同为 ~15ms 量级，无感知差异。

补充（2026-09 review）：按 425k→42.2s 反推 async 每节点约 60–100µs（逐节点
promise/线程池开销，无管线），sync 约 3–8µs。记录为后续优化候选：**有界并行窗口**
（8–16 兄弟节点并发、保留逐批让渡节奏与 visited 确定性），425k 墙钟可望降至个位
数秒——本次不改（低风险优先，收益面在超大 store）。

## 6. T4/T5/T6 测量面与结论

- **T4（M4 置顶写回防抖）**：单元面（test:sidebar view-prefs 34 用例）钉死语义——
  防抖窗内 N tick 合并 1 次写/通知、每账户最新意图胜出、等值写不落盘不通知、reset
  清窗。运行面无独立实机指标（写频率由会话更新节奏驱动，属真实机项 §7-4）。
- **T5（M1 调度 + D7）**：主进程逻辑收口，无独立 UI 指标；语义（进度相位跳盘、终态
  现场重走）由代码注释钉死 + typecheck/test:desktop 门禁。
- **T6（H3 实验）**：归因探针落地（eval-measure.mjs）。每启两段结构长任务：
  LT1 13–21ms 起、72–96ms（主图 main/vendor/covered/chamber 求值）；
  LT2 100–120ms 起、57–62ms（实例启动图：profile 家族 + langs/*）。module 脚本的
  longtask attribution API 为空（Chromium 只填可定位 culprit），归因取资源加载序 +
  时长预算推断。懒加载边界审计：首屏急切图（main/vendor/index/covered/chamber）与
  实例启动图（profile 家族）均无 chamber 自建安全可动边界——covered/chamber 已按
  设计在 settle/apply 末尾 fire-and-forget 注册；langs/* 已按需动态加载。**实验结论：
  负面（无可安全改动的边界），两段结构任务保持稳定，真机验证列 §7-5**。

## 7. 实机待复测清单（用户机，打包版或带会话的 dev 实例）

前置：退出运行中的 dsh-chamber；以 `dsh-chamber --remote-debugging-port=9333` 重启；
`node scripts/perf/boot-measure.mjs 3` 验证通道。

1. **②/⑤ 曾拖宽侧栏的实例冷 settle**：把某实例侧栏拖宽 >320px → 退出重进/切走再
   切回，记录骨架窗口与 settle CLS（默认观感 + reduced-motion 两档）——veil（T1）
   应消除主区左缘位移。
2. **③ 快速连点 ×10 的冷挂载切换**：对两实例间连点，记录末点击 → 内容稳定耗时与
   过渡节数（T2 键控单槽应把链式过渡收敛为 ≤2 节；`switch-measure.mjs --rapid 10`）。
3. **⑥ 版本事务**：dsh 运行时设置页触发安装/切换/回滚，事务全程 `sample <pid>` 主
   进程，记录最大阻塞——改造后应无同步全树冻结（T3+D7 面；改造前基线见 §5 曲线）。
4. **更新模式侧栏写频**：把某工作区置于"最近更新"序并保持会话流式更新，侧栏其它
   来源计数 localStorage 写（T4 防抖面，250ms 窗收敛）。
5. **H3 懒加载验证**：慢速/高负载真机上跑 `eval-measure.mjs 5`，确认两段结构长任务
   与归因结论（如真机出现可感知的首屏主图求值，再评估入口级切分方案——本次审计
   未发现安全边界，不预设改动）。

## 8. 六场景前后对照汇总

| 场景 | PRE（改造前） | AFTER（P0–P2） | 判定 |
|---|---|---|---|
| ① 启动骨架→内容 | 同环境 890ms（run1 1162）/ CLS 0.001–0.002 / 1–2 长任务 | 888ms（run1 1140）/ CLS 0.001–0.002 / 0–2 长任务（4/6 run 0） | 无回归；真实机看 veil 失配消除 |
| ② 跨来源切换 settle | 热切换面：无骨架/无长任务（形态记录） | 同左；冷挂载面待真机（§7-1） | 代码面收敛（T2）；实测面待真机 |
| ③ 连点 ×10 | 0 长任务 / CLS 0.002 / 921ms | 0 长任务 / CLS 0.001 / 928ms | 无回归；单槽收益面待真机 |
| ④ 断连/恢复 | 观察窗无长任务、CLS 0 | 未触碰 transport 面 | 不适用（无改动） |
| ⑤ 宽侧栏冷 settle CLS | 280px 假几何失配（真机可入 CLS） | 零几何主张 veil（T1） | 代码面消除；真机复测（§7-1） |
| ⑥ 版本事务主进程阻塞 | 425k 项单遍 51s、事务 9+ 遍叠加冻结 | 异步单遍 42s（不冻结）+ coalescer/D7 合并 | 冻结消除（本机合成面）；真实事务 sample 待真机（§7-3） |

数据文件：scripts/perf/data/{boot-baseline,boot-pre-p0,boot-after-t1,boot-after-t2,
boot-after-t2b,boot-after-final,boot-after-review,boot-after-review2,rapid-pre-p0,
rapid-after-t2,switch-after-t2,eval-baseline,disk-walk-baseline,
disk-walk-after-t3}.json（14 个，全部入库于 scripts/perf/data/，.gitignore 白名单
例外）。

## 9. 任务编号对账与去向（2026-09 review 补登）

- M0（环境探测）→ scripts/perf 工具链 + §1 环境/方法（CDP 守卫、沙箱与
  跨会话漂移发现即其产物）；M1（T0 基线）→ §2–§4 与 data/*.json。
- T7–T12（P2 卫生批明细）：批准方案全文缺失，痕迹中仅存"P2 卫生批 T7–T12、
  T13 并入 T1"字样，无逐项内容【重建：无法还原】。本轮按痕迹执行了卫生批
  的实质工作并如实命名：perf 工具卫生（README/守卫/探针）、全量门禁重扫、
  dev 实例烟测、文档完成态——未沿用 T7–T12 编号以免伪造原案粒度。
- review 轮处置（2026-09，5 面独立审查）：F1 拖拽竞态（P1）、文档 3×P1
  （boot-after-final 交代/PRE 数字/T7–T12 去向）、渲染层 P2 硬化×2、
  注释措辞批量、maxReruns 边界测试、gateway 测试 race 兜底等——修复明细见
  工作树（未提交）与 STATUS.md 条目。
