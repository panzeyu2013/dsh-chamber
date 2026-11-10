# Remote Browser 验收 Checklist（acceptance）

- 阶段：acceptance
- 触发：改动右栏浏览器 / Swift native guest 载体或 `browser` 桥 / SSH forward / CSP / 官方 `ui-sidebar-browser` 行面，或发布前
- Owner：浏览器面改动 author 出自动化证据；真机项由验收人执行
- Timebox：自动化 ≤10 分钟；真机（§D / §E2 步 22）≤1 小时
- 退出标准：§A 全绿（含 SH-7 live）；W-13…W-30 真机项按 §E2 与 gui-acceptance-checklist §4.2 留证；FAIL/INFO 逐条记录
- 自动化入口：`node --experimental-strip-types --test packages/desktop/test/forward/*.test.ts`、`pnpm run test:gui-acceptance`（CI 判定层：SH-7 + 归档 v2 判据）、`node scripts/gui-acceptance/drivers/run.mjs --live`（SH-7）、`node packages/dsh-chamber-client-ui-browser/scripts/test.mjs`；真机入口见 §E2/gui-acceptance-checklist §4.2
- 证据：每条给「命令 + 平台 + 源类型 + 结果（PASS/FAIL/INFO 原因）+ 截图/报告路径」；INFO 不等于通过

> 本文件只固定流程与留痕：判据权威 = design 28 §1 / §4 / §5 / §9（v3 native guest；[ADR-0004](../../design/decisions/0004-swift-guest-per-tab.md)）；自动化证据与真机步骤分开。CI 只判定 SH-7（纯 HTTP）与归档 v2 判据；W-13…W-30 全部是真机/打包态。不记录版本号、批次日志或完成叙事。

## 0. 前置

- 当前 pin 的 vendor 树已填充（`vendor/harness-checkout` 非空）。
- `node_modules` 已安装；锁文件与 workspace 一致。
- 有一个 dsh 或 gateway 的 SSH 源（或按 B/C/D 使用临时本地夹具）；本地实例也应出现入口（无远端分区）。
- 入口 = 除 http 外全部来源：local、dsh+ssh、gateway+ssh 出现；gateway+http 不出现。
- 载体 = Swift 每 tab 子 `WKWebView` guest（[ADR-0004](../../design/decisions/0004-swift-guest-per-tab.md)）：页面存在 `chamberBrowser` 桥 → 注册 native guest 行；桥缺失 → 不注册任何行（fail-closed）。远端端到端腿需要真实 SSH 源且该主机 `127.0.0.1:<port>` 上有可服务页面；Swift 界面腿按 [gui-acceptance-checklist.md](./gui-acceptance-checklist.md) §4.2 真机/目检；Electron CDP 夹具（`--dev`/`--ssh-fixture`）随 flavor 冻结归档，native driver 不接受这些参数。

## A. 自动化（Linux，已可在本仓库跑）

