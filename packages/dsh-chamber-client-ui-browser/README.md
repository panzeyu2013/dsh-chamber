# @dsh-chamber/dsh-chamber-client-ui-browser

Remote Browser（design 28）：右侧边栏的「浏览器」launcher。它把用户输入的
http(s) 地址分成两条腿——公网地址走既有的系统浏览器 link leg，远端 `127.0.0.1` /
`localhost` 经 SSH 端口转发后由受信 main 进程打开——并在同一面板里显示该 source 的
转发列表（轮询）。本地实例只保留地址栏：没有远端可转，loopback 地址直接在本机系统
浏览器打开。

> 状态：S1/S2 实现面。纯逻辑（地址表 / source 门 / launcher 模型 / forward 契约守卫）由
> `node --test` 直接运行；组件只做静态锁（仓库没有 DOM 设施）。ForwardManager、preload/Swift
> shim 与复合入口的另一半在 `packages/desktop` 与本仓 renderer；真机/打包验收见 design 28 §15。

## 职责

- 注册右侧边栏 tab type：id `@dsh-chamber/remote-browser`、kind
  `chamber-remote-browser`、`multiple: false`，附一个 guide 条目
  （`id: 'open'`、order 40）与 `sidebar.right.pane.tab` / `...title` 两个 keyed 座位。
- 地址栏：http(s)（默认 http）、path/query 保留、fragment 丢弃、host/scheme 分类
  （见下）。
- 远端分区：轮询 `forward.list`（1.5s，无 push），渲染 bound / binding / error /
  stale 行与打开 / 重开 / 关闭动作；不做 pin / retry / subscribe。
- 错误与空态：拒绝原因、bridge 缺席、列表读取失败（可重试）、无转发、达到上限。

## 非目标（v1 明确不做）

- **不** iframe / webview / native 内嵌页面；本包不渲染任何远端内容。
- **不** 走 gateway tunnel；`gateway` + http 来源无入口（没有 SSH 隧道），`local` 来源没有远端分区。
- **不** 新增通用 URL IPC；远端 URL 由 main 从 record id + 校验后的 path 构造。
- **不** 申请/持有 forward 生命周期所有者身份；forward 归 source，关闭 launcher 不杀。
- **不** 尝试控制系统浏览器里已打开的旧页；只把记录标 stale 并提供重开。
- **不** 支持 `[::1]`、RFC1918、远端 LAN 主机名作为 forward 目标；它们最多是公网
  URL（在**本机**系统浏览器打开）。
- **不** 支持 2FA/OTP 主机、共享 127.0.0.1 回退、cookie/存储清理。

## 入口与注册（apply 顺序是契约）

1. **source 门**：`resolveBrowserEntry(chamberInstanceId, chamberTransport)`，字面量
   `local` + `local`（`mayForward=false`）与 `dsh-<id>` / `gateway-<id>` + `ssh`
   （`mayForward=true`）通过；`http`、legacy `ssh-<id>` 与 kind/transport 交叉错配直接
   return。
2. **fingerprint**：远端必须是 64 hex；本地实例是字面量 `local`（`shell.ts` 的 boot 事实）。
   远端缺指纹时警告并缺席（不注册一个必然被 main 拒绝的 tab）。
3. **探测 `sidebarRightTabs`**：用 `ctx.get('sidebarRightTabs')`（**不**写进导出
   `inject`）。缺该服务时只警告、不注册，也不报假入口。
4. 注册 locale（zh/en）→ tab type → 两个 keyed slot 座位。

`export const inject = ['slots', 'locale']` 是刻意的：required-service probe 读取导出
inject，若把 `sidebarRightTabs` 放进去，http source 会被点名缺服务，而那里的入口本来
就是「按设计缺席」。代价是 ssh 源且图里缺 sidebar-right 行时只有 console 警告、probe
不点名——W0 需补一条等价探针测试（见集成文档）。

无 shortcut、无 commandId：guide 点击由 ui-sidebar-right 自己的
`openTab(entry.kind)` 完成。

## 地址表（`src/shared/address.ts`）

