# 17 · open-in 打开注册表（Finder 本地 + VS Code 本地/远程的统一打开面）

> **状态：设计定稿并已实现（M0–M3 全部落地，2026-08）。** 本文是设计 16
> （VS Code 深链）的同族演进：把"会话头部 utilities 行的 vscode 按钮"升级为
> **通用打开注册表**——每个"拉起方式"一个 provider，本地来源（`chamberInstanceId
> === 'local'`）可打开 Finder（文件管理器），vscode 成为其中一个 provider（本地
> `vscode://file/`、远程 `ssh-remote+`，行为零变化）。参考 openchamber 的
> open-in-app 体系（`openInApps.ts` + `useOpenInAppsStore.ts` + `OpenInAppButton.tsx`
> + electron `desktop_open_path`/`desktop_reveal_path`）：取其"finder 常驻、
> 平台化命名、目录 → 打开文件管理器"语义，去其应用扫描/图标抓取/选择器重机制。
>
> 实现后经 **五路对抗复核**（安全契约 / 前端接线 / 测试质量 / 打包分发 / 集成
> 等价，无 P0）与两轮修复，验证门全绿（test:desktop 287 用例、全部插件
> typecheck、build:renderer、test:renderer-shell、verify:i18n、frozen-lockfile）。
> 剩余仅实机验收项（见 §9）。

## 1. 目标与非目标

### 目标

- **本地环境识别**：`sourceId === 'local'` 时可用 app 集 = [finder, vscode]
  （≥2 → 图标按钮 + chevron 下拉选择）；远程来源（`ssh-<id>`）仅 vscode
  （`remoteCapable` 过滤，行为与 design 16 完全一致）；
- **注册表抽象**：主进程 `OpenInApp` provider 接口（id / remoteCapable /
  available / open），新 app（terminal 等）= 新增一个 provider，桥面/IPC/客户端
  零改动；
- **能力协商**：`apps()` 一次 IPC 返回全集 `{id, remoteCapable, available}`，
  客户端按来源过滤；可用性主进程实探（纯 fs/PATH，绝不 spawn）；
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
│    remoteCapable）；≥2 → 主图标按钮（默认 vscode）+ chevron 下拉（Menu      │
│    原语，portal）；=1 → 纯图标按钮（远程行为与旧版一致）                    │
│    门控：桥就绪 ∧ 可用集非空 ∧ 工作区有路径（fail-closed）                  │
│    下拉打开时 refreshApps() 重探（会话中途装/卸 app 可见）                  │
│    平台文案：bridgePlatform() → Finder/资源管理器/文件管理器               │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ IPC ×2（trustedIpc 围栏）
┌─ 桌面主进程 packages/desktop/open-in.ts（electron-free 核心）──────────────┐
│  OpenInApp 注册表 [finder, vscode]（固定序，镜像 transport-provider 的      │
│    "新来源 = 新 provider" 哲学）                                           │
│  ├ finder：remoteCapable=false；available 恒 true（OS 常驻）；仅 local      │
│  │         → validateRemotePath → stat → 目录 shell.openPath（打开 Finder   │
│  │           窗口）/ 文件 shell.showItemInFolder（reveal）                 │
│  └ vscode：remoteCapable=true；available=ctx.vscodeAvailable（注入可测）    │
│            open=runVscodeLaunch（零行为变化，深链管线原样复用）             │
│  runOpenInLaunch 六步 loud 管线 + normalizeOpenPathError（shell 边界纯函数）│
│  main.ts：info 载荷 +platform；ipc-open-in.ts：open-in-apps / open-in 两    │
│    IPC（含载荷形状守卫；vscode 成功时保留 deep-link-intent 推送）           │
└────────────────────────────────────────────────────────────────────────────┘
```

- 无 host 插件、无 seed、无控制面改动——动作是本机拉起，没有实例内执行面
  （design 16 同款形态纪律）；
- `deep-link.ts` 只加一处 `export`（`validateRemotePath` 供复用），其余零改动；
  OS 深链（`dsh-chamber://open-vscode`）管线原样保留。

## 3. 契约

### 3.1 IPC（trustedIpc 围栏，替代 design 16 的两通道）

```
dsh-chamber:open-in-apps  ()                        → { apps: [{id, remoteCapable, available}] }
dsh-chamber:open-in       {appId, instanceId, path} → { ok: true } | { ok: false, error }
```

- **design 16 的 `dsh-chamber:vscode-availability` / `dsh-chamber:open-vscode`
  两 IPC 已删除**（随旧插件一起退役；渲染层唯一入口收敛为 open-in 两通道）；
- 载荷形状守卫：`appId/instanceId/path` 非 string → 统一 loud
  `invalid open-in payload`（不落 transport rejection）；
- 渲染层传入值一律不可信（与 design 16 §8 同款纪律）。

### 3.2 桥面（preload + renderer global.d.ts）

```ts
openIn: {
  apps(): Promise<Array<{ id: string; remoteCapable: boolean; available: boolean }>>
  open(appId: string, instanceId: string, path: string): Promise<{ ok: true } | { ok: false; error: string }>
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
  remoteCapable: boolean              // 能否打开远程实例路径（仅 vscode 家族 true）
  available(ctx: OpenInLaunchContext | null): boolean
  //   纯探测；常驻 app 忽略参数；协商期（apps()）传 null，无法作答须返回 false
  open(req: { instanceId: string; path: string }, ctx: OpenInLaunchContext): Promise<OpenInResult>
}
```

