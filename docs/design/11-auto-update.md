# 11 · 桌面端更新提示（settings 低调展示，无弹窗）与通道灰度（现行：已实现，2026-08）

> **状态：现行（已实现，2026-08）**——原 todo 设计（2026-08 自 `docs/todo/` 移入，
> 原文件已删除）已按 M1–M3 落地：**M1** 主进程 `packages/desktop/updater.ts`
> （`electron-updater` github provider，`autoDownload=false`、`autoInstallOnAppQuit`、
> 状态机、静默失败日志）
> + preload IPC（`dsh-chamber:update-state` 查询/推送、`update-download`、`open-release`）；
> **M2** settings 壳新增 chamber 全局「更新」入口（`__update`，chamber 全局固定入口区，结构见设计 15）
> + 低调 `UpdateSection` 组件（zh/en 文案，`verify:i18n` 通过）；**M3** desktop build
> 配置（`publish` github provider、mac 增加 `zip` target）+ `DSH_CHAMBER_UPDATE_CHANNEL=beta`
> + release.yml 双 leg 更新产物（win：exe+`latest.yml`/`beta.yml`；mac：dmg+zip+
> `latest-mac.yml`/`beta-mac.yml`）。**2026-08 v0.1.2 修订**：不发布 `.blockmap`
> 侧车——Windows `nsis.differentialPackage: false`（不生成 exe.blockmap，差分退化
> 为全量下载，feed 不引用 blockmap 故功能无损），mac zip 的硬编码 `.zip.blockmap`
> 在 finalize 翻转 draft 前经 GitHub API 删除。
>
> 需求来源：升级目标是 **dsh-chamber 自身**（Electron 桌面应用），**不是**远端 dsh
> 实例。本设计为其引入「后台**静默**检查 → settings 低调提示 → **用户明确确认后**
> 后台下载 → 退出时安装」，并以**通道模型（beta → stable）**实现滚动/灰度发布。
>
> 决策记录（2026-08，用户拍板）：
> 1. feed/检查源 = **GitHub Releases**（零新增服务器）；
> 2. 灰度策略 = **通道模型 beta → stable**（非百分比灰度）；
> 3. **双平台流程一致**（Windows 与 macOS 同一形态）：`electron-updater` 静默检查 →
>    settings 提示 → 用户确认 → 后台下载 → 退出时安装；**macOS 不手动安装**。
>    macOS 安装腿的硬前置 = Developer ID 签名（Squirrel.Mac 硬前提）；公开发布
>    workflow 同时要求公证凭据并验证 stapled ticket，缺失即 fail-closed。
> 4. **UX（三轮修订）**：**不弹窗** + **低打扰（不显眼）**——更新信息只在 settings
>    的 chamber 全局「更新」部分低调展示；**后台下载以用户明确确认（点击「更新」）
>    为前提**，用户不确认则永不下载；退出时自动安装（双平台）。
>
> **剩余验证项（实现后）**：配置真实 Developer ID/公证/Authenticode 秘密后，
> `electron-builder --publish` 的 draft → finalize、stapling/验签与双平台实机
> 检查/下载/退出安装仍需一次真实 CI/设备验证。

## 1. 现状（实现前的动机）

| 项 | 现状 | 证据 |
|---|---|---|
| 更新器依赖 | 无 `electron-updater`（devDeps 仅 electron / electron-builder） | 实现前 `packages/desktop/package.json` |
| 主进程更新代码 | 无 `autoUpdater` / `checkForUpdates` 任何代码；全仓库无「检查更新」UI/IPC | 实现前 `main.ts` |
| 更新产物 | 显式关闭：`dmg.writeUpdateInfo: false`、`nsis.differentialPackage: false` | 实现前 desktop package.json `build` |
| 发布 feed | `--publish=never`，每平台只传安装器（mac dmg / win exe）——「no zip/blockmap sidecars」 | 实现前 `.github/workflows/release.yml` |
| 签名 | macOS **ad-hoc**（afterPack 钩子）；Windows 未签名 | `after-pack-adhoc-sign.mjs`、STATUS.md |
| 版本 | chamber 版本分布于根/desktop/control-plane/renderer/cli 五包；4 个 chamber 插件包跟随 vendored dsh | 各 package.json |

