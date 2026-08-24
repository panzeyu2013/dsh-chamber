# 16 · VS Code 深链插件（deeplink 快速拉起本机 VS Code 打开对应 server 目录）

> **更新（2026-08）**：应用内按钮已演进为 open-in 通用打开注册表（设计 17）——
> 插件重命名 `@dsh-chamber/dsh-client-ui-open-in`，`dsh-chamber:open-vscode`/
> `vscode-availability` 两 IPC 与 `window.dshChamber.vscode` 桥面已随旧插件
> 删除（渲染层唯一入口收敛为 `open-in-apps`/`open-in`）；OS 深链
> `dsh-chamber://open-vscode` 管线**不变**。本文保留为 OS 深链与 vscode 拉起的
> 契约；文中旧 IPC/桥面/包名描述属历史基线，以设计 17 §6 演进表为准。

> **状态：设计定稿并已实现（M0–M2，2026-08）**。经两轮反思 + 一轮独立对抗复核收敛
> （复核发现无 P0；5 项 P1 必改与 P2 边界均已并入本文），实现后另经一轮安全契约
> 审查与一轮前端接线审查（无 P0；必改项均已修复，见 §10.2）。配套进度见
> `docs/progress/STATUS.md`。
>
> 目标：OS 级深链 `dsh-chamber://`（或应用内按钮）快速用**本机 VS Code Remote-SSH**
> 打开**对应 server 实例**上的指定/当前工作区目录。
>
> 形态纪律：**全部功能以新增插件/新模块落地，现有包改动 = 0**（sidebar / layout /
> connections / settings / git 均不动）；**无 host 插件、无 seed**——动作是本地拉起
> VS Code，没有实例内执行面；深链是 OS 级不可信输入，全部校验在主进程完成。

## 1. 目标与非目标

### 目标

- 注册自定义协议 `dsh-chamber://`，macOS `open-url` / Win+Linux `second-instance`
  argv / 冷启动 argv 三类入口统一收进主进程深链核心；
- 深链按 `instance=<id>` 映射注册表 SSH 实例，构造 `vscode://vscode-remote/...`
  经主进程 `shell.openExternal` 打开（或 code CLI argv 形态，v1 以 URL 为准）；
- 应用内按钮（右侧主区顶部标题栏最右、垂直居中）打开**当前来源的当前工作区**；
- **本机 VS Code 可用性探测**：不存在（或未知）→ 按钮不显示（fail-closed）。

### 非目标（明确不做）

- **不做 host 插件 / 不做 seed**：无实例内执行面；与设计 08/13 的远端分发机制无关；
- 不做远端路径存在性校验（VS Code 自会报错，诚实透传；UI 文案明示该边界）；
- 不自动注入非标准 sshPort 的 `~/.ssh/config`（确定性拒绝 + 指引，见 §3.2）；
- 不供给密码认证主机的免密（VS Code 自行弹框；v1 不感知注册表密码存储）；
- 不做 code-server / openvscode-server 网页版（"服务器上的 VS Code" = Remote-SSH）。

## 2. 形态与分层

