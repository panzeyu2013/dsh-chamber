# @dsh-chamber/dsh-chamber-client-ui-browser

Remote Browser（[design 28 v3](../../docs/design/client/28-remote-browser.md)；载体决策 [ADR-0004](../../docs/design/decisions/0004-swift-guest-per-tab.md)）：右侧边栏「浏览器」页签。本包 = 上游官方 `@deepseek-ai/dsh-client-ui-sidebar-browser`（版本随上游 pin，见根 `harness.commit`）**桌面 carrier 语义在 Swift 壳的 native 复刻**：地址栏 / 历史 / store 持久化 / 多标签 / 快捷键 / 标题 / 8 语言 / 失败条 / restore 与上游同源；面板内容 = **每 tab 一个子 `WKWebView` guest**（由 Swift 壳持有：独立 web content process、非持久 `WKWebsiteDataStore`、导航/权限/下载/证书门全在 main），renderer 只发意图与占位几何。**唯一行为差异 = SSH 反代**（forward alias 加载、external alias 投影、远端 loopback 导航期协商）。

> 上游 Electron webview 载体（`electron/` + `dshDesktop.browser`）刻意不 fork：Electron 腿冻结归档（[electron-frozen.md](../../docs/progress/electron-frozen.md)）；carrier 由 Swift 壳提供，本包经 `browser` 桥驱动 guest（keepMounted / per-session 记账在 renderer，guest 生命周期在 main）。
> `pnpm install` 后 `typecheck:browser` 的类型豁免见 `tsconfig.json` 的 `erasableSyntaxOnly: false` 注释（上游同源源码逐字复用，随包由 vite/esbuild 打包）。

> 契约 = [design 28 v3](../../docs/design/client/28-remote-browser.md) / [ADR-0004](../../docs/design/decisions/0004-swift-guest-per-tab.md)；开放验收项见 [STATUS 的「右栏浏览器 v3」条目](../../docs/progress/STATUS.md)。

## 来源与同步

- 上游包：`vendor/harness-checkout/packages/client/ui-sidebar-browser`（pin 见根 `harness.commit`）。
- **逐字节 verbatim**（`test/locks/registration.test.ts` 用 SHA-256 冻结，8 文件）：`src/client/browser/{BrowserNavigation,BrowserPersistence,url}.ts`、`src/client/view/{BrowserPresentation.ts,BrowserTitle.tsx,Browser.module.css}`、`src/client/locales.ts`（8 语言）、`src/index.ts`。
- **fork-diff 面（上游派生但不逐字，不进锁表）**：`src/client/browser/BrowserPage.ts`（v3 page 契约增加 `tabId`/`carrier` 身份字段；其余与上游同形）。
- **语义移植（不逐字，上游 `ElectronWebViewImpl`/`ElectronWebviewPresentation`/pages/workspace 的对偶）**：`src/client/browser/{NativeGuestImpl.ts,NativeGuestPresentation.ts,pages.ts}`——guest acquire/navigate/command/frame 意图、`browser.state`/`openRequested`/`input` 投影、失败条。
- **行为差异文件**：
  - `src/client/browser/ForwardFrameResolver.ts`（chamber 唯一逻辑：SSH 远端 loopback → forward alias）；
  - `src/client/browser/BrowserFrame.ts`（`BrowserFrameState.externalUrl` additive；代理页 external 出口用 alias，租约解析中/失败为 `null` 禁用）；
  - `src/client/view/BrowserBody.tsx`（external 按钮优先 `frame.externalUrl ?? target.url`；其余 DOM/aria/copy 逐字）；
  - `src/client/definition.tsx`（仅 `BROWSER_ID` 值改为 `@dsh-chamber/remote-browser`，kind 仍是上游 `browser`）；
  - `src/client/index.ts`（上游 apply 主体 + chamber source gate + carrier 门 + registry 等待 + resolver 注入；无 Electron 分支）；
  - `src/client/registry-wait.ts`（chamber 自有：deferred chunk 与右栏宿主行的竞速修复）；
  - `src/client/browser/{BrowserController,store}.ts`（**仅类型**：named `TabId` import 改为本地 `type TabId = string`）。