## 2. 目标与边界

**目标**：dsh-chamber 桌面端后台**静默**检测新版本（stable/beta 通道），在 **settings
的 chamber 全局「更新」部分**以**低调、不显眼**的一行状态提示「有新版本 vY」；**用户
明确点击「更新」后**才开始后台自动下载，**退出时自动安装**——Windows 与 macOS 流程
一致，全程无弹窗。

**边界（硬约束）**：

- **无弹窗是硬约束**：主进程 dialog、托盘气泡、系统通知一律不出现（与仓库
  「notifications 移出」纪律一致）。
- **低打扰是硬约束**：settings 内也只用**普通状态行**低调展示（无高亮徽标、无角标、
  无横幅、无开机即弹）；用户主动打开 settings 才看得到。
- **下载以用户确认为前提**：没有用户点击，检查后不产生任何下载/网络副作用
  （`autoDownload=false`）。
- 检查器/下载器只进 **`packages/desktop` 主进程**；控制面保持 loopback-only、零出网
  不变；渲染层（dsh 官方前端复用面）不参与检查逻辑，只经 IPC 呈现状态。
- **不涉及远端 dsh**：chamber 升级自带新 dsh runtime（`extraResources` 的
  `vendor/dsh`），远端实例版本无关（`verifyUp` 握手已按 dsh 特征签名兼容新旧）。
- 不引入认证面、不改控制面契约（05 权威契约不动）。

## 3. 选型与架构：双平台统一（electron-updater）

### 3.1 机制：`electron-updater`（github provider），双平台同一形态

- **检查**：`autoUpdater.checkForUpdates()`（github provider，读 release 资产中的
  `latest.yml`（stable）/ `beta.yml`（beta）——mac 为 `latest-mac.yml` 系列）。
- **下载**：默认 **不自动下载**（`autoDownload: false`）——检查发现新版本后状态置为
  `available`，**仅当用户点击 settings「更新」部分中的「更新」按钮**才调
  `downloadUpdate()` 后台下载（无进度弹窗，进度只经 IPC 反映为 settings 状态行）。
- **安装**：下载完成置 `downloaded`，`autoInstallOnAppQuit: true`——**退出时自动
  安装**（连接管理器场景不打断活跃会话；无任何安装弹窗）。
- **macOS 签名前置（非 UX 分支）**：Squirrel.Mac（electron-updater mac 安装器）
  **要求有效代码签名**——Developer ID 未配置时 mac 安装腿被阻塞。`updater.ts` 启动时
  以 `codesign -dv` 探测一次签名权威（有无 `Authority=Developer ID`），缺失则
  `installBlockedReason` 置位，settings 响亮提示「已下载（…），请手动安装」——
  **绝不假装已安装**。ad-hoc 是否放行 Squirrel.Mac 未实机（剩余验证项）。
- **channel 实现细节**：`DSH_CHAMBER_UPDATE_CHANNEL=beta` 环境变量 opt-in；打包态
  channel 烘焙于 app-update.yml（electron-builder 从版本 semver prerelease 后缀推导：
  `0.2.0` → latest、`0.2.0-beta.1` → beta），运行时**不**覆盖（仅 dev 显式
  `setFeedURL`）。
- **排除项**：自托管静态 feed——仅百分比灰度需要，v1 不做（§4）。

### 3.2 呈现面：settings 的 chamber 全局「更新」部分（低调、无弹窗）

- **状态流**：主进程 `updater.ts` 状态机（idle → checking → up-to-date → available →
  downloading → downloaded / error；`up-to-date` = 已检查且无新版，区别于未检查的
  idle）→ 经 preload IPC（`dsh-chamber:update-state` invoke 查询 + `update-state-changed`
  push）→ settings 壳渲染。
