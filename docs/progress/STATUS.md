# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项（含剩余实机门禁）、**设计未决**与**必要取舍**
> （范围决策 / 已知偏差 / 已知降级）。已实现基线以 git 历史、`CHANGELOG.md` 与
> `docs/design/`（设计契约与样式定稿）为权威，不在此复述实现过程、历史轮次、验证
> 计数或执行台账（历次轮次记录已随收口从工作文档移除，留存 git 历史）。本文档是
> dsh-chamber 进度追踪的唯一记录。

## 未完成 / 部分完成（剩余验收）

- **dsh 运行时版本管理（design 18 §3.6/§9，M5–M7 已落地）**：剩余——macOS 打包态
  `.app` 内共享 dsh-runtime/内嵌 pnpm/koffi 与完整激活-故障回退-恢复链的实机；Linux
  server 同款端到端；Gateway 重启窗口的前端重连与 connections 的 SSH
  `restart_service` systemd IPC 端到端；`restartLocal()` 在真实 1s SIGTERM→SIGKILL
  grace 与健康计时器交错的覆盖；settings-bridge 的 gateway React 组件级交互仍以纯
  函数/API 客户端测试代证；ZFS 下全新 pnpm store 克隆偶发 `ERR_PNPM_EAGAIN`
  （失败投影诚实可重试，系统化并发缓解未排期）。
- **apply-now 立即应用（design 18 addendum §9.2 实机门禁）**：macOS 打包态 `.app`
  运行中全链；Linux server gateway 生产 TLS 下 POST apply-now → 202 → 停机窗口轮询
  → 探针 → 故障注入回退；`restartLocal()` 真实 grace × 健康计时器交错；Gateway
  restart 窗口前端重连；Windows 只读投影。
- **桌面端更新（design 11 §9）**：用真实 Apple 凭据跑通一次发布 CI（Developer ID
  签名/公证/stapling/Gatekeeper）+ 双平台检查清单（确认前不下载、下载后退出安装、
  mac quitAndInstall 原生 quit 语义断言）+ 打包态 quitAndInstall 端到端与缓存清理
  （Linux AppImage 更新端到端另见 design 22 清单）。正式 macOS 发布缺凭据会在 Release
  mutation 前阻断；仅 `dry_run` 允许 ad-hoc mac 构建。
- **认证服务端 Gateway（design 17）**：剩余发布前实机门禁——生产 TLS 反代
  Host/Origin/XFF/Secure-cookie 与 SPKI pin 正/负例、真实 dsh `/api/remote.mux`
  断线恢复；打包 Desktop 三种代表形态（HTTPS+凭据 / HTTP+凭据 / 显式可信网络
  `--no-auth`）重启后 safeStorage/密码重登与凭据变更撤销 live stream；`/chamber/runtime`
  在生产 TLS 下全链；Linux system/user service 安装升级与回退；`--bind 0.0.0.0`/
  隧道/tailscale 全链负例。凭据管理剩余：desktop settings-bridge 便捷重置（推迟项）
  + 真实 TLS 下改密/轮换/停机态 CLI 恢复。
- **S0/S2 http 直连链路（design 17 §10.5）**：S0 注入与 S2 非 loopback TCP
  keepalive + staleness 自愈已实现（见 §10.5/代码注释与 git 历史，不在此复述）；
  **S2-c（放宽 dsh mux 心跳，可选增强）未实现**——前置 = 扩展 gateway patch
  写入器，单列。剩余验收：打包态实机（浏览器直连 gateway 的 Models/插件设置可
  写；杀托管 dsh/断网后 sidebar 60–120s 自动恢复；升级 dsh 版本复验钩子存在性）。
- **设计 21 网关插件能力对齐（已实现）**：剩余——§9 实机 E2E 矩阵（真实
  gateway×desktop 双通道手动/脚本化门禁、registry 实装传递依赖与 lifecycle scripts、
  故障注入、journal 中断对账；发布前执行；.172 测试机 gateway 侧升级因凭据轮换
  暂停，待用户侧恢复后按 §9 重跑）；UI 余留照实：who/when 归因 tooltip 未渲染、
  gateway 拒绝码→本地化文案映射未做（409 逐字英文）、pollGatewayReady 英文错误串
  未本地化；archive-pick file+folder 双模式对话框为 **macOS-v1**（非 macOS 保持
  文件夹对话框，随 design 22/23）。
- **归档清理与归档管理器（design 24，已实现）**：**2026 purge 幽灵行收敛
  轮（§20）已实现并经三方只读 review 修订**——purge 后已删会话浮出侧边栏/
  点击 `session/not-found` 的缺陷修复（官方 ctx 会话行 summaries 仅连接代数
  刷新 + purge 事件 no-op → 归档集合移除后行失去过滤；收敛 = chamberBridge
  `requestSessionListRefresh` + App **收敛状态机**（每次 ready 推送评估
  `planSessionListRefresh`：收缩移除 ∪ pending 中仍列行者 = 幽灵 → 按 5s
  冷却重发请求，行消失自终止——闭合「相邻 purge 收缩被合并窗口吞掉」与
  「刷新失败无重试」两 review 发现）+ 对话框每次 purge settle 即时请求，
  插件按实例调官方 `ctx.sessions.refresh()`（缺失/失败均 warn）；
  design 05 §3 桥契约已同步）。剩余——实机 **gateway/远程 dsh 形态**、§20 收敛
  执行腿（插件/App/对话框接线）与打包版 UI 目检（§19-9 偏差/待目检并入该腿，
  含幽灵行不再浮现、刷新后无干扰）；事件发射为文档化 no-op
  直至上游 wire，域随上游 `sessions.delete` wire 落地后退休（上游未落地）。
  可选增强（未排期）：PluginDialog 三态行、rowError 本地化、已归档浏览区
  （todo 12 A）；归档集合**历史无目录成员 + 收尾集合移除写失败（`archive-set`）
  残留**收敛（「删除全部」退役后无 UI 路径可达，见 design 24 §20 残余登记
  ①，建议收尾孤儿全集合清扫）；「归档当前活动会话→整源降级、
  已归档行浮出」复现确认（§20 残余登记②，dev-QA 原登记于 commit 1b19712）。
- **移动端 Web 访问面（design 17 §18）**：P1/P1.5/适配轮已实现。剩余——实机门禁
  （§18.6：真机触控目标比例/抽屉开合/键盘遮挡/安全区/汉堡不重叠/crumbs 换行/
  Session 日志图标化/iOS 单击切换/设置手机档走查/刘海横屏/深层谱系高度等）；DOM
  锚点审计剩余（details 打标缺口修复的**接线仅实机可验**、`[class$=_…]` 后缀命名
  契约测试固定、composer 锚点 fixture 化、Android 键盘盲区真机门禁）；P2（PWA 安装
  + SW 壳离线，per-instance scope，尊重官方「不完整离线」立场）；P3（公网认证流转
  正式化 + Web Push；先行形态 = 内网/可信网络 `--no-auth`/tailscale）。
- **Windows 首版（design 23）**：M0–M4 代码项已就绪、POSIX 单测绿（design 23 §2 /
  todo 头注）。剩余全为**外部门禁**，台账见 `docs/progress/todo/windows-v1.md`
  （已剪为剩余项清单；windows-baseline.md 首跑数据待填）：真实 Windows runner
  首跑绿（test-windows 腿，含 submodule 物化 + junction 建链）；M0.5 上游 dsh
  win32/NSIS protocols/Defender/原生依赖实证；M2a runner 事务矩阵；**M2b UI 翻转
  （纪律：M2a 真实 win32 全绿前不做）**；M3/M4 实机矩阵与打包验证。M5/M6 发布面
  决策/演练待发布前（另见桌面端更新、发布/CI 条）。
