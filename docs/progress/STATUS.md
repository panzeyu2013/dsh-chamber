# 模块完成状态总览（STATUS）

> 只记仍开放项：未完成/部分完成（含实机与打包态门禁）、设计未决、仍成立的取舍；每条 = 开放事实 + 判据/指针。
> 已实现基线以 git 历史、`CHANGELOG.md`、`docs/design/` 为权威；不记完成叙事、测试计数、哈希、批次与实现过程。
> 本文件是**唯一进度记录**；未排期计划见 [TODO.md](TODO.md)，双 flavor 差异见 [deviations.md](deviations.md)；
> 条目的进度状态只在本文件，TODO/deviations 不重复记状态。条目落地或不再成立即删。

## 一、未完成 / 部分完成

### 1.1 会话链、运行位与页面通道

- **I-15 上游漂移实机记录**：六组矩阵（P6、归档两段式+恢复、通知四缺口、运行位 60/190/310s、I-14 selection scope、I-12 谱系压制）待打包态/真机各跑一次；执行序见 `gui-acceptance-checklist.md` §4.1，判据见 [TODO.md](TODO.md) A§14.1。
- **上游 UI 对齐遗留面**：待裁差异见 §2.1，外部约束见 §2.3，明细见 [TODO.md](TODO.md) A§15。
- **会话链重构（design 14 §D4）**：60/190/310s、ssh 写回时延、macOS 腿、集中日志面待校准；Swift `RendererRecovery`/`RendererHangWatchdog` 超 ≤90/≤60 目标且未入棘轮；反补丁波次①–④；`tests` 模式 flaky。
- **弱网韧性 v1（design 27）**：真实 WAN/ssh 中继下的 100/300ms、1/5% 丢包、10s 黑洞、20s flap、真机睡眠/切网（resume/online 复验）与 `verifyUpBudgetMs` 复合预算（gateway 口令 35s / dsh 5s）待人工确认；终态自愈（terminalRetryable）/就绪延展/慢探抖动的滚动升级与真机门禁同批待验；本机 `pnpm run acceptance:netem` 可复跑 veth+netem（真实 tc/真代理；`NETEM_BULK_UPLOAD=1` 追加 20MB@2Mbit），不替代真实 WAN 与真机睡眠。另：打包态入站 `client-body idle` 慢上传（loopback 已证 35s `requestTimeout` 不约束）、`$events` 宿主 boot id 后续、PinnedAgent 延期（pin 仍 `agent:false`）；其余已知限制见 design 27 §6。
- **会话运行位卡死**：①lane 复现未接 CI；②WS 半盲时 transcript 不收敛（宿主 `asOfSeq` 对账未做）；③`session.list` 单飞悬挂；④子代理行不进运行时事实（有意）；⑤隐藏期 watchdog 不 tick；⑥阈值/N=2/写回链未实机校准；⑦vendor 语义由 `vendor-session-fact-contract.test.ts` 钉住；⑧日志取证价值未验；⑨全量性缺水位；⑩集中日志面未做；⑪两处更省形态未落；⑫对话流健康臂未实机验；⑬静默半死（keepalive/游标/`ended(false)` 兜底未做）；⑭修链未闭合（契约写回、90s 界限、ssh 时延、窄缝、行为测试）；修正 provenance 的 I3 臂无 host 证据不通知，实机矩阵未跑；⑮运行位解析未实机校准；⑯子代理环行集与官方不同源待裁。
- **会话打开停滞（design 14 §D4）**：宿主无首帧期限仍是开放项；原 mobile 包内的停滞提示/自动 resync 已随适配层退役——若真实网络下复现，按 host/session 层首帧期限修复（design 17 §18.4），不以恢复 mobile 包为出口。
- **连接稳定性**：24h 494 次 WS 关闭全为 upstream close（local 108 次、0 heartbeat lost），但独立 Node 客户端同 mux 400s 无 close ⇒ 页面侧差异；下一步抓 close code（1006/4000）并对齐 `[chamber:evidence]`。
- **连接加固残余（v0.2）**：`@cert-authority` 证书链校验仍不支持（行被保留但绝不当作 host key；`@revoked` 已拒绝覆盖）；进程级 buffered 预算仍是 scalar（未做 Map<ownerId,bytes>）；buffered inbound 总预算只有单测、缺 createInstanceProxy e2e。host-key/ssh-credentials/ssh-orphan/ssh-socket/http-limits/ssh-askpass 六个模块已在 file-budgets 受棘轮保护。已知未修边界：4xx 中仅协议类 terminal 的 provider 显式 `terminalRetryable`（身份/版本不匹配，滚动升级窗）按 5m→15m→45m→60m 慢重探自愈；其余 4xx 无宽限窗（自愈 = 手动 connect/通道重连）；bearer 失败无速率限制（依赖 CSPRNG token 熵，legacy scrypt 只有 work gate）；page unary lease 5min 小于大 mutation 60min（≥3 个 >5min mutation 才低估在飞量）；`UpdateHostKeys=no`/`VerifyHostKeyDNS=no` 已 pin，`KnownHostsCommand=none` 仅在 ssh >=8.5 版本门内 pin（exec/run 仍无 host-key pre-gate）；legacy `[host]:port`/hashed 非 22 导入行首次需重新信任（probe 报 known、spawn gate 仍拒绝）；orphan 只按 pid+startedAt、无 cmdline 身份校验；long-RPC 只有 owner 级 8 槽、无 per-connection 公平份额（一个实例可占满，另一实例的 long 命令会 503）。
- **SSH UDS 腿**：POSIX UDS 已落地（`-L <socket>`、`StreamLocalBindUnlink=yes`、`ControlMaster=no/ControlPath=none`、orphan 账本清扫、socketPath 贯穿探针/代理/page-channel）；残余 = Windows TCP 等价物未实机、macOS `ps -o lstart=` 与长 `TMPDIR` 未实机、无真实 gateway-over-UDS 端到端、启动不按 uid 目录清 socket（`StreamLocalBindUnlink=yes` 原路径替换，避免切掉另一 chamber root 的 live listener）；路径已按 runtimeBaseDir 短哈希命名（两个 root 不再共享 listener）。判据 = UDS 端到端 + argv + orphan 负控（design 05 §8）。
- **degraded 服务化真机验收**（design 02 §3.5 / 04 §4.2）：打包态与真机尚未复验 degraded 窗口内页面与 gateway 的实际体验（45s 超时/504 而非快速 503）、旧客户端（≤ 0.4.2）忽略 503 `details.state` 的兼容、以及 stopped/restart-exhausted 的终态文案是否点到「启动实例」；另需确认「活着但不再服务」的宿主最长约 10min（20×30s 周期探测，请求失败不加速恢复）在真机上可接受；判据 = 远端 gateway 升级后的 journal + 打包态目检。
- **页面级 HTTP 预算（design 26 §D7）**：①参数 `4/1/2` 待真机标定（queueMs p50/p95、`zeroWaitGrants`、leaseExpired、成功率、bundle 帽对 boot 影响）；②残余通道（connection RPC/script/deferred chunk）不经预算；③bundle 槽无 queueDeadline；④元素/worker 同源加载不在预算。
- **页面通道/事实源残余**：page-channel 上游连接不计反代并发（`stats()` 无消费方）；权威门 producer 无 `reportedAt`；预算拒绝诊断 `not-injected`；gateway 不挂 page-channel 且 `degraded=true` 成因未查；design 26 打包态复验未跑。
- **本地 facts 间歇降级**：待真机 fetch 排队测量（≥3 个 SSH 慢源时 in-flight 是否恒 6；`unscheduled booked=false` 与慢窗口同拍；单慢源阴性对照）。
- **P2b 事实通道降级**：`$events` 有投递；一次定案为插件管理器长 RPC 撞 45s 保险丝（扩容 `LONG_RPC_PATHS` 待裁）；另一次十连败不可区分，出口 = 窗口期差分（Node 默认时序 + unary 探针）。
- **完成身份/判读窗口**：无锚完成跨通道身份不同（最坏重复一条横幅）；`lastAnchoredSeq` 已有单调记账；消除需上游 `turn/end` 判别符。facts-only 源无 `beforeBaseline` 首见窗口、P2b 行 `identityConfirmed` 门、facts 不可判时读清/武装冻结。
- **性能遗留（P0–P2）**：五条实机复测 + 全视图 DOM ≤13,000（实测 15,805 含壳 chrome）；已知取舍（蓝点/通知暂停、桥探测 30s 长尾、purged 孤儿键 K=2）；待真机 = 隐藏 ≥60s 唤醒、SVG scope 探针、风暴档发布速率。
- **Swift 壳性能 A/B**：启动/大载荷 p95/空闲 wakeups 待打包态；`[shell-fps]` 被 `!isPackaged` 编译掉；判据 = 空闲安装率 <200/s、静默 CPU <10%。
- **页面侧残余**：流级预算表外 2s/8 两份未锁；forensics request/snapshot 半通道、carrier `openingAnswered` 无生产消费者；五条结构性重复/死分支。
- **载波重建节拍（design 27 §3.6/§6.26/§6.27）**：①真机 soak 待跑——原判据「`carrier-throttled[laneReconnect]` → `carrier-throttle-expired` → `carrier-rebuild` 三连」在改动后**结构上不可能出现**（expired 只由证据型 arm 发出），恒真不可伪，改为三条可伪信号：(a) `control-plane.log` 的 `closed (cause, Nms)` 间隔与 socket 寿命不再聚在 60s（旧形态实测恒 60000ms）；(b) `carrier-throttle-expired` 的 cause 只允许证据型（`socketNoFrame`/`openingStall`/`teardownNoFrame`），lane 拒绝后不再排期；(c) 注入证据故障（半开/零帧）时证据型重建仍发生（恢复面未退化）。对齐面 = `control-plane.log` + 页面 `dsh-chamber:stream-forensics`（须 inspector 实时监听：环 cap 256、flush 清空、无持久消费面；代理日志不含 close code，要 code 需另加日志）；②15s/15s 边界赛跑（teardown 判定的差值 = `15000 − 握手时延`，首轮取决于定时器迟到）见 §6.27，收紧要动表值，未裁；③聚合看门狗的 **stale 臂**按 transport 每 120s(http)/300s(ssh)（replay 不刷新 `snapshotAt` 时退化 60s），**fallback 臂**是 60s 退避而非 120/300——两臂都会产生一次**合法**换代际 ⇒ 三处 UI 仍按其节奏闪；「同批处理 vs 接受并写明」未裁；④三条渲染臂的 caller tag 只在 inspector 在场时可见（warn 级不进 console 环）；OS 唤醒/`online`/长隐藏返回的 liveness 换代在 vendor 车道内部直接 `controller.reconnect()`（`packages/dsh-client-connection/src/client/index.ts`），不经该 seam、成功零日志 ⇒ 该臂只能靠「无前置 `[renderer]` tag 的 `socket-reconnect`」反向推断，或接受不可归因；⑤`CarrierPhase 'silent'` 是死词汇（全仓无写入者，`streamFrame` 只做 silent→open）：保留注释还是删成员（公开 union，需独立改动）未裁。