- **挂载位置**：settings 壳（`packages/dsh-chamber-client-ui-settings-bridge`）
  的**「通用」段内**（`__general` 固定入口 → `GeneralView` 底部嵌入 `UpdateSection`
  控制组）——**2026-08 修订**：原独立的 `__update` 固定入口随用户拍板并入「通用」，
  固定入口区结构（`__connections` / `__general`）与并入决策以**设计 15** 为权威，
  本节不重复。「更新」控制组 = `UpdateSection` 组件（`update-store.ts` 模块单例
  订阅，N-ctx 共享）。内容小、只读一个 IPC 状态 → 无需
  新插件包，直接扩展 settings 壳。
- **部分内容（低调状态行，不显眼）**：
  - 当前版本 vX（主进程投影 `currentVersion`，`dsh-chamber:info.version` 兜底）；
  - **「检查更新」按钮（2026-08 新增，用户拍板）**：点击 → 主进程同一条静默检查
    路径（`dsh-chamber:update-check` → `updater.checkNow()`，`autoDownload=false`
    不变——检查永不下载）；在途检查/下载或「已下载」终态时按钮禁用（`update-gate.ts`
    相位门，与主进程 `runCheck()` 门一致）；检查结果经状态行呈现；
  - 有新版时一行状态：「新版本 vY（stable/beta）」+ **「更新」按钮**（点击 →
    后台下载；状态行随之变为 下载中… → 已下载，退出时安装）；不点击 → 永不下载；
  - 无新版时：「已是最新版本」；检查失败时：「无法检查更新」（静默，绝不假成功）；
  - mac 签名未配置时：「已下载（…），请手动安装」+「前往下载页」链接（经主进程
    `shell.openExternal`，仅允许本仓库 GitHub 页——窗口禁 popup/navigation）。
- zh/en 文案走 `dsh-chamber.settings.bridge` 命名空间（`verify:i18n` 通过）；样式用
  普通列表行（dsh design tokens），不加高亮——2026-08 起与「通用」段一致采用
  settings-panel 控制组/胶囊按钮词汇。

## 4. 滚动/灰度：通道模型（beta → stable）

- **stable（默认）**：读最新正式 release 的 `latest.yml` / `latest-mac.yml`。
- **beta（opt-in）**：`DSH_CHAMBER_UPDATE_CHANNEL=beta` 环境变量 → 读 `beta.yml` /
  `beta-mac.yml`；settings 部分标注「beta 通道」。
- **发布侧**：beta = 版本带 prerelease 后缀（如 `0.2.0-beta.1`）→ electron-builder
  自动产 `beta*.yml`，GitHub Release 的 prerelease 标志由**版本 prerelease 后缀推导**
  （非 workflow 输入——tag-push 时输入为空，按输入推导会把 beta feed 发到非
  prerelease release，稳定客户端会把该 release 当最新并 404 在 latest.yml）。
  验证通过后发正式版本（`latest*.yml`）——「先内测、后提升」，与现有
  draft → finalize 手动发布节奏契合。
- **明确不做（v1）**：百分比灰度（按客户端分桶）——需自托管 feed 侧实现；用户
  规模达到再评估。

## 5. 更新数据流与 UX

```
启动（延迟 15s）→ 静默检查（autoDownload: false，无网络副作用）
  ├─ 有新版 → settings「通用」段更新组一行状态「新版本 vY」+ [更新] 按钮
  │     ├─ 用户点击 → 后台自动下载（进度经 IPC → 状态行 下载中…）
  │     └─ 不点击 → 永不下载（仅状态行）
  │  下载完成 → 「已下载，退出时安装」→ quit 时自动安装（双平台一致）
  ├─ 无新版 → 「已是最新版本」
  └─ 失败 → 「无法检查更新」（静默写主进程日志，绝不假成功）
用户主动点击 [检查更新]（2026-08）→ 同一条检查路径（update-check IPC，仍不下载）
每 6h 周期静默复查；settings「通用」段的更新组 = 唯一可见面
```

- **失败语义**：检查/下载/校验/安装任何失败 → 静默或 settings 内响亮（安装失败
  绝不假装成功），**绝不阻塞启动、绝不静默降级**（`allowDowngrade=false`）。
