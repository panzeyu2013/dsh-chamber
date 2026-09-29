# 模块完成状态总览（STATUS）

> 只记仍开放项：未完成/部分完成（含实机与打包态门禁）、设计未决、仍成立的取舍；每条 = 开放事实 + 判据/指针。
> 已实现基线以 git 历史、`CHANGELOG.md`、`docs/design/` 为权威；不记完成叙事、测试计数、提交哈希、批次轮次与实现过程。
> 双 flavor 偏差（S/T/P/G/D）见 [deviations.md](deviations.md)；未排期想法见 [todo/](todo/)；条目落地或不再成立即删。

## 未完成 / 部分完成（剩余验收）

- **上游漂移批次三剩余（I-15 实机记录）**：本条只作执行序指针，六组矩阵（完成未读 P6、归档两段式 + 恢复、
  通知行为四缺口、运行位校准 60/190/310s、I-14 selection scope、I-12 谱系压制）的开放事实仍在各自条目；
  执行序已归并（`gui-acceptance-checklist.md` §4.1），**待打包态/真机各跑一次并留证据**（用户裁定：合并到主分支后再执行，
  见「设计未决」的 macOS Swift 原生壳条）。I-12 的判据落点见 design 19 §3.2/§3.5，I-14 见 design 09 §3.6。
  判据/方案/落点/关闭与待退役块触发见 [todo/upstream-drift-plan.md](todo/upstream-drift-plan.md)。
- **上游 UI 对齐遗留面**：按性质分两处登记 —— 功能面差异见下文「功能差异（chamber vs 上游）」；受 vendor 语义/平台
  面约束、本仓改不动的见下文「无法控制的差异（外部约束）」。判据、候选落法与已收敛项见
  [todo/upstream-ui-parity-plan.md](todo/upstream-ui-parity-plan.md)；现状面与契约指针在 design 06 §7、design 05 §2。
- **通知壳 sink `runtimeSettled` 锚点（I2；剩打包态实机回执）**：facts/壳两 sink 共用
  `complete-ledger.ts` 的 `completionAlreadySettled`（无标记/无锚点 = fail-open，只影响抑制、
  不影响投递；**未恢复别名表**）。残余重复窗口 = 「同页、非首批、producer 状态被重置的壳完成
  重放」需在打包态证不再双发。打包态
  `ShellDebug.isEnabled` 恒 false（`!isPackaged` 守卫）⇒ 判据只能走实机回执。**实机/复核未做**：
  候选证据门（`factsCompletionOf` 只认 host 域 observed 的 `completedAt`）、`factsContradictsIdle`、
  Dock 真实回执链（去无窗守卫、同值不写、写后真读回 `{count, applied}`）、`authority-log-store` 的
  `facts-health` 保底名额。
- **目标活跃期间的完成通知/未读压制**（design 19 §3.2）：打包态实机（N 轮 `held≥1 && sent==0`、outcome 后恰一条、六面同拍、reload/冷启、撤回、local/gateway/SSH 各一组）；activation unknown 静默窗口需上游只读 activation 读；围栏双发（§3.2.7 ⑦ F30）仍待裁——scoped withdraw 已按 provenance 定契（design 19 §3.2.4/§3.5：桥面上报撤回只清壳轨、事实载体换代整代撤回；含 C1 撤回窗口内 facts 完成不丢发的取舍）。
- **会话链重构**（design 14 §D4）：阈值真机校准（60/190/310s，[session-authority-calibration.md](../checklists/session-authority-calibration.md)）、ssh 写回时延、macOS 腿、集中日志面（机内环已有）；mobile `session-stall.ts` 是否拆分待裁（决策核心已表驱动，其余为 DOM/提示壳——不记行数，行数每次重构都会漂）；Swift 收口 `RendererRecovery.swift`（≈185 行）与 `RendererHangWatchdog.swift`（≈129 行）仍超 ≤90/≤60 目标且未入棘轮、`RendererRecoveryPolicy` 判定/记账分离；反补丁波次①–④（阶梯决策边界、子代理完整性属上游依赖、载波身份仍是请求键、P6 上游首帧期限 / `doOpen` 契约，`verify:upstream-lifecycle-contract` 钉住）；`tests` 模式 flaky（gateway/control-plane，假宿主占端口）。
- **会话运行位卡死**（ui-chat「深度求索中」；机制已单源化）：①实机 lane 复现未接 CI；②HTTP 健康而 WS 半盲时 transcript 不收敛（45s 旁路 follow 已落，宿主 `asOfSeq` 对账未做）；③`session.list` 单飞悬挂 ⇒ store 永久 loading（需上游超时）；④子代理行（`origin==='subagent'`）仍不进运行时事实/导航（有意；P2a/P2b 的源侧投递门 + I-12 谱系压制已落，余实机旁证）；⑤隐藏期 watchdog 不 tick；⑥阈值/N=2/写回链未实机校准；⑦上游语义由 `vendor-session-fact-contract.test.ts` 逐条钉住（vendor 未物化默认失败）；⑧控制面/壳日志的取证价值未验；⑨`session.list` 全量性缺水位；⑩控制面集中日志面未做；⑪两处「更省形态」候选未落；⑫对话流健康臂实机验收未做（自动 resync / `loading` 提示、滚动位置观感）；⑬静默半死（宿主流级 keepalive+游标未做、首帧期限与探针阈值未校准、`ended(false)` 兜底）；⑭修链未闭合（非 `ISessions` 契约写回、90s 界限只在失败分支、ssh 时延、窄缝、行为测试缺）；修正 provenance 的 I3 臂无 host 证据不通知，实机矩阵未跑；⑮运行位解析对齐后未实机校准；⑯子代理运行环行集与官方不同源（收紧 or 写进契约，待裁）。

- 实机门禁（缺真实实例 / 打包态环境）：
  - 调试模式 T-10 打包态（Web Inspector 附着**只能人工判**）。
  - 多来源 sleep/wake 与隐藏恢复、版本歪斜容忍、gateway 形态回归（WebKit 真机复验的是 0.2.0 上游的引擎无关内建判定；gateway 出口的原生源码归一已随最低 runtime 抬到 0.2.0-rc.1 删除）。
  - 隐藏/遮挡态节流（design 14 §D1；S-10）：最小化/完全覆盖两工况的 rAF/定时器/`visibilityState`/App Nap、隐藏 ≥60s 页面通道（`/api/page-channel`，design 26）与 Remote mux/推送不断、唤醒即时重连、30s 兜底轮询跳过 + 补偿。
  - vendor 性能补丁可见态 A/B（真实 app 同环境）。
  - 右侧栏栈真实 profile 装载时序、session v3 迁移真实存储。
  - open-in 实例内 host 包：两代 runtime 探针（pin 0.2.0-rc.1 需复跑，最大未验证风险）、图标/缓存/CSP/无 cookie fence/remote cwd、macOS 实机清单（目录顺序、拉起落工作区、ssh 两态、设置页行集、N-ctx、打包 seed）、Windows 盘符/UNC、第三方 scheme、fork 折入流程。
  - 写入期终止失败闩锁（design 02 §3.4）：只能靠重启再证明。
  - 实例写者静默门拦自动启动恢复：如实 409 但按钮停 `starting`/端口 0；恢复 = 优雅重启。
  - 降级提示三处座位目检（design 05 §4）。
  - 切源后座席/字标与设置齿轮空白：真机在重构建产物上重放；gateway/mobile 官方壳未覆盖（scoper 收拢待裁）。
  - boot 死区收敛（design 05 §4.1）：idle 远端点会话不启 boot、`error`/托管 stopped 1.5s 宽限判死、挂死 boot 10s 给重试/⌘R、502 非阻断横幅 + 自愈。
  - idle 来源点会话排队 68s 才失败（05 §4.1）：候选 = 记推迟 open 意图、ready 重放。
  - 0.2.0-rc.1 pin 四项：内置插件页目检、跨代 profile 对账、gateway 就地升级、0.1.6 代移动端 + 右栏终端 tab。
  - 客户端插件热同步（design 09 §3.7）剩余实机面：经插件管理器/配置编辑路径触发的一次真实 add/remove 帧、
    ssh/gateway 各一来源、卸载保证边界（factory/loadCache/style 保留面）、隐藏回收期无迟到写入、宿主崩溃重启后
    活行存活（重连响应非 200——重启窗口内的 503/502——浏览器按规范判死；hold 层已加有界重建 ≈97s 覆盖
    该窗口，预算耗尽才退回 boot 现状须手动重载；重建是否真覆盖重启窗口待实机）；图回归（boot 无图的 ssh 来源在
   seed + 重启后由每 60s 有界探测发现图已就绪并重挂一次，取到 profile 的 client 行）同待实机；已验范围与复现命令见 design 09 §5（不在本文件重复）。
  - 遮罩层叠/揭幕 P0–P3（design 05 §2.2.1/§4）：W-1b 真机走查、揭幕时延（active ≤1 帧 / absent ≤2s / hero 保持）、Swift 发布包 Safari 人工抽检。