### 1.2 通知、未读与归档

- **通知壳 sink `runtimeSettled`（I2）**：两 sink 共用 `completionAlreadySettled`（fail-open，只影响抑制）；打包态需证「同页、非首批、producer 重置后的壳完成重放」不再双发；候选证据门、`factsContradictsIdle`、Dock 读回、`facts-health` 保底名额待复核。
- **目标活跃期通知/未读压制（design 19 §3.2）**：N 轮 `held≥1 && sent==0`、outcome 后一条、六面同拍、reload/冷启、撤回、local/gateway/SSH 各一组；activation unknown 需上游只读面；围栏双发（F30）待裁。
- **P6 完成未读实机**：官方位读数（武装/清除/重载即空/修正臂）与六面矩阵（侧栏/搜索/待办/Dock/通知/诊断）；local+gateway+SSH（design 06 §4.1–§4.3）。
- **通知行为缺口**：点击二级门、主进程握手、设置页渲染、`pagehide` flush。
- **事实健康环**：仅无壳 mux 快照、无 in-app 读面；收口 = gateway 采样 + 只读环。
- **归档清理/管理器（design 24）**：打包版目检、探针 fail-closed、>65,536 不清扫、gateway/远程实机；两段式与恢复路径实机未跑；残余 = 上游 wire no-op、维护期 force、保护边界；缺陷 = `errors` 通道混用；清理残留 = projcache 4KB、迁移代际窗口；tombstone 由孤儿清扫收敛。
- **工作区删除意图（design 05 §2.2.1）**：列表中部删除不滑尾、最后一行无位移、确定性拒绝不闪回（限单次删除）；四类已登记例外与两类派生窄窗（见设计）；上游 order/remove 原子化后退役（§2.3）。
- **侧栏收敛四项 + 整源降级**：会话创建/fork/归档、打开意图/工作区回声（`early-open.ts` 去留）、新 checkout 首帧五项（位置/淡入/确认层/tooltip 裁剪/`data-hover-gate`，判据见 design 06 §7）、会话待办区 10 项。
- **双帧 status**：需宿主轮次键/可信 host 尾时间；无壳观察者 follow 已走 remote.mux，须真实宿主核对。
- **受管日志取证**：真机未验；隐私代价（含会话内容）；仅本地 spawn。
- **会话列表标签**：title→cwd basename→id；无额外实机门禁。