| 输入 | kind | 行为 |
|---|---|---|
| `http(s)://公网/主机名` | `public` | 系统浏览器 link leg；`reachability` 标 public |
| 其它 `127/8`、`*.localhost` | `public` (`local-machine`) | 系统浏览器；提示「在本机打开」 |
| RFC1918 / 169.254 / 100.64（CGNAT） | `public` (`private-network`) | 系统浏览器；提示不保证远端可达 |
| `127.0.0.1` / `localhost`（任意端口） | `remote-loopback` | 规范化 127.0.0.1，请求 forward |
| `https://127.0.0.1` | `remote-loopback` | scheme 透传，UI 提示证书不匹配 |
| `[::1]` / IPv4-mapped loopback | `unsupported` (`ipv6-loopback`) | 拒绝 |
| `0.0.0.0` / `[::]` | `unsupported` (`unspecified-host`) | 拒绝 |
| userinfo | `unsupported` (`credentials`) | 拒绝 |
| app origin（含同端口 loopback 别名） | `unsupported` (`application-origin`) | 拒绝 |
| 非 http(s) / 端口 0 / 控制字符 | `unsupported` | 拒绝 |

path/query 保留；fragment 丢弃；返回 `requestPath`（path + `?query`）供 main 校验。
`remote-loopback` 在 local 源上不进 forward：同一 URL 直接走 link leg（`reachability:
'local-machine'`），面板也没有远端分区。交给系统浏览器的 URL 保留用户输入的 `localhost` 拼写
（本地服务/证书可能只认它）；`host` 字段恒为 `127.0.0.1`，只作 forward 目标。

## forward 契约（`src/shared/forward-bridge.ts`）

本包不 import 任何尚不存在的模块，而是声明 launcher 需要的本地接口与运行时守卫：

```
request({sourceId, sourceFingerprint, port, scheme}) -> {ok, record} | {ok:false, code}
release({sourceId, sourceFingerprint, id})            -> {ok} | {ok:false, code}
list({sourceId, sourceFingerprint})                   -> {ok, records} | {ok:false, code}
openInBrowser({sourceId, sourceFingerprint, id, path?}) -> {ok} | {ok:false, code}
```

- record 只含 `aliasHost` + `localPort` 供**显示**；renderer 永远不拿 URL 回传给 main。
- `scheme` 是 record 的一部分：远端 https 不会被静默降级为 http。
- `stale` 是 list 事实；面板给「重新打开」，不承诺更新系统浏览器旧页。
- 已接 `chamberForward`：renderer 的 `chamber-forward-adapter` 把 preload/Swift shim 的
  wire 面（`@dsh-chamber/dsh-chamber-wire/forward`：targetPort / targetHost / namespace /
  时间戳、7 个 state、`{code, detail}` 错误封套）翻译成本包的小本地面；本包不 import wire，
  映射表与锁步在 `packages/renderer/test/lifecycle/chamber-forward-adapter.test.ts`。

## 依赖

- `ctx.slots`、`ctx.locale`（cordis 服务，声明在 `inject`）。
- `ctx.sidebarRightTabs`（官方 ui-sidebar-right 提供；**不在** inject 里，apply 时
  `ctx.get` 探测）。
- `ctx.chamberInstanceId` / `chamberTransport` / `chamberSourceFingerprint`
  （chamber-entry 的 per-entry boot 事实）。
- `chamberForward` 服务/预加载桥（结构性探测；缺则远端分区显示「当前环境未提供远端
  转发能力」，local 源不渲染该分区）。

## W0 待核项 / TODO

- pin（0.2.2-rc.1）上重新核对：`sidebarRightTabs.register` 字段
  （`title` 是否必填、guide 的 title/description 是函数还是字符串、`priority`
  默认 band、guide 点击是否仍 `openTab(entry.kind)`）；slot 名
  `sidebar.right.pane.tab` / `.title` 与 `key` 语义；`ctx.get` 可用性。
- 地址默认 http（官方 0.2.1-rc.2 默认 https）与 app-origin 环回别名拒绝是刻意差异，
  要写进 design 28。
- renderer onboarding（依赖、alias、covered/deferred、chunk budget、lockfile、根
  scripts、gate-surfaces、vendor-modules.d.ts、EXPORTS_ALLOWLIST、
  RUNTIME_LOADED_PACKAGES）见 `.tmp/remote-browser/w0-package-integration.md`。
- vendor 树未填充时 pin 侧 `tsc` 仍不可运行；纯逻辑测试用 Node type stripping 直接跑过（见下）。

## 测试

```
node ./scripts/test.mjs                         # 本包 manifest（需要仓库 node_modules）
node test/address/address.test.ts               # 单文件也可直接 node 运行（纯逻辑）
```

- 纯函数：address / source / forward-bridge / launcher-model（真跑，Node 22 type
  stripping）。
- 组件：仓库没有 DOM 设施（无 jsdom/testing-library 依赖），因此组件只做源码静态锁
  （`test/locks/registration.test.ts`：inject 面、注册常量、slot key、错误/空态标记、
  link leg 的 anchor 属性、CSS token/0.5px 规则、无 value import 缺失模块）。
