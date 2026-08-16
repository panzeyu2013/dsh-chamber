# 模块完成状态总览（STATUS）

> 本文档只追踪**进度状态**：未完成项与范围契约。已实现基线以 git 历史与
> `docs/design/`（设计契约与样式定稿）为准，工程细节在代码注释——不记录
> 历史日志/每日验证记录。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

- **SSH 密码认证（05 §8 例外，2026-08 落地）**：表单密码字段 +
  `desktop_ssh_set_password` → `SSH_ASKPASS_REQUIRE=force` + 临时
  0600 askpass 助手注入系统 ssh（隧道与 systemd exec 均覆盖；助手按提示文本
  区分主机密钥确认/密码）。**持久化 = 明文文件兜底（用户决策）**：密码镜像到
  `<userData>/ssh-passwords.json`（0600、原子写、启动加载——密码主机重启后
  自动连接可用；损坏保留 `*.corrupt` 响亮报告；不进注册表/日志/renderer）。
  askpass 注入已随隧道链路端到端实机验证（见下「已实机验证」）；
  **仍待实机**：错误密码终态、重启后自动连接；**Windows 门禁**
  （`sshPasswordSupported()` 为 false 时 IPC 显式拒绝，密钥/agent 兜底）需
  实机确认 Win32-OpenSSH 行为（Windows 首版整体暂缓，见下）。已单测覆盖：
  助手脚本转义/主机密钥 yes/0600 权限/清理、buildStartEnv 环境合并与
  disposeAuth、env 异常落地 error、密码文件持久化往返/0600/损坏保留。
  未做（后续可选）：一键免密引导、系统钥匙串。
- **侧边栏 pending 交互徽标（06 §4.3 修订，方案 A）实机验证**：本地实例
  触发 `ask_user_question` → 侧边栏该会话行出现问号徽标（区别于运行环），
  回答后消失；远端来源会话 pending 时本地侧边栏同步呈现。静态检查（sidebar
  typecheck / build:renderer / verify:i18n）已绿，运行时呈现待实机。
- **设置壳交互与 GUI 内手动操作待实机**（背景：esbuild bundle + 真实本地
  host 的运行时验证已覆盖子 ctx 装配的 ledger 事实——general 5 行（含
  bridge-rows 的 composer-enter / permission）、plugins 3 卡、onboarding 2 项、
  dispose 清理、官方控制器可驱动（ModelsSettingsStore/AgentPreset 控制器
  ready））；壳交互（下拉 roving、nav 投影、连接导航、懒装配时序）与 GUI 内
  手动操作待实机（onboarding 2 项是子 ctx 装配事实，壳不渲染 onboarding；
  bridge-rows 两行的读写落盘待实机——单测覆盖控制器状态机，schema 解码为
  数据驱动，实机验证 describe/mutate wire）。
- **Windows 首版支持暂缓**（detached/进程组/lsof 降级路径）——暂无 Windows
  设备，维持「未验证」状态；Unix 为契约目标。
- **模型额外参数 + 默认推理等级**（设计 07）：需求定稿、链路查清、实现
  蓝本已写入 `docs/design/07-models-params.md`；**实现推迟**——wire 白名单
  无泛化透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，
  均待上游解锁（解锁条件与 harness.commit 升级复查清单见 07 §3/§4）。
- **Git Worktree 插件**（设计 08）：范围决策已定稿（2026-08-16，01 §4 的
  git/GitHub 由移出项改写为插件化——不进控制面/本体，允许 chamber 强制打包
  的客户端插件形态），设计稿已写入 `docs/todo/08-todo-git-worktree-plugin.md`
  （2026-08-16 自 docs/design/ 移入 docs/todo/）；
  **实现未排期**（M1–M5 分期见 08 §8）。