- **Swift 原生运行期监督**：首载门现按 `/health` 中的 `dsh.status` 等待 managed dsh ready；首屏提交后仍无前台周期健康探测（S-45）或「重启 sidecar」入口；`didCommit` 后缺首载期限；两 flavor 需按 design 14 §8 分层真机取证。
- 宿主 cwd / 安装根（余两条）：vendor `worker_threads` 共享 `process.cwd()`；安装/更新原子化 + 运行中检测。
- ProMotion / 120Hz：打包态三工况实机；确认 `[shell-fps]` 只在 `DSH_CHAMBER_SHELL_DEBUG=1` 出现。
- macOS 窗口 chrome 实机（待打包 .app；**Electron 腿已按上游 darwin 分支收口**：hiddenInset + 红绿灯 (16,18) + vibrancy + 透明底，锁 S-54）：折叠/展开条带上灯与开关同一水平线（缩放/全屏/跨屏后不变）、侧栏模糊与 Reduce Transparency、恢复不瞬时透出、`html[data-fullscreen]`（两 flavor 都由 main/Shell 镜像）、失败页可读、可拖整窗；Swift 组装 `build:sidecar`→`build:swift-app`，Electron 腿 `build:desktop`。
- 原生席位 + W7：打包态右键菜单/Sparkle 标准窗语言与外观、主题即时性待验；语言语义已裁决（族比较 + 同族不覆盖）；取舍两条（只随包 en/zh-Hans；shim 六条拒绝文案英文）；W7 待产品裁决。
- gateway unit 登录环境（待 Linux）：重跑安装器验 `systemd-analyze verify` + 服务拿到 HOME。
- ssh/http dsh 无 cookie 注入：五处资源 URL 已归一为本实例前缀（design 09 §3.6），cookie 注入未覆盖。
- gateway 来源插件播种被拒（400 `invalid_input`）：旧 gateway 只认 `dsh-host-*`；剩余 = 就地重建旧 gateway 未排期。
- `install` 不同步 dsh 锚基线（待裁）：`--dsh-upgrade` 只对 `update` 生效；收口 = 升锚后重跑自愈事务；待裁 = install 是否同步锚。
- dsh 运行时版本管理（design 18 §3.6/§9）：macOS 打包 `.app` 全链、Linux server 端到端、gateway 重启重连与 SSH systemd IPC、`restartLocal()` grace×健康计时器交错、settings-bridge 组件级、ZFS `ERR_PNPM_EAGAIN`。
- `protobufjs`/`@google/genai` 放行分歧：待 M2 全新安装证据。
- gateway 运维页缺 `recover-metadata`/`cleanup-version`/`restore-pre-rollback` 三入口（design 21 §7）；FATAL 下只能 curl。
- apply-now 实机：macOS 打包全链、Linux 生产 TLS 全链、Windows 只读投影。
- 桌面更新（design 11 §9）：真实 Apple 凭据跑通发布 CI + 双平台清单未在签名包确证。
- 认证服务端 Gateway：生产 TLS 反代/SPKI pin/`remote.mux` 断线恢复、三形态重登与撤销、`/chamber/runtime` TLS、Linux service 升级回退、`--bind 0.0.0.0`/隧道负例；凭据重置推迟、改密/轮换停机 CLI 恢复。
- S0/S2 http（design 17 §10.5）：S2-c 未实现（前置 = 扩展 gateway patch 写入器）；剩余验收 = 打包态直连可写、断链 60–120s 自愈、升级后钩子复验。
- 设计 21 对齐：只读通道/seed 供给面端到端核验（发布前）、who/when tooltip 未渲染、`pollGatewayReady` 英文串。
- 产物新鲜度：`desktop/dist/web/**`、`dist/host-*-package/**`、vendor `allowBuilds` 无守卫；G2/G3/G5/G7/G8 未落（`todo/refactor-plan.md` §8）。
- CI 无 SMOKE PASS 腿：`smoke.test.ts` 恒 SKIP ⇒ 绿灯不代表真跑安装链。
- A1 读面残余：F4（版本冲突输入建立不了）、F5（restart-required 报另一版本）、F6（recheck 基门漏 boot 字段）、S1（`ok` 无已装载事实）。
- A2：A2-4（哨兵 vs semver）、A2-7（raw vs effective pending）。
- A3：A3-1/2/3/4 保鲜门自证、A3-5 假过且 `--check` 未进 CI、A3-6、A3-10、A3-11、A3-13、A3-15、A3-14，另有 S1–S13 疑似面（S12 已单列）；判据 = 读失败/未检必须可与「通过」区分。
- bundle 层生效信号（design 21 §6.6）：需新宿主事实 `bundleLayers`，两态才可区分。
- 归档清理与归档管理器（design 24）：打包版目检、探针 fail-closed、>65,536 不清扫、gateway/远程实机；待跑验收（skippedProtected/skippedRunning/子代理后代/常驻保留链）；**归档两段式实机目检**（运行中会话 → 确认框列出活动 → 停止并归档；安静会话仍单次归档）；**恢复路径实机未跑**（管理器行/批量 → 官方 `workspace/unarchiveSession` → 行回归，且侧栏生产端的 purge 墓碑由同一事实释放；曾挂载/当前未挂载来源按既有「归档集两收割间冻结」降级、重挂载收敛）；残余 = 事件 no-op 至上游 wire、维护期 force 风险、保护边界 = 活 `current`；seam 依赖官方私有三面（已加写后读回守卫 `registry-write-mismatch`；退役 = 上游批量原语）；缺陷 = `errors` 通道混用致成功也红；清理残留 = projcache 4KB 档未回收、迁移在飞 purge 留代际窗口；可选增强 = PluginDialog 三态行/rowError 本地化；tombstone 由孤儿清扫收敛（空语料 G1a 永跳）。
- 会话列表标签：链 = 官方 title→cwd basename→id；无超出日常的实机门禁。
- 移动端 Web（design 17 §18）：未实施 = 移动中量化/滚动记忆/宽屏触控/长按气泡；composer 守卫 WebKit 未验（真机读 `[data-mobile-kbd-state]`）；复审①–⑪（右栏全屏让位、44px 底线、官方浮面未适配、`touch-action:none` 冲突、真机抽检、回到底部控件被键盘遮、caret reveal、layer-2 不可达、iPad 指针档假设、档位边界、模态叠加）；§18.6 实机门禁清单；登录页预热三项（真机链路/滥用度量/边界复核）；git 侧栏与 P2/P3 排期；DOM 锚点审计三项（details 打标仅实机可验、composer 锚点 fixture 化、Android 键盘盲区）。
- 连接稳定性：控制面代理 24h 记录 494 次 WS 关闭**全部是 upstream close**（local 108 次、寿命 60–135 s 居多、最长 871 s，0 次 heartbeat lost），但独立 Node 客户端挂同一 mux 400 s 无 close ⇒ 关闭不是实例心跳的普遍行为，**页面侧（WebKit 的 pong/调度差异）才是差异所在**；下一步仍是抓 close code（1006/4000）与把页面侧 mux 关闭与 `[chamber:evidence]` 账本对齐。
- JSC 崩溃 → 静默整页重载：引擎缺陷（WebKit 22625），仓内只降触发概率 + 状态可见化；2026-09-28 15:28:33 新增报告与已知族同源（主线程微任务路径 `operationOptimize → newReplacementCodeBlockFor`，`far=0x120`）⇒ 整页重载清空全部页面内事实仍是「各来源同时坏」的独立机制；恢复提示与过程缺真机验证、页面事实持久消费面缺（`dsh-chamber.evidence-log.v1` 已给判定面，尚未覆盖事实行本身）。
- 会话打开停滞（仅余开放项；根因归 design 14 §D4 的引擎判定第三类 vendor 补丁，不复述）：宿主无首帧期限；①触屏档无载波层；②blank 子形态恢复入口待真机；③移动端 source↔artifact 缺锁；④FNV 预算键碰撞；⑤`socket-silent` 消费面缺；⑥`presented` document 级近似；⑦阈值未校准；⑧unary 引导未采纳；⑨无消费的取证小面；⑩实例级回退粗粒度；⑪未完成补读面待接线或退役。宿主两条已登记 `todo/upstream-proposals.md` §4.3/§4.7。
- 本地 facts 间歇降级：两条机制归 design 14 §D4 证据有效性层与 design 26 页面通道（实现不复述）。开放项：①design 26 的打包态实机复验（冷启动 + 多来源窗口：`[chamber:evidence]` 的 `page-channel` 行与 unary 时延对账、重载/唤醒后的订阅重放）；②gateway 形态**不**挂载 `/api/page-channel`（升级分发已**明确拒绝**该路径并有用例钉住；移动端当前不使用这三族，将来要用须在 gateway 升级分发登记同一端点，design 26 §2 非目标）；③gateway 镜像 `diagnostics.degraded=true`（harness `followFailures` 19）的成因仍未查；④下一次时好时坏窗口带 `[chamber:evidence]` 账本做一次真机复验（`unscheduled booked=false` 的出现频率与 v2 判定的对照）。
- 页面通道的上游连接**不**计入逐实例反代的并发计数与诊断面（design 26 必要取舍：每订阅一条长活上游是 O(活跃订阅) 的设计，套用反代的 64 条并发上限就是把容量旋钮搬回来）。`pageChannel.stats()` 已暴露 `{sockets,subscriptions,upstreams}` 并有测试，但控制面当前没有诊断面消费方（`InstanceProxy.getDiagnostics()` 同样无生产消费方）——将来做运维面时从这里接。
- **Electron 托盘图标尺寸未实机核验**（Swift 对偶面＝自持 18pt 图，`macos/Sources/DSHChamber/StatusItemIcon.swift`）：`packages/desktop/main.ts` 的 `maybeCreateTray`（`packages/desktop/main.ts#=literal:function maybeCreateTray(cp: PlaneHandle)`）把 1024×1024 的 `resources/icon.png`（打包后 `process.resourcesPath/icon.png`）原样交给 `Tray`，macOS 下是否被菜单栏自动缩放未验；判据 = 打包态托盘图标与状态栏等高、不出现被裁的大图，并与 Swift 侧 18pt 观感一致；若不缩放 ⇒ 换/缩专用托盘图，或按 T-15 纪律登记 deviations。两侧都需实机目检（Swift 侧装新构建后看菜单栏，Electron 侧同上）。
- **macOS 原生壳：设置页窗口拖拽面实机目检**（未验）：判据 = 实机上从设置页页头行空白处按下可拖动窗口、首组标题区域不被吃成文本选择。相关：`packages/dsh-chamber-client-ui-settings-plugin-manager/src/client/EmbeddedPluginManagerPage.module.css` 的基础落位规则（首组头 `pointer-events: none`）与 `macos/Sources/DSHChamber/ShellWindowDrag.swift` 的 `[data-window-drag]` 祖先链判定；设计 05 §5。
- **实机验收 + soak 未执行**：Swift 壳流式中点开 ×20、soak 采集 mux churn 与 JSC 崩溃率基线；证据路径 = `~/Library/Logs/DiagnosticReports` WebContent 报告、`control-plane.log` 的 `browser close` 频率、`dsh-chamber:stream-forensics`/`dsh-chamber:stream-carrier-failed` 页面事实；design 14 §D4 末条。
- 上游装载面三项：`compose()` 首批 ~10.65 MiB（PDF.js 6.57 MiB）、`SubagentHeaderLineage` 缺 `count` class、会话打开流缺首帧超时。
- 会话可靠性六项：跨 Electron/Swift 注入矩阵、Swift 真机隐藏/遮挡/唤醒、无独立绘制游标、通知显示与落盘无原子事务、缺共同轮次键、Swift 有界写器注入。
- 双帧 status 全丢的证据边界：需宿主轮次键/可信 host 尾时间；无壳观察者 `session/follow` 已走 remote.mux，须真实宿主核对。
- 受管 dsh 日志取证（opt-in）：真机验收未做；隐私代价（含会话内容，脱敏仅 token）；仅本地 spawn。
- Windows 首版（design 23）：外部门禁 M0.5–M6（台账 `todo/windows-v1.md`）。
- Linux 桌面（design 22 §7）：实机清单 + release.yml `dry_run` + deb/arm64。
- 桌面通知/徽标：macOS 权限/点击/三形态、Dock 三态、Linux 仅 Unity、Windows overlay 随 M3。
- **完成未读对齐 P6 实机验收（打包态 .app）**：官方位读数（屏上/隐藏来源的武装与清除、重载即空、重跑/离表清除、修正臂只补有壳隐藏来源 `current` 行 ∪ 无壳 provenance 全行）与六面矩阵（侧栏行点/搜索行/待办条/Dock 角标/通知观察面/诊断）逐场景；local + gateway + SSH 各一组（design 06 §4.1–§4.3、§5）。
- 事实健康环：只覆盖无壳 mux 快照、无 in-app 读面；收口 = gateway 源接采样 + 只读环读面。
- 通知行为测试缺口四项（点击二级门、主进程握手、设置页渲染、`pagehide` flush）。
- 会话待办区（design 06 §8）：10 项实机门禁。
- open-in 超集口径（裁决）：S3 = 复制路径；复制 ssh/深链与 S4 不做。
- VS Code 深链 + open-in：macOS 实机 8 项。
- Git Worktree（design 08）：远程 Linux 端到端 3 项 + 实机 3 项 + 孤儿 workspace 注册清理两态 1 项（外部删除目录 / 目录+记录都已 prune，判据见 gui-acceptance checklist）。
- 会话创建/fork/归档侧栏收敛：四项实机验收 + 整源降级面。
- 打开意图/工作区回声：四项实机验收 + 阶段 0 插桩判定 `early-open.ts` 去留。
- 新 worktree 首帧落点（位置意图）与行动效：实机验收四项——①从所属 workspace 之后入场、不在列表最顶端（含主 checkout
  折叠、恰好 200 行的组、拖拽覆盖序残留窗口）；②点 + 新建会话时新行淡入、下方行滑移，不整列瞬移（未钳制组与折叠组都不改键）；
  ③活动会话被拒绝时行菜单项与行内悬停钮都进同一确认层，跨行换靶被拒、连点不重复；④列表最底行的归档钮
  tooltip 不被 `.chamberList` 裁剪容器切掉（Tooltip 未传 portal，需一次渲染实测后接受或补上）。