```text
┌─ 新客户端插件 @dsh-chamber/dsh-client-ui-vscode（编译期打包，设计 08 同款）──┐
│  shell.overlay 条目：主区右上按钮（垂直居中于标题栏行）                        │
│  coordinator 单例：可用性标志（主进程事实，单飞共享）                         │
│  门控：可用性 true ∧ 有当前工作区 path（本地与远程来源均显示，用户决策       │
│  2026-08：local 走 `vscode://file/`、远程走 `ssh-remote+`），否则渲染 null  │
│  当前工作区路径读自身 ctx（chamberInstanceId + sessions/workspaces store）     │
│  零 @dsh-chamber 依赖（仅 peer 依赖 vendor 包）                               │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ IPC（trustedIpc 围栏，只增不改）
┌─ 桌面主进程 deep-link.ts（新模块，纯新增）───────────────────────────────────┐
│  DeepLinkHandler 注册表（scheme → parse → execute，镜像 TransportProvider）  │
│  └ vscode handler：instance 白名单+实查 → authority 构造（§3.2）→            │
│    buildVscodeRemoteUrl（§3.3 编码纪律）→ openExternal（scheme 硬编码）       │
│  detectVscodeAvailability(platform)：纯 fs + PATH 扫描，绝不 spawn（§5）      │
│  main.ts 只接线：顶层 open-url + pendingIntents 队列 + 打包门控协议注册       │
│  + second-instance argv（无深链 argv → 仅 showMainWindow）+ quit guard        │
└─────────────────────────────────────────────────────────────────────────────┘
```

- `packages/renderer` 只把客户端插件静态注册进复合 entry（设计 08 §8 锁步），不拥有
  深链事实/业务 UI；
- `packages/control-plane` 零改动（深链与实例执行无关，不经过实例反代）；
- `packages/desktop` 持有深链核心与可用性探测（宿主能力）；新 IPC 走既有
  `trustedIpc` 围栏（05 §7.4）；
- 与 dsh shell 的联动为 **best-effort**：VS Code 启动由主进程独立完成；深链可附带
  归一化 intent 推送渲染层激活对应来源（`deepLink.onIntent` + App 订阅 +
  `selectView`），窗口未就绪时按 hold/replay 纪律（仿 `lastResume`，main.ts:581），
  shell 激活失败不阻塞 VS Code 启动。

## 3. 深链契约

### 3.1 格式与解析

```
dsh-chamber://open-vscode?instance=<id>&path=<远端绝对路径>
```

- 用 `new URL()` 解析；`hostname` 必须精确等于 `open-vscode`（其余 host 一律拒绝，
  不猜测、不归一化）；
- `instance`：`INSTANCE_ID_PATTERN`（`/^(?!local$)[a-zA-Z0-9_-]{1,64}$/`）+
  注册表实查（`transportManager.listInstances()`），`kind !== 'ssh'` 或查无 →
  确定性拒绝 + loud；**`local` 显式放行**（用户决策 2026-08：走 §3.4 的 local 分支，
  不查注册表）；
- `path`：必须以 `/` 开头（绝对路径），拒绝控制字符 / CR / LF / NUL，长度 ≤ 4096；
  缺失/非法 → loud 错误；
- 幂等/去重：macOS `open-url` 与 argv 可能双触发同一 URL → single-flight 已处理
  集合去重；重复实例引用以首次为准。

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
  （对比 `isAllowedReleaseUrl` 白名单纪律，main.ts:189）；
- path 逐段 `encodeURIComponent`（首 `/` 保留），空格/中文/`#`/`?`/`&`/`%` 均有
  单测覆盖；控制字符在 §3.1 已拒绝；
- 失败路径全部 loud：对话框（VS Code 未装）/ 日志 / `{error}` 返回，绝不静默假成功。

### 3.4 入口一致性

- OS 深链与 IPC `dsh-chamber:open-vscode`（renderer 按钮触发）**共用同一 `execute()`**：
  IPC 只是可信渲染端触发的 intent，同样过注册表实查、authority 构造、可用性校验；
- **local 分支（用户决策 2026-08）**：`instanceId === 'local'` 时 `runVscodeLaunch` 不走
  注册表（local 不在 ssh 注册表），直接 `buildVscodeFileUrl` + 可用性校验 + 打开；
  `instance=local` 的 OS 深链与按钮均支持（§3.1 的 pattern 校验对 `local` 显式放行）；
- OS 深链在 VS Code 不存在时无法"不显示"（协议注册与可用性无关）→ `execute()` loud
  报错；按钮侧则由可用性门控直接隐藏（§6.3）。

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
- `pendingIntents` 在 startup 完成（transportManager 装载 + 主窗口就绪）后统一
  drain；冷启动 argv 在 `whenReady` 内解析（macOS argv 含 `-psn_` 噪声，防御式：
  非深链 argv 零副作用、绝不 throw 打断启动）；
- Win/Linux：`second-instance(event, commandLine, …)` 扫描 argv；**无深链 argv →
  仅 `showMainWindow()`**（现有行为保持；handler 签名变更不可避免，语义不变）；
- `quitRequested` 置位后（before-quit 确认在途 / will-quit 清理）到达的深链直接
  ignore——不启动 VS Code、不重建窗口（不进 05 §7.7 状态机）。

### 4.3 协议注册（打包门控）

- **`app.isPackaged` 门控** `setAsDefaultProtocolClient('dsh-chamber')`（镜像托盘
  先例 main.ts:258）——开发态注册会把裸 Electron 注册成 scheme handler，污染
  LaunchServices，与打包版（bundle id `com.dshchamber.desktop`）冲突；
- 打包态：electron-builder `protocols: [{ schemes: ['dsh-chamber'] }]`（自动生成
  mac `CFBundleURLTypes` / linux desktop `MimeType` / Windows 注册表项）；
- dev 深链测试：`electron-dev.mjs` 支持透传 argv 注入（URL 作为冷启动 argv），
  不依赖真实 OS 协议事件；
- Windows 首版暂缓一致性：win32 门控 `setAsDefaultProtocolClient` + argv 扫描
  （镜像 ssh 密码 askpass 门控 main.ts:1086）；`open-url` 为 mac 专属事件。

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