- **Linux 桌面（design 22，已落地 + 无头验证绿）**：剩余实机门禁按 design 22 §8
  清单（GNOME X11+Wayland/KDE 抽验：XDG 自启、深链冷/热与 CHROME_DESKTOP/xdg-mime
  路由及升级后重注册、托盘/通知点击、safeStorage keyring、SSH 密码全链、运行时
  打包态全链、自动更新端到端、AppImage 沙箱与 Wayland 焦点；另复核 before-quit
  无头挂住行为）；release.yml dry_run 全链（需 GitHub 可达）；deb/arm64 后续。
  已知未动项登记于 design 22 **§6**（裸 CLI stateDir 提示、pnpm home 边角、
  private-fs 严格 fsync 审计结论等）。
- **桌面通知 / 未读徽标（design 19）**：通知剩余 macOS 权限/拒绝行为、点击打开、
  关窗/托盘/后台三形态与打包态实机；徽标剩余 macOS Dock 打包态三态（武装/解除/退役
  + 重载与退出清零）实机；Linux 仅 Unity launcher 家族可见（文档化平台限制）；Windows
  任务栏 overlay v1 门控未接线（design 23 实机矩阵排期）。
- **会话待办区（design 06 §8，已实现）**：剩余实机门禁——通用页开关即时生效、
  同源/跨来源/未常驻跳转与权威移除、折叠来源中目标、断连→重连重现、rail 不渲染、
  「还有 N 项」展开/收起与自动收起、展开内滚动（8 行上限）、拖拽尾随点击不误开、
  同会话内联重命名不打断、打包态。
- **VS Code 深链 + open-in（designs 16/20；窗口策略已核查修复）**：剩余 macOS 实机
  验收——深链冷/热启动、打包态、托盘/退出在途、N-ctx、VS Code 缺失、`sshPort != 22`、
  Finder 下拉在 vendor 会话头部的定位/层叠、远程来源仅 VS Code（新窗口/复用两态在
  打包态真机确认）。
- **Git Worktree 插件（design 08）**：剩余真实远程 Linux + Git 仓库端到端（首次
  ready-time seed 后重启生效、并发 session 删除竞态、Git LFS/filter 与恢复边界）。
- **远程实例插件管理（design 13）**：本地 `dsh plugin`/`pnpm pack` 依赖
  `resolvePnpmBinDir` 对 PATH/nvm/volta/homebrew 的 best-effort 探测——需打包态实机。
- **会话创建/fork 侧边栏收敛延迟修复**：剩余本地 + 远程 SSH 实例实机验收（行出现
  延迟、状态图标延迟、位置跳动）。
- **chamber shell 内官方 bundle 的实例相对绝对路径（已知缺陷，2026-08 缓办决策）**：
  官方 bundle 若绕过 patched carrier 以实例 origin 相对路径直请求会打到控制面自身；
  已知实例 `dsh-session-log-export`（「导出会话日志」在 chamber 视图不可用）。用户
  决策：不逐个临时 fork，待出现第二个同类特性时一次性建立 patched-copy 基础设施。
- **发布/CI 基础设施**：test job 抽 reusable workflow 供 release.yml 复用（长期目标，
  现靠策略测试与人工同步，有漂移风险）；vendor submodule 剩余验收（Windows runner
  物化 + junction 建链、CI 真跑、release.yml 改动后 workflow_dispatch dry_run）；
  Gateway npm 分发未决策（现仅 GitHub Release `.tgz` 分发）；打包闭包自检（CI 增加
  「主进程传递模块闭包 vs build.files 清单」机械检查，长期建议）。
- **性能遗留真实机清单（P0–P2 轮）**：`docs/progress/performance-baseline.md`
  §7 五条实机复测全开放（宽侧栏冷 settle CLS、连点冷挂载切换、版本事务主进程阻塞
  采样、更新模式侧栏写频、H3 懒加载验证——需打包版或带会话 dev 实例）。
- **性能整改第二阶段（视图保留/后台门控/行窗口，2026 A/B/C/D）剩余实机验收**：
  代码面已落地（0.2.3；retention/session-row-window/measure-ui，2026 三方评审修复
  随行——预热保留槽门控、回收诊断收敛、边界语义对齐，commit 1c494a6）。剩余——
  打包版/带会话 dev 实例同环境 A/B（measure-ui：DOM 节点分壳/堆/空闲长任务/合成
  输入帧/预热壳数）+「打开→切走→重开 ×3 堆无净增长」（×3 需多次快照序列）；
  验收表与语义偏差见 performance-baseline.md §10 与 design 05 §1 注记。已知取舍
  （登记）：被回收壳内运行中任务完成蓝点/通知边沿暂停至源重开（冷 boot 首报重
  播种）；侧栏聚合落 30s unary 兜底（05 §2.3）。
- **SSH 密码一键免密引导与系统钥匙串（05 §8）**：未实现（现行为 endpoint-bound 0600
  明文镜像，见取舍）。
- **模型额外参数 + 默认推理等级（design 07）**：wire 白名单无泛化透传、host 组合不
  可注入、`agent-default-model` 未对客户端暴露——待上游解锁；`agent-default-model`
  回显已解锁、实现另行排期。

## 一致性债务与开放登记（低–中，未排期；均指回代码面注释/design 登记）

- 私有文件纪律三实现（cp `private-file.ts` 抛错式 vs dsh-runtime `private-fs.ts` kind
  结果式，同名异签）——统一需依赖方向裁定（design 18 §9.1）。
- wire 载体（A–F）登记维持：P4-3 A↔C 传输层合并**裁定不合并**（前置 ①–⑦，任一项
  未决前不动 A/C 传输面）；E（git-api）禁改（见 `wire-common.ts` 注，P4-1/2/3/N6）。
- sanitize 语义矩阵（core/desktop/gateway/installer 四成员）与 win-probes↔
  windows-process 孪生：互注无机械锁步。
- dashboard（gateway 浏览器运维页）仍为独立第三份运行时 UI，不共享 sidebar 的
  parse/poll 核心（D-2，共享核心迁移列后续）。
- C-F7 undo 语义不对称：ssh「撤销=恢复」vs gateway v1 undoForLatest（仅最新 ok
  install→remove）；服务端 preImage 备份无运行时恢复消费方（design 21 §6.8 r2–r4 二期）。
- C-F8 `GET /chamber/plugins/installed` 裸读未入写栅栏（撕裂读仅 loud 500）。
- C-F12 desktop 本地 plugin add 子进程 env 未 scrub（gateway executor 与共享 runtime
  installer 已白名单化）。
- C-F13 readManifest 三后端无共享联合（design 21 §3「单一定义」措辞未兑现）。
- A-U3 desktop `SETTINGS_SET` 无 busy/pending/env 门（env 维度放行为有意；busy/pending
  维度对称性待决策）；A-F16 `DSH_HOME` 布局默认偏 desktop（共享推导点防误读登记）。
- dual-host 语义下沉延后：activation-facts/startup-verdict 映射、restart 拒绝织、
  apply-now 门（整门合并不做，见下取舍）、identity-probe 腿——4 个分歧位以 ruling
  注释登记在代码面，统一需新 dsh-runtime 公开导出（dist 锁）或行为裁定。