~~~sh
node --experimental-strip-types --test packages/desktop/test/forward/*.test.ts
node scripts/gates/checks/verify-test-wiring.mjs
node scripts/gates/checks/verify-no-dead-exports.mjs
node scripts/gates/checks/verify-import-cycles.mjs
node scripts/gates/checks/verify-file-budgets.mjs
node scripts/gates/checks/verify-package-boundaries.mjs
node scripts/gates/checks/verify-shim-payload-shape.mjs
node scripts/gates/checks/verify-md-links.mjs
node packages/dsh-chamber-client-ui-browser/scripts/test.mjs

# CI 判定层：SH-7 纯 HTTP + 归档 v2 判据（不覆盖 v3 guest 载入/进程/几何/文件面板）
pnpm run test:gui-acceptance
node scripts/gui-acceptance/drivers/run.mjs --live

# W-13…W-30 是真机/打包态判据：见 §E2 与 gui-acceptance-checklist §4.2，不在本块执行
~~~

- v3 的 `--dev` / `--attach` / `--require-embed` / `--embed-port` / `--ssh-fixture` 只服务归档 Electron CDP 腿；native driver 不接受这些参数，不得写成可执行证据路径。

- `forward-real-ssh.test.ts`：临时 sshd + 真实 `ssh -N -L` + alias HTTP 取回 + release；key-auth，Linux/root。
- `forward-spawn.test.ts`：真实 spawn + `/proc` start-time + ledger + 幂等 stop。
- `forward-windows.test.ts`：CIM/CommandLineToArgvW 纯解析；真实 Windows 见 §C。
- 期望：全部绿；非 Linux/非 root 的 real-ssh 用例自动 skip。

## B. Askpass（真机 / 特权环境）

本仓库的 Linux 测试环境 `/etc/shadow` 只读，不能在自动测试里安全建临时密码账户；用一次性主机或容器执行：

1. 用一次性用户/容器启动 sshd：`PasswordAuthentication yes`、`UsePAM yes`、仅监听 127.0.0.1，临时 authorized_keys 不需要。
2. 让 askpass 脚本只回显测试密码；`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force` 经 launcher 的 lease env 注入。
3. 请求一个 remote loopback 端口的 forward；期望 bound，alias URL 可取回测试 HTTP body。
4. release 后：子进程退出、ledger 清空、askpass lease 释放恰好一次；无密码/URL 进日志环。
5. 测试结束删除临时用户/容器；不得改真实 `/etc/shadow`。

## C. Windows（真机；**ARCHIVED：随 Electron 冻结，不执行**）

1. 真实 `ssh` + 密钥/agent 源；确认 launcher 的 `spawn` 为 `shell:false`、`detached:false`、`pgid:null`。
2. 启动 forward；确认 CIM 查询得到 `CreationDate`/完整 `CommandLine`，ledger 的 start-time 与 probe 三元匹配。
3. 关闭应用后重启：reaper 只 kill 证出身份的子进程；无法证明身份时保留记录、0 kill。
4. release/quit：`taskkill /PID <pid> /T /F`，无 Job Object；子进程树无孤儿。
5. ACL 复核失败时 fail-closed（不杀）。
6. 若任一不成立，记录为 Windows 实机阻塞；不要用纯逻辑测试替代。

## D. macOS（真机）

1. 启动 forward；确认 alias 绑定、HTTP 取回。
2. kill -9 应用后重启：`ps` argv 无法逐字还原时 reaper **不杀**、保留 ledger（设计 28 的 fail-closed 取舍）；确认没有误杀。
3. release/quit：POSIX 进程组 TERM→KILL 生效。
4. 如需让 macOS 具备自动回收，先单独评审 exact-argv 适配器（不要以"近似 argv"替换）。

## E. S2 GUI 走查

1. 右栏指南/标签在 local、dsh+ssh、gateway+ssh 源出现；gateway+http 不出现；缺 `sidebarRightTabs` 时诚实缺席。**必须覆盖非首个 boot 的来源**：页面打开后（首个 boot 通常是本地实例）切到另一个来源，再展开右栏——入口必须同样出现（注册表是宿主图行，晚于 deferred chunk；只认首个 boot 的探测正是本步要防的回归）。
2. 地址栏任意 http(s) URL（含 https/公网）→ 面板内 native guest 直连；系统浏览器只经工具栏 external 按钮，不自动转。
3. 地址栏 `http://127.0.0.1:<port>/path`：ssh 源 → ensure forward → 面板内 guest 载入 main 构造的 **alias** URL（127.0.0.2–254；面板显示逻辑地址，不显示 alias 主机）；https/证书不匹配按 guest 引擎失败条 + external 出口（不自动切系统浏览器、不点穿）。local 源：同一地址**直接 guest**（不建 forward、面板无远端分区），系统浏览器是上游 BrowserBody 工具栏的显式出口。gateway+ssh 源：与 dsh+ssh 同一路径（forward 复用该来源的 SSH 隧道）。
4. 两 source 同端口：各自 alias；cookie 探针隔离；不存在共享 127.0.0.1。
5. 端口冲突 → ephemeral；stale/重开；console 关闭不杀；退出回收。
6. 失败/上限/无桥/空态/a11y（role=alert/status）可见。默认路径是 **native guest**（design 28 §4）：任意 http(s) 由 guest 顶层加载（XFO 站点同样可见），失败投影为失败条（code+description，见 E2 步 6），系统浏览器只走工具栏 external 显式出口；E2 的步 1–22 覆盖载体面。
7. per-port 确认：5173 确认后，5174 再次弹窗；同端口不再弹；dialog 期间 retarget 返回 `confirmation_late` 且没有新 listener。
8. 官方 `ui-sidebar-browser` 未同时出现（web profile 恒禁用，§F 已核实）。

<a id="e2"></a>

## E2. 载体验收（design 28：Swift native guest；W-13…W-30 真机 + SH-7 CI）

判据权威 = [design 28](../../design/client/28-remote-browser.md) §1 / §2.10 / §4 / §5 / §6 / §9 与 [ADR-0004](../../design/decisions/0004-swift-guest-per-tab.md)；本段只固定步骤与留痕。CI 判定层 = `pnpm run test:gui-acceptance`（SH-7 + 归档 v2 判据）；**W-13…W-30 全部在 macOS 真机/打包态执行**（[gui-acceptance-checklist.md](./gui-acceptance-checklist.md) §4.2），`--dev`/`--attach`/`--require-embed`/`--embed-port`/`--ssh-fixture` 只属归档 Electron CDP 腿，native driver 不接受，不写成可执行证据路径；headless 只覆盖 design 28 §9 L5 的 forward 链。

0. **上游同源静态锁（先跑）**：`packages/dsh-chamber-client-ui-browser` 的 8 个 upstream verbatim 文件（`BrowserNavigation`/`BrowserPersistence`/`url`/`BrowserPresentation`/`BrowserTitle`/`Browser.module.css`/`locales`(8 语言)/`src/index.ts`）与 vendor `ui-sidebar-browser` 逐字节相同（SHA-256 锁）；`BrowserPage` 是 fork-diff 面（v3 page 契约增加 tabId/carrier 字段），载体实现 `NativeGuestImpl`/`NativeGuestPresentation`/`pages` 是上游 Electron carrier 的语义移植（不逐字复制）；命令 = `node packages/dsh-chamber-client-ui-browser/scripts/test.mjs`；不成立 = FAIL（design 28 §1/§9 L2）。

1. **W-13 面板结构与占位几何**：右栏 guide 按上游 `[data-sidebar-right-guide-entry="browser"]` 定位（**该 guide 锚点未在真机证实 = 未证实**，真机走查时先确认） → 开页签 → 上游 BrowserBody 恰一个可见（地址栏、toolbar back/forward/reload/go/external、content `aria-busy` 可读；上游无自研 panel/phase/远端分区概念；guest 恒隔离，**不做** sandbox/referrer 断言）→ renderer 上报占位 `frame` 几何且 Swift 侧 guest 已挂载（`browser.acquire` 成功、`BrowserGuestLayerView` 只在活动 rect 内命中、其余穿透）；占位 rect 与 guest 实际位置不一致即 FAIL（design 28 §4.1、§9 L4）。

2. **W-14a local guest 真跑**：地址栏提交**显式** `http://127.0.0.1:<port>/`（上游裸地址默认 https）→ renderer 只发 `browser.navigate({kind:"direct"})`，main 复核 URL 后由 guest 加载；观测 `browser.state` push：loading true→false、url = 输入、title = **页面 JS 设置的值**（页面 JS 真跑的判据；空白/未执行不算通过）、地址栏保持逻辑地址、不建 forward（design 28 §4.3、§2.10）。

3. **W-14b remote alias guest 真跑（真机；需真实 SSH 源）**：切到该 dsh/gateway+ssh 来源并打开浏览器页签 → 输入显式 `http://127.0.0.1:<port>/` → main 先 `forward.request`（确认/限额）再以 record 身份导航；观测：guest 实际加载 URL 是 per-source **alias**（127.0.0.2–254，绝不是 127.0.0.1/远端地址；alias 由 main 合成、renderer 不拼）、地址栏显示逻辑地址、页面 JS 执行证据、external 出口 = alias；租约由 alias 加载 + 页面执行 + 关 tab 后 alias 不可达共同证明。前置缺失记未判/INFO，不得用无 SSH 的运行冒充；不得用归档 CDP 夹具充当真机证据（design 28 §2.10、§9 L4/L5）。

4. **W-15 XFO 站点必须可见**：fixture `/embed-xfo`（`X-Frame-Options: DENY`）→ guest 是顶层文档，XFO/frame-ancestors 不适用：页面必须**加载且可见**（`browser.state` 的 url/title/loading=false 正常）；工具栏 external 存在且可点、装载时**不自动打开**、点击后恰一次打开逻辑地址（forwarded 页用 alias 投影）；转发目标解析中/attach 失败 external 禁用（design 28 §6、§8-1、§9）。

5. **W-15b 关 tab 释放**：点页签关闭钮 → renderer `browser.release`（lease 失效）→ 该 tab guest 销毁、其 web content process 退出（`pgrep`/`ps` 进程计数回落）；forwarded 页另要求 detach 后 alias 端口 ECONNREFUSED（未知可达性不算已释放）。local 直连无 forward，不做 list 探针（design 28 §4.2、§2.7、§9 L5）。

6. **W-16 失败可见性**：不可达地址（`http://127.0.0.1:<closed-port>/`）与自签/不匹配 TLS 站点 → `didFailProvisionalNavigation`/`didFail` → `browser.state.error={code,description}` → 上游 `load.failed`/`load.failed.detail` 失败条可见（含 NSURLErrorDomain code 与描述）；guest 崩溃（W-22）同一投影（design 28 §4.3、§5 ⑦）。

7. **W-17 安全门矩阵**（每门至少一条反例，全部被拦且无页面行为）：① app-host（控制面 origin 的 host:port）拒绝，`127.0.0.2–254` 与其它端口放行；② 带凭据 URL 拒绝；③ 主 frame 非 web scheme 导航 cancel（`about:` allow；主 frame `blob:`/`data:` cancel，子帧 allow）；④ 媒体采集 deny、其余权限无回调即隐式拒；⑤ 下载：navigation action 的 `shouldPerformDownload` cancel + response 的不可展示 MIME cancel；⑥ HTTP auth challenge cancel；⑦ 证书走 performDefaultHandling（失败投影失败条，不放宽）；⑧ alert/confirm/prompt 立即关闭；⑨ 数据 store 隔离（W-21）；⑩ guest 无注入脚本/无桥（页面内不可见 `dshChamber`）；⑪ URL 只由 main 构造/放行；⑫ **非规范 loopback 字面**（尾点 `127.0.0.1.`、十进制 `2130706433`、IPv4-mapped `::ffff:127.0.0.1`、全展开 `[0:0:0:0:0:0:0:1]`）经 RT-01 归一后仍按 loopback/app-host 判定（main frame 门 + content rule 不得绕过）；⑬ **ssh 来源的 guest 页内直接请求** `127.0.0.1`/`localhost`/`[::1]` 任意端口必须被 content rule 的 ssh 变体拦截，per-source alias 段不受影响；⑭ 弃用 TLS：`shouldAllowDeprecatedTLS` 返回 false（design 28 §5）。

8. **W-18 新窗**：GET `target=_blank`（http(s)、无凭据、非 app-host）→ `browser.openRequested` → 面板开新 browser tab（不交系统浏览器）；POST/PUT/PATCH 新窗一律丢弃（拿不到 postBody）；子帧 popup 不推 openRequested、不转系统浏览器（子帧导航可拦截性待探针 = 已知限制）（design 28 §5③、§8-3/§8-4、§6）。

9. **W-19 z-order / 遮挡**：guest 是原生层、DOM 浮层无法覆盖 → renderer 用 9 点 DOM 命中 + overlay 候选 selector（250ms 缓存）+ 显式 `setOccluded` seam 判定 `occluded=true` 隐藏 guest：命令面板、对话框/sheet、侧栏 guide、toast/通知、DOM 菜单、拖拽遮罩、tab 切换过渡逐类打开验证 guest 不遮挡且关闭后恢复；rect 0/离屏/收起 → hide。统一 `overlayDepth` 全信号尚未实现（TODO D§5 #1）（design 28 §4.1、§8-5）。

10. **W-20 rect 同步**：滚动（捕获阶段 scroll）、分栏拖动、窗口缩放/全屏、ProMotion 120Hz 与 pageZoom 下占位 rect 与 guest 实际位置无漂移（≥1px 或可见性变化才上报；观察期内不得出现稳定偏移）；收起右栏/滚出可视区 → hide（design 28 §4.1、§8-5）。

11. **W-21 存储隔离**：两个 workspaceKey 的登录态/站点数据互不可见（cookie 探针）；重启 app 即丢（`nonPersistent`）；删除/退役 source 后该 source 分区不可再用、无残留 lease（design 28 §4.4、§8-6）。

12. **W-22 进程与内存**：N 个 guest tab 常驻（切 tab / 切 Session / 收起右栏不销毁）；kill 某 tab 的 web content process → `webViewWebContentProcessDidTerminate` → 失败条 + 用户 reload 重建 guest 并重载 checkpoint URL，forward record 不释放；宿主显式释放（隐藏源壳回收、来源退役、硬上限、内存压力、手动释放）销毁该源全部 guest 并 release consumer（design 28 §4.2、§4.6、§8-8）。

13. **W-23 a11y/键盘**：guest 聚焦时 Cmd+T → `browser.input` 推给 renderer shortcut 管线 → 新开浏览器页签（target 由 input 携带的 lease 归属 tab/session 上下文给出）；非表内组合/双键 chord/IME 编辑键归 guest；AppKit 菜单 key equivalents 与页面快捷键并存；面板控件 aria 可读（地址输入/工具栏按钮各带 `aria-label`、tab 标题来自 `definition.tsx` 的 `t('type.label')`）、占位 div `aria-hidden="true"` 且无 `aria-label`（可访问名只由 guest 提供）、失败条 `role=alert`/`status`（design 28 §4.5、§8-15、§9 L4）。契约：input.modifiers canonical = `control`（旧 shim 的 boolean 形态由 adapter 兼容，字符串 `ctrl` 不接受）、input 带 lease（旧 shim 缺失时按 tabId 回退）、renderer 每页只派发一次；真机 NOT RUN。

14. **W-24 localhost 转发语义**：ssh 源输入 `http://localhost:<port>` 与 `http://127.0.0.1:<port>` 走同一 forward、同一 alias（display 保留用户拼写）；local 源同地址直接 guest 加载、不建 forward、无远端分区；gateway+ssh 同一路径（design 28 §1、§2.10）。

15. **SH-7 桌面 CSP 短头**：Swift 桌面壳前端文档 CSP 的 `frame-src` 精确等于 `blob:`，`frame-ancestors 'none'`/XFO/COOP 保持；**不得**出现 `http:`/`https:`/loopback/alias host/`'self'`/`*`/`data:`；`ControlPlaneOptions.frameSources` 不再由 Swift sidecar 启动点传（gateway/cli/standalone 不变；冻结 Electron 入口保留 v2 扩展 = 唯一例外，见 electron-frozen §3）。出现扩展即 FAIL。命令 = `node scripts/gui-acceptance/drivers/run.mjs --live`（纯 HTTP，不需要 GUI）（design 28 §5 CSP、§9）。

16. **W-25 子帧资源级拦截（层：真机）**：ssh 源 guest 页内 `fetch()`/XHR/WebSocket/`iframe` 指向 app-host（控制面 `127.0.0.1:<cpPort>`、`localhost:<cpPort>`、`[::1]:<cpPort>`）必须失败（`WKContentRuleList` 请求级门：顶层规则数组 + WebKit 正则子集，ssh 变体用不匹配 alias 段的显式枚举）；同一页对 per-source alias `127.0.0.n:<port>` 与其它 host 的同类请求必须不被误伤；控制面重启导致 cpPort 变化后规则重编译、重测仍拦；常见 legacy 写法（`127.1`、`0x7f000001`、前导零、IPv6 展开）同样被拦。若真机确认子帧 `file://` 导航不投递 `decidePolicyFor`，以 content rule 兜底；子帧发起的下载归 W-28。证据 = guest 内失败请求的 DOM/error 观察 + alias 请求成功 + 探针记录（design 28 §5 app-host/两变体、§8-3）。

17. **W-26 guest 内 loopback 导航（alias 反查 = 降级）**：在 guest 页内（非地址栏）点击/重定向到远端 `127.0.0.1:<port>` → main 在主 frame 导航决策挂起 → `forward.request` → 以 alias 重载并取消原导航；`::1` 等其它 loopback 写法通过类别门后不建 forward（失败条，不加载本机 loopback）。地址栏/历史保持**逻辑 URL 仅限同一 forward alias origin 内**（**降级**：不做 record 表通用反查，离开该 origin 的 URL 原样显示 alias；未知 alias 显式提示未实现——登记 [TODO](../../progress/TODO.md) D§5 #0）；该 record 的 external 出口 = alias。真机（真实 ssh 源）；CI 无该腿。证据 = 导航后地址栏逻辑值 + guest 实际 alias 值 + forward list 记录（design 28 §2.10、§4.3）。执行状态 = macOS 真机 **NOT RUN**。

18. **W-27 文件选择 = 当前显式拒绝（安全优先；层：L6-only，macOS 真机）**：guest 页 `input type=file` 点击 → **不弹面板**、guest 收到取消（delegate `WKUIDelegate.runOpenPanelWith` 显式 `completionHandler(nil)` + 日志）；断言无 `NSOpenPanel`、无本机路径进日志/renderer。**「安全开启」判据（用户手势证据 + 只回本 guest 的临时授权）登记 [TODO](../../progress/TODO.md) D§5 #5；未开启前判据 = 代码/日志确认拒绝路径（`BrowserGuestRegistry.swift#=literal:拒绝文件选择`）；执行状态 = macOS 真机 NOT RUN，真机确认未弹面板前不记 PASS**（design 28 §8-13、§9 L6）。

19. **W-28 子帧下载不落盘**：主 frame 与子帧两类下载（`<a download>`、`Content-Disposition: attachment`、子帧 iframe 内触发）→ navigation action 与 response 双 cancel；下载目录/临时目录在操作前后 diff 无新文件（macOS 真机 `$HOME/Downloads` 与 WebKit 临时目录；S0-P4 记录子帧是否投递 delegate，若 WebKit 默认取消亦按不落盘判 PASS 并留探针证据）。两 source / 两 scheme 各一条（design 28 §5⑤、§8-3、§8-10）。

20. **W-29 zoom 目标（层：表达式 + 真机）**：guest 聚焦时 Cmd+±/Cmd+0 **只作用于 guest 页面缩放**（guest.pageZoom；实现 = `MainWindowController.zoomIn`/`zoomOut`/`resetPageZoom` 按 `focusedGuestWebView()` 分流），壳 `pageZoom` 不变；焦点在壳 UI 时只作用于壳；一次按键只缩放一个目标、不双投；缩放后 rect 契约仍为 `points = cssPx * webView.pageZoom` 且占位与 guest 无漂移（采样窗与 ≤1px 判据同 W-20）。证据 = 缩放前后壳/guest `pageZoom` 读数 + 占位几何差（design 28 §4.5、§8-5）。执行状态 = macOS 真机 **NOT RUN**（真机跑前不记 PASS）。

21. **W-30 内存阈值（R-10/C-11；层：真机采样）**：采样方法 = 每个 tab 打开/切换/关闭后记录壳进程 RSS 与 guest web content process RSS 合计（`ps -o rss=` 旁证；首选 registry 暴露的 guestCount/内存读数，不用私有 API）；曲线覆盖 1/3/6 个 tab 与「两 source 各 1 tab」。阈值/采样窗以 design 05 §4.1（与 C-11 同批落地）为**单源**，本清单不手抄数值；**阈值当前待定（design 05 §4.1 无 guest 阈值），阈值落地前本项按 INFO 记录**；超限判定 = keep-all 释放路径触发或内存压力终止后台进程 → 失败条 + reload 恢复且 forward record 仍属该 tab。证据 = 采样表 + 阈值判定结论（design 28 §8-8、§4.6）。

22. **L6 真机（Swift .app；Electron 半边 ARCHIVED）**：design 28 §9 L6 全套（guest 独立进程、z-order/rect、快捷键、IME、拖拽、文件选择、下载取消、权限/证书/对话框、崩溃恢复、W-30 内存曲线）按 [gui-acceptance-checklist.md](./gui-acceptance-checklist.md) §4.2 真机/目检执行；记录每条「命令 + 平台 + 源类型 + 结果（PASS/FAIL/INFO 原因）+ 截图/报告路径」。

记录：每条给「命令 + 平台 + 源类型 + 结果（PASS/FAIL/INFO 原因）+ 截图/报告路径」；INFO 不等于通过。

### 假绿防护与证据分层（G-01…G-08 / C-3…C-11）

- **层标注**：CI 唯一判定负载 = SH-7 纯 HTTP（`run.mjs --live`）+ 归档 v2 判据（`test:gui-acceptance`）；**W-13…W-30 全部是真机/打包态**，CI 不覆盖 guest 载入/进程/z-order/几何/文件面板；CI 绿 ≠ 载体验收，发布门要求至少一条真机/打包态实跑（G-01）。
- **W-14a/14b 的 JS 真跑**：fixture 的 `document.title` 必须由页面脚本**运行期计算**（随机串/时间戳注入），不得由 URL/host 派生；`browser.state` 的 title 与请求随机串一致才算 PASS（G-07）。
- **W-15b 进程退出**：首选 registry 暴露的 guestCount 回落 + 释放后不再有该 tab 的 `browser.state` 事件 + 内存回落；`pgrep`/`ps` 仅旁证，不用进程数差当判据；kill 单进程只允许影响该 tab（相邻 tab 状态不销毁）（G-04、C-4）。
- **W-20 rect**：用 test-only debug hook 读 guest 实际 frame/pageZoom/occluded（渲染侧自证不算）；采样窗 ≥10s 拖动/滚动，几何差 ≤1px 且无稳定偏移才 PASS（G-02、C-3）。
- **W-22/W-30 内存**：按 W-30 采样方法出曲线；kill 单个 web content process 后要求失败条 + reload 重建 + forward record 仍属该 tab 且可用（G-08）。
- **W-19 z-order**：纯表达式只测 occluded 标志；真遮挡以真机截图 region diff + 命令面板/对话框/toast 等浮层负例为准（含 9 点命中 + overlay 候选 selector 两种路径）（G-03）。
- **W-17 新桥越权**：除通道存在外，加伪造 tabId/lease、跨 frame 调用的拒绝反例；每通道绑定 lease capability（G-05）。
- **禁止**把 CI 层 PASS 抄进真机证据行；真机项「未跑」只能记 INFO/未判，不得记 PASS。

## F. 官方行证据（只读核对）

1. 在 pin 的 `dsh-web-app/cordis.patch.yml` 确认该行条件：`disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`。
2. 在 `packages/control-plane/src/spawn-dsh.ts` 确认宿主恒以 `--profile web` 启动。
3. 实测：`POST /api/i/<source>/api/clientGraph/graph` 的 entries 不含 `@deepseek-ai/dsh-client-ui-sidebar-browser`（web profile 的 75 行图）。
4. 结论：不需要 covered/skip 条目；若 chamber 未来提供 desktop profile，再按 design 28 §1/§5 处理重复入口。

## G. 构建 / 锁文件

~~~sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm run typecheck:browser
pnpm run build:renderer
# ARCHIVED（Electron 冻结）：pnpm run build:preload
pnpm run build:sidecar
pnpm run test:swift      # darwin
pnpm run test:macos      # darwin
pnpm run check:full
~~~

期望：锁文件无 diff；新包/chunk budget 通过；A 桥计数与命名空间以 `packages/desktop/bridge-manifest.json` 的 counts 为准（`browser` 命名空间按 design 28 §3 进 `bridge-swift-only-additions.json` 白名单并重生成 manifest 三件），shim surface 计数以 `node scripts/gates/checks/verify-shim-payload-shape.mjs` 的 `EXPECTED_SURFACE` 为准；打包闭包根模块数复核命令见 [packaging-closure-checklist.md](../release/packaging-closure-checklist.md) §4。

## 验收记录

- 在 [`../../progress/STATUS.md`](../../progress/STATUS.md) 只保留仍开放的项；完成项移入设计/发布记录。
- 每条失败给出：命令、平台、源类型、错误码、是否 fail-closed、是否阻塞发布。
