# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项与范围契约。已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/`（设计契约与样式定稿）为权威，不在此复述
> 实现过程、历史用例数或每日验证日志。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

> **2026-09 dsh 基线对齐记录（0.1.2-rc.1，临时驻留；发布收口时并入 CHANGELOG 后移除）**：
> 源码线 pin → dsh-v0.1.2-rc.1（a66e4702，`update-vendor.mjs` 原子升级，tag 与远程一致；
> 锁文件重生成后 frozen 稳定、零 diff——本轮上游相对 alpha.5 **零代码改动**：全仓 252 个
> package.json 仅版本行 bump（alpha.5 → rc.1，diff 复核），客户端/wire/存储/DOM 面无任何增量）。
> fork 副本（connection/web/api-gateway）零源码重放（rc.1 与 a5 同码），版本标记
> 同步 rc.1；运行时线常量同代（bundle 锁文件 / bundle-dsh 兜底 / release.yml env /
> install-gateway.sh 锚，`bin.js --version` 冒烟 = 0.1.2-rc.1）。a5→rc.1 无任何改动
> → DOM 锚点审计基线（a4 双 pin，alpha.5 复核）与 wire 契约结论直接继承；回归测试套件见 rc.1 分支提交说明。

**0.1.2 线已知降级（仍有效）**：
- **远端/直连 0.1.2 dsh 附加被硬阻断**（launch token 为远端进程内存随机数、隧道不可恢复；verify 探针 401 诚实分类；上游提供 token 检索机制前保持阻断）。**2026-09：dsh×http 组合已在连接表单与主进程校验禁用**（http 只服务 gateway；ssh 为 dsh 唯一传输——设计 17 §3 记有恢复点）。
- **版本芯片**：本地实例已接线（desktop 桥运行时版本），远端实例隐藏（D2 兜底）。
- **cookie Max-Age=30 天无会话中重换**：过期后约 10 分钟健康失败窗口触发重启换新（自愈，后续排期「cookie 过期即重交换」）。
- **remote-stream 接收面帧校验宽松于上游 exactKeys**（接受未知键，前向兼容容差）。
- **settings-bridge agentPresets/select 以合成 `{agentId:'',agentPreset}` 发出**（typert wire 将 Agent 参数投影为 agentId 键）：一旦被调必响亮失败（当前无调用点，潜伏面）。
- **端口碰撞理论面**：本地实例同端口 cookie 覆盖（实际不可达，登记不修）。
- **设计 07 §3 #3（agent-default-model 回显）已解锁**、实现另行排期。
- **unary 兜底归档过滤无 wire 源**（0.1.2 删 workspace.list；归档集仅存在于 follow baseline）——仅影响未挂载来源与首次 baseline 前窗口（KNOWN DEGRADATION，见 `instance-api.ts` fetchInstanceSnapshot）。
- **推送通道死亡期间侧边栏成员关系/归档集冻结在最后推送**（sessions 仍刷新、恢复推送自愈；冻结窗口内新归档/取消归档不可见；mounted 源在 store 未 withdraw 的断连→重连窗口同样落入全量兜底视图直至下一次真实推送——见 `aggregate-refresh.ts` commitAggregatePull 注释）。
- **兜底 cwd 派生分组的已知限制**：符号链接拼写（如 macOS /tmp vs /private/tmp）可能不匹配 canonical-cwd 索引，会话落未分组桶（诚实兜底）；未挂载（兜底）来源的新建**空工作区**不可见（无会话即无组，fail-closed 语义）。
- **git 工作树删除时 runtime 通道缺席 fail-closed**（'runtime-unknown'）。

- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游
  wire 根治）；实现未排期。设计见 `docs/progress/todo/12-todo-archived-sessions.md`。