- 0.2.2 审查跟进残留（低优 UX）：会话行动作仍 hover-only（键盘/触屏无揭示路径）；
  仓库组折叠 × 会话待办条带张力（确认产品意图后过滤或文档化）；chamber 表最坏徽标
  组合窄窗可能横向撑破（实机目检后定）；en 单数文案、行移除 aria-label 覆盖可见
  文本、行无 `<label>`、ssh done 态 stale 行按钮可用、无 PluginDialog DOM 测试、
  对账空态双提示；settings-dshruntime：PUT registry 成功不 bump versionsEpoch（旧源
  数据至下次自然刷新）、30s 超时文案双层措辞、围栏/超时逻辑内联组件 effect（可测性
  债务；窗口级残余服务端读侧无害 ≤3s 自愈）。
- **`test:gateway` 会停掉宿主 gateway 服务（2026-12 实机定位 + 已修）**：实机
  取证链——宿主 `dsh-chamber-gateway.service` 的三次"无故停机"（07:27:42、
  07:42:53、08:10:57 UTC）与三次 `pnpm run test:gateway` **任务启动**逐秒对应
  （+35s/+35s/+41s；后两者先跑了两个 typecheck，纯套件偏移 41s），`/tmp/gw.log`、
  `/tmp/b1.log` 均在 `install-script.test.ts` 处被 SIGTERM 截断，且 `/tmp/
  gateway-installer-overlay-rollback-*` 残留目录的 mtime 正是停机秒（`finally`
  未执行）。以 PATH 垫片捕获到真实调用 `systemctl stop dsh-chamber-gateway.service`
  + `disable`，父进程正是该测试的 `harness.sh`，触发者是 **`do_install` 用例**
  （"overlay install rollback…"）而非 cmd_update 用例。根因：
  `scripts/install-gateway.sh` 的 D2 跨形态清理**直接调用裸 `systemctl`**（不是
  `systemctl_for_mode`）并写死单元名（`install-gateway.sh:2619-2623`），而相关测试
  只 mock 了 `systemctl_for_mode`——真实 systemctl 逃逸，把运行测试的机器的真实
  服务停掉（**测试机上的实际损害是 stop**：套件本身在 gateway 单元 cgroup 内，
  `stop` 先 SIGTERM 掉调用方，`disable` 来不及执行；在普通开发机上两者都会落地）。
  **已修**：全部 harness 统一经 `harnessSource()` 注入宿主安全桩（仅当存在真实
  `systemctl` 时定义 `systemctl()` 空实现；`systemctl_for_mode` 留给库本身以保留
  作用域断言；测试自定义的 mock 仍覆盖），并加**源码级不变量测试**（每个
  `writeFileSync(harness, …)` 必须走 `harnessSource` 或落在显式 allowlist，否则
  测试失败）。**残留/约束**：D2 清理的固定单元名是安装器设计行为（跨形态迁移必须
  停旧形态）；`install-script.test.ts` 仍有 2 处直接 spawn 真实安装器（`--help`/
  `install --version`，当前只走用法/解析即退出）——若未来让它们走更远，会再次逃逸
  （stub 只覆盖库切片 harness）；`03:16:06` 的同签名停机**未被钉死**（/tmp 证据被
  07:29:45 容器重启清掉），01:22 的非优雅死亡与 01:35 陈旧锁接管已解释为容器被外部
  非正常终止 + 网关自身的锁接管恢复，09-07 23:45:29 已解释为手工 install/update。
- **N-ctx 文档级主题投影归属（2026-12 修复，design 06 §4.6）**：文档级
  `color-scheme`/`body[data-ds-dark-theme]` 改由**活动视图独占**投影（App 经
  chamberBridge 发布活动来源；ui-layout fork 的 `document-theme.ts` 按
  `ctx.chamberInstanceId` 门控、teardown 永不回收、全页单例 presenter）；
  代码面已收口（单测/typecheck/build 均过），**剩余=打包态实机目检**：首屏、
  视图切换与回收窗口的 checkbox 深浅，以及预热视图不再互踩主题。
- **Git 来源分支候选（2026-12 修复，design 08 §11.5 尾条）**：主 checkout 当前
  分支不再被候选过滤（单分支仓库不再空候选；localStorage 记忆不再永久遮蔽
  main），候选推导抽为纯函数并单测。**剩余=打包态实机目检**（判别期 harness
  gateway 停机，wire 快照仅由 host 代码路径 + 宿主 git 事实推断）；unborn
  （零提交）仓库 `branches` 必空 + 默认 base 40 零直送 git 无 preview 门仍为
  代码面已知残留（实机无此形态）。

## 设计未决