- 发布/CI 基础设施：reusable workflow、vendor submodule 验收、Gateway npm 分发未决、打包闭包自检。
- 性能遗留（P0–P2）：五条实机复测 + 第二阶段 A/B 目标（全视图 DOM ≤13,000；实测 `document.querySelectorAll('*')`=15,805 含壳 chrome，需按 `scripts/perf/measure-ui.mjs` 口径复测）；已知取舍 = 回收壳蓝点/通知暂停至该源重开、桥探测预算耗尽后转 30s 长尾（迟到 `desktopSsh` 采纳上界 30s，design 19 §3.2.4）、purged 孤儿键按指纹 K=2 淘汰且首迁移只清当前 instanceId（design 24 F5）；仍待真机验收：①隐藏/遮挡 ≥60s 的唤醒与采样实测（需最小化窗口）②打包态 SVG scope 探针（`scripts/dev/svg-resource-probe.mjs` 需活体控制面）③五条复测须含风暴档发布速率；侧栏 T2、factAt 量化与前置仪表等推迟项见 [todo/page-perf-p2.md](todo/page-perf-p2.md)。
- Swift 壳性能 A/B：启动/大载荷 invoke p95/空闲 wakeups 需打包态；`[shell-fps]`/控制台转发在打包态被编译掉（`ShellDebug.isEnabled` 的 `!isPackaged` 守卫），打包态仲裁暂只有 Safari inspect 三角测量；0 延时定时器自激修复后的打包态判据 = 空闲安装率 <200/s、静默可见态 CPU <10%。
- B 桥协议写端验证面：`sidecar-stdio.test.ts` 已有真实协议行为用例；出站帧门/有界缓冲仍是源码正则 + 本机真解析门（行为用例需可暂停 stdout 消费的夹具）。
- SSH 密码一键免密与钥匙串（design 05 §8）：未实现。
- 模型额外参数 + 默认推理等级（design 07）：待上游解锁；回显/设置入口未排期。
- 跨边界诊断文案：框架之下 `{detail}` 文本无 locale 席位。
- 变更文件覆盖率门未接：需 devDependency 或单进程 runner（待裁）。
- 根级弹性回弹（S-50）：打包态实机 + macOS 14.4 复验。
- **只读会话状态镜像（design 17 §10.7）**：实机矩阵（无 CDP Electron 阻断）、gateway/SSH 事实（running/pending/goal）与 404/降级自愈、场景级时序、DOM 断言、性能基线；跨端读回执相关用例（双客户端 E2E、read/read-all 回放）随该面退役删除。
- 事实通道降级归因（P2b）：`$events` **有投递**（2026-09-27 实测 4 分钟 18 帧 `api-session/status`，原「只收 ready」记录作废；design 19 §3.5 已更正）。11:01:08→11:02:32 已定案 = 插件管理器长 RPC（`installBundle`/`waitForInstall` 不在 `LONG_RPC_PATHS`，撞 45s 保险丝；扩容该表是待裁的修复候选）；09:29:26→09:34:56 十连败无宿主自述证据，与「事件循环长阻塞 / 外部 CPU-IO 饥饿 / 浏览器侧排队」不可区分——出口 = 窗口期差分（真观察者模块在 Node 跑默认时序 + 独立 unary 探针；宿主侧全绿而页面侧失败 ⇒ 浏览器侧）。
- 完成身份跨通道边界（design 19 §3.2.3 R1/R2 落地后仍开放）：**无锚**完成（facts 行缺席 / 只有已见旧行 / 跨页重放的同一边沿）在两条轨道上身份不同（页内 nonce vs 水位/宿主 seq），最坏一次重复横幅、绝不漏发；已借出的宿主 seq 有单调记账（`lastAnchoredSeq`），同一事件序不再归属第二条完成。消除重复需要上游只读面让壳完成也带 `turn/end` 判别符（§3.2.7 ⑥⑦ 已按此收窄）。
- **facts-only 判定侧读回退的已知窗口**（design 19 §3.2/§3.5）：列表播种与网关平面（快照/增量）都不带 `firstSeenByDelta`（该位只由无壳观察者的 status 首建）⇒ 无 `beforeBaseline` 首见武装窗口（idle 行等下一次 running→idle 边沿）；P2b 子代理行仍不建行、不投递，但父的 `subagentCount` 由**列表事实的 running 位 ∪ 状态帧**供养（与 P2a 网关镜像「不上 wire、仍计入 subagentCount」同形；漏掉的 status 帧由下一次基线整表重算收敛，只滞后不永久缓行）；P2b 的 status/waterfall 首建行在列表事实确认前不进快照（`identityConfirmed` 门，design 19 §3.5），`beforeBaseline` 位随之只在确认后可见——第二支窗口到不了的结论不变；上游 `observeRunning` 的第二支只在「列表基数已知且未就绪（`listKnown && baselines === 0`）」且行带 `beforeBaseline` 时启用，今天两个平面实际上都到不了该窗口（P2b 可判即 ≥1 基线；P2a 网关平面行**永不带 `firstSeenByDelta`**）；facts 不可判（`virtualRuntimeReport` 返回 undefined：host stopped/disabled/forward-skew/legacy）时无壳读清与武装一并冻结，打开意图不消点——与冻结条款一致，登记为已知边界。
- 流级预算表外多副本：2s/8 两份未锁；出口 = 并入 tables + parity 或加锁步。
- 取证 request/snapshot 半条通道无生产消费者：页面终局账本退役后 `dsh-chamber:stream-forensics-request` 无 dispatcher、snapshot 无 listener（`stream-forensics.test.ts` 仍覆盖往返）；live `dsh-chamber:stream-forensics` + ring 不变。出口 = 删除或按探针用途接线。
- 载波 reducer socket 生命周期无生产发射者：F1 的 accept 通道（`OpeningTicket`/`openingAccepted`）已退役，`openingAnswered` 保留为「交付即结算」（生产发射者 = `stream-client.ts` 首帧交付处）；余下事件出口 = 删除或接线，门禁按生产 emit 判定。
- 结构性重复与死分支五条：`healRoute` 恒等、解析双份漂移、三账本可并、`carry` 五处、baseline 三连块。
- 页面侧限速：lane reconnect 注释与行为不符。

