# macOS Swift 原生壳 v1：剩余门禁、验收协议与 WBS 索引

> 路线A：Swift写壳 + Node sidecar；契约见 `docs/design/25-macos-swift-native-shell.md`。本文只留
> 双端验收协议/中止条件与W-xx索引（代码与测试注释按编号引用契约）；开放门禁状态归 `docs/progress/STATUS.md`（矩阵design 25 §8.5）。M0–M4的执行记录、逐里程碑叙述、施工分批与工期估算不在本文（留存git历史）。

## 〇、决策结果索引（D1–D7；原签核表）

|决策|结果|契约|
|---|---|---|
|D1路线确认 + P0先行|按路线A；G1–G5 + C1/C2判定随M5复跑|design 25 §8.1|
|D2双壳共存 + bundle id|共存；bundle id `com.dshchamber.native`（改动 = 通知授权重来 + 打包身份返工）|design 25 §1|
|D3更新路线|v1 `blocked-available` 由Sparkle 2取代（D-1 = B）；见design 25 §7|design 25 §7|
|D4仓库落位|`macos/`（SwiftPM，同design 25 §3.2布局）|design 25 §3.2|
|D5原生UI渐进（路线B/C）|不做；HostEdges边界即未来接缝|design 25 §5|
|D6 Node版本/架构/来源|构建期fetch固定版本 + SHA-256校验（`DEFAULT_NODE_VERSION` 24.18.1，大版本对齐Electron 43.4.0内置Node）；v1 arm64-only|`packages/desktop/scripts/build-sidecar.mjs`|
|D7静态凭据加密|不做：诚实0600明文 + 旧safeStorage「保留禁用待重录」|design 25 §6|

## 一、待验收门禁（坐标；状态归 STATUS）

- M5实机门禁W-28…W-32：状态/范围见 `docs/progress/STATUS.md`「macOS Swift原生壳（design 25，路线A）开放门禁」；矩阵design 25 §8.5，判定标准见 §七。
- 双端harness未实施：`swift-harness-driver.test.ts`（真实窗口/桥/通信/深链）需GUI会话，不进普通push链（design 25 §8.3/§8.6）。
- A6外部阻断：Apple凭据（Developer ID签名/公证/stapler）缺失时dry-run全链绿即可推进代码，但不得声称「完成」（design 25 §7）。
- 其余实机项（通知权限时序、SMAppService登录项、LaunchServices深链、唤醒恢复、SSE/WS心跳、ATS、通知音效差异）在STATUS未完成项。

## 二、WBS 任务号索引（W-01…W-32 → 契约落点）

> WBS任务号索引；代码/测试注释按此引用，表只给「任务→契约所在」。

|任务|内容|契约落点|
|---|---|---|
|W-01/W-02|M0决策包签核与文档同步|§〇、design 25 §0.1|
|W-03|Swift壳脚手架（Package.swift/main/AppDelegate/MainWindowController）|design 25 §3.2、§8.1|
|W-04|A桥雏形（shim注入/MessageHandler/TrustGuard/bridge-shim.js）|design 25 §4.4.1、§4.4.3|
|W-05|竖切（AnyCodable/FrameCodec/BridgeClient/sidecar-stub + 集成测试）|design 25 §4.4.2、§8.1|
|W-06…W-08|P0走查与门禁（G1–G5、C1/C2判定）|design 25 §8.1|
|W-09/W-10|core seam（node-edges/shell-core/IPC面镜像与「core禁electron」门）|design 25 §4.1|
|W-11/W-12/W-13|sidecar入口与stdio JSON-RPC（sidecar-entry/sidecar-ctx/bridge manifest管道）|design 25 §3.2、§4.1|
|W-14|Electron零回归证明（分层gate）|design 25 §4.1、§8.2|
|W-15|SidecarSupervisor（退避重启 + 退出码分级）与目录锁|design 25 §3.3、§6.3|
|W-16|B桥客户端（FrameCodec协议 + 连接生命周期）|design 25 §4.4.2|
|W-17/W-18|bridge-manifest生成物（JSON + Swift白名单 + stub）+ shim表面锁步|design 25 §4.4.3|
|W-19/W-20|HostEdges原生腿（SwiftEdgeHostLegs：对话/面板/文件/通知）|design 25 §5 E1–E20、§4.5|
|W-21|窗口/菜单/通知/深链/渲染器恢复（MainWindowController/RendererRecovery）|design 25 §4.5、§5|
|W-22|更新v1（blocked-available）→ 由Sparkle取代|design 25 §7|
|W-23/W-24|sidecar打包（内建node + dist/web）与 .app组装/Info.plist/ATS|design 25 §3.2、§4.3|
|W-25|Sparkle预研→S-01实现|design 25 §7|
|W-26/W-27|CI（ci.yml `test-macos`）与发布产物（`-native` 命名、appcast、回滚）|design 25 §8.4|
|W-28…W-32|M5实机门禁与验收|design 25 §8.5；开放状态见STATUS|