`OpenInLaunchContext`（main.ts 组装，模块 electron-free 可单测）：
`lookupInstance`（注册表实查）/ `vscodeAvailable` / `openVscodeUrl`（scheme
复验封装）/ `stat`（fs 包装）/ `openPath`（shell 包装 + normalizeOpenPathError）/
`showItemInFolder`。

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

### 4.3 Providers

- **finder**：`remoteCapable:false`、恒可用；`instanceId !== 'local'` → 拒绝；
  stat 不存在 → `path does not exist`；目录 → `openPath`（错误串 → `open path
  failed`）；文件 → `showItemInFolder`（Electron void API，静默面，见 §9）；
- **vscode**：`available: (ctx) => ctx.vscodeAvailable()`；open 直通
  `runVscodeLaunch`（注册表实查 + authority 构造 + scheme 复验，零行为变化）。

### 4.4 normalizeOpenPathError

Electron `shell.openPath` 成功返回 `''`、失败返回错误串——提取为纯函数
（`''`/非 string → null，非空串 → 原样）使该边界可单测。

## 5. 客户端插件（@dsh-chamber/dsh-client-ui-open-in）

- 包自 `dsh-chamber-client-ui-vscode` **重命名**（锁步 10 项按 design 16 §7.2
  模板：chamber-entry import/plugin/coveredFactory、chamber-covered ×2、vite
  alias ×3、vendor-modules 声明、根脚本 `typecheck:open-in`、ci.yml）；
- `OpenInButton` 三进门控（任一不满足 → 渲染 null）：① 桥就绪（有界轮询
  ≤40×500ms）且 `apps()` 过滤后非空（`available` 硬过滤 + 远程仅
  `remoteCapable`）；② 工作区有路径（useWorkspaces 按 sessionId）；③ hooks
  无条件先执行；
- 交互：1 个 app → 纯图标按钮；≥2 → 主图标按钮（默认 vscode 否则首个，本次
  挂载内记忆）+ chevron + `Menu`（portal，vendor primitives 原语）；chevron
  **打开即显示 + 后台 `refreshApps()` 重探**（toggle 关闭；协调器 epoch 防抖，
  会话中途装/卸 app 无需刷新页面）；
- 打开：`ssh-` 前缀剥离 → `openIn.open(appId, instanceId, path)`；失败 loud
  `console.error`（`openFailed` 前缀）+ `.catch` 兜底；
- 图标：vscode = 官方图标资源（`vscode-icon.png`）；finder = 中性文件夹 SVG
  （design token 着色）；slot 条目 `label` 用中性文案（该 label 是 vendor 槽的
  诊断标识，非用户可见；用户可见 tooltip/aria-label 由组件按 app 提供）；
- 协调器：`getApps()` 单飞 + 桥未就绪不固化可重试 + 真实结果 memoized +
  fail-closed；`refreshApps()` 绕过 memo 强制重探。

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

- appId 精确白名单（不猜测、不归一化）；`openInApps` 模块私有不可篡改；
- instanceId 门与 `runVscodeLaunch` 对称；`ssh-<id>` 视图 id 直呼被双层吸收
  （finder 走 remoteCapable 门拒绝 / vscode 走注册表实查 → `instance not found`）；
- remoteCapable 双层（管线门 + provider 复查）；远程路径绝不进入本地文件系统面；
- path 校验 + stat 存在性在主进程完成；只调 `shell.openPath`/`showItemInFolder`
  /`openVscodeUrl`（scheme 复验封装）；绝不 `shell.openExternal` 裸调用；
- `platform` 为非秘密元数据；失败全 loud；桥面缺失 fail-closed；
- 探测零副作用（纯 fs/PATH，绝不 spawn）。

## 8. 验证（M3 门禁全绿）

> 里程碑（M0–M3）：M0 主进程核心（open-in.ts + 用例套件）→ M1 IPC/桥面/info
> platform → M2 插件重命名 + 下拉 UI + 锁步接线 → M3 验证门全绿 + 实机验收。
> 与 design 16 §9 同款分期口径。

- `test:desktop` **287 用例**（截至 2026-08 定稿快照：transport-manager 75 +
  ssh-provider 37 + ssh-config
  15 + renderer-trust 2 + plugin-sync 72 + chamber-settings 13 + deep-link 43 +
  **open-in 24** + bundle-swap 3 + after-pack-adhoc-sign 3；后续新增
  notifications 19 等用例后合计 ~316，以 `pnpm run test:desktop` 实时为准）；
  open-in 套件覆盖
  六步管线每步（含精确 vscode URL 断言、门失败副作用 spy、path 非 string/空串、
  normalizeOpenPathError 四态），**任意机器确定**（可用性经 ctx 注入）；
- 全部插件 typecheck（open-in + sidebar/layout/connections/settings-bridge/git
  + client-web）、根 tsc、`build:renderer`、`test:renderer-shell`（锁步断言）、
  `verify:i18n`、`pnpm install --frozen-lockfile`（锁文件 = HEAD + 仅 importer
  重命名与 primitives peer 的最小 diff）；
- **五路对抗复核（2026-08，无 P0）**：修复 P1×3（测试机器依赖、AGENTS.md 行号
  前缀事故、锁文件再生漂移还原）+ P2×7（孤儿 IPC 删除、path 上移、载荷形状守卫、
  openPath 边界提取、URL 断言强化、门失败 spy、folder hover）。

## 9. 已知边界与实机验收

- **Windows 盘符路径**：`validateRemotePath` 要求 `/` 开头（POSIX 口径），win32
  上 finder/vscode-file loud 失败——"Windows 首版暂缓"口径一致，非回归；
- **`showItemInFolder` 为 Electron void API**：文件 reveal 分支无错误通道
  （目录分支 loud）；动作非关键、无安全后果，如实记录；
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
