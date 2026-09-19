# GUI 验收 Checklist

> 这不是新的阻断门，也不是判据的第二份副本。 判据权威在 `docs/design/`（契约）与 `docs/progress/STATUS.md`（开放实机门禁）；本清单只固定流程：跑什么、看什么、留什么证据；判据要改就改design/STATUS，本文件只跟指针。工具箱 `scripts/gui-acceptance/`（说明、已登记容忍与边界见 `scripts/gui-acceptance/README.md`；放宽容忍先改那里，不在工具箱里猜）。

## 0. 选择腿

|腿|何时用|命令|产物|
|---|---|---|---|
|机械A（只读探测）|每次改动控制面/反代/静态壳后；也可对安装态跑|`pnpm run acceptance:gui`|`.tmp/gui-acceptance/gui-live-report.md`|
|机械B（界面走查）|每次改动renderer / 侧栏 / 设置面 / 布局后|`pnpm run acceptance:gui -- --attach`（已有dev实例）或 `-- --dev`（自起自关）|`gui-walkthrough-report.md` + `shots/*.png`|
|目检|机械腿跑完后按 §3逐条看图|人|截图 + 一句结论|
|打包态/真机|发布前，或涉及安装包、更新、深链、通知、运行时事务|见 §4 + STATUS|见 §4|

前置：`--dev` 需先有构建产物；沙箱内需 `--electron-arg=--no-sandbox`；GUI腿不进CI，只读、不点变更控件。

## 1. 机械 A：只读运行态（`--live`）

|项|检查id|判据来源|
|---|---|---|
|控制面存活（GET/HEAD `/health`）、本地连接行、写者静默诊断、主机日志、SSE健康推送|`CP-1`…`CP-6`|design 04 §3；02 §3.4（写者静默）、§3.8（日志）|
|信任边界：敌意Origin 403、非origin-form（`//`、反斜杠）400|`CP-7`…`CP-10`|design 04 §3（CORS/目标形态）；03 §3.3（代理诚实）|
|静态壳：index + 安全头（CSP/XFO/nosniff/referrer）、声明资源全200、缺失404、深路径回落|`SH-1`…`SH-5`|design 04 §3、§4.3（响应头权威）|
|静态路径穿越围栏|`SH-6`|design 04 §4|
|每实例反代：前端文档、声明资源、多入口插件包（**含 `rev` 查询**）、未知实例诚实报错、穿越围栏|`IP-1`…`IP-5`|design 03 §3 / 04 §4 / 09 §3.6|
|升级（`remote.mux`）：敌意Origin 403、自身Origin 101|`IP-6`、`IP-7`|design 03 §3、04 §4|
|多来源：桌面注册表每个来源经同源前缀返回自己的前端与资源；不可用来源如实报告|`MX-1`、`MX-2`|design 05 §2、09|
|实例端口无凭据直连被拒（401）|`IN-1`|design 02（宿主托管/凭据）|

通过判据：无 `FAIL`。`INFO` 是环境事实、不是通过：

- 旧安装态没有该路由时 `CP-4` 记INFO；判据 `quiescent === true`（`writers` 列 `reclaimed` 孤儿正常，`kept` 才是活写者）。
- 实例未就绪（`dsh.status != ready`）时 `IP-*` / `IN-1` / `CP-5` 转INFO（design 18 §3.4隔离期503属预期）。
- `--dev` 干净状态无远程来源（`MX-*` 记INFO）。

## 2. 机械 B：界面走查（`--attach` / `--dev`）

