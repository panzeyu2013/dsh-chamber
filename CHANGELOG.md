# Changelog（变更日志）

本文件记录 dsh-chamber 的全部重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

发布产物与各版本的发布说明同时发布在 GitHub Releases 页面
（`https://github.com/panzeyu2013/dsh-chamber/releases`）。

> English: [docs/CHANGELOG.en-US.md](docs/CHANGELOG.en-US.md)

## [Unreleased]

### 新增

- **桌面通知（设计 19）** —— session complete / ask / request 时推送桌面原生
  通知（设置可选项，并入设置壳「通用」页通知控制组；检测复用侧边栏运行时事实
  通道边沿，零控制面改动）。
- **来源级收拢 + server 拖拽排序（06 §2.4 方案 1）** —— 侧边栏来源头折叠
  开关（收拢整来源 workspace 列表）+ 来源头拖拽排序（显示偏好，持久化于
  `dsh-chamber.sidebar.v1`，跨 ctx 实时联动）。
- **workspace 图标按身份着色（06）** —— 图标色相按 `(serverId, 家族种子)`
  哈希派生稳定 accent，worktree 与主检出共享家族色；2026-10 柔和化色板。
- **Open in 打开注册表（设计 17）** —— VS Code 深链插件演进为通用打开面：
  本地来源 Finder + 本地/远程 VS Code 统一按钮（`conversation.session.header.
  utilities` 槽），插件重命名 `@dsh-chamber/dsh-client-ui-open-in`，旧 vscode
  IPC 收敛删除。

### 修复

- **插件动作主进程确认（09 §4 v1 安全缓解）** —— `desktop_ssh_plugin_materialize_add` /
  `desktop_local_plugin_add` / `desktop_local_plugin_remove` 增加主进程确认
  对话框：远端 bundle 与 chamber 页面同上下文，脚本不能静默驱动本地源码外传、
  任意 registry 包安装（持久执行面）或破坏性卸载。取消返回 `{ok:true,
  cancelled:true}`；无窗口 fail-closed；单飞防堆叠；UI 侧三个消费点补齐
  `cancelled` 分支（不再把取消误报为成功）。
- **本地插件清单路径脱敏（09 §4 v1 安全缓解）** —— `desktop_local_plugin_list`
  的依赖值投影不再回显本地绝对路径：file:/link:/相对/绝对/`~/` 值掩码为
  `file:<hidden>`（保持 materialize 分类与名称匹配语义，客户端 diff 不变）。
- **控制面生命周期竞态守卫（2026 audit H2）** —— 健康探针携带代次
  AbortSignal：stop()/start() abort 在途探针并等待其落定；`stopped`/`error`
  态或 start 在途时到达的失败判定一律惰性（不复活连接、不双 spawn）；spawn
  失败落在 stop() 之后（epoch 已变）不再把 `stopped` 改回 `error`。
- **spawn 失败统一清理（2026 audit H3）** —— spawnAttempt 全部失败路径（含
  PID 记录写入失败）统一收敛到 `killFailedSpawn`：进程组 SIGKILL → 确认退出
  → 删除记录（对齐设计 02 §3.3），不再遗留无记录可追踪的 detached 进程。
- **catalog 持久化不再阻断状态机（2026 audit M13）** —— status/dshPort/error
  运行时投影写盘改为 best-effort：磁盘失败 loud log、状态照常迁移、下次迁移
  自愈；用户可编辑字段（label/accentColor）保持严格写穿。
- **反代压缩一致性（2026 audit M3b）** —— 请求侧剥离 `accept-encoding`（上游
  恒 identity），响应头白名单放行 `content-encoding`（压缩标签随行，浏览器
  正确解码）。
- **boot 预算取消 + 串行链（2026 audit H1）** —— 整个 boot 任务（含宿主图
  通道与 `AppWebEntry.run()` 各阶段）受超时预算约束：超时即取消（dispose
  已构造 entry、拒绝排队 opens），调用方与串行链都在预算内 settle，两个
  boot 永不并发覆盖 `__DSH_BASE_PATH__` 旋钮（消除跨实例流量混淆）；
  任务先 settle 时清除计时器，成功 boot 不会被过期计时器误取消。
- **dispose 串行化（2026 audit M1）** —— `AppWebEntry.dispose()` 是异步
  teardown：同 ID 重 boot 必须先 await 旧 teardown 完成（pendingDisposes），
  新旧 ctx 永不重叠、旧 teardown 不再清掉新 shell 的共享状态。
