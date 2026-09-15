# scripts/gui-acceptance — GUI 验收工具箱

面向维护者的**可执行证据产生器**：把 `docs/checklists/gui-acceptance-checklist.md` 里
标 `[机械]` 的项目跑一遍，产出固定 schema 的报告 + 截图，供 PR / issue 附证据。

**它不是新的阻断门**：判据的权威仍在 `docs/design/`（契约）与
`docs/progress/STATUS.md`（开放实机门禁），本目录只负责**跑**与**留痕**——所以正文不复制
判据，避免出现第二份会漂移的台账。

| 文件 | 用途 |
|---|---|
| `run.mjs` | 单一入口：`--live` / `--attach` / `--dev` |
| `probe.mjs` | `--live`：对**运行中的应用**做只读 HTTP/WS 探测（安装态亦可，无 CDP） |
| `walkthrough.mjs` | CDP 界面走查：结构断言 + 截图 + 控制台/网络事实采集（含 `W-4b` 行悬停卡片四条腿：标记锚定的升起/清卡 + 标题同一性、**实测窗口内**的搁浅竞态、A→B 互斥自愈、blur/hidden 清卡） |
| `launch.mjs` | `--dev`：一次性 dev 实例（隔离 user-data、固定控制面端口、CDP 端口） |
| `cdp.mjs` | 零依赖 CDP 客户端（Node 内置 `WebSocket`/`fetch`） |
| `checks.mjs` | **纯判据层**：全部 pass/fail 逻辑在此，无 IO，故可在 CI 单测 |
| `gui-acceptance.test.mjs` | `checks.mjs` 的单测（`pnpm run test:gui-acceptance`，CI 跑） |
| `mobile-walkthrough.mjs` | 移动档 CDP 走查（独立 CLI）：设备尺寸/触控模拟 + 几何断言 + WS 帧采集（`--ws-frames off\|summary\|full`，落盘前脱敏）；`--require-run` 把「没目标/没会话」的 INFO 改判 FAIL |
| `mobile-checks.mjs` | 移动档的**纯判据层**（含脱敏）：判据全部是纯函数，无 IO |
| `mobile-checks.test.mjs` | `mobile-checks.mjs` 的单测（`pnpm run test:gui-acceptance` 一并跑） |

移动档的两层与桌面档同构：`mobile-walkthrough.mjs` 只采集事实（CDP + DOM 表达式），
判定与脱敏都在 `mobile-checks.mjs`。真机抽检不可省（见 `docs/progress/STATUS.md`
的移动验收项）：模拟层有三条实测边界（`Emulation.setEmulatedMedia` 的
`pointer`/`hover` 被 Chromium 忽略、`mobile:true` 的收缩适配让
`scrollWidth <= innerWidth` 恒真、iOS/WebKit 语义造不出来）。

## 命令

```sh
pnpm run acceptance:gui                      # --live：探测运行中的应用（只读，最安全）
pnpm run acceptance:gui -- --attach          # 对已带 CDP 的 dev 实例做界面走查
pnpm run acceptance:gui -- --dev             # 自起 dev 实例 → 走查 → 自动关闭
pnpm run acceptance:gui -- --dev --require-hover   # 悬停腿必须真实执行：未执行（INFO）计为 FAIL
pnpm run acceptance:gui -- --live --sources gateway-a,gateway-b   # 显式指定要扫的远程来源
pnpm run test:gui-acceptance                 # 纯判据单测（无需 GUI，CI 跑）
```

产物默认写 `.tmp/gui-acceptance/`（gitignored，**不污染仓库**）：

- `gui-live-report.md` / `.json`、`dev/gui-live-report.*`（`--dev` 的实例侧）
- `gui-walkthrough-report.md` / `.json`、`shots/*.png`
- `dev-app.log`（`--dev` 的 Electron 日志）、`dev-user-data/`（隔离状态）

退出码：有 `FAIL` 即 1；`INFO`（环境不适用，或命中"已登记容忍"）不判失败。

**但"无 FAIL"不等于"都跑过"**：`INFO` 的含义是"这条腿没执行、没判过任何事"。所以结束行会把 INFO 数
一并说出来——`GUI 验收：无 FAIL（4 项 INFO 未执行）`——绿色运行不会被读成"全量覆盖"。要让"没跑过"直接
变红，用 `--require-hover`：走查的四条悬停腿（`W-4b`、`W-4b-race`、`W-4b-swap`、`W-4b-dismiss`）只要判成
INFO（实例确无可悬停卡片行），就在报告里改成 FAIL 并附上"本次运行要求 hover 腿必须真实执行"。退出码语义
不变（`INFO` 默认仍不算失败），所以这是**逐次显式选择**的严格档，不是新的默认门；它只重标"未执行"，
已经是 PASS/FAIL 的判据原样通过。

