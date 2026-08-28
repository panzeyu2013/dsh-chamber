# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项与范围契约。已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/`（设计契约与样式定稿）为权威，不再在此
> 复述实现过程与验证日志。本文档是 dsh-chamber 进度追踪的唯一记录。

## 性能/卫生延后项（2026-11 批次评审，未排期）

- **P0 渲染进程内存定位**：CDP 堆快照 + DOM 节点统计，对比 JS 堆 vs DOM 占比，
  需打包版运行时实测。
- **P3 长会话虚拟化**：`dsh-client-ui-conversation` ChatView 全量渲染
  （todo/10 §6.1 已记录）；拷贝上游 + `@tanstack/react-virtual`（renderer 已有
  依赖）与 todo/10「保持上游纯净」立场冲突，需先改立场再立项。
- **P4 shiki 语言包产物核对**：构建已按需分包（BOOT_GRAMMAR_FILES 仅
  ts/shellscript/json），仅需对构建产物核实 langs 按需加载，无代码改动。
- **P6 控制面移入 utilityProcess**：中期重构（transport 注册面跨进程、spawn 孙
  进程清理链、test:desktop 全回归）。

> 2026-11 批次已实施项（A 类 10 项 + 3 项防御性 + P1/P2/P5 + 顺带项）以 git 历史
> 与设计文档修订（02 §3.5 探活缺省 30s、05 §4 预热视图闲置回收例外条款）为权威
> 记录，本文件不保留批次日志。

### 2026 重构批次新增延后项（同一评审报告 P0–P4，未排期）

- **SidebarRoot.tsx 拆分**：`packages/dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx`
  2891 行（拖拽状态/事件/marker 渲染/多来源统一列表同文件），渲染路径行为
  不变重构，需单独批次。
- **App.tsx 后续深化**：回收/驱逐决策已抽为 `recycle-policy.ts`、shell 模块级
  单例已封装为 `ShellRegistry`（A5-renderer）；App.tsx（约 1500 行）UI 渲染与
  视图切换逻辑的进一步拆分延后。
- **paths 映射远期方案**：反代路径映射（instance-proxy 硬编码 `ssh-<id>` 段）
  与 renderer 侧 base-path 构造（dsh-client-connection base-path 补丁）对新
  kind 需同步扩展（05 §7.6 存量耦合点）；统一路径映射单源化的远期方案未排期。

## 2026 架构重构批次（A1–A6 / B1–B10，重构 + 卫生项 + 合并前修复）

> 本批次为评审报告 P0–P4 的落地执行（按阶段化编排：
> 常量导出基线 → 并行包重构 → 跨包共享协议 → 文档同步）。全部为行为不变
> 重构或纯卫生项——wire 形状 / IPC 通道名 / 消息形状逐字节不变；最初有意的
> 行为变更是 control-plane standalone 与 cli serve 默认端口统一为 17500
> （B1-eng）。合并前多轮安全审查另修复了一组可观察正确性/安全问题（见下列
> “merge review”项，均不新增 wire/IPC 面）。B9/B10 为收尾批次（打包态验证 + 文档同步，对应本文档与设计
> 文档修订；其遗留验证项见下「遗留」）。与本文件「已实现基线不保留批次
> 日志」的惯例不同，本节按编排要求留档本次完成项；代码位置为权威，简述只
> 指方向。

已完成：
- **A1 桌面主进程拆分**（packages/desktop）：`main.ts`（约 1840 → 约 800 行）
  收敛为窗口生命周期 + 退出清理 + wiring 装配的薄引导；IPC 面按领域拆为
  `ipc-ssh.ts` / `ipc-plugin-sync.ts` / `ipc-settings.ts` / `ipc-notifications.ts` /
  `ipc-update.ts` / `ipc-open-in.ts` / `ipc-deep-link.ts`（各导出 `register*(ctx)`）；
  drain 队列 / close-to-tray 门控 / 退出状态机的纯决策抽为 `wiring.ts`
  （`enqueueBounded` / `shouldDrainNotificationOpen` / `isLocalProcessRunning` /
  `isUpdateDownloadReady`，`wiring.test.ts` 覆盖）；trustedIpc 围栏抽为
  `renderer-trust.ts`（`createTrustedIpc`，sender 校验语义不变）。通道名与契约
  不变。
