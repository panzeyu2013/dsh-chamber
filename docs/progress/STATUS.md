# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项与范围契约。已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/`（设计契约与样式定稿）为权威，不在此复述
> 实现过程、历史用例数或每日验证日志。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

> **dsh 基线升级 0.1.1-rc.2 → 0.1.2-alpha.1 → 0.1.2-alpha.2（2026，迁移完成，双线已同步）**：
> 源码线已整体切到 dsh-v0.1.2-alpha.2（harness.commit=0a53fb55、fork 副本基线 0.1.2-alpha.2，
> 插件/探针/gateway 均已迁移，详见 docs/tmp-dsh-upgrade-audit.md 与
> docs/tmp-dsh-v012-migration-plan.md）。
> **双线一致性（release-preflight 硬门禁）已放行**：运行时线已同步 @deepseek-ai/dsh@0.1.2-alpha.2
> （npm 已发布）——release.yml env / install-gateway.sh / bundle-dsh 兜底 /
> packages/desktop/vendor/dsh/pnpm-lock.yaml 全部同代，`release-preflight --versions-only`
> 的双线一致性检查不再报 runtime != baseline。
> **BrowserAuth 适配（0.1.2 新增门禁）**：本地实例经控制面 spawn 时捕获 `dsh web:` 启动行
> launch token（进程内存随机数，行缓冲整行脱敏后进日志）→ `GET /?token=` 交换出签名 cookie
> （仅存控制面进程内存）→ 自动注入 call()/桌面实例代理 HTTP+WS/gateway 代理 HTTP+WS/gateway mux WS；
> 失败/停止清 cookie；旧 host（rc.2 无门禁）无 token 行时按旧 wire 直接工作。
> 已知降级（已记录）：
> - **远端/直连 0.1.2 dsh 附加被硬阻断**（launch token 为远端进程内存随机数、隧道不可恢复；verify 探针 401 诚实分类；上游提供 token 检索机制前保持阻断）；
> - gateway 会话索引健康路径=控制流+轮询、降级路径=纯轮询（控制流断连自动重连）；
> - approval/提问通知经 $events 流 + $events/result 应答（answer-driven 解析）；
> - workspace/follow 未接线：工作区由 session/list cwd 事实派生（workspaceId 不派生、无会话 workspace fail-closed）；
> - 版本芯片：本地实例已接线（desktop 桥运行时版本），远端实例隐藏（D2 兜底）；
> - cookie Max-Age=30 天无会话中重换：过期后约 10 分钟健康失败窗口触发重启换新（自愈，后续排期「cookie 过期即重交换」）；
> - 索引 per-key seq 水位线已删除：轮询快照可短暂覆盖更新的流投影（≤10s 自愈）；
> - remote-stream 接收面帧校验宽松于上游 exactKeys（接受未知键，前向兼容容差）；
> - settings-bridge agentPresets/select 以合成 `{agentId:'',agentPreset}` 发出（typert wire 将 Agent 参数投影为 agentId 键）：一旦被调必响亮失败（当前无调用点，潜伏面）；
> - 端口碰撞理论面：本地实例同端口 cookie 覆盖（实际不可达，登记不修）；
> - 设计 07 §3 #3（agent-default-model 回显）已解锁、实现另行排期。


- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游
  wire 根治）；实现未排期。设计见 `docs/todo/12-todo-archived-sessions.md`。
- **模型额外参数 + 默认推理等级（设计 07）**：实现推迟——wire 白名单无泛化
  透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，待上游
  解锁（07 §3/§4）。设计见 `docs/design/07-models-params.md`。
- **SSH 密码认证可选增强（05 §8 例外主体已落地）**：一键免密引导与系统
  钥匙串尚未实现；现行 SSH 密码镜像仍是 endpoint-bound 0600 明文文件。
- **Windows 首版支持暂缓**：detached/进程组/lsof 降级路径仍未形成与 Unix
  等价的运行时契约；dsh-runtime mutation 与 SSH askpass 密码认证保持只读/
  禁用门控。Gateway owner-private 目录在 Windows 只验证 real-dir/no-follow/identity
  并继承 OS ACL：Node 的 mode/chmod 无法诚实证明 POSIX 0700，不能把该让步写成
  已有等价权限保障。
