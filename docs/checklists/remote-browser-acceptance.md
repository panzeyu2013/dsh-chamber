# Remote Browser 验收清单（design 28）

状态：开放项清单；自动化证据与真机步骤分开。不要在本文件记录版本号、批次日志或已完成的叙事。

## 0. 前置

- 当前 pin 的 vendor 树已填充（`vendor/harness-checkout` 非空）。
- `node_modules` 已安装；锁文件与 workspace 一致。
- 有一个 dsh 或 gateway 的 SSH 源（或按 B/C/D 使用临时本地夹具）；本地实例也应出现入口（无远端分区）。
- 入口 = 除 http 外全部来源：local、dsh+ssh、gateway+ssh 出现；gateway+http 不出现。
- v2 内嵌：默认所有支持来源内嵌 iframe（design 28 §16.2）；远端端到端腿需要**真实 SSH 源**且该主机
  `127.0.0.1:<port>` 上真有一个可服务的页面（`--embed-port <port>` 显式给出）。**本机夹具**：`--dev --ssh-fixture`
  一次性 sshd/agent + 临时 remote dsh（预置 chamber host-graph seed）+ 回环 cookie 注入代理 + fixture 页 +
  dev userData 预置（app known_hosts、ssh-instances.json、forward 端口预授权）；真实 SSH 隧道/alias/iframe/
  关 tab 释放全链路本机可跑，不依赖外部主机（失败 loud、收尾回收端口）。local 直连腿用
  工具箱自起的 in-process fixture（无需 SSH），只在一次性实例（`--dev`）上驱动。

## A. 自动化（Linux，已可在本仓库跑）