|项|检查id|判据来源|
|---|---|---|
|壳启动并挂载实例视图（`[data-instance]`）|`W-1`|design 09 §3.2|
|侧栏多来源结构（`[data-chamber-section]` / `[data-chamber-row]` / `[data-session-id]`）|`W-2`|design 05 §2、06|
|首启模态可关闭/可走完（非首启记INFO）|`W-3`|design 05 §5（onboarding阶段）|
|侧栏rail折叠/展开：控件结构定位（侧栏头部图标钮，按计算可见性只取可见视图；候选为空或并列即FAIL）+ 效果锚定（官方frame属性 `[data-sidebar-collapsed]` 出现/消失；复原用同一元素、按身份寻址）+ 写入边界（本次点击不得改动 `dsh-chamber.sidebar.v1`）；点错控件、未复原、定位不到、写了偏好都FAIL|`W-4`|design 06 §3.1（ui-layout fork的折叠与宽度共享）、05 §6|
|来源级收拢：来源节整列表收拢且几何可见（`aria-expanded` 翻转 + 来源节高度收缩、展开恢复；几何非有限数即FAIL）+ 往返后不留持久化残留（`sourceFolded`；快照读不到按未检查FAIL）；只覆盖首个来源节；会写该偏好，**只在 `--dev` 跑**，`--attach` 记INFO|`W-4a`|design 06 §2.4、§3.1（`sourceFolded`）|
|行悬停卡片（`[data-chamber-hovercard]` 计数）：悬停升起一张、含该行标题、移开消失；竞态腿先测本机dwell→React提交窗口（~5ms轮询标记，最后未见时刻为严格下界，多次取最大），再由 `raceBandForWindow()` 取确定性偏移、12次试验0搁浅（`dwell+10..60ms` 仅下界不可判别——见README；窗口测不到或 ≤2ms记「不具区分力」INFO，绝不记PASS）；A→B换行至多一张且收在B；blur / `visibilitychange`（hidden）清卡（实例确无可悬停行时INFO；有锚点形状却无 `[data-chamber-hovercard-anchor]` 记FAIL）。INFO**只**表示「没执行/没区分力」：结束行报 `（N 项 INFO 未执行）`；要真跑真判别用 `--require-hover`，四条腿INFO一律改记FAIL|`W-4b`、`W-4b-race`、`W-4b-swap`、`W-4b-dismiss`|design 06 §7（悬停卡片：锚点/搁浅/互斥/失焦清卡）|
|设置面从侧栏座席打开、插槽渲染且**无 `[data-slot-error]`**|`W-5`、`W-6`|design 05 §5（完整桥接）|
|设置导航项存在、每个设置页渲染内容、页面切换真的换内容|`W-7`…`W-9`|design 05 §5|
|真实Escape键关闭设置面|`W-10`|design 05 §5|
|走查期间无未预期的 ≥400请求、无未预期的渲染层error|`W-11`、`W-12`|容忍清单见工具箱README（诚实性基线）|

`W-4` 控件**不带 `aria-expanded`**（上游只有会翻转的 `aria-label`）：按 `pickRailToggle`（`checks.mjs`）结构定位、用官方frame属性判效果；`W-4a` 判来源级整列表收拢（几何须可见），写偏好、只跑一次性实例。

## 3. 目检腿（机械腿不能替代的部分）

逐张看 `shots/`，只判「人眼才能判」的事；看不出来就写「未判」，不要写成通过：

- 首帧与切换：骨架→内容无FOUC/双骨架；侧栏、设置面在浅/深色下都不漏底、不叠字（design 06 §4.6）。
- 设置面：导航高亮跟随、来源下拉显示当前来源、每页标题与分组层级正确（design 05 §5）。
- 多来源侧栏：分组归属（来源 → 工作区 → 会话）、状态点、待办条带与角标不串行（design 05/06）。
- 失败呈现：任何降级/不可达是否如实显示（比「没坏」更重要，design 03 §3.3）。

## 4. 打包态 / 真机腿（本工具箱不覆盖）

只能在打包态或真机上判，逐条门禁见 `docs/progress/STATUS.md`（不在本文件复述判据）：

|面|权威|
|---|---|
|安装/更新事务、quitAndInstall、缓存清理|design 11 §9|
|dsh运行时版本事务（激活/回退/恢复）|design 18 §3.5–§3.6、§9|
|通知与未读徽标、Dock/托盘/任务栏三形态|design 19|
|open-in拉起外部应用、图标、深链冷热启动|design 16、20 §6/§10|
|Git worktree全链（真实远程Linux仓库）|design 08|
|归档管理器与force清理链（保护三态：无会话打开仍可删 + 顶部降级说明行 / 正在查看的会话所在树被 `skippedProtected` 跳过 / 归档即终止）|design 24 §5、§13|
|gateway形态（生产TLS、`/chamber/*`、移动端）|design 17、21 §9|
|移动端Web面（真机触控档、安全区、键盘）|design 17 §18.6|
|Linux桌面 / Windows首版|design 22 §7、23|

## 5. 证据与记录纪律

- PR里附 `gui-live-report.md`（或 `.json`）与 `gui-walkthrough-report.json` + 关键截图；目检结论逐条一句（「看了什么、看到什么、哪条未判」）。
- 不写进STATUS.md：跑过、通过、轮次、计数；STATUS只记仍开放的门禁与取舍。验收跑绿不改变它的内容，除非验收暴露新的开放项或让某条开放项失效。
- 机械腿的 `INFO` 要变成门禁，改design/checklist的判据，而不是让工具箱猜。