- **A2 跨包协议单源化**：control-plane 新增 `src/rpc-envelope.ts`（unary
  client-request 信封 + server-response 解析校验，吸收 dsh-client.ts 与
  ssh-provider 三处实现）与 `src/cordis-inserts.ts`（insert 渲染/解析/冲突判定，
  吸收 host-graph-seed.ts 与 plugin-sync.ts 两处实现），均从 `src/index.ts`
  导出；desktop 新建 `control-plane-module.ts` 双路径 facade（打包态 →
  `dist/control-plane/` 编译产物，dev/测试 → workspace 源码），main.ts /
  ssh-provider.ts / plugin-sync.ts 统一经它取用；`cross-package-contract.test.ts`
  断言桌面消费输出与控制面输出对同一输入**逐字节一致**。合并审查修正 facade
  的顶层 Electron import（纯 Node 单测不再依赖 Electron 二进制）：打包态以
  `process.versions.electron + process.defaultApp` 判定，并在动态 import 前检查
  编译产物存在，四分支纯函数测试覆盖。
- **A3 control-plane dsh-client 死代码删除**：`src/dsh-client.ts` 删 v2 会话
  运行时遗留（respond / openEventStream / pendingEnvelope 观察 /
  PendingCapExceededError），收敛为仅 unary `call` + `describeCapabilities`；
  test/protocol.ts 与 test/m1-dsh-client.ts 同步裁剪。
- **A4 PluginGraphDiagnostic 类型收敛**：三份定义（sidebar aggregate-store /
  renderer host-graph / renderer vendor-modules.d.ts）收敛为 sidebar
  `src/shared/aggregate-store.ts` 单一来源，renderer `src/host-graph.ts` 从
  `@dsh-chamber/dsh-client-ui-sidebar/shared` 导入（re-export 保留给既有消费方）。
- **A5 静态服务拆分 + renderer 编排层重构**：control-plane `index.ts` 内嵌静态
  服务拆为 `src/static-serving.ts`（`createStaticServing`，响应行为逐字节一致，
  CSP/安全头仍由 index.ts 装配）；renderer `src/recycle-policy.ts` 纯函数
  （App.tsx 回收/驱逐决策提出，可测）+ `src/shell.ts` 模块级单例封装为
  `ShellRegistry` 类（cancelledBoots / pendingDisposes / 排队语义；
  BUNDLE_LOAD_TIMEOUT_MS 声明顺序修正）。合并审查补齐超时边界：每 entry 的
  `{instanceId, basePath, generation}` 固化在自身 Cordis root context（不再使用 window/模块
  级可变旋钮），dispose 作为取消信号阻止迟到 mount；重复 dispose 按 entry
  去重且共享真实 teardown Promise，同 ID 重试不会越过未完成释放；shell 在
  boot 开始/取消时预留 producer generation floor，sidebar runtime-facts 与
  snapshot producer 同时校验显式 generation + token，旧代迟到注册/report/clear
  都不能抢占或清除新代状态。对应超时/迟到 settle/延迟 teardown/代际上报均有
  回归测试。
- **A6 settings-bridge 幽灵依赖修复**：settings-connections package.json exports
  增加稳定子路径 `"./section"`（→ src/client/ConnectionsSection.tsx），
  settings-bridge 声明对该包的 workspace 依赖，SettingsShell.tsx 改 import
  子路径；两包独立 typecheck（typecheck:settings-bridge / typecheck:connections）
  均通过。
- **B1 死导出 / 端口常量**：control-plane `catalog.ts` 删仅测试消费的
  save / listConnections / removeConnection / mutate / getSnapshot /
  snapshotHealth（test/storage.ts 同步裁剪，If-Match/409 头部承诺同步修正）；
  cli 与 control-plane standalone 端口统一引用 `DEFAULT_CONTROL_PLANE_PORT`
  （17500；standalone 旧 3001 默认**有意改为 17500**，与 cli serve 对齐）；
  renderer / settings-connections 的 DEFAULT_CONTROL_PLANE_URL 随 B2 收敛。
