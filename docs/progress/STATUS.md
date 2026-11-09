# 模块完成状态总览（STATUS）

> 只记仍开放项：代码/功能类的未完成/部分完成、设计未决、仍成立的取舍；每条 = 开放事实 + 判据/指针。
> 已实现基线以 git 历史、`CHANGELOG.md`、`docs/design/` 为权威；不记完成叙事、测试计数、哈希、批次与实现过程。
> 本文件是**唯一进度记录**；未排期计划见 [TODO.md](./TODO.md)，双 flavor 差异见 [deviations.md](./deviations.md)；
> 条目的进度状态只在本文件，TODO/deviations 不重复记状态。条目落地或不再成立即删。
>
> **版本范围与冻结清单**：唯一出货 flavor = macOS Swift 原生壳；Electron flavor 已冻结归档、不发布（Windows/Linux 桌面腿随之冻结；Electron 专属历史见 [electron-frozen.md](./electron-frozen.md)）。范围、共享契约、禁用面与复活清单见 [electron-frozen.md](./electron-frozen.md) §1 与根 [`AGENTS.md`](../../AGENTS.md)。

## 一、未完成 / 部分完成

### 1.1 会话链、运行位与页面通道

- **上游 UI 对齐遗留面**：待裁差异见 §2.1，外部约束见 §2.3，明细见 [TODO.md](./TODO.md) A§15。
- **会话链重构（design 14 §D4）**：Swift `RendererRecovery`/`RendererHangWatchdog` 超 ≤90/≤60 目标且未入棘轮；反补丁波次①–④；`tests` 模式 flaky。
- **弱网韧性 v1（design 27）**：终态自愈（`terminalRetryable`）/就绪延展/慢探抖动的滚动升级；PinnedAgent 延期（pin 仍 `agent:false`）；`$events` 宿主 boot id 后续；其余已知限制见 design 27 §6。
- **会话运行位卡死**：②WS 半盲时 transcript 不收敛（宿主 `asOfSeq` 对账未做）；③`session.list` 单飞悬挂；④子代理行不进运行时事实（有意）；⑤隐藏期 watchdog 不 tick；⑨全量性缺水位；⑩集中日志面未做；⑪两处更省形态未落；⑬静默半死（keepalive/游标/`ended(false)` 兜底未做）；⑭修链未闭合（契约写回、90s 界限、ssh 时延、窄缝、行为测试）；⑯子代理环行集与官方不同源待裁。
- **会话打开停滞（design 14 §D4）**：宿主无首帧期限仍是开放项；原 mobile 包内的停滞提示/自动 resync 已随适配层退役——若真实网络下复现，按 host/session 层首帧期限修复（design 17 §18.4），不以恢复 mobile 包为出口。
- **连接稳定性**：24h 494 次 WS 关闭全为 upstream close（local 108 次、0 heartbeat lost），但独立 Node 客户端同 mux 400s 无 close ⇒ 页面侧差异；下一步抓 close code（1006/4000）并对齐 `[chamber:evidence]`。
- **连接加固残余（v0.2）**：`@cert-authority` 证书链校验仍不支持（行被保留但绝不当作 host key；`@revoked` 已拒绝覆盖）；进程级 buffered 预算仍是 scalar（未做 Map<ownerId,bytes>）；buffered inbound 总预算只有单测、缺 createInstanceProxy e2e。host-key/ssh-credentials/ssh-orphan/ssh-socket/http-limits/ssh-askpass 六个模块受 file-budgets 棘轮保护。已知未修边界：4xx 中仅协议类 terminal 的 provider 显式 `terminalRetryable`（身份/版本不匹配，滚动升级窗）按 5m→15m→45m→60m 慢重探自愈；其余 4xx 无宽限窗（自愈 = 手动 connect/通道重连）；bearer 失败无速率限制（依赖 CSPRNG token 熵，legacy scrypt 只有 work gate）；`UpdateHostKeys=no`/`VerifyHostKeyDNS=no` 已 pin，`KnownHostsCommand=none` 仅在 ssh >=8.5 版本门内 pin（exec/run 仍无 host-key pre-gate）；legacy `[host]:port`/hashed 非 22 导入行首次需重新信任（probe 报 known、spawn gate 仍拒绝）；orphan 只按 pid+startedAt、无 cmdline 身份校验。
- **SSH UDS 腿**：残余 = 启动不按 uid 目录清 socket（`StreamLocalBindUnlink=yes` 原路径替换，避免切掉另一 chamber root 的 live listener）；路径按 runtimeBaseDir 短哈希命名（两个 root 不共享 listener）。
- **页面级 HTTP 预算（design 26 §D7）**：②残余通道（connection RPC/script/deferred chunk）不经预算；③bundle 槽无 queueDeadline；④元素/worker 同源加载不在预算。
- **页面通道/事实源残余**：page-channel 上游连接不计反代并发（`stats()` 无消费方）；权威门 producer 无 `reportedAt`；预算拒绝诊断 `not-injected`；gateway 不挂 page-channel 且 `degraded=true` 成因未查。
- **P2b 事实通道降级**：`$events` 有投递；一次定案为插件管理器长 RPC 撞 45s 保险丝（扩容 `LONG_RPC_PATHS` 待裁）；另一次十连败不可区分，出口 = 窗口期差分（Node 默认时序 + unary 探针）。
- **完成身份/判读窗口**：无锚完成跨通道身份不同（最坏重复一条横幅）；`lastAnchoredSeq` 有单调记账；消除需上游 `turn/end` 判别符。facts-only 源无 `beforeBaseline` 首见窗口、P2b 行 `identityConfirmed` 门、facts 不可判时读清/武装冻结。
- **N-ctx 壳常驻（design 05 §4.1）**：③**侧边栏门控/单实例化评估**（触发 = 来源 ≥8 或实测 p95 劣化）：见 [TODO.md](./TODO.md) D§4；④**进程隔离重评条件**：来源 >8 或「一个壳的长任务卡住整页」复现（design 05 §9），重评前先取帧时/长任务证据；⑤手动释放的草稿代价见 §4.2；证据指针 = `packages/renderer/src/resident-policy.ts` / design 05 §4.1。
- **页面侧残余**：流级预算表外 2s/8 两份未锁；forensics request/snapshot 半通道；五条结构性重复/死分支。
- **载波重建节拍（design 27 §3.6/§6.26/§6.27）**：②15s/15s 边界赛跑（teardown 判定的差值 = `15000 − 握手时延`，首轮取决于定时器迟到）见 §6.27，收紧要动表值，未裁；③聚合看门狗的 **stale 臂**按 transport 每 120s(http)/300s(ssh)（replay 不刷新 `snapshotAt` 时退化 60s），**fallback 臂**是 60s 退避而非 120/300——两臂都会产生一次**合法**换代际 ⇒ 三处 UI 仍按其节奏闪；「同批处理 vs 接受并写明」未裁；④三条渲染臂的 caller tag 只在 inspector 在场时可见（warn 级不进 console 环）；OS 唤醒/`online`/长隐藏返回的 liveness 换代在 vendor 车道内部直接 `controller.reconnect()`（`packages/dsh-client-connection/src/client/index.ts`），不经该 seam、成功零日志 ⇒ 该臂只能靠「无前置 `[renderer]` tag 的 `socket-reconnect`」反向推断，或接受不可归因；⑤`CarrierPhase 'silent'` 是死词汇（全仓无写入者，`streamFrame` 只做 silent→open）：保留注释还是删成员（公开 union，需独立改动）未裁。

