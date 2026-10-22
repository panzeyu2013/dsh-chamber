# 模块完成状态总览（STATUS）

> 只记仍开放项：未完成/部分完成（含实机与打包态门禁）、设计未决、仍成立的取舍；每条 = 开放事实 + 判据/指针。
> 已实现基线以 git 历史、`CHANGELOG.md`、`docs/design/` 为权威；不记完成叙事、测试计数、哈希、批次与实现过程。
> 本文件是**唯一进度记录**；未排期计划见 [TODO.md](TODO.md)，双 flavor 差异见 [deviations.md](deviations.md)；
> 条目的进度状态只在本文件，TODO/deviations 不重复记状态。条目落地或不再成立即删。

## 一、未完成 / 部分完成

### 1.1 会话链、运行位与页面通道

- **I-15 上游漂移实机记录**：六组矩阵（P6、归档两段式+恢复、通知四缺口、运行位 60/190/310s、I-14 selection scope、I-12 谱系压制）待打包态/真机各跑一次；执行序见 `gui-acceptance-checklist.md` §4.1，判据见 [TODO.md](TODO.md) A§14.1。
- **上游 UI 对齐遗留面**：待裁差异见 §2.1，外部约束见 §2.3，明细见 [TODO.md](TODO.md) A§15。
- **会话链重构（design 14 §D4）**：60/190/310s、ssh 写回时延、macOS 腿、集中日志面待校准；mobile `session-stall.ts` 拆分待裁；Swift `RendererRecovery`/`RendererHangWatchdog` 超 ≤90/≤60 目标且未入棘轮；反补丁波次①–④；`tests` 模式 flaky。
- **弱网韧性 v1（design 27）**：真实 WAN/ssh 中继下的 100/300ms、1/5% 丢包、10s 黑洞、20s flap、真机睡眠/切网（resume/online 复验）与 `verifyUpBudgetMs` 复合预算（gateway 口令 35s / dsh 5s）待人工确认；本机 `pnpm run acceptance:netem` 可复跑 veth+netem（真实 tc/真代理；`NETEM_BULK_UPLOAD=1` 追加 20MB@2Mbit），不替代真实 WAN 与真机睡眠。另：打包态入站 `client-body idle` 慢上传（loopback 已证 35s `requestTimeout` 不约束）、`$events` 宿主 boot id 后续、PinnedAgent 延期（pin 仍 `agent:false`）；其余已知限制见 design 27 §6。
- **会话运行位卡死**：①lane 复现未接 CI；②WS 半盲时 transcript 不收敛（宿主 `asOfSeq` 对账未做）；③`session.list` 单飞悬挂；④子代理行不进运行时事实（有意）；⑤隐藏期 watchdog 不 tick；⑥阈值/N=2/写回链未实机校准；⑦vendor 语义由 `vendor-session-fact-contract.test.ts` 钉住；⑧日志取证价值未验；⑨全量性缺水位；⑩集中日志面未做；⑪两处更省形态未落；⑫对话流健康臂未实机验；⑬静默半死（keepalive/游标/`ended(false)` 兜底未做）；⑭修链未闭合（契约写回、90s 界限、ssh 时延、窄缝、行为测试）；修正 provenance 的 I3 臂无 host 证据不通知，实机矩阵未跑；⑮运行位解析未实机校准；⑯子代理环行集与官方不同源待裁。
- **会话打开停滞（design 14 §D4）**：宿主无首帧期限；触屏档无载波层、blank 恢复入口、移动端 source↔artifact 锁、FNV 键碰撞、`socket-silent` 消费面、`presented` 近似、阈值、unary 引导、取证小面、实例级回退、补读面——均待接线/退役或校准。
- **连接稳定性**：24h 494 次 WS 关闭全为 upstream close（local 108 次、0 heartbeat lost），但独立 Node 客户端同 mux 400s 无 close ⇒ 页面侧差异；下一步抓 close code（1006/4000）并对齐 `[chamber:evidence]`。
- **JSC 崩溃 → 静默重载**：WebKit 22625；16 份/8 天基线 ≈0.29 次/小时页面存续，入口全为 WS 消息派发；开放 = 重载后草稿复原真机验证、事实持久消费面、vendor 事件窗口淘汰。
- **页面级 HTTP 预算（design 26 §D7）**：①参数 `4/1/2` 待真机标定（queueMs p50/p95、`zeroWaitGrants`、leaseExpired、成功率、bundle 帽对 boot 影响）；②残余通道（connection RPC/script/deferred chunk）不经预算；③bundle 槽无 queueDeadline；④元素/worker 同源加载不在预算。
- **页面通道/事实源残余**：page-channel 上游连接不计反代并发（`stats()` 无消费方）；权威门 producer 无 `reportedAt`；预算拒绝诊断 `not-injected`；gateway 不挂 page-channel 且 `degraded=true` 成因未查；design 26 打包态复验未跑。
- **本地 facts 间歇降级**：待真机 fetch 排队测量（≥3 个 SSH 慢源时 in-flight 是否恒 6；`unscheduled booked=false` 与慢窗口同拍；单慢源阴性对照）。
- **P2b 事实通道降级**：`$events` 有投递；一次定案为插件管理器长 RPC 撞 45s 保险丝（扩容 `LONG_RPC_PATHS` 待裁）；另一次十连败不可区分，出口 = 窗口期差分（Node 默认时序 + unary 探针）。
- **完成身份/判读窗口**：无锚完成跨通道身份不同（最坏重复一条横幅）；`lastAnchoredSeq` 已有单调记账；消除需上游 `turn/end` 判别符。facts-only 源无 `beforeBaseline` 首见窗口、P2b 行 `identityConfirmed` 门、facts 不可判时读清/武装冻结。
- **性能遗留（P0–P2）**：五条实机复测 + 全视图 DOM ≤13,000（实测 15,805 含壳 chrome）；已知取舍（蓝点/通知暂停、桥探测 30s 长尾、purged 孤儿键 K=2）；待真机 = 隐藏 ≥60s 唤醒、SVG scope 探针、风暴档发布速率。
- **Swift 壳性能 A/B**：启动/大载荷 p95/空闲 wakeups 待打包态；`[shell-fps]` 被 `!isPackaged` 编译掉；判据 = 空闲安装率 <200/s、静默 CPU <10%。
- **页面侧残余**：流级预算表外 2s/8 两份未锁；forensics request/snapshot 半通道、carrier `openingAnswered` 无生产消费者；五条结构性重复/死分支；lane reconnect 注释与行为不符。