- **macOS Swift 原生壳（design 25 v2，路线 A：WKWebView + Node sidecar 全复用）**：
  方案与实施计划均已出——docs/design/25-macos-swift-native-shell.md（v2，经三个
  并行 subagent 打磨轮：逐条评审 / 承重核验 / 执行计划细化，Major 修正已闭合）+
  docs/progress/todo/macos-swift-v1.md（M0–M5 六门 + WBS W-01…W-32 + runbook/
  门禁/中止条件；估算 46–72 人-日）。**未立项**。待用户决策 D1–D7：P0 先行、
  双壳共存/bundle id、更新路线（v1 blocked-available → v2 Sparkle）、仓库落位、
  原生 UI 渐进范围、Node 版本/架构、静态凭据加密（v1 建议诚实 0600 明文）。实施
  须先过 P0 验证门（G1–G5 + WebKit 后台节流/存储隔离 C1/C2 + 桥护栏）；Electron
  版（Win/Linux/mac）并行不回归。**自主推进（2026-09-07）**：P0 代码交付级完成——
  `macos/` SwiftPM 壳（窗口/A 桥护栏/B 桥/编解码）+ `packages/desktop/poc-sidecar.ts`
  （W-03…W-05）：swift build 0 警告、swift test 24/24（含 B 桥集成 5 例，push 拓扑
  无 GUI 闭环）、sidecar 驱动 33/33、真链冒烟（真实 chamber UI→shim→Swift→sidecar
  `desktop_ssh_instances_get` 回包）；静态审查 0 Blocker/1 Major 已修（instances_get
  诚实错误帧）+ 7 项 Minor 代码修正（深度上限/Dock reopen/护栏统一/转义等）；G1 用户
  实机目测确认（本地实例正常显示），其余 G 门按用户指示暂缓；D1–D7 未签核。
   **M2/W-09+W-10 已交付（同日，逐批门禁全绿）**：shell-core.ts 落地（W-09 纯搬运）；
   W-10 S0–S11 十二批——60/60 ipcMain.handle 全迁 installIpcHandlers、HostEdges/
   electron-edges seam 落位、深链合龙、mirror 无死键断言（68/68）、main.ts 5663→
   3803（剩装配/窗口 glue/生命周期/启动事务宿主）；每批 test:desktop 全绿（收官
   896/896）+ typecheck 0。
   **M2/P1 后续已交付（同日续，消息/目标驱动持续推进）**：W-11/12/13
   sidecar-entry/node-edges/B 桥 stdio 冒烟 6/6（a669124）；W-14 门禁全绿；
   M3：BridgeClient edge/notify/ready + 60 通道无 GUI 全量冒烟（c612382）、
   W-17 manifest 管线（2c3cfc4）、W-18 前半接线+一致性 XCTest（3e082f6）、
   W-18 后半 A shim 存根（9d06caa）、E2 flavor（645a654）、W-19/20
   SwiftEdgeHostLegs 骨架+注入+装配接线（4ec76ce/9f19d0e）；swift test
   38/38、desktop 全链 38 文件绿、typecheck 0。
   **已登记硬门禁（未伪造，待实机/凭据）**：W-21 真实通知/角标腿需 BridgeClient
   异步 edge 应答改造 + GUI 验收；M4 Sparkle/blocked-available 需 Apple 凭据
   （A6）；G 门 walkthrough 与截屏此前被系统屏幕录制拒绝。
   **P3 打包闭环（同日）**：当前 HEAD 产物 zip/blockmap/app/DMG（离线
   hdiutil）就绪于 packages/desktop/release/（adhoc 签名、0.2.2）；沙箱无
   外网 → distribution 签名/notarization/dmgbuild 标准版式受阻（登记）；
   asar 抽查含当前分支核心文件；/Applications 刷新待用户确认（事故纪律）。
   **Swift 路径全量占位实现（同日 S-A…S-C-2/parity）**：hostFacts 推送、shim
   全表面 67 方法、sidecar ctx 全真化（连接/凭据/审计/确认框/插件/runtime 控
   制器族）、notify 消费路由+legs 补全；POC dev 全栈可用（DSH_SIDECAR_LEGACY_
   START=1 离线快捷门）；swift 66/66、desktop 914/914。parity 边界：update
   （Swift W-22 Sparkle 线）、settings 叶 async 化（已收口 8b988eb）、全新离线
   profile 阻塞（与 Electron 同语义）、实机门禁（SMAppService/拉起/通知闭环）。
   **状态快照（2026-09-08 17:26，用户要求记录）**：swift @ b1c19c8（树干净）；
   swift test 65/65、desktop 914/914、typecheck 0；M2/P1+M3 代码级+P3(adhoc)+
   parity 批(S-A…S-E)+跨层审计 A 类收口均已完成；POC dev 验收环境就绪（POC_*
   env + DSH_SIDECAR_LEGACY_START=1，独立 userData/17520/17511，与现网隔离）；
   硬门禁清单与解锁条件见 todo macos-swift-v1.md「当前状态快照」；最近 POC
   已退出待重拉。
   **推进轮（2026-09-08 续，M3 缺口收口批）**：W-15 Supervisor 落地（目录锁
   `flock(LOCK_EX|LOCK_NB)` + `O_NOFOLLOW`/0600/规整+属主校验 + 记录
   `{pid,startedAt,shell}` 供 sidecar-entry 只读复验；崩溃退避 500ms/60s≤3、
   exit=3 锁冲突 fatal、exit=0 不重启、spawn 失败 fatal）；E19 renderer 崩溃
   有界重载 + 三事件映射（新保留入站 `__host.rendererLifecycle` → core
   `onRendererLifecycle`，语义单源在 core）；E13 深链 `application(_:open:)`
   + `DeepLinkRelay` + `__host.deepLink` → core `enqueueDeepLink` +
   `macos/Info.plist.template`（CFBundleURLTypes，W-24 消费）；E1/E9/E20 关窗与
   退出链（新保留入站 `__host.quitFacts` → core 决策投影，复用
   `shouldHideToTray`/`computeQuitRisk`；Swift `windowShouldClose` → orderOut
   隐藏或转 `NSApp.terminate`，`applicationShouldTerminate` 三分支 +
   `.terminateLater` 5s 清理硬顶 + `QuitGate` 单飞，决策失败保守取消/隐藏）；
   桥面保留 method Swift 单源 `HostInboundMethod` 与 node-edges.ts 表锁步
   （XCTest 断言）；`bridge-shim-surface.test.ts` 接入 `test:desktop`（此前孤儿
   静默跳过，已修）；**跨层缺陷修复**：sidecar-entry 原复验把「记录 pid ≠ 自身且
   存活」一律判冲突——Swift 壳先持锁再 spawn 时记录 pid 即父进程，会导致恒
   exit 3；已按 §6.3「校验父 pid」语义修正（父 pid 放行 / 陈旧放行 / 其他存活
   进程 loud exit 3），两条真 sidecar 集成测试钉住。（Electron 侧同锁已于本轮
   落地，见下方 `chamber-lock.ts` 条目——原「未落地/开放项」登记作废。）
   **W-22 更新 v1 blocked-available 已落地**（`packages/desktop/update-headless.ts`）：
   Swift flavor 真实 check（有界 GitHub releases 列表 API → 版本比较 →
   `phase='available'` + `releaseUrl`，`isAllowedReleaseUrl` 复核）+
   `installBlockedReason` 恒「原生壳不支持自动安装」+ download/restart 核心层
   显式拒绝 + feed 故障响亮 error（绝不伪装 up-to-date）+ 不排周期检查（v1 仅
   用户主动检查，有意差异）；sidecar-ctx 由 loud stub 换真实控制器；
   settings-bridge 增原生壳 blocked 行本地化键（zh/en）与 known-reason 映射。
   **W-23 sidecar 打包已落地**（`tsconfig.sidecar.build.json` +
   `scripts/build-sidecar.mjs`）：布局 `<out>/{node, sidecar.js, package.json,
   dist/control-plane/}`；tsc 闭包校验 + esbuild 打包（control-plane/electron
   外部化）+ control-plane 产物拷贝 + 装配 package.json + Node 捆绑
   （SHA-256 校验、落位 `<out>/node`、**基名断言 A5**）；`--dry-run`/`--skip-node`
   支持离线校验；control-plane-module 增 `isPackagedSidecarRuntime`
   （`DSH_CHAMBER_SIDECAR_COMPILED=1` → 相对入口，装配目录无 node_modules 树）。
   实跑：装配产物 `sidecar.js` 两种模式均出 ready 帧、SIGTERM exit 0（Node 捆绑
   因沙箱无外网未执行，已登记）。
   **W-24 `.app` 打包已落地**（`macos/scripts/build-swift-app.mjs` +
   `entitlements.plist`/`entitlements.node.plist`）：Info.plist 由模板渲染
   （`__VERSION__`）、SwiftPM 资源包 + icon.icns + W-23 sidecar + renderer
   dist/web 装配、嵌套 node 先签 / 主 app 后签（Developer ID 带 hardened
   runtime）、`codesign --verify --deep --strict`、ditto zip / hdiutil dmg。
   **实跑发现并修正三处**：资源包不能放 .app 根（codesign 未密封内容）→ 改
   Contents/Resources + 新增 `ChamberResources` 定位（弃 `Bundle.module`）；
   entitlements plist 不能带 XML 注释（AMFI 解析）；`sidecar-entry.ts` 裸
   import `@dsh-chamber/control-plane` 在装配态 ERR_MODULE_NOT_FOUND → 一律经
   `control-plane-module` facade。**打包态端到端实跑**：`.app` 启动 → shim 注入
   → 装配态参数 + `DSH_CHAMBER_SIDECAR_COMPILED=1` → 目录锁 + Supervisor →
   `sidecar ready（shellVersion=0.2.2）` → 窗口显示 + 页面 invoke 1..10；
   ad-hoc 签名 + 208 密封资源校验通过。
   实测：`swift build` 0 告警、`swift test` **108/108**、`test:desktop` **953/953**、
   `test:macos` **30/30**（darwin 锁 + 两打包脚本；ubuntu 腿不跑）、
   `typecheck` 0、`verify:i18n` 无漂移。**W-26 CI/release 腿已落地**：
   `ci.yml` `test-macos`（swift build/test + 桥面锁步三件 + 打包 dry-run）；
   `release.yml` `build-swift`（与 Electron mac 腿同 tag 并行、`-native` 命名、
   dry-run 剥离凭据走 ad-hoc、正式腿 fail-closed Developer ID +
   notarytool/stapler/spctl + draft 上传），`finalize-release.needs` 已含
   `build-swift`；`test:release-workflow` + `verify:workflows` 绿。
   **W-27 双端同 tag 演练准备已落地**：`scripts/dev/release-artifacts.mjs`
   （两族产物清单 + 碰撞/feed 归属断言，CLI 可打印）+ 4 例测试并入
   `test:release-workflow`；演练记录（顺序/命名隔离/回滚语义）在 todo companion。
   **Electron 侧同锁已落地**（`chamber-lock.ts`，design §6.3 收口）：Darwin
   `O_EXLOCK|O_NONBLOCK` 经 `fs.open` 数值 flags（实测 EAGAIN/可重取），
   whenReady 首步取锁、失败 fail-closed 弹窗退出、`app.on('quit')` 释放（清理链
   settle 之后；2026-09 二审 #6）；非 darwin
   返回 `unsupported` 放行（loud）；7 例单测（含既有宽松权限 fchmod 收紧）。`swift-harness-driver` 可行方案
   已登记（`--harness` 模式 + node 驱动，需 GUI 会话，2–3 人日，未实施）。
   **未实跑**：GitHub runner 上的真实执行（本地仅 YAML 解析 + 策略测试 + 等价
   命令 dry-run）、真实 Node 捆绑（沙箱无外网）。**剩余 = 外部门禁**：实机
   G2/G3/G4/G5/C1/C2、退出确认/隐藏恢复/通知点击/SMAppService/launchApp、更新
   设置页 blocked 行目检、Developer ID 签名与公证（Apple 凭据）。
   **三审收口（2026-09-09，用户要求「继续修复残留」）**：打包态默认路径解析
   （新增 `PackagedLayout` 纯函数：node/sidecar/userData 同根/vendor-dsh 全部
   bundle-relative，`POC_*` 优先）+ vendor-dsh/pnpm 装配（Electron
   extraResources 同款过滤器 + 嵌套 Mach-O 先签 + release 断言）+
   Supervisor launch/终止竞态（`launchGeneration` 提交门 + 启动期退出按启动
   失败 fatal）+ 退出码分级（新模块 `sidecar-exit-codes.ts` 0/1/3/70）+
   hostFacts 重启全量重推 + 深链 relay 重启复位 + `.terminateLater` awaiting +
   CI 打开 8 例 Swift 集成（`POC_NODE_BIN`，本地 8/8 零 skip）+
   sidecar-stdio 逐通道具体断言 + 深链端到端（core→宿主腿）+
   `chamber-lock-wiring.test.ts`（main.ts 锁接线源码断言）+ update-headless
   feed 三态（全 beta/全 draft → up-to-date，仅「无可解析版本」才 error）+
   pin 守卫补 `@ref` 缺失判定。门禁：`swift test` **108/108**（0 skip）、
   `test:desktop` **953/953**、`test:macos` **30/30**、typecheck 0、
   verify:i18n 无漂移、build:preload 成功、verify:workflows OK、
   test:release-workflow 4/4、swift build 0 源告警。**三审后剩余**：E19 三处
   未声明偏离、默认端口折叠/userinfo 边界、真实 Apple 凭据公证、实机 G 门、
   真实 Node 归档下载。
   **四审收口（2026-09-09 续）**：E19 三处偏离与 Electron 对齐（giveUp 非永久、
   排定重载可取消、退出期抑制）+ TrustGuard 边界（默认端口折叠、expectedOrigin
   userinfo 拒绝）+ chamber-lock 收紧 0o7777（setuid/sticky）。门禁：
   `swift test` **108/108**、`test:desktop` **953/953**、`test:macos` **30/30**、
   其余全绿。**剩余 = 外部阻断**：Apple 凭据公证、实机 G 门、真实 Node 归档
   下载与 runner 实跑。
   **第二轮验收（2026-09-09，3 并发 subagents ×2 批 + 自验）**：第一批（Swift/JS/
   CI 三域）均 `fixes-verified-with-issues`、**无功能回归**（Swift 侧实证无误拦：
   壳首载恒根文档、前端无路径/query 路由、无 iframe；CI 侧以 fake pnpm 复刻 bash 3.2
   双分支；JS 侧独立复核 SHA 真值与 fchmod）。第二批：对抗猎捕 `no-regression`
   （归一化/双护栏/drain/锁/codesignArgs/guarded 展开全部实测）、开放项复核
   10/12 登记准确 + 3 条补登、文档漂移 10 项。**二轮新修**：release 腿空数组在
   bash 3.2 + `set -u` 下 unbound variable（dry-run 必失败）→ guarded 展开 +
   策略断言；`POC_CP_URL` 带路径/query 归一化为 origin 根；`origin(of:)` IPv6
   补方括号 + host 小写；`codesignArgs` 补 argv 单测 + entitlements 判据收紧；
   A5 改 `tar -tzf` 列成员 + 导出断言 + 合成归档三例单测 + maxBuffer 64 MiB；
   chamber-lock fchmod 分支单测；drain 移到 `runStartupTail().then(ok,err)`
   （legacy 分支亦补，且避免 `.finally` 未处理拒绝）；文档 10 处漂移（门禁数字
   94/94→**96/96**、975/975→**951/951**、补登 test:macos **28/28**、Electron 锁
   与 `quit` 释放措辞、design §3.2/§4.4.1/§4.4.2/§6.3、测试头注释与用例名、
   README 开放项）。
   **验收审计（2026-09，六路 subagents + 对抗复核；详见 todo companion）**：
   六域结论 swift-lifecycle pass-with-issues / js-wire pass-with-issues /
   packaging **fail** / ci-release **fail** / tests-gates pass-with-issues /
   docs-drift pass-with-issues。**已修**：codesign Developer ID argv 错序
   （blocker）、打包态 web-dist 落位不一致导致 sidecar fatal（blocker）、
   `test:desktop` 在 ubuntu 跑 macOS 专属用例致 CI 必红（blocker，拆出
   `test:macos` + NODE_BIN 缺省改 `process.execPath`）、A 桥缺
   「壳文档」判定（major：同源非根文档可继承 shim+60 通道 → 新增
   `TrustGuard.isTrustedDocument` 并接入消息/导航护栏）、release 腿先打包后
   公证（major → 改为 `--no-zip --no-dmg` → notarize → staple → 再生成归档）、
   Electron 锁在 will-quit 起始释放（改 `quit`）、SHA-256 断言恒真（改真值 +
   负例）、feed 无可用候选伪装 up-to-date（改响亮 error）、A5 断言恒真（加归档
   成员名/解包基名检查）、HostInboundMethod 仅 4/7（补齐 7 条 + 锁步断言）、
   `drainDeepLinkLaunches` 缺调用、chamber-lock 不收紧既有权限、文档漂移
   5 处（Info.plist 注释/design §6.1 同根声称/§6.3 旧锁条目/AGENTS 纪律措辞/
   测试头注释）。**仍开放（登记）**：打包态默认路径与 userData 同根（§6.1 U1）、
   vendor-dsh/pnpm 装配、sidecar 侧 core 汇的端到端断言、Supervisor
   launch/终止竞态与 E19 三处未声明偏离、退出码分级、hostFacts 重启簿记、
   `.terminateLater` 已确认分支、深链 isReady 重启复位、策略测试 dry-run 门
   断言（已加，见下）、pin 守卫漏无 @ref 行。
