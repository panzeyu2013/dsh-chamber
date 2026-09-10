# 16 · VS Code 深链（deeplink 拉起本机 VS Code 打开对应来源目录）

> **状态：现行（OS 深链与 VS Code 拉起契约，2026-12）**——注册 `dsh-chamber://`
> 深链并用**本机 VS Code**（本地 `vscode://file`、远程 `vscode://vscode-remote/ssh-remote+…`）
> 打开指定/当前来源的工作区目录；应用内打开入口已演进为 open-in 通用注册表
> （设计 20，插件 `dsh-chamber-client-ui-open-in`），本文只保留 OS 深链与
> vscode 拉起契约；**M3 实机验收未完成**，未完成门禁见 `docs/progress/STATUS.md`。
>
> 形态纪律：**无 host 插件、无 seed**——动作是本地拉起 VS Code，没有实例内执行面；
> 深链是 OS 级不可信输入，全部校验在主进程完成。
>
> **与设计 20 的分界**：应用内按钮/桥面/IPC 均为设计 20 的 open-in 面
> （`open-in-apps` / `open-in`；旧的 `dsh-chamber:open-vscode` /
> `vscode-availability` 两通道与 `window.dshChamber.vscode` 桥面已随旧插件删除），
> 本地目录探测与 launch 由实例自身官方宿主半边（`dsh-host-open-in-app`）经
> 每实例代理 `<basePath>/open-in-app/*` 执行，主进程 open-in 注册表**收窄为
> vscode-only**（`finder`/`stat`/`openPath`/`showItemInFolder` 面退役）。
> 本文 §7.2 的锁步清单与 §6 的槽位/门控纪律是两者共用的接线模板
> （设计 20 §5/§3 为其现行形态）。
>
> **连接模型 v2 注记**：现行来源 id 为 `dsh-<id>` / `gateway-<id>`，`ssh-<id>`
> 仅保留 legacy 兼容映射；kind 是目标类型，是否能使用 VS Code Remote-SSH 由
> `transport === 'ssh'` 决定（17 §2.2/§9.1）。

## 1. 目标与非目标

### 目标

- 注册自定义协议 `dsh-chamber://`，macOS `open-url` / Win+Linux `second-instance`
  argv / 冷启动 argv 三类入口统一收进主进程深链核心；
- 深链按 `instance=<id>` 映射注册表 SSH 实例，构造 `vscode://vscode-remote/...`
  经主进程 `shell.openExternal` 打开（或 code CLI argv 形态，v1 以 URL 为准）；
- 应用内入口（会话头部 utilities 行，§6.1）打开**当前 header 所属会话的工作区**；
- **本机 VS Code 可用性探测**：不存在（或未知）→ 入口不显示（fail-closed，§6.3）。

### 非目标（明确不做）

- **不做 host 插件 / 不做 seed**：无实例内执行面；与设计 08/13 的远端分发机制无关；
- 不做远端路径存在性校验（VS Code 自会报错，诚实透传；UI 文案明示该边界）；
- 不自动注入非标准 sshPort 的 `~/.ssh/config`（确定性拒绝 + 指引，见 §3.2）；
- 不供给密码认证主机的免密（VS Code 自行弹框；v1 不感知注册表密码存储）；
- 不做 code-server / openvscode-server 网页版（"服务器上的 VS Code" = Remote-SSH）。

## 2. 形态与分层