- **B2 REST 客户端共享化**：renderer `src/api.ts` 与 settings-connections
  `src/client/control-plane.ts` 两份同源控制面 REST 客户端收敛为 sidebar
  `src/shared/control-plane-client.ts`（ApiError / ApiErrorBody / controlPlaneUrl /
  request + health/connections 方法面；浏览器纯实现）；renderer api.ts 改薄
  封装（App.tsx import 面不变）。
- **B4 清单 glob 化**：根 tsconfig.json desktop 逐文件白名单改目录 glob
  （`packages/desktop/*.ts`、`packages/desktop/*.cts`——此前 4 个测试文件漏检）；
  desktop electron-builder build.files 改 glob（`"*.ts"` / `"*.cts"` + 显式
  `!*.test.ts` 排除）。
- **B5 测试入口收敛**：根 package.json 新增 `test:control-plane`
  （scripts/test-control-plane.mjs，按 AGENTS.md Validation 权威清单，纳入
  rpc-envelope.ts / cordis-inserts.ts / reaper.ts）；ci.yml / release.yml 两处
  control-plane 测试清单改走该脚本；test:desktop 纳入
  cross-package-contract.test.ts 与 wiring.test.ts；m1-dsh-client.ts 头注释幽灵
  smoke.mjs 引用修正。
- **B6 reaper 测试**：`packages/control-plane/test/reaper.ts` 新增——身份不匹配
  保留 / 端口归属失败保留 / owner 存活保留 / 孤儿回收 / killAndConfirm
  （SIGTERM→SIGKILL）序列；ps/lsof/ss 依赖经 `ReaperDeps` 注入（DI seam，
  默认行为不变）。
- **B7 砍 direct-endpoint 投机面**：transport-provider.ts 删 direct-endpoint 模式
  （buildStartArgs 缺省 direct 分支、probeTarget / endpointUrl、开放 kind 联合
  收窄为 `['ssh']` 闭集、Ssh* 兼容别名）；transport-manager.ts 直连运行时分支
  删除；**verifyUp 保留**（ssh `host.describe` 探测有真实消费）；
  transport-manager.test.ts 同步删 direct-endpoint 用例。
- **B8 IPC 通道常量单源**：packages/desktop/ipc-events.ts 导出 `IPC_CHANNELS`
  常量（主进程全部 handle/send 通道）；preload.cts 受单文件自包含构建约束
  （build-preload.mjs）不 import 常量模块——重复字面量由 ipc-surface-mirror.test.ts
  字符串级守卫（主侧 handle/send 集合 == 预加载侧 invoke/on 集合、主侧无裸
  字面量、预加载字面量均为 IPC_CHANNELS 已知值）。
- **合并前安全审查修复（2026-08-28，已完成）**：release/CI action pin 与
  validation-before-release-mutation、dry-run 零 Release 写入及 tag/手动同版本
  concurrency 归一；reaper 精确绝对入口 + profile/port token +
  端口归属 + owner 死亡四重证据；本地 spawn 端口探测/就绪/describe/browse 全链
  取消与 start→stop→start 代次隔离；host-logs 失败切新代与 stopped 单行；实例
  反代注册 HTTP-only；transport registry whole-set 原子拒绝及密码/元数据补偿；
  SSH 捕获 stdout/stderr/未终止行的增量内存上界与 fail-closed 脱敏；本地插件
  pack 禁生命周期脚本并纳入 will-quit 进程组/树回收；renderer shell 打开轮询、
  聚合重试 timer、roster latest-wins 与 registry source-generation ABA 门、恢复
  timer 与 quit 代次隔离；fork parent-accounted 3s 有界
  first-observation 宽限及来源删除回收；Git visible 恢复立即刷新；深链队列、
  本地 Windows path、协议注册、open-external/本地路径错误投影与设置副作用回滚；
  连接表单 `remoteDshHome`/长度门禁与 desktop 权威对齐。关键路径均有复现原问题
  的回归用例；完整 Linux 验证矩阵在本次合并前重跑，macOS Developer ID/公证与
  Windows NSIS/实机仍由 release CI/对应平台验收。

遗留（本次文档核对发现，未修）：
- **设计未决项解决情况**：响应头白名单双处同步（03 §3.4 / 04 §4.3）本次未动，
  保留原条目（见「设计未决」）。