- **起始端口偏移**：本地默认 17510、控制面默认 17500；当前固定起始端口 + P+1 重试 +
  记录仲裁，是否开放配置仍未决。
- **trusted-host 自定义 Host**：当前反代 Host 与实例自身 `127.0.0.1:<port>` 一致；
  未来引入自定义 Host 时须同步扩 trusted-host 集。
- **多控制面 `$DSH_HOME` 冲突**：同 stateDir 共享 home 时会话 JSONL 可追加，settings
  由 dsh 的 `settings-conflict` 仲裁；是否进一步隔离未决。
- **多控制面 catalog metadata 无跨进程 CAS**：label/accentColor 并发修改是
  last-writer-wins；可靠多 writer 需 kernel-backed 跨平台 lock + 锁内 reload + 字段
  intent，否则应正式改为「并发 plane 必须不同 stateDir」。普通 pidfile/mkdir stale
  lock 存在三方 takeover 双持，不能作为修复。
- **响应头白名单双处同步**：权威在 04 §4.3，仍建议把代码/文档表述进一步单源化。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状继续以 vendor `parseBootManifest`
  为准维护。

## 范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

- **移出项（P3 硬纪律）**：匿名 control-plane 的认证/审计、薄壳聊天/会话列表/审批
  弹窗、控制面会话 runtime/统一索引、连接 broker/绑定、walkthrough、通知中心/历史、
  MCP、文件夹/笔记、web 预览、目标/终端等不得回流。设计 17 的独立 Gateway 认证/
  派生编排、设计 18 的共享 dsh 运行时核心、设计 19 的 Electron 原生边沿通知、设计 08
  的实例内 Git 插件、设计 20 的可信 open-in 边缘能力与设计 24 的实例内归档清理宿主
  域是边界明确的例外，不得泄入匿名 control-plane、引入 session 消费者/通知历史，或
  变成第二套执行面（design 24 例外随上游 delete wire 落地退休，不作他域先例）。
