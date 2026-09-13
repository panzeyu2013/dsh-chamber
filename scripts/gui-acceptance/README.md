# scripts/gui-acceptance — GUI 验收工具箱

面向维护者的**可执行证据产生器**：把 `docs/checklists/gui-acceptance-checklist.md` 里
标 `[机械]` 的项目跑一遍，产出固定 schema 的报告 + 截图，供 PR / issue 附证据。

**它不是新的阻断门**：判据的权威仍在 `docs/design/`（契约）与
`docs/progress/STATUS.md`（开放实机门禁），本目录只负责**跑**与**留痕**——所以正文不复制
判据，避免出现第二份会漂移的台账。

| 文件 | 用途 |
|---|---|
| `run.mjs` | 单一入口：`--live` / `--attach` / `--dev` |
| `probe.mjs` | `--live`：对**运行中的应用**做只读 HTTP/WS 探测（安装态亦可，无 CDP） |
| `walkthrough.mjs` | CDP 界面走查：结构断言 + 截图 + 控制台/网络事实采集（含 `W-4b` 行悬停卡片的真实指针开合） |
| `launch.mjs` | `--dev`：一次性 dev 实例（隔离 user-data、固定控制面端口、CDP 端口） |
| `cdp.mjs` | 零依赖 CDP 客户端（Node 内置 `WebSocket`/`fetch`） |
| `checks.mjs` | **纯判据层**：全部 pass/fail 逻辑在此，无 IO，故可在 CI 单测 |
| `gui-acceptance.test.mjs` | `checks.mjs` 的单测（`pnpm run test:gui-acceptance`，CI 跑） |

## 命令

```sh
pnpm run acceptance:gui                      # --live：探测运行中的应用（只读，最安全）
pnpm run acceptance:gui -- --attach          # 对已带 CDP 的 dev 实例做界面走查
pnpm run acceptance:gui -- --dev             # 自起 dev 实例 → 走查 → 自动关闭
pnpm run acceptance:gui -- --live --sources gateway-a,gateway-b   # 显式指定要扫的远程来源
pnpm run test:gui-acceptance                 # 纯判据单测（无需 GUI，CI 跑）
```

产物默认写 `.tmp/gui-acceptance/`（gitignored，**不污染仓库**）：

- `gui-live-report.md` / `.json`、`dev/gui-live-report.*`（`--dev` 的实例侧）
- `gui-walkthrough-report.md` / `.json`、`shots/*.png`
- `dev-app.log`（`--dev` 的 Electron 日志）、`dev-user-data/`（隔离状态）

退出码：有 `FAIL` 即 1；`INFO`（环境不适用，或命中"已登记容忍"）不判失败。

## 已登记容忍与策略（判据的例外都写在这里，不藏在代码里）

| 情形 | 处置 | 依据 |
|---|---|---|
| `clientGraph/graph` 冷启动期 503 | 记为**容忍**（原始文本仍入报告） | design 09 §3.2：`client/serving-gate.ts` 头注——实例未 serving 时反代拒转发，属预期 |
| `api/host/health-events` 的 `net::ERR_ABORTED` | 记为**容忍** | 页面自身重订阅/关闭 SSE 时浏览器记客户端 abort；服务端掉线会是状态码或别的错误串，仍判失败 |
| `[cordis-client-runner] … has no active Connection` | 记为**上游噪声**（原始文本仍入报告） | 上游 `cordis-client-runner/src/client/inspect-registry.ts` 启动期日志，非 chamber 缺陷 |
| 首启向导（`settings.onboarding`） | `--dev` 会**走完**（优先点关闭动作，最多 4 步自动推进）；`--attach` **绝不代点**，记 INFO 并跳过设置面走查 | 推进向导会写实例自身状态：只允许发生在一次性实例上 |
| 实例未就绪（`dsh.status != ready`） | 实例面检查（`IP-*`/`IN-1`/`CP-5`）转 **INFO** 并说明隔离期 503 属预期 | design 18 §3.4 |
| 实例没有可悬停的侧栏行（只有来源头，按设计无卡片） | `W-4b` 记 **INFO** 并写明未执行 | design 06 §7（来源头不是卡片锚点） |
| 安装态早于 2026-09-10（无 `/writers` 路由） | `CP-4` 记 INFO | 该路由由 9767853 引入 |

`CP-4` 的判据是 `quiescent === true`（**不是** `writers` 为空）：扫描到的 `reclaimed` 孤儿会如实列出，只有 `kept`（无法回收）才代表有无法解释的活写者。

## `--dev` 的干净退出

退出顺序：`DELETE /api/connections/local`（让应用自己停掉托管实例）→ 杀 Electron 进程组 → 按端口回收**本仓 `packages/desktop/vendor/dsh` 下的**遗留进程。第三道只认这个 cwd，因此不会碰到打包版自己的实例（17510）。`--keep` 可跳过关闭以便人工接管（此时请自行收尾）。

## 前置条件

- **`--live`**：应用已在跑（打包态或 dev 均可）。只发 GET/HEAD、读一帧 SSE、做原始
  upgrade 握手；**不发任何写请求**，可安全用于有真实会话的安装态。
- **`--attach`**：dev 实例已带 `--remote-debugging-port=9333`（与 `scripts/perf` 同一约定）。
- **`--dev`**：需要构建产物就位——`packages/desktop/dist/{web,preload.cjs,control-plane}` 与
  `packages/desktop/vendor/dsh/node_modules`（缺哪一项会**直接报出该跑哪条命令**，不隐式构建）。
- 在沙箱/容器里跑 Electron 需要 `--electron-arg=--no-sandbox`（Chromium 沙箱无法嵌套）。

`--dev` 与运行中的打包版**互不干扰**：独立 user-data（自己的锁/状态/注册表/凭据）、
控制面从 17520 起自动退避（本工具箱默认固定 17530）；其托管 dsh 若发现 17510 已占用会
自行让位。dev 模式不注册 `dsh-chamber://` 协议，故不会抢打包版的深链。

## 断言的取向（为什么这样写）

- **只用仓库已有的 DOM 契约**，不新增测试钩子、不靠文案匹配：
  `[data-instance]`（每实例壳）、`[data-chamber-section]` / `[data-chamber-row]`（多来源侧栏）、
  `[data-slot]` / `[data-slot-error]`（设置面渲染位）、`dialog nav [class*="navList"] > button`（设置导航项）。
- 仅两处与语言耦合（侧栏「设置」座席、首启模态的关闭动作）走 zh/en 白名单，匹配不到就记
  `INFO` 并留下截图，交给目检——不假装通过。
- **点击白名单**：只点设置导航项与上述两个动作，因此按不到「启动/停止/保存/删除」这类
  变更控件；整个走查不产生数据写入。
- GUI 腿需要 display/打包态，**不进 CI**；进 CI 的只有 `checks.mjs` 的纯判据单测。

## 与其它工具的关系

- `scripts/perf/`：性能测量尺子（同一套 CDP 前置，采 DOM/堆/帧间隔）；本工具箱管**功能验收**。
- `pnpm run smoke`：控制面 × 真 dsh 的无头端到端；本工具箱管**界面与同源反代面**。
- `acceptance:runtime:*`：dsh 运行时管理器（无头）。