## 功能差异（chamber vs 上游；功能面取舍与缺口）

（本节只汇总功能面差异；同一条规则若已在下文「范围决策 / 裁决 / 遗留」条目里立规，以那些条目为唯一所有者，本节不重复立规。）

> 这里只收「app 做什么」的差异（功能有无、交互路径、呈现语义）。纯视觉档位与纪律条仍归
> 「范围决策与必要取舍」；vendor 侧改不动的归「无法控制的差异（外部约束）」。判据口径与候选落法见
> [todo/upstream-ui-parity-plan.md](todo/upstream-ui-parity-plan.md)（§1 = 待裁，§2 = 已收敛）。

**待裁（与 chamber 功能/契约相冲；plan §1 编号即条号，1.3 归下面的外部约束模块）**

- **1.1 pinned 会话（残余：置顶序 + 拖拽分区守卫）**：写入口与行面见 design 06 §5/§7（登记 checklist §4.6）；
  仍未接客户端置顶序（上游 `pinSessionOrder`）与拖拽的跨分区守卫；另有两处置顶诚实性缺口（未挂载来源的发送即忘、
  半开 follow 通道的陈旧集）——机制、候选落法与残余④见 design 06 §5、plan §1.1。
- **1.2 会话行时间列**：上游行尾静息显示相对时间（`primaryStatus.trailingLabel ?? timeLabel(updatedAt…)`），本仓行尾是
  **状态槽**（品牌蓝完成点 / 14px pending / `data-chamber-*` 机器标记），相对时间只在悬停卡。
- **1.5 重命名交互**：本仓行内表单（双击进入，拖拽/pending-click 围着它写），上游是 `shell.overlay` 模态
  `SessionRenameDialog` / workspace Modal。
- **1.6 search 形态**：本仓胶囊行常驻（展开即挂载），上游在来源头内 inline 展开（`max-width .18s` + `search-skeleton`
  骨架，本仓同等 `loading` 状态下用 `search.pending` 文本）。

**已裁决的本仓功能/呈现差异**（设计面见 design 06 §1–§3 与 design 05 §2；此处只登记「与上游不同」这一事实）

- 自有功能面：多来源列表/分组/来源折叠与管理、会话拖拽排序三模式 + view-prefs 持久化、归档两段式确认 + 归档管理器、
  workspace 头新建会话钮（官方 new-chat 字形）与行内重命名、搜索胶囊、悬停卡（机器自持，见下条约束）、chamber 字标（mark 回退；rail 态用
  上游 FishLogo）。
- 呈现语义：行尾状态槽（时间只在卡片）、会话卡状态行 0–1（上游 1–2 且至少一行）、菜单密度 = 原语 `compact` 实测档
  （24px 行/11px 字，比 26px 列表行矮 2px）、命中盒 = 视觉盒（六个小图标钮 20/20/18/16）、行标题两级墨色、
  动作簇 4px/20px、footer `gap: 4px`。
- 缺的上游功能（已裁不做）：`sidebar.toggle.badge`、`sidebar.workspaces` 的官方归档/恢复/过滤贡献、flat 单列表模式、
  按工作区树分组（`groupBy.workspaceTree`）、跨来源移动会话
  ——本条只登记「与上游不同」这一事实，逐条裁决与理由见下文「范围决策」条，不重复裁决文字。
- 缺的上游交互机制（**按裁决登记为不做**；上游证据用安装产物 `SB`/`WS` 简写，本仓面只写路径不写行号）：
  - **重命名提交无校验**：上游 `trim()` 后提交、空/未变/重名时禁用确认并给 `conflict.named`、聚焦全选标题、组合输入
    中的 Enter 被 `composingRef` 吞掉（`WS:1142-1152`、`WS:1430`、`WS:1440-1446`、`WS:1451`；`session-actions/RenameSession.tsx`）；
    本仓行内表单直接 Enter 提交（`server-section-controls.tsx`），`isComposing`/`trim()` 在本包零命中。
  - **折叠组上 `+` 不展开该组**：上游 `onCreate` 先展开组再建会话（`WS:508-513`）；本仓 `ServerSection.tsx` 的 `+` 只调
    `onNewSession` ⇒ 折叠态下新会话行不渲染、无当前位置反馈。
  - **搜索命中打开后不 reveal**：上游清查询、收搜索、置 `revealSessionId`、展开所属组、抬窗口、`scrollIntoView`
    （`WS:1032-1040`、`WS:343-356`）；本仓 `ServerSectionSearch.tsx` 只 `openSession`，`scrollIntoView` 在本包与
    client-core 零命中（与 §1.6 search 形态同族，重议时并裁）。
  - **本仓归档路径无提示/撤销**：上游归档后 6s toast + 撤销 + 看已归档（`session-actions/RowActionToast.tsx`）；本仓
    `sidebar-root-sessions.ts` 只 `requestRefresh`，`notify`/`toast` 在本包零命中 ⇒ 与官方 ⇧⌘A 路线行为不同。
  - **占位「新会话」行可拖拽**：上游 `draggable` 带 `!row.blank` 门（`rows/Rows.tsx`）；本仓 `ServerSectionRows.tsx` 只排除
    ghost/synthetic（同行动作簇与双击重命名已按 blank 门控）⇒ 空行可被拖走并提交一次 `insertSessionBefore` 重排。
  - **添加工作区后不自动开会话**：上游 adopt+create 后 `startSession`（`WS:1316-1319`）；本仓 `sidebar-root-dialogs.tsx`
    只建+刷新+关闭（本仓流程见 design 05 §2）⇒ 每个新工作区多一次 `+`。
  - **rail 无「添加工作区」控件**：上游两态都渲染 add 按钮（`WS:1287-1302`）；本仓 rail 只有来源色点（design 06 §5 已裁
    「rail 无搜索」；此条为其邻项）。
  - **删除工作区确认框按 unary 结果关闭**：上游等投影不再含该 id 才关（`WS:1175-1184`、`WS:1196-1204`，注释点名早关
    一帧会暴露给下一个手势）；本仓 `sidebar-root-dialogs.tsx` 在 action 报 ok 时即关 ⇒ 一帧闪影。
  - **open-in 分体控件**：上游忙/挂起时整控件禁用（含 chevron 与菜单 `open` 门控）、Menu/Tooltip 传 `portal`、按目标路径
    `key={cwd}` 重挂载（`OpenTargetButton.tsx`、`OpenInAppAction.tsx`）；本仓 `OpenInButton.tsx` 只 disable 主按钮、三处未传
    `portal`、无 `key` ⇒ 拉起中可从菜单选到被静默丢弃的项、菜单/提示不 portal、切会话后打开态与错误装饰不归零（⌥⌘O
    死键属外部约束，见下节）。
  重议条件：任一条在上游退役或本仓交互面重启时并裁。判据口径与上游行号口径见
  [todo/upstream-ui-parity-plan.md](todo/upstream-ui-parity-plan.md)（§1 = 待裁，§2 = 已收敛）。

## 无法控制的差异（外部约束：vendor 语义 / 上游缺陷与未导出面）