```text
┌─ 客户端插件 @dsh-chamber/dsh-chamber-client-ui-open-in（编译期打包，08 同款）─┐
│  conversation.session.header.utilities 条目：会话头部 utilities 行内按钮      │
│  （order -1，排在 vendor "Session log" 左侧；placement 见 §6.1）              │
│  coordinator 单例：应用清单/可用性事实（主进程 + 实例官方目录，单飞共享）      │
│  门控（§6.3）：来源可用应用集非空 ∧ 该 header 的会话属于有 path 的工作区，     │
│  否则渲染 null；本地来源走 `vscode://file/`、远程 ssh 走 `ssh-remote+`         │
│  零 @dsh-chamber 依赖（仅 peer 依赖 vendor 包）                               │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ IPC（trustedIpc 围栏：open-in-apps / open-in）
┌─ 桌面主进程 deep-link.ts（深链核心）+ 主进程 vscode 覆盖 ────────────────────┐
│  DeepLinkHandler 注册表（scheme → parse → execute，镜像 TransportProvider）  │
│  └ vscode handler：instance 白名单+实查 → authority 构造（§3.2）→            │
│    buildVscodeRemoteUrl（§3.3 编码纪律）→ openExternal（scheme 硬编码）       │
│  detectVscodeAvailability(platform)：纯 fs + PATH 扫描，绝不 spawn（§5）      │
│  main.ts 只接线：顶层 open-url + pendingIntents 队列 + 打包门控协议注册       │
│  + second-instance argv（无深链 argv → 仅 showMainWindow）+ quit guard        │
└─────────────────────────────────────────────────────────────────────────────┘
```

- `packages/renderer` 只把客户端插件静态注册进复合 entry（设计 08 §7 锁步），不拥有
  深链事实/业务 UI；
- `packages/control-plane` 零改动（深链与实例执行无关，不经过实例反代）；
- `packages/desktop` 持有深链核心与可用性探测（宿主能力）；新 IPC 走既有
  `trustedIpc` 围栏（05 §7.4）；
- VS Code 启动与 dsh shell 激活为两条独立链：启动由主进程直接完成、不等待 UI；
  成功后的归一化 intent 进入有界 hold/replay 队列，App **先**安装
  `deepLink.onIntent`、再调用 `deepLink.ready()`（失败按 5×500ms 有界重试），主进程
  此后才推送；每条 push 带主进程签发的 `sourceFingerprint`、稳定 `deliveryId` 与
  逐次递增 `attempt`，renderer 接受/入队后精确 ACK，主进程才释放记录。远程来源还要
  在 renderer 等当前 generation 的首次权威 `instances_get` 成功后，以 roster + proof
  双门确认才 `selectView`；此间单槽 last-intent-wins，local 立即激活，注册表缺少目标或
  proof 过期才 loud 丢弃。冷启动/重载不会因监听或 roster 尚未就绪而丢激活；
  shell 自身激活失败仍不回滚已经完成的 VS Code 拉起。通知点击采用同构 roster/proof
  门，但保留完整 `{sourceId,sourceFingerprint,sessionId,deliveryId,attempt}` 的 64 条
  有界 FIFO。
- **来源代与 proof 轮换**：每个成功 launch 在主进程捕获当前来源 ownership token，
  renderer push 携带 `{instanceId,path,sourceFingerprint,deliveryId,attempt}`；远程
  proof 是主进程内存签发的 opaque 值，删除来源或编辑其传输身份会轮换来源代并丢弃旧
  pending/in-flight，renderer 在激活/ACK 前用权威 roster + proof 复验，同 id 重建
  不继承旧 intent。

## 3. 深链契约

### 3.1 格式与解析

```
dsh-chamber://open-vscode?instance=<id>&path=<远端绝对路径>
```

- 用 `new URL()` 解析；`hostname` 必须精确等于 `open-vscode`（其余 host 一律拒绝，
  不猜测、不归一化）；
- `instance`：`INSTANCE_ID_PATTERN`（`/^(?!local$)[a-zA-Z0-9_-]{1,64}$/`）+
  注册表实查（`transportManager.listInstances()`），查无或
  `transport !== 'ssh'` →
  确定性拒绝 + loud；**`local` 显式放行**（用户决策 2026-08：走 §3.4 的 local 分支，
  不查注册表）；
- `path`：必须以 `/` 开头（绝对路径），拒绝控制字符 / CR / LF / NUL，长度 ≤ 4096；
  缺失/非法 → loud 错误；
- 幂等/去重：macOS `open-url` 与 argv 可能以不同 raw URL 拼写双触发同一目标；
  parse 后以 `(instanceId,path)` 归一化 key 做 pending+in-flight single-flight。
  启动队列与 renderer replay 队列各有 64 条硬上限，容量覆盖 pending + sent-but-unacknowledged；
  满时 loud 丢弃最旧 pending，**无 pending 可淘汰时明确返回 `saturated`**
  并 loud 拒绝新 intent（绝不冒充
  已接收）。renderer 投递队列的 key 直到精确 ACK 才 complete，因此 send-return 后的
  reload 窗口仍保持 single-flight；ACK 后允许用户稍后主动再次打开相同目标。

### 3.2 authority 构造（与 SSH_HOST_PATTERN 解耦）

`SSH_HOST_PATTERN`（ssh-provider.ts:78）允许 `:`（为 IPv6），**不得直接复用**拼
authority。规则：

- `authority = [<user>@]<host>`；`user` 为 null 时省略（注册表非秘密元数据）；
- host 含裸 `:`（非合法 IPv6 字面量）→ 拒绝（防 `host:port` 误填歧义）；
- IPv6 必须带 `[]` 括号（`[::1]`）；
- **`sshPort != null && != 22` → 确定性拒绝 + loud 指引**（VS Code 的
  `ssh-remote+` 目标按 `~/.ssh/config` 别名解析，URL 无法可靠携带端口；文案：
  "请在 ~/.ssh/config 配置该主机别名后重试"）；
- host/user 均来自注册表（保存时已过白名单），构造时仍 encodeURIComponent 防御。

### 3.3 打开 URL 构造（编码纪律，纯函数）

```ts
buildVscodeRemoteUrl(host, user, sshPort, path): string
// → vscode://vscode-remote/ssh-remote+<authority><encoded-path>   （远程源）
buildVscodeFileUrl(path): string
// → vscode://file/<encoded-path>                                  （local 源，用户决策 2026-08）
```

- scheme **硬编码 `vscode:`**，绝不把原始深链 URL 透传给 `shell.openExternal`
  （对比 `isAllowedReleaseUrl` 白名单纪律）；
- path 逐段 `encodeURIComponent`（首 `/` 保留），空格/中文/`#`/`?`/`&`/`%` 均有
  单测覆盖；控制字符在 §3.1 已拒绝；