- IPC `dsh-chamber:vscode-availability`（getter，**每次实探**，无缓存陈旧问题）；
- 主进程启动时无需预探（getter 惰性）；`execute()` 内**二次校验**（防御纵深：
  IPC/深链两条路都过，VS Code 不存在 → loud `{error: 'vscode not detected'}`）；
- 渲染层经 preload `vscode.availability()` 拉取；coordinator 单例单飞共享。

## 6. 客户端插件（@dsh-chamber/dsh-client-ui-vscode）

### 6.1 放置：会话头部 utilities（实机修正 2026-08，替代 shell.overlay）

- **最终实现**：注册进**官方会话头部 utilities 槽**（`conversation.session.header.utilities`，
  与 vendor "Session log" 同一右对齐行）——按钮以普通流式布局排在 session-log 旁边，
  **无绝对定位**，由头部排版自动排列；
- **为何放弃 shell.overlay（实机测量）**：初始实现注册 `shell.overlay`（layout fork 已声明的
  frame-wide 槽，`{kind:'list', scope:'root'}`）并以 `top:12px; right:16px` 锚定 frame 右上角。
  实机测量发现：details 列关闭（默认）时中心列延伸到 frame 右缘，官方会话头部
  （top 0→76）的 utilities 行右对齐于头部右侧——session-log 按钮实测 x=1141→1252，
  而 frame 右上锚点 x=1236→1264，**必然重叠**（重叠区 16px）。frame 右上不存在可靠
  空闲锚点（头部高度/tabs/details 开合均变化），故整个 frame 层方案废弃；
- 槽是 session 作用域：组件直接收到**本头部所属的 `sessionId`** 与框架全局
  `useWorkspaces` 选择器钩子（同一 store，侧边栏归组同源），**不再直接读 ctx 的
  sessions/workspaces**（inject 声明保持 `['slots','locale']`）；
- 按钮 CSS：行内 32×32 图标按钮（透明底、hover 主题 tint、focus 环），与头部工具行
  对齐；aria-label / tooltip / 键盘可聚焦保持；
- **行内排序（用户要求 2026-08）**：条目注册带 `order: -1`——utilities 行按 `order`
  升序排列（默认 0），因此 vscode 按钮排在 "Session log"（order 0）**左侧**，
  session-log 保持在最右侧；
- **图标（用户修正 2026-08）**：按钮图标改为**官方产品图标资源**——从安装的
  `Visual Studio Code.app` 的 `Code.icns` 提取 32px@2x PNG（`vscode-icon.png`，
  vite 内联为 data URL），替代初始的手绘旧版 SVG path（旧版为 2022 年前的角形
  logo，与本机当前图标不一致）；
- **实施第 0 步（P1-5，已按原方案验证 ✅ 2026-08，后被实机放置测量推翻）**：vendor
  `dsh-client-ui-layout/src/client/AppFrame.tsx` 实证渲染 `shell.overlay`
  （`<div className={overlayLayer} data-shell-overlay>{renderSlot('shell.overlay', {})}</div>`，
  层 `position:absolute; inset:0; z-index:20`，`.overlayLayer > * { pointer-events: auto }`）——
  该槽保留在 layout fork 中（零占用），未来 frame 级徽标/浮层仍可复用。

### 6.2 coordinator（单例，git 插件同款模式）

- 模块级单例：`attach()` 首/末 retain 拥有唯一订阅与探测；
- **可用性标志**（主进程事实）：单飞拉取一次，跨 N-ctx 共享；
- **当前工作区路径读自身 ctx**（P2-1 简化）：`ctx.chamberInstanceId` +
  ctx 的 sessions/workspaces store（照 sidebar 同款方式），**不走 chamberBridge
  跨 ctx join**——新包因此零 @dsh-chamber 依赖（仅 peer 依赖 vendor 包）。

### 6.3 三进门控（任一不满足 → 渲染 null，不显示）

1. `vscode.availability() === true`（false / 探测失败 / IPC 异常 → 隐藏，
   fail-closed）；
2. `chamberInstanceId` 的当前会话属于有路径的工作区（**本地与远程来源都显示**——
   用户决策 2026-08：local 源的工作区路径在本机，走 `vscode://file/<path>` 打开本地
   文件夹；远程源走 `ssh-remote+`；§3.4 的 local 分支）；
3. 存在当前工作区 path（空白新会话/无工作区 → 隐藏）。

### 6.4 交互

