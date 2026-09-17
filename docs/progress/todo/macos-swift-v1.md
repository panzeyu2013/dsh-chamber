# macOS Swift 原生壳 v1：剩余门禁、验收协议与 WBS 索引

> 状态：**代码面已落地**（路线 A：Swift 写壳 + Node sidecar；契约与实现形态见
> `docs/design/25-macos-swift-native-shell.md`）。本文是 design 25 的 companion，只保留
> **未闭合的外部门禁**、**双端验收协议 / 中止条件**与 **W-xx 任务号索引**（代码与测试注释按该
> 编号引用契约）。M0–M4 的执行记录、逐里程碑叙述、施工分批顺序与工期估算已随收口删除
> （留存 git 历史）；实机项与开放项同时登记在 `docs/progress/STATUS.md`。

## 〇、决策结果索引（D1–D7；原签核表）

| 决策 | 结果 | 契约 |
|---|---|---|
| D1 路线确认 + P0 先行 | 按路线 A 启动并落地；G1–G5 + C1/C2 判定随 M5 复跑 | design 25 §8.1 |
| D2 双壳共存 + bundle id | 共存；bundle id `com.dshchamber.native`（改动 = 通知授权重来 + 打包身份返工） | design 25 §1 |
| D3 更新路线 | v1 `blocked-available` **已被 Sparkle 2 取代**（用户裁决 D-1 = B）；见 design 25 §7 | design 25 §7 |
| D4 仓库落位 | `macos/`（SwiftPM，与 design 25 §3.2 同布局） | design 25 §3.2 |
| D5 原生 UI 渐进（路线 B/C） | 不做；HostEdges 边界即未来接缝 | design 25 §5 |
| D6 Node 版本/架构/来源 | 构建期 fetch 固定版本 + SHA-256 校验（`DEFAULT_NODE_VERSION` 24.18.1，大版本对齐 Electron 43.4.0 内置 Node）；**v1 arm64-only** | `packages/desktop/scripts/build-sidecar.mjs` |
| D7 静态凭据加密 | 不做：诚实 0600 明文 + 旧 safeStorage「保留禁用待重录」 | design 25 §6 |

## 一、未闭合门禁

- **M5 实机门禁**（W-28…W-32，需真实打包产物 + 桌面会话）：
  - W-28 打包态全链矩阵：控制面起动 / 本地实例预启动 / 连接 / 网关凭据重录 / 运行时版本管理与回退 /
    插件同步 / 归档清理入口（无对话框）/ 通知点击 / 深链 / 隐藏恢复 / 唤醒补发 / 退出确认；
  - W-29 W1–W6 parity 逐项判定（判据见 §七）；
  - W-30 性能基线对照 + **双端产物体积对比登记**（.app/dmg/zip，同机同架构同 tag，目标 ≤ Electron × 0.75）；
  - W-31 双端同 tag 正式发布 + CHANGELOG + STATUS 收口；
  - W-32 R1–R13 实际化复盘 + D1–D7 复核。
- **双端 harness 未实施**：`swift-harness-driver.test.ts`（node 侧拉起 Swift harness，断言真实窗口/桥/通信/
  深链）需 GUI 会话，不进普通 push 链，列 release 演练与 M5（design 25 §8.3/§8.6）。
- **A6 外部阻断**：Apple 凭据（Developer ID 签名 / 公证 / stapler）与首次 build-swift 的发布证明；凭据缺失时
  dry-run 全链绿即可推进代码，但不得声称「完成」（STATUS 既有语义）。
- 其余实机项（通知权限时序、SMAppService 登录项、LaunchServices 深链、唤醒恢复、SSE/WS 心跳、ATS）见 STATUS 未完成项。

## 二、WBS 任务号索引（W-01…W-32 → 契约落点）

> 2026-12 已执行实施的 WBS 任务号；代码/测试注释按此引用，表只给「任务 → 契约所在」。