- **exec 子进程退出等待（2026 audit M2）** —— 退出时 exec 子进程（systemd/
  远端命令 ssh）与隧道子进程同款 SIGTERM→SIGKILL 升级，`disposeAsync` 等待
  全部退出，SIGTERM 忽略型 ssh 不再残留孤儿进程。
- **预热队列解卡（2026 audit M8）** —— 删除正在预热的实例时同步清除
  inflight 标记并立即推进队列（此前卸载后 settle 被丢弃、标记永久残留，
  预热队列整体卡死）。
- **端口分配失败自动恢复（2026 audit M10）** —— 隧道本地端口瞬时分配失败
  进入慢速周期重探（与 max-retry 同款），不再永久停在 error 等待人工。
- **插件缺失可见化（2026 audit M6）** —— 宿主启动图通道失败（graph-unreachable/
  not-injected）时 boot 仍成功但 settle 状态携带 `pluginDegraded`，实例视图
  显示警告条（"部分插件未能加载"），不再与完全成功同态。
- **搜索可见集语义修正（2026 audit M7）** —— `mergeSearchResults` 增加
  `projectionReady`（`aggregateReady`）：投影就绪后可见集是权威，空集过滤
  全部远程命中（archived/subagent/blank 不再回流可点击结果）；仅未就绪时
  保留不过滤降级。
- **新建主机原子性（2026 audit M9，2026 final review 修正）** —— 保存顺序
  按注册表存在性：编辑既有主机密码先行（失败则注册表不动）；新增主机注册表
  先行再落密码（主进程拒绝为未注册 id 存密码），密码失败回滚元数据、回滚
  失败时按权威注册表保留编辑态（不再被 duplicate 校验拒绝）；测试复刻主进程
  未知-id 门禁。
- **来源域键（2026 audit L2）** —— 双击 pending 与 blank-ghost 宽限按
  `(serverId, sessionId)` 建键：克隆实例相同 UUID 跨来源点击/幽灵槽不再串
  状态（跨来源双击改名仍工作——两次点击键到行所属来源）。
- **IPC 镜像防漂移（2026 audit L3，最终审查强化）** ——
  `ipc-surface-mirror.test.ts` 在方法集比对之外增加**字段集比对**（覆盖
  manifest/chamber/gitWorktree/notifications 等辅助类型），并修复了三处
  真实漂移（preload 两个 manifest 缺 `chamber`、renderer
  `ChamberInjectionState` 缺 `gitWorktree`、settings `ChamberSettings` 缺
  `notifications`）。
- **远端插件 apply 主进程确认（2026 final review）** ——
  `desktop_ssh_plugin_apply` 的 registry add/remove 增加主进程确认对话框
  （远端持久执行面，与本地安装同门控）；`SshPluginApplyIpcResult` 增补
  `{ok:true,cancelled:true}`（三处镜像同步），同步/添加视图两处消费方处理
  取消为跳过而非误报。
- **退出守卫（2026 final review）** —— `trustedIpc` 在 quit 在途时拒绝全部
  IPC（`app_quitting`）；transport-manager `dispose()` 置内部门，`exec()`/
  `connect()` 退出后拒绝新工作（不再有 quit 在途理论孤儿 spawn 窗口）。
- **双端 materialize 分类一致性（2026 final review）** —— 客户端 `isPathSpec`
  的 file:/link: 前缀改为大小写不敏感，与主进程 `isMaterializeSpec` 对齐
  （远端 manifest 大写 `FILE:`/`LINK:` 不再双端分类偏差）。
- **遗留问题修复轮（2026 cleanup-review）** —— `settings-set` 校验失败
  形状统一为 `{ok:false,error}`；隧道 stdout 入环形日志前同样过提供者脱敏；
  `writeSettingsFile` 补 fsync+显式 0600（原子写纪律对齐）；`bundle-dsh` 的
  默认 dsh 版本改为**从已提交 runtime lockfile 派生**（与 release.yml 的
  硬编码不再可能漂移）；管理面 body 补 10s 逐块 idle 超时（不再占连接槽到
  35s 总限）；pid 记录与 seed overlay 原子写补 fsync；shell.ts 的
  `pluginDegraded` 声明移到闭包之前（消除 TDZ 脆弱点）；sidebar 拖拽提交
  改用活 store/活 roster（两处排序模式 + server 拖拽）；connections 保存/
  删除改为**对权威注册表读-改-写**（消除渲染闭包快照竞态）；git 未注册工作树
  删除前刷新失败显式上浮（不再吞错）；镜像测试 `stripComments` 行首锚定
  （字符串字面量内 `//` 不再误删）。实机冒烟仍待真实环境。