- 点击 → `dsh-chamber:open-vscode` IPC `{instanceId, path}`（主进程二次校验）；
- 无当前工作区时按钮不显示（不是禁用——避免悬停暗示不可用动作）；
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

### 7.2 客户端插件锁步（10 处，设计 08 §8 + chamber-entry 头注）

1. `chamber-entry.ts` 静态 `import * as UiVscode from '.../client'`（首屏）；
2. `chamber-entry.ts` apply() `ctx.plugin(UiVscode)`；
3. `chamber-entry.ts` `COVERED_FACTORIES` 加
   `['@dsh-chamber/dsh-client-ui-vscode', coveredFactory(UiVscode)]`；
4. `chamber-covered.ts` `CHAMBER_COVERED_IDS` 加 id；
5. `chamber-covered.ts` `CHAMBER_COVERED_FACTORY_IDS` 加 id
   （三向锁步由 `assertCoveredFactoryLockstep` + CI host-graph.test.ts 强制）；
6. `vite.config.mjs` alias 三行（`/`、`/client`、`/shared`）；
7. 新包 `package.json`（`dsh.client` 声明 inject `['slots','locale']`）+ `tsconfig.json`
   + `vendor-modules.d.ts` ambient 面 + `window.dshChamber.vscode/deepLink` ambient
   镜像（参照 connections `global.d.ts` 模式）；
8. 根 `package.json` 增 `typecheck:vscode`（参照 `typecheck:git`）；
9. `.github/workflows/ci.yml` typecheck 块增 `typecheck:vscode`（逐条列出）；
10. `locales.ts` zh/en + `LocaleNamespaceMap` 声明（手动锁步——**`verify:i18n` 只
    校验 docs 双语对，不覆盖插件词典**，勿声称其为门）。

### 7.3 desktop 接线

- `packages/desktop/deep-link.ts` **进 electron-builder `files`**（打包态主进程 TS
  源码逐文件列出；漏加 → 打包版 import 404 而 dev 正常）；
- `deep-link.ts` + `deep-link.test.ts` 进根 `tsconfig.json` `include`（逐文件列出；
  **勿复刻** `chamber-settings.test.ts`/`plugin-sync.test.ts` 漏加反例）；
- `test:desktop` 脚本加 `deep-link.test.ts`；
- `preload.cts` 加 `vscode.availability()` + `deepLink.onIntent()` 面
  （`build:preload` 自动编译）；
- main.ts 接线（§4.2/§4.3）；
- electron-builder `protocols` 键；
- release.yml 版本断言：**无需并入**（断言集只含 host 包：root/desktop/
  control-plane/renderer/cli/dsh-host-client-graph/dsh-host-git-worktree；git client
  插件亦不在集内）——新包独立 version 字段即可。

## 8. 安全不变量

- 深链是 OS 级不可信输入：instance 过白名单 + 注册表实查（`local` 走独立分支）；
  path 过 §3.1/§3.3 编码纪律（local 分支同款：绝对路径、无控制字符、逐段编码）；
  scheme 硬编码 `vscode:`；`openExternal` 仅主进程且注入点复验
  `vscode://vscode-remote/` 与 `vscode://file/` 前缀；
- authority 构造与 `SSH_HOST_PATTERN` 解耦（§3.2）；sshPort 非 22 确定性拒绝；
- 渲染层经 IPC 传入的 path 同样视为不可信（主进程统一校验，绝不信任单一来源）；
- 探测零副作用、绝不执行 PATH 中的 `code`（仅文件/可执行位检查）；
- 失败全 loud（对话框/日志/`{error}`），绝不静默假成功；fail-closed 优先
  （探测未知 → 按钮隐藏）。

## 9. 分期（里程碑）

| 里程碑 | 纵向闭环 |
|---|---|
| M0 | `deep-link.ts` 深链核心 + `detectVscodeAvailability` + 两个 IPC handler + `deep-link.test.ts`（纯函数套件：parse/argv 扫描/authority/URL 编码/恶意输入） |
| M1 | 生命周期接线：顶层 `open-url` + pendingIntents + 打包门控协议注册 + electron-builder `protocols` + dev argv 注入测试 + win32 门控 |
| M2 | 客户端插件：`shell.overlay` 按钮 + coordinator + 三进门控 + 五处锁步（10 项）全部接线 + i18n |
| M3 | 验证门全绿（test:desktop / typecheck:vscode / test:sidebar 回归 / build:renderer / verify:i18n）+ 实机验收（macOS 深链冷/热启动、打包态、N-ctx、local 源、VS Code 缺失、sshPort 非 22、托盘/退出在途） |

## 10. 边界与验证（P2 记录，实施期核实项）