- **chamber shell 内官方 bundle 的实例相对绝对路径（已知缺陷类，2026-08）**：
  官方客户端 bundle 若绕过 patched connection carrier、以实例 origin 相对
  路径直接请求（读 `location.origin` 或硬编码 `/…`），在 chamber 页面（控制面
  origin）会打到控制面自己。已知实例：
  - `@deepseek-ai/dsh-client-hmr`——`EventSource('/plugins/events')` 命中
    控制面 SPA fallback 的 text/html，每次 boot/重连刷屏 MIME 中止报错；
    已通过加入 `CHAMBER_COVERED_IDS`（page-own，无 factory）断链修复；
  - `@deepseek-ai/dsh-session-log-export`——`HEAD /api/session.export` 打到
    控制面 404 JSON，chamber 视图"导出会话日志"不可用（实例官方 UI 正常）；
    **记录缓办**：用户决策不逐个临时 fork（版本漂移 + UI 重复 + AGENTS.md
    可改源码边界扩张），待出现第二个同类特性时一次性建立 patched-copy
    基础设施（共享 base-path helper）再统一处理。
- **dsh 运行时版本管理（设计 18，M5–M7 已落地）**：剩余验证与实现缺口：
  - macOS 打包态实机：真实 `.app` 内共享 `packages/dsh-runtime`、内嵌 pnpm、
    koffi/dsh CLI 与完整激活/故障回退/数据恢复链；Linux server 同款端到端记录；
  - Gateway restart 窗口的前端重连，以及 SSH `restart_service` systemd IPC
    端到端回归；
  - `restartLocal()` 在真实 1s SIGTERM→SIGKILL grace 窗口与健康计时器交错的覆盖；
  - settings-bridge 的 gateway/ssh React 组件级交互（切换取消、失败链、hostId
    截取）仍主要由纯函数/API 客户端测试代证；
  - 该机 ZFS 下全新 pnpm store 克隆偶发 `ERR_PNPM_EAGAIN`；当前失败投影诚实且
    可重试，系统化并发缓解未排期。
  契约见 `docs/design/18-dsh-runtime-version.md` §3.6/§9。
- **apply-now 立即应用（18 增补，2026-03）**：pending 相位新增用户触发的
  「立即应用」（复用既有激活事务与 restartLocal 停机窗口，零新终态、零新崩溃
  窗口）。契约见 `docs/design/18-addendum-apply-now.md`。**剩余验收（§9.2
  实机门禁）**：macOS 打包态 `.app` 运行中「立即应用」全链；Linux server gateway
  生产 TLS 下 POST apply-now → 202 → 停机窗口轮询 → 探针 → 故障注入回退；
  `restartLocal()` 真实 1s grace × 健康计时器交错；Gateway restart 窗口前端
  重连；Windows 只读投影。
- **发布基础设施长期目标态**：把 `ci.yml` 的 test job 抽为 reusable workflow，
  由 `release.yml` validation 直接复用。当前两份 YAML 已覆盖 gateway/runtime、
  control-plane、desktop、renderer、插件、CLI 与 policy 关键门，但仍靠策略测试和
  人工同步，新增 CI 门禁存在漂移风险。
- **Gateway npm 分发延后**：现行正式分发只有 GitHub Release 中的 gateway `.tgz`
  与同名 `.tgz.sha256`；workflow 会 pack、安装到干净前缀并执行 `gateway --help`，
  **不会**执行 npm publish 或维护 dist-tag。是否开放 npm 正式发布需另行决策与门禁。
- **desktop 打包闭包已知 P2（非阻塞）**：托盘图标存在两个永不命中的候选路径；
  `dist/**/*.map` 未排除；打包态缺 `dist/preload.cjs` 时回退 `preload.cts` 会
  SyntaxError，应改为 loud 失败；单独运行 `build:renderer` 会因共享 dist +
  `emptyOutDir` 清掉其他 desktop 构建产物（完整 `build:desktop` 顺序安全）。