- **独立检查轮修复（2026 independent-review）** —— 桌面：askpass 助手改为
  密码不变即复用（不再每次删除重建——并发隧道+exec 互删对方在用助手的虚假
  认证失败竞态消除），清密码/删实例即清除已落盘助手；`desktop_ssh_seed_
  host_graph` 手动路径补主进程确认（自动路径不受影响），结果类型增补
  `{ok,cancelled}`（三处镜像同步 + UI 静默处理）；`connect`/`instances_set`
  对未知/非法输入收敛为 null/现状形状（不再 throw→rejection）；`TransportRun
  Command` 收窄为实际可分发集。验证体系：release.yml 新增 `validation` job
  并接入两个打包 job 的 needs（tag 发布无法再绕过验证门禁）；ci.yml 补桌面
  构建子步骤（control-plane/preload/host-graph-package）与第三方声明一致性
  校验；shell 串行化测试消除假阴性（B 清零旋钮 + 宏任务让出）；spawn 清理
  测试补进程表级断言（pid 日志方案与 SIGKILL 竞态，改用 ps）；镜像测试补
  Update/SettingsSurface 金基线；host 包构建校验产物存在；boot-rows 补
  extras 去重边界测试；`instance-mutation-values` 登记归位 test:sidebar。
  文档：05 §7.6 白名单与 13 §7.2 对齐、02 §3.4 补 dev 路径身份、09 §4 基线
  标注历史、desktop README 退出语义/字段清单、spawn-dsh 注释修正。
- **全新审查轮修复（2026 fresh-review）** —— 控制面：spawn 补 `error` 监听
  （ENOENT/Electron fuse 等异步 spawn 失败不再以未捕获异常崩溃整个进程）；
  反代 body 内存预算持有到上游请求完成（原先 readBody 后即释放，64×300MiB
  并发可耗尽进程内存）；进入 starting 前清 `dshPort`（投影不再短暂携带死
  端口）；`noteHealthFailure` 补 `signalCode` 死亡判定。类型面：settings-
  connections 的整套 IPC 声明改为从 renderer `global.d.ts` **re-export**（消除
  三处手工镜像漂移源）；settings-bridge 的 `chamber-bridge` 镜像对齐真实
  `ChamberServerAggregate`（删幻影 `hint`、补 workspaces/aggregate*/runtime）；
  `connections-section` 镜像补真实消费的 `pluginDiagnostics`；layout
  view-prefs 镜像补 4 个缺失可选字段；preload 暴露值归一化为 `null`；
  enter-row 采纳校验 wire 值（越界回退默认行为）；`composeBootRows` 对
  extraIds 去重；镜像测试适配 re-export 模型（9/9）。
- **第三轮审查修复（2026 round-3 review）** —— 控制面：存活判定补
  `signalCode`（信号杀死的子进程不再误报存活）；restart-exhausted 落地前
  终止残留子进程并清 `child/dshPort`（与「stops automatically」契约对齐）；
  `setState` 的 `error` 显式删除（内存/磁盘投影一致）；`→ stopped` 终态行
  显式落滚动日志；reaper 身份匹配兼容源码 tsx 启动路径；host-logs 改同步追加写
  + 内存环带压缩（消除异步流缓冲/异步打开与压缩 rename 的竞态——原先会重复并
  交错内容）并修空行分隔；offset 越界返回空；
  proxy 对带 body 的 GET/HEAD 排空（keep-alive 复用不串帧）。桌面/客户端：
  save-host 密码失败后的回滚抛错不再串扰报错文案（保留密码错误）；连接客户端
  `stop()` 现在中止在途退避睡眠；App 回收 effect 同步裁剪其余 per-instance
  refs。验证体系：CI tag 推送（v*）触发全量验证链 + host 包 esbuild 构建进
  入 push 路径；shell 新增跨实例串行 boot 测试；镜像测试补 25 方法金基线。
- **第二轮审查加固（2026 round-2 review）** —— 镜像测试升级为**类型敏感**
  比对（字段名之外还比对 `name:type` 签名，覆盖 PluginApplyResult /
  ChamberNotificationSettings / ChamberSettings 等）并修复解析脆弱性
  （`\b` 锚定防 `ChamberSettingsStatus` 前缀错配）；settings-connections 的
  `Window.dshChamber` 改导入权威 `DshChamberBridge`（不再自述镜像却缺 4 字段）；
  transport-manager 的 M2 测试改为真验证 `disposeAsync` 在 SIGKILL 前不 settle、
  新增 M10「分配期间断连不臂慢重探」守卫用例；shell 迟到 settle 测试时序裕量
  加宽（80ms 预算 / 250ms 延迟）。