- **gateway 连接插件能力对齐（A/B/C，2026-12 用户提出；Phase 1-5 已实现 + 质量审核修复轮已落地，见 design 21/本段）**：
  gateway 连接缺 ssh+dsh 的第三方插件「添加/同步」（design 17 §3/§10 收窄的
  副作用）、connections 页缺 gateway 受控重启入口、日志/主机日志按钮不可区分。
  B（连接日志/网关主机日志改名 + 图标去重）与 C（gateway 卡 + 插件面板「重启
  dsh」，经实例代理 `/chamber/runtime/restart` + 202/status 轮询；gateway-runtime
  parse/poll 纯核心迁 sidebar/shared）已定稿；A v1 已拍板：**单一插件管理模型、
  仅最终执行阶段分叉**（gateway 宿主 spawn vs ssh exec，非双通道同权）；registry
  spec 直装 + 文件夹直推双通道（出网允许、registry 来源不限定、lifecycle scripts
  默认允许），第三方同步仅手动、批量一次确认，runtime 单写者栅栏 + ready 边沿
  deferred 排空；含远端「已安装」列表显式移除（模型统一、ssh/gateway 同权）、
  `POST /chamber/runtime/start` 停机恢复原语、journal/备份撤销最近操作、故障域
  恢复（评审 P1 修正已并入 v2）。契约见
  `docs/design/21-gateway-plugin-parity.md`（原 todo 评审稿已并入该 design）；执行计划见
  `docs/progress/todo/21-gateway-plugin-parity-plan.md`（Phase 0-6，逐阶段门禁）。
  **实现进度（2026-12，执行级门禁零 P0/P1）**：Phase 1 B ✅、Phase 2（C + gateway-runtime parse/poll 迁
  sidebar/shared + ambient 镜像 + 卡片/面板「重启 dsh」）✅、Phase 3 A0（gateway installed 读路由 +
  desktop `gateway_plugin_sync` IPC + 视图 chamber 同步/漂移）✅、Phase 4 A1 写面 ✅、Phase 5 UI 全闭环
  ✅（详情见下三段）；
  其中 Phase 4.3 的白名单族前置已先行落地：spec/name/materialize 白名单 + MAX 字符 +
  WRITE_FILE/RUN_STDOUT 上限迁 `control-plane/src/plugin-spec.ts`（design 21 §6.2 单一来源；desktop
  经 control-plane-module.ts 双路径 facade 与原 ssh-provider 再导出消费、gateway 经包导出直引），新增
  `isDeniedPluginName` 保留名谓词（@deepseek-ai/* + @dsh-chamber/*，decision 19），渲染端 ADD_SPEC 镜像
  锁步测试落地（gateway/test/plugin-spec-lockstep.test.ts；ssh 侧 applyPlugins 保留名拒绝接线随统一增量）；
  运行级验证（typecheck/test/实机）待可运行工作区执行（登记残余风险，不虚报）。
  **运行级验证状态更新（2026-12 后期）**：本工作树已可用 `~/.nvm/versions/node/v24.20.0` + pnpm 装入
  node_modules（vendor/harness-checkout 子模块仍缺失，仅影响需 vendor 源码的构建如 build:renderer/打包）——
  已落地内容在可运行子集上**已执行验证**：test:gateway 全绿、test:connections 10/10、test:sidebar（含镜像
  锁步 5/5）、test:settings-bridge、desktop 受触套件（gateway-sync-registry/plugin-sync/ssh-provider/
  transport-manager/ipc-surface-mirror/renderer-trust/cross-package-contract/gateway-provider）全绿；
  typecheck:gateway/:connections/:sidebar/:settings-bridge 0 错误；Phase 4 起门禁以执行级为准（子代理默认 shell
  无 nvm PATH——命令需显式 export 或在父代理侧运行）。
  **Phase 4 进度（2026-12，执行级验证）**：4A 白名单共享迁移、journal+串行执行器（含 XDG_CONFIG_HOME pin/
  前后双检/onTerminal）、写栅栏 beginProfileWrite（双向互斥）+ start 原语 + beforeSpawnCheckpoint 生产接线、
  plugins-tasks 编排器（lease/deferred.json/单飞 drain）与 install/remove/materialize(流式 32MiB+tgz 上限)/
  tasks 四条写路由均已实现——gateway 全套 481 测试（478 通过 0 失败 3 平台跳过）+ typecheck 0 错误；
  Phase 4 已勾销（2026-12，执行级门禁零 P0/P1：汇总门禁 FAIL 1 P1 → I4 修复 → P1 关闭复核 CLOSED；
  gateway 487/484/0fail/3 平台跳过、desktop 全链 724/724 26 文件、root typecheck 0）：4G apply/materialize
  IPC、F7×租约串行化（waitForProfileWriteIdle 先于 restore）、executor canRun 窗口复核（等待-再-阻断）、
  code 族统一（reserved）、remove-before-add（decision 5）、256MiB 解包上限对齐均落地。Phase 6 归口登记：
  remove not_installed/no_manifest 409-vs-400 定夺、dispatch/routes 陈旧注释清扫、journal 保留窗口、
  'too_large' 双档、任务面措辞回写。
  **Phase 5 进度②③（2026-12，执行级）**：② ssh 模态新增远程「已安装」list tab（逐行移除确认 + 撤销
  undo IPC、fail-loud verified/ready 标记照实呈现；等价表逐键保持、local 模式零改动）；③ gateway 统一视图
  增量（PluginInventoryView：已安装行/移除/撤销/变更记录 tasks 投影（deferred 意图+busy+recovery 提示）/
  profile_absent-corrupt 横幅/停机 chamber 区降级标签；修复 Phase-3 遗留 seed-cache 双前缀真 bug）+ 卡片
  「启动实例」start 动作（runtime 探测门控 stopped/error/restart-exhausted、202+poll）；A 键表 34+1 键
  （296/296）。connections 全链 112/0、typecheck 0。Phase 6 归口（非阻断）：who/when 归因 tooltip 渲染
  （initiator 投影）、gateway 拒绝码→本地化文案映射（queue_busy 等）、统一单组件双后端合体未做（功能等价
  双面，已登记）、实机 E2E 矩阵门禁不可在本树执行（照实登记）。
  **Phase 5 进度①（2026-12，执行级）**：纯模型层 plugin-model.ts（deny 镜像/orderApplyOps/
  ApplyOutcome 分类（含 ssh fail-loud verified/ready/readyNote 诚实携带）/projectTasks/undoForLatest/
  分派表/BATCH_FAILURE_POLICY 单一取舍；35 测试 + 控制面 lockstep）✅ 门禁修复后零 P0/P1；ssh 统一增量
  （readManifest 掩码统一挂接 SSH_PLUGIN_LIST、保留名整批拒绝（decision 19 同集）、ssh-plugin-journal +
  SSH_PLUGIN_UNDO IPC（撤销=恢复语义、file-backed/out-of-model 不投影）、undo 诚实面）✅ 门禁 PASS +
  两条 P2 修复（upgrade-restore 对称恢复、executed-but-not-effective 投影）。
  **质量审核修复轮（2026-12，审核后执行；全量验证绿）**：4×P1 已修复——executor
  租约泄漏（journal 终态写失败/记录丢失仍触发终态钩子，plugins-exec complete()）、
  executor env 白名单化（INSTALL_ENV_WHITELIST 共享常量，同 dsh-runtime 源）、
  deferred 排空后自动受控 restart 一次（全部排空 op 终态后请求——首 op 终态请求会撞后续
  op 租约门，第二轮扫描修正为末 op 终态点；index.ts restartManaged 门控镜像 /restart 同步
  拒绝族）、ssh undo journal 操作目标指纹绑定（latestOkForTarget + 删除/编辑
  转换路径 clear 接线）；8×P2 已修复——错误脱敏升级（sanitizeInstallerOutput 族 +
  2000B 有界）、tasks/deferred 投影 file: 掩码、崩溃孤儿子进程 pid journal + 启动
  对账击杀、手动 chamber 同步失败显式化 ok:false（both-false 遗留 P2 勾销）、
  gateway_plugin_apply 确认后重检、deferred drain 波浪续排（>8 积压自清）、staged
  tgz 三处 GC、persistence_failed 500 错误码族；均带失败注入/行为测试。文档归位
  本次补全：design 17（§3 表 F4 勘误 + §10 写面 + §4.1 barrier 语言）、design 18
  （§6 出网登记 + §9.3 start 行/互斥矩阵/兜底链更正）、design 05 §5（F4 勘误 +
  design 21 增补）、design 13（收敛表述）、sidebar/settings-bridge README 双语文档
  与哈希重录——修复明细见 design 21 §10「质量审核修复补录」。
  第二轮扫描修正（复核修复轮自身，⑭–⑰）：drain 自动重启请求点改为本轮全部排空 op 终态后
  （原首 op 终态会撞在途租约门）、materialize 路由 500 分支补 staged GC、tasks 投影删除
  childPid（活进程 pid 不出网）、波浪测试强化（200ms 慢关 + 租约授予时序证明，5 次连跑稳定）。
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
- **Linux 桌面首版支持（设计 21，2026-12 落地）**：AppImage（x64）发行 + 形态门
  自动更新 + 桌面集成修复已入库（打包配置；updater 形态门——探针按
  AppImageUpdater 真实替换语义校验启动形态/绝对常规文件/父目录可写，2026-12
  review 加固；XDG（仅绝对路径）/APPIMAGE 自启与协议 .desktop 每启重写 +
  CHROME_DESKTOP 指回；node 兜底平台分表 + X_OK；目录 fsync EINVAL/ENOTSUP
  平台无关容错；resolvePnpmBinDir Linux 根；release.yml build-linux 腿与策略
  测试 4 腿）。**无头验证（Ubuntu 22.04 测试机）**：Linux 原生 CI 对齐全量套件
  全绿（node 24.20、非 root runner 形态）；`dist:desktop:linux` 产物与 feed
  （url/size/sha512）、AppImage 内 .desktop 身份、afterPack 断言全部通过；
  双形态无头冒烟（AppImage 提取运行 / 解包目录）验证协议 .desktop 指向、
  形态门开关与本地 dsh 实例全链。细节入 CHANGELOG/发布笔记。
  **剩余实机门禁**（真实桌面矩阵 GNOME X11+Wayland、KDE 抽验，清单见设计 21
  §8）：XDG 定制自启、深链冷/热启动与 **CHROME_DESKTOP/xdg-mime 路由**及
  AppImage 升级后重注册、托盘可见性、通知点击、safeStorage 有无 keyring、
  SSH 密码全链、运行时安装/切换/apply-now/restartLocal 打包态全链、
  **自动更新端到端（已下载→退出→$APPIMAGE 原位替换→重启；stable+beta；
  二次更新）**、AppImage 沙箱与 Wayland 焦点、before-quit 确认框的无头挂住行为
  确认；另有 release.yml dry_run 全链验证（需 GitHub 可达，见下方 submodule
  剩余验收同纪律）与 deb/arm64 后续排期。
- **Linux 桌面已知未动项（登记）**：托盘图标候选两死路径见既有「desktop 打包
  闭包已知 P2」条目（同事实）；gateway 裸 CLI 默认 stateDir ~/.dsh-chamber 与
  control-plane standalone 同目录（裸跑形态运维提示待加；安装器形态
  DSH_GATEWAY_STATE 无此问题）；不做独立 verify-linux-appimage 脚本（取舍见
  设计 21 §5，以 afterPack + workflow 内联 + 无头冒烟覆盖）；XDG_DATA_HOME 偏移
  的 pnpm home 与 macOS ~/Library/pnpm 未纳入 resolvePnpmBinDir（低优）；
  dsh-runtime private-fs.ts syncPinnedDirectory 保持严格目录 fsync（设计 21 §6
  审计结论，未并入容错）；userData 实测 ~/.config/@dsh-chamber/desktop（可选
  优化 app.setName，未做）；electron-builder desktopName/syncDesktopName 提示
  （WM_CLASS 关联，低优）。
- **chamber shell 内官方 bundle 的实例相对绝对路径（已知缺陷类，2026-08）**：
  官方客户端 bundle 若绕过 patched connection carrier、以实例 origin 相对
  路径直接请求（读 `location.origin` 或硬编码 `/…`），在 chamber 页面（控制面
  origin）会打到控制面自己。已知实例：`@deepseek-ai/dsh-session-log-export`——
  `HEAD /api/session.export` 打到控制面 404 JSON，chamber 视图「导出会话日志」
  不可用（实例官方 UI 正常）；**记录缓办**：用户决策不逐个临时 fork（版本漂移 +
  UI 重复 + AGENTS.md 可改源码边界扩张），待出现第二个同类特性时一次性建立
  patched-copy 基础设施（共享 base-path helper）再统一处理。（`dsh-client-hmr`
  同类问题已断链修复。）
- **dsh 运行时版本管理（设计 18，M5–M7 已落地）**：剩余验证与实现缺口：
  - macOS 打包态实机：真实 `.app` 内共享 `packages/dsh-runtime`、内嵌 pnpm、
    koffi/dsh CLI 与完整激活/故障回退/数据恢复链；Linux server 同款端到端记录；
  - Gateway restart 窗口的前端重连，以及 connections 的 SSH `restart_service`
    systemd IPC 端到端回归（settings 的 dsh-runtime 段已移除 ssh 分支）；
  - `restartLocal()` 在真实 1s SIGTERM→SIGKILL grace 窗口与健康计时器交错的覆盖；
  - settings-bridge 的 gateway React 组件级交互（切换取消、失败链）仍主要由
    纯函数/API 客户端测试代证；
  - 该机 ZFS 下全新 pnpm store 克隆偶发 `ERR_PNPM_EAGAIN`；当前失败投影诚实且
    可重试，系统化并发缓解未排期。
  契约见 `docs/design/18-dsh-runtime-version.md` §3.6/§9。
- **apply-now 立即应用（18 增补）**：pending 相位新增用户触发的「立即应用」
  （复用既有激活事务与 restartLocal 停机窗口，零新终态、零新崩溃窗口）。契约
  见 `docs/design/18-addendum-apply-now.md`。**剩余验收（§9.2 实机门禁）**：
  macOS 打包态 `.app` 运行中「立即应用」全链；Linux server gateway 生产 TLS 下
  POST apply-now → 202 → 停机窗口轮询 → 探针 → 故障注入回退；`restartLocal()`
  真实 1s grace × 健康计时器交错；Gateway restart 窗口前端重连；Windows 只读投影。
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
- **打包闭包自检（长期建议）**：CI 增加"desktop 主进程传递模块闭包 vs
  `build.files` 清单"机械检查，替代纯手工核对。

## 部分完成（剩余验收）

- **vendor 源码树 submodule 化（2026-09）**：已迁移为固定 commit 的 git
  submodule（`ensure-harness-vendor.mjs` 硬校验 submodule HEAD == `harness.commit`
  并断言链接集合 == 锁文件 vendor importer 集合；升级唯一入口
  `scripts/dev/update-vendor.mjs <tag>`）。**剩余验收**：Windows runner 上
  submodule 物化 + junction 建链（`build-windows` 腿）、CI 真跑（push 后 ci.yml
  全绿）、release.yml 改动后的 `workflow_dispatch` dry_run 全链验证
  （release-checklist §7b 纪律）。
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
- **桌面端更新（设计 11）**：feed 隔离与 beta 版本自锁已实现（stable 仅
  `latest*.yml`，beta 仅 `beta*.yml`；仅 canonical `X.Y.Z-beta.N` 自锁 beta，
  `alpha`/`rc`/其他 prerelease fail closed；发现失败不调用 updater 或回退 stable）。
  剩余：用真实 Apple 凭据跑通一次发布 CI、Developer ID 签名/公证/stapling/
  Gatekeeper 验证，以及双平台检查、确认前不下载、下载后退出安装。正式 macOS
  发布缺凭据会在 Release mutation 前阻断；凭据或签名/公证无效会阻断 draft 公开
  finalize。只有 `dry_run` 允许 ad-hoc mac 构建（无条件清空签名/公证环境与
  `GH_TOKEN`，不创建/修改 Release、不上传产物）。
- **会话创建/fork 侧边栏收敛延迟修复**：剩余本地 + 远程 SSH 实例实机验收
  （行出现延迟、状态图标延迟、位置跳动三类症状）。
- **移动端 Web 访问面（design 17 §18，2026-09 提出 / 2026-12 随编排面剥离修订）**：
  **P1 实现已落地（2026-12）**：`packages/dsh-chamber-client-ui-mobile`（移动适配
  插件本体——触屏档抽屉化布局/44px 触控/safe-area/设置全屏/弹层限宽/输入行单行、
  回车换行与 editability 恢复行为层、layoutFacts 双源驱动的抽屉滚动锁（gateway 官方 ui-layout 回退属性观察，§18.4 项 3 部署例外）、shell.overlay
  汉堡+backdrop；零代码复制、按 v0.1.2-alpha.3 基线重写；typecheck/29 测试/
  构建全绿）+ `dsh-chamber-client-ui-layout` fork 订阅面（`ctx.layoutFacts`：
  getLayoutSnapshot/subscribeLayout，回归全绿）+ gateway 接线（build.mjs
  host-packages 拷贝、seedFiles 含 lib/client.js、UA 分流开关默认关闭——
  `--mobile-ua-redirect`/`--mobile-entry`，13 个 UA 用例 + 4 个 config 用例全绿，
  test:gateway 全绿（fail 0，含 13 UA + 4 config + build 产物断言））
  **P1.5 已完成（2026-12）**：IME 恢复完整五层（程序化 focus 丢弃循环/
  editability 翻转/pointerup 手势 refocus/visualViewport 键盘判定/键盘钉住）、
  composer 30s busy 自愈、共享 layout source（滚动锁/Esc 单实例）、
  职责区分显式化（§18.2 管理面 vs 适配面矩阵——认证/凭据/会话边界/UA 分流/
  登录流转为 gateway 独占，插件零认证引用已 grep 验证）。
  **剩余**：实机门禁（§18.6：真机抽检——触控目标比例/抽屉开合/弹层不出屏/
  键盘遮挡/安全区）；P2（PWA 安装 + SW 壳离线，per-instance scope，尊重官方
  "不完整离线"立场）；**0.1.2-alpha.4 DOM 锚点重审计**（布局壳部分已执行：
   双 pin（a3=dd6322d6 / a4=4e84901e）的 ui-layout **AppFrame 组件源码逐字节一致**
   （组件级 git diff 空；ui-layout 包内另有 AppFrame.module.css 纯视觉边框微调，不影响锚点）；审计发现 **details 打标缺口**——官方 details 列壳自首帧常驻、其
  `[data-slot=details]` 出口按会话门控后挂，观察器原谓词漏"出口挂入常驻列壳"
  （frame 孙级挂载）→ **已修（2026-09）**：(a) 谓词补孙级分支（markup.ts
  `isStructuralTarget`）+ (b) frame 属性观察双保险（`data-sidebar-collapsed`/
  `data-details-collapsed` 变更→重打标，独立通路；**其接线仅实机可验**——单测无 DOM 观察器基建，只覆盖纯函数谓词/批决策）；谓词/批决策纯函数化，
  markup.test.ts 补 boot 空壳 + 晚挂载回归用例；代码注释与 README 出处已刷新为
  a4。缺口定性：潜伏（官方当前无可达的 details 打开路径——`panels.details`
  默认 0、`openDetails` 注入面为死代码、官方 ui-layout spec 仅证 details 为 session scope 且无 UI 消费方；
  手机 <996px 让步链上开不了；恒关时打标/不打标视觉等价），非 a4 回归（自插件
  首提交即携带）。**剩余**：`[class$=_…]` 后缀选择器命名契约的测试固定、
  composer 锚点 fixture 化、Android 键盘盲区真机门禁（`interactive-widget=
  resizes-content` 下 visualViewport 键盘判定恒 false——IME 层 1 可能关掉发送后
  刚开着的键盘，iOS 不受影响，§18.6 项））；P3（公网认证流转正式化、Web Push）。先行形态 =
  内网/可信网络（`--no-auth` 显式可信网络或 tailscale）。契约：§3 装配矩阵 +
  §10 项 2 的移动例外——`dsh-chamber-client-ui-mobile` 是唯一随 gateway
  发行物打包 seed 的 chamber 客户端插件（链路无桌面，不参与 `/chamber/plugins`
  桌面同步）。
- **认证服务端 Gateway（设计 17）**：自动化与打包面已完成，剩余发布前实机门禁：
  - 生产 TLS 反代的 Host/Origin/XFF/Secure-cookie、HTTP/WS 一致策略与 SPKI pin
    正/负例；真实 dsh 的 `/api/remote.mux` 断线恢复和插件 bundle；
  - 打包 Desktop 的三种代表形态（HTTPS+凭据、HTTP+凭据、显式可信网络
    `--no-auth`），重启后 safeStorage 解密/密码重登、凭据变更撤销 live stream、
    N-ctx 与完整 gateway runtime 管理面；
  - `/chamber/runtime` 在生产 TLS 下的 SSE/poll/auth，以及真实版本安装→探针→
    故障回退→DSH_HOME 恢复；
  - Linux 真实 system/user service 与 foreground 安装升级：目标版本/新 boot identity
    健康证明、restart 失败回滚、local/global artifact 回退及凭据/env anchor 保留；
  - `--bind 0.0.0.0` 带凭据/显式 `--no-auth`、SSH 隧道回环、tailscale 等可信
    网络形态的全链路及 401/421/403 负例。
  - **运行时凭据管理（design 17 §7.4）**：自动化面已完成（v2 凭据信封、
    `/auth/change-password` `/auth/change-token` `/auth/credentials`、stateDir
    独占锁、`gateway auth` 停机态 CLI、`/chamber/` 凭据面板与 S25 不变量，2026-09
    全量修复轮已完成）。**剩余**：desktop settings-bridge 便捷重置（Phase 4
    推迟项）、真实 TLS 反代下改密/轮换/停机态 CLI 恢复的实机门禁。
  - **http 连接链路修复（S0/S2，2026-09，本地单测全绿，待实机部署验证）**：
    - S0：gateway 代理出口对托管 dsh 的 HTML 注入 `__DSH_TRANSPORT__.ownsHost`
      （上游文档化钩子契约），解除官方设置页在非 loopback 页面上的
      memory 持久化门控（"settings are unavailable in this browser"）——网页直连
      settings/models/插件可用；**取代 design 17 §10.5「gateway 不绕过」旧表述**，
      文档待同步；属"能登录即受信"的信任边界决策（auth 门在先，非鉴权绕过）。
    - S2：control-plane 对**非 loopback 上游腿**（direct-http(s)，含 gateway 与
      dsh 两种 kind；判别轴为解析后目标的 host 而非来源 id——ssh 隧道恒为
      loopback 本地腿）启用 OS 级 TCP keepalive（30s，对齐 ssh
      `ServerAliveInterval` 语义）；renderer staleness 看门狗对
      **transport=http 来源**（registry spec 判别）的静默 mounted 推送触发轻量
      `connection.reconnect()` 自愈（staleness 120s / 退避 60s；mounted=本代曾
      推送；不作用于 local/ssh 隧道来源）。稳态代价如实记录：健康空闲
      direct-http 来源约每 2 分钟一次轻量连接重连（依赖撤稿→重发链刷新
      新鲜度；链不浮现则退化为退避门 ~60s），真死 channel 自 stale 后每
      ~60s 重试一次——均为治愈冻结局的固有取舍（App 层无法区分冻结与
      空闲；活跃来源不受影响）。
    - S2-c：调宽 dsh 2s/2miss mux 心跳为可选增强，**未实现**。可行性已确认：
      补丁层格式本就支持 id-targeted config override（既有
      cordis.patch.yml 机制，desktop plugin-sync 保留用户行；形如
      `{id: typert-gateway, config: {websocketHeartbeatIntervalMs}}`，
      匹配不到 warn+skip）——但 chamber 代码零引用 typert-gateway id，
      需先扩展 gateway 的 patch 写入器，故单列。
    - **剩余验收**：打包态实机——浏览器直连 gateway 的 Models/插件设置可写；
      杀托管 dsh / 断网注入后 sidebar 60–120s 自动恢复；升级 dsh 版本复验
      （`__DSH_TRANSPORT__` 钩子与 typert-gateway id 跨版本存在性）。

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
  改 design 02 为"并发 plane 必须不同 stateDir"。普通 pidfile/mkdir stale lock 存在
  三方 takeover 双持，不能作为修复。
- **响应头白名单双处同步**：权威在 04 §4.3，仍建议把代码/文档表述进一步
  单源化。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状继续以 vendor
  `parseBootManifest` 为准维护。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **`--no-auth` 是醒目的可信网络有界例外**：Gateway 外部部署默认必须认证；
  只有服务器显式传 `--no-auth` 才可覆盖，启动器二次确认并打印安全告警。它不是
  静默 fallback，也不授权普通匿名 control-plane 绑定公网。
- **Gateway state 根目录自动收紧（2026-09 用户决策）**：`createGatewayStore`
  对既有 `stateDir` 由 fail-closed `require 0700`（启动崩溃循环）改为经 pinned
  no-follow 描述符自动收紧到 `0700`，并新增属主 uid 校验（异主 fail-closed）；
  broad root 拒绝与 Windows 继承 ACL 让步不变（17 §12 目录边界、§17 S15）。安装器同步以
  0700 创建 `~/.dsh-chamber` 全部自有目录。
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
- **推迟**：flat 单列表模式（与"仅按来源分类"呈现原则有张力）。
- **设置壳偏差**：未连接实例不装配子 ctx；stub remote 无 WS 失效流；壳不渲染
  官方 SettingsRoot、子 ctx 懒装配；服务器选择器使用 body portal + viewport
  翻转/钳位与内部滚动；离线远端仍可选并显示不可达占位与连接管理动作；chrome
  跟随宿主 locale，子 ctx 跟随目标实例 locale。
- **默认排序 `manual`（06 §3.1）**：按 wire 顺序，与官方默认 `updated` 不同，
  是有意产品取舍。
- **窗口标题冻结**：桌面原生标题固定为 `dsh-chamber`，会话名只在应用内呈现。
- **Electron 二进制惰性安装（每机器共享 dist）**：根 postinstall 默认跳过，仅
  `DSH_CHAMBER_ELECTRON=1` 或 `dev:desktop` 首启按需物化到平台缓存共享 dist
  （macOS `~/Library/Caches/dsh-chamber/electron/v<版本>-<平台>-<架构>/` 等，逻辑见
  `packages/desktop/scripts/electron-shared.mjs`）；worktree 并行开发共用同一份，
  不再每个 worktree 下载/解压 ~300MB。Gateway/control-plane/CLI 不携带 Electron。
- **dev 实例隔离**：dev 使用独立 `packages/desktop/.dev-user-data`；控制面端口从
  17520 起自动退避到首个空闲端口（`DSH_CHAMBER_CP_PORT` 可固定覆盖，退避区间
  全占时回退系统临时端口），多个 dev worktree 可与打包版的 userData/17500 共存。

- **dsh 运行时设置面统一（2026-12 实施，登记契约变更与残余偏差）**：两分支同构
  UI——彩色状态徽标（正常/检查中/下载中/安装中/待应用/应用中/回退中/重启中/切换失败/
  快照失败/恢复受阻/启动受阻/操作失败/错误/元数据异常，四色）取代「已是最新/可用更新」
  claim 文案；快照+磁盘占用并入「当前状态」组；registry 只读行+编辑态统一；常驻
  「清理已安装版本」入口；gateway「部署锚」口径。desktop env/只读平台放行「重启 dsh」
  （design 18 §3.6 落地）。gateway 新增 `cleanup-version` / `restore-pre-rollback` /
  `recover-metadata` 路由、FATAL blocked-alive（不再进程级拒启，status 可轮询 +
  救援路由）、status 的 metadata 健康投影（metadataHealth/metadataComponents/
  canRecoverMetadata）、store-prune 标记消费（消除 10GiB 软上限死锁）。
  残余登记（有意保留）：desktop SETTINGS_SET 在 env 下允许更换 registry（设计文字
  禁，代码行为有意更宽）；restore-builtin × restore-half 逃生集 desktop 更保守
  （先 retry-restore）而 gateway 沿用设计允许集；registry 白名单形状 desktop
  https-only、gateway 允许 http-loopback（共享 canonical 更宽，桌面层收紧）；
  desktop 15s+6h 周期检查不移植 gateway（避免周期出网；进页拉取 + 手动检查）；
  gateway 组件级交互仍以纯函数/API 客户端测试代证（原实机门禁项维持）。

- **2026-12 review 轮次修复与登记（设计 18 §9.3 配套）**：① FATAL 启动块下所有普通
  mutation 拒绝（路由 recovery-gate 增 startupBlockedReason 门，仅放行各自恢复面）；
  ② FATAL×stale-pending 相位投影为 idle+startupBlockedReason（恢复面不被 pending
  门锁死，canRecoverMetadata 与路由可达一致）；③ boot 前 `metadataRecoveryPending()`
  预检——引擎归档元数据后 gateway 重启不再绕过探针门直接以内建服务 DSH_HOME；
  ④ recover 成功后 resume-start 失败转入 `metadata-start-failed` 哨兵（可重试）；
  ⑤ store-prune 标记在 boot 边界消费（desktop 同款语义）；⑥ 徽标/registry 编辑复位/
  versions 内嵌 error/恢复行 window.confirm/blocked 原因行等 review 项已修。
  登记（有意保留）：desktop main.ts 的 RUNTIME_RESTART 等 handler 内联无单测
  （renderer 镜像 + lockstep 代证；抽取纯函数排期）；env×FATAL（dormant corrupt
  selection）gateway 死锁需清 env（共享 `shouldProbeEnvWithDormantCorruptSelection`
  通路未移植，登记）；`status()` 每次轮询跑 metadata health 检测无缓存（小文件读，
  TTL 排期）；metadata 恢复期 pnpm prune 子进程不可 abort（退出延迟登记）。