## 三、双线防漂移门禁清单（压缩索引；断言细节见各文件与 design 25 §8.4）

|门禁|落点|断言什么|
|---|---|---|
|IPC面镜像锁步|`packages/desktop/test/ipc/ipc-surface-mirror.test.ts`|main handle/send集合 == preload invoke/on集合；无裸字面量；preload/renderer global.d.ts/settings-connections结构镜像|
|bridge-manifest一致|`bridge-manifest.test.ts` + `scripts/emit-bridge-manifest.mjs` + 提交物JSON/Swift/stub|重生成 == 提交物；通道数守恒70=61+9；manifest只承载通道 + 方向|
|A桥shim表面|`bridge-shim-surface.test.ts`|shim每个命名空间方法集 == preload；method→channel映射一致；无W-04别名残留|
|A桥stub锁步|`bridge-shim.test.ts`|重生成逐字节 == 提交物；invoke/push计数；信封 `{id,method,payload}`|
|core禁electron|`electron-free-gate.test.ts`|fail-closed传递闭包：core家族无electron import；白名单四文件有|
|sidecar全通道冒烟|`sidecar-stdio.test.ts`|假Swift驱动60 invoke回包 + 9 push 面的代表采样（真处理器）|
|release腿策略/打包清单同源|`scripts/release/release-workflow-policy.test.mjs`、`packaging-manifest-lockstep.test.mjs`|staple先于归档；`ARTIFACT_ARGS` 展开恰2次；产物名 `dsh-chamber-<ver>-macos-arm64`；host包清单五处一致|
|Swift负例护栏|`macos/Tests`（XCTest，ci.yml `test-macos`）|伪造frame/超大帧/非协议流/伪造事件名/越origin全拒|
|双端harness|`swift-harness-driver.test.ts`（未实施）|真实窗口/桥/通知/深链（需mac + GUI，见 §一）|

Swift产品代码**禁止**手写通道字符串（测试fixture除外）。通道增删改 = 一次PR内三侧同改：`ipc-events`/preload（+ renderer镜像）→ bridge-manifest重生成→Swift引用点。

## 六、同 tag 双端发布：回滚预案

流程本体（凭据fail-closed门、两条mac腿、Swift腿命名与独立EdDSA appcast）见design 25 §8.4与release.yml。回滚：
Swift产物出问题 ⇒ draft不publish、Electron照发（共存主通道，Swift可晚一tag）；Electron出问题 ⇒ 同tag Swift不单独发（防版本错位）；Win/Linux不受影响。

## 七、风险与中止条件

### 7.1 风险登记（design 25 §9 R1–R13 的展开；措辞以 design 25 为准）

- R10开发期双后端竞态：Electron dev（17520起探测）与Swift dev共享控制面起始端口族 ⇒ `DSH_CHAMBER_CP_PORT`/`DSH_CHAMBER_SHELL_PORT` 分别钉死 + 双userData（或先后启动）。
- R11人手单点：壳 + 桥 + 护栏 ≈25–35个Swift文件长期维护；缓解 = 护栏集中单target、XCTest覆盖率门、Generated产物。
- R12 manifest生成脚本解析脆弱性：新写法（模板串/别名）漏检 ⇒ 生成脚本复用mirror解析 + 「通道数守恒」断言（70=61+9）。
- R13 devtools：默认关；发布态由设置页运行期开关显式开启（design 25 §5.1.1）。debug构建的默认开只在「无设置文件或文件级损坏（不动作）」时存活；合法文件（哪怕缺 debug 键，按 Electron 默认 false）会覆盖它。inspector属信任边界。

### 7.2 WKWebView 实测项 W1–W7 判定标准（M5 / W-29 用）

|项|过|不过|不过处置|
|---|---|---|---|
|W1剪贴板（富文本复制/粘贴）|会话复制富文本（代码块/表格）粘贴进外部富文本app保结构；页内粘贴正常|仅纯文本/结构丢/粘贴被吞；或写剪贴板需弹权限而UI无流程|归因（渲染vs权限），修复预算 ≤2–3人-日；超预算或P0期失败→中止A2|
|W2菜单快捷键|Cmd+C/V/A/全选与Electron一致|快捷键无响应（first-responder断）|必修（design 25明示）|
|W3富文本粘贴 + 文件拖拽|拖文件进composer成附件；拖进归档对话框入口可用|拖拽无反应或触发导航|同W1|
|W4打印/查找|Cmd+P弹系统打印对话框且内容合理；Cmd+F若dsh UI未实现查找则N/A（登记不视为失败）|打印无对话框/空白|N/A不阻断；真失败按渲染差异排查|
|W5字体/滚动/IME|中文输入无吞字/乱序；长会话滚动无感卡顿；无方块字|IME丢字；滚动明显劣于Electron；字体破损|归因WebKit渲染差异→按W1预算|
|W6后台节流对SSE/WS|隐藏/失焦后SSE/WS心跳不断、恢复即时（≤现Electron语义）|后台WS掉线且无法自动重连或恢复 >30s|归因WebKit节流→改keep-alive/唤醒补发（core具备）|
|W7刷新率三工况|打包态：插电120fps；电池 + 低电量模式60fps（系统级帧间隔 ×2）；60Hz外接屏不回退|任一工况达不到，或启动日志与 `[shell-fps]` 实测矛盾|归因（渲染侧偏好vs系统节流）；日志标「面板上限」时以 `[shell-fps]` 实测为准；判据见design 25 §5.1/deviations S-48|