### 1.2 通知、未读与归档

- **通知壳 sink `runtimeSettled`（I2）**：两 sink 共用 `completionAlreadySettled`（fail-open，只影响抑制）；打包态需证「同页、非首批、producer 重置后的壳完成重放」不再双发；候选证据门、`factsContradictsIdle`、Dock 读回、`facts-health` 保底名额待复核。
- **目标活跃期通知/未读压制（design 19 §3.2）**：N 轮 `held≥1 && sent==0`、outcome 后一条、六面同拍、reload/冷启、撤回、local/gateway/SSH 各一组；activation unknown 需上游只读面；围栏双发（F30）待裁。
- **P6 完成未读实机**：官方位读数（武装/清除/重载即空/修正臂）与六面矩阵（侧栏/搜索/待办/Dock/通知/诊断）；local+gateway+SSH（design 06 §4.1–§4.3）。
- **通知行为缺口**：点击二级门、主进程握手、设置页渲染、`pagehide` flush。
- **事实健康环**：仅无壳 mux 快照、无 in-app 读面；收口 = gateway 采样 + 只读环。
- **归档清理/管理器（design 24）**：打包版目检、探针 fail-closed、>65,536 不清扫、gateway/远程实机；两段式与恢复路径实机未跑；残余 = 上游 wire no-op、维护期 force、保护边界；缺陷 = `errors` 通道混用；清理残留 = projcache 4KB、迁移代际窗口；tombstone 由孤儿清扫收敛。
- **工作区删除意图（design 05 §2.2.1）**：列表中部删除不滑尾、最后一行无位移、确定性拒绝不闪回（限单次删除）；四类已登记例外与两类派生窄窗（见设计）；上游 order/remove 原子化后退役（§2.3）。
- **侧栏收敛四项 + 整源降级**：会话创建/fork/归档、打开意图/工作区回声（`early-open.ts` 去留）、新 worktree 首帧五项（位置/淡入/确认层/tooltip 裁剪/`data-hover-gate`，判据见 design 06 §7）、会话待办区 10 项。
- **双帧 status**：需宿主轮次键/可信 host 尾时间；无壳观察者 follow 已走 remote.mux，须真实宿主核对。
- **受管日志取证**：真机未验；隐私代价（含会话内容）；仅本地 spawn。
- **会话列表标签**：title→cwd basename→id；无额外实机门禁。