- **dsh 客户端插件运行时加载（设计 09）**：设计草案已写入
  `docs/todo/09-todo-client-plugin-runtime-loading.md`（每实例合并宿主 boot
  图：图通道方案 A/B、union+id 去重、信任边界、分期）；**实现未排期**。
  现状（2026-08 核实）：客户端插件（`dsh.client` 行）无法运行时加载——chamber
  前端 `__DSH_BOOT__` 清单构建期写死单 entry（`gen-boot-manifest.mjs`），官方
  机制（`dsh-client-modules` 组合图 + `/plugins/<id>/client.js` + 反代透传）完整
  保留但无人消费；功能型（宿主侧）插件可经 profile `cordis.patch.yml` 正常安装。
- **设计未决**（见 02 §5 / 04 §7）：starting port 偏移、trusted-host
  自定义 Host、restart-exhausted 手动恢复入口、多控制面 `$DSH_HOME` 冲突、
  响应头白名单双处同步、`__DSH_BOOT__` 随 dsh 版本漂移。
- **外部编辑风险**：`packages/desktop/`（transport-manager / ssh-provider /
  ssh-config / main.ts）存在未提交的进行中改动，其间的 typecheck/测试
  结果可能波动（已多次观测 0↔2↔25 错误波动；最近一次 typecheck 0 错误）。

## 已实机验证（2026-08 确认）

- **真实远端实例 SSH 隧道链路端到端验证已完成**：exec 通道、就绪身份握手
  （host.describe 探测）、askpass 注入等已在真实远端实例上实测通过。
- **打包应用实启 GUI 复验已完成**：v1 收敛（认证/审计移除）后的新构建已
  实机启动验证。
- **偶发主进程冻结未再复现，关闭**：曾 4 次（实例未启动且前端重试期），
  其后约 20 次实启未再出现，根因未最终定位——不再留待排查。

## 代码收敛（2026-08-16，评审驱动修复）

以下为 2026-08 仓库评审发现问题的修复（均已含测试或构建验证）：

- **浏览器来源边界**：管理 API/实例 HTTP 在路由前校验 loopback Host 与
  Origin，WS 在 upgrade 转发前复用同一判定（403 `origin_forbidden`）；
  不再把“无 CORS 响应头”误当成 simple POST/WS 防线，并拒绝同源 DNS
  rebinding Host。回归测试覆盖恶意 `text/plain` POST 无副作用、恶意 WS 在
  代理前拒绝与非 loopback Host。
- **Electron IPC sender/导航边界**：全部 `dsh-chamber:info` / `desktop_ssh_*`
  handler 校验当前主窗口 mainFrame + 精确控制面 origin；窗口禁止 popup，
  `will-navigate` / `will-redirect` 禁止跨 origin。纯信任谓词含单测；
  preload 引导期 `dsh-chamber:info` 短重试（≤10×50ms）消化 mainFrame URL
  提交前的时序拒绝，不弱化门禁。
- **catalog 持久化失败传播**：JSON store 改为同步 write-through，写盘失败
  回滚内存并抛 `json_store_persist_failed`（接口注释明确同步 throw 语义）；
  catalog 行读取返回 clone、更新走不可变事务，消除“内存成功/磁盘失败”假
  成功。单测覆盖 store 与同步 catalog 调用的失败回滚。
- **排队会话打开结果闭环**：shell 未 boot 时的 open 保存原 Promise，只有
  runtime dispatch 成功才 resolve；dispatch/boot/dispose/68s 超时均 reject
  （dispatch 同步 throw 也显式 reject，绝不悬挂），不再提前成功后仅
  console 报错。纯队列单测覆盖成功、失败、同步 throw、释放与超时。
- **桌面应用图标**：`packages/desktop/resources/`（icns/ico/icons）接入
  mac/win/linux 打包图标；`resources/icon.png` 经 extraResources 映射进
  `process.resourcesPath/icon.png`，打包态托盘图标落位（原先仅兜底跳过）。

- **反代上游超时（设计 03 §3.3 的 504 落地）**：`instance-proxy.ts` 增加
  `UPSTREAM_TIMEOUT_MS`（10s，可注入）——上游静默（响应头等不到 / 非 SSE
  body 停顿）→ 显式 504 `upstream_timeout` + abort，不再无限挂住请求；
  SSE / WebSocket 升级后的长连接不受限。新增 3 测试（HTTP / 正常流不受扰 /
  upgrade）。
