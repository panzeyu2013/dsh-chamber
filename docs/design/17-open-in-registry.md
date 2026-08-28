# 17 · open-in 打开注册表（Finder 本地 + VS Code 本地/远程的统一打开面）

> **状态：设计定稿；M0–M2 已实现，M3 自动化覆盖与最终 HEAD 复验已完成；
> macOS 实机验收仍未完成（2026-08，见 §8/§9）。** 本文是设计 16
> （VS Code 深链）的同族演进：把"会话头部 utilities 行的 vscode 按钮"升级为
> **通用打开注册表**——每个"拉起方式"一个 provider，本地来源（`chamberInstanceId
> === 'local'`）可打开 Finder（文件管理器），vscode 成为其中一个 provider（本地
> `vscode://file/`、远程 `ssh-remote+`，行为零变化）。参考 openchamber 的
> open-in-app 体系（`openInApps.ts` + `useOpenInAppsStore.ts` + `OpenInAppButton.tsx`
> + electron `desktop_open_path`/`desktop_reveal_path`）：取其"finder 常驻、
> 平台化命名、目录 → 打开文件管理器"语义，去其应用扫描/图标抓取/选择器重机制。
>
> 实现后曾经 **五路对抗复核**（安全契约 / 前端接线 / 测试质量 / 打包分发 / 集成
> 等价，无 P0）与两轮修复。本轮全面契约复核又发现并修复/收敛新的边界；最终 HEAD
> 的精确验证记录统一写在 `docs/progress/STATUS.md`。实机验收仍未完成（见 §8/§9）。

## 1. 目标与非目标

### 目标

- **本地环境识别**：`sourceId === 'local'` 时可用 app 集 = [finder, vscode]
  （≥2 → 图标按钮 + chevron 下拉选择）；远程来源（`ssh-<id>`）仅 vscode
  （`remoteCapable` 过滤，行为与 design 16 完全一致）；
- **注册表抽象**：主进程 `OpenInApp` provider 接口（id / displayKind /
  remoteCapable / available / open）；v1 注册表固定为 finder/vscode。新增 app 的
  执行与能力协商只增 provider，既有桥面/IPC 形状可不变；客户端按稳定的
  `displayKind`（`vscode` / `file-manager`）选择专用文案/图标，未知 kind 使用中性
  app 呈现，不会被误标为 Finder；
- **能力协商**：`apps()` 一次 IPC 返回全集
  `{id, displayKind, remoteCapable, available}`，客户端逐项校验并按来源过滤；
  可用性主进程实探（纯 fs/PATH，绝不 spawn）；
- **统一执行管线**：appId 白名单 → instanceId 校验 → path 校验 → remoteCapable
  门 → 可用性二次校验 → 分发；失败全 loud，绝不静默假成功；
- **平台文案**：Finder（macOS）/ 资源管理器（Windows）/ 文件管理器（Linux），
  经 `dsh-chamber:info` 新增的非秘密 `platform` 字段驱动。

### 非目标（明确不做）

- 不做 openchamber 式**应用扫描/图标抓取/选择器持久化**（v1 只有两个固定入口；
  扫描+图标管线重且与 remote 无关）；
- 不做 OS 深链 `dsh-chamber://open-finder`（Finder 按钮在应用内，无 OS 级诉求；
  deep-link handler 注册表已支持未来增补）；
- 不做 copy-path / 在终端打开 / 更多 app（P2 候选，见 §9）。

## 2. 形态与分层