- **`--no-auth` 是醒目的可信网络有界例外**：Gateway 外部部署默认必须认证；只有显式
  传 `--no-auth` 才可覆盖，启动器二次确认并打印安全告警。不是静默 fallback，也不
  授权普通匿名 control-plane 绑定公网。
- **Gateway state 根目录自动收紧**：既有 stateDir 经 pinned no-follow 描述符自动收紧
  0700 + 属主 uid 校验（异主 fail-closed）；broad root 拒绝与 Windows 继承 ACL 让步
  不变（design 17 §12）。
- **safeStorage 的诚实回退**：Gateway 凭据优先 safeStorage；OS 加密不可用时按用户
  决策回退 target-bound 0600 明文并如实显示，不把 plaintext 冒充密文。SSH 密码为
  endpoint-bound 0600 明文镜像。**Windows 例外（C16）**：DPAPI 不可用时拒绝明文落盘，
  凭据仅内存驻留（每次连接重录）——S22 明文兜底仅限非 win32。
- **Windows 发布身份让步**：x64 安装包未做 Authenticode 签名，SmartScreen 提示是
  已知取舍；feed sha512 只证明下载完整性，不等价于发行者签名。
- **N-ctx 单文档信任域**：连接远端实例让其前端与同一 renderer 文档内其他实例及高
  权限 preload bridge 共域；现有 main-frame/origin/proof/主进程确认只能缓解，真正
  横向隔离推迟到每实例独立 WebContents 架构。
- **N-ctx 壳常驻语义收窄（2026 性能整改偏差，已登记代码注释与 design 05 §1）**：
  05 §1/§4 的「booted 壳无限常驻 / 视图生命周期 = 注册表条目生命周期」收窄为
  chamber 保留策略——local 恒留，隐藏壳最多保留 RETAINED_HIDDEN_VIEWS=1，超限
  回收「已 settle + 连续隐藏 ≥60s」的最久者（回收 = dispose shell + 卸载壳，
  实例进程/连接不受影响，重开冷 boot）；被回收源不再自动预热直到用户点开。
  运行中任务的完成蓝点/通知边沿随壳回收暂停至重开（取舍登记，见上条目）。
- **不做（v1）**：跨来源移动会话、单 store 真融合、控制面会话实时同步、远程实例
  管理 UI 外壳。**推迟**：flat 单列表模式（与「仅按来源分类」呈现原则有张力）。
- **设置壳偏差**：未连接实例不装配子 ctx；stub remote 无 WS 失效流；壳不渲染官方
  SettingsRoot、子 ctx 懒装配；服务器选择器 body portal + viewport 翻转/钳位与内部
  滚动；离线远端仍可选并显示不可达占位与连接管理动作；chrome 跟随宿主 locale，子
  ctx 跟随目标实例 locale。
- **默认排序 `manual`（06 §3.1）**：按 wire 顺序，与官方默认 `updated` 不同，是
  有意产品取舍。**窗口标题冻结**：桌面原生标题固定 `dsh-chamber`。
- **Electron 二进制惰性安装**（每机器共享 dist，worktree 并行共用）；**dev 实例隔离**
  （独立 user-data、控制面端口 17520 起自动退避）。
- **内建版本行引导（2026-12 决策，方案 2）**：选中与内建同版本行且未装受管树、
  存在用户选择时主按钮引导「恢复内建」（零下载；树/快照保留），「仍下载并安装为
  受管版本」为显式次要动作；gateway 部署锚分支同款镜像。
- **dsh 运行时设置面（2026-12 统一）残余偏差（有意保留）**：desktop `SETTINGS_SET`
  在 env 下允许更换 registry（设计文字禁、代码有意更宽）；恢复期矩阵两侧已收窄对齐
  ——swap-attempted/snapshot-failed/restore-blocked/FATAL 只开放各自 retry 与
  recover-metadata，restore-builtin 仅限 pending/健康选择（armed reset 在持久恢复
  标记下必然复阻，旧矩阵格不可执行）；registry 白名单形状 desktop https-only vs
  gateway http-loopback（共享 canonical 更宽，桌面层收紧）；desktop 15s+6h 周期检查
  不移植 gateway（避免周期出网）；失败现场清除入口仅本地（gateway 无对应路由）；
  `status()` metadata health 检测无缓存；metadata 恢复期 pnpm prune 子进程不可 abort
  （退出延迟）；desktop main.ts 的 RUNTIME_RESTART 等 handler 内联无单测（renderer
  镜像 + lockstep 代证）；env×FATAL（dormant corrupt selection）预路由为 desktop 独有
  （gateway env override 经共享核心等效处理 + 激活探针门）。
- **apply-now 门形态取舍**：desktop `evaluateApplyNowGate` 是纯投影门、gateway
  `applyNowPreflight` 是含副作用 preflight——输入与副作用各异，整门合一将推翻逐轮
  对齐语义，**不做整门合并**（两 owner 保留各自投影/执行层）。
- **探针契约残余（design 18 §3.4 定稿后）**：上游 `session.list` 分页/裁剪/删除能力
  仍待上游（chamber 不落地实现；设计 24 退休条件同源）；归档「不能瘦身」事实维持
  （探针不再读列表，归档仅影响列表体积）；legacy 回退 warn 为可选注入 sink（desktop
  与 gateway 未注入即静默；control-plane 两生产点已注入）；激活层对上游再漂移的
  可见性以失败路径为准（fail-loud）；desktop SSH attach 底线 ≥ 0.1.2-rc.1（旧树由
  signature 路径给出确定性 terminal「check or upgrade」）；远端瞬时重启/路由挂载窗
  口双 404 → 通用 terminal（粘滞窗口先于探针改动存在，与「已答即确定性」分类一致；
  ready 心跳降级为瞬态的改法引入 60s 慢重探 churn，取舍留给未来设计）；
  `verifyUp` 必须在自有限期内 settle（transport 层裸 await，无外层超时）。