- **host-logs 环形截断（设计 02 §3.8 落地）**：写入侧 `MAX_LOG_LINES`（500）
  超限即压实保留尾部 `COMPACT_KEEP_LINES`（400）并重开写流——长期宿主不再
  积累无界日志文件。新增 1 测试。
- **致命屏时效修复（renderer）**：`App.tsx` 健康错误**持续**超过 10s（或
  首帧从未拉到）才呈现"无法连接控制面"覆盖层——会话中途控制面失联不再被
  陈旧 health 永久掩盖，瞬时抖动/SSE 重连不闪烁。
- **侧边栏搜索超时竞态修复**：30s 调用方超时 abort 后按 job 是否仍持有
  controller 区分「超时」与「被替换/取消」——超时落 `search.unavailable`
  错误态，不再永久停留在转圈（06 §1 fail-loud 语义）。
- **workspace 组头拖拽尾随点击修复**：组头 `dragstart` 同样武装
  `suppressClickRef`（06 §2.2 守卫清单完整化）。
- **boot 队列超时护栏（renderer）**：`shell.ts` 单个 boot 超过 `BOOT_TIMEOUT_MS`
  （60s）不再阻塞后续实例的 boot（链放行，迟到 settle 仍正常注册视图、会话
  保活）；旋钮清理改为按值守卫（迟到 settle 不误删后续 boot 的旋钮）。
- **quit 等待 SIGKILL 升级（desktop）**：`transport-manager.disposeAsync()` 在
  dispose 后等待全部 kill escalation 清空（至多 grace+1s）；`main.ts`
  will-quit 改为先 await——SIGTERM 忽略的 ssh 子进程不再因 2s 宽限内退出而
  遗留。
- **设置页 roster 新鲜度修复**：`ConnectionsSection` 订阅
  `onInstancesChanged` 即时重拉 roster（本页外注册表增删改即刻可见）。
- **release.yml runner 修复（参考 OpenChamber 踩坑）**：非公开标签
  `macos-26`/`macos-15-intel` → 公开 `macos-14`（arm64）/`macos-13`（x64）；
  node `'22'` → `lts/*`（与 ci.yml 一致）。
- **macOS 打包签名修复（ad-hoc，2026-08-16）**：无 Apple 签名身份时
  electron-builder 完全跳过签名（含 afterSign 钩子），产物继承官方 Electron
  二进制的 linker ad-hoc 签名（`codesign --verify` 报 "code has no resources
  but signature indicates they must be present"），下载隔离后 macOS 报
  "已损坏"且任何 Gatekeeper 设置（允许所有来源）无法绕过——校验发生在签名
  验证层，独立于 spctl。修复：新增 afterPack 钩子
  （`packages/desktop/scripts/after-pack-adhoc-sign.mjs`，注册于 desktop
  package.json `build.afterPack`）在 DMG 构建前对 .app 整体
  `codesign --force --deep --sign -` 并 verify（DMG 内即签名产物；未来配置
  真实身份时 electron-builder 签名步骤在其后执行并覆盖 ad-hoc 签名，安全）；
  ci.yml / release.yml 的 macOS 验证步骤新增 `codesign --verify --deep
  --strict` 防回归。已本地端到端验证：钩子产物
  `Identifier=com.dshchamber.desktop`、`_CodeSignature/CodeResources` 存在、
  verify 通过。治本仍为 Developer ID + 公证（secrets 未配置）。
- **macOS v1 仅 arm64（2026-08-16）**：GitHub 退役最后一个公开 Intel
  runner `macos-13` 后，release.yml 的 x64 矩阵腿在 v0.1.0 全部 5 次运行中
  均排队等不到 runner（finalize 因 needs 不满足从未触发，release 为手动
  发布；资产只有 arm64 DMG + Windows exe）。决策：**v1 放弃 macOS x64**，
  release.yml 移除矩阵改为单一 `macos-14` arm64 构建（ci.yml 本就只出
  arm64），Intel Mac 暂不支持（README 中英已注明）。恢复 x64 的路径（未
  排期）：自托管 Intel runner；或 arm64 runner 上 Rosetta 交叉构建
  （bundle:dsh 的 darwin-x64 原生模块需在 Rosetta 下编译，可行性未验证）。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **移出项**（P3 硬纪律，永不回流）：认证/审计（密码/Passkey/会话
  cookie/client token/限流/审计 SQLite）、控制面薄壳聊天/会话列表/审批
  弹窗、控制面会话运行时/统一索引/交互管线、连接注入适配器/broker/
  绑定、walkthrough、notifications、cron、文件夹/笔记、
  web 预览、MCP、目标/终端等宿主 UI 职责面（处置映射见 01 §4；git/GitHub
  例外：插件化，见 01 §4 / 设计 08）。