## 已登记容忍与策略（判据的例外都写在这里，不藏在代码里）

| 情形 | 处置 | 依据 |
|---|---|---|
| `clientGraph/graph` 冷启动期 503 | 记为**容忍**（原始文本仍入报告） | design 09 §3.2：`client/serving-gate.ts` 头注——实例未 serving 时反代拒转发，属预期 |
| `api/host/health-events` 的 `net::ERR_ABORTED` | 记为**容忍** | 页面自身重订阅/关闭 SSE 时浏览器记客户端 abort；服务端掉线会是状态码或别的错误串，仍判失败 |
| `[cordis-client-runner] … has no active Connection` | 记为**上游噪声**（原始文本仍入报告） | 上游 `cordis-client-runner/src/client/inspect-registry.ts` 启动期日志，非 chamber 缺陷 |
| 首启向导（`settings.onboarding`） | `--dev` 会**走完**（优先点关闭动作，最多 4 步自动推进）；`--attach` **绝不代点**，记 INFO 并跳过设置面走查 | 推进向导会写实例自身状态：只允许发生在一次性实例上 |
| `W-4a` 来源级收拢（会写持久化偏好 `sourceFolded`） | `--dev` 执行（收拢→展开往返，并断言往返后无残留）；`--attach` 记 **INFO** 并写明原因 | design 06 §3.1；与上一行"只允许写在一次性实例上"同一口径 |
| 实例未就绪（`dsh.status != ready`） | 实例面检查（`IP-*`/`IN-1`/`CP-5`）转 **INFO** 并说明隔离期 503 属预期 | design 18 §3.4 |
| 实例确无可悬停的卡片行（只有来源头，或只有按设计无卡片的未分组桶头 `[data-chamber-row][role="treeitem"]`） | `W-4b`/`W-4b-race`/`W-4b-swap`/`W-4b-dismiss` 记 **INFO** 并写明未执行（`--require-hover` 时改记 **FAIL**） | design 06 §7：来源头、未分组桶头都不是卡片锚点（`ServerSection.tsx:1436-1437` 有行属性但 `:1743-1746` 不套 `RowHoverCard`） |
| 有锚点形状的行（父节点是 `RowHoverCard` 的锚点 `<span>`）却没有 `[data-chamber-hovercard-anchor]` | `W-4b` 记 **FAIL** 并点名缺失标记 | **不是环境事实**：`--attach`/`--dev` 面向本仓 dev 构建，标记由 `RowHoverCard.tsx` 落地；缺标记 = 修复没打进包，正是 `W-4b` 要拦的 |
| 同屏凑不出两个可悬停行（视口太小/工作区折叠） | `W-4b-swap` 记 **INFO**（`--require-hover` 时改记 **FAIL**） | 互斥腿要有 A、B 两行同屏可悬停；单行无从判"至多一张" |
| 本机 dwell→提交窗口测不到、或 ≤2ms（探针/计时器分辨率之下） | `W-4b-race` 记 **INFO**（"本次运行不具区分力"，`--require-hover` 时改记 **FAIL**） | 固定 band 只是窗口下界：窗口不可测时该腿证明不了任何事，报 PASS 就是把没区分力的运行当证据（复核 finding H5/#3） |
| 安装态早于 2026-09-10（无 `/writers` 路由） | `CP-4` 记 INFO | 该路由由 9767853 引入 |

`CP-4` 的判据是 `quiescent === true`（**不是** `writers` 为空）：扫描到的 `reclaimed` 孤儿会如实列出，只有 `kept`（无法回收）才代表有无法解释的活写者。

## `--dev` 的干净退出

退出顺序：`DELETE /api/connections/local`（让应用自己停掉托管实例）→ 杀 Electron 进程组 → 按端口回收**本仓 `packages/desktop/vendor/dsh` 下的**遗留进程。第三道只认这个 cwd，因此不会碰到打包版自己的实例（17510）。`--keep` 可跳过关闭以便人工接管（此时请自行收尾）。

## 前置条件

- **`--live`**：应用已在跑（打包态或 dev 均可）。只发 GET/HEAD、读一帧 SSE、做原始
  upgrade 握手；**不发任何写请求**，可安全用于有真实会话的安装态。
- **`--attach`**：dev 实例已带 `--remote-debugging-port=9333`（与 `scripts/perf` 同一约定）。
- **`--dev`**：需要构建产物就位——`packages/desktop/dist/{web,preload.cjs,control-plane}` 与
  `packages/desktop/vendor/dsh/node_modules`（缺哪一项会**直接报出该跑哪条命令**，不隐式构建）。
- 在沙箱/容器里跑 Electron 需要 `--electron-arg=--no-sandbox`（Chromium 沙箱无法嵌套）。