### 1.2 通知、未读与归档

- **目标活跃期通知/未读压制（design 19 §3.2）**：`activation unknown` 需上游只读面；围栏双发（F30）待裁。
- **事实健康环**：仅无壳 mux 快照、无 in-app 读面；收口 = gateway 采样 + 只读环。
- **归档清理/管理器（design 24）**：残余 = 上游 wire no-op、维护期 force、保护边界；缺陷 = `errors` 通道混用；清理残留 = projcache 4KB、迁移代际窗口；tombstone 由孤儿清扫收敛。
- **工作区删除意图（design 05 §2.2.1）**：列表中部删除不滑尾、最后一行无位移、确定性拒绝不闪回（限单次删除）；四类登记例外与两类派生窄窗（见设计）；上游 order/remove 原子化后退役（§2.3）。
- **侧栏收敛四项 + 整源降级**：会话创建/fork/归档、打开意图/工作区回声（`early-open.ts` 去留）、新 checkout 首帧五项（位置/淡入/确认层/tooltip 裁剪/`data-hover-gate`，判据见 design 06 §7）、会话待办区 10 项。
- **双帧 status**：需宿主轮次键/可信 host 尾时间；无壳观察者 follow 走 remote.mux。
- **会话列表标签**：title→cwd basename→id。

### 1.3 客户端插件与设置

- **设置面残余**：写路径 4–8 人日（台账/字段描述符/密钥存在性）；面板要求源壳挂载（常驻策略下关闭面板后该源成为普通常驻壳，design 05 §4.1）。
- **上游 More 行依赖延迟设置行**：`entry-customization` 的 `pluginNavigation` 只由延迟的 settings-plugin-manager 提供，宿主行停在 PENDING ⇒ 会话头/右栏 More 缺席。残余 = 延迟簇座席存在但读取在处置窗口抛错时 `openPending` 无自动 flush（再次点击恢复）。
- **Git 工作树恢复的 reload 出口**：证明失败/超预算、`path-unavailable` 重放、`git-timeout`/`git-spawn-failed`/`state-source-*`、终态 receipt 重放、create 的未尝试探测失败仍无关闭入口（退出 = reload 后按 fresh Git 事实核对）；细则 = design 08 §6.2。
- **未接入的上游服务面**：会话被动 API（events/state/wait/projections/follow）、`pluginChanges`、异步 `sessionProjections` 句柄迁移（seed-git-worktree 仍懒读 `ctx.get` 并保留 `header.cwd` 回退）；接入点 = design 09 §3.5/§3.6 的复合入口与 seam，需要时按同一注册表接入。