- 同步方式：替换上游 pin 时重新复制上述文件、重跑 locks digest 表（upstream-touchpoints 纪律：digest 表更新是显式动作）。sha 表 = 上面的 8 个 verbatim 文件；`BrowserPage.ts` 与行为差异文件永不进表。

## 唯一行为差异（SSH 反向代理：alias 加载 + external 出口）

地址栏/标题/持久化历史始终显示**逻辑 target**，guest 只加载 main 构造的 URL：

| 来源 | target host | guest 加载 |
|---|---|---|
| local 实例 | 任意 http(s) | 逻辑 URL 直连（`127.0.0.1`/`localhost` 即本机，不转发） |
| dsh/gateway + ssh | `127.0.0.1` 或 `localhost` | `forward.request`（带 consumer/path）→ main 的 alias URL |
| dsh/gateway + ssh | 其它 host | 逻辑 URL 直连 |

- 代理页的工具栏 external 用 alias；解析中/失败时 `null` → 出口禁用（不把本机不可达的远端逻辑地址交给系统浏览器）；direct 页用逻辑 URL。
- attach-first：新记录 bound 后才释放旧 consumer；失败走上游失败条并保留旧页。
- guest 内主 frame 导航到 loopback（不经地址栏）：main 在主 frame 决策里挂起、向 renderer 协商 record，成功以 alias 重载并取消原导航；子帧导航的引擎可拦截性待探针（资源级 content rule 兜底，design 28 §8-3）；`::1` 不作 forward 目标（协商后以失败条结束）。
- 离开转发目标 / 关 tab / 页 dispose → 释放 consumer；切 tab / 切 Session / 收起右栏不销毁 guest（keepMounted）；宿主显式释放（来源退役、硬上限、内存压力、手动释放）才销毁。
- 无 `chamberBrowser` 桥（非 Swift 壳页面）→ 浏览器行不注册（fail-closed；无 iframe 兜底）。

## 入口（source gate 是 chamber 契约）

1. `apply` 先过 chamber source 门：只有 `local` 与 ssh 到达的 `dsh-<id>` / `gateway-<id>` 注册；`http` / legacy `ssh-<id>` / 错配直接 return（不写 locale、不注册）。
2. carrier 门：页面存在 `chamberBrowser` 桥才注册 native guest 行；桥缺失 → 不注册任何行（fail-closed）。
3. 远端 source 必须带 64-hex boot fingerprint（local 是字面量 `local`），否则警告并缺席；注册上游 8 语言 dictionary（`sidebarBrowser` namespace）。
4. `ctx.inject(['sidebarRight','sidebarRightTabs'])` 等右栏宿主行（deferred chunk 在页面缓存后可能早于宿主行 apply；5s 缺席诊断只发一次）。
5. 在服务可用上下文执行上游 registration body：store、`browser.new` shortcut、tab type（`multiple:true`、`priority:'builtin'`、guide order 30、`keepMounted:true`）、keyed body/title 两个座位；native guest page factory 注入 `ForwardFrameResolver`。

## 测试

```
node ./scripts/test.mjs
```

- `test/url` / `test/navigation`：上游 url/navigation spec 的 node:test 版（地址默认 https、allowlist、bounded history）。
- `test/forward/resolver.test.ts`：唯一 diff（local 直连 / ssh `127.0.0.1`·`localhost` attach / 离开释放 / 失败失败条 / 串行化 / 每 tab 一个 consumer）。
- `test/carrier/native-guest.test.ts` / `guest-state.test.ts` / `popup-limit.test.ts`：native guest 桥 guard、push 投影、占位几何、地址/历史投影与 popup 限流。
- `test/lifecycle/forward-controller.test.ts` / `test/launcher/forward-bridge.test.ts`：既有租约与 forward 契约守卫。
- `test/registration/registry-wait.test.ts` / `test/locks/registration.test.ts`：右栏服务就绪竞速、8 文件 verbatim digest 表与 `BrowserPage` fork-diff 面、carrier 门（桥缺失不注册）、上游 DOM/copy/definition 锚点。