`--dev` 与运行中的打包版**互不干扰**：独立 user-data（自己的锁/状态/注册表/凭据）、
控制面从 17520 起自动退避（本工具箱默认固定 17530）；其托管 dsh 若发现 17510 已占用会
自行让位。dev 模式不注册 `dsh-chamber://` 协议，故不会抢打包版的深链。

## 断言的取向（为什么这样写）

- **只用仓库已有的 DOM 契约**，不新增测试钩子、不靠文案匹配：
  `[data-instance]`（每实例壳）、`[data-chamber-section]` / `[data-chamber-row]`（多来源侧栏）、
  `[data-chamber-hovercard]` / `[data-chamber-hovercard-anchor]`（行悬停卡片与其锚点，`RowHoverCard.tsx`）、
  `[data-slot]` / `[data-slot-error]`（设置面渲染位）、`dialog nav [class*="navList"] > button`（设置导航项）。
- 悬停卡片的行选择与计数**只认标记**（曾经按 `position:fixed` + 244px + `z-index:100` 的几何计数，Tooltip
  气泡或残留卡片都能满足它）；可悬停行只认 `[data-chamber-hovercard-anchor]` 之内的行，所以未分组桶头
  不会被误选。
- **选控件与判效果分开，且判的是"效果"**：`W-4`（侧栏 rail 折叠）的控件**不带 `aria-expanded`**——上游与
  本仓 fork 都只给它一个会翻转的 `aria-label`（移动档替代品为何"自行"补 `aria-expanded`，见
  `MobileNavToggle.tsx` 头注：它不在它所折叠的侧栏内部）。因此这条腿**不按属性选控件**：页面只 dump
  按钮描述符，纯函数 `pickRailToggle`（`checks.mjs`）在侧栏头部**结构定位**（候选为空或并列即 FAIL，
  绝不"取第一个"），判据是官方 frame 属性 `[data-sidebar-collapsed]` 的出现/消失 + 复原。**点错控件
  ⇒ 属性不动 ⇒ FAIL**。曾经的写法是 document 级"左半屏第一个 `button[aria-expanded]`"：它打到了
  来源节折叠钮（现 `W-4a`），腿报 PASS 而侧栏从未折叠；旧腿的"复原"还沿用同一表达式重扫选择器，
  真折叠后会点到 rail 的「设置」座席并打开设置面——现在复原点击用**同一元素**（`CLICK_STASHED_BUTTON`），
  仅当该元素已脱离 DOM 才回退到同一套定位策略，且效果断言仍会拦住错点。
  候选带必须**贴住头部行**（`RAIL_TOGGLE_BAND_MAX_TOP_PX = 48`；实测开关在 top 18/22）：rail 态在头部
  区域还有一颗同尺寸的「新建会话」钮（36×36 @top≈66，会**真的建会话**）——带放宽到它就会在开关缺失时走到它。
  收紧后，开关缺失 ⇒ `no-candidate` ⇒ FAIL，绝不落到变更控件上（点击白名单承诺的安全性质，单测钉住）。
- **点击按身份寻址，不按 DOM 下标**：纯判据选出控件后，页面侧先核对"该下标处的元素是否就是描述符指的那个"，
  不匹配就按描述符重新定位，找不到就**一个都不点**（腿随后在"效果没发生"上失败）。下标只在两次 CDP 往返
  之间是提示——期间页面重排（会话事件插行、poll 提交）会让它指向别的控件。复原点击一律用**上一次点过的同一个
  节点**（`CLICK_STASHED_BUTTON`），元素已脱离 DOM 才回退到同一套策略。
- **W-4 判的是往返，方向随初始态**：视口窄于侧栏自动折叠阈值时实例**初始就是折叠态**，第一次点击是"展开"，
  于是 `03-sidebar-toggled.png` 显示的是"另一个状态"而非"折叠态"——方向以证据行
  `[data-sidebar-collapsed] false → true → false` 为准（1280×768 与 rail/窄档三态都实测过）。
- **W-4a 只覆盖首个来源节**：多来源实例里其余来源的收拢不在本腿内（一次性实例本也只有本地来源一个节）。
- **N-ctx 多壳窗口按"可见性"收口**：非活动实例视图仍挂载在 DOM 里、只用 `visibility: hidden` 隐藏
  （`packages/renderer/src/styles.css` 的 `.instance-hidden`/`.instance-pending`），几何上仍有真实尺寸。
  因此 `DOM_FACTS` 把**计算可见性**作为事实一并带出：`pickRailToggle` 只接受可见控件，`W-4a` 只取**首个
  可见**的来源节——否则会点/折叠一个用户看不见的视图。实测（往真实页面注入一个隐藏克隆）：不过滤时隐藏钮
  会进入候选并可能被顶择，过滤后仍选中可见那一颗；隐藏钮**独占**候选时判 `no-candidate` ⇒ FAIL（绝不点）。
  这条边界只在多壳窗口才有区分力：走查每次先 reload、DOM 重建，本机一次性实例是单壳，故真机多来源应用未复验。