- **desktop 打包态跨平台验收（部分完成）**：Linux x64 已完成真实
  electron-builder unpacked 打包、asar 内容抽查（运行模块/`preload.cjs`/
  `dist/control-plane` 齐全，测试/`.vite`/workspace control-plane 源码未误收）与
  Xvfb 启动冒烟（控制面监听、本地 bundled dsh ready、退出后无残留进程/端口）；
  因当前环境非 macOS/Windows，`dist:desktop:mac`、签名/公证、NSIS 与两平台
  实机启动仍由 release CI/对应实机验收。
- **plugin-sync computeCordisPatchUpdate 的 fold 语义未单源化**：cordis
  loader insert 的**渲染/解析/冲突**已单源至 control-plane `cordis-inserts.ts`
  （A2），但 desktop `plugin-sync.ts` 的 `computeCordisPatchUpdate`（远端
  cordis.patch.yml 合并的确定性改写/fold 语义，见该文件头注释）仍为本地
  实现——与 host-graph-seed 侧的同名合并逻辑未统一，留待后续单源化。
## 未完成 / 待执行

- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游
  wire 根治）；实现未排期。设计见 `docs/todo/12-todo-archived-sessions.md`。
- **模型额外参数 + 默认推理等级（设计 07）**：实现推迟——wire 白名单无泛化
  透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，待上游
  解锁（07 §3/§4）。设计见 `docs/design/07-models-params.md`。
- **SSH 密码认证可选增强（05 §8 例外主体已落地）**：未做（可选）——一键
  免密引导、系统钥匙串。
- **Windows 首版支持暂缓**：detached/进程组/lsof 降级路径；Unix 为契约
  目标。

## 部分完成（剩余验收 / 剩余实现）

- **桌面通知（设计 19，已实现）**：剩余 macOS 系统通知权限实机验收（M3，
  打包态冒烟）。契约见 `docs/design/19-notifications.md`。
- **VS Code 深链 + open-in 打开注册表（设计 16/17，M0–M3 已实现）**：
  剩余实机验收——macOS 深链冷/热启动、打包态、托盘/退出在途、N-ctx、
  VS Code 缺失、sshPort≠22、dev 深链 argv 注入测试路径、Finder 下拉在
  vendor 头部的定位/层叠、远程来源仅 vscode。契约见
  `docs/design/16-vscode-deeplink.md` / `docs/design/17-open-in-registry.md`。
  （2026-09 打磨：下拉行改为 图标 + 短应用名，OpenChamber OpenInAppButton
  样式；Finder 使用系统 Finder 图标（darwin，finder-icon.png），非 darwin
  保留中性文件夹标记；按钮组 hover 一体化 + 图标圆角微调；主按钮
  tooltip/aria-label 长句文案不变，无契约变化。）
- **Git Worktree 插件（设计 08，v1 已落地）**：M4 尚余真实远程 Linux +
  Git 仓库的端到端验收（含首次 ready-time seed 后重启生效、Git LFS/filter
  提示边界）。契约见 `docs/design/08-git-worktree-plugin.md`。
- **远程实例插件管理（设计 13，M1–M4 已落地）**：剩余——本地 `dsh plugin`/
  `pnpm pack` 依赖本机 pnpm（`resolvePnpmBinDir` 扫描 PATH + nvm/volta/
  homebrew，打包态 best-effort）。契约见 `docs/design/13-remote-plugin-management.md`。
- **桌面端更新（设计 11，已实现）**：剩余——配置真实签名秘密后的 release
  CI 上传/公证/验签实测，双平台实机检查/下载/退出安装；mac 安装腿未配置
  Developer ID 时 settings 响亮提示手动安装。契约见 `docs/design/11-auto-update.md`。
- **会话创建/fork 侧边栏收敛延迟修复（2026-10，已实现）**：变更拉取改独立
  mutation 域（推送不作废；失败路径保留共享序号守卫）；创建/fork 会话的
  「未分类」瞬时摆放由显式成员宽限 + parent-accounted first-observation 有界
  宽限抑制，fork attach 部分失败到期后仍会显式落未分组（05 §2.3 /
  06 §2.2）。剩余：本地 + 远程 SSH 实例实机验收（行出现延迟、状态图标
  延迟、位置跳动三类症状的改善确认）。