- **官方命令的键盘入口**（plan §1.3）：六个命令由官方 ui-workspace 注册（`WS:139-203`）。**可达四个**：
  `session.new`/`session.fork`/`session.archive` 调**共享服务**（键被派发就真的建/分叉/归档，归档在活动会话上弹官方两段式确认框）；
  `session.rename` 写 `controls.rename`，消费者是官方 `SessionRenameDialog`——它是 `shell.overlay` 的座席（`WS:4367-4372`），
  该座席由本仓 layout fork 声明（`packages/dsh-chamber-client-ui-layout/src/client/index.ts#apply` 的 `slots.register`
  子座席表 `shell.overlay`）并由官方 `AppFrame` 渲染（fork `:22`/`:181`；`renderSlot("shell.overlay")` 见产物
  `dsh-client-ui-layout/lib/client.js`）⇒ **模态真的出现**。
  **死的三个**：`session.search`（`controls.search`）与 `workspace.add`（`controls.add`；其 `noPicker` 门因本仓为每个托管来源
  pin 了 directory-picker-browse、占同一座席而放行）只把 `searchRequest`/`addRequested` 写进被覆盖的官方浏览器 store，
  没有任何本仓可见的消费者；`workspace.openLocal`（官方 ui-open-in-app 行注册的 ⌥⌘O）同理——本仓不加载该行的控制器，
  其 apps 探针落在控制面 origin，`currentApp()` 恒 undefined，键被消费后静默无反应。修法被注册表语义封死：
  `dsh-client-shortcuts/lib/client.js` 的 `ShortcutRegistry.register` 在 :589 对重复 id 抛 `Duplicate shortcut command`、
  :602 逐 runtime×platform 校验默认键重叠并抛 `Conflicting shortcut defaults`（:598/:599 另拒 Web 不可达键与保留键）
  ⇒ 既不能覆盖注册同名 id，也不能用同一默认键自建 id。未做 = 按 plan §1.3 的 C2 清单做一次实机判定（①四个活键确有效应；
  ②⌥⌘R/⇧⌘A 各只出现官方一层、与本仓行内重命名/两段式是否真的不叠加；③store 级的两个死键 ⌘K/⌘O 确无可见反应），
  再定登记口径；`workspace.openLocal` 的 ⌥⌘O 是另一种死法（键被消费、无反馈），不在 C2 三项内。
- **悬停卡与 tooltip 的抑制契约**：vendor `HoverCard` 用模块私有的 `TooltipSuppression` context 抑制锚点内 tooltip，
  该 context 不在 `ui-primitives` 导出面 ⇒ 悬停 workspace 头的 `+`（以及会话行的归档钮）时 tooltip（500ms）与卡片（800ms）会同时出现；
  退役条件 = 上游导出该 context 或本仓自持 tooltip（design 06 §7）。
- **vendor `HoverCard` 的 pointerleave 竞态 ⇒ 卡片机器自持**：`onPointerLeave` = `clearTimer()` + `if (open) armClose()`，
  dwell 到 React 提交之间落下的 leave 什么都不 arm ⇒ 卡片挂载后指针已离开且无自愈；本仓以 `hover-intent` 机器自持
  （C15 形状 + 时间常数锁步；上游修掉即退役，登记行见 [upstream-touchpoints.md](../checklists/upstream-touchpoints.md) §4）。
- **`sidebar.workspaces` 保留声明但永不渲染**：撤销声明在机制上**不抛错**（`slots.inject` 对未声明槽只是不执行回调；抛错点是回调里的 `register`），但会让官方注册与第三方注入静默消失 ⇒ 保留声明（裁决与锁见
  「范围决策」条），后果 = 上游归档/恢复/过滤贡献在 chamber 是死件。两座席（`sidebar.session.row.{leading,hover}`）不随该注册
  出现：上游注册里的两行由 vendor 补丁 13 号删除，改由本仓侧栏在**自己的** `children` 里声明并渲染（`renderSlot` 的
  `fallback` 让自有 Schedule 标记与 occupant 永不并现；design 09 §3.6 第四类第二形态）。
- **A1 座席的页面级 id 冲突（开放风险）**：座席是页面级 list slot，`ui-schedule` 用固定
  `id: 'schedule-mark'` 注册（`ui-slots` 对同 id 同优先级的第二条注册**抛错**：`already has an entry with id`）。
  单实例或只开一个实例的 schedule bundle 时无冲突；**同一页面两个实例都加载 schedule bundle**（opt-in、默认不被 shipped 模板选中）
  会在第二条注册处抛错——须先解「每实例 bundle 的页面级 slot id 命名空间」，再放开多实例同时启用。
- **平台腿未落地**：Windows 的 `[data-windows-titlebar]` 分支（属性已由 win32 preload 的 `markWindowsTitlebar` 写入，
  侧栏整块未抄，收口随 design 23）⇒ Windows 腿的侧栏
  形态与上游不同，属排期而非功能选择（Electron macOS 腿已按上游 darwin 分支收口，见第 52 行）。

## 一致性债务与开放登记（低–中，未排期；均指回代码面注释/design 登记）

- 验证面缺类：`verify:no-dead-exports` 只判「经 package entry 可达的运行时导出」⇒ **type-only 导出**不判
  （已裁：类型导出属文档/契约面、误报面大，理由与边界写在脚本头部）；**仅测试引用**的导出已规则化
  （`TEST_ONLY_EXPORT_ALLOWLIST`，每条一句理由，stale 即红）。
- 验证面缺类（叶子模块）：`verify:no-dead-exports` 只沿各包 `src/index.ts` 判定「经 package entry 可达的运行时导出」，故**无入口可达的叶子模块**对它不可见——被删的 `packages/gateway/src/util.ts` 即实例，未来同类新增同样隐形。方向：新增「`packages/*/src/**/*.ts` 必须被导入或被构建程序点名」的孤儿模块门禁（误报面待设计），或并入上一条统一收口。证据：`node scripts/gates/verify-no-dead-exports.mjs`（绿）与 `packages/gateway/src/util.ts` 的删除提交说明。
- 结构性重构与清理（未闭合；[todo/refactor-plan.md](todo/refactor-plan.md)）：三门（`verify:import-cycles`/`verify:file-budgets`/`verify:no-dead-exports`）常驻但**只本地跑**；未收口 = renderer 外三处 state/ref 镜像、`ssh-<id>` 别名与旧版本探测（保留）；跨包逐字重复可删 0 组（计划 §6）。
- `run-checks tests` 链式步骤可「零覆盖记通过」：manifest dump 丢失时 `requireDump` 只对 direct 生效 ⇒ tests 绿不代表 vendor 套件真跑；修法 = 无 dump 无 transcript 即硬失败。
- CI 打包排练 CPU bound（Windows 285–342s、macOS 133–188s）：拆成独立并行 job 后 push 侧墙钟由 Windows 排练单独决定，压缩只能动排练范围/打包参数。
- Swift 套件串行是 macOS 腿最大单项（113s，`scripts/gates/run-swift-tests.mjs`）：`swift test --parallel` 不能直接开——并行模式只在 worker 内打印分片汇总且不打印 `Test Case ... skipped` 行（G2「XCTSkip=0」判据会静默失效），套件另有多处共用固定端口（17520、17951–17953 等），须先做并行隔离与判据重设计。
- 既有升级线残余（跨代）：fatal 恢复框真机键位走查、node-pty 补偿「补丁生效、补偿可撤」复核。
- 隐私口径：`DSH_TELEMETRY_DISABLED=1` 不覆盖 `session-log-deepseek`，chamber 不拦（design 02 环境固定）。0.2.0-rc.1 起官方 `dsh-client-product-analytics` 家族进入挂载集（C4 = 24），其事件走宿主的 session-telemetry/OTel 路（launch-time opt-out = 任何非空 `DSH_TELEMETRY_DISABLED`，`profile-context.ts`）；chamber 仍不加额外门、也不默认注入该变量（与上游 `FEEDBACK_ONLY` 默认一致）——是否让桌面壳默认 opt-out 属开放裁决（用户可见的规模差异在桌面账户家族，而该家族按 design 09 §3.5 跳过）。
- `isMainFrame` 归属缺陷（真实 WKWebView 实测）：同源 blob/子 frame 经 `parent.` 投递被当主 frame；需真实壳复验，根治 = sandbox/换源（并入 S-35）。
- docs 证据锚点过期（D15）：工具已进 `check:static`；退役 = 分批语义化重锚 + 调低预算。
- 设置面残余登记（design 05 §5）：写路径余 4–8 人日（P1 台账驱动、P2 字段描述符、P3 密钥存在性）；面板要求该源壳挂载；打包态冒烟待做。
- 私有文件纪律三实现同名异签：待依赖方向裁定（design 18 §9.1）。
- `install-gateway.sh` 锚走 npm：绕过 `allow-builds.mjs` 单源；无机械锁步。
- `client-web` 未使用依赖 `ui-theme`：删除须与锁文件重生成同批。
- layout `ThemePresenter` 永不回收（有意）：残留 `color-scheme`/token/theme-color。
- wire 载体 A–F：P4-3 不合并；E 禁改。
- sanitize 语义矩阵与 win-probes 孪生：无机械锁步。
- dashboard 仍为第三份运行时 UI（共享核心迁移列后续）。
- A-U3 `SETTINGS_SET` 无 busy/pending/env 门；A-F16 `DSH_HOME` 默认偏 desktop。
- dual-host 语义下沉延后（3 处 ruling 注释，统一需新导出或行为裁定）。
- 低优 UX 残留（旧审查跟进）：hover-only 动作、徽标窄窗撑破、en 单数文案、行 aria-label/`<label>`、ssh done 态按钮、无 PluginDialog DOM 测试、对账空态双提示、versionsEpoch 不 bump、30s 超时文案、围栏/超时内联 effect。
- `test:gateway` 宿主隔离：`install-script.test.ts` 仍有 2 处直接 spawn 真实安装器（当前只走用法/解析即退出），若未来走更远会再次逃逸。
- N-ctx 文档级主题投影归属：打包态目检（须重打包）。
- 页面语言归属：冷启动变化 ≤1、预热/收割 0；另验同帧性与降级姿态。
- 构建后回填 `packages/renderer/scripts/check-chunk-budgets.mjs` 的 `chamberEntry` 基线（`build:renderer` 后重取样）。
- Git 来源分支候选：打包态目检；unborn 仓库 `branches` 必空属已知残留。
- `verify:styles` 覆盖外：`docs/**` 的 token（包级 `README.i18n.yaml` 哈希已由 `verify:i18n` 守卫，非人工纪律）。
- gateway 运维页失败分支不被夹具覆盖：需夹具 `respond` non-ok 能力。
- 归档保护候选根闭包缺一条测试（开放无过滤清理前先补）。
- 通知收敛器遗留收窄：`armedFloor` 比较近不可达、`keepFence` 待上移批次层、`setArmed`、`forgetPending`（只清 pending 不清 armed，生产零调用）与 `SessionFactsSource.getSnapshot()` 测试专用入口（均标 D4「仅测试/诊断面」，生产路径不得接线）；触发 = 下次重构。
- 旧边沿孤岛：host 事件序回退而水位前进的异形上报无排序守卫（观测层收口，不恢复第二套边沿）。
- 页面账本预热的接线对照锁：`source-lifecycle` 迁移后，「落屏写点派发 `windowReset`、绝不派发 `painted`」这条实测分歧只剩 `dsh-stream-state/src/source.ts` 的注释说明，丢的是**接线对照**那一半：两条 reducer 级不变量仍被锁（`packages/dsh-stream-state/test/source/source-lifecycle.test.ts` 的 painted 清 suppression、`source-container.test.ts` 的 windowReset 不清 suppression），但无用例阻止有人把 `painted` 接进 App 的落屏写点（会重开预热保留循环）；原锁随 `packages/renderer/test/lifecycle/source-ledger-equivalence.test.ts` 退役。
- 页面通道模块重复实例的观测缺口：`assertSingletonModule('page-channel')` 只 `console.error`（design 26 §D5 登记为**检测器**，不是守卫）——同一 bundle 出现第二份模块实例会开出第二条页面 WS，I-1 的两件工具都看不见它；根治 = socket/订阅状态改 `Symbol.for` 全局键控（成本 vs 触发面待裁）。
- `packages/dsh-stream-state/src/evidence.ts` 的 `notServingYet` 有读者（`classifyObservation` 的 unavailable 分支）但**无生产者**：送达路径上该规则不可达，唯一置真值的是测试。保留（给未来分类器接线）还是删除待裁。