- **0.1.2 线已知降级（仍有效）**：
  - 远端/直连 0.1.2 dsh 附加被硬阻断（launch token 为远端进程内存随机数、隧道不可
    恢复；上游提供 token 检索机制前保持）。dsh×http 组合已在表单与主进程校验禁用
    （http 只服务 gateway；ssh 为 dsh 唯一传输——design 17 §3 记有恢复点）。
  - 版本芯片：本地已接线，远端隐藏（D2 兜底）。
  - cookie Max-Age=30 天无会话中重换：过期后约 10 分钟健康失败窗口触发重启换新
    （自愈；「cookie 过期即重交换」另行排期）。
  - remote-stream 接收面帧校验宽松于上游 exactKeys（接受未知键，前向兼容容差）。
  - settings-bridge agentPresets/select 以合成 `{agentId:'',agentPreset}` 发出：
    一旦被调必响亮失败（当前无调用点，潜伏面）。
  - 端口碰撞理论面：本地实例同端口 cookie 覆盖（实际不可达，登记不修）。
  - unary 兜底归档过滤无 wire 源（归档集仅存在于 follow baseline）——仅影响未挂载
    来源与首次 baseline 前窗口（KNOWN DEGRADATION，`archiveSetKnown:false` 诚实三态；
    2026-09 归档回流修复后：已推送过的挂载来源断连期间保留其推送视图
    ——`shouldRetainPushedAggregate`——重连 ready-edge 不再整提交兜底降级视图；
    残留/历史降级视图由兜底看门狗限流触发 ctx 连接重连（`shouldRebaselineFallbackView`）
    重放 follow baseline 自愈）。
  - **首屏「整源降级直到被点击」形态（2026-12 修复 + 实机判别补登记）**：0.2.3 性能
    整改把「每个 ready 来源最终串行挂载」的旧通道移除后，首启只有 local 挂载 + 1 个
    预热槽且不轮转、被回收来源在用户点击前禁预热，于是 N-1 个 ready 远程源**稳态
    停留**在 unary 兜底视图（合成工作区分组 + 空归档集 ⇒ 已归档会话按普通行浮出、
    无真实工作区动作），直到用户点该服务器（`selectView` 重挂载 → follow baseline）。
    **全部自愈臂都要求 `mounted===true`**（`shouldRebaselineFallbackView`、S2 stale
    臂、`planSessionListRefresh`），对首屏未挂载源永不生效；30s 看门狗只重复提交
    同一份全量兜底，不会变权威。**修复（已实施，design 05 §2.3「首屏基线收割」）**：
    `packages/renderer/src/baseline-harvest.ts` + App 接线——ready 未挂载源在同一
    后台预热槽里挂一次、首个权威推送即回收（尝试上限 2、失败退避 120s、挂载后
    `BOOT_TIMEOUT_MS+15s` 无推送且壳已 settle 判失败、另有绝对放弃上限回收并停用
    挂死壳（同一上限也按挂载时刻、仅对未 settle 的挂载独立看管"在途挂载"本身，
    且 shell.ts 对"等待上一代 boot"设**绝对**上限（前代起始 + 两个 boot 预算，
    所有后继共享同一截止）——否则该源此后每次重挂都卡在 `previousInstanceBoot`
    上（不可提前释放尾：尾持有 generation 记录，提前释放会让迟到前代同号注册覆盖
    后继）；同族加固：页面的 producer 注册表按**代际栅栏**（`chamberBootGeneration`
    经 ctx 注入），迟到的老 boot 注册作废、其 teardown 不再可能清空健康后继的通道；
    放弃臂按**每个挂载视图的挂载时刻**判定（不只预热在途），活动/待开视图标记失败
    让覆盖层与重试出现，重试换新容器并丢弃被取代的迟到 settle；
    在途壳不计入 retention 的隐藏壳数，避免挤掉用户温壳）、用户点开即采用、
    退役同源收敛；
    **存在收割候选时独占后台槽**——温壳若
    顶上来会以 `autoPrewarmed` 身份长期占位并让剩余源永远拿不到基线；托管 dsh
    停机的 gateway 源不预热/不收割）。**剩余验收=打包态实机**（首启 N-1 源在收割窗
    内出现真实分组与归档过滤、稳态无驻留壳、慢隧道/失败源退避不卡 boot 链、收割期
    用户点击不被回收）。**登记残留**：①尝试耗尽仍未拿到基线的源（`harvestParked`）
    **不再退回普通预热**（否则白拿第三次 boot 并长期占用唯一后台槽），它保持未挂载
    并停在兜底视图，只能靠用户点击自愈；②已收割源的归档集在两次收割之间冻结（外部
    客户端变更/未挂载源的设计 24 purge 需**用户点开（重挂载）**才可见——已满足基线的
    源不再回到收割队列，与下条同族）；③首启每个
    ready 源各付一次后台 boot（稳态 ≤1 壳不变，属性能取舍；启动窗口内用户首次点击
    的排队概率上升，最坏受 60s boot 预算约束；**收割有独立预算线**——用户保留的
    隐藏温壳不再永久挡死收割，代价是收割窗口内最坏多一个隐藏壳）；④**最后收割的
    壳被保留为温壳**
    （省掉一次预热 boot，且该源的挂载期状态事实保持在线），遇到新收割候选时由
    `shouldReclaimHarvestedShell` 让位——"温壳长期占槽导致后续 ready 源无法收割"
    的形态已闭合；⑤**降级列表的诚实标注已补**（`source.baselinePending`：`connected
    && aggregateReady && archiveSetKnown !== true` 时就地提示"基线未就绪/降级列表"），
    托管 dsh 停机另有就地原因 + 恢复入口提示（`source.managedDown`，状态词复用既有
    `status.*`）。
  - **gateway 形态 `ready` 不蕴含托管 dsh 就绪（2026-12 修复 + 实机判别补登记）**：
    desktop 的 ready 只证明 gateway 进程活着（`ssh-provider.ts` 的 `verifyUp` 只探
    `/chamber/runtime/status`），侧栏**不消费**该响应的 `connectionState`，因此托管
    dsh 停机/重启窗口内 UI 无降级投影：`+` 建会话入口只在非 synthetic 真实工作区行
    渲染、状态显示（运行环/pending/完成点）只存在于挂载 producer 推送，"transport
    ready 而 dsh 已停"的窗口里按钮可点而背后不可用（dsh 直连目标无此问题——verify
    直接探 dsh 本体）。**修复（已实施，`shared/managed-runtime.ts` + App 15s 前台
    探针；判定走**独立字段** `managedRuntimeDown`，只在该源传输 `ready|degraded`
    且探针报终态停机时为 true——绝不从合并后的 `phase` 反推，因为两套词表都含
    `error`，反推会把隧道失败误诊为托管停机，2026-12 复查 BLOCKER）**：
    gateway 来源的 `connectionState` 投影进该源——终态停机
    （`stopped`/`error`/`restart-exhausted`）把 phase 换成该状态（侧栏既有状态点与
    `status.stopped/error/restartExhausted` 文案直接复用，无新增文案）并置
    `connected=false`（动作入口按既有语义禁用）；`starting`/`restarting` 同样投影进
    phase 并折叠进 `connected=false`（dsh 未服务，动作只会 503；忙碌点仍显示，
    侧栏另有 `source.managedStarting` 说明行）；`degraded` 保持传输态、按既有语义
    呈现为**未连接**（`instanceConnected` 只认 `ready`，会话子树隐藏）；探针缺失/
    非 200/代理失败一律 **fail open**
    （绝不拿缺失探针隐藏健康来源）。**剩余验收=打包态实机**：真停托管 dsh 后侧栏
    由绿转红且 `+` 禁用、重启后自动恢复；探针周期与 `/api/connections` 轮询叠加的
    请求量目检。**登记残留**：①托管 dsh 停机**不门控 unary 兜底 watchdog**——从未
    挂载的 down 源仍每 30s 拉一次（503 + 3s×5 重试突发），行虽已隐藏（权威事实已
    在手上，可顺手接进 `collectReadySourceIds`，但该谓词被多处共用，需单独裁定）；
    ②托管停机源的来源头**不再是可激活入口**（无 role/tabIndex/onClick，title/aria
    改为说明原因；2026-12 复查 MAJOR-2）——实测该路径原本到不了失败覆盖层
    （boot 成功、body 渲染空壳，vendor ConnectionBanner 无 owner），故就地补一行
    原因 + 恢复入口（`source.managedDown`）；深链/通知仍可激活该源（App 侧按
    注册表权威放行，落空则由失败覆盖层呈现）；③settings-bridge 在 `connected=false`
    时把整个设置面板换成 `targetUnavailable`，对"托管 dsh 停机但隧道正常"文案不准确
    ——**已改**：该形态改用 `managedDshDown`（"网关可达但托管 dsh 未运行"），
    「管理连接」按钮既有；剩余=托管 dsh 停机的**恢复原语**（`/chamber/runtime/start`）
    仍未从设置面板直达（现需走 connections 页的「启动实例」）。
  - **同一份文档的其它逐实例全局量（2026-12 复查登记，design 06 §4.6「同族残留」）**：
    主题投影已收口为活动视图独占，但同族还有六处——①**文档级 `drop` 扇出（真实
    缺陷，未修）**：vendor `ui-attachment/ComposerAttachments` 在 document 上挂
    drop 且无归属判定，两个壳同时挂载时一张图会同时附到两个实例的草稿；②**`<html
    lang>` last-writer-wins（真实缺陷，未修，且被收割放大）**：vendor `locale` 每次
    boot 写且无 teardown 回收，预热/收割实例的 en locale 会把可见文档翻成 `lang=en`；
    ③`document.title` 竞争写（被桌面主进程冻结标题掩盖，当前不可见）；④
    `--dsh-content-font-size` 播种读到上一个 applier 的值（下次投影自愈）；
    ⑤**portal 逃逸（真实缺陷，未修）**：vendor `ui-primitives/Modal`（含 backdrop）
    与 chamber SettingsShell/AppMenu portal 到 `document.body`，`.instance-hidden`
    只隐藏视图子树——A 的模态在程序化切换后仍盖住 B；同族 `DropOverlay` 每壳一份
    （N 层遮罩，隐藏壳的禁用副本可能盖住活动壳的启用副本）；⑥主题样式表每壳各插
    6 个 `<style>`（同内容、随 fiber 移除，良性重复）。①②的修法同主题：按活动来源
    门控（②可纯 chamber 侧实现），需 seed/patch 路线裁定后实施。
  - **活跃视图的"数据面拉活"仍缺席（2026-12 评估，未实施）**：对**当前活跃**来源，
    点会话行不触发任何聚合刷新（`openSession` 只做导航分发；`selectView` 对活跃
    视图早退），其新鲜度完全依赖后台通道（30s 兜底 watchdog / producer 推送 /
    `requestRefresh`）。推送与 unary 同时失效时视图**静默冻结在最后一次推送**
    （App onInstanceSnapshot 的保留分支），且无错误提示——恢复只能靠重挂载/页面
    刷新。**评估结论**：交接建议的"ready 且上次推送超阈值就对活跃源强制 ctx 重连"
    **不宜直接照做**——ssh 目标被 S2 臂**有意排除**（隧道 keepalive + loopback 稳定
    已保护，空闲源超过 120s 无推送是常态，按 recency 重连会对所有活跃 ssh 源产生
    周期性白 churn，见 App.tsx S2 臂注释 M1）。正确判别信号是**推送视图与 unary
    权威列表的分歧**（合并拉取时若 unary 会话行与推送视图不一致 ⇒ follow 流已陈旧
    ⇒ 触发一次限流 ctx 重连重放 baseline），需要新的分歧判定 + 限流记账；与
    design 24 §20 幽灵行收敛共用"以 unary 为权威"的语义。排期未定。
  - 推送通道死亡期间侧边栏成员关系/归档集冻结在最后推送（sessions 仍刷新、恢复推送
    自愈；冻结窗口内新归档/取消归档不可见）。
  - 兜底 cwd 派生分组限制：符号链接拼写（macOS /tmp vs /private/tmp）可能不匹配
    canonical-cwd 索引；未挂载来源的新建空工作区不可见（fail-closed 语义）。
  - git 工作树删除时 runtime 通道缺席 fail-closed（'runtime-unknown'）。
  - unary 长命令豁免残余与治本（design 03 §3.4；豁免本体已随 0.2.3 落地，见
    CHANGELOG [0.2.2]/[0.2.3]，不在此复述）：超 30 分钟保险丝的极端业务仍被
    **显式截断（504 + abort）、操作未完成、会话一致性无损**（保险丝计数发布
    中非零即复访取值）；治本——上游把 `commands.execute` 改为受理即回、结果
    经会话事件流交付（验收：受理回执形状、终态错误分类、对等待 unary 语义的
    官方客户端影响；退役：上游落地并经 chamber 验证后名单与保险丝一并退役）
    ——宿主非 chamber 可写范围，登记上游跟踪项；上游若异步化，dsh-runtime
    激活/身份探针（runtime-probes 以伪 session 直连宿主期待同步
    `session/not-found` 信封）须平行迁移（探针走直连端口不经代理、与豁免窗口
    无交集）。