- **新窗口默认（2026-12，chamber 设置驱动）**：两个构造器在 chamber 设置
  `vscodeOpenInNewWindow`（chamber-settings.json，通用页「运行」组，默认开）
  开启时统一追加 `?windowId=_blank`。背景：VS Code 运行中收到外部协议 URL 时，
  其主进程对外部文件夹 URL 默认走「复用最近活动窗口并替换内容」（
  `window.openFoldersInNewWindow` 默认 `default` 不参与覆盖，CLI 与 URL 的默认
  分支不同）——该参数在复用决策**之前**强制新窗口分支，且目标文件夹已开在某
  窗口时仍聚焦旧窗口、不重复开（行为依据：本机 VS Code 1.135 主进程 bundle 的
  `handleProtocolUrl`/`shouldOpenNewWindow`/`openInBrowserWindow` 逐级核实）。
  关闭设置则保持裸 URL，交还 VS Code 自身策略。参数只追加在编码后的 path 之
  后，不触碰逐段编码纪律与 scheme 硬编码；主进程注入点前缀复验不受影响
  （URL 仍以 `vscode://file/` 或 `vscode://vscode-remote/` 开头）。
- 失败路径全部 loud：对话框（VS Code 未装）/ 日志 / `{error}` 返回，绝不静默假成功。

### 3.4 入口一致性

- OS 深链与主进程 open-in 的 vscode 通道（`open-in` IPC，设计 20 §3.1）
  **共用同一 `execute()` / `runVscodeLaunch`**：
  IPC 只是可信渲染端触发的 intent，同样过注册表实查、authority 构造、可用性校验；
- **local 分支（用户决策）**：`instanceId === 'local'` 时 `runVscodeLaunch` 不走
  注册表（local 不在 ssh 注册表），直接 `buildVscodeFileUrl` + 可用性校验 + 打开；
  `instance=local` 的 OS 深链与应用内入口均支持（§3.1 的 pattern 校验对 `local` 显式放行）；
- OS 深链在 VS Code 不存在时无法"不显示"（协议注册与可用性无关）→ `execute()` loud
  报错；入口侧则由门控直接隐藏（§6.3）。

## 4. 主进程深链核心（deep-link.ts）

### 4.1 DeepLinkHandler 注册表

```ts
interface DeepLinkHandler {
  scheme: string                 // 本 handler 处理的深链 scheme
  parse(url: URL): Intent | null // 校验失败返回 null（+ 日志）
  execute(intent: Intent): Promise<{ ok: true } | { ok: false; error: string }>
}
```

vscode handler 为第一个实现；未来"在终端打开/浏览器打开"等深链动作只增 handler，
核心零改动（镜像 05 §7.6 "新来源接入 = 新 provider + kind 注册"）。

### 4.2 生命周期接线（main.ts）