### 1.3 客户端插件、设置与移动端

- **插件热同步（design 09 §3.7）**：真实 add/remove 帧、ssh/gateway 各一源、卸载边界、隐藏回收无迟到写、宿主重启活行存活、图回归（60s 有界探测）待实机。
- **插件刷新收敛（design 09 §3.7/15 §6）**：装/启/卸后不按 Cmd+R 即时出现；同 id 新 rev 5s 内自动重载一次不循环；宿主帧先于结算的竞态；跨实例冲突只出事实条；在途动作不被重载打断；restart-required 不谎报。判据 = 5 个测试 + 目检。
- **遮罩/揭幕 P0–P3**：W-1b 真机走查、揭幕时延、Swift 发布包 Safari 抽检。
- **files seat（D-01=B）**：Files 页签出现「打开当前文件夹」、per-source 语义、官方占座 inert；判据 = 2 测试 + 目检。
- **登录 shell 环境（design 02 §3.1）**：Dock/Finder 启动下两 flavor 读到 PATH/代理/API key；失败可定位、不阻塞；`DSH_*` 不被覆盖；判据 = 1 测试 + 实机。
- **移动端 Web（design 17 §18）**：未实施 = 移动中量化/滚动记忆/宽屏触控/长按气泡；WebKit composer 守卫、§18.6 复审余项、登录页预热、git 侧栏排期、DOM 锚点审计。
- **移动端 P0/P1**：14 项真机复验（首行 ≤48px、安全区、tooltip 三形、crumbs、`_toBottomSlot`、PlatformOverlay、R3/R5、IME、M-9、stale-selection、inert、Escape、preview 卡、M-10 判红；判据见 design 17 §18.6）。
- **N-ctx 主题/语言**：打包态目检；冷启动变化 ≤1、预热/收割 0，另验同帧性。
- **设置面残余**：写路径 4–8 人日（台账/字段描述符/密钥存在性）；面板要求源壳挂载；打包态冒烟。

### 1.4 打包态与真机门禁（按来源/版本）

**壳与窗口**：T-10 调试模式人工判；多来源 sleep/wake、版本歪斜、gateway 回归；隐藏/遮挡（S-10：rAF/定时器/`visibilityState`/App Nap、≥60s 页面通道与 mux、唤醒重连、30s 轮询补偿）；macOS chrome（红绿灯 (16,18)、vibrancy、Reduce Transparency、`data-fullscreen`、失败页、整窗拖动）；ProMotion 三工况（插电 120/低电 60/60Hz 外屏不回退）；原生席位/W7 语言与主题；托盘图标（等高不裁、与 Swift 18pt 一致）；设置页拖拽（按下可拖、正文不被选择、按钮可点）；S-50 根级回弹（整页零位移、滚动/惯性/键盘无回归）；Swift soak（流式中点开 ×20、mux churn/JSC 基线）。

**来源与启动**：vendor 补丁可见态 A/B；右栏栈/session v3 迁移；open-in host 包（两代探针、图标/缓存/CSP/fence/cwd、macOS 清单、Windows 盘符/UNC、第三方 scheme）；终止失败闩锁；写者静默门（409 停 `starting`）；降级提示三处；切源座席/字标；boot 死区（idle 不启、1.5s 判死、10s 重试、502 自愈）；idle 排队 68s。

**桌面宿主路径（S-56）**：打包态按 design 25 §5.7 的五组判据（拖入/回形针/粘贴 flavor/回退归属/负控）逐项走查；证据 = `[shell] 宿主路径快照` 行；判据 = 4 测试 + 本实机。

**Swift 运行期**：首载按 `/health` 等 ready；首屏后无周期健康探测/重启入口；`didCommit` 后缺期限；宿主 cwd/安装根两条。