~~~sh
node --test packages/desktop/test/forward/*.test.ts
node scripts/gates/verify-test-wiring.mjs
node scripts/gates/verify-no-dead-exports.mjs
node scripts/gates/verify-import-cycles.mjs
node scripts/gates/verify-file-budgets.mjs
node scripts/gates/verify-package-boundaries.mjs
node scripts/gates/verify-shim-payload-shape.mjs
node scripts/gates/verify-md-links.mjs

# v2 内嵌腿（纯判据 + 假 DOM；CI）：W-13/14a/14b/15/15b/SH-7 的判定层
pnpm run test:gui-acceptance
# v2 内嵌腿（需 GUI）：local fixture 真跑 + 系统浏览器出口 + 关 tab 释放——`--dev`/CDP 腿已随 Electron 冻结归档，
# 原生壳界面按真机/目检执行（gui-acceptance-checklist §4）；确需复活时按 electron-frozen.md §6 显式传 --flavor electron。
# v2 远端端到端：本机 ssh fixture 同为归档 CDP 驱动；真实 ssh 源按本文 L5 真机矩阵执行（原生命令见 §L5）
# 或真实 ssh 源 + 已人工预开的斜签：--require-embed 把未执行的内嵌腿改判 FAIL
node scripts/gui-acceptance/run.mjs --attach --require-embed --embed-port <remote-loopback-port>
~~~

- `forward-real-ssh.test.ts`：临时 sshd + 真实 `ssh -N -L` + alias HTTP 取回 + release；key-auth，Linux/root。
- `forward-spawn.test.ts`：真实 spawn + `/proc` start-time + ledger + 幂等 stop。
- `forward-windows.test.ts`：CIM/CommandLineToArgvW 纯解析；真实 Windows 见 C。
- 期望：全部绿；非 Linux/非 root 的 real-ssh 用例自动 skip。

## B. Askpass（真机/特权环境）

本仓库的 Linux 测试环境 `/etc/shadow` 只读，不能在自动测试里安全建临时密码账户；用一次性主机或容器执行：

1. 用一次性用户/容器启动 sshd：`PasswordAuthentication yes`、`UsePAM yes`、仅监听 127.0.0.1，临时 authorized_keys 不需要。
2. 让 askpass 脚本只回显测试密码；`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force` 经 launcher 的 lease env 注入。
3. 请求一个 remote loopback 端口的 forward；期望 bound，alias URL 可取回测试 HTTP body。
4. release 后：子进程退出、ledger 清空、askpass lease 释放恰好一次；无密码/URL 进日志环。
5. 测试结束删除临时用户/容器；不得改真实 `/etc/shadow`。

## C. Windows（真机）

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
4. 如需让 macOS 具备自动回收，先单独评审 exact-argv 适配器（不要以“近似 argv”替换）。

## E. S2 GUI 走查

1. 右栏指南/标签在 local、dsh+ssh、gateway+ssh 源出现；gateway+http 不出现；缺 `sidebarRightTabs` 时诚实缺席。
   **必须覆盖非首个 boot 的来源**：页面打开后（首个 boot 通常是本地实例）切到另一个来源，再展开
   右栏——入口必须同样出现。旧实现只在页面首个 boot 注册该页签，此步会失败（注册表是宿主图行，
   晚于 deferred chunk；一次性探测只在首个 boot 赢）。
2. 地址栏任意 http(s) URL（含 https/公网）→ 上游 iframe 直连；系统浏览器只经工具栏 external 按钮，不自动转。
3. 地址栏 `http://127.0.0.1:<port>/path`（v2 默认内嵌）：ssh 源 → ensure forward → 面板内 iframe 载入
   main 构造的 **alias** URL（127.0.0.2–254；面板显示逻辑地址，不显示 alias 主机）；https/证书不匹配按上游 iframe
   载入（engine 错误页/失败条 + external 出口；不自动切系统浏览器、不点穿）。local 源：同一地址**直接 iframe**
   （不建 forward、面板无远端分区），系统浏览器是上游 BrowserBody 工具栏的显式出口。
   gateway+ssh 源：与 dsh+ssh 同一路径（forward 复用该来源的 SSH 隧道）。
4. 两 source 同端口：各自 alias；cookie 探针隔离；不存在共享 127.0.0.1。
5. 端口冲突 → ephemeral；stale/重开；console 关闭不杀；退出回收。
6. 错误/上限/no-bridge/空态/a11y（role=alert/status）可见。
   v2 默认路径是**上游 iframe**（design 28 §16.11）：任意 http(s) 都在面板内载入，系统浏览器只走工具栏
   external 显式出口（上游不把 XFO/TLS 失败投影进 UI，见 E2 步 4）；E2 的步 1–7 覆盖内嵌面。
7. per-port 确认：5173 确认后，5174 再次弹窗；同端口不再弹；dialog 期间 retarget 返回
   `confirmation_late` 且没有新 listener。
8. 官方 `ui-sidebar-browser` 未同时出现（web profile 恒禁用，F 已核实）。

## E2. v2 内嵌面（design 28 §16.9/§16.11；机器腿 W-13…W-15b + SH-7 + 真机）

判据权威 = design 28 §16；机械腿由 `scripts/gui-acceptance` 驱动（判据在 `checks.mjs`，CI 单测 + 假 DOM），
本段只固定步骤与留痕：

0. **上游同源性（静态，先跑）**：`packages/dsh-chamber-client-ui-browser` 的 BrowserNavigation/BrowserPage/
   BrowserPersistence/url/Presentation/BrowserTitle/CSS/locales(8 语言)/`src/index.ts` 与 vendor `ui-sidebar-browser`
   逐字节相同（SHA-256 锁在包测试）；带注释标记的 diff = `ForwardFrameResolver.ts`（SSH 反代：iframe src + 代理页
   external alias）+ `IframeImpl.ts` 异步 src seam/`forwards`/externalUrl + `IframePresentation.ts`/`pages.ts` +
   `BrowserFrame.externalUrl`/`BrowserBody` external 投影 + `definition.tsx`（id）+ `client/index.ts`/新增
   `registry-wait.ts`（source gate/就绪等待）+ 新增 `shared/{source,forward-bridge}.ts`；`BrowserController/store`
   仅 TabId 类型适配；命令 = `node packages/dsh-chamber-client-ui-browser/scripts/test.mjs`。不成立 = FAIL（行为/样式不再保证上游一致）。

1. **W-13 入口/面板结构（`--dev`）**：前置=先有可见 Session（右栏 surface 按 Session 渲染）——冷实例由
   走查经既有 UI 建一次性工作区/会话（new-session 控件 → 无工作区时 hero 工作区入口 → 浏览式目录对话框选
   `<--out>/workspace`；dsh 空态选工作区即生成空白会话），`--attach` 默认必须先人工选中一个会话（否则 INFO）；仅一次性/打包态 smoke 可用 `--attach --attach-create-session` 显式允许经同一 UI 路径建会话。
   随后右栏 guide 出现「浏览器」入口（上游 `[data-sidebar-right-guide-entry="browser"]`，kind 定位、不靠文案）→ 开页签 →
   上游 BrowserBody 恰一个可见（地址栏 `input[aria-label=上游 placeholder]`、toolbar back/forward/reload/go/external、
   sandbox 开关 aria-pressed、content `aria-busy` 可读）；上游无自研 panel/phase/远端分区概念。多来源实例另用
   `--attach`：切到非首个 boot 的来源再展开右栏，入口必须同样出现（见 E.1）。
2. **W-14a local 直连真跑（`--dev`）**：工具自起 127.0.0.1 fixture → 地址栏输入**显式** `http://127.0.0.1:<port>/`
   （上游裸地址默认 https）→ iframe 恰一、`src` 指向本次 fixture、`data-sidebar-browser-frame="iframe"`、
   `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`、
   `referrerpolicy=no-referrer`、地址栏保持逻辑地址，并**收到 fixture 的 `postMessage`**（跨源文档真的运行了；
   空白 iframe 不算通过）；上游不提供 name/title 契约，不做断言。
3. **W-14b remote 端到端（`--ssh-fixture`，或 `--attach` + 真实 ssh 源 + `--embed-port`）**：窗口切到该
   dsh/gateway+ssh 来源（活动视图）并打开浏览器页签 → 地址栏输入显式 `http://127.0.0.1:<port>/` → iframe 的 src 是
   per-source **alias**（127.0.0.2–254，绝不是 127.0.0.1/远端地址）、上游 sandbox/referrer 契约、地址栏仍显示逻辑
   地址、**收到 fixture 的 postMessage**；上游 fork 已删除 attached 行 UI，租约由 alias+postMessage+关 tab 后
   alias 不可达共同证明。前置缺失时终端 loud SKIP（INFO），`--require-embed` 改判 FAIL——**不得**用无 SSH 的运行
   冒充这条腿。`--attach` 跑完后手动关闭该浏览器页签以释放这条 forward；释放判据见 W-15b 与 L5。
   **打包态**：已构建 `release/<platform>-unpacked` 时运行
   `xvfb-run -a node scripts/gui-acceptance/packaged-ssh-smoke.mjs --binary <packaged executable>`；
   它用同一 SSH fixture 预置一次性 userData/ssh-agent、启动打包可执行并跑 W-13…W-15b（含本步 W-14b），
   不碰真实 userData/~/.ssh。
4. **W-15 系统浏览器出口（上游语义，`--dev`）**：fixture `/embed-xfo`（`X-Frame-Options: DENY`）→ 上游
   **不承诺** XFO/TLS 失败探测（不要求 refusing/失败条）；断言 iframe 尝试了该显式 http 地址、external 按钮存在
   且可点、装载时**不自动打开**、点击后 `window.open(逻辑地址,'_blank','noopener,noreferrer')` 恰一次（witness
   stub 掉真实打开）；观察到的上游失败条仅作证据（无失败条 = 上游限制，不判红）。代理页（SSH remote
   127.0.0.1）的 external 目标是 main 合成的 alias（`frame.externalUrl`），不是本地不可达的远端逻辑 URL；
   转发目标解析中（attach 未定）与 attach 失败时 external 禁用（不误开本机 127.0.0.1）；direct 页面仍用 `target.url`。
5. **W-15b 关 tab 即释放（`--dev` local 版 / 真机远端版）**：点页签关闭钮 → 上游 BrowserBody 与 iframe 移除、
   无 pending（`aria-busy`/重建观察窗）；有 forward 的版本还要求 alias 端口 ECONNREFUSED（未知可达性不算已释放）。
   远端释放腿 = L5 headless 真 sshd 或真机。
6. **SH-7 CSP frame-src 合同（`--live`，纯 HTTP）**：桌面壳 CSP 的 `frame-src` 精确等于 v2 源集
   （`blob:` + `http://127.0.0.1:*` + `http://localhost:*` + 127.0.0.2–254 + 裸 `http:`/`https:`，共 258 源，
   头 ≤8KB），`frame-ancestors 'none'` 仍在；**不得**出现 `'self'`/`*`/`data:`。gateway/cli/standalone
   保持 v1 `frame-src blob:`（不得放宽；控制面缺省逐字节不变由单测锁）。
7. **真机（现行 = Swift .app；Electron 半边 ARCHIVED）**：Swift .app 一次（Electron 打包态随 flavor 冻结归档，
   复活后再补跑）——远端 dsh+ssh / gateway+ssh 的
   loopback 页面内嵌/关闭释放；上游 system-browser 出口（上游不承诺 XFO/TLS 失败 UI）；任意 http(s)（含 https、
   公网）iframe 载入与证书错误形态；跨源 cookie/登录；`target=_blank`/下载的沙箱+壳安全门；iframe 内外键盘/焦点差异；
   远端页面不能改 chamber 状态（AC8 的 iframe 版）。Swift 的 ATS/子 frame 导航（任意 http(s)）/下载判据在
   design 28 §16.8/§16.11，真机矩阵按 design 25 §8.5。

记录：每条给「命令 + 平台 + 源类型 + 结果（PASS/FAIL/INFO 原因）+ 截图/报告路径」；INFO 不等于通过。

## F. 官方行证据（只读核对）

1. 在 pin 的 `dsh-web-app/cordis.patch.yml` 确认该行条件：
   `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`。
2. 在 `packages/control-plane/src/spawn-dsh.ts` 确认宿主恒以 `--profile web` 启动。
3. 实测：`POST /api/i/<source>/api/clientGraph/graph` 的 entries 不含
   `@deepseek-ai/dsh-client-ui-sidebar-browser`（web profile 的 75 行图）。
4. 结论：不需要 covered/skip 条目；若 chamber 未来提供 desktop profile，再按 design 28 §5.1 处理重复入口。

## G. 构建/锁文件

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

期望：锁文件无 diff；新包/chunk budget 通过；bridge manifest **58/9/67**（invoke/push/total，v2 不新增通道）；
surface 11/63/54/9；packaging closure **100**（根模块数）；GUI walkthrough 通过（v2 内嵌腿见 E2）。

## 验收记录

- 在 `docs/progress/STATUS.md` 只保留仍开放的项；完成项移入设计/发布记录。
- 每条失败给出：命令、平台、源类型、错误码、是否 fail-closed、是否阻塞发布。