- **session runtime 导出收敛（2026 audit M12）** —— 控制面 index 只 re-export
  生产符号（call/RpcBusinessError/RpcTransportError），respond/openEventStream
  不再对外（测试仍经 dsh-client.ts 直连）。
- **审计复核登记（2026 audit S19）** —— 以下审计项经复核确认**已修复、
  无需改动**：H7（Origin:null 已被 corsFor 拒绝，403）、M3a（proxy 空闲
  超时每 chunk 刷新、45s）、M5（pnpm pack/本地插件 CLI 均为异步 runChild）、
  M11（uncaughtException fail-closed 退出）、L1（layout WeakRef 扇出）、
  L4（CI 全部 action 以 commit SHA 固定）。
- **打包完整性** —— `notifications.ts` 补入 electron-builder `build.files`
  （此前打包产物缺该模块会启动失败）；preload 编译改为临时目录 emit 只搬入
  `preload.cjs`（消除 3 个死文件进 asar）；`build.files` 排除 `dist/.vite/**`。
- **死依赖清理** —— 移除控制面 `@simplewebauthn/server`（v1 认证面移除后的
  残留），锁文件与第三方声明同步。

### 变更

- **文档收口** —— `docs/progress/STATUS.md` 重写为只记录未完成/部分完成项与
  范围偏差（已实现基线以 git 历史与 CHANGELOG 为准）；AGENTS.md 与设计文档
  同步（open-in 包、ws-frames 测试、打包完整性 checklist 新增）。

## [0.1.5] - 2026-08-23

### 新增

- **VS Code 深链插件（设计 16）** —— `dsh-chamber://` OS 深链 + 应用内按钮
  快速拉起本机 VS Code Remote-SSH 打开对应 server 实例目录（本地走
  `vscode://file/`、远程走 `ssh-remote+`）；按钮位于官方会话头部 utilities
  槽（session-log 左侧），图标取自本机 VS Code 官方资源。
- **Git 工作树删除增强（设计 08 §6 修订，用户拍板）** —— dirty 工作树不再
  硬性阻断删除：删除对话框警示「未提交更改将被丢弃、分支保留」+ 勾选框，
  勾选后以 `git worktree remove --force` 移除；**分支/提交/HEAD 永不触碰**，
  身份/锁/主 checkout/running 守卫全部保留。

### 修复

- **Git 删除 504 竞态与 workspace 残留** —— 控制面实例反代上游空闲超时
  10s→45s（高于 host git mutation 预算 30s）、浏览器 git RPC 超时 30s→60s：
  慢速 `git worktree remove`（node_modules 重型目录）不再被 504 截断、
  不再残留"普通 workspace"。
- **Git host** —— pre-2.47 Git 回退换行定界 `--porcelain`（`-z` 未知开关
  exit 129 时自动降级）；以最高优先级 `-c core.hooksPath` 禁用 worktree
  hooks（防仓库自身 `core.hooksPath` 重新启用 `post-checkout`）。
- **控制面加固** —— 代理剥离转发身份头；keep-alive 超大 JSON 请求体排空
  （防连接被长请求体长期占用）；reaper 端口不可验证时 fail-closed；强制
  仅回环绑定地址。
- **桌面端安全** —— 拒绝渲染层注入的 `file:` 插件 spec；默认拒绝 web
  权限请求（剪贴板写入豁免）。
- **渲染器** —— pre-ready 503 预加载额外行有界重试（实例启动窗口内不再
  静默丢失 profile 安装的插件）；host-graph bundle 仅加载 root-relative
  形态。
- **侧边栏** —— 移除死的 `sessions.state` 完备性检查（修复 session 状态
  图标滞后一轮轮询周期的断链）。
- **设置桥** —— 搜索聚焦时服务器下拉保持打开；客户端插件诊断迁移到
  connections 插件的 chamber 块。
- **VS Code 插件** —— 按钮入位官方 `conversation.session.header.utilities`
  槽（不再与 utilities 行重叠）；图标换官方资源、排序在 session-log 左侧。

### 变更