**上游 pin 新面（无 GUI 未跑）**：
- 基线：0.2.1-rc.2 未复跑；pin 四项（内置插件页、跨代 profile、gateway 就地升级、0.1.6 移动端 + 右栏终端）挂账。
- alpha.4：Schedule（Automation tasks 面板/任务页/行 clock 标记/右侧任务标签/删除 toast/每会话 catalog 查询）+ Developer Tools（可选、默认关、Session/NodeJS Inspector、shell.bottom 声明）在 N-ctx 目检；判据 = C9/C11/C16 + `frame-slots`；风险 = inspector iframe document-relative 可能落 SPA fallback（C9 前缀或占位）。
- alpha.4 Discover：启用市场 bundle 后设置→插件管理的 Discover 页签与安装链；判据 = `test:plugin-manager` 的 `plugins.tab` + C4 契约 26；风险 = inject 含 plugin-manager 行、extra row 模块表解析未测（必要时升 covered factory）。
- alpha.5：①账号通知栈（层叠/高度过渡/空标题/空 expiresAt/未校验 JsonValue）；②模型标签三处（trigger/菜单/模型行，112px 已修）；③终端列表会话级缓存（去重/失效不重试/reset 刷新）；④右栏收起 PageUp 不横滚；⑤PTC code-first 与 persona 一致。
- alpha.5 观察：portal 逃出实例子树（隐藏管不到、onShown 不校验 → 可能提前 ack/跨壳叠加）；required-extra-rows 不覆盖 host-graph 行（inject 缺失静默 PENDING）。
- rc.2（仅该来源）：①Web 搜索开关（默认关、三命名空间字段与凭据、sendOriginalQuestion 128 字符、下次搜索生效、回退前先关）；②模型徽标三处（112px 回归已修，菜单/模型行待目检）；③web-deepseek-api 凭据/available；④日志 body.thinking 可选 log-only。
- 0.2.1 整页插件/自动化：页面根安全区/页头避让/44px 触控/字段堆叠与 16px 输入/choose-shell 命中区/抽屉收起（320/360/390/834 已模拟）；待真机 = 安全区/横屏、iOS/Android 键盘、真实插件动作与保存；判据 = 目检 + `acceptance:mobile` 路由步（脚本待补）。

**open-in/Git/深链/只读镜像**：open-in S3=复制路径（工作区已落、会话行待补或裁决；S4/复制 ssh/深链不做）；VS Code 深链 8 项；Git worktree 远程 3 + 实机 3 + 孤儿清理 1；只读会话镜像（无 CDP 阻断、gateway/SSH 事实、404 自愈、DOM、性能）。

### 1.5 平台、发布与外部凭据

- **gateway**：Linux unit 登录环境；ssh/http cookie 注入未覆盖；旧来源插件播种 400（重建未排期）；运维页缺 `recover-metadata`/`cleanup-version`/`restore-pre-rollback`；S0/S2-c 未实现；设计 21 对齐（只读/seed 端到端、tooltip、英文串）。
- **install/runtime**：`install` 不同步锚（待裁）；dl 运行时 macOS 全链/Linux/gateway 重连/`restartLocal` 交错/ZFS EAGAIN；上游装载面 `compose()` 10.65MiB、`SubagentHeaderLineage` 缺 class、首帧超时；会话可靠性六项；`protobufjs`/`@google/genai` 待 M2 证据。
- **桌面更新（design 11）**：真实 Apple 凭据 CI、双平台清单、通道封签打包态实证；`checkNow()` 在 runCheck 门跳过仍回 ok、渲染门缺 `downloadStallPending` 腿（待裁回 `{ok:false}` 或补腿；判据 = 按钮可点必须有效果或明确禁用）。S-52 = Sparkle quit 与在飞关窗相撞（≤2s 窗、~0.6，未实机；修 = 区分在飞决策/重复退出）。
- **认证 Gateway**：生产 TLS/SPKI/`remote.mux` 恢复、三形态重登/撤销、`/chamber/runtime` TLS、Linux 升级回退、`--bind 0.0.0.0` 负例；凭据重置/改密 CLI。
- **平台**：Windows M0.5–M6（[TODO.md](TODO.md) B§2）；Linux 清单 + `dry_run` + deb/arm64；桌面通知/徽标（macOS 权限/点击/三态、Linux Unity、Windows overlay）。
- **发布/CI**：reusable workflow、submodule 验收、Gateway npm 分发、打包闭包；DMG 并发（`serial` 缺失 + `hdiutil` 弃用未迁移）；CI 无 SMOKE PASS 腿；A1（F6/S1）、A2（A2-4/7）、A3（A3-1…15、S1–S13；判据 = 读失败/未检须可与“通过”区分）、bundle `bundleLayers`、产物新鲜度（web/host-package/allowBuilds，G2/G3/G5/G7/G8；关闭 = 第五类比对或严格档 `build:renderer`）。
- **其余**：SSH 一键免密/钥匙串未实现；模型额外参数待上游；`{detail}` 无 locale；变更文件覆盖率门未接。