- `app.on('open-url')` **在模块顶层注册**（whenReady 之前，与 second-instance 同层）
  ——冷启动深链先于 startup 完成到达，必须入 `pendingIntents` 队列；
- `pendingIntents` 在 startup 完成（transportManager 装载 + 主窗口创建）后顺序
  drain；成功拉起只把 intent 交给独立 `pendingRendererIntents`，不直接向尚未订阅的
  frame 发送。冷启动 argv 在 `whenReady` 内解析（macOS argv 含 `-psn_` 噪声，
  防御式：非深链 argv 零副作用、绝不 throw 打断启动）；
- preload 暴露 `deepLink.onIntent()` + `ready()`；App 按 listener-before-ready
  顺序握手。导航开始/renderer crash/窗口关闭会复位 ready；`did-finish-load` 与
  ready handler 都尝试 drain，覆盖“React 已握手但慢子资源仍令 isLoading=true”的
  顺序；App 对 ready 的瞬时失败做 5×500ms 有界重试并在耗尽时 loud；旧窗口事件
  不得改变新窗口状态。`webContents.send` 返回只把记录转成 in-flight，**不代表消费
  成功**；renderer 在完整 intent 已接受/入有界 roster 队列后调用 trusted
  `deep-link-ack(deliveryId,attempt)`，仅精确当前 attempt 释放容量与 single-flight key。
  reload/crash/start-loading/closed 将全部未 ACK 前缀按 FIFO 放回队首，下一次发送递增
  attempt，旧 document 的迟到 ACK 无效；同步 send throw 只 rollback 当前 intent，
  早先成功发送的前缀继续逐项等待 ACK，后继不得越过。仅仍为 current 的失败窗口可
  撤销 ready，ready IPC 返回 false 令 renderer 进入下一次有界握手。主进程完成这一级
  replay 后，远程 intent 仍按 §2 的权威 roster generation + sourceFingerprint 二级
  hold/replay，避免冷启动 roster 尚未返回时被视为已删除，也避免旧来源代激活同 id
  replacement；
- Win/Linux：`second-instance(event, commandLine, …)` 扫描 argv；**无深链 argv →
  仅 `showMainWindow()`**（现有行为保持；handler 签名变更不可避免，语义不变）；
- `quitRequested` 置位后（before-quit 确认在途 / will-quit 清理）到达的深链直接
  ignore——不启动 VS Code、不重建窗口（不进 05 §7.7 状态机）。

### 4.3 协议注册（打包门控）

- **`app.isPackaged` 门控** `setAsDefaultProtocolClient('dsh-chamber')`（镜像托盘
  `maybeCreateTray` 的打包态门控先例）——开发态注册会把裸 Electron 注册成 scheme handler，污染
  LaunchServices，与打包版（bundle id `com.dshchamber.desktop`）冲突；
- `setAsDefaultProtocolClient` 的 `false` 返回值与 throw 都经
  `attemptDeepLinkProtocolRegistration` 变成 loud 失败日志，绝不把“未注册”写成成功；
- **打包 Linux/macOS 均使用无 relaunch args 形态**；冷启动时 `argv[1]` 可能就是
  本次 `dsh-chamber://` URL，绝不把它作为固定参数写进协议注册。Electron 的
  executable+script 参数形态仅属于 `process.defaultApp` 开发启动，而本应用已门控开发态注册；
- 打包态：electron-builder `protocols: [{ schemes: ['dsh-chamber'] }]`（自动生成
  mac `CFBundleURLTypes` / linux desktop `MimeType` / Windows 注册表项）；
- dev 深链测试：`electron-dev.mjs` 支持透传 argv 注入（URL 作为冷启动 argv），
  不依赖真实 OS 协议事件；
- Windows（design 23 已解锁）：打包态同样走无参数 `setAsDefaultProtocolClient`
  （electron-builder `protocols` 的 Windows 注册表项是否同时写入为实证项，
  同目标幂等）；`open-url` 为 mac 专属事件，win/linux 由 `second-instance` argv
  扫描 + 冷启动 argv 扫描投递。

## 5. VS Code 可用性探测（默认口径，用户拍板）

### 5.1 判定（纯函数、零副作用）

```ts
detectVscodeAvailability(platform): { available: boolean }
```

- **纯 fs + PATH 扫描，绝不 spawn、绝不执行任何东西**（探测自身无副作用、<1ms）；
- macOS：`/Applications/Visual Studio Code.app` 或 `~/Applications/Visual
  Studio Code.app` 存在，**或** PATH 中存在 `code`；