### 1.3 客户端插件、设置与移动端

- **插件热同步（design 09 §3.7）**：真实 add/remove 帧、ssh/gateway 各一源、卸载边界、隐藏回收无迟到写、宿主重启活行存活、图回归（60s 有界探测）待实机。
- **插件刷新收敛（design 09 §3.7/15 §6）**：装/启/卸后不按 Cmd+R 即时出现；同 id 新 rev 5s 内自动重载一次不循环；宿主帧先于结算的竞态；跨实例冲突不在设置页出条（只在连接页呈现）；在途动作不被重载打断；restart-required 不谎报。判据 = 5 个测试 + 目检。
- **遮罩/揭幕 P0–P3**：W-1b 真机走查、揭幕时延、Swift 发布包 Safari 抽检。
- **files seat（D-01=B）**：Files 页签出现「打开当前文件夹」、per-source 语义、官方占座 inert；判据 = 2 测试 + 目检。
- **登录 shell 环境（design 02 §3.1）**：Dock/Finder 启动下两 flavor 读到 PATH/代理/API key；失败可定位、不阻塞；`DSH_*` 不被覆盖；判据 = 1 测试 + 实机。
- **移动端真机抽检（design 17 §18.6）**：移动适配包已退役，布局/触控/键盘由上游前端负责；待跑 = iPhone Safari（键盘/图标/tap）、Android Chrome、iPad 834（确认接受上游 56px rail）与 390/768/834 的 `acceptance:mobile` 走查。若复现硬缺口，按 design 17 §18.4 在上游或 host/renderer 层修复。
- **N-ctx 主题/语言**：打包态目检；冷启动变化 ≤1、预热/收割 0，另验同帧性。
- **设置面残余**：写路径 4–8 人日（台账/字段描述符/密钥存在性）；面板要求源壳挂载；打包态冒烟。
- **rc.3 More 行依赖延迟设置行**：`entry-customization` 的 `pluginNavigation` 只由延迟的 settings-plugin-manager 提供，宿主行停在 PENDING ⇒ 会话头/右栏 More 缺席。延迟簇的 `Promise.all`（`registerDeferred`，`packages/renderer/src/chamber-entry.ts`）无 deadline：chunk **reject** 时按行 id 上报、只该延迟行失败（延迟簇其余行照常挂载）；chunk **悬挂**时整簇不挂载且零报告。判据 = 延迟 chunk 失败 drill + 悬挂 drill + 目检；座席存在但读取在处置窗口抛错时 `openPending` 无自动 flush（再次点击恢复），同 drill 覆盖。
- **Git 工作树恢复的 reload 出口**：证明失败/超预算、`path-unavailable` 重放、`git-timeout`/`git-spawn-failed`/`state-source-*`、终态 receipt 重放、create 的未尝试探测失败仍无关闭入口（退出 = reload 后按 fresh Git 事实核对）；细则 = design 08 §6.2。
- **未接入的上游服务面**：会话被动 API（events/state/wait/projections/follow）、`pluginChanges`、异步 `sessionProjections` 句柄迁移（seed-git-worktree 仍懒读 `ctx.get` 并保留 `header.cwd` 回退）；接入点 = design 09 §3.5/§3.6 的复合入口与 seam，需要时按同一注册表接入。
- **远端浏览器（design 28）**：W0/S1/S2 实现面；入口门 = 除 http 外全部来源（local / dsh+ssh / gateway+ssh；gateway+http 不出现），local 无远端分区、loopback 地址直接本机打开，gateway+ssh 与 dsh+ssh 同一条转发路径。官方 `ui-sidebar-browser` 在 web profile 恒禁用已核实（desktop-only 条件 + 宿主恒 `--profile web`），不再是开放项。开放验收 = ①真实 pin vendor 下 renderer composite typecheck/build；②S2 真实 boot；③S3 Swift/app 打包与签名；④真实 SSH askpass（密码主机）、macOS/Windows 实机（alias 可达/secure context/Host、win32 taskkill/CIM、reaper 身份）、全量 `test:desktop`；真实 sshd 的转发验收（`test/forward/forward-real-ssh.test.ts`）只在 Linux + root 且 sshd/ssh-keygen/ssh 齐备时执行，`scripts/test.mjs` 以 `guard: 'registered'` 把非 root 腿记为**合法跳过**——它因此不是 CI 覆盖，真机/特权环境仍要各跑一次；编译态存储验收（`test/forward/forward-storage-compiled.test.ts`）需要 `dist/control-plane`（`build:control-plane`），同一 guard 让缺该产物的腿合法跳过（tests 模式不自举它），打包态或本地全构建后必须真跑；⑤完整 sidecar 发布需 vendor/dsh + python。判据 = design 28 §11/§12；验收程序 = `docs/checklists/remote-browser-acceptance.md`；打包名单 = packaging closure。

### 1.4 打包态与真机门禁（按来源/版本）

**壳与窗口**：T-10 调试模式人工判；多来源 sleep/wake、版本歪斜、gateway 回归；隐藏/遮挡（S-10：rAF/定时器/`visibilityState`/App Nap、≥60s 页面通道与 mux、唤醒重连、30s 轮询补偿）；macOS chrome（红绿灯 (16,18)、vibrancy、Reduce Transparency、`data-fullscreen`、失败页、整窗拖动）；ProMotion 三工况（插电 120/低电 60/60Hz 外屏不回退）；原生席位/W7 语言与主题；托盘图标（等高不裁、与 Swift 18pt 一致）；设置页拖拽（按下可拖、正文不被选择、按钮可点）；S-50 根级回弹（整页零位移、滚动/惯性/键盘无回归）；Swift soak（流式中点开 ×20、mux churn）。