```text
┌─ 客户端插件 @dsh-chamber/dsh-client-ui-open-in（自 ui-vscode 重命名扩展）──┐
│  单条目 open-in（order -1，会话头部 utilities 槽）→ OpenInButton           │
│    apps = openIn.apps() 按来源过滤（本地：[finder, vscode]；远程：仅        │
│    remoteCapable）；≥2 → 主图标按钮（默认 vscode）+ chevron 下拉            │
│    （chamber-owned ARIA menu，body portal）；=1 → 纯图标按钮               │
│    门控：桥就绪 ∧ 可用集非空 ∧ 工作区有路径（fail-closed）                  │
│    下拉打开时 refreshApps() 重探（会话中途装/卸 app 可见）                  │
│    平台文案：bridgePlatform() → Finder/资源管理器/文件管理器               │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ IPC ×2（trustedIpc 围栏）
┌─ 桌面主进程 packages/desktop/open-in.ts（electron-free 核心）──────────────┐
│  OpenInApp 注册表 [finder, vscode]（固定序，镜像 transport-provider 的      │
│    "新来源 = 新 provider" 哲学）                                           │
│  ├ finder：remoteCapable=false；available 恒 true（OS 常驻）；仅 local      │
│  │         → validateRemotePath → stat → 非 macOS 目录 shell.openPath；     │
│  │           macOS 所有目录/所有平台文件走 showItemInFolder（只 reveal）  │
│  └ vscode：remoteCapable=true；available=ctx.vscodeAvailable（注入可测）    │
│            open=runVscodeLaunch（零行为变化，深链管线原样复用）             │
│  runOpenInLaunch 六步 loud 管线 + normalizeOpenPathError（shell 边界纯函数）│
│  main.ts：info 载荷 +platform；open-in-apps / open-in 两 IPC（含载荷形状     │
│    守卫；vscode 成功时保留 deep-link-intent 推送）                          │
└────────────────────────────────────────────────────────────────────────────┘
```

- 无 host 插件、无 seed、无控制面改动——动作是本机拉起，没有实例内执行面
  （design 16 同款形态纪律）；
- `deep-link.ts` 的 URI 构造/执行管线继续由 vscode provider 复用；共享的 path
  校验、异常描述器、有界 intent 队列同样保持 electron-free、可独立单测。

## 3. 契约

### 3.1 IPC（trustedIpc 围栏，替代 design 16 的两通道）

```
dsh-chamber:open-in-apps  ()                        → { apps: [{id, displayKind, remoteCapable, available}] }
dsh-chamber:open-in       {appId, instanceId, path, sourceFingerprint} → { ok: true } | { ok: false, error }
```

- **design 16 的 `dsh-chamber:vscode-availability` / `dsh-chamber:open-vscode`
  两 IPC 已删除**（随旧插件一起退役；渲染层唯一入口收敛为 open-in 两通道）；
- 载荷形状守卫：`appId/instanceId/path/sourceFingerprint` 非 string → 统一 loud
  `invalid open-in payload`（不落 transport rejection）；
- `sourceFingerprint` 是主进程随权威 roster 投影的非秘密 opaque 来源代 proof：local
  固定为 `local`，远程为 64 位小写十六进制；只存在于主进程内存 sidecar，删除后同 id
  重建也会换 proof，renderer 不得从 host/user/port 等字段自行推导；
- vscode provider 成功后的 renderer 激活不是 `send()` 即消费：push 载荷为
  `{instanceId,path,sourceFingerprint,deliveryId,attempt}`；主进程保留未 ACK delivery，
  reload/crash 后重发，renderer 完成路由或按权威 roster/proof 有意丢弃后才精确 ACK。
  `attempt` 隔离旧 document ACK，proof 隔离同 id replacement；Finder 不产生该 intent；
- provider 可用性探测抛错时，能力协商将该 app 标为 unavailable、逐项 loud 记录
  provider id 与安全错误描述（其余 app 仍返回）；执行期探测/宿主适配器抛错则统一转成 `{ok:false,error}`，不落
  transport rejection；
- 渲染层传入值一律不可信（与 design 16 §8 同款纪律）。

### 3.2 桥面（preload + renderer global.d.ts）

```ts
openIn: {
  apps(): Promise<Array<{ id: string; displayKind: string; remoteCapable: boolean; available: boolean }>>
  open(appId: string, instanceId: string, path: string, sourceFingerprint: string): Promise<{ ok: true } | { ok: false; error: string }>
}
platform: string | null   // 顶层，process.platform，非秘密（dsh-chamber:info 载荷新增）
```