- **平台词偏差 C3（2026-09 性能审计，已登记 dsh-client-web platform.ts /
  seed.ts / renderer chamber-entry.ts / shell.ts 注释）**：上游 `PLATFORM_MODULES`
  仍列 `@deepseek-ai/dsh-client-ui-primitives`，chamber 自建平台集不再 seed 该词
  （其整包命名空间导入把 markdown/高亮栈拖进 App 挂载前的 main-graph 求值）；
  改由 composite covered factory 回答 extra 行的同步 require 边，前置保证 =
  chamber 入口先于任何 extra bundle 装载（shell.ts C3 门 + host-graph.ts
  `awaitBeforeLoad`）。依赖面：本地/远端 profile 的 extra 行与用户插件 client
  bundle 的 primitives require 由该工厂回答；残余窄竞态 = shell 侧 chamber
  prefetch 失败后 create 期并发 materialize（extra loud 降级、重试自愈，
  见 chamber-entry 头注）——非静默。实测（build 产物快照 2026-09，终版 dist
  见 perf-sizes.json 与 performance-baseline.md 字节快照节）：主图
  1,403,568 → 1,185,439 raw（−218KB / −77KB gzip），chamber 入口净 +217KB
  → C4 后再 −176KB（分步再着色）；vendor 栈仍经内核 onboarding 静态链留在
  主图（部分收益，剩余面待内核懒化）。
- **settings 簇 deferred C4（2026-09 性能审计，已登记 chamber-entry.ts /
  chamber-covered.ts 注释）**：官方 ui-settings **保留首屏**（locale/ui-theme
  首屏 root-inject 其 `settingsScope`，defer 会瘫痪壳）；其后移的是 4 个官方
  settings section + chamber settings shell/connections（chamber-entry
  registerDeferred，+6 import 站点）。语义：可观测瞬态仅「设置入口缺席
  ≈1 chunk 往返」（页面首个实例首冷启一次性，其后模块缓存同 tick 解析；
  六家同 tick 注册，无中间「官方 SettingsRoot 空壳」帧）；每服设置面板
  内容经 child ctx（bridge-context mountBridgeSession）独立装载，不受
  boot-ctx 时序影响。失败面（登记）：任一 import 失败 → 整个簇本 boot 缺失
  （含 connections CRUD、dsh-runtime 管理与更新），console loud 无重试、
  靠 shell 重 boot——与既有 deferred 家族同模式；按家族 allSettled 独立
  注册为候选改进（bridge 失败可落官方降级面）。