## 设计未决

- C15 hover 触发降级（提案，待 CI/产品裁决）：改触发面 + 同批改 `AGENTS.md`/`upstream-touchpoints.md`/`release-workflow-policy.test.mjs`/`static-gate-parity.mjs`/`verify-release-ci-proof.mjs`。
- 双 flavor 接入点 parity：仍 open = S-01（EdDSA/Sparkle/安装与 delta）、G19（CI 签名打包）、S-44（授权查询/申请面）、S-10（遮挡/App Nap）、T-28（`corner-shape` 等引擎降级）；核验清单见 §4。
- 原生窗口高度折中（S-49）待裁：Swift 786 内容 vs Electron 800 外框；宽度偏好仍 per-flavor（T-18）。
- macOS Swift 原生壳（design 25，路线 A）：M5 实机矩阵未闭合（按用户裁定：合并到主分支后执行，见 I-15 条）；残余 = 实机/GUI 验收（含 WKWebView 无 `backgroundThrottling` 等价物）、Developer ID/公证/stapler/spctl 与首个 `build-swift` 发布腿（缺凭据外部阻断）、M5 矩阵 W-28…W-32 与双端 harness、通知音效平台等价物。
- 起始端口偏移（已定）：本地 dsh 缺省 17510（spawn 逐次 +1 至 17514）、控制面缺省 17500，仅经 `DSH_CHAMBER_DSH_PORT_BASE` / `DSH_CHAMBER_CP_PORT` 覆盖，不引入配置文件级偏移（口径见 `packages/desktop/README.md` §控制面）。
- Electron flavor 托管宿主的运行时指纹（待裁）：当前 pin（Electron 43.4.0 × dsh 0.2.0-rc.1 的 `node-addon-require-builtin@0.1.6`（pin 换锚后需复跑复核））下宿主子进程 exit 1，报 `unsupported Electron runtime fingerprint … (supported: 43.0.0 / 44.0.0 / 45.0.0-alpha.6)`，5 个起始端口全部失败——证据 `.tmp/gui-acceptance/dev-app.log`（`--dev` 验收腿）。待裁：Electron pin 对齐 addon 收录版本，或等上游 addon 收录 43.4.0（下次 pin 一并复核，见 [todo/upstream-drift-plan.md](todo/upstream-drift-plan.md) E2）。纯 node（Swift sidecar / standalone serve）不受影响。机制与指纹门见 [design 02](../design/02-host-management-deployment.md) §2.6。
- trusted-host 自定义 Host：须同步扩 trusted-host 集。
- 多控制面 `$DSH_HOME` 冲突：进一步隔离未决。
- 多控制面 catalog metadata 无跨进程 CAS：需锁内 reload + 字段 intent，或正式要求「并发 plane 必须不同 stateDir」。
- 响应头白名单双处同步（权威在 design 04 §4.3）。
- `__DSH_BOOT__` 随 dsh 漂移：以 vendor `parseBootManifest` 为准。
- 未挂载来源只读 `workspace/follow` 流（未决）：架构级解法，代价 = 侧栏再实现读通道，触碰边界；当前不走。
- facts 源 forward-skew 且载荷可解析时按整量快照替换行集（`packages/renderer/src/session-facts-source.ts` 的 `publishProbe` → `publishCompleteSnapshot`），而 design 19 §3.5 的「保留既有行」只定契**无载荷**降级（503 disabled / mode off / 无 protocol / protocol>1）：带载荷的版本偏斜是否仍算权威行集未裁，关闭 = 代码改为保留既有行或 design 补一句。

## 范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

> 双 flavor 专项登记（S/T/P/G/D + 可达性纪律）见 [deviations.md](deviations.md)。

- **两个 God 文件预算本代上调**（`scripts/gates/file-budgets.json`：`App.tsx` 2352→2358、`aggregate-store.ts` 984→1069）：worktree 放置事实/通道与行入场动画的真实增量，该表「只降不升」的本代唯一例外；两条 note 记录评审理由（2026-09 合并评审），收口方向 = 放置事实迁到 `workspace-placement.ts` 旁。

