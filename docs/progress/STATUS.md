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
- **归档清理与归档管理器（design 24，已实现）**：剩余——实机 **gateway/远程 dsh
  形态**与打包版 UI 目检（§19-9 偏差/待目检并入该腿）；事件发射为文档化 no-op
  直至上游 wire，域随上游 `sessions.delete` wire 落地后退休（上游未落地）。可选
  增强（未排期）：PluginDialog 三态行、rowError 本地化、已归档浏览区（todo 12 A）。
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

## 设计未决

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