| 任务 | 内容 | 契约落点 |
|---|---|---|
| W-01/W-02 | M0 决策包签核与文档同步 | §〇、design 25 §0.1 |
| W-03 | Swift 壳脚手架（Package.swift / main / AppDelegate / MainWindowController） | design 25 §3.2、§8.1 |
| W-04 | A 桥雏形（shim 注入 / MessageHandler / TrustGuard / bridge-shim.poc.js） | design 25 §4.4.1、§4.4.3 |
| W-05 | 竖切（AnyCodable / FrameCodec / BridgeClient / poc-sidecar + 集成测试） | design 25 §4.4.2、§8.1 |
| W-06…W-08 | P0 走查与门禁（G1–G5、C1/C2 判定） | design 25 §8.1 |
| W-09/W-10 | core seam（node-edges / shell-core / IPC 面镜像与「core 禁 electron」门） | design 25 §4.1 |
| W-11/W-12/W-13 | sidecar 入口与 stdio JSON-RPC（sidecar-entry / sidecar-ctx / bridge manifest 管道） | design 25 §3.2、§4.1 |
| W-14 | Electron 零回归证明（分层 gate） | design 25 §4.1、§8.2 |
| W-15 | SidecarSupervisor（退避重启 + 退出码分级）与目录锁 | design 25 §3.3、§6.3 |
| W-16 | B 桥客户端（FrameCodec 协议 + 连接生命周期） | design 25 §4.4.2 |
| W-17/W-18 | bridge-manifest 生成物（JSON + Swift 白名单 + stub）+ shim 表面锁步 | design 25 §4.4.3 |
| W-19/W-20 | HostEdges 原生腿（SwiftEdgeHostLegs：对话/面板/文件/通知） | design 25 §5 E1–E20、§4.5 |
| W-21 | 窗口/菜单/通知/深链/渲染器恢复（MainWindowController / RendererRecovery） | design 25 §4.5、§5 |
| W-22 | 更新 v1（blocked-available）→ **已被 Sparkle 取代** | design 25 §7 |
| W-23/W-24 | sidecar 打包（内建 node + dist/web）与 .app 组装 / Info.plist / ATS | design 25 §3.2、§4.3 |
| W-25 | Sparkle 预研 → **已落地为 S-01 实现** | design 25 §7 |
| W-26/W-27 | CI（ci.yml `test-macos`）与发布产物（`-native` 命名、appcast、回滚） | design 25 §8.4 |
| W-28…W-32 | M5 实机门禁与收口 | 本文 §一 |

## 三、双线防漂移门禁清单（压缩索引；断言细节见各文件与 design 25 §8.4）

| 门禁 | 落点 | 断言什么 |
|---|---|---|
| IPC 面镜像锁步 | `packages/desktop/test/ipc/ipc-surface-mirror.test.ts` | main handle/send 集合 == preload invoke/on 集合；无裸字面量；preload/renderer global.d.ts/settings-connections 结构镜像 |
| bridge-manifest 一致 | `bridge-manifest.test.ts` + `scripts/emit-bridge-manifest.mjs` + 提交物 JSON/Swift/stub | 重生成 == 提交物；通道数守恒 68=60+8；manifest 只承载通道 + 方向 |
| A 桥 shim 表面 | `bridge-shim-surface.test.ts` | shim 每个命名空间方法集 == preload；method→channel 映射一致；无 W-04 别名残留 |
| A 桥 stub 锁步 | `bridge-shim.test.ts` | 重生成逐字节 == 提交物；invoke/push 计数；信封 `{id,method,payload}` |
| core 禁 electron | `electron-free-gate.test.ts` | fail-closed 传递闭包：core 家族无 electron import；白名单四文件有 |
| sidecar 全通道冒烟 | `sidecar-stdio.test.ts` | 假 Swift 驱动 60 invoke 回包 + 8 push 采样（真处理器） |
| release 腿策略 / 打包清单同源 | `scripts/release/release-workflow-policy.test.mjs`、`packaging-manifest-lockstep.test.mjs` | staple 先于归档；`ARTIFACT_ARGS` 展开恰 2 次；产物名 `dsh-chamber-native-<ver>-macos-arm64`；host 包清单五处一致 |
| Swift 负例护栏 | `macos/Tests`（XCTest，ci.yml `test-macos`） | 伪造 frame / 超大帧 / 非协议流 / 伪造事件名 / 越 origin 全拒 |
| 双端 harness | `swift-harness-driver.test.ts`（**未实施**） | 真实窗口/桥/通知/深链（需 mac + GUI，见 §一） |

**Swift 产品代码禁止手写通道字符串**（测试 fixture 除外）。通道增删改 = 一次 PR 内三侧同改：
`ipc-events`/preload（+ renderer 镜像）→ bridge-manifest 重生成 → Swift 引用点。