- 代码质量辅助门只本地跑（2026-09-25 裁决）：8 门退出 ci/release，仍是 `check:static` 成员；代价 = CI 不再捕获这几类漂移（登记在 `static-gate-parity.mjs`）。
- seed 自检缺包「只报不阻断」；要阻断改该 check 的 `gap` 判定。
- 组件工厂 + local slots 推迟（与手写镜像重合）。
- 0.1.6 代已裁决不做 5 项：`session/writer-held`、`sidebar.toggle.badge`、`workspace-tree` 认领、`.dsh-module-fallback` 自动删除、外部仓 `plugins.bundle.config`。
- 依赖声明补齐与跨包原语合并暂缓：待平台正确的 lockfile 重生成；此前以 parity/lockstep 门代替。
- 目标通知压制的覆盖/偏差边界（design 19 §3.2.5/§3.5）：P1 只覆盖有壳来源，facts-only 源已覆盖 ask/完成（判定侧读回退）但 `beforeBaseline` 首见窗口实际不可达（见「facts-only 判定侧读回退的已知窗口」）；mobile 无该面、facts-only `subagentCount` 仅在谱系已认证时作 busy 证据（watcher/无谱系证据来源保持 presence 语义）、paused 通知 drop、结束通知复用 `complete`、schedule/job 不覆盖、侧栏不加 goal 视觉。
- 注册表降级期间 durable 收敛：不把空/不完整 roster 当权威 ⇒ 通知账本三表不剪不落盘（修正臂表同拍不剪），fail-closed（design 05 §7.4、design 19 §3.2.4）。
- 构建产物移出 git：clean checkout 先 `pnpm run build:artifacts`；`renderer/src/generated` 不提交。
- 测试面精简上限：再压必落安全/fail-closed/parity/golden/CI 引用类 → 删减需显式裁决。
- 统一名称的保留面：bundle id（T-14）、跨进程协议串、`native-shell.page-zoom.*`（T-22）、POC 标记与 `'native-shell'` 分类 id；改名须同步 T-14/T-17/T-22 与两侧测试。
- 租客 body portal 不受 stacking 约束（残余，顶层幕布不做；design 05 §4 被否方案⑤）。
- 降级事实覆盖边界：已覆盖四座；不覆盖未激活来源、壳回收清除、单槽后报覆盖、侧栏行无动作。
- 连接页手写 tooltip 未走 vendor `Tooltip`：无 `role="tooltip"` 关联；未决 = 补 ARIA 或改用 vendor。
- api-gateway fork 未重放 rc.2 uplink 客户端半边（G43）：带 uplink 的 descriptor 同步抛错；证据 `client-uplink-rejection.test.ts`。
- 插件管理 tab 钉在上游页结构上（design 05 §5）：上游改结构即静默回归；失效判据见 design 05 §5，pin 升级按 §7 复核。
- 重打包（rev 变化）的已加载 client 插件无活页面切换路径：内核按 id first-load-wins 报 `rev-conflict('restart')` 并复用旧 factory，`restart-required` 只是事实；自动窗口重载已随 hot-reload 修复退役（`restart-window-reload.ts` 删除），需要用户手动重载页面/重启应用（design 09 §3.7/§5、design 18 §3.6 项 8）。
- live 热同步的跨来源 chunk-owner 撤销边界：页面级 `graphRows` 按 id 共享，只有 factory owner 的 remove 才撤销描述符（非 owner 保留）；**owner 自身移除而另一来源仍挂载同 id** 时描述符仍会被删（`live-graph.ts` 的 `ownsChunkDescriptor`；design 09 §3.7 ⑥）。
- `/plugins/events` 属主是上游 HMR 宿主行（cordis.patch.yml 原文 always mounted，仅 rebuild watcher 为 dev 工具；design 09 §5）：端点被移除/改名即 live 热同步静默退回 boot 现状；失效判据 = pin 升级按 §7 复验该路由与帧形状（registry `mirror.dsh-client-hmr-events-endpoint`）。
- git 客户端与宿主错误码重叠是有意例外（design 08；`host-client-lockstep.test.ts` 钉死）。
- 移出项（P3 硬纪律）：匿名 control-plane 的认证/审计、薄壳会话面、统一索引、broker、通知中心、MCP 等不得回流；design 17/18/19/08/20/24 例外不作他域先例。
- `--no-auth` 是醒目的可信网络有界例外（默认必须认证）。
- Gateway state 根目录自动收紧 0700 + 属主校验（异主 fail-closed；design 17 §12）。
- safeStorage 诚实回退：Gateway 优先 safeStorage，不可用时 target-bound 0600 明文并如实显示；SSH 密码同；Windows DPAPI 不可用则拒绝落盘（仅内存）。
- Windows 发布身份让步：x64 无 Authenticode，SmartScreen 已知；sha512 不等价签名。
- macOS 平台范围让步：v1 不发布 x64（无 Intel runner；交叉构建需 Rosetta）。
- 发布面临时收窄（2026-09-26 起，暂态；2026-09-27 恢复 gateway 腿）：正式发布出 Swift 原生壳 + gateway tarball —— 其余三条 Electron 发布腿（mac / win / linux）带 job 级 `if: ${{ false }}` 整腿跳过（不构建、不上传），`finalize-release` 的 `if:` 以 `always() && !cancelled()` 放行被跳过的依赖，同时保持 fail-closed（`validation`/`create-release`/`build-swift` 必须 success、任一腿失败即拒发）。恢复 = 删这三处 `if:` 与 finalize 的 `if:`；判据 = `.github/workflows/release.yml` 头注 TEMPORARY SCOPE（`needs` 全腿集未改，故 `pnpm run test:release-workflow` 的钉法原样成立）。
- N-ctx 单文档信任域：横向隔离推迟到每实例独立 WebContents。
- N-ctx 原生键盘路由（RC-C4，design 25 §4.4.1）：单槽桥 ⇒ 全部已 boot 实例 accept；按活动源路由要改三层 + Swift 同构，暂不做；实机验收 = 焦点在 B 只动 B、A 独有绑定不被误 preventDefault；收口触发 = 上游给作用域或决定拆投递。
- N-ctx 壳常驻语义收窄：local 恒留、隐藏壳最多 1、超限回收；完成边沿不依赖壳（design 06 §4.2、design 19 §3.3/§3.7）；仅实机腿未判。
- 官方 open-in 行加载后的页级 localStorage 键（未判为缺陷）：`ui-open-in-app/src/client/controller.ts` 把
  `OpenInAppController.choice` 落在页面级 `dsh.open-in-app.choice`，N 个实例共用一个槽；今天无可见后果
  （header 席位读 document-relative 探针 ⇒ 空列表 ⇒ 渲染 null），header 席位一旦做成可用面即成跨实例事实，
  届时应与 `dsh.sessions.current` 同法按 `ctx.chamberBasePath` 分键。
- N-ctx 下未收口的 document-relative 站点（机制、代价与机器锁见 design 09 §3.6「已知缺口」；此处只记裁决面）：
  实例侧 `ui-sidebar-documentpreview` 的 Markdown 预览图片仍解析到控制面 origin（右侧栏预览含图片的文档时图片坏）。
  **待裁决**：A（推荐，零成本）保持降级 + 向上游提中性 base 钩子；B 把该包覆盖进 composite 并打同形前缀补丁
  （两案的上游理由、收益/代价与跨 bundle 席位时序契约见 design 09 §3.6「已记录缺口」）。
  B 的执行序（若裁决）：先做「实例侧行仍在 + composite 也注册」的最小实验钉死注册时序 → 覆盖 → 补丁 → 全门 + 实机。
  触发条件：上游明确不接 A，且「预览图片在远程实例也必须可用」。
- `chamberFileApiBase` 只在其**唯一来源**做执行期断言（`chamber-entry` 要求 `chamberBasePath === /api/i/<id>`，layout fork 仅透传）：消费端 8 处 `undefined`/空串双守卫是归一契约的一部分（design 09 §3.6），不做二次校验/归一——树内不可产生空串是设计意图，测试钉的是分支语义。
- 远程来源会话状态与切源白屏：实现面闭合，实机/CI 项见上文「只读会话状态镜像」与「facts-only 判定侧读回退的已知窗口」。
- `document.hasFocus()` ≡ 宿主焦点的假设（`macos/` 无焦点观测）待实机判：它只驱动通知的 `requireHidden` 门（完成点由官方位与 App `painted` 视图解除，focus 已不参与完成判定，design 06 §4.2/§9）。
- Swift 形态的产物门已补齐、实机门仍开（design 25 §8.5）。
- 远端宿主上的空白会话残留：按已知降级接受；根治须上游给 selection 作用域。
- 复合首屏 `ui-chat` 老代实例整面失败：收口 = 升锚到当前 pin + chamber 侧诚实提示。
- 未挂载来源的工作区集合只有「回声 + 挂载 push」：不做每次变更付一次后台挂载。
- 不做（v1）：跨来源移动会话、单 store 真融合、控制面会话实时同步、远程实例管理 UI 外壳、上游视图选项菜单的
  分组与归档筛选两轴（`groupBy` 三态与 `archivedFilter` 三态——归档会话不进导航投影，看/恢复归档由归档管理器承担；
  `orderBy` 两态本仓已实现，见 design 06 §3.1）。推迟：flat 单列表模式。
- 保留项（裁决）：`ALLOW_BUILDS` 的 `fs-ext` 保留；`runtime-host-adapter` 退役不采纳（夹具契约）；连接 fork `ownsGeneration()` 守卫保留为纵深防御（删除行为等价、无法被测试见证）——不要补测试。
- 设置壳偏差：自绘 chrome、面板渲染选中源自己 boot ctx 台账（故该源壳必须挂载）、离线远端不可达占位、选择器 body portal。
- 官方桌面账户家族不加载（design 09 §3.5 有意跳过名单③）：该行的 `dshDesktop` 门在本页成立而其 `desktop-onboarding` 浮层会接管 `#root`（本页没有 desktop 表单结算它）⇒ 冷启动整页被接管；跳过 = 与官方 web 形态一致。代价：桌面账户分节（各源实测 `signed-out`）、账户登录步骤/`settings.models.sign-in` 座与 `shell.quota-notice` 认领一并消失，凭据配置回落到 models 的 API-key 编辑路径。开放风险：skip 压在上游 id 字面量上，远端实例可跑不同 dsh ⇒ 换 id/换家族会静默复发（C4 `COVERED_SENTINELS` + `roster-parity`，后者依赖 vendor 子模块/CI）。复发兜底 = `root-takeover-watch`（design 09 §3.5）：只认 #root 内联 `style.opacity=0`（稳定态按 grace，亚 grace 抖动按 15s/3 次窗口），上报 incident 并按页面预算释放；样式表/类名隐藏、`calc()`/`var()` 与替换 #root 不在网内，释放不移除外来浮层（可能仍拦指针）；`inert`-only 合法对话框不受影响。**退出条件冲突**：若上游把该门改成宿主能力而删本覆盖条目，必须同批退役/降级本网（合法 onboarding 与劫持签名不可区分）。账户面若要做属 chamber 自建特性（design 05 §5，未排期）。
- 上游对齐轮引入的有意偏差（仍成立）：首启阶段活动视图门；`sectionsEmpty` 占位保留；框架失败屏深引 `ui-primitives/src/Button.tsx`（主图已越 `mainGraphRaw.warn`，待决 = 拆懒化 or 上调阈值并写头注）；`Switch` 披露属性挂原语控制节点（收口需上游透传）；「开/选中」色用业务蓝（六处落点，不改官方组件）；侧栏 schedule 事实由 chamber 带过去（A1 后官方行座席同样渲染：`ui-schedule` 的 occupant 落在 leading/hover 座席，本仓 `SessionScheduleIndicator` 只作 occupant 缺席的 fallback）；会话状态标记（蓝点/14px 徽标）与 Dock 角标/桌面通知为保留偏差，判据 design 06 §4.3/§5、design 19 §3.7。
- 默认排序 `manual`（design 06 §3.1）；窗口标题冻结（Electron `dsh-chamber-electron`、壳 `dsh-chamber`）。
- `sidebar.workspaces` 声明但不渲染（裁决）：保留声明（撤销会让官方注册与第三方注入静默消失：未声明槽的 `slots.inject` 不执行回调，抛错点在回调内的 `register`），
  chamber 自有多源列表拥有浏览区，上游归档/恢复/过滤贡献在 chamber 为死件；锁测试
  `packages/dsh-chamber-client-ui-sidebar/test/source-runtime/sidebar-slot-declaration.test.ts`
  （design 24 §1、design 05 §2.2.1）。