- **无弹窗清单**：主进程 dialog、托盘气泡、系统通知、settings 外的任何提示一律
  不出现。

## 6. 发布流程与构建产物（已实现）

- **双平台都需要 feed 产物**（electron-updater 消费）：
  - `packages/desktop/package.json`：`electron-updater` 依赖；mac target 增加 `zip`
    （electron-updater mac 需要 zip，dmg 保留首装）；`publish` 块（github provider，
    owner=`panzeyu2013`，repo=`dsh-chamber`）。**2026-08 v0.1.2 修订**：
    `nsis.differentialPackage: false` **且 `nsis.useZip: false`**——v0.1.2 初版改为
    true/true 会让 CI/发布产出 `exe.blockmap` 侧车，但 feed 从不引用 blockmap，差分
    只省带宽不省功能；且 `differentialPackage: false + useZip: true` 会让 NSIS 内部
    从 7z(LZMA) 退化为 zip，exe 从 ~123MB 膨胀到 ~169MB（NsisTarget format 选择：
    `!isBuildDifferentialAware && useZip ? "zip" : "7z"`）。统一不发 blockmap 且保持
    7z 高压缩（win 配置关闭 + mac 在 finalize 前删 asset）。
  - **实现发现**：`--publish=never` **不生成** update-info yml（app-builder-lib
    PublishManager 仅在 `isPublish` 时执行 `createUpdateInfoTasks`）——发布必须走
    `--publish`。
- **`release.yml` 双 leg 改造（已实现）**：
  - build 步骤改 `--publish=always`（`GH_TOKEN`）——electron-builder 把全部产物
    **包括 feed 文件**上传进 create-release 创建的 draft release（softprops 上传步骤
    移除；create-release 建 draft + finalize 翻转公开的流程不变）；
  - win leg 产物：`*.exe` + `latest.yml` / `beta.yml`（**无 blockmap**，2026-08）；
  - mac leg 产物：`*.dmg` + `*.zip` + `latest-mac.yml` / `beta-mac.yml`；
  - workflow_dispatch 的 `version` 输入必须等于 `packages/desktop/package.json`
    版本（create-release 先断言，防 electron-builder 上传到幻影 v<package.json>
    draft 而 finalize 空 release）；draft 的 `prerelease` 由版本 prerelease 后缀
    推导；`dry_run` 时回退 `--publish=never`（build-only 检查；create-release 仍会
    建一个空 draft——与既有行为一致，已在 workflow 输入描述注明）；
  - CI 验证步骤新增：非 dry-run 时断言 channel yml 存在、**无** blockmap 产物；
  - finalize 前新增清理步骤：经 GitHub API 删除 draft release 里的
    `*.zip.blockmap`（mac zip 的 blockmap 由 electron-builder 硬编码生成，无配置
    开关；feed 不引用它，删除后 mac 更新退化为全量下载 zip）。
- **macOS 签名前置**：自动安装依赖 Developer ID 签名 + 公证（Squirrel.Mac 硬
  前提）——未配置时 mac 安装腿阻塞（§3.1；settings 响亮提示手动安装，**不做**手动
  安装的 UX 分支）。

## 7. 安全与已知让步

- **完整性**：`latest*.yml` 内 sha512 校验下载包——无签名也有传输/下载完整性保护。
- **发布身份（fail-closed）**：公开发布必须同时具备 macOS Developer ID + 公证
  凭据和 Windows Authenticode 凭据；release workflow 在建 draft 前检查秘密，
  构建后再以 `codesign`/`spctl`/`stapler` 与 `Get-AuthenticodeSignature` 验证。
  缺任一项即不发布。dry-run 仍允许生成不公开的本机构建产物。
- **出网面**：仅主进程访问 GitHub API / feed（HTTPS）；控制面零出网、loopback
  闭环不变。
- **隐私**：检查/下载不携带任何用户/SSH 材料；仅应用版本与平台信息。
- **用户确认闸**：`autoDownload: false`——无用户点击不产生下载流量（低打扰 +
  减少无谓网络副作用）。