### 1.5 平台、运行时与外部凭据

- **P5b 工作树统一（代码残余）**：node PATH shim / string-only 解析；打包面判据见 design 08 §7.5 与 `docs/checklists/release/packaging-closure-checklist.md`。
- **gateway**：ssh/http cookie 注入未覆盖；旧来源插件播种 400（重建未排期）；运维页缺 `recover-metadata`/`cleanup-version`/`restore-pre-rollback`；S0/S2-c 未实现；设计 21 对齐（只读/seed 端到端、tooltip、英文串）。
- **gateway 启动失败原因对 chamber 不可见**：`state_root_locked` 的 holder 与判定依据只进 journal；客户端只能拿到 socket 级的归因文案（按 ECONNREFUSED/ECONNRESET/EPIPE 分类并指向 gateway 服务与隧道，`packages/desktop/gateway-session.ts` 的登录传输分类），看不到持有者类别与拒绝依据，把结构化原因回传需要一条新的远程诊断面（读 state 根的启动失败记录或 journal 尾）——未排期，是「错误透传」的剩余部分。
- **租约身份的跨平台残差**：`bootId`/`procStartTicks`/`pidNamespace`/`machineId` 只有 Linux 提供（`packages/control-plane/src/process-identity.ts`）；macOS/Windows 的 v2 记录仍只有启动代际推断（依赖墙钟，步进超过 5 分钟余量时可能误判陈旧），同一启动内的 pid 复用保守锁定（宁锁不双写）。跨机护栏要求记录与本机都读得到 machineId，缺失时按「属主私有、单机」契约处理（design 17 §12）。
- **运行时安装现场的 pid 判活（macOS/Windows）**：pid 证据的非 Linux 分支没有 kernel 身份源，仍按同号进程判活——安装中硬崩溃 + pid 复用会阻塞清理；身份源缺口与「租约身份的跨平台残差」同形。
- **install/runtime**：`install` 不同步锚（待裁）；dl 运行时 macOS 全链/Linux/gateway 重连/`restartLocal` 交错/ZFS EAGAIN；上游装载面 `compose()` 10.65MiB、`SubagentHeaderLineage` 缺 class、首帧超时；会话可靠性六项；`protobufjs`/`@google/genai` 待 M2 证据。
- **桌面更新（design 11）**：`checkNow()` 在 runCheck 门跳过仍回 ok、渲染门缺 `downloadStallPending` 腿（待裁回 `{ok:false}` 或补腿；判据 = 按钮可点必须有效果或明确禁用）；S-52 = Sparkle quit 与在飞关窗相撞（≤2s 窗、~0.6；修 = 区分在飞决策/重复退出）。
- **认证 Gateway**：凭据重置/改密 CLI 未实现。
- **其余**：SSH 一键免密/钥匙串未实现；模型额外参数待上游；`{detail}` 无 locale。

### 1.6 一致性债务与门禁缺口

