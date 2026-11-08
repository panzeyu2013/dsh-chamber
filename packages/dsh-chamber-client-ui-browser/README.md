# @dsh-chamber/dsh-chamber-client-ui-browser

Remote Browser（design 28 `16）：右侧边栏「浏览器」页签。本包是上游官方
`@deepseek-ai/dsh-client-ui-sidebar-browser`（版本随上游 pin，见根 `harness.commit`）**iframe 路径的忠实源码 fork**：
DOM / className / 文案 / 快捷键 / 多标签 / priority / guide 顺序 / keepMounted /
store 持久化 / 地址解析 / 历史 / sandbox 开关 / 失败条 / restore 全部与上游逐字一致；
**唯一行为差异**是 SSH 反代——SSH 来源的远端 `127.0.0.1` 目标经既有 SSH 端口转发
租约拿 main 构造的 `frameUrl` 作为 iframe src，代理页的 system-browser 出口用同一
alias（不是本机不可达的远端逻辑地址；租约解析中/失败时出口禁用）。

> 上游 Electron webview 载体（`electron/` + `dshDesktop.browser`）刻意不 fork：Electron
> 归档参考与现行 Swift 腿都走 iframe 路径（design 28 `16.8），壳里没有该桥。
> `pnpm install` 后 `typecheck:browser` 的类型豁免见 `tsconfig.json` 的
> `erasableSyntaxOnly: false` 注释（上游源码逐字复用，随包由 vite/esbuild 打包）。

## 来源与同步

- 上游包：`vendor/harness-checkout/packages/client/ui-sidebar-browser`（pin 见根 `harness.commit`）。
- **逐字节 verbatim**（`test/locks/registration.test.ts` 用 SHA-256 冻结）：
  `src/client/browser/{BrowserNavigation,BrowserPage,BrowserPersistence,url}.ts`、
  `src/client/view/{BrowserPresentation.ts,BrowserTitle.tsx,Browser.module.css}`、
  `src/client/locales.ts`（8 语言）、`src/index.ts`。
- **行为差异文件**：
  - `src/client/browser/ForwardFrameResolver.ts`（新增，chamber 唯一逻辑）；
  - `src/client/browser/BrowserFrame.ts`（`BrowserFrameState.externalUrl` additive；代理页的
    system-browser 出口用 alias，不把不可达的远端 `127.0.0.1` 交给系统浏览器；attach 失败时
    `null` 禁用出口）；
  - `src/client/view/BrowserBody.tsx`（external 按钮优先 `frame.externalUrl ?? target.url`；
    其余 DOM/aria/copy 逐字）；
  - `src/client/browser/IframeImpl.ts`（异步 src 解析 seam + dispose 释放租约；失败仍走上游
    `BrowserFrameState.error` → `load.failed` 失败条）；
  - `src/client/view/IframePresentation.ts`（document 多一个解析后的 `url`，src 用它；其余
    DOM 属性/sandbox/referrerPolicy/dataset 逐字）；
  - `src/client/pages.ts`（`createIframePage(options, resolver)`）；
  - `src/client/definition.tsx`（仅 `BROWSER_ID` 值改为 `@dsh-chamber/remote-browser`，kind
    仍是上游 `browser`）；
  - `src/client/index.ts`（上游 apply 主体 + chamber source gate + 就绪等待 + resolver 注入；
    无 Electron 分支）；
  - `src/client/registry-wait.ts`（chamber 自有：deferred chunk 与右栏宿主行的竞速修复）；
  - `src/client/browser/{BrowserController,store}.ts`（**仅类型**：repo ambient 的 dock-kit 是
    shorthand module，named `TabId` import 改为本地 `type TabId = string`）。
- 同步方式：替换上游 pin 时重新复制上述文件、重跑 locks 的 digest 表（upstream-touchpoints
  纪律：digest 表更新是显式动作）。sha 表 = 上面的 9 个 verbatim 文件；行为差异文件永不进表。

## 唯一行为差异（SSH 反向代理：frame URL + external 出口）

`ForwardFrameResolver`（每个 tab occurrence 一个，复用 `src/shared/browser-controller.ts`
的 consumer 租约）：

| 来源 | target URL host | iframe src |
|---|---|---|
| local 实例 | 任意 | `target.url` 直连（本机） |
| dsh/gateway + ssh | 恰为 `127.0.0.1` | `forward.request`（带 consumer/path）→ main 的 `frameUrl` |
| dsh/gateway + ssh | 其它 host（含 localhost） | `target.url`（上游直连语义） |

- 地址栏/标题/持久化历史始终显示**逻辑 target**（绝不显示 alias URL）；只有
  `<iframe src>` 用解析后的 URL。
- 代理页的工具栏 external 用 `BrowserFrameState.externalUrl`（alias）；该字段在
  **租约解析中**（attach 未定）与 attach 失败时为 `null` → 出口禁用，避免把远端
  `127.0.0.1` 打开成本机服务；direct 页面仍走上游的 `target.url`。
- attach-first：新目标 bound 后才释放旧 consumer；attach 失败保留旧页并走上游失败条。
- 离开转发目标（导航到直连 URL）立即 detach；tab 关闭/插件 scope dispose →
  page dispose → resolver dispose → 租约释放（main 关 listener）。
- 无 `chamberForward` 桥（非桌面页）时 SSH 远端 loopback 目标解析失败 → 上游失败条，
  不伪造页面。

## 入口（source gate 是 chamber 契约）

1. `apply` 先过 chamber source 门：只有 `local` 与 ssh 到达的 `dsh-<id>` / `gateway-<id>`
   注册；`http` / legacy `ssh-<id>` / 错配直接 return（不写 locale、不注册）。
2. 远端 source 必须带 64-hex boot fingerprint（local 是字面量 `local`），否则警告并缺席。
3. 注册上游 8 语言 dictionary（`sidebarBrowser` namespace）。
4. `ctx.inject(['sidebarRight','sidebarRightTabs'])` 等右栏宿主行（deferred chunk 在页面
   缓存后可能早于宿主行 apply；5s 缺席诊断只发一次）。
5. 在服务可用上下文执行上游 registration body：store、`browser.new` shortcut、tab type
   （`multiple:true`、`priority:'builtin'`、guide order 30、`keepMounted:true`）、keyed
   body/title 两个座位。
6. iframe page factory 注入 `ForwardFrameResolver`。

## 测试

```
node ./scripts/test.mjs
```

- `test/url` / `test/navigation`：上游 url/navigation spec 的 node:test 版（地址默认 https、
  allowlist、bounded history、known/unknown 观测）。
- `test/forward/resolver.test.ts`：唯一 diff（local 直连 / ssh 127.0.0.1 attach / 离开释放 /
  失败失败条 / 串行化 / 每 tab 一个 consumer）。
- `test/lifecycle/forward-controller.test.ts` / `test/launcher/forward-bridge.test.ts`：
  既有租约与 forward 契约守卫。
- `test/registration/registry-wait.test.ts`：右栏服务就绪等待（竞速回归）。
- `test/locks/registration.test.ts`：verbatim digest 表、diff 面清单、上游 DOM/copy/definition
  锚点、自研 launcher 已删除。