### 1.6 一致性债务与门禁缺口

- **导出/门禁**：type-only 导出不判；无入口叶子模块不判（方向 = 孤儿模块门）；`TEST_ONLY_EXPORT_ALLOWLIST` 已规则化；`run-checks tests` 零覆盖可过；`verify:styles` 不覆盖 docs token；`verify:anchors` 无 Windows 覆盖；`install-gateway.sh` 走 npm 绕单源；`test:gateway` 仍有 2 处真装器 spawn。
- **重构/测试**：renderer 外三处 state/ref 镜像、`ssh-<id>` 别名、跨包重复 0 组（[TODO.md](TODO.md) D§1）；CI 打包排练 CPU；Swift 串行 113s（并行会丢 XCTSkip 判据）；升级线残余 = fatal 恢复框键位走查、node-pty 补偿复核。
- **隐私/平台**：`DSH_TELEMETRY_DISABLED` 不覆盖 `session-log-deepseek`，桌面是否默认 opt-out 未裁；`isMainFrame` 归属缺陷；docs 锚点过期（D15）；私有文件纪律三实现；`client-web` 未用 `ui-theme`；layout `ThemePresenter` 残留；wire A–F、sanitize/win-probes、dashboard 第三份 UI、A-U3/A-F16、dual-host。
- **低优 UX**：hover-only、徽标窄窗、en 单数、aria-label、ssh done 态、PluginDialog DOM 测试、对账空态、versionsEpoch、30s 文案、内联 effect。
- **其他**：`verify:i18n` 的 40-hex 例外；gateway 失败分支夹具；归档保护闭包测试；通知收敛器遗留；旧边沿孤岛；页面账本预热接线锁；page-channel 重复实例只报错；`notServingYet` 无生产者；Git 分支候选；B 桥写端行为夹具。

## 二、差异（功能面 / 外部约束）

> 只汇总「app 做什么」与「本仓改不动什么」；明细与候选见 [TODO.md](TODO.md) A§15。

### 2.1 待裁（与 chamber 功能/契约相冲）

- **U1 pinned**：分区已落地；缺块内拖拽/跨块守卫、账号写入（B2）、半开 follow 陈旧标记；候选 A 完整/B 现分区/C 不做（已否）。
- **U2 时间列**：上游行尾相对时间 vs 本仓状态槽；候选 A 状态槽静息分支/B 双尾随/C 不落。
- **U3 快捷键**：四活键（new/fork/archive/rename）；三死键（search/add/openLocal）；注册表封死覆盖，候选 C1 维持/C2 实机判定。
- **U4 重命名**：行内表单 vs 上游 `shell.overlay` 模态。
- **U5 search**：胶囊常驻 vs 上游 inline 展开（过渡/骨架）。

### 2.2 已裁的功能与呈现差异

- **自有功能**：多源列表/分组/折叠、拖拽排序三模式 + view-prefs、归档两段式 + 管理器、新建会话钮/行内重命名、搜索胶囊、机器自持悬停卡、chamber 字标。
- **呈现**：行尾状态槽（时间只在卡）、会话卡状态 0–1、`compact` 菜单（24px/11px）、命中盒=视觉盒、两级标题墨色、动作簇 4px/20px、footer 4px。
- **不做**：`sidebar.toggle.badge`、`sidebar.workspaces` 官方归档/恢复/过滤贡献、跨来源移动；flat/树按 per-source。
- **未照搬的上游交互**：重命名无 trim/重名校验、折叠组 `+` 不展开、搜索不 reveal、添加工作区不自动开会话、rail 无 add、删除确认按 unary 结果关、open-in 分体控件未整控件禁用/portal/key。重议 = 上游退役或交互面重启时并裁。

### 2.3 无法控制的差异（外部约束）