- preload 的 `apps()` **解包 `{apps}` 信封**返回裸数组（声明即运行时形状）；
- 插件以局部 `OpenInBridgeSurface` 结构子集 cast 消费（design 16 §10.2-⑤ 同款
  文档化偏离，不声明全局 Window 增强）。

## 4. 主进程核心（open-in.ts）

### 4.1 Provider 接口

```ts
interface OpenInApp {
  id: string                          // 'vscode' | 'finder' | …
  displayKind: string                 // 'vscode' | 'file-manager' | future neutral kind
  remoteCapable: boolean              // 能否打开远程实例路径（仅 vscode 家族 true）
  available(ctx: OpenInLaunchContext): boolean
  //   纯探测；协商/执行统一传同一个注入 ctx，dispatcher 不按 provider id 特判
  open(req: { instanceId: string; path: string }, ctx: OpenInLaunchContext): Promise<OpenInResult>
}
```

`OpenInLaunchContext`（main.ts 组装，模块 electron-free 可单测）：
`lookupInstance`（注册表实查）/ `vscodeAvailable` / `openVscodeUrl`（scheme
复验封装）/ `stat`（fs 包装）/ `openPath`（shell 包装 + normalizeOpenPathError）/
`showItemInFolder`。

`apps()` 也把同一 `OpenInLaunchContext` 逐项传给 provider 的 `available`；协商器不
检查 `id === 'vscode'`，因此新增 provider 只需在自身实现探测，单项抛错仅令该项
`available=false` 并经注入 reporter loud 记录，不抹掉合法 sibling；reporter 自身异常
也不能抹掉完整能力列表。

### 4.2 runOpenInLaunch 六步 loud 管线

1. **appId 白名单**：`getOpenInApp` 未命中（含非 string）→ `unknown open-in app`；
2. **instanceId 校验**：`'local'` 或 `INSTANCE_ID_PATTERN`（镜像 runVscodeLaunch
   对称门）；
3. **path 校验上移管线**：`validateRemotePath`（绝对/无控制字符/≤4096，复用
   deep-link.ts 共享函数）——未来 provider 不可能把未校验字符串交给宿主包装；
4. **remoteCapable 门**：非 local 实例 + 非远程能力 app → 拒绝（远程路径绝不
   进入本地文件系统面）；provider 内复查为无害冗余（防御纵深）；
5. **可用性二次校验**：`app.available(ctx)`（vscode 走 `ctx.vscodeAvailable()`，
   与 apps() 协商同源，**任意机器可测**）；
6. **分发** `app.open({instanceId, path: 已验证}, ctx)`。

步骤 5/6 均有异常边界：provider 或注入的宿主适配器即使 throw/reject，也只会
得到带 app id 的 loud `OpenInResult`，不会击穿 trustedIpc 成为 transport rejection。

### 4.3 Providers

- **finder**：`remoteCapable:false`、恒可用；`instanceId !== 'local'` → 拒绝；
  stat 仅将 `ENOENT`/`ENOTDIR` 分类为不存在 → `path does not exist`；`EACCES`/I/O/
  hostile failure 继续抛给 provider 外层并结构化为 loud `{ok:false,error}`，绝不冒充路径缺失；非 macOS 目录 → `openPath`（错误串 →
  `open path failed`，主进程包装只返回原始宿主错误，避免重复前缀）；文件以及
  **macOS 的所有目录（含指向目录的 symlink）** → `showItemInFolder`。LaunchServices
  可按任意已注册扩展/package bit 把目录当 package，故 Darwin 不用不可完备的后缀
  黑名单、绝不把任何目录交给 `openPath`；同步异常可结构化，Electron void 完成态
  限制见 §9；
- **vscode**：`available: (ctx) => ctx.vscodeAvailable()`；open 直通
  `runVscodeLaunch`（注册表实查 + authority 构造 + scheme 复验，零行为变化）。

### 4.4 normalizeOpenPathError

Electron `shell.openPath` 成功返回 `''`、失败返回错误串——提取为纯函数
（`''`/非 string → null，非空串 → 原样）使该边界可单测。