- **发布流水线** —— macOS Developer ID 签名/公证接线（fail-closed：缺
  凭据或验签失败即不发布，删除旧 Release 之前先预检凭据）。
- **性能** —— 侧边栏拖拽目标未变化时跳过重渲染。

## [0.1.4] - 2026-08-21

### 新增

- **Git Worktree 插件 OpenChamber 呈现对齐（设计 08 §11）** —— **workspace
  行即 Git 表面**：occupant 渲染进 workspace 头部行内（分支 chip 常显、
  行内创建/删除动作与 "+"/kebab 同 hover 触发、状态徽标 dirty/↑↓
  ahead-behind/健康/attention），独立 git 行与独立面板座位移除
  （`sidebar.workspace.git` 上下文座位替代 `sidebar.git`）。创建对话框对齐
  OpenChamber：New/Existing 双 tab、分支名双词 slug 查重、目录同步/重置、
  来源分支下拉（localStorage 按仓库记忆）、已有分支可选框（快照 branches）、
  **单击直接创建**（无预览屏，host 校验链保留）、**创建永不提交会话**
  （recovery 携带 createSession 标志）。删除对话框列出关联会话标题（≤5 +
  "还有 N 条"）+ **可选同时删除本地分支**（用户授权，失败如实上报且不阻断
  已删工作树）。
- **Git Worktree 后端对齐** —— 统一 worktree 根
  `<DSH_HOME>/worktrees/<仓库>-<hash12>/<目录>`（集中、跨同名仓库无冲突、
  仓库工作树外）；**来源分支 startRef**（新分支从所选分支 HEAD 起，精确
  commit 钉死 + create 复验）；快照 **upstream/ahead/behind 只读事实**
  （status `--branch`，基于本地 refs 永不 fetch）；发现缓存 30s TTL +
  workspace 签名失效；`show-ref --heads`/`branch -D` 白名单新增。
- **显示全部 worktree（Plan A）** —— 未注册工作树按仓库分散到 repo 组
  末尾（名称=目录 basename，行样式与派生 workspace 一致），"新建会话"即
  adopt 懒注册、"删除"走未注册删除（host `workspaceId` 可选 + `path`，
  git-first 保留全部守卫，`next: 'none'` 跳过 workspace 删除）；孤儿
  workspace（路径已消失）显示"已消失"徽标，删除弹专门确认（仅清理注册、
  会话保留转未分组）；关联会话计数只统计可见会话（排除已归档/子代理）。
- **对话框细节** —— 创建对话框双 tab 改**滑块式切换**、来源分支/已有分支
  下拉复用仓库 Menu 原语（自定义样式，弃用系统 select）、**目录重名自动
  加数字后缀**（`name-2`/`name-3`…，打开/切换/失焦/提交四处查重，同仓库
  范围）；删除对话框移除长说明文字、工作树路径颜色提为主色。

### 修复

- Git host：**startRef 解析层被丢弃**（一选来源分支即 `invalid-input`，
  P1）；缺失分支 exit 128 被当硬错误（`localBranchHead` 非零即 null）；
  create 不清发现缓存（新工作树快照 30s 不可见）；快照每仓库每轮多余
  show-ref（缓存 branches 未消费）；deleteBranch 重放路径静默跳过。
- Git 客户端：无会话创建在恢复重试时仍建会话并跳转；existing tab 残留
  new 模式建议分支；existing 目录被静默覆盖；occupant 按钮未纳入拖拽
  尾随 click 抑制；分支删除结果被解码丢弃；attention/upstream 等新字段
  对旧 host 包按"缺省降级 + 未知值仍拒"解码（不再整源静默消失）；blur
  规范化保留非 ASCII（中文分支名不再被改写成 `-`）；死样式/死 locale
  清理。
- **Git host 404 语义**：git RPC 404 判定为确定性的
  `git-host-not-loaded`（host 包缺失或未生效，不建恢复、不重试）——本地
  重启桌面端、远程在连接设置中重下发 chamber host 包并"重启生效"。
- **一键重启远程实例**：connections 插件的 chamber 块新增"重启实例"按钮
  （`restart_service`）与 seed 后的"重启生效"（pendingRestart）态；同时
  chamber 双包 seed 新增 `gitWorktree` 探测。
- **窗口重建崩溃根因**：desktop 用带尾斜杠的 rendererOrigin 重建窗口产生
  `//` 双斜杠 URL，control-plane 的 `new URL` 解析在 Node 22 抛异常导致
  致命退出——两端修复（URL 归一化 + 解析 try/catch 返回 400）。