- Linux：PATH 中存在 `code`（覆盖 /usr/bin、/usr/local/bin 等），或常见安装路径存在；
- Windows：`%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe` 存在，或 PATH 中
  存在 `code.cmd`；
- 用 `access(X_OK)` 校验可执行位（PATH 中 `code` 为目录/无执行位不算存在）；
- **只认稳定版 VS Code**：Insiders / Cursor / VSCodium / oss 检出为"不存在"→
  按钮隐藏，文档明示；
- 诚实边界：探测是 best-effort 正信号，未检出 ≠ 保证不存在，但足以决定
  "显示/隐藏"。

### 5.2 投影与时机

- 主进程 open-in 面 `open-in-apps`（getter，**每次实探**，无缓存陈旧问题）返回
  可用的主进程应用集（当前为 VS Code；见设计 20 §3.1）；
- 主进程启动时无需预探（getter 惰性）；`execute()` / `runVscodeLaunch` 内**二次校验**
  （防御纵深：IPC/深链两条路都过，VS Code 不存在 → loud `{error: 'vscode not detected'}`）；
- 渲染层经 preload `openIn.apps()` 拉取；coordinator 单例单飞共享。

## 6. 客户端入口（现由 open-in 面承载）

### 6.1 放置：会话头部 utilities

- 注册进**官方会话头部 utilities 槽**（`conversation.session.header.utilities`，
  与 vendor "Session log" 同一右对齐行）——按钮以普通流式布局排在 session-log 旁边，
  **无绝对定位**，由头部排版自动排列；
- **shell.overlay 不是可用承载**：details 列关闭（默认）时中心列延伸到 frame 右缘，
  官方会话头部 utilities 行右对齐于头部右侧，frame 右上不存在可靠空闲锚点
  （头部高度/tabs/details 开合均变化）——frame 层方案会与 utilities 行重叠；
- 槽是 session 作用域：组件直接收到**本头部所属的 `sessionId`** 与框架全局
  `useWorkspaces` 选择器钩子（同一 store，侧边栏归组同源），**不直接读 ctx 的
  sessions/workspaces**（inject 声明保持 `['slots','locale']`）；
- 按钮 CSS：行内 32×32 图标按钮，**样式与 vendor "Session log" pill 同款复用**
  （`0.5px solid var(--dsw-alias-border-l2)` 描边、`border-radius: 18px`、透明底、
  hover 主题 tint、focus 环），与头部工具行对齐；aria-label / tooltip /
  键盘可聚焦保持；
- **行内排序**：条目注册带 `order: -1`——utilities 行按 `order`
  升序排列（默认 0），因此 open-in 按钮排在 "Session log"（order 0）**左侧**，
  session-log 保持在最右侧；
- **图标**：VS Code 入口用**官方产品图标资源**（从安装的
  `Visual Studio Code.app` 的 `Code.icns` 提取 32px@2x PNG → `vscode-icon.png`，
  vite 内联为 data URL），不用手绘近似 logo；
- **`shell.overlay` 槽保留在 layout fork 中**（`AppFrame.tsx` 渲染
  `<div data-shell-overlay>`，层 `position:absolute; inset:0; z-index:20`，
  `.overlayLayer > * { pointer-events: auto }`），现由 mobile 客户端插件的抽屉开关
  等使用——本设计不再用它承载头部按钮。

### 6.2 coordinator（单例，git 插件同款模式）

- 模块级单例：`attach()` 首/末 retain 拥有唯一订阅与探测；
- **应用集/可用性事实**（主进程 + 实例官方目录）：单飞拉取一次，跨 N-ctx 共享；
- **当前工作区路径读自身 ctx**：`ctx.chamberInstanceId` +
  header 的 session/workspaces 选择器，**不走 chamberBridge
  跨 ctx join**——本包因此零 @dsh-chamber 依赖（仅 peer 依赖 vendor 包）。

### 6.3 三进门控（任一不满足 → 渲染 null，不显示）

1. 该来源的可用应用集非空（探测失败 / IPC 异常 / 未知来源 → 隐藏，fail-closed；
   http 与未知来源天然为空——vscode-remote 是传输能力，设计 20 §5）；
2. 本 header 的 `sessionId` 属于有路径的工作区（**本地与远程 ssh 来源都显示**：
   local 源的工作区路径在本机，走 `vscode://file/<path>`；远程源走 `ssh-remote+`；
   §3.4 的 local 分支）；