**来源与启动**：vendor 补丁可见态 A/B；右栏栈/session v3 迁移；open-in host 包（两代探针、图标/缓存/CSP/fence/cwd、macOS 清单、Windows 盘符/UNC、第三方 scheme）；终止失败闩锁；写者静默门（409 停 `starting`）；降级提示三处；切源座席/字标；boot 死区（idle 不启、1.5s 判死、10s 重试、502 自愈）；idle 排队 68s。

**桌面宿主路径（S-56）**：打包态按 design 25 §5.7 的五组判据（拖入/回形针/粘贴 flavor/回退归属/负控）逐项走查；证据 = `[shell] 宿主路径快照` 行；判据 = 4 测试 + 本实机。

**Swift 运行期**：首载按 `/health` 等 ready；首屏后无周期健康探测/重启入口；`didCommit` 后缺期限；宿主 cwd/安装根两条。

**上游 pin 新面（无 GUI 未跑）**：
- 基线：0.2.2-rc.1 未复跑（相对 alpha.3 为纯版本串，依赖闭包 9 个 @deepseek-ai/* 包同批升稳定版；其新面并入下方各行）；pin 三项（内置插件页、跨代 profile、gateway 就地升级）挂账（移动端改由上游前端负责，见 §1.3）。
- rc.3（仅该来源）：①会话头视图折叠 + More（Trajectory 行在延迟簇注册视图，默认出现）；②右栏 guide More；③「浏览」落到设置→插件管理（plugin-navigation 座席）；⑤New Session 全局按钮复用空白会话（复用保持创建时预设）。判据 = 含已打开会话的 More/浏览 走查 + 打包态真机（本次机械 live/走查未打开会话，不覆盖本行）；⑤ 另判：已有空白会话（含非默认预设）时点全局「新会话」→ 会话行数不增、落回同一 `[data-session-id]`、预设不变；杀宿主重启后按当前定义重判。侧栏 More 不采纳见 §4.2。
- 0.2.2（仅该来源）：官方 8 语言界面（chamber 自撰文案仍 zh/en，layout 快捷键标签随上游镜像 8 语言）、`fileDrag` 图片拖拽与文字选区浮条、官方新 client 行（action-cards / creation-recommendations / plugin-recommendations / message-quotes / cua）在 N-ctx 目检；判据 = 打包态真机（机械 live/走查不覆盖本行）；风险 = 新行若成为首屏根 inject 的强制依赖须升 covered factory（design 09 §3.5）。
- 0.2.2-alpha.3（仅该来源）：①右键上下文菜单（`ui-context-menu` 升 covered 首屏：`useContextMenu` root prop + `contextMenus` service）在 N-ctx 目检——文件/图片右键、键盘 ContextMenu/Shift+F10、Escape 关闭、焦点归还；②窄窗 drawer（帧宽 <768px，vendor AppFrame 覆盖层）走查——mask/Escape 关闭、`data-shortcut-modal=sidebar` 与 Cmd/Ctrl+B 放行、窄窗进出 store 分支（`SIDEBAR_DRAWER_BREAKPOINT`）与上游一致；③`ui-file-actions` 仍由宿主图加载（文件菜单走 `remote.workspaceFiles.readBytes`，per-entry base），图片目标在缺 `path`/`sessionId` 时回退 `target.url`——判据 = 远端实例右键图片的复制/下载实测（失败则按 design 09 §3.6 给 `ui-attachment` 补 base）；④桌面 `dshDesktop.fileActions` 座位未采纳（`canSaveAs=false`，下载走 blob），与 S-25/fileDrag 载体缺口同型；⑤drawer 内 `newSession` 的 darwin 填充未镜像上游 `:where(.root:not([role='dialog']))` 门控（Swift 锁步要求带 vibrancy 的裸选择器）＝纯视觉差异。判据 = 打包态真机 + 上述机器门（`test:layout`/`test:sidebar`/`build:renderer` 的 patch marker）。
- include journal（0.2.2-alpha.3）：loader rc.8/Include 1.1.1 把运行期编辑 journal 进父 patch 层，bundle 行运行时 `disabled:true` 不再跨重启。判据 = 本机启停一轮后 `profiles/web/cordis.patch.yml` 只增 chamber 预期行、无重复 id、无非预期诊断；chamber 的行都带显式 id（匿名 id 重排的坑不适用）。
- cordis rc.11 失败 fiber 语义：依赖恢复后失败 fiber 仍失败、`entry.update` 现在 reject。chamber 的 `boot-tolerance` 只分类不驱动恢复；判据 = `test:client-web` 的 boot-tolerance 用例 + 一条「失败 fiber 不因依赖恢复自行 ACTIVE」的行为断言（未写则按设计接受更多 failure surfaced）。
- 终端 attach/重连（G43）：生成式流的 uplink（输入/半关/取消帧）与断线重连待打包态真机走查；判据 = 行为用例 `packages/dsh-api-gateway/test/behavior/client-uplink-support.test.ts`、`packages/dsh-api-gateway/test/behavior/mux-self-heal.test.ts` + 真机。
- alpha.4：Schedule（Automation tasks 面板/任务页/行 clock 标记/右侧任务标签/删除 toast/每会话 catalog 查询）+ Developer Tools（可选、默认关、Session/NodeJS Inspector、shell.bottom 声明）在 N-ctx 目检；判据 = C9/C11/C16 + `frame-slots`；风险 = inspector iframe document-relative 可能落 SPA fallback（C9 前缀或占位）。
- alpha.4 Discover：启用市场 bundle 后设置→插件管理的 Discover 页签与安装链；判据 = `test:plugin-manager` 的 `plugins.tab` + C4 契约 27；风险 = inject 含 plugin-manager 行、extra row 模块表解析未测（必要时升 covered factory）。
- alpha.5：①账号通知栈（层叠/高度过渡/空标题/空 expiresAt/未校验 JsonValue）；②模型标签三处（trigger/菜单/模型行，112px 已修）；③终端列表会话级缓存（去重/失效不重试/reset 刷新）；④右栏收起 PageUp 不横滚；⑤PTC code-first 与 persona 一致。
- alpha.5 观察：portal 逃出实例子树（隐藏管不到、onShown 不校验 → 可能提前 ack/跨壳叠加）；required-extra-rows 不覆盖 host-graph 行（inject 缺失静默 PENDING）。
- rc.2（仅该来源）：①Web 搜索开关（默认关、三命名空间字段与凭据、sendOriginalQuestion 128 字符、下次搜索生效、回退前先关）；②模型徽标三处（112px 回归已修，菜单/模型行待目检）；③web-deepseek-api 凭据/available；④日志 body.thinking 可选 log-only。
- 0.2.1 整页插件/自动化：窄屏布局已由上游前端负责；待真机 = 安全区/横屏、iOS/Android 键盘、真实插件动作与保存；判据 = 目检 + `acceptance:mobile` 路由步。

**open-in/Git/深链/只读镜像**：open-in S3=复制路径（工作区已落、会话行待补或裁决；S4/复制 ssh/深链不做）；VS Code 深链 8 项；Git worktree 真机（池内创建/enter/path-based 删除、删除对话框的可选归档与分支删除/旧池清空）；只读会话镜像（无 CDP 阻断、gateway/SSH 事实、404 自愈、DOM、性能）。

### 1.5 平台、发布与外部凭据

- **P5b 工作树统一（发布前开放门）**：forge bundle + 六个依赖包（七个 package.json）载荷（Electron `resources/vendor/dsh` 与 Swift sidecar 的 `vendor/dsh` 都要有 worktree / tool-worktree / forge / forge-github / forge-session / client-ui-forge）、实例前端 opt-in 开关与重启、node PATH shim / string-only 解析（打包态 + Finder 启动，远程只做诊断）、旧 `$DSH_HOME/worktrees` 池清空、filters/LFS 发布说明、Swift + Electron 双形态 P0（四项 UI/同池三条/node 实际创建）；任一缺失按发布阻断处理。判据 = release-checklist §0/§4、packaging-closure §3.2、design 08 §7.5；V1–V6/V16 合并门（dev Electron）与 V7–V21 发布门尚未逐项跑，未跑项按 design 08 §7.5 开账。
- **gateway**：Linux unit 登录环境；ssh/http cookie 注入未覆盖；旧来源插件播种 400（重建未排期）；运维页缺 `recover-metadata`/`cleanup-version`/`restore-pre-rollback`；S0/S2-c 未实现；设计 21 对齐（只读/seed 端到端、tooltip、英文串）。
- **gateway 启动失败原因对 chamber 不可见**：`state_root_locked` 的 holder 与判定依据只进 journal；客户端只能拿到 socket 级的归因文案（已按 ECONNREFUSED/ECONNRESET/EPIPE 分类并指向 gateway 服务与隧道，`packages/desktop/gateway-session.ts` 的登录传输分类），看不到持有者类别与拒绝依据，把结构化原因回传需要一条新的远程诊断面（读 state 根的启动失败记录或 journal 尾）——未排期，是「错误透传」的剩余部分。
- **租约身份的跨平台残差**：`bootId`/`procStartTicks`/`pidNamespace`/`machineId` 只有 Linux 提供（`packages/control-plane/src/process-identity.ts`）；macOS/Windows 的 v2 记录仍只有启动代际推断（依赖墙钟，步进超过 5 分钟余量时可能误判陈旧），同一启动内的 pid 复用保守锁定（宁锁不双写）。跨机护栏要求记录与本机都读得到 machineId，缺失时按「属主私有、单机」契约处理（design 17 §12）。
- **运行时安装现场的 pid 判活**：`dsh-runtime` 的 `isPidAlive`（`cleanupStaleInstalls`，`packages/dsh-runtime/src/dsh-runtime-store.ts`）仍按「同号进程存在」判活；安装中硬崩溃 + 重启后 pid 被复用会让清理一直抛「仍有活动写进程」，托管 dsh 起不来。pid 文件只有数字、没有身份元组，修法与租约修复同形（写 bootId+startTicks），未排期。
- **install/runtime**：`install` 不同步锚（待裁）；dl 运行时 macOS 全链/Linux/gateway 重连/`restartLocal` 交错/ZFS EAGAIN；上游装载面 `compose()` 10.65MiB、`SubagentHeaderLineage` 缺 class、首帧超时；会话可靠性六项；`protobufjs`/`@google/genai` 待 M2 证据。
- **桌面更新（design 11）**：真实 Apple 凭据 CI、双平台清单、通道封签打包态实证；`checkNow()` 在 runCheck 门跳过仍回 ok、渲染门缺 `downloadStallPending` 腿（待裁回 `{ok:false}` 或补腿；判据 = 按钮可点必须有效果或明确禁用）。S-52 = Sparkle quit 与在飞关窗相撞（≤2s 窗、~0.6，未实机；修 = 区分在飞决策/重复退出）。
- **认证 Gateway**：生产 TLS/SPKI/`remote.mux` 恢复、三形态重登/撤销、`/chamber/runtime` TLS、Linux 升级回退、`--bind 0.0.0.0` 负例；凭据重置/改密 CLI。
- **平台**：Windows M0.5–M6（[TODO.md](TODO.md) B§2）；Linux 清单 + `dry_run` + deb/arm64；桌面通知/徽标（macOS 权限/点击/三态、Linux Unity、Windows overlay）。
- **发布/CI**：reusable workflow、submodule 验收、Gateway npm 分发、打包闭包；DMG 并发（`serial` 缺失 + `hdiutil` 弃用未迁移）；CI 无 SMOKE PASS 腿；A1（F6/S1）、A2（A2-4/7）、A3（A3-1…15、S1–S13；判据 = 读失败/未检须可与“通过”区分）、bundle `bundleLayers`、产物新鲜度（web/host-package/allowBuilds，G2/G3/G5/G7/G8；关闭 = 第五类比对或严格档 `build:renderer`）。
- **其余**：SSH 一键免密/钥匙串未实现；模型额外参数待上游；`{detail}` 无 locale；变更文件覆盖率门未接。

### 1.6 一致性债务与门禁缺口

- **导出/门禁**：type-only 导出不判；无入口叶子模块不判（方向 = 孤儿模块门）；`TEST_ONLY_EXPORT_ALLOWLIST` 已规则化；`run-checks tests` 零覆盖可过；`verify:styles` 不覆盖 docs token；`verify:anchors` 无 Windows 覆盖；`install-gateway.sh` 走 npm 绕单源；`test:gateway` 仍有 2 处真装器 spawn。
- **重构/测试**：renderer 外三处 state/ref 镜像、`ssh-<id>` 别名、跨包重复 0 组（[TODO.md](TODO.md) D§1）；god-file 预算现登记 44 条（含 13 个新文件；4 条 `kind:ceiling` 单列，`--report` 的缺口只按可减目标合计），但新模块仍需**人工**登记才受保护；CI 打包排练 CPU；Swift 串行 113s（并行会丢 XCTSkip 判据）；升级线残余 = fatal 恢复框键位走查、node-pty 补偿复核。
- **隐私/平台**：`DSH_TELEMETRY_DISABLED` 不覆盖 `session-log-deepseek`，桌面是否默认 opt-out 未裁；`isMainFrame` 归属缺陷；docs 锚点过期（D15）；私有文件纪律三实现；`client-web` 未用 `ui-theme`；layout `ThemePresenter` 残留；wire A–F、sanitize/win-probes、dashboard 第三份 UI、A-U3/A-F16、dual-host。
- **低优 UX**：hover-only、徽标窄窗、en 单数、aria-label、ssh done 态、PluginDialog DOM 测试、对账空态、versionsEpoch、30s 文案、内联 effect。
- **门单源残余**：① 5 个 typecheck（`typecheck:host-graph/host-git/host-archive-cleanup/host-open-in` 与 `typecheck:gateway`）只存在于 `ci.yml` 与 `release.yml` 的手写多行 run（gateway 另见 Windows 腿的 `ci.yml`），registry 无条目 → 四个模式都不含它们，“modes 名字即 CI 所跑”对这 5 步不成立（`seed-client-graph` 的唯一检查完全在模式之外）；② `proof:true` 只覆盖 release 校验 job 的 3/16 个生成门步，`C8` rebuild、remote-state acceptance、third-party notices、`release-preflight --actions-only`、renderer SVG scoper 断言、gateway pack/install smoke 均非 proof-required（proof 集合与 65 条 id→command 现已由 golden 钉住，改动必须同批改断言）；③ 同一 job 里 typecheck 与 typecheck:runtime 各跑两次（手写块 + `run-checks typecheck`）；④ `release-preflight.mjs` 的全量 battery 与 registry 漂移（漏 6 项、多列 4 项，无测试守）；⑤ Windows 腿结构上进不了 registry（`gate-registry.mjs` 的 platform 校验只允许 darwin），8 条 `macos.*` 门无生成块、靠手写步骤执行（命令等价但无 lockstep 测试）。修①需裁决：把手写步并入生成块，或补 registry 条目；⑥ 生成块之外的手写步骤仍无覆盖网——`gate-workflow-views --check` 只比对四个标记块，旧 `static-gate-parity` 扫整个 job 的能力没有等价替代（静态门的 CI 落位已由 registry 不变量「`workflow` 或 `coveredBy`」拦下，其余步骤仍需人工对照）。
- **其他**：`verify:i18n` 的 40-hex 例外；lockfile 断言（`git diff --exit-code -- pnpm-lock.yaml`，`ci.yml` 与 `release.yml` 的多个 job）不在任何模式里，只由 `verify-release-ci-proof.mjs` 的 `NON_GATE_STEPS` 按步骤名保护；gateway 失败分支夹具；归档保护闭包测试；通知收敛器遗留；旧边沿孤岛；页面账本预热接线锁；page-channel 重复实例只报错；`notServingYet` 无生产者；Git 分支候选；B 桥写端行为夹具。
- **首屏体积**：`build:renderer` 两条 warn 已越线（chamber entry 与 head CSS）；增量含 `lexical`（ui-conversation 编辑器）与既有的 `simple-icons` 整桶。只 warn 不 fail，阈值不上调（上调会把增长藏起来）；拆分/懒载未排期。

## 二、差异（功能面 / 外部约束）

> 只汇总「app 做什么」与「本仓改不动什么」；明细与候选见 [TODO.md](TODO.md) A§15。

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
- **A1 座席 id**：注册台账每实例 ctx 一份；同 registry 同 id 抛错，两个 registry 互不干扰 ⇒「同页两实例必抛」不可复现；待实机复核 `schedule-mark`/`schedules`。
- **面板轴**：`ui-schedule` 页面级 localStorage 键、30s 无 visibility 门、点击埋点未复制；宽态入口盒形/aria 分组/重挂载偏差见 design 06 §4.7。
- **删除 workspace 两帧**：宿主 order/remove 非原子 + client `installOrder` 沉底 ⇒ 行先滑尾；本仓删除意图补偿；外部删除仍复现；上游原子化后退役。
- **平台腿**：Windows `[data-windows-titlebar]` 未抄 ⇒ 侧栏形态不同（排期，非功能选择）。
- **壳外拖拽**：补丁后壳外 drag 不再 `preventDefault`，落点导航拦截由 Electron/Swift 两壳各自提供（第三方壳需自带，否则拖入只产生浏览器默认行为）。
- **拖出原生臂缺载体**：随包 `ui-file-drag` 的原生拖出要求 `globalThis.dshDesktop.protocolVersion === 1 && dshDesktop.fileDrag`（`{prepare,cancel,start,release}`）；Electron preload 的 `exposeDesktopCarrier` 只暴露 protocolVersion/updates/keyboard/shortcuts/deviceInfo ⇒ 走浏览器臂（objectURL + DownloadURL），拖到 Finder/资源管理器是「下载式」而非原字节借用。功能可用、属新特性降级；判据 = 打包态真机（原生臂接通后回验原字节与资源借用）。
- **插件页头滚动面 inert**：`createHeaderRef` 已随座席注入，但 `EmbeddedPluginManagerPage.module.css` 让 `.page` 高度自适应，页内 `pageBody` 不再自滚 ⇒ sticky/compact 页头不触发（静态页头在，无崩溃）。裁决 = 保持现状或改容器滚动契约。

## 三、设计未决

- C15 hover 触发降级（提案）：改触发面 + 同批改 `AGENTS.md`/触点表/发布策略/静态门。
- 双 flavor parity 仍 open：S-01、G19、S-44、S-10、T-28、S-54（清单见 deviations §1/§2/§4）。
- 上游 host release 门（#6228）在 chamber 不生效：未决采纳（透传 release + 复刻刷新提示）或登记有意差异。
- S-49 原生窗口高度（786 vs 800）；宽度偏好 per-flavor（T-18）。
- macOS Swift 壳 M5 实机矩阵未闭合；Developer ID/公证/stapler/`build-swift` 发布腿缺凭据；双端 harness/通知音效等价物未验。
- 起始端口偏移已定（dsh 17510+1..17514、CP 17500，仅 env 覆盖）。
- Electron 运行时指纹：当前 pin 43.4.0 不在 addon 表内 ⇒ 宿主 exit 1、5 端口全失败；待裁对齐 pin 或等 addon。2026-10 GUI 走查以 `DSH_CHAMBER_ELECTRON_DIST` 指 43.0.0 跑通——shipped 43.4.0 的启动腿仍是发布阻断项。
- trusted-host 自定义 Host 需同步扩集；多 plane `$DSH_HOME` 隔离未决；catalog metadata 无跨进程 CAS。
- 响应头白名单双处同步；`__DSH_BOOT__` 以 vendor `parseBootManifest` 为准。
- 未挂载源 `workspace/follow` 只读流未决；facts forward-skew 带载荷是否算权威行集未裁。
- P1 结构性收口的两处“编排核心”按**风险/收益**保留，而非“需要依赖容器”：`retireSources`（App 678-827，外部绑定约 75 个、线性扇出）与 `refreshRemotes`（838-936，99 行、约 23 个自由变量）可继续拆成 3 段 + 按域输入对象，但收益主要是可测的注销不变量（per-source closers 登记表），行数有限；host-assembly 的订阅体按上一条成对抽即可。seam 级拆分的边界：wire 契约与 gate 单源在 registry/生成块内受约束；renderer 的 6 个大 hook（28 个 app-hook 的其余部分 <200 行）与 desktop/gateway 12 个新模块登记在 file-budgets.json（38 条）；未拆的两处编排核心即上一条。
- host-assembly 的 `sm.onStatusChanged` 订阅体**可以抽**，但必须与 `onVerified` **成对**抽成同一工厂（二者共享 `registeredTargetKeys`/`registeredAuthFingerprints`）：工厂在组合根原位调用一次、仍同步订阅，注册时机不变。此前的“必须内联”判断不成立；真约束只剩两处：fail-closed 分支的 `return` 语义逐字保留（现 698-710）与 6 个同工厂闭包状态的归属。抽完预计 -158 行（1163 → ~1005）。

## 四、范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

> 双 flavor 见 [deviations.md](deviations.md)。

### 4.1 架构、门禁与平台边界

- **God 文件预算例外**：`App.tsx`/`aggregate-store.ts`/`derive.ts` 高于基线，note 记理由；收口 = 放置/删除事实迁到 `workspace-placement.ts`/`workspace-removal.ts`。
- **门禁**：i18n/文档链接/测试接线/死导出/样式 token 为本地例外；seed 自检只报不阻断；测试面再压需显式裁决；`ALLOW_BUILDS` `fs-ext` 保留、`runtime-host-adapter` 不退役、`ownsGeneration()` 保留（勿补测试）；统一名称保留面（bundle id/协议串/`native-shell.page-zoom`/POC 标记）改名须同步 T-14/T-17/T-22 与测试。
- **不做/推迟**：组件工厂 + local slots；0.1.6 五项（`writer-held`/`toggle.badge`/`workspace-tree` 认领/`.dsh-module-fallback`/外部仓 `plugins.bundle.config`）；依赖声明补齐待 lockfile；工程门禁 P2；git 钩子。
- **移出项（P3）**：匿名 control-plane 认证/审计、薄壳会话面、统一索引、broker、通知中心、MCP 不得回流；design 17/18/19/08/20/24 例外不作他域先例。
- **构建/注册**：构建产物移出 git（`build:artifacts` 自举）；注册表降级不剪不落盘（fail-closed）；上游纯镜像 README 死链跳过（C1）；sidebar/layout `lib` 目标与镜像 exports 有意保留。
- **安全/发布**：`--no-auth` 有界例外；Gateway state 0700 + 属主；safeStorage 诚实回退；Windows 无 Authenticode、macOS 不出 x64；发布面临时收窄（三腿 `if:` 跳过，恢复删三处 + finalize）；state 根租约对越界拓扑（容器重建挂 volume、NFS 共享根）响亮拒绝，恢复 = 移走 `owner.json`（design 17 §12）。
- **N-ctx**：单文档信任域；原生键盘单槽（全部 boot 实例 accept）；壳常驻（local 恒留/隐藏最多 1/超限回收）；文档主题/页面语言归 §1.3。
- **registry/元工程**：触点 registry 单一来源、无 Windows 覆盖；R10 文本锁未全量改 import 断言；settings-plugin-manager 无 typecheck 程序（其 vendor client 面未铺成独立 program），`ctx.get` 显式类型实参一类编译错误只有该包 wiring 测试的反向源锁兜底；R11 布局助手受 Swift 锚点；pnpm shim 待打包实机；state 根租约 legacy 一个 minor 后删；Windows 覆盖缺口 R2/R14；R15 ui-layout 分类表；host 域逐域手写有 lockstep；第三类 vendor 补丁（`use-chat-reading`）；ServerSection 预算 raise（1243→1273）；alpha.3 workspace 成员判定待复核；cua 不接入。

### 4.2 产品、界面与运行时取舍

- **通知边界**：P1 只覆盖有壳源；facts-only `beforeBaseline` 不可达；facts-only `subagentCount` 仅谱系已认证（watcher 无谱系保持 presence）；paused drop、complete 复用、schedule/job 不覆盖、侧栏无 goal 视觉。
- **降级边界**：已覆盖四座；不覆盖未激活源/壳回收/单槽后报/侧栏无动作；租客 body portal 不受 stacking；连接页 tooltip 无 ARIA。
- **插件**：管理页钉上游结构（`data-plugin-panel`/drag/slot）；重打包无活切换（`restart-required`）；模块表按 id 唯一、跨实例一律复用原 factory（`reuseForeignBuilds`；release/内容证明只决定连接页是否提示，≤8 次校验）；刷新控制面 string-key；pluginGraph 无静默看门狗；两条重载无仲裁；chunk-owner 撤销边界；`/plugins/events` 属上游 HMR。
- **连接/来源**：open-in 官方页级 localStorage 槽（`dsh.open-in-app.choice`）待按 `chamberBasePath` 分键；N-ctx Markdown 预览仍 document-relative（A 保持降级/B 覆盖补丁待裁）；`chamberFileApiBase` 仅唯一来源断言；远程会话状态/切源白屏实现闭合（实机见 §1.4）、远端空白会话、ui-chat 老代整面失败、未挂载工作区集合仅回声+挂载 push 均按已知降级；`document.hasFocus()` 假设只驱动 `requireHidden`。v1 不做 = 单 store 真融合、控制面会话实时同步、远程实例管理 UI 外壳、跨来源平铺列表。
- **UI 偏差**：B1–B10（默认 manual、unpin 回自然位、家族优先、树展开/拖拽约束、拖拽不切 orderBy、账号成员=可见行、搜索链、归档无 toast、行窗口配额、fork 落尾）；`sidebar.workspaces` 声明不渲染；菜单 `compact`；窗口标题冻结；轨道点裁切；hover 几何无指针腿；导轨无锚点/aria；Git 错误码重叠；折叠 folder 字形不补源码锁。
- **归档**：成功不就地提示 + 筛选降级（未知集禁用整轴）；两段式旧宿主降级（第二调上抛，不做版本探测）；已知代价 = 墓碑撤下后筛选禁用至挂载。
- **运行时/桌面**：Electron 二进制惰性安装；内建版本行引导；dsh 设置面偏差（registry/https-only/周期检查/prune/`RUNTIME_RESTART`）；apply-now 纯投影门；探针契约残余；0.1.2 线降级（硬阻断/芯片隐藏/cookie 30 天/帧校验/`agentPresets`/unary 兜底/首屏整源降级/gateway ready 不蕴含托管就绪）；代理 300MiB；C3 composite 代际；C4 settings 簇；plugin localOnly 不检测；prune 保留 `docs/` 运行时文档（任意深度；`docs/` 内附属物目录与包内技能 Markdown 仍被裁，design 18 §3.7/§4.1）。
- **视觉/交互**：标题墨色不照官方；动作簇 4px；会话行键盘不可达；命中盒 <24px；`gap: 4px`；漏事件补丁未落；动作簇键盘入口/roving tabindex 待裁。
- **会话投影**：标签 + `hasActiveSchedule` 跨代际保留（0.6–0.8s；`updatedAt` 前进即停）。
- **P5b 工作树统一（开放取舍）**：①**Swift 保留**原生壳与 sidecar，node 分 flavor（Swift = sidecar node；Electron = PATH shim / string-only，绝不写 `process.execPath`），不做 sidecar 移除或回退形态；②forge bundle **opt-in**（默认关、启用/关闭需重启，GitHub provider disabled），不预置进 profile；③旧 `$DSH_HOME/worktrees` 池**不迁移、不检测、不提示**，升级前逐树 `workspace.delete`（归档需保留的会话）+ `git worktree remove/prune` 是发布前提；④filters 与 forge 两步 parity，接受 LFS/clean-smudge 降级（checkout 为指针文件，需手动 `git lfs pull`）；⑤restore 仅 forge record（seed 树无 restore）；⑥`checkoutOrder` 只在本机 localStorage 持久化、不跨实例同步；⑦同一 checkout 允许 0..N 会话共享 HEAD/index（无默认提示、无硬锁）；⑧只发布池内 checkout，池外手工树不可见。判据 = design 08 §3/§5/§7。
- **上游并存**：experimental worktree 默认关**仍真**（P5b 为 opt-in，需在实例插件页开启并重启）；旧裁决“其产物由 design 08 接管、不复用 create”已被 P5b 反转——forge 与 seed 共用 `<repo>/.agents/worktrees` 池，checkout 由 design 08 的派生行呈现，官方 `create_worktree` 工具与 composer 都复用同一池；GitHub provider 由 overlay disabled；cua 不接入。
- **设置/账户**：设置壳自绘 chrome/源壳必须挂载/离线占位/body portal；上游对齐轮偏差（首启门、`sectionsEmpty`、失败屏深引、`Switch` 属性、业务蓝、schedule 事实、状态标记/Dock/通知）；桌面账户登录不可闭环（`/oauth/callback` 未反代；裁决 D2 见 [TODO.md](TODO.md) C§1）；`__dshChamberAccountOverlay` 与安全网互搏（待裁）。
- **跨实例 rev 冲突 = 静默复用 + 连接页提示**（design 09 §3.5）：跨实例一律沿用页面已有 factory（`reuseForeignBuilds`），实例 boot 不因该冲突失败；代价 = 跨发布构建可能与宿主预期不一致（缺块/行为异常），由连接页诊断点名两侧发布版本与收口，且 local 无图降级时构建来源可能反转（design 09 §3.5 残余风险）；复验 = `packages/renderer/test/lifecycle/host-graph.test.ts` 冲突用例 + 连接页目检。
- **远端浏览器（design 28）**：无共享 `127.0.0.1` 回退（Host 被拒/421 = 可读错误，不降级；远端未配 `127.0.0.n` 的服务打不开）、OTP/2FA 主机不支持（每条 forward 独立 ssh）、`kill -9` 后 listener 存活到下次启动、被转发页面可无预检访问本机 loopback（PNA 残余，design 28 §9.7）——均登记为已知取舍，不是待修缺陷。
- **上游 rc.3 新面的取舍**：桌面复合体**不采纳侧栏 More**（chamber 侧栏不声明 `sidebar.panellist.actions`，`entry-customization` 的该注册停在等待态；`panel-pins.ts` 登记 `dropped`，采纳触发见 TODO A§15/U6）；gateway 的官方侧栏照常显示。**New Session 复用空白会话**（全局按钮/快捷键）：宿主把复用的空白切到默认预设；仅当该空白的 Agent 仍加载时保持创建时组成，重启后按当前定义（官方 guide 14/16/20）；chamber 的来源「+」仍按来源复用（只打开复用行，不走上游 `connectWorkspace` 的 sessionId 语义）；接受，不包裹。（本节只记取舍；验收判据与未覆盖事实见 §1.4「上游 pin 新面」rc.3 行，不在此重复。）