### 变更

- **dsh 基线升级 0.1.0-rc.8 → 0.1.1-rc.2** —— 构建期源码（`harness.commit` /
  vendor 树）、捆绑运行时（`@deepseek-ai/dsh`）与兄弟检出统一到 rc.2；
  in-repo fork 副本重基于上游 rc.2：`dsh-client-connection`（RPC 签名合并
  同时容纳上游 transport override、HTTP body 上限 160→300 MiB、
  `__DSH_TRANSPORT__` 传输钩子接线且完整保留 chamber per-instance basePath
  补丁）、`dsh-client-web`（boot 内核 `__DSH_TRANSPORT__.loadBundle` 接线 +
  预取跳过）。上游 rc.2 的图片/Files 管线（200MiB 图片准入）经 chamber 代理
  可达（见下条）。
- **控制面代理体积上限 50/100 → 300 MiB** —— per-instance 代理
  （instance-proxy）请求体/响应体上限与进程级缓冲预算对齐上游 rc.2 的
  300MiB 请求体上限（200MiB 图片 base64 膨胀 ~267.7MiB 后仍留余量）；
  413/503 语义与 30s 分片空闲超时不变。

## [0.1.3] - 2026-08-20
### 新增

- **Git Worktree 独立插件（设计 08）** —— 新增实例内
  `@dsh-chamber/dsh-host-git-worktree` Remote 与首屏静态
  `@dsh-chamber/dsh-client-ui-git`：30 秒单飞拓扑、`sidebar.git` 座位、创建
  worktree/workspace/session 补偿事务，以及 Git-first/workspace-delete 可重试删除。
  Git 与 workspace 权威同进程/同用户；主工作树、dirty、locked、运行中目标硬拒绝，
  全程不归档、不 force、不删分支，也不开放 fetch/pull/push 等网络 Git 动词；创建
  checkout 仍遵从该用户已配置的仓库 filter（例如 Git LFS，可能访问网络），并在确认
  界面明示。host-graph 与 Git host 包使用同一 overlay；本地 profile 和远程
  ready-time seed 均先完整预检两个包，再逐文件写入并一次合并 overlay（不是跨文件
  原子事务，失败会响亮并在下次 ready 幂等重试）。
- **Git Worktree 插件三处扩展（2026-08-20 合并后）** —— ① 每个工作树行新增
  「在此新建会话」：对**已有工作树**做只读采纳式会话创建（无 Git mutation；
  workspace 复用/注册 + 预分配会话 id，session 尝试后永不补偿）；② 会话↔工作树
  附着状态模型：host 快照按行分类 `ready/missing/invalid/not-a-repo`、
  `branch/detached/unborn` HEAD 与进行中 Git 操作（merge/rebase/cherry-pick/
  revert/bisect，从工作树 git-dir 探测），侧栏呈现健康/HEAD/attention/当前会话
  徽标，删除对不健康工作树显式阻断；③ 删除级联语义对齐：删除确认时递归枚举
  （`parentSessionId` 闭包）直接 + 全部子会话，文案明示「会话保留并转未分组，
  不删除」，并可选先归档整棵会话树（归档失败即中止，不删任何工作树）。
- **「检查更新」按钮与更新设置段**（design 11 修订）——设置「通用」段并入
  `UpdateSection`，用户可显式触发更新检查（与启动/周期静默检查同一条路径，
  从不自动下载）；`update-gate` 相位门 + 单测。

- **rc.8 后端版本容忍（设计 09 §3.3 修订）** —— 实例后端 dsh 官方前端版本与
  chamber 壳不同步时不再整 boot 崩溃：壳未覆盖的宿主图额外行（含 rc.8 新增
  `dsh-client-ui-attachment` client half 等核心行）apply/materialize 失败降级为
  **特性缺席**（console.error + status `failed`，shell 照常 boot）；壳种子词表对齐
  rc.8 官方平台集（平台词 = 永不成为图行的包）；app-shell renderer 安装容错（后端
  `ui-renderer` 行先装则采纳）；chamber 入口 bundle 装载去 `?rev=`（与 vite chunk
  图裸引用同 URL → 延迟 ui-* 族不再二次执行入口 bundle，duplicate factory 消失）。
- **boot 容错决策规则单测（`pnpm run test:client-web`）** —— 版本容忍判定规则
  提取为纯函数模块（`dsh-client-web/src/boot-tolerance.ts`）并纳入 CI 单测面，
  后续改动不再靠人工回归。