## 5. 客户端插件（@dsh-chamber/dsh-client-ui-open-in）

- 包自 `dsh-chamber-client-ui-vscode` **重命名**（锁步 10 项按 design 16 §7.2
  模板：chamber-entry import/plugin/coveredFactory、chamber-covered ×2、vite
  alias ×3、vendor-modules 声明、根脚本 `typecheck:open-in`、ci.yml）；
- `sourceId` 与来源 proof 来自该 `AppWebEntry` 的私有 cordis Context：shell.ts 经
  `configureContext` 闭包注入
  `chamberInstanceId/chamberBasePath/chamberSourceFingerprint`，chamber-entry
  显式用后者配置 ConnectionPlugin；open-in 只读本 ctx 的 `chamberInstanceId`，
  不使用已删除的页面级 `chamber-knob.ts`/`window.__DSH_BASE_PATH__` boot 写入，
  N-ctx 交错 boot 不会串源；
- `OpenInButton` 三进门控（任一不满足 → 渲染 null）：① 桥就绪（有界轮询
  ≤40×500ms）且 `apps()` 过滤后非空（`available` 硬过滤 + 远程仅
  `remoteCapable`）；② 工作区有路径（useWorkspaces 按 sessionId）；③ hooks
  无条件先执行；
- 交互：1 个 app → 纯图标按钮；≥2 → 主图标按钮（默认 `displayKind=vscode`
  否则首个，本次挂载内记忆）+ chevron + chamber-owned `AccessibleAppMenu`
  （body portal、焦点转移、roving tabindex、ArrowUp/Down/Home/End、Escape 回
  trigger、Tab/Shift+Tab 显式回到 trigger 原 DOM 顺序的相邻焦点、
  `menuitemradio`/`aria-checked`）；portal 绑定所属 `.instance-view` 生命周期，来源被
  程序化切换/隐藏/卸载时同步变为不可见且 inert，再关闭并阻止旧来源 launch；chevron **打开即显示 +
  后台 `refreshApps()` 重探**（toggle 关闭；协调器 epoch 防抖，会话中途装/卸
  app 无需刷新页面）；
- 来源：只接受精确 `local` 或 `ssh-<INSTANCE_ID_PATTERN>`，并显式拒绝
  `ssh-local`/空/越界/非法字符；解析成功后才调用
  `openIn.open(appId, instanceId, path, sourceFingerprint)`。proof 来自本 entry
  Context 私有注入的 `chamberSourceFingerprint`，失败 loud `console.error`
  （`openFailed` 前缀）+ `.catch` 兜底；
- 图标：vscode = 官方图标资源（`vscode-icon.png`）；finder = 中性文件夹 SVG
  （design token 着色）；slot 条目 `label` 用中性文案（该 label 是 vendor 槽的
  诊断标识，非用户可见；用户可见 tooltip/aria-label 由组件按 app 提供）；
- 协调器：`getApps()` 单飞 + 桥未就绪不固化可重试 + 真实结果 memoized +
  fail-closed；首次真实 `apps()` IPC reject 在**同一 page-wide flight** 内最多 3 次、
  每次间隔 500ms，成功或第三次耗尽才 memoize（耗尽仍为 null，按钮隐藏，绝不无限
  重试）；一次新 probe/`refreshApps()` 发现桥缺失时清除旧 capability（不会声称在无
  probe 的情况下主动侦测桥消失）；每个 IPC 条目严格校验，坏条目不抹掉合法 sibling；
  `refreshApps()` 绕过 memo 强制重探，probe epoch 阻止被取代的旧 flight 迟到覆盖新结果。

## 6. 与 design 16 的关系（演进记录）