- **门禁局部面**：`i18n` 的 CI/release 落位见 `gate-surfaces.json` 的 `workflow` 生成块；`md-links` / `test-wiring` / `no-dead-exports` / `styles` 按 local-only 决策只在本地跑（`check:static`/`check:full`），不生成 CI 步骤。
- **导出/门禁**：type-only 导出不判；无入口叶子模块不判（方向 = 孤儿模块门）；`TEST_ONLY_EXPORT_ALLOWLIST` 是规则化名单；`run-checks tests` 零覆盖可过；`verify:styles` 不覆盖 docs token；`verify:anchors` 无 Windows 覆盖；`install-gateway.sh` 走 npm 绕单源；`test:gateway` 仍有 2 处真装器 spawn。
- **重构/测试**：renderer 外三处 state/ref 镜像、`ssh-<id>` 别名、跨包重复 0 组（[TODO.md](./TODO.md) D§1）；god-file 预算条目与阈值见 `scripts/gates/registry/file-budgets.json`（`node scripts/gates/checks/verify-file-budgets.mjs --report` 的缺口只按可减目标合计，`kind:ceiling` 单列），但新模块仍需**人工**登记才受保护；CI 打包排练 CPU；Swift 串行 113s（并行会丢 XCTSkip 判据）；升级线残余 = fatal 恢复框键位走查、node-pty 补偿复核。
- **隐私/平台**：`DSH_TELEMETRY_DISABLED` 不覆盖 `session-log-deepseek`，桌面是否默认 opt-out 未裁；`isMainFrame` 归属缺陷；docs 锚点过期（D15）；私有文件纪律三实现；`client-web` 未用 `ui-theme`；layout `ThemePresenter` 残留；wire A–F、sanitize/win-probes、dashboard 第三份 UI、A-U3/A-F16、dual-host。
- **低优 UX**：hover-only、徽标窄窗、en 单数、aria-label、ssh done 态、PluginDialog DOM 测试、对账空态、versionsEpoch、30s 文案、内联 effect。
- **门单源残余**：① 5 个 typecheck（`typecheck:host-graph/host-git/host-archive-cleanup/host-open-in` 与 `typecheck:gateway`）只存在于 `ci.yml` 与 `release.yml` 的手写多行 run（gateway 的 `typecheck:gateway` 另见 `ci.yml` 手写步），registry 无条目 → 四个模式都不含它们，“modes 名字即 CI 所跑”对这 5 步不成立（`seed-client-graph` 的唯一检查完全在模式之外）；② `proof:true` 只覆盖 release 校验 job 的部分生成门步，`C8` rebuild、remote-state acceptance、third-party notices、`release-preflight --actions-only`、renderer SVG scoper 断言、gateway pack/install smoke 均非 proof-required（proof 集合与 id→command 身份面由 `scripts/gates/registry/gate-registry.test.mjs` 的 golden 钉住，改动必须同批改断言）；③ Windows 腿结构上进不了 registry（`gate-registry.mjs` 的 platform 校验只允许 darwin；Windows 腿已随 Electron 冻结删除），6 条 `macos.*` 门无生成块、靠手写步骤执行（命令等价但无 lockstep 测试）。修①需裁决：把手写步并入生成块，或补 registry 条目；④ 生成块之外的手写步骤仍无覆盖网——`gate-workflow-views --check` 只比对四个标记块，旧 `static-gate-parity` 扫整个 job 的能力没有等价替代（静态门的 CI 落位已由 registry 不变量「`workflow` 或 `coveredBy`」拦下，其余步骤仍需人工对照）
- **其他**：`verify:i18n` 的 40-hex 例外；lockfile 断言（`git diff --exit-code -- pnpm-lock.yaml`，`ci.yml` 与 `release.yml` 的多个 job）不在任何模式里，只由 `verify-release-ci-proof.mjs` 的 `NON_GATE_STEPS` 按步骤名保护；gateway 失败分支夹具；归档保护闭包测试；通知收敛器遗留；旧边沿孤岛；页面账本预热接线锁；page-channel 重复实例只报错；`notServingYet` 无生产者；Git 分支候选；B 桥写端行为夹具。`verify-artifact-freshness`（release-checklist 手跑）与 `pnpm run smoke`（ci 步骤）也不在四个模式内，按各自单源执行。
- **首屏体积**：`build:renderer` 两条 warn 越线（chamber entry 与 head CSS）；增量含 `lexical`（ui-conversation 编辑器）与既有的 `simple-icons` 整桶。只 warn 不 fail，阈值不上调（上调会把增长藏起来）；拆分/懒载未排期。

## 二、差异（功能面 / 外部约束）

> 只汇总「app 做什么」与「本仓改不动什么」；明细与候选见 [TODO.md](./TODO.md) A§15。

### 2.1 待裁（与 chamber 功能/契约相冲）

- **U1 pinned**：分区已定；缺块内拖拽/跨块守卫、账号写入（B2）、半开 follow 陈旧标记；候选 A 完整/B 现分区/C 不做（已否）。
- **U2 时间列**：上游行尾相对时间 vs 本仓状态槽；候选 A 状态槽静息分支/B 双尾随/C 不落。
- **U3 快捷键**：四活键（new/fork/archive/rename）；三死键（search/add/openLocal）；注册表封死覆盖，候选 C1 维持/C2 实机判定。
- **U4 重命名**：行内表单 vs 上游 `shell.overlay` 模态。
- **U5 search**：胶囊常驻 vs 上游 inline 展开（过渡/骨架）。

### 2.2 已裁的功能与呈现差异

- **自有功能**：多源列表/分组/折叠、拖拽排序三模式 + view-prefs、归档两段式 + 管理器、新建会话钮/行内重命名、搜索胶囊、机器自持悬停卡、chamber 字标。
- **呈现**：行尾状态槽（时间只在卡）、会话卡状态 0–1、`compact` 菜单（24px/11px）、命中盒=视觉盒、两级标题墨色、动作簇 4px/20px、footer 4px。
- **不做**：`sidebar.toggle.badge`、`sidebar.workspaces` 官方归档/恢复/过滤贡献、跨来源移动；flat/树按 per-source。
- **未照搬的上游交互**：重命名无 trim/重名校验、折叠组 `+` 不展开、搜索不 reveal、添加工作区不自动开会话、rail 无 add、删除确认按 unary 结果关、open-in 分体控件未整控件禁用/portal/key。重议 = 上游退役或交互面重启时并裁。
- **语言面**：官方 UI 8 语言；chamber 自撰文案 zh/en（非 zh 回落 en），layout 快捷键标签随上游镜像 8 语言。

### 2.3 无法控制的差异（外部约束）