### 修复


- **退出流程加固**（design 14 review 轮）——退出确认仅在本地 dsh 进程实际
  存活时弹出（`localProcessAlive`，状态串独立事实）；SIGTERM/SIGINT 走优雅
  退出路径（will-quit 完整回收，强停不再残留 detached 孤儿进程占端口）；
  控制面 stop 先强关连接再 close（滞留 SSE/WS 不再挂死退出）；设置壳重构为
  「连接/通用」两固定入口 + `quitConfirmation` 开关。
- **插件管理 Modal 两处修复**——浅色主题白底白字（内容锚定
  label-primary）；本地实例恒 loading 导致 footer「关闭」死控件（移除）。


- 实例运行 rc.8 官方前端时 chamber 渲染器 boot 崩溃（seed 词表遮蔽 factory →
  "invalid plugin"），现降级为特性缺席、实例照常可用。
- 延迟加载的 ui-* 族导致 tool-call 节点渲染"未知 surface 事件"兜底文案（chamber
  入口 bundle 因 `?rev=` 与 chunk 图裸引用被浏览器视为不同模块而二次执行）。
- 后端 `ui-renderer` 行先装 slot-renderer 时 app-shell 整 boot 失败，现采纳已装
  renderer。
- boot 容错日志措辞与实际失败类型对齐；manifest 预加载行去重过滤覆盖旧的 `?rev=`
  残留形式。


### 变更


- **全量对齐 dsh rc.8 baseline（设计 09 §4）** —— `harness.commit` →
  141eb6fef8（dsh 0.1.0-rc.8）：vendor 源物化为仓库内受管快照
  `vendor/harness-checkout`（规避 pnpm 11 锁文件剪枝，`--frozen-lockfile` 通过）；
  boot 内核迁 rc.8 模块系统 bootstrap（`boot.ts` 类结构 + `__ModuleLoader__`
  facade + BootPage 加载页，挂载经 `ctx.uiRenderer`）；复合延迟族 +3 覆盖
  （`ui-attachment` / `ui-brand-official` / `ui-reference`）、`ui-renderer` 归
  page-own；web-react/schema-form 深导入随删/迁移（渲染装配移入 ui-renderer 行，
  settings 系迁 `SettingsSchemaService`）；本地宿主同步升 rc.8（vendor dsh
  0.1.0-rc.8）。rc.8 客户端自带 `commands.execute` 的 `images` 参数，临时兼容桥
  随对齐移除；rc.7 宿主随对齐移出支持面。



- 壳种子词表移除 rc.7 遗留平台词（`dsh-client-web-react` /
  `dsh-client-ui-attachment` / `dsh-client-schema-form`），与 rc.8 官方一致。
- 设计 09 失败降级语义按层表述：加载失败响亮归预加载层（collectExtraRows），
  apply/materialize 失败降级归 boot 内核层。

## [0.1.2] - 2026-08-19

### 新增

- **桌面自动更新（设计 11）** —— 静默更新检查（启动延迟 + 6 小时周期）、设置页低调的「更新」分区、仅在用户明确确认后下载、退出时安装。双平台更新源已随发布提供（`latest.yml` / `latest-mac.yml`；beta 频道经 semver 预发布版本）。macOS 安装环节在缺少 Developer ID 签名时如实提示（给出手动安装指引，绝不假报成功）。
- **睡眠/后台常驻（设计 14）** —— 关窗行为可配置（隐藏到托盘让 dsh 继续运行，或退出；退出前若会停掉活动隧道或本地实例则先确认）、登录自启（mac/linux）、OS 唤醒即时重连（不等心跳 watchdog）、保持唤醒开关。设置持久化于主进程 `chamber-settings.json`（0600、原子写、损坏文件保留）。
- **Chamber 设置页（设计 15，v1 平铺表单）** —— 设置壳固定入口 Connections / General / Update；chamber 全局设置与实例配置平面严格分离。
- **首屏性能（P4）** —— 服务 HTML 中的静态骨架 + 关键 CSS、并行 boot、host-graph 拉取与 boot 链重叠、非首屏 ui-* 系列拆为懒加载 chunk（入口 chunk 934KB → 650KB）、与清单 URL 匹配的绝对 modulepreload、控制面 `/assets/*` 即时 gzip + 不可变缓存。
- **侧边栏 UX 批量改进** —— 单击立即打开会话、双击重命名；经 chamber ui-layout fork 跨 shell 与重启持久化侧边栏宽度；N-ctx 切换服务器时保留侧边栏滚动位置；显式排序菜单 + 官方 updated-order 语义（手动顺序 + 活动提升）。
- **Host-graph 可见性** —— chamber 注入的宿主包行展示模块 A 版本与实时生效三态（已生效 / 重启后生效 / 未知），经隧道 RPC 探测。
- **Boot 加固** —— covered 包的联合表补全、chamber 级失败遮罩（报告 + 重试 + 切换服务器）、首次启动模块系统竞态修复。