3. 存在工作区 path（空白新会话/无工作区 → 隐藏）。

### 6.4 交互

- 点击 → 主进程 open-in 通道（`open-in` IPC，携带 `appId/instanceId/path/sourceFingerprint`；
  主进程二次校验；设计 20 §3.1）；
- 无当前工作区时入口不显示（不是禁用——避免悬停暗示不可用动作）；
- 打开结果：成功静默；失败主进程 loud（对话框/日志），renderer 侧同步展示
  `{error}`（如 VS Code 未装、sshPort 非 22、实例已删除）。

## 7. 非破坏保证与接线清单

### 7.1 非破坏保证

- **现有包改动 = 0**：sidebar / layout / connections / settings / git 源码零改动
  （`shell.overlay` 已由 chamber layout fork 声明并渲染，无需改它）；
- `TransportInstanceSpec` **零字段变更**（注册表只读消费）；
- 新 IPC / 新包 / 新模块 / electron-builder `protocols` 键全部纯新增；
- `second-instance` 无深链 argv → 仅 `showMainWindow()`（语义保持）；
- 协议注册打包态增量、开发态门控，不影响既有功能。

### 7.2 客户端插件锁步（10 处，设计 08 §7 + chamber-entry 头注）

1. `chamber-entry.ts` 静态 `import * as UiOpenIn from '.../client'`（首屏）；
2. `chamber-entry.ts` apply() `ctx.plugin(UiOpenIn)`；
3. `chamber-entry.ts` `COVERED_FACTORIES` 加
   `['@dsh-chamber/dsh-chamber-client-ui-open-in', coveredFactory(UiOpenIn)]`；
4. `chamber-covered.ts` `CHAMBER_COVERED_IDS` 加 id；
5. `chamber-covered.ts` `CHAMBER_COVERED_FACTORY_IDS` 加 id
   （三向锁步由 `assertCoveredFactoryLockstep` + CI host-graph.test.ts 强制）；
6. `vite.config.mjs` alias 三行（`/`、`/client`、`/shared`）；
7. 新包 `package.json`（`dsh.client` 声明 inject `['slots','locale']`）+ `tsconfig.json`
   + `vendor-modules.d.ts` ambient 面 + `window.dshChamber.openIn/deepLink` ambient
   镜像（参照 connections `global.d.ts` 模式）；
8. 根 `package.json` 增专属 `typecheck:<插件>`（参照 `typecheck:git`）；
9. `.github/workflows/ci.yml` typecheck 块增同一脚本（逐条列出）；
10. `locales.ts` zh/en + `LocaleNamespaceMap` 声明（手动锁步——**`verify:i18n` 只
    校验 docs 双语对，不覆盖插件词典**，勿声称其为门）。

### 7.3 desktop 接线

- **打包面**：`packages/desktop/*.ts`（含 `deep-link.ts`）由 electron-builder
  `files` 的 `*.ts` glob 整体收入（`!*.test.ts` 排除测试），新增主进程模块**无需**
  逐文件登记；只有必须解包的模块才进 `asarUnpack`（当前 `sanitize-error.ts` /
  `dsh-runtime-controller.ts`）；
- **类型面**：根 `tsconfig.json` 以 `packages/desktop/*.ts` / `*.cts` glob 收入；
- `test:desktop` 脚本**逐项列出**测试文件（含 `deep-link.test.ts`、
  `open-in.test.ts`）——新增测试必须登记；
- `preload.cts` 暴露 `deepLink.onIntent()/ready()/ack()` 与 open-in 面
  （`openIn.apps()/open()`，设计 20 §3.2；`build:preload` 自动编译）；
- main.ts 接线（§4.2/§4.3）；
- electron-builder `protocols` 键（`schemes: ['dsh-chamber']`）；
- release.yml 版本断言：**自动纳入**——`release-preflight --versions-only` 以数据
  驱动核对「根 + `packages/` 下全部非 fork 包 = 目标版本」（`@deepseek-ai/*` fork
  副本按 FORK_VERSION），因此新包必须与根同版本，不额外手工登记。

## 8. 安全不变量

