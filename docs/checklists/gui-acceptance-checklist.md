# GUI 验收 Checklist

> **这不是新的阻断门，也不是判据的第二份副本。** 判据权威在 `docs/design/`（契约）与
> `docs/progress/STATUS.md`（开放实机门禁）；本清单只固定**流程**：跑什么、看什么、留什么证据。
> 一旦某项的判据要改，改 design/STATUS，本文件只跟着改指针。
>
> 工具箱：`scripts/gui-acceptance/`（`scripts/gui-acceptance/README.md` 是它的说明与边界）。

## 0. 选择腿

| 腿 | 何时用 | 命令 | 产物 |
|---|---|---|---|
| 机械 A（只读探测） | **每次改动控制面/反代/静态壳后**；也可对安装态跑 | `pnpm run acceptance:gui` | `.tmp/gui-acceptance/gui-live-report.md` |
| 机械 B（界面走查） | **每次改动 renderer / 侧栏 / 设置面 / 布局后** | `pnpm run acceptance:gui -- --attach`（已有 dev 实例）或 `-- --dev`（自起自关） | `gui-walkthrough-report.md` + `shots/*.png` |
| 目检 | 机械腿跑完后按 §3 逐条看图 | 人 | 截图 + 一句结论 |
| 打包态/真机 | 发布前或涉及安装包、更新、深链、通知、运行时事务时 | 见 §4 + STATUS | 见 §4 |

前置与已知边界见工具箱 README（`--dev` 的构建产物前置、沙箱内需
`--electron-arg=--no-sandbox`、GUI 腿不进 CI、只读/不点击变更控件）。

## 1. 机械 A：只读运行态（`--live`）

| 项 | 检查 id | 判据来源 |
|---|---|---|
| 控制面存活（GET/HEAD `/health`）、本地连接行、写者静默诊断、主机日志、SSE 健康推送 | `CP-1`…`CP-6` | design 04 §3；02 §3.4（写者静默）、§3.8（日志） |
| 信任边界：敌意 Origin 403、非 origin-form（`//`、反斜杠）400 | `CP-7`…`CP-10` | design 04 §3（CORS/目标形态）；03 §3.3（代理诚实） |
| 静态壳：index + 安全头（CSP/XFO/nosniff/referrer）、声明资源全 200、缺失 404、深路径回落 | `SH-1`…`SH-5` | design 04 §3、§4.3（响应头权威） |
| 静态路径穿越围栏 | `SH-6` | design 04 §4 |
| 每实例反代：前端文档、声明资源、多入口插件包（**含 `rev` 查询**）、未知实例诚实报错、穿越围栏 | `IP-1`…`IP-5` | design 03 §3 / 04 §4 / 09 §3.6 |
| 升级（`remote.mux`）：敌意 Origin 403、自身 Origin 101 | `IP-6`、`IP-7` | design 03 §3、04 §4 |
| 多来源：桌面注册表里的每个来源经同源前缀返回**自己的**前端与资源；不可用来源如实报告 | `MX-1`、`MX-2` | design 05 §2、09 |
| 实例端口无凭据直连被拒（401） | `IN-1` | design 02（宿主托管/凭据） |

**通过判据**：无 `FAIL`。`INFO` 是环境事实、不是通过：

- 安装态早于 2026-09-10 时 `CP-4` 无该路由；`CP-4` 的判据是 `quiescent === true`（`writers` 里如实列出 `reclaimed` 孤儿是正常的，`kept` 才是活写者）。
- 实例未就绪（`dsh.status != ready`）时 `IP-*` / `IN-1` / `CP-5` 转 INFO（design 18 §3.4 隔离期 503 属预期）。
- `--dev` 的干净状态没有远程来源（`MX-*` 记 INFO）。

已登记容忍（`clientGraph/graph` 冷启动 503、SSE 重订阅的 `net::ERR_ABORTED`、上游 cordis 启动日志）逐条写在 `scripts/gui-acceptance/README.md`——**要放宽一项就先改那里，不要在工具箱里"猜"**。

## 2. 机械 B：界面走查（`--attach` / `--dev`）

| 项 | 检查 id | 判据来源 |
|---|---|---|
| 壳启动并挂载实例视图（`[data-instance]`） | `W-1` | design 09 §3.2 |
| 侧栏多来源结构（`[data-chamber-section]` / `[data-chamber-row]` / `[data-session-id]`） | `W-2` | design 05 §2、06 |
| 首启模态可关闭/可走完（非首启记 INFO） | `W-3` | design 05 §5（onboarding 阶段） |
| 侧栏折叠/展开（`aria-expanded` 导轨开关） | `W-4` | design 06（layout 持久化） |
| 设置面从侧栏座席打开、插槽渲染且**无 `[data-slot-error]`** | `W-5`、`W-6` | design 05 §5（完整桥接） |
| 设置导航项存在、每个设置页渲染内容、页面切换真的换内容 | `W-7`…`W-9` | design 05 §5 |
| 真实 Escape 键关闭设置面 | `W-10` | design 05 §5 |
| 走查期间无**未预期**的 ≥400 请求、无**未预期**的渲染层 error | `W-11`、`W-12` | 容忍清单见工具箱 README（诚实性基线） |

## 3. 目检腿（机械腿不能替代的部分）

逐张看 `shots/`，只判"人眼才能判"的事；**看不出来就写"未判"**，不要写成通过：

- 首帧与切换：骨架→内容无 FOUC/双骨架；侧栏、设置面在浅/深色下都不漏底、不叠字（design 06 §4.6）。
- 设置面：导航高亮跟随、来源下拉显示当前来源、每页标题与分组层级正确（design 05 §5）。
- 多来源侧栏：分组归属（来源 → 工作区 → 会话）、状态点、待办条带与角标不串行（design 05/06）。
- 失败呈现：任何降级/不可达是否**如实**显示（比"没坏"更重要，design 03 §3.3）。

## 4. 打包态 / 真机腿（本工具箱不覆盖）

以下只能在打包态或真机上判，逐条门禁见 `docs/progress/STATUS.md`（不要在本文件复述判据）：

| 面 | 权威 |
|---|---|
| 安装/更新事务、quitAndInstall、缓存清理 | design 11 §9 |
| dsh 运行时版本事务（激活/回退/恢复） | design 18 §3.5–§3.6、§9 |
| 通知与未读徽标、Dock/托盘/任务栏三形态 | design 19 |
| open-in 拉起外部应用、图标、深链冷热启动 | design 16、20 §6/§10 |
| Git worktree 全链（真实远程 Linux 仓库） | design 08 |
| 归档管理器与 force 清理链（含 2026-09 保护修正三态：无会话打开仍可删 + 顶部降级说明行 / 正在查看的会话所在树被 `skippedProtected` 跳过 / 归档即终止） | design 24 §5、§13 |
| gateway 形态（生产 TLS、`/chamber/*`、移动端） | design 17、21 §9 |
| 移动端 Web 面（真机触控档、安全区、键盘） | design 17 §18.6 |
| Linux 桌面 / Windows 首版 | design 22 §7、23 |

## 5. 证据与记录纪律

- PR 里附：`gui-live-report.md`（或 `.json`）与 `gui-walkthrough-report.json` + 关键截图；
  目检结论逐条一句（"看了什么、看到什么、哪条未判"）。
- **不写进 STATUS.md**：跑过、通过、轮次、计数。STATUS 只记**仍然开放**的门禁与取舍；
  本轮跑绿不改变它的内容，除非验收暴露了新的开放项或让某条开放项失效。
- 机械腿的 `INFO` 若要变成门禁，改 design/checklist 的判据，而不是让工具箱"猜"。