### 7.3 双端性能与产物体积验收协议（P0 预检 / M4–M5 定标）

> 同环境A/B纪律见 `scripts/perf/README.md`：前后对照**只**在同环境A/B内可信，跨环境绝对值**不可比**；双端对比必须同机、同脚本顺序、同会话窗口，数据落 `scripts/perf/data/*.json` 同族。

方法学平移（不换尺）：`scripts/perf/{boot,switch,eval,cdp-lib}-measure.mjs` 为CDP驱动（Electron专属）；Swift侧以 **WKUserScript注入同一套PerformanceObserver探针 + `evaluateJavaScript` 驱动合成MouseEvent**（同源、引擎无关），四场景平移：boot（wall/长任务/CLS）、跨来源切换、rapid×10连点、eval归因；驱动与schema双端共用，差异只在注入通道（CDP ↔ WKUserScript）。

|形态|指标|建议预算（P0首测后校准，不作跨环境承诺）|
|---|---|---|
|相对门（同机A/B）|boot wall/切换/rapid×10|原生 ≤ Electron × 1.3/× 1.5（长任务与CLS结构只登记不设硬门）|
|绝对预算|IPC invoke p95（60通道抽测代表组）|≤ 20ms|
|绝对预算|事件推送突发|100事件/秒不丢序（core有界队列语义）|
|能力门|后台隐藏 ≥30s SSE/WS心跳 + 唤醒恢复（C1）|心跳不断、恢复 ≤ 现Electron语义；不过→keep-alive/唤醒补发，登记已知降级或修复|
|能力门|内存峰值/空闲唤醒次数与进程数|内存 ≤ Electron × 0.7；进程数/唤醒登记对比|
|能力门|产物体积（M5定标；M0起可dry-run先采Electron基线）|.app安装体积/dmg/zip/磁盘展开 ≤ Electron × 0.75（口径 `du -sh` + 文件大小）|

数据纪律：P0只做「数量级异常预检」（灾难性回归早暴露，不定标）；正式定标M4/M5；跨会话/跨环境数字不得直接作差异结论。

### 7.4 中止/回退触发点（任一失败即回 design 25 §10 决策 1 重审，不硬着头皮继续）

- A1：P0 G1主界面实质功能缺口（非minor样式）⇒ WKWebView承载面证伪。
- A2：P0 G2剪贴板/拖拽硬伤（W1/W3不过；G3=侧栏插件不受影响）⇒ 试1–2天归因，仍不过重审。
- A3：B桥护栏负例被击穿（伪造frame/超大帧/非协议流/伪造事件名任一）⇒ fail-closed信任模型不成立：立即停止，P2出口前必须闭合。
- A4：P1拆分后 `test:desktop` 连续2批不收敛绿 ⇒ 回退上一绿commit重排批次。
- A5：M3双端harness真实窗口不稳定（排除环境后 >1周）⇒ 重审壳层策略（Electron退守不受影响）。
- A6：M4/M5发布门因Apple凭据缺失挂起 ⇒ 不中止路线：dry-run全链绿即可推进代码，发布登记外部阻断，不得声称「完成」。
- A7：P4性能基线结构性不达标且非修复可解 ⇒ 回D1重审。
- A8：bridge-manifest生成物 ≠ 提交物连续3个PR反复红 ⇒ 暂停Swift大PR，先修manifest流程。

## 八、决策门日程

决策门结果见 §〇（原「最迟拍板门 / 错过后果」表在git历史）；日后重开路线会连带通知授权/打包身份/路径与CI返工。

## 九、工具与 dev 侧约定

- ATS：dev态以 `NSAllowsLocalNetworking` 放行loopback（生产同值）；WebView只加载控制面origin。
- dev后端：Swift dev用 `DSH_CHAMBER_SHELL_PORT` 钉死的控制面 + `dsh-chamber-dev` userData（与Electron dev的 `.dev-user-data` 隔离，见 `deviations.md` §3 P-10）。
- 工期估算（三档人-日）与里程碑排期不在本文；量级与关键路径见design 25 §0。