- 深链是 OS 级不可信输入：instance 过白名单 + 注册表实查（`local` 走独立分支）；
  path 过 §3.1/§3.3 编码纪律（local 分支同款：绝对路径、无控制字符、逐段编码）；
  scheme 硬编码 `vscode:`；`openExternal` 仅主进程且注入点复验
  `vscode://vscode-remote/` 与 `vscode://file/` 前缀；
- authority 构造与 `SSH_HOST_PATTERN` 解耦（§3.2）；sshPort 非 22 确定性拒绝；
- 渲染层经 IPC（open-in 面）传入的 path/instanceId 同样视为不可信
  （主进程统一校验，绝不信任单一来源）；
- 探测零副作用、绝不执行 PATH 中的 `code`（仅文件/可执行位检查）；
- 失败全 loud（对话框/日志/`{error}`），绝不静默假成功；fail-closed 优先
  （探测未知 → 入口隐藏）。
- `runVscodeLaunch` 在 registry/availability/URL 构造/openExternal 全链外设异常边界；
  `describeUnknownError` 对 hostile message getter/Proxy/toString 二次 throw 仍返回稳定
  `unknown error`，公共 Promise 不落 transport rejection。

## 9. 验证门与实机验收

**自动化门**：`test:desktop`（deep-link 纯函数套件：parse / argv 扫描 / authority /
URL 编码 / 恶意输入；队列与 ACK 语义）、`typecheck`、`typecheck:open-in`、
`test:sidebar` 回归、`build:renderer`、`verify:i18n`（无 DRIFTED）。
精确冻结 HEAD 的测试数字与分发证据只见 `docs/progress/STATUS.md`
（设计文档只定义验证门，不登记数字）。

**实机验收（未完成；不能由 Linux 构建替代）**：macOS 深链冷/热启动、打包态协议注册、
N-ctx、local 源、VS Code 缺失、sshPort 非 22、托盘/退出在途、Windows 打包态深链
冷/热启动（design 23 的 real-runner 矩阵）。

## 10. 边界与实施期核实项

- vendor 盒模型（堆叠流与标题栏行高）决定入口的视觉定位——需实机视觉校验 + 对齐
  主题 token；条目需自身 opt-in pointer-events；
- vendor header（ui-conversation / ui-renderer）若提供专用槽 → 可无痛切换到槽内
  方案（插件本体不变）；
- 可用性探测是 coarse proxy（存在性/可执行位），**不覆盖** Insiders / Cursor /
  VSCodium；探测时机 = coordinator attach 时单飞 + getter 每次实探；
- 深链到不存在的路径 → VS Code 自会报错/开空目录；文案明示"不做路径校验"的诚实边界；
- Windows（design 23）：打包态协议注册走无参 `setAsDefaultProtocolClient`（§4.3），
  electron-builder `protocols` 的 Windows 注册表项写入仍属**实证项**（同目标幂等）；
- a11y：aria-label / tooltip / 键盘聚焦（click-through opt-in 条目必须可聚焦）。

**已如实记录的剩余边界（仍然成立）**：

1. `openExternal` resolve ≠ VS Code 真打开（未注册 handler 的平台可能静默 no-op——
   Electron 固有局限，打开成功判定无法在模块内证明）；
2. Linux 打包态无参数 `setAsDefaultProtocolClient` 未经实机协议注册验证；
3. 深链 path 的 `+` 按表单编码解为空格是标准行为；
4. 路径段 `..` 不额外编码（合法路径段，无穿越沙箱/无法逃逸 scheme-host——VS Code 在
   远端解析，核实无绕过面）；
5. 插件以局部桥面结构子集 cast 消费桥（未声明全局 Window 增强——避免与 renderer 桥
   契约的 interface-merging 冲突，属 §7.2 第 7 条的文档化偏离）；
6. 入口 top 偏移（标题栏行高 vendor 决定）与 §9 的全部实机项仍需打包态/人工验证。

## 11. 相关文档

- `docs/design/01-overview.md` §3 文档地图（本文条目）
- `docs/design/05-connection-manager.md` §7（IPC 围栏 / 桌面契约 / 安全不变量）、
  §7.6（provider 抽象先例）
- `docs/design/08-git-worktree-plugin.md` §7（客户端插件锁步接线模板）
- `docs/design/09-client-plugin-runtime-loading.md`（覆盖集 / 模块表机制）
- `docs/design/13-remote-plugin-management.md`（本文**不**使用其远端分发——无 host 面）
- `docs/progress/STATUS.md`（唯一进度记录）