- **打包闭包自检（长期建议）**：CI 增加“desktop 主进程传递模块闭包 vs
  `build.files` 清单”机械检查，替代纯手工核对。

## 部分完成（剩余验收）

- **vendor 源码树 submodule 化（2026-09）**：`vendor/harness-checkout` 已从
  多源回退（env/兄弟检出/codeload）迁移为固定 commit 的 git submodule——
  gitlink 即 pin、`ensure-harness-vendor.mjs` 硬校验
  submodule HEAD == `harness.commit` 并断言链接集合 == 锁文件 vendor importer
  集合（`--check`）、幂等差量建链（集合未变零操作）、`verifyDepsBeforeRun:
  false` 掐断隐式 install、CI 五处 checkout `submodules: true` + frozen 后
  `git diff --exit-code -- pnpm-lock.yaml` 漂移断言、升级唯一入口
  `scripts/dev/update-vendor.mjs <tag>`（原子重生成锁文件）。本地已验证：frozen
  install / 幂等 / --check / 漂移演练（详见迁移提交）。**剩余验收**：Windows
  runner 上 submodule 物化 + junction 建链（`build-windows` 腿）、CI 真跑
  （push 后 ci.yml 全绿）、release.yml 改动后的 `workflow_dispatch` dry_run
  全链验证（release-checklist §7b 纪律）。
- **桌面通知（设计 19）**：自动化主链已完成；剩余 macOS 系统通知权限/
  拒绝行为、点击打开、关窗/托盘/后台三形态与打包态实机验收。
- **VS Code 深链 + open-in（设计 16/20）**：剩余 macOS 深链冷/热启动、打包态、
  托盘/退出在途、N-ctx、VS Code 缺失、`sshPort != 22`、Finder 下拉在 vendor
  会话头部的定位/层叠，以及远程来源仅 VS Code 的实机验收。
- **Git Worktree 插件（设计 08）**：M4 尚余真实远程 Linux + Git 仓库端到端
  验收（首次 ready-time seed 后重启生效、并发 session 删除竞态、Git LFS/filter
  提示与恢复边界）。
- **远程实例插件管理（设计 13）**：本地 `dsh plugin` / `pnpm pack` 仍依赖
  `resolvePnpmBinDir` 对 PATH、nvm、volta、homebrew 的 best-effort 探测；需打包态
  实机验证。
- **桌面端更新（设计 11）**：stable 与 beta 已使用相互独立的 builder 配置和
  feed（stable 仅 `latest*.yml`，beta 仅 `beta*.yml`）；只有 canonical
  `X.Y.Z-beta.N` 应用按自身版本自动锁定 beta，`alpha`/`rc`/其他 prerelease 发布
  fail closed；beta 检查先从有界 Releases API 选择最高 canonical published beta，再走
  精确 tag Generic feed，发现失败时不会调用 updater 或回退 stable。仍需用真实 Apple 凭据跑通
  一次发布 CI、Developer ID 签名/公证/stapling/Gatekeeper 验证，以及双平台
  检查、确认前不下载、下载后退出安装。正式 macOS 发布缺凭据会在 Release mutation
  前阻断；凭据或签名/公证无效会阻断 draft 公开 finalize。只有 `dry_run` 允许
  ad-hoc mac 构建；它即使面对已配置的正式 secrets 也无条件清空签名/公证环境与
  `GH_TOKEN`，且不创建/修改 Release、不上传产物。
- **会话创建/fork 侧边栏收敛延迟修复**：剩余本地 + 远程 SSH 实例实机验收
  （行出现延迟、状态图标延迟、位置跳动三类症状）。