- **键盘**：四活键可达；search/add/openLocal 三死键；注册表 `Duplicate shortcut command`/`Conflicting shortcut defaults` 封死覆盖；未做 = C2 实机判定。
- **悬停卡 tooltip 抑制**：`TooltipSuppression` 未导出 ⇒ 卡片与 tooltip 同现；退役 = 上游导出或自持 tooltip。
- **`HoverCard` pointerleave 竞态**：leave 不 arm ⇒ 卡片机器自持 `hover-intent`。
- **`sidebar.workspaces` 保留声明但不渲染**：撤销会让官方/第三方注册静默消失；上游归档/恢复/过滤为死件；两行座席由 vendor 补丁 13 删除、本仓自声明（design 09 §3.6）。
- **A1 座席 id**：注册台账每实例 ctx 一份；同 registry 同 id 抛错，两个 registry 互不干扰 ⇒「同页两实例必抛」不可复现；待复核 `schedule-mark`（owning occupant）与 `schedules` 面板入口（owning 真身 + 外来源回落）。
- **面板轴**：`ui-schedule` 页面级 localStorage 键、30s 无 visibility 门、点击埋点未复制；宽态入口盒形/aria 分组/重挂载偏差见 design 06 §4.7。**跨壳回落**：已挂载来源读页面级 `panel-axis` 发布、未挂载且 connected 来源按 pin 默认组合回落；回落档无 selected 态、未知面板 id 不渲染（pin 升级新增 panellist 注册者须补 `remote-panel-axis.tsx` 字形表并上报待裁）、选中意图 TTL 自点击起算（consume 返回原点击时刻，跨代不重置；激活失败后 TTL 内同来源重激活仍可能消费旧意图并开面板——每来源一条上限，已接受取舍；壳释放/换代不擦在飞意图）、不可激活来源（托管停机/瞬态）不渲染外来源入口（与 header/rail 激活门一致）；A/B 来源 hover 的时钟入口与点击待走查（切来源 + 打开该来源面板）。
- **外来源行无活动定时任务标记**：上游 occupant 只读本实例 Host 任务目录（`schedule/catalog`），chamber 不按来源拉 catalog；旧 `hasActiveSchedule` 会话投影回落链随 pin 移除 `schedule` projection 已删除（design 06 §4.3）。版本歪斜的旧远端宿主（仅缺 identity 方法的极旧宿主会被要求升级，design 27 §3.2）若仍在会话投影里带 `schedule`，chamber 也**有意不读**——恢复需按来源拉 catalog（未做）。判据 = 外来源行与搜索结果行零足迹、owning 行首标记仍由上游 occupant 渲染。
- **删除 workspace 两帧**：宿主 order/remove 非原子 + client `installOrder` 沉底 ⇒ 行先滑尾；本仓删除意图补偿；外部删除仍复现；上游原子化后退役。
- **平台腿**：Windows `[data-windows-titlebar]` 未抄 ⇒ 侧栏形态不同（随 Windows 腿冻结，复活时执行）。
- **壳外拖拽**：补丁后壳外 drag 不再 `preventDefault`，落点导航拦截由 Electron/Swift 两壳各自提供（第三方壳需自带，否则拖入只产生浏览器默认行为）。
- **拖出原生臂缺载体**：随包 `ui-file-drag` 的原生拖出要求 `globalThis.dshDesktop.protocolVersion === 1 && dshDesktop.fileDrag`（`{prepare,cancel,start,release}`）；Electron preload 的 `exposeDesktopCarrier` 只暴露 protocolVersion/updates/keyboard/shortcuts/deviceInfo ⇒ 走浏览器臂（objectURL + DownloadURL），拖到 Finder/资源管理器是「下载式」而非原字节借用。功能可用、属新特性降级；原生臂接通后回验原字节与资源借用。**（Electron 侧原生臂随 flavor 冻结、不排期；Swift 腿不依赖该 preload 载体）**
- **插件页头滚动面 inert**：`createHeaderRef` 随座席注入，但 `EmbeddedPluginManagerPage.module.css` 让 `.page` 高度自适应，页内 `pageBody` 不再自滚 ⇒ sticky/compact 页头不触发（静态页头在，无崩溃）。裁决 = 保持现状或改容器滚动契约。

## 三、设计未决

- C15 hover 触发降级（提案）：改触发面 + 同批改 `AGENTS.md`/触点表/发布策略/静态门。
- 上游 host release 门（#6228）在 chamber 不生效：未决采纳（透传 release + 复刻刷新提示）或登记有意差异。
- S-49 原生窗口高度（786 vs 800）；宽度偏好 per-flavor（T-18）。
- trusted-host 自定义 Host 需同步扩集；多 plane `$DSH_HOME` 隔离未决；catalog metadata 无跨进程 CAS。
- 响应头白名单双处同步；`__DSH_BOOT__` 以 vendor `parseBootManifest` 为准。
- 未挂载源 `workspace/follow` 只读流未决；facts forward-skew 带载荷是否算权威行集未裁。
- P1 结构性收口的两处“编排核心”按**风险/收益**保留，而非“需要依赖容器”：`retireSources`（外部绑定约 75 个、线性扇出）与 `refreshRemotes`（99 行、约 23 个自由变量）可继续拆成 3 段 + 按域输入对象，但收益主要是可测的注销不变量（per-source closers 登记表），行数有限；host-assembly 的订阅体按上一条成对抽即可。seam 级拆分的边界：wire 契约与 gate 单源在 registry/生成块内受约束；renderer 的 6 个大 hook（28 个 app-hook 的其余部分 <200 行）与 desktop/gateway 12 个新模块登记在 file-budgets.json（清单与阈值以表为准）；未拆的两处编排核心即上一条。
- host-assembly 的 `sm.onStatusChanged` 订阅体**可以抽**，但必须与 `onVerified` **成对**抽成同一工厂（二者共享 `registeredTargetKeys`/`registeredAuthFingerprints`）：工厂在组合根原位调用一次、仍同步订阅，注册时机不变。“必须内联”的判断不成立；真约束只剩两处：fail-closed 分支的 `return` 语义逐字保留（`sm.onStatusChanged` 订阅体内）与 6 个同工厂闭包状态的归属。抽完预计 −158 行（以抽取时的基线复测为准）。