- **键盘**：四活键可达；search/add/openLocal 三死键；注册表 `Duplicate shortcut command`/`Conflicting shortcut defaults` 封死覆盖；未做 = C2 实机判定。
- **悬停卡 tooltip 抑制**：`TooltipSuppression` 未导出 ⇒ 卡片与 tooltip 同现；退役 = 上游导出或自持 tooltip。
- **`HoverCard` pointerleave 竞态**：leave 不 arm ⇒ 卡片机器自持 `hover-intent`。
- **`sidebar.workspaces` 保留声明但不渲染**：撤销会让官方/第三方注册静默消失；上游归档/恢复/过滤为死件；两行座席由 vendor 补丁 13 删除、本仓自声明（design 09 §3.6）。
- **A1 座席 id**：注册台账每实例 ctx 一份；同 registry 同 id 抛错，两个 registry 互不干扰 ⇒「同页两实例必抛」不可复现；待实机复核 `schedule-mark`/`schedules`。
- **面板轴**：`ui-schedule` 页面级 localStorage 键、30s 无 visibility 门、点击埋点未复制；宽态入口盒形/aria 分组/重挂载偏差见 design 06 §4.7。
- **删除 workspace 两帧**：宿主 order/remove 非原子 + client `installOrder` 沉底 ⇒ 行先滑尾；本仓删除意图补偿；外部删除仍复现；上游原子化后退役。
- **平台腿**：Windows `[data-windows-titlebar]` 未抄 ⇒ 侧栏形态不同（排期，非功能选择）。

## 三、设计未决

- C15 hover 触发降级（提案）：改触发面 + 同批改 `AGENTS.md`/触点表/发布策略/静态门。
- 双 flavor parity 仍 open：S-01、G19、S-44、S-10、T-28、S-54（清单见 deviations §1/§2/§4）。
- 上游 host release 门（#6228）在 chamber 不生效：未决采纳（透传 release + 复刻刷新提示）或登记有意差异。
- S-49 原生窗口高度（786 vs 800）；宽度偏好 per-flavor（T-18）。
- macOS Swift 壳 M5 实机矩阵未闭合；Developer ID/公证/stapler/`build-swift` 发布腿缺凭据；双端 harness/通知音效等价物未验。
- 起始端口偏移已定（dsh 17510+1..17514、CP 17500，仅 env 覆盖）。
- Electron 运行时指纹：当前 pin 43.4.0 不在 addon 表内 ⇒ 宿主 exit 1、5 端口全失败；待裁对齐 pin 或等 addon。
- trusted-host 自定义 Host 需同步扩集；多 plane `$DSH_HOME` 隔离未决；catalog metadata 无跨进程 CAS。
- 响应头白名单双处同步；`__DSH_BOOT__` 以 vendor `parseBootManifest` 为准。
- 未挂载源 `workspace/follow` 只读流未决；facts forward-skew 带载荷是否算权威行集未裁。

## 四、范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

> 双 flavor 见 [deviations.md](deviations.md)。

### 4.1 架构、门禁与平台边界

- **God 文件预算例外**：`App.tsx`/`aggregate-store.ts`/`derive.ts` 高于基线，note 记理由；收口 = 放置/删除事实迁到 `workspace-placement.ts`/`workspace-removal.ts`。
- **门禁**：i18n/文档链接/测试接线/死导出/样式 token 为本地例外；seed 自检只报不阻断；测试面再压需显式裁决；`ALLOW_BUILDS` `fs-ext` 保留、`runtime-host-adapter` 不退役、`ownsGeneration()` 保留（勿补测试）；统一名称保留面（bundle id/协议串/`native-shell.page-zoom`/POC 标记）改名须同步 T-14/T-17/T-22 与测试。
- **不做/推迟**：组件工厂 + local slots；0.1.6 五项（`writer-held`/`toggle.badge`/`workspace-tree` 认领/`.dsh-module-fallback`/外部仓 `plugins.bundle.config`）；依赖声明补齐待 lockfile；工程门禁 P2；git 钩子。
- **移出项（P3）**：匿名 control-plane 认证/审计、薄壳会话面、统一索引、broker、通知中心、MCP 不得回流；design 17/18/19/08/20/24 例外不作他域先例。
- **构建/注册**：构建产物移出 git（`build:artifacts` 自举）；注册表降级不剪不落盘（fail-closed）；上游纯镜像 README 死链跳过（C1）；sidebar/layout `lib` 目标与镜像 exports 有意保留。
- **安全/发布**：`--no-auth` 有界例外；Gateway state 0700 + 属主；safeStorage 诚实回退；Windows 无 Authenticode、macOS 不出 x64；发布面临时收窄（三腿 `if:` 跳过，恢复删三处 + finalize）。
- **N-ctx**：单文档信任域；原生键盘单槽（全部 boot 实例 accept）；壳常驻（local 恒留/隐藏最多 1/超限回收）；文档主题/页面语言归 §1.3。
- **registry/元工程**：触点 registry 单一来源、无 Windows 覆盖；R10 文本锁未全量改 import 断言；R11 布局助手受 Swift 锚点；pnpm shim 待打包实机；state 根租约 legacy 一个 minor 后删；Windows 覆盖缺口 R2/R14；R15 ui-layout 分类表；App.tsx 未拆簇；host 域逐域手写有 lockstep；第三类 vendor 补丁（`use-chat-reading`）；ServerSection 预算 raise（1243→1273）；alpha.3 workspace 成员判定待复核；cua 不接入。