## 设计未决（02 §5 / 04 §7）

- **起始端口偏移**：本地默认起始端口（17510）与控制面端口（17500）相邻；
  是否可配 / 每实例偏移未定——当前以"固定起始端口 + P+1 重试 + 记录仲裁"
  落地（02 §5.2）。
- **trusted-host 自定义 Host**：`--trusted-host 127.0.0.1:<port>` 对应反代
  转发 Host 头（保持实例自身 host:port，不改写）；若引入自定义 Host 场景需
  同步扩展 trusted-host 集（05 §7.5 固定形态）。
- **多控制面 `$DSH_HOME` 冲突**：宿主 `DSH_HOME` 固定 `<stateDir>/dsh-home`，
  多控制面共享 stateDir 才共享 home——会话 JSONL 追加式多写安全，settings
  last-writer-wins 由 dsh `settings-conflict` 仲裁；不同 stateDir 互不相干
  （02 §5.6）。
- **响应头白名单双处同步**：上游引入新必需响应头需同步 03 §3.4 与 04 §4.3
  （一处契约两处表述）——建议单源化（04 §7.1）。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状随 dsh `parseBootManifest`
  契约（vendor 源码为准）维护；构建链变更见 05 §6（04 §7.2）。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **移出项**（P3 硬纪律，永不回流）：认证/审计（密码/Passkey/会话 cookie/
  client token/限流/审计 SQLite）、控制面薄壳聊天/会话列表/审批弹窗、控制面
  会话运行时/统一索引/交互管线、连接注入适配器/broker/绑定、walkthrough、
  通知中心、cron、文件夹/笔记、web 预览、MCP、目标/终端等宿主 UI 职责面
  （处置映射见 01 §4；git/GitHub 例外：插件化，见 01 §4 / 设计 08）。
- **不做（v1）**：跨来源移动会话、单 store 真融合（fork runtime）、会话
  实时推送同步、远程实例管理 UI 外壳。
- **P0 信任域残余（09 §4，已缓解，架构版解决）**：远端 bundle 与 chamber 页面
  共享高权限 bridge 的上下文。2026-11 已落地 v1 缓解——materialize/本地插件
  add/remove 与远端 `plugin_apply`（registry add/remove，2026 final review）
  主进程确认对话框 + `local_plugin_list` 路径脱敏；bridge 全局面与
  横向实例数据面隔离推迟到每实例独立 WebContents 架构版（本阶段明确不做）。
- **推迟**：flat 单列表模式（与「仅按来源分类」呈现原则张力）。
- **设置壳偏差（持续成立）**：未连接实例不装配子 ctx（配置在目标机器上，
  物理不可达）；stub remote 无 WS 失效流；设置壳不渲染官方 SettingsRoot；
  子 ctx 懒装配；服务器选择器使用 body portal + viewport 翻转/钳位（含窄
  视口缩放）+ 名称/实例 ID 搜索，超长 roster 内部纵向滚动；在线/离线状态
  同时使用文字与色点，搜索输入位于 listbox 外；离线远端仍可选并显示明确
  不可达占位与「前往连接管理」动作；chrome 跟随宿主 locale、子 ctx 跟随
  目标实例 locale。
- **默认排序 manual（06 §3.1）**：每来源会话排序默认 `manual`（保持 wire
  序），与官方默认 `updated` 不同——有意取舍；`orderBy[sourceId]` 持久化于
  `dsh-chamber.sidebar.v1`。
- **窗口标题冻结（桌面壳故意偏差）**：桌面壳冻结原生标题栏为 `dsh-chamber`
  （单 frame 品牌恒定），会话名仍在应用内呈现。
- **dev 实例隔离（dev 契约）**：`electron-dev.mjs` 以独立 `--user-data-dir`
  （`packages/desktop/.dev-user-data`）+ dev 控制面端口 17520
  （`DSH_CHAMBER_CP_PORT` 覆盖）启动，并清除继承的 `ELECTRON_RUN_AS_NODE`——
  dev 与运行中的打包版实例（同一应用名 → 同 userData/单实例锁、占 17500）
  可共存；打包版默认端口/数据路径不变。