- **打开链接白名单**：`dsh-chamber:open-release` 仅允许
  `https://github.com/panzeyu2013/dsh-chamber/*`（严格前缀校验，主进程执行），
  渲染层无法打开任意 URL。
- **失败语义**：超时/网络错误静默 + 日志；settings 显示「无法检查更新」而非假
  成功；安装失败响亮（与仓库 proxy honesty 原则同源）。

## 8. 版本管理与数据兼容

- chamber 版本分布于 6 包（根/desktop/control-plane/renderer/cli/
  dsh-host-client-graph——host-graph 是 chamber 自有宿主包，其版本随 chamber
  发版且经插件管理 UI 展示，2026-08 review 补入 §8），发版时**一致 bump**
  （semver 比较；`main.ts` 读 desktop package.json 的 version 并经
  `dsh-chamber:info` 透传渲染层、注入更新控制器；release.yml 断言全部 6 包
  与发布版本一致）。4 个客户端插件包（sidebar/connections/settings-bridge/
  layout）**不随 chamber 发版移动**——保持各自 fork 时的版本（2026-08
  rc.8 对齐后统一 bump 到 chamber 发版版本 0.1.3，与 6 个发版包一致；
  vendored dsh 源为 0.1.0-rc.8——插件版本只在 chamber 侧参与 workspace
  解析，从不与 dsh 源逐位对齐，也从不参与任何比较/展示；2026-08
  review 澄清措辞，2026-08 最终轮扫描同步现状）。
- 更新只替换应用本体；`userData`（`ssh-instances.json`、state、`ssh-passwords.json`）
  天然保留。未来若改变注册表/状态格式 → 首启迁移（幂等、失败响亮不冒充成功）。
- 升级不要求升级远端 dsh；与旧版本 chamber 的远端实例握手兼容（`verifyUp`）。

## 9. 实现记录与剩余项

**实现记录（2026-08，M1–M3 全部落地；2026-08 review 轮修复）**：

- **review 轮（4 个 subagent：桌面主进程 / settings 前端 / 发布流水线 / 文档一致性）**：
  发现并修复——codesign 探测读 stderr（原只读 stdout → mac 恒判阻塞）+ 改异步防阻塞
  启动；`autoUpdater.channel` setter 会重置 `allowDowngrade=true`（重排赋值）；
  beta 需 `allowPrerelease`（否则去最新正式 release 找 beta.yml 404）；dev 需
  `forceDevUpdateConfig`；`downloaded` 态不被周期复查回退；检查失败与下载失败的状态
  区分（检查失败清 `latestVersion`，UI 显示「无法检查更新」且不提供误导重试）；
  `getSnapshot` 纯净化 + 重试重新武装 + push 优先 + 下载在途闸；settings-bridge 的
  Window 声明改为完整 `DshChamberBridge`（import 自 renderer 权威声明，恢复 merge
  不变式）；beta 标点/blocked 原因本地化；release.yml 版本一致性守卫（workflow 版本
  必须等于 desktop package.json）+ prerelease 由版本推导（tag-push 时输入为空）。
  **补（桌面主进程 review 完整报告）**：mac 未签名时 `available` 态不提供「更新」
  按钮（mac 下载即喂 Squirrel，未签名必进 error 循环）——只给手动安装提示 + 下载页
  链接；`UpdateState.error` 路径脱敏（`[path]` 替换绝对路径，完整错误留在主进程
  日志）；`open-release` 白名单改为 `new URL` 解析（origin + pathname 前缀，替代
  startsWith 字符串判断）。

- **M1（主进程更新器 + IPC）**：新增 `packages/desktop/updater.ts`（`electron-updater`
  接入：`autoDownload=false`、`autoInstallOnAppQuit=true`、`allowDowngrade=false`；
  状态机含 `up-to-date`；失败静默日志；mac `installBlockedReason` 经 `codesign -dv`
  探测；Linux 惰性；dev 显式 `setFeedURL`、打包态保留 app-update.yml 烘焙 channel）；
  `preload.cts` 新增 `update` 面（`state`/`download`/`openReleasePage`/`onChanged`）；
  `main.ts` 接线（trustedIpc 三个 handler + 状态推送 + `shell.openExternal` 白名单 +
  `updater.start()` 延迟 15s + 6h 周期）。