## 四、范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

> 双 flavor 见 [deviations.md](./deviations.md)。

### 4.1 架构、门禁与平台边界

- **本文件登记范围**：只记代码/功能类开放项、设计未决与仍成立的取舍；验收 / 发布 / 实机 / 目检 / CI 复核类工作不在本文件登记——程序与门禁在 `docs/checklists/`（release / acceptance / upgrade），发布阻断以 `release-checklist` 与 `packaging-closure-checklist` 的 ❌ 项为准；§1.4 编号保留但不登记（稳定全仓引用）。
- **God 文件预算例外**：`App.tsx`/`aggregate-store.ts`/`derive.ts` 高于基线，note 记理由；收口 = 放置/删除事实迁到 `workspace-placement.ts`/`workspace-removal.ts`。checkout 会话放置失败事实（design 08 §4.2）把 `aggregate-store.ts` +30（事实/通道/两方法）与 `use-bridge-subscriptions.ts` +18（App 订阅）抬过棘轮——note 记理由；桥面方法不可外移，其放置半边随上述收口方向一并考虑。`ServerSection.tsx` 因 0 会话 checkout 空态退役 −8，棘轮同步下调。
- **门禁**：`i18n` 的 CI/release 落位见 §1.6；md-links/测试接线/死导出/样式 token 为本地例外；seed 自检只报不阻断；测试面再压需显式裁决；`ALLOW_BUILDS` `fs-ext` 保留、`runtime-host-adapter` 不退役、`ownsGeneration()` 保留（勿补测试）；统一名称保留面（bundle id/协议串/`native-shell.page-zoom`/POC 标记）改名须同步 T-14/T-17/T-22 与测试。
- **不做/推迟**：组件工厂 + local slots；0.1.6 五项（`writer-held`/`toggle.badge`/`workspace-tree` 认领/`.dsh-module-fallback`/外部仓 `plugins.bundle.config`）；依赖声明补齐待 lockfile；工程门禁 P2；git 钩子。
- **移出项（P3）**：匿名 control-plane 认证/审计、薄壳会话面、统一索引、broker、通知中心、MCP 不得回流；design 17/18/19/08/20/24 例外不作他域先例。
- **构建/注册**：构建产物移出 git（`build:artifacts` 自举）；注册表降级不剪不落盘（fail-closed）；上游纯镜像 README 死链跳过（C1）；sidebar/layout `lib` 目标与镜像 exports 有意保留。
- **安全/发布**：`--no-auth` 有界例外；Gateway state 0700 + 属主；safeStorage 诚实回退；Windows 无 Authenticode、macOS 不出 x64；发布面 = macOS Swift + gateway；Electron 三腿 `if: false` 恒 skipped（冻结归档，恢复按 `electron-frozen.md` §6，不得按旧注释删守卫）；state 根租约对越界拓扑（容器重建挂 volume、NFS 共享根）响亮拒绝，恢复 = 移走 `owner.json`（design 17 §12）。
- **N-ctx**：单文档信任域；原生键盘单槽（全部 boot 实例 accept）；壳常驻——local 恒留 + 用户意图壳常驻（keep-all，无常规空闲退役）；系统投机壳（空闲预热/收割）≤1 后台槽；唯一自动退役 = 硬上限（12）+ 平台化内存压力阀（v1.1）；手动释放 = 设置→通用「性能与内存」；释放写 `prewarmSuppressed`（选中/删源/设置目标清除）；契约见 design 05 §4.1，决策叶 `packages/renderer/src/resident-policy.ts`、页面级快照 `packages/dsh-chamber-client-core/src/resident-store.ts`；文档主题/页面语言归 §1.3。
- **registry/元工程**：触点 registry 单一来源、无 Windows 覆盖；R10 文本锁未全量改 import 断言；settings-plugin-manager 无 typecheck 程序（其 vendor client 面未铺成独立 program），`ctx.get` 显式类型实参一类编译错误只有该包 wiring 测试的反向源锁兜底；R11 布局助手受 Swift 锚点；pnpm shim 待打包实机；state 根租约 legacy 一个 minor 后删；Windows 覆盖缺口 R2/R14；R15 ui-layout 分类表；host 域逐域手写有 lockstep；第三类 vendor 补丁（`use-chat-reading`）；ServerSection 预算 raise（1243→1273）；alpha.3 workspace 成员判定待复核；cua 不接入。