### 修复

- macOS：`windowCloseBehavior='quit'` 现在真正退出（此前在 darwin 上会永远停留在无窗口状态）；唤醒重探不再在退出拆除期间生成传输。
- `isAllowedReleaseUrl` 拒绝百分号编码的路径穿越与 userinfo —— 白名单不再能被指向任意 github.com 路径。
- 更新器：下载进行中时周期重检不再覆盖 `downloaded` 状态；错误文本路径脱敏覆盖任意 POSIX 绝对路径。
- 侧边栏：两个 rowActions 包裹 span 现在把 `stopPropagation` 与 `clearPendingClick` 配对（残留的 pending 可能误入重命名）。
- 远程插件列表刷新不再为未初始化的远程 profile 写 ERROR 日志（静默 manifest 探测）。
- 设置壳 keyed-slot 支持（插件页不再弃置 chamber 壳）；子 ctx 错误在宿主 seam 处收口。
- 连接设置：chamber-block 可读性恢复；刷新操作区分开。
- 渲染层/侧边栏滚动同步排除 ghost 行；排序推导收敛不再写循环。

### 变更

- **macOS 发布构建现在面向 macOS 26**（`macos-latest` runner）—— macos-14 已弃用（2026-07）且到 2026-11 不再受支持。
- 发布工程：版本断言覆盖全部 6 个 chamber 包；发布 workflow 并发守卫；CI 打包显式 `--publish=never`（否则 electron-builder 26 在 CI 环境中隐式发布）。
- **发布产物不再附带 `.blockmap`** —— Windows `nsis.differentialPackage` 恢复为 `false`；mac zip 硬编码的 `.zip.blockmap` 在 finalize 前从 draft 移除。更新源永不引用 blockmap，更新回退为全量下载（功能不变）。
- 中文 README 提升为主版本（`docs/README.en-US.md` 镜像）。

## [0.1.1] - 2026-08-18

### 新增

- Chamber host-graph 注入在插件管理中可见（本地/远程 seed 接线、`--patch` 覆盖、安装级回退）。
- 客户端插件运行时加载（设计 09）：每实例 host-graph 合并、额外 entry 预加载、covered 集去重。
- 经 SSH exec 通道的远程插件管理（list / add / remove / restart、spec 白名单）。
- 多来源侧边栏增强批次（workspace 分组、信息卡、运行中 subagent 指示、跨 ctx 实时同步）。
- 可信 IPC + 导航围栏到控制面主 frame；拒绝非 loopback 的 HTTP/WS origin。
- Windows 单趟精简安装器；应用/托盘图标；打包 dev 实例隔离。

### 修复

- 瞬时隧道失败经慢速重探重试；渲染层崩溃窗口恢复；N-ctx cordis ctx 在 dispose 时拆除；排队中的会话打开保持 pending 直到 runtime 接受；行操作上光标闪烁；chamberBridge 发布以投影签名门禁（保持身份一致的聚合状态）。

### 变更

- 集成 dsh 0.1.0-rc.7（harness 固定 + CI bundle 固定 + lockfile 同步）。
- v1 放弃 macOS x64 CI 构建（仅 arm64）。
- 自动更新重设计为低调的设置流（设计 11 范围）。

## [0.1.0] - 2026-08-15

初始发布 —— dsh 的本地桌面连接管理器：

- 控制面连接核心：web profile 宿主托管、管理 REST（`/health`、`/api/connections`、`/api/host/logs`）、每实例同源反代、静态前端服务。
- 自建渲染层（dsh 官方前端源码复用）：N-ctx 多实例、chamber 侧边栏 / 连接设置 / 设置壳客户端插件。
- SSH 传输（隧道 + 远端 systemd）、实例注册表、Electron 单 frame 壳、CLI。

v1 范围：无认证/审计面（仅 loopback 控制面）。

[0.1.5]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.5
[0.1.4]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.4
[0.1.3]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.3
[0.1.2]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.2
[0.1.1]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.1
[0.1.0]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.0