- **M2（settings「更新」部分）**：`SettingsShell.tsx` 新增 `__update` chamber 全局固定
  入口（divider 块内，`IconRefreshOutline16`）+ `UpdateSection.tsx`（低调状态行 +
  「更新」按钮 + 下载进度 + 失败态 + mac 安装不可用态 + 下载页链接）+
  `update-store.ts`（模块单例，bridge 异步暴露有界重试）+ zh/en 文案 +
  `SettingsShell.module.css` 样式。
  **2026-08 修订（用户拍板）**：`__update` 固定入口并入「通用」——`UpdateSection`
  改作 `GeneralView` 底部控制组（settings-panel 控制组/胶囊按钮词汇），导航固定入口
  收为 `__connections` / `__general`（设计 15 D1）；新增 **「检查更新」按钮**
  （`dsh-chamber:update-check` → `updater.checkNow()`，与周期静默检查同一条
  `runCheck()` 路径，linux 显式拒绝）+ `update-gate.ts` 相位门（在途检查/下载或
  「已下载」终态禁用，与主进程门一致）+ 纯逻辑测试。
- **M3（通道与发布）**：`DSH_CHAMBER_UPDATE_CHANNEL=beta`；desktop build 配置
  （`publish`、mac zip、files 收 `updater.ts`；`differentialPackage` 于 v0.1.2
  修订为 `false`，见 §6）；release.yml 双 leg 改造（`--publish=always` + GH_TOKEN、
  版本一致性守卫、prerelease 由版本推导、feed 产物断言 + blockmap 清理）。

**验证（2026-08）**：根 `typecheck`（desktop main/preload/updater + renderer）✓；
`typecheck:settings-bridge` ✓；`build:preload`（preload.cts → dist/preload.cjs）✓；
`test:desktop`（5 文件合计 170 用例）✓；`test:settings-bridge`（5 文件合计 31 用例）✓；
`build:renderer` ✓；`verify:i18n` ✓（无 DRIFTED）。`pnpm install --frozen-lockfile` 通过
（electron-updater 加入后锁文件完整，vendor 记录未剪除）。

**剩余验证项**：

- macOS/Windows 公共发布身份门禁已落代码；仍需在配置真实证书秘密后做一次 CI
  实跑，确认 Developer ID 公证 stapling、Authenticode 与更新安装链路。
- release.yml 的 `electron-builder --publish=always` → draft release 上传路径需一次
  真实 CI 运行验证（含 beta channel 的 `beta*.yml` 命名）。
- 双平台实机：检查（stable/beta/无网/坏网络）、确认前不下载、下载 → 退出时安装、
  托盘/窗口行为无回归。

**开放项（未排期）**：

- GitHub repo 可见性：公开 repo 匿名可读 feed；私有 repo 需 generic provider +
  凭据（决定 feed 配置形态）。
- **macOS 签名决策**：是否投入 Developer ID（$99/年 + 公证）——决定 mac 安装腿
  是否可用。
- beta 通道开关形态：v1 仅环境变量 vs 设置项（设置项需 chamber 设置插件面）。
- 百分比灰度的引入评估（§4 升级路径）。

## 10. 关联文档

- `01-overview.md` §3 文档地图（本文档编号 11，2026-08 自 `docs/todo/` 移入）；
  `docs/progress/STATUS.md`（本文档由「未完成 / 待执行」移入「已实现」记录）。
- 涉及面：`packages/desktop`（`main.ts`、`preload.cts`、`updater.ts`、
  `package.json`）、`packages/dsh-chamber-client-ui-settings-bridge`（settings 壳
  `__general` 视图内的 `UpdateSection` + `update-store` + `update-gate`）、
  `.github/workflows/release.yml`。