- **已覆盖（侧边栏不做）**：fork 会话——官方 conversation 回合尾部分支
  动作（ui-conversation turn-tail `forkAt`）在 boot 图内常驻可用，侧边栏
  行内 fork 仅 UI 覆盖缺口。
- **推迟**：flat 单列表模式（与"仅按来源分类"呈现原则张力）。
- **已实现（2026-08 修订）**：当前空白"新会话"行——活动来源的当前空白
  会话按官方 `(!blank || current)` 规则投影为 New Session 行（仅活动来源
  投影，与 06 §4.3 全局单选门控一致；其他来源空白行仍不入导航列表）；
  壳内新建会话（New Session 按钮等 ctx 内入口）与首条消息后 blank→real
  翻转触发该来源聚合即时重拉（插件会话列表结构签名变化 →
  chamberBridge.requestRefresh，不等 10s 轮询）。
- **06 §4.3 修订（2026-08，方案 A）**：待交互（pending）状态不再与运行中
  同形——会话行尾状态槽对 pending 渲染**可辨识图标徽标**（`question` 问号
  / `plan-review` 清单 / `approval` 警示三角；business 蓝 / warn 琥珀两级
  配色），运行中仍为蓝色 ongoing 环；通道与数据源不变（仅渲染分支 +
  样式）。悬停替换（状态槽 ↔ 行操作）语义不变。
- **不做（v1）**：跨来源移动会话、单 store 真融合（fork runtime）、会话
  实时推送同步、远程实例管理 UI 外壳。
- **设置壳偏差**：未连接实例不装配子 ctx（配置在目标机器上，物理
  不可达）；stub remote 无 WS 失效流（外部改动不实时推送到桥接页，刷新
  依赖重进/切换）；设置壳不渲染官方 SettingsRoot（自建壳，onboarding
  步骤与 settings.header/action 席位省略）；子 ctx 懒装配（仅面板打开且
  服务器已连接时，关闭即释放——首次打开有一次短暂加载）；下拉列表为
  in-panel 定位（非 portal），nav 滚动 + 超长 roster 时尾部可能被 nav
  裁剪（已知项，后续可换 portal）；面板 chrome 跟随宿主 boot 的 UI
  locale 而子 ctx 内容跟随目标实例 locale.preference（两服务器语言偏好
  不同时混排——符合"配置事实留在目标主机"哲学，预期行为）。
- **v1 实现形态（代码内声明，与 05 契约无实质偏差）**：自研侧边栏 + 纯
  dsh 首屏即基线；renderer 的 entry 级 React 面仅剩纯 dsh 桥接宿主
  （`App.tsx`：auto-start/auto-connect、chamberBridge publish、
  onOpenSession/onActivateSource/onRefresh/onRuntimeReport）；当前来源
  判定经 knob 注入（`chamber-knob.ts` ↔ `ctx.chamberInstanceId`）；拷贝
  包 `tests/` 未拷贝；`chamber-auth` 随认证移除；settings 页
  `ns.inject('settings.section' …)` 通道可用于后续插件化。
- **窗口标题冻结（桌面壳故意偏差）**：官方前端 `DocumentTitle` 会把当前
  会话名投影进 `document.title`（浏览器标签语义）；桌面壳在
  `packages/desktop/main.ts` 以 `title: 'dsh-chamber'` + 拦截
  `page-title-updated` 冻结原生标题栏（单 frame 品牌恒定），会话名仍在
  应用内呈现——不改前端、不重实现。