- **认证服务端 Gateway（设计 17）**：自动化与打包面已完成，剩余发布前实机门禁：
  - 生产 TLS 反代的 Host/Origin/XFF/Secure-cookie、HTTP/WS 一致策略与 SPKI pin
    正/负例；真实 dsh 的 events.mux/events.host 断线恢复和插件 bundle；
  - 打包 Desktop 的三种代表形态（HTTPS+凭据、HTTP+凭据、显式可信网络
    `--no-auth`），重启后 safeStorage 解密/密码重登、凭据变更撤销 live stream、
    N-ctx 与完整 gateway runtime 管理面；
  - `/chamber/runtime` 在生产 TLS 下的 SSE/poll/auth，以及真实版本安装→探针→
    故障回退→DSH_HOME 恢复；
  - 真 Git 仓库的创建、歧义恢复、删除重试与并发 session 安全验证；
  - Linux 真实 system/user service 与 foreground 安装升级：目标版本/新 boot identity
    健康证明、restart 失败回滚、local/global artifact 回退及凭据/env anchor 保留；
  - `--bind 0.0.0.0` 带凭据/显式 `--no-auth`、SSH 隧道回环、tailscale 等可信
    网络形态的全链路及 401/421/403 负例。
  `session.list`→Git mutation 的 TOCTOU 目前由 realpath fail-closed、两次 live
  check 与 non-force 缩小；彻底消除仍需上游提供原子 session lease。
  - **运行时凭据管理（design 17 §7.4）自动化已落地**：v2 凭据信封（config/runtime
    source + 播种规则）、`/auth/change-password` `/auth/change-token`
    `/auth/credentials`、stateDir 独占锁、`gateway auth` 停机态 CLI、
    `/chamber/` 凭据面板与 S25 不变量。**全量修复轮（2026-09）已完成**：锁重写
    （O_EXCL 优先 + rename 认领 + 移动内容校验 + 还原 + 创建后所有权终验（双进程
    无双持）、exit 监听器仅获取成功后注册、releaseLock bytes+inode 精确复验、start() 重取
    reacquire）、S25 匿名禁种与并发 remove 串行化等安全测试补齐、
    `{remove:true}`+新值互斥 400、verifier 形状校验、`gateway auth status` 无锁只读
    与 boot 行有效 kind、rename 后 fsync 报错的 generation/readback/一次性 token
    `durability:'unknown'` 语义，以及 stop/startup-rollback 对 credential/feature/runtime
    writer 的统一 admission fence + drain（慢 body 被撤销，已入写操作持锁收敛）；**剩余**：desktop settings-bridge 便捷重置
    （Phase 4 推迟项）、真实 TLS 反代下改密/轮换/停机态 CLI 恢复的实机门禁。

## 设计未决（02 §5 / 04 §7）

- **起始端口偏移**：本地默认 17510、控制面默认 17500；当前固定起始端口 +
  P+1 重试 + 记录仲裁，是否开放配置仍未决。
- **trusted-host 自定义 Host**：当前反代 Host 与实例自身
  `127.0.0.1:<port>` 一致；未来引入自定义 Host 时须同步扩 trusted-host 集。
- **多控制面 `$DSH_HOME` 冲突**：同 stateDir 共享 home 时会话 JSONL 可追加，
  settings 由 dsh 的 `settings-conflict` 仲裁；是否进一步隔离未决。
- **多控制面 catalog metadata 无跨进程 CAS**：runtime status/dshPort/error 已完全移出
  catalog，消除了高频 stale lifecycle 写回覆盖；但两个进程同 stateDir 并发修改
  label/accentColor 仍是 last-writer-wins。可靠保持多 writer 需要 kernel-backed、
  跨平台 lifetime/document lock + 锁内 reload + 字段 intent；若不引入该能力，则需正式
  改 design 02 为“并发 plane 必须不同 stateDir”。普通 pidfile/mkdir stale lock 存在
  三方 takeover 双持，不能作为修复。
- **响应头白名单双处同步**：权威在 04 §4.3，仍建议把代码/文档表述进一步
  单源化。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状继续以 vendor
  `parseBootManifest` 为准维护。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **`--no-auth` 是醒目的可信网络有界例外**：Gateway 外部部署默认必须认证；
  只有服务器显式传 `--no-auth` 才可覆盖，启动器二次确认并打印安全告警。它不是
  静默 fallback，也不授权普通匿名 control-plane 绑定公网。