### 4.2 产品、界面与运行时取舍

- **通知边界**：P1 只覆盖有壳源；facts-only `beforeBaseline` 不可达；mobile 无该面；facts-only `subagentCount` 仅谱系已认证（watcher 无谱系保持 presence）；paused drop、complete 复用、schedule/job 不覆盖、侧栏无 goal 视觉。
- **降级边界**：已覆盖四座；不覆盖未激活源/壳回收/单槽后报/侧栏无动作；租客 body portal 不受 stacking；连接页 tooltip 无 ARIA。
- **插件**：管理页钉上游结构（`data-plugin-panel`/drag/slot）；重打包无活切换（`restart-required`）；模块表先证互换再复用（release 相同 / profile 字节一致 / ≤8）；刷新控制面 string-key；pluginGraph 无静默看门狗；两条重载无仲裁；chunk-owner 撤销边界；`/plugins/events` 属上游 HMR。
- **连接/来源**：terminal/attach uplink 重连实机验收待做（行为用例 `packages/dsh-api-gateway/test/behavior/client-uplink-support.test.ts`）；open-in 官方页级 localStorage 槽（`dsh.open-in-app.choice`）待按 `chamberBasePath` 分键；N-ctx Markdown 预览仍 document-relative（A 保持降级/B 覆盖补丁待裁）；`chamberFileApiBase` 仅唯一来源断言；远程会话状态/切源白屏实现闭合（实机见 §1.4）、远端空白会话、ui-chat 老代整面失败、未挂载工作区集合仅回声+挂载 push 均按已知降级；`document.hasFocus()` 假设只驱动 `requireHidden`。v1 不做 = 单 store 真融合、控制面会话实时同步、远程实例管理 UI 外壳、跨来源平铺列表。
- **UI 偏差**：B1–B10（默认 manual、unpin 回自然位、家族优先、树展开/拖拽约束、拖拽不切 orderBy、账号成员=可见行、搜索链、归档无 toast、行窗口配额、fork 落尾）；`sidebar.workspaces` 声明不渲染；菜单 `compact`；窗口标题冻结；轨道点裁切；hover 几何无指针腿；导轨无锚点/aria；Git 错误码重叠；折叠 folder 字形不补源码锁。
- **归档**：成功不就地提示 + 筛选降级（未知集禁用整轴）；两段式旧宿主降级（第二调上抛，不做版本探测）；已知代价 = 墓碑撤下后筛选禁用至挂载。
- **运行时/桌面**：Electron 二进制惰性安装；内建版本行引导；dsh 设置面偏差（registry/https-only/周期检查/prune/`RUNTIME_RESTART`）；apply-now 纯投影门；探针契约残余；0.1.2 线降级（硬阻断/芯片隐藏/cookie 30 天/帧校验/`agentPresets`/unary 兜底/首屏整源降级/gateway ready 不蕴含托管就绪）；代理 300MiB；C3 composite 代际；C4 settings 簇；plugin localOnly 不检测。
- **视觉/交互**：标题墨色不照官方；动作簇 4px；会话行键盘不可达；命中盒 <24px；`gap: 4px`；漏事件补丁未落；动作簇键盘入口/roving tabindex 待裁。
- **会话投影**：标签 + `hasActiveSchedule` 跨代际保留（0.6–0.8s；`updatedAt` 前进即停）。
- **上游并存**：experimental worktree 默认关、其产物由 design 08 接管、不复用 create；cua 不接入。
- **设置/账户**：设置壳自绘 chrome/源壳必须挂载/离线占位/body portal；上游对齐轮偏差（首启门、`sectionsEmpty`、失败屏深引、`Switch` 属性、业务蓝、schedule 事实、状态标记/Dock/通知）；桌面账户登录不可闭环（`/oauth/callback` 未反代；裁决 D2 见 [TODO.md](TODO.md) C§1）；`__dshChamberAccountOverlay` 与安全网互搏（待裁）。