### 4.2 产品、界面与运行时取舍

- **N-ctx 壳常驻（design 05 §4.1）**：①**每壳字节内存不可得**（N 壳共享一个 renderer JS 堆/渲染进程，Chromium/WKWebView 无按壳归属读数）——可得的是页面级事实（状态/隐藏时长/DOM 节点数）与整机系统内存（`settings.get` 可选 `system`）；②**critical 压力可丢草稿**（只在 `critical` 且非活动/屏上壳；活动壳永不释放，但后台壳内未提交草稿/未保存表单无法在释放前保存）；③**设置面板挂载的源常驻**（面板 hold 只保证打开期间不被释放；关闭后成为普通常驻壳，不再自动释放）；④系统内存是 30s 采样而非实时，`critical` 释放可能滞后一个窗口——宁滞后不误杀；⑤投机壳 ≤1 是唯一后台槽约束，硬上限 12 不随设置变化（无可配置档位）；⑥**「性能与内存」面板与手动释放只在调试模式开启时存在**——诊断/手动控制面不是常设设置面；关闭调试模式后无可视手动释放入口（自动退役仍生效），需要时先开调试模式。
- **通知边界**：P1 只覆盖有壳源；facts-only `beforeBaseline` 不可达；facts-only `subagentCount` 仅谱系已认证（watcher 无谱系保持 presence）；paused drop、complete 复用、schedule/job 不覆盖、侧栏无 goal 视觉。
- **降级边界**：覆盖四座；不覆盖未激活源/已释放壳（manual/cap/valve 后）/单槽后报/侧栏无动作；租客 body portal 不受 stacking；连接页 tooltip 无 ARIA。
- **插件**：管理页钉上游结构（`data-plugin-panel`/drag/slot）；重打包无活切换（`restart-required`）；模块表按 id 唯一、跨实例一律复用原 factory（`reuseForeignBuilds`；release/内容证明只决定连接页是否提示，≤8 次校验）；刷新控制面 string-key；pluginGraph 无静默看门狗；两条重载无仲裁；chunk-owner 撤销边界；`/plugins/events` 属上游 HMR。
- **连接/来源**：open-in 官方页级 localStorage 槽（`dsh.open-in-app.choice`）待按 `chamberBasePath` 分键；N-ctx Markdown 预览仍 document-relative（A 保持降级/B 覆盖补丁待裁）；`chamberFileApiBase` 仅唯一来源断言；远程会话状态/切源白屏实现闭合、远端空白会话、ui-chat 老代整面失败、未挂载工作区集合仅回声+挂载 push 均按已知降级；`document.hasFocus()` 假设只驱动 `requireHidden`。v1 不做 = 单 store 真融合、控制面会话实时同步、远程实例管理 UI 外壳、跨来源平铺列表。
- **UI 偏差**：B1–B10（默认 manual、unpin 回自然位、家族优先、树展开/拖拽约束、拖拽不切 orderBy、账号成员=可见行、搜索链、归档无 toast、行窗口配额、fork 落尾）；`sidebar.workspaces` 声明不渲染；菜单 `compact`；窗口标题冻结；轨道点裁切；hover 几何无指针腿；导轨无锚点/aria；Git 错误码重叠；折叠 folder 字形不补源码锁。
- **归档**：成功不就地提示 + 筛选降级（未知集禁用整轴）；两段式旧宿主降级（第二调上抛，不做版本探测）；已知代价 = 墓碑撤下后筛选禁用至挂载。
- **运行时/桌面**：Electron 二进制惰性安装；内建版本行引导；dsh 设置面偏差（registry/https-only/周期检查/prune/`RUNTIME_RESTART`）；apply-now 纯投影门；探针契约残余；0.1.2 线降级（硬阻断/芯片隐藏/cookie 30 天/帧校验/`agentPresets`/unary 兜底/首屏整源降级/gateway ready 不蕴含托管就绪）；代理 300MiB；C3 composite 代际；C4 settings 簇；plugin localOnly 不检测；prune 保留 `docs/` 运行时文档（任意深度；`docs/` 内附属物目录与包内技能 Markdown 仍被裁，design 18 §3.7/§4.1）。
- **视觉/交互**：标题墨色不照官方；动作簇 4px；会话行键盘不可达；命中盒 <24px；`gap: 4px`；漏事件补丁未落；动作簇键盘入口/roving tabindex 待裁。
- **会话投影**：标签跨代际保留（0.6–0.8s；`updatedAt` 前进即停）。
- **P5b 工作树统一（开放取舍）**：①**Swift 保留**原生壳与 sidecar；Node 统一取 primary-runtime payload（单 Node 裁决，sidecar.js 与托管 dsh 同一 `process.execPath`，进程名 `node`；不再有独立 `dsh-chamber-helper`）；Electron 分支随冻结归档、不在本裁决内（`process.execPath` 不被改写），不做 sidecar 移除或回退形态；②forge bundle **opt-in**（默认关、启用/关闭需重启，GitHub provider disabled），不预置进 profile；③旧 `$DSH_HOME/worktrees` 池**不迁移、不检测、不提示**；升级前逐树 `workspace.delete`（归档需保留的会话）+ `git worktree remove/prune` 是 **0.4.4 一次性历史迁移**的前提（design 08 §7.4），后续版本不再作为发布前提；④filters 与 forge 两步 parity，接受 LFS/clean-smudge 降级（checkout 为指针文件，需手动 `git lfs pull`）；⑤restore 仅 forge record（seed 树无 restore）；⑥`checkoutOrder` 只在本机 localStorage 持久化、不跨实例同步；⑦同一 checkout 允许 0..N 会话共享 HEAD/index（无默认提示、无硬锁）；⑧只发布池内 checkout，池外手工树不可见。判据 = design 08 §3/§5/§7。
- **上游并存**：experimental worktree 默认关**仍真**（P5b 为 opt-in，需在实例插件页开启并重启）；P5b 下 forge 与 seed 共用 `<repo>/.agents/worktrees` 池，checkout 由 design 08 的派生行呈现，官方 `create_worktree` 工具与 composer 都复用同一池（“其产物由 design 08 接管、不复用 create”的旧裁决不再适用）；GitHub provider 由 overlay disabled；cua 不接入。
- **设置/账户**：设置壳自绘 chrome/源壳必须挂载/离线占位/body portal；上游对齐轮偏差（首启门、`sectionsEmpty`、失败屏深引、`Switch` 属性、业务蓝、schedule 事实、状态标记/Dock/通知）；桌面账户登录不可闭环（`/oauth/callback` 未反代；待做与边界见 [TODO.md](./TODO.md) C§1）；`__dshChamberAccountOverlay` 与安全网互搏（待裁）。
- **跨实例 rev 冲突 = 静默复用 + 连接页提示**（design 09 §3.5）：跨实例一律沿用页面已有 factory（`reuseForeignBuilds`），实例 boot 不因该冲突失败；代价 = 跨发布构建可能与宿主预期不一致（缺块/行为异常），由连接页诊断点名两侧发布版本与收口，且 local 无图降级时构建来源可能反转（design 09 §3.5 残余风险）；复验 = `packages/renderer/test/lifecycle/host-graph.test.ts` 冲突用例。
- **右栏浏览器 v2（design 28 §16/§16.11）**：面板与上游 `ui-sidebar-browser` iframe 路径逐字同源（唯一差异 = SSH 反代：iframe src + 代理页 external alias 投影）；沿用 v1 = 无共享 `127.0.0.1` 回退（Host 被拒/421 = 可读错误，不降级；远端未配 `127.0.0.n` 的服务打不开）、OTP/2FA 主机不支持（每条 forward 独立 ssh）、`kill -9` 后 listener 存活到下次启动、被转发页面可无预检访问本机 loopback（PNA 残余）；新增/保留取舍 = 任意 http(s) 页面可 iframe（含 https；上游语义，证书不匹配直接表现为 iframe 失败条/工具栏 external 出口，不自动转系统浏览器）、XFO/frame-ancestors/TLS 不做可靠探测或 refusing UI（上游语义；W-15 旧 refusing 判据退役）、上游 sandbox 允许 popups，Electron `setWindowOpenHandler` 仍 deny 新窗口并把外链转系统浏览器（Swift 子 frame 的新窗不转系统、仅主文档外链转——有意更严，design 28 §16.11）、`list.embedding` 能力字段保留但 v2 fork 无 UI 消费者（生产恒 enabled；紧急回退 = 启动点收回 `frameSources`）、下载仍只允许 app-origin blob、`localhost`/公网/其它 host 按上游直连（只有 host 恰为 `127.0.0.1` 的 SSH 目标走 forward）、local iframe 与 app 同 host 共享 cookie jar、跨 site 第三方 cookie/SameSite 可能让认证型页面退化（E1）、隐藏 session 的 keepMounted tab 常驻占 8/source 配额、用户打开的源壳按 keep-all 常驻（design 05 §4.1；只有显式释放路径才拆壳，拆壳即释放该源 iframe/forward）、站点数据无手动清除（删源/retarget 清、tab 关闭不清）、上游 store persist key 在 N-ctx 同 sessionId 下跨来源共享 localStorage 条目（上游 known boundary）——均登记为已知取舍，不是待修缺陷。
- **上游新面（More / New Session）的取舍**：桌面复合体**不采纳侧栏 More**（chamber 侧栏不声明 `sidebar.panellist.actions`，`entry-customization` 的该注册停在等待态；`panel-pins.ts` 登记 `dropped`，采纳触发见 TODO A§15/U6）；gateway 的官方侧栏照常显示。**New Session 复用空白会话**（全局按钮/快捷键）：宿主把复用的空白切到默认预设；仅当该空白的 Agent 仍加载时保持创建时组成，重启后按当前定义（官方 guide 14/16/20）；chamber 的来源「+」仍按来源复用（只打开复用行，不走上游 `connectWorkspace` 的 sessionId 语义）；接受，不包裹。