## 六、同 tag 双端发布草案（D2=共存默认）

单 repo 单 tag `vX.Y.Z`：push CI 全绿（含上表全部 JS 门禁）→ release.yml `create-release`（Apple 凭据 fail-closed 门）
→ Electron mac 腿（dmg/zip/latest-mac.yml）与 Swift mac 腿（`dsh-chamber-native-<ver>-macos-<arch>.dmg/.zip` +
`appcast-swift.xml`，**独立 EdDSA 密钥**）并行构建上传 draft → 双产物齐 → 双端冒烟（M5 矩阵 + harness）→ publish。
回滚预案：Swift 产物出问题 → draft 不 publish、Electron 照发（Electron 是共存主通道，Swift 可晚一 tag 跟上）；
Electron 出问题 → 同 tag Swift 不单独发（防版本错位）；Win/Linux 腿不受影响。

## 七、风险与中止条件

### 7.1 风险登记（design 25 §9 R1–R13 的展开；措辞以 design 25 为准）

- **R10 开发期双后端竞态**：Electron dev（17520 起探测）与 Swift dev 共享控制面起始端口族 → Electron 用
  `DSH_CHAMBER_CP_PORT`、Swift 用 `POC_PORT` 钉死 + 双 userData（或先后启动）。
- **R11 Swift 侧人手单点**：壳 + 桥 + 护栏 ≈25–35 个 Swift 文件的长期维护面；缓解 = 护栏规则集中于单 target、
  XCTest 覆盖率门、Generated 产物减少手写面。
- **R12 manifest 生成脚本解析脆弱性**：新写法（模板串/别名）会漏检 → 生成脚本复用 mirror 解析函数并加「通道数守恒」
  断言（68=60+8）。
- **R13 WKWebView devtools**：debug 构建才开 `developerExtrasEnabled`，发布态由 build 脚本保证关闭（inspector 属信任边界）。

### 7.2 WKWebView 实测项 W1–W6 判定标准（M5 / W-29 用）

| 项 | 过 | 不过 | 不过处置 |
|---|---|---|---|
| W1 剪贴板（富文本复制/粘贴） | 会话复制富文本（代码块/表格）粘贴进外部富文本 app 保结构；页内粘贴正常 | 仅纯文本 / 结构丢 / 粘贴被吞；或写剪贴板需弹权限而 UI 无流程 | 归因（渲染 vs 权限），修复预算 ≤2–3 人-日；超预算或 P0 期失败 → 中止 A2 |
| W2 菜单快捷键 | Cmd+C/V/A/全选与 Electron 一致 | 快捷键无响应（first-responder 断） | 必修（design 25 明示） |
| W3 富文本粘贴 + 文件拖拽 | 拖文件进 composer 成附件；拖进归档对话框入口可用 | 拖拽无反应或触发导航 | 同 W1 |
| W4 打印/查找 | Cmd+P 弹系统打印对话框且内容合理；Cmd+F 若 dsh UI 未实现查找则 N/A（登记不视为失败） | 打印无对话框/空白 | N/A 不阻断；真失败按渲染差异排查 |
| W5 字体/滚动/IME | 中文输入无吞字/乱序；长会话滚动无感卡顿；无方块字 | IME 丢字；滚动明显劣于 Electron；字体破损 | 归因 WebKit 渲染差异 → 按 W1 预算 |
| W6 后台节流对 SSE/WS | 隐藏/失焦后 SSE/WS 心跳不断、恢复即时（≤现 Electron 语义） | 后台 WS 掉线且无法自动重连或恢复 >30s | 归因 WebKit 节流 → 改 keep-alive/唤醒补发（core 已具备） |

### 7.3 双端性能与产物体积验收协议（P0 预检 / M4–M5 定标）

> 同环境 A/B 纪律见 `scripts/perf/README.md`：**前后对照只在同环境 A/B 内可信，跨环境绝对值不可比**；
> 双端所有对比必须同机、同脚本顺序、同会话窗口执行，数据落 `scripts/perf/data/*.json` 同族。