- **safeStorage 的诚实回退**：Gateway token/密码优先 safeStorage；OS 加密不可用
  时按用户决策回退 target-bound 0600 明文文件并在非秘密投影/UI 中如实显示，
  不把 plaintext 冒充密文。SSH 密码仍采用 endpoint-bound 0600 明文镜像。
- **Windows 发布身份让步**：Windows x64 安装包当前未做 Authenticode 签名，
  SmartScreen 提示是已知取舍；update feed 的 sha512 只证明下载完整性，不等价于
  发行者签名。
- **N-ctx 单文档信任域**：连接一个远端实例会让其前端代码与同一 renderer 文档内
  其他实例及高权限 preload bridge 共域。现有 main-frame/origin/proof/主进程确认
  只能缓解，真正横向隔离推迟到每实例独立 WebContents 架构。
- **移出项**（P3 硬纪律）：匿名 control-plane 的认证/审计、薄壳聊天/会话列表/
  审批弹窗、控制面会话 runtime/统一索引、连接 broker/绑定、walkthrough、通知中心/
  历史、MCP、文件夹/笔记、web 预览、目标/终端等不得回流。设计 17 的独立
  Gateway 认证/派生编排、设计 18 的共享 dsh 运行时核心、设计 19 的 Electron 原生
  边沿通知、设计 08 的实例内 Git 插件和设计 20 的可信 open-in 边缘能力是边界明确的
  例外，不得泄入匿名 control-plane、引入 session 消费者/通知历史，或变成第二套执行面。
- **不做（v1）**：跨来源移动会话、单 store 真融合、控制面会话实时同步、远程
  实例管理 UI 外壳。
- **推迟**：flat 单列表模式（与“仅按来源分类”呈现原则有张力）。
- **设置壳偏差**：未连接实例不装配子 ctx；stub remote 无 WS 失效流；壳不渲染
  官方 SettingsRoot、子 ctx 懒装配；服务器选择器使用 body portal + viewport
  翻转/钳位与内部滚动；离线远端仍可选并显示不可达占位与连接管理动作；chrome
  跟随宿主 locale，子 ctx 跟随目标实例 locale。
- **默认排序 `manual`（06 §3.1）**：按 wire 顺序，与官方默认 `updated` 不同，
  是有意产品取舍。
- **窗口标题冻结**：桌面原生标题固定为 `dsh-chamber`，会话名只在应用内呈现。
- **Electron 二进制惰性安装**：根 postinstall 默认跳过，仅
  `DSH_CHAMBER_ELECTRON=1` 或 `dev:desktop` 首启按需下载；Gateway/control-plane/
  CLI 不携带 Electron。
- **dev 实例隔离**：dev 使用独立 `packages/desktop/.dev-user-data` 与默认控制面
  端口 17520，可与打包版的 userData/17500 共存。

### 0.1.2 迁移已知偏差登记(源自 docs/tmp-dsh-v012-migration-plan.md §7.5-§7.6,临时文档移除后留存)

- ① workspace 面退化:fetchInstanceSnapshot workspaces:[]、git cwd 派生、follow TODO(fail-closed)
- ② fork 副本 exports lib/ 约定
- ③ 双线门禁刻意必红(源码 0.1.2 vs 运行时 rc.2 窗口,现已在 0.1.2-alpha.2 放行)
- ④ D2 版本芯片远端隐藏(本地实例走桌面桥)
- ⑤ answer-driven pending 清理(0.1.2 $events/result 语义)
- ⑥ cookie 30 天死窗(~10 分钟自愈,排期重交换)
- ⑦ seq 水位删除(≤10s 自愈)
- ⑧ remote-stream 接收面宽松 exactKeys(前向兼容)
- ⑨ agentPresets/select agentId:'' 潜伏面
- ⑩ 端口碰撞理论面
- ⑪ commands/execute 探针期望码 session/not-found(上游链证据,round8a 驳斥)
- ⑫-⑮ 0.1.2-alpha.2 升级注记:dist 重建同步、$host stub(bridge-context)、记账 UTF-8 口径、mountBridgeSession 全链测试盲区(需实机浏览器冒烟)