- **竞态腿的 band 是量出来的，不是写死的**。搁浅要求 pointerleave 落在 **[dwell 回调已跑，React 提交 open]
  之间**（vendored 的 `onPointerLeave` 是 `clearTimer(); if (open) armClose()`）：固定 band（历史上的
  `dwell+10..60ms`）只是这个窗口的**下界**，在空闲快线程上整段 band 都可能落在提交之后，于是有缺陷的包也
  会变绿（对抗性复核 finding H5/#3）。所以走查先**测本机的 dwell→提交窗口**（进卡片行后每 ~5ms 轮询一次
  `[data-chamber-hovercard]`，取"最后一次没看到卡片"的时刻作为提交时刻的**严格下界**——宁可低估也不能高估，
  高估正好是让坏包通过的方向；多次采样取最大，即不会越界的最紧估计），再由纯判据 `raceBandForWindow()`
  在该窗口内取 3 个确定性偏移（窗口过大时封顶 200ms 以控时长），12 次试验轮流使用。
  窗口测不到（没看到卡片）或 ≤2ms（低于探针分辨率，真实计时器无法投递）时，本腿报
  **"本次运行不具区分力"（INFO）而不是 PASS**，绝不把没区分力的运行当证据；`--require-hover` 会把这条 INFO
  改判 FAIL。搁浅一旦出现，无论窗口如何都是 FAIL。时长：测量 ~3s + 12 次试验 ~12s。
- 该腿**不注入主线程负载**：它测量的是本次运行真实拥有的窗口，而不是人为制造慢线程。
- **真实指针输入**：悬停腿全部走 CDP `Input.dispatchMouseEvent`（合成 DOM 事件会绕开浏览器命中测试）。
  唯一的合成事件是 `W-4b-dismiss` 的 `blur` / `visibilitychange(hidden)` 探针——真实 OS 失焦与真实
  标签页隐藏无法用 CDP 制造，所以那一条验的是**监听接线**（首次开卡时绑定 + 能清卡），不是 OS 交接；
  走查会恢复 `document.visibilityState`，即使断言抛错也在 `finally` 里恢复。
- 仅两处与语言耦合（侧栏「设置」座席、首启模态的关闭动作）走 zh/en 白名单，匹配不到就记
  `INFO` 并留下截图，交给目检——不假装通过。
- **点击白名单**：只点设置导航项、首启关闭动作、侧栏头部图标钮（`W-4`）与来源节折叠钮（`W-4a`）
  这四处，因此按不到「启动/停止/保存/删除」这类变更控件。
- **写入边界（2026-09-15 修订）**：`W-4` 只改内存态——导轨折叠是 layout store 的 0 状态，
  `view-prefs.ts` 明写「折叠不会持久化」（持久化的只有拖拽宽度 `sidebarWidth`）。`W-4a` 会写**持久化**
  偏好 `sourceFolded`（design 06 §3.1），所以它**只在一次性实例（`--dev`）上执行**，`--attach` 记
  INFO——与首启向导「只允许在一次性实例上推进」同一口径。此前「整个走查不产生数据写入」的声明不成立：
  旧的 `W-4` 选择器静默点到来源节折叠钮并落盘，而报告没说。
  这条边界现在**由腿自己检查**：走查读共享键 `dsh-chamber.sidebar.v1` 的指纹（`VIEW_PREFS`）——`W-4` 的
  任一点击若改了它就是 FAIL（design 06 §3.1 只持久化拖拽宽度），`W-4a` 的收拢往返若留下 `sourceFolded`
  残留也是 FAIL。"不写数据"因此是被断言的事实，而不是 README 里的承诺。**读不到快照**（没取到，或存值
  JSON 解析失败）一律按"未检查"处理并 FAIL——"证明不了没写"不会被读成"没写"；同理 `W-4a` 的来源节几何
  读不到（非有限数）即 FAIL，因为那条腿的判据本来就是几何。
- GUI 腿需要 display/打包态，**不进 CI**；进 CI 的是 `checks.mjs` 的纯判据单测，加上悬停行选择逻辑对假 DOM 跑的迷你用例（真页面表达式，判"未分组桶头不会被误选"这类选择缺陷）。

## 与其它工具的关系

- `scripts/perf/`：性能测量尺子（同一套 CDP 前置，采 DOM/堆/帧间隔）；本工具箱管**功能验收**。
- `pnpm run smoke`：控制面 × 真 dsh 的无头端到端；本工具箱管**界面与同源反代面**。
- `acceptance:runtime:*`：dsh 运行时管理器（无头）。