| 维度 | design 16（历史基线） | design 17（现状） |
|---|---|---|
| 插件 | `@dsh-chamber/dsh-client-ui-vscode` | `@dsh-chamber/dsh-client-ui-open-in`（重命名） |
| 按钮 | 单 vscode 图标按钮 | 单 `open-in` 条目；本地 [finder, vscode] 下拉 / 远程单 vscode |
| 桥面 | `vscode.availability()/open()` | `openIn.apps()/open()` + `platform` |
| IPC | `vscode-availability` / `open-vscode` | `open-in-apps` / `open-in`（旧两通道已删除） |
| 执行管线 | `runVscodeLaunch`（单 app） | `runOpenInLaunch` 注册表六步管线（vscode provider 包装前者） |
| 深链 | `dsh-chamber://open-vscode` OS 级 | **不变**（OS 级只有 vscode 有 URL 语义，深链管线原样） |
| intent 推送 | open-vscode 成功后推送 | open-in 对 vscode 成功时保留推送（与 OS 深链对齐；finder 不推送） |

design 16 文档保留为 OS 深链与 vscode 拉起的契约（§3.4/§5.2/§6.4 中的旧 IPC
与桥面描述属历史基线，以本文为准）。

## 7. 安全不变量

- appId 精确白名单（不猜测、不归一化）；注册表数组与 provider 运行时冻结；
- instanceId 门与 `runVscodeLaunch` 对称；`ssh-<id>` 视图 id 直呼被双层吸收
  （finder 走 remoteCapable 门拒绝 / vscode 走注册表实查 → `instance not found`）；
- remoteCapable 双层（管线门 + provider 复查）；远程路径绝不进入本地文件系统面；
- path 校验 + stat 在主进程完成；只调 `shell.openPath`/
  `showItemInFolder`/`openVscodeUrl`（scheme 复验封装）；macOS 所有目录一律只
  reveal、不执行；绝不 `shell.openExternal` 裸调用；
- `platform` 为非秘密元数据；失败全 loud；桥面缺失 fail-closed；
- 来源/basePath 由每个 `AppWebEntry` 的 Context 私有注入；不以页面级可变全局值
  决定当前 N-ctx，避免交错 boot 把远端路径路由到错误来源；shell 在任何 graph/module
  副作用前只接受 `local` 或严格 `ssh-<INSTANCE_ID_PATTERN>`，注册前同时检查取消阈值
  与当前 generation；相同 id 后继还必须等前代 boot settle 与异步 dispose 完成，不能
  让两代同时占用同一容器；
- `sourceFingerprint` 在主进程 IPC 入口先与当前来源代精确匹配；执行上下文的实例查找、
  VS Code 异步启动前后及最终 intent 入队前继续复验同一 ownership token。来源删除或
  传输身份编辑一旦退役，旧 ctx 中仍可见的按钮只能 loud 失败，不能操作同 id replacement；
- 探测零副作用（纯 fs/PATH，绝不 spawn）。

## 8. 验证门（M3）

> 里程碑（M0–M3）：M0 主进程核心（open-in.ts + 用例套件）→ M1 IPC/桥面/info
> platform → M2 插件重命名 + 下拉 UI + 锁步接线 → M3 验证门全绿 + 实机验收。
> 与 design 16 §9 同款分期口径。

- `test:desktop` 的 open-in/deep-link/renderer-trust 套件覆盖六步管线、精确 vscode URL、
  门失败副作用 spy、path 非 string/空串、`normalizeOpenPathError` 四态、stat 缺失与
  权限错误分类、hostile thrown value、来源 proof 生命周期及异步 ownership fence；
  可用性由 ctx 注入，测试结果不依赖执行机器是否安装 VS Code；
- 全部插件 typecheck（open-in + sidebar/layout/connections/settings-bridge/git
  + client-web/connection + host-graph/host-git）、根 tsc、`build:renderer`、
  `test:renderer-shell`（含 shell 来源代生命周期）、
  `verify:i18n`、`pnpm install --frozen-lockfile`（锁文件 = HEAD + 仅 importer
  重命名与 primitives peer 的最小 diff）；
- `test:open-in`：独立覆盖 capability 逐项校验、`ssh-local`/非法来源与非法 proof 拒绝、
  协调器 single-flight/epoch/桥消失清理、首次 IPC reject 后有界恢复与三次耗尽
  fail-closed，以及菜单 40 次 bridge-hydration 轮询所依赖的纯键盘状态机；生产
  `build:renderer` 覆盖 owned menu 的 React/portal 接线；