- 已归档浏览过滤推迟：恢复入口走官方 `workspace/unarchiveSession`（管理器行/批量）；
  `ArchivedFilter` 镜像 + view-prefs 持久化仅在多来源确有浏览需求时排期（判据 = design 24 §1）。
- **归档准入两段式 + 旧宿主降级**（design 24 §5）：chamber 恒发官方两段式（首调无 `stopActivity`，宿主以 `workspace/session-active` 拒绝并列出活动，确认后带 `stopActivity: true` 重发，停止由宿主 provider 完成）；**已接受的降级** = 无该准入的旧宿主上第二调原样上抛，归档不再由客户端补偿停止（旧 `stopArchivedSubtree` 腿已删，不保留）——安静会话归档照旧，带后台工作的会话在旧宿主上归档后其工作继续运行；**不做版本探测**（能力自证：只有能返回该拒绝的宿主才收到第二调）。git 的 pre-remove 归档勾选同此口径（`stopActivity` 随勾选授权，旧宿主忽略该字段，行为同前）。证据：`packages/dsh-chamber-client-core/src/instance-api.ts`（`archiveSession`/`sessionArchiveRefusal`）、`packages/dsh-chamber-client-ui-sidebar/src/client/session-archive-confirm.ts`、`packages/dsh-chamber-client-ui-git/src/shared/saga.ts`。
- 菜单密度 = primitives `compact` 档（= `.compactList`，实测 24px 行 / 11px 字；design 06 §7），不得改回默认/dense。
- Electron 二进制惰性安装（共享 dist）；dev 实例隔离（独立 user-data、端口 17520 起退避）。
- 内建版本行引导（方案 2：同版本行引导「恢复内建」，下载为次要动作）。
- dsh 运行时设置面残余偏差：desktop env 换 registry、https-only vs http-loopback、周期检查不移植、prune 不可 abort、`RUNTIME_RESTART` 无单测；F4b = gateway 12 分钟墙钟上限，本地无 abort 句柄（取消通道未排期）。
- apply-now 门形态取舍：纯投影门 vs 含副作用 preflight，不整门合并。
- 探针契约残余（design 18 §3.4）：上游分页/裁剪待上游、归档不能瘦身、legacy warn 可选 sink、fail-loud、SSH attach ≥ 0.1.2-rc.1、双 404 走通用 terminal、`verifyUp` 自有期限 settle。
- 0.1.2 线已知降级（仍有效）：远端/直连 0.1.2 硬阻断；版本芯片远端隐藏；cookie 30 天无重换（~10 分钟健康窗口自愈）；remote-stream 帧校验宽松；settings-bridge `agentPresets` 合成必响亮失败；unary 兜底归档过滤无 wire 源；首屏整源降级到点击（剩余验收 = 打包态实机；残留 = `harvestParked` 只能点击自愈、归档集两收割间冻结、每源一次后台 boot、末壳留温壳、`baselinePending`/`managedDown` 标注）；gateway `ready` 不蕴含托管 dsh 就绪（`managedRuntimeDown` 投影；剩余验收 = 打包态实机；残留 = 停机不门控 unary watchdog、停机源头不可激活、settings-bridge `targetUnavailable`、`/chamber/runtime/start` 未直达）；同一文档其它逐实例全局量（`drop` 扇出与 portal 逸出为真缺陷未修、`document.title` 竞争、字号播种自愈、每壳 6 个 `<style>`）；活跃视图数据面拉活缺席（正确信号 = 推送与 unary 分歧，未排期）；推送死亡期冻结；兜底 cwd 分组限制；git 删除时 runtime 通道缺席 fail-closed；unary 30 分钟保险丝（治本 = 上游受理即回）。
- 代理 300MiB 上限 ⇒ 大会话导出中断/413，无分片逃生口（不修）。
- 平台词偏差 C3：composite 代际依赖（prefetch 失败窄竞态、旧代 CodeBlock 行定位失效）。
- settings 簇 deferred C4：官方 ui-settings 留首屏、4 个 section + 设置壳后移；失败面 = 整簇本 boot 缺失（候选 = 按家族 allSettled）。
- 插件页不检测远端真的带 `localOnly` 包（接受不检测；design 20 §6.2/§9）。
- 会话行/搜索结果标题墨色不照官方（静止次级、hover 主色；A1 教训；不得改回）。
- workspace 头部行尾动作簇间距 = 4px（不跟官方 12px；不得改回）。
- 会话行动作簇键盘不可达（同类缺陷的范围外残留）：会话行是 `role="treeitem"` 但无 `tabIndex`
  （`ServerSectionRows.tsx`），rest 态 kebab `display:none`（`.sessionRow:hover .rowActions`）
  ⇒ 重命名/分叉/归档没有键盘入口；修法（roving tabindex，或 kebab 常驻可聚焦再视觉换出）属设计裁决。
  workspace 行与来源头部已在键盘揭示态下可达（`.rowActionsVisible`/`.sourceActionsVisible`，design 06 §7）；
  来源头部在托管停机（非 `headerActivatable`，无 `tabIndex`）时其图标簇同样没有键盘入口。
- 轨道来源点多于可视高度被裁、无滚动入口（不回退为自绘滚动条）。
- footer 动作行 `gap: 4px` 是 chamber 增量（重抄官方块必须带上）。
- 侧栏/git 图标钮命中区回到视觉盒（重低于 WCAG 24px；重加 rim 前必须重测）。
- 根治该漏事件类的补丁未落地（复发再落）。
- 导轨开关没有稳定 DOM 锚点、也不带 `aria-expanded`（改身份锚定属设计裁决）。
- 悬停几何/墨色没有真指针验收腿（发布前补 W-4b-`cluster` 与墨色腿）。
- 不做 git 钩子（`core.hooksPath` 不随 clone）。
- 上游触点 registry 单一来源：`verify:registry`/`verify:anchors` 无 Windows 执行覆盖（残余盲区）；C4/C7–C15 判据留代码只按 id 引用。
- 推迟：工程门禁 P2 项（观察型 CI job、术语表、文档字数预算、checklist 转动作）。
- 上游纯镜像 README 失效链接被链接门显式跳过（C1 冻结；修复面在上游）。
- sidebar/layout 的 `main`/`types` 仍指向无人构建的 `lib/`（R4 P6 有意保留）。
- 上游镜像包的 exports 保持 `lib` 目标而磁盘无 `lib/`（有意保留；死发布面已删）。
- 元工程余量（R10）：`preload.cts` payload 形状未单源（靠文本锁）；「文本锁改 import 断言」未全量执行（161 个测试文件读源码），需范围裁决。
- desktop 跨包接入受 Swift 锚点约束（R11）：布局助手与 `resolvePnpmEntry` 顺序被 Swift 源文本锁，迁移属 macOS 门。
- 宿主插件管理器的随包 pnpm 供给待打包实机验收：控制面在托管宿主 PATH 解析不出可执行 pnpm 时，于 `<stateDir>/pnpm-shim/` 生成 wrapper 并只前置到该次 spawn 的 PATH（02 §3.1，`withPnpmShim`）；宿主已有 pnpm 时按设计逐字不动（此时不保证 11.21.0）。单测与穿线已覆盖（`pnpm-shim.test.ts`、`spawn-dsh.test.ts`、`manager-api.test.ts` 的 plane→spawn、gateway `lifecycle.test.ts` 的 gateway→plane），但「Finder 双击打包 App → 设置里安装/卸载插件成功 + 同一宿主会话 `pnpm --version` = 11.21.0」仍需一次实机确认；判定面 = 实机 + `<stateDir>/logs/control-plane.log` 的 `[dsh:<port>] pnpm: ...` 供给行。
- state 根租约的 legacy 退役时点（R2）：一个 minor 后删 `retireLegacyStateLocks` 及相关。
- Windows 覆盖缺口（R2/R14）：`state-root-lease` T4–T6 与 `host-domain-wiring-lockstep` 未进 WIN32_FILES。
- chamber-named 副本的 preflight 覆盖边界（R15）：`ui-layout` 走 C1/C2/C3 分类表，非逐文件 fork-replay。
- App.tsx 未拆簇（R7）：boot/bridge/roster 簇风险不值；渲染树与 selectors 可后续搬。
- host 域接线仍逐域手写（R14 b 方案未做）：由 `host-domain-wiring-lockstep.test.ts` ①a–⑥b lockstep 用例兜底。
- 第三类 vendor 补丁准入（维护者裁决）：`ui-chat` `use-chat-reading.ts` settle 回贴；取舍 = 24px 内微调也回贴；上游修复后删除（登记 design 09 §3.6、触点表 §3、C9 门）。