- **实施第 0 步**：vendor AppFrame 渲染 `shell.overlay` 实证（§6.1）；若否 → 与用户
  确认 fallback 放置（settings.section）后再继续；
- 按钮自定位依赖 vendor 盒模型（全 frame 定位 vs 堆叠流、标题栏行高均 vendor
  决定）——实机视觉校验 + 对齐主题 token；entry 需自身 opt-in pointer-events；
- vendor header（ui-conversation / ui-renderer）若存在专用槽 → 可无痛切换到槽内
  方案（插件本体不变）；
- 可用性探测为 coarse proxy（存在性/可执行位），文档明示不覆盖 Insiders/Cursor/
  VSCodium；探测时机 = coordinator attach 时单飞 + getter 每次实探；
- 深链到不存在路径 → VS Code 自会报错/开空目录，文案明示"不做路径校验"诚实边界；
- Windows 首版暂缓；dev/打包协议注册差异（§4.3）；
- a11y：aria-label / tooltip / 键盘聚焦（click-through opt-in 条目必须可聚焦）。

### 10.2 实现后审查记录（2026-08，两轮独立审查 + 修复）

- **安全契约审查**（无 P0）：P1 两必改已修复——① 按钮侧视图 id（`ssh-<id>`）→ 裸注册表
  id 的映射（此前按钮传 `ssh-<id>`，主进程按裸 id 实查恒不命中，M2 核心功能不可用）；
  ② `detectVscodeAvailability` 的 X_OK 判定补 `isFile()`（POSIX 目录带执行位会被误判为
  可执行 `code`），Windows `Code.exe` 分支同补。P2 已修：parse 拒绝 userinfo/port、
  `runVscodeLaunch` 对 IPC 侧 instanceId 对称补 `INSTANCE_ID_PATTERN` 校验、主进程
  `openVscodeUrl` 注入点 scheme 复验（`vscode://vscode-remote/` 前缀）、drain async IIFE
  补 `.catch`、去重注释与实现语义对齐。
- **前端接线审查**（无 P0）：P1 已修——coordinator 单飞 promise 在桥未就绪时不固化
  （复位可重试，镜像 App.tsx 的桥就绪守卫），按钮侧有界轮询桥就绪后再探测。P2 已修：
  `/shared` barrel 补齐、`open()` 补 `.catch`、`chamberInstanceId` 缺失时 bail 不注册、
  删除未用 `ui-primitives` peer、`:focus-visible` 焦点环。
- **验收执行**：构建产物（control-plane / preload / chamber bundle / manifest 单 entry）
  与自动化门（test:desktop 263 用例含 deep-link 43、typecheck、typecheck:vscode、
  build:renderer、verify:i18n、frozen-lockfile）全绿；dev:desktop 有界冒烟受本会话沙箱
  限制（Chromium 沙箱无法初始化）未整窗 boot，控制面/主进程启动日志正常、缺 dsh CLI 的
  本地实例错误态非致命。
- **如实记录的剩余边界**：① `openExternal` resolve ≠ VS Code 真打开（未注册 handler 的
  平台可能静默 no-op——Electron 固有局限，打开成功判定无法在模块内证明）；② Linux
  打包态 `setAsDefaultProtocolClient` 的 relaunch args 未经实机验证；③ 深链 path 的
  `+` 按表单编码解为空格为标准行为；④ 路径段 `..` 不额外编码（合法路径段，无穿越
  沙箱/无法逃逸 scheme-host——VS Code 在远端解析，终审核实无绕过面）；⑤ 插件以局部 `VscodeBridgeSurface` 结构子集 cast
  消费桥（未声明全局 Window 增强——避免与 renderer 桥契约的 interface-merging 冲突，
  属 §7.2 第 7 条的文档化偏离）；⑥ 按钮 top 偏移（标题栏行高 vendor 决定）与 macOS
  深链冷/热启动、打包态协议注册、N-ctx 实机显示、托盘/退出在途等仍需打包态/人工实机
  验证。

## 11. 相关文档

- `docs/design/01-overview.md` §3 文档地图（本文条目）
- `docs/design/05-connection-manager.md` §7（IPC 围栏 / 桌面契约 / 安全不变量）、
  §7.6（provider 抽象先例）
- `docs/design/08-git-worktree-plugin.md` §8（客户端插件锁步接线模板）
- `docs/design/09-client-plugin-runtime-loading.md`（覆盖集 / 模块表机制）
- `docs/design/13-remote-plugin-management.md`（本文**不**使用其远端分发——无 host 面）
- `docs/progress/STATUS.md`（唯一进度记录）