- **五路对抗复核（2026-08，无 P0）**：修复 P1×3（测试机器依赖、AGENTS.md 行号
  前缀事故、锁文件再生漂移还原）+ P2×7（孤儿 IPC 删除、path 上移、载荷形状守卫、
  openPath 边界提取、URL 断言强化、门失败 spy、folder hover）。
- **2026-08-28 第一轮合并前复核（历史）**：补齐普通 `Error` 形态的 provider/宿主适配器
  异常边界、修正 Electron
  `openPath` reject 的重复错误前缀、菜单用 `selectedId` 标出当前默认 app，并拒绝
  空 sourceId；后续补 hostile-error/registry 回归。Linux 同平台完整分发构建通过；
  `dist:desktop:mac` 在 Linux 上按平台保护拒绝 `linux-x64` 内嵌运行时，macOS dmg/zip
  仍须按 DEVELOPMENT 的宿主要求在 macOS（release CI: macos-latest）验证。
- **2026-08-28 全面契约复核（当前轮）**：根模块所有权/05 架构清单已补登记；
  错误描述器可抵御 getter/toString 二次 throw；capability 增 `displayKind` 并对未知
  provider 中性呈现；来源/能力项/open 结果严格校验；owned ARIA menu 补齐键盘与
  焦点语义；bridge hydration 轮询严格 40 次；真实 app probe 增最多 3 次尝试、
  相邻尝试间隔 500ms 的有界恢复；主进程 capability provider probe 失败逐项 loud，
  Finder stat 只把 ENOENT/ENOTDIR 视作缺失；
  N-ctx 改为 per-entry Context 私有事实并以 same-id boot tail/async teardown 隔离；
  shell 对 boot/run 与 session runtimeCtx/list/open 的 hostile thrown value 也会
  loud 收敛并 settle，不会悬挂 Promise；最终再补 opaque proof、retiredIds 与异步
  ownership fence，旧 ctx 不能把动作或激活路由到同 id replacement。自动化/Linux
  构建仍不能代证 macOS 实机 M3；最终 HEAD 的测试数量与分发证据只见 STATUS。

## 9. 已知边界与实机验收

- **Windows 盘符路径**：`validateRemotePath` 要求 `/` 开头（POSIX 口径），win32
  上 finder/vscode-file loud 失败——"Windows 首版暂缓"口径一致，非回归；
- **`showItemInFolder` 为 Electron void API**：同步 throw 已被执行管线归一为 loud
  结果，但 API 不提供 reveal 完成/失败回执；非 macOS 目录的 `openPath` 有完整错误串；
  Darwin 上任意注册扩展/package bit 都可能改变目录的 LaunchServices 分类，因此所有
  目录统一采用 reveal 的 void 边界，不维护不可完备的后缀黑名单；
- **apps 会话内记忆化**：协调器 memo 真实结果，会话中途装/卸 app 需打开下拉
  （refreshApps 重探）或刷新页面才反映；点击时主进程活体复检兜底（loud）；
- **实机验收剩余**：macOS Finder/vscode:// 实际拉起、按钮+下拉在 vendor 头部
  utilities 行的定位/层叠（"Session log 同槽"为描述性主张）、N-ctx 混合渲染、
  OS 深链冷/热启动与打包态回归。

## 10. 相关文档

- `docs/design/01-overview.md` §3（文档地图，本文条目 17）
- `docs/design/16-vscode-deeplink.md`（母设计：OS 深链 + 槽位/门控/IPC 纪律；
  本文的 vscode provider 与其共享管线）
- `docs/design/05-connection-manager.md` §7（trustedIpc 围栏 / 安全不变量）
- `docs/design/08-git-worktree-plugin.md` §8（客户端插件锁步模板）
- openchamber 参考：`packages/ui/src/lib/openInApps.ts`、
  `packages/ui/src/components/desktop/OpenInAppButton.tsx`、electron
  `desktop_open_path`/`desktop_reveal_path`
- `docs/progress/STATUS.md`（唯一进度记录）