**方法学平移（不换尺）**：现有 `scripts/perf/{boot,switch,eval,cdp-lib}-measure.mjs` 是 CDP 驱动（Electron 专属）。
Swift 侧用 **WKUserScript 注入同一套 PerformanceObserver 探针 + `evaluateJavaScript` 驱动合成 MouseEvent**
（同源注入代码，引擎无关），四场景平移：boot（wall/长任务/CLS）、跨来源切换、rapid×10 连点、eval 归因；
页面驱动脚本与数据 schema 双端共用，差异只在注入通道（CDP ↔ WKUserScript）。

| 形态 | 指标 | 建议预算（P0 首测后校准，不作跨环境承诺） |
|---|---|---|
| 相对门（同机 A/B） | boot wall / 切换 / rapid×10 | 原生 ≤ Electron × 1.3 / × 1.5（长任务与 CLS 结构只登记不设硬门） |
| 绝对预算 | IPC invoke p95（60 通道抽测代表组） | ≤ 20ms |
| 绝对预算 | 事件推送突发 | 100 事件/秒不丢序（core 有界队列语义） |
| 能力门 | 后台隐藏 ≥30s SSE/WS 心跳 + 唤醒恢复（C1） | 心跳不断、恢复 ≤ 现 Electron 语义；不过 → keep-alive/唤醒补发，登记已知降级或修复 |
| 能力门 | 内存峰值 / 空闲唤醒次数与进程数 | 内存 ≤ Electron × 0.7；进程数/唤醒登记对比 |
| 能力门 | 产物体积（M5 定标；M0 起可 dry-run 先采 Electron 基线） | .app 安装体积 / dmg / zip / 磁盘展开 ≤ Electron × 0.75（口径 `du -sh` + 文件大小） |

**数据纪律**：P0 只做「数量级异常预检」（引擎级灾难性回归早暴露，不定标）；正式定标在 M4/M5；任何跨会话/跨环境数字不得直接作差异结论。

### 7.4 中止/回退触发点（任一失败即回 design 25 §10 决策 1 重审，不硬着头皮继续）

- A1：P0 G1 主界面实质功能缺口（不能归类 minor 样式）——WKWebView 承载面证伪。
- A2：P0 G2 剪贴板/拖拽硬伤（W1/W3 不过，G3=侧栏插件不受影响）——先试 1–2 天归因修复，仍不过即重审。
- A3：B 桥护栏负例可击穿（伪造 frame/超大帧/非协议流/伪造事件名任一穿透）——信任模型 fail-closed 无法保证 ⇒ 立即停止，P2 出口前必须闭合。
- A4：P1 拆分后 `test:desktop` 连续 2 个批次无法收敛绿——拆分粒度/顺序错 ⇒ 回退上一绿 commit 重排批次。
- A5：M3 双端 harness 在真实窗口无法稳定（排除环境因素后 >1 周）——壳缺陷深 ⇒ 重审壳层策略（Electron 退守不受影响）。
- A6：M4/M5 发布门因 Apple 凭据缺失挂起——不中止路线：dry-run 全链绿即可推进代码，发布登记为外部阻断，但不得声称「完成」。
- A7：P4 性能基线结构性不达标且非修复可解——回 D1 重审。
- A8：bridge-manifest 生成物 ≠ 提交物连续 3 个 PR 反复红——暂停 Swift 大 PR，先修 manifest 流程再继续。

## 八、决策门日程与结果（原「最迟拍板门 / 错过后果」）

决策门随执行已全部拍板（结果见 §〇）：D1/D2/D4 在 M0 定；D3/D5 在 M2 前定（D3 后由用户裁决改为 Sparkle 2）；
D6 在 M3 入口定（24.18.1 + arm64-only）；D7 在 M4 出口复查（不做）。若日后重开路线，最迟拍板门与错过后果仍照原表
（改动会导致通知授权/打包身份/路径与 CI 返工）——原文见 git 历史。

## 九、工具与 dev 侧约定

- **ATS**：dev 态以 `NSAllowsLocalNetworking` 放行 loopback（生产同值）；WebView 只加载控制面 origin。
- **dev 后端**：Swift dev 用 `POC_PORT` 钉死的控制面 + `dsh-chamber-poc-dev` userData（与 Electron dev 的
  `.dev-user-data` 隔离，见 `deviations.md` §3 P-10）。
- **计划期工期估算**（三档人-日）与里程碑排期已随执行收口删除；量级与关键路径见 design 25 §0。
