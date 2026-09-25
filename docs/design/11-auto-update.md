# 11 · 桌面端更新提示（settings 低调展示，无弹窗）与通道灰度

> **dsh-chamber 应用本体更新；macOS/Windows/Linux 按运行形态门控**——本文是应用更新通道的权威行为契约：GitHub Releases feed、后台静默检查、settings 低调提示、用户明确确认后才下载、退出时安装 + 界面内「重启并安装」、beta → stable 通道模型与发布侧纪律；未完成门禁见 `docs/progress/STATUS.md`。

## 1. 需求与动机（当前形态）

**更新目标是 dsh-chamber 自身**，**不是**远端 dsh 实例。诉求：
「后台**静默**检查 → settings 低调提示 → **用户明确确认后**后台下载 → 用户控制安装时机
（界面内「重启并安装」按钮；不点击则保持退出时安装）」，并以**通道模型（beta → stable）**
实现滚动/灰度发布。

| 项 | 当前形态 | 证据 |
|---|---|---|
| 更新器依赖 | `electron-updater`（desktop dependencies） | `packages/desktop/package.json` |
| 主进程更新代码 | `packages/desktop/updater.ts` 控制器 + `main.ts` trustedIpc handler + preload `update` 面 | 同左 |
| 更新产物 | mac target = `dmg` + `zip`（dmg 留首装、不产 update-info：`writeUpdateInfo: false`）；win `nsis` `differentialPackage: false` + `useZip: false`（不发 blockmap、保 7z 高压缩） | desktop `build` 配置 |
| 发布 feed | build 走 `--publish=always`（`GH_TOKEN`）把产物含 feed 上传进 draft release；`--publish=never` **不生成** update-info yml | `.github/workflows/release.yml` |
| 签名 | macOS 正式发布强制 Developer ID + 公证 + stapler + spctl；Windows 未签名（SmartScreen 提示，§7 的明确让步） | release.yml、§7 |
| 版本 | 根 `dsh-chamber` + 全部 `@dsh-chamber/*` 包一致 bump（17 个）；三个 fork 副本保持上游基线版本 | `release-preflight.mjs`、§8 |


## 2. 目标与边界

**目标**：dsh-chamber 桌面端后台**静默**检测新版本（stable/beta 通道），在 **settings 的 chamber 全局「更新」部分**以**低调**一行状态提示「有新版本 vY」；**用户明确点击「更新」后**才后台自动下载，**退出时自动安装**——Windows 与 macOS 流程一致，全程无弹窗。

**边界（硬约束）**：

- **无弹窗**：主进程 dialog、托盘气泡、系统通知一律不出现（与仓库「notifications 移出」纪律一致）。
- **低打扰**：settings 内只用**普通状态行**低调展示（无高亮徽标/角标/横幅/开机即弹）。
- **下载以用户确认为前提**：无用户点击，检查只访问更新发现 API/feed，无包下载或安装副作用（`autoDownload=false`）。
- 检查器/下载器只进 **`packages/desktop` 主进程**；控制面保持 loopback-only、零出网；渲染层不参与检查逻辑，只经 IPC 呈现状态。
- **不涉及远端 dsh**：chamber 升级自带新 dsh runtime（`extraResources` 的 `vendor/dsh`），远端实例版本无关（`verifyUp` 已按 dsh 特征签名兼容新旧）。
- 不引入认证面、不改控制面契约（05 权威契约不动）。

## 3. 选型与架构：平台同形态（electron-updater）

### 3.1 机制：`electron-updater`（github provider），平台同一形态

- **检查**：stable 保留 electron-updater GitHub provider，读正式 release 的 `latest.yml`（mac 为 `latest-mac.yml`）。beta 不把 GitHub provider 的 channel fallback 当安全边界：主进程用 Electron `net.fetch` 请求固定仓库 Releases list API（10s timeout、最多 100 条），只接受 `draft=false`、`prerelease=true` 且 tag 精确匹配 `vX.Y.Z-beta.N` 的发布，选最高版本后把 updater 切到 `/releases/download/<exact-tag>/` 的 Generic provider（channel=`beta`），再读 `beta.yml` / `beta-mac.yml`。网络/JSON/候选/规范校验失败时不调用 updater，因而不会从缺失的 beta feed 回退到 stable `latest*`。
- **下载**：默认 **不自动下载**（`autoDownload: false`）——发现新版本置 `available`，**仅当用户点击** settings「更新」部分的「更新」按钮才调 `downloadUpdate()` 后台下载（无进度弹窗，进度只经 IPC 反映为 settings 状态行）。
- **安装**：下载完成置 `downloaded`，`autoInstallOnAppQuit: true`——**退出时自动安装**（不打断活跃会话；无安装弹窗）。
  **「重启并安装」（退出腿不是可控安装流程）**：普通退出是否触发
  安装/重启因平台与运行形态而异（mac 的 Squirrel 安装发生在受控 relaunch、
  退出腿在清理超时走 `app.exit(1)` 时会跳过 onQuit 安装等），因此 `downloaded`
  状态行提供**「重启并安装」**主按钮（IPC `dsh-chamber:update-restart` →
  `updater.restartAndInstall()` → electron-updater `quitAndInstall()`）。平台范围：**macOS + Windows**；**Linux 一律不提供**（AppImageUpdater 点击瞬间原位替换并同步拉起新实例，新实例必被仍存活的老实例吸收——自动重启结构性落空；Linux 保留退出腿）。门：`downloaded` + 安装未被阻塞（mac 签名），主进程在 IPC 边界再强制一次（与 `download()` 同纪律）；成功即 fire-and-forget（单飞闸不复位），同步失败不回退 phase（保持 `downloaded` 原位重试），`error` 事件（含 arm 后异步失败）释放单飞闸；arm 后宽限期未退出由 no-event watchdog（`restartWatchdogMs`，默认 60s）释放单飞并给如实文案。重启失败经一次性 `restartFailureText` carry（脱敏）呈现，phase 保持 `downloaded` 并渲染重启专用失败行 + 原位重试。
    **关窗次序不变量（缺陷修复）**：`quitAndInstall` **先关闭全部窗口、关完才退出，不走正常退出序列开头**（Electron 43.4.0 typings `AutoUpdater#before-quit-for-update` 明文「`before-quit` 不会在所有窗口关闭前发出」；43.4.0/darwin 探针证实 `before-quit-for-update` 与窗口 `close` 都在 `quitAndInstall()` 内部、早于 `before-quit`）。而「关窗到托盘」（design 14 D1，默认 `hide-to-tray`）以 `quitRequested`（`before-quit` 置位，即关窗**之后**）为放行条件——退出腿的关窗会被 hide 吞掉：页面消失、进程永久留存、更新永不安装。故控制器在 `quitAndInstall()` 前同步回调 `onQuitAndInstallArmed`，主进程在该回调武装 `updaterQuitArmed`（关窗在该调用内部，返回后再置位已晚；拒绝路径不回调，无「假武装」），武装期间 `shouldHideToTray` 恒 false；重启失败或停滞（`restartFailureText` / 相位离开 `downloaded`）立即撤回，并把被更新关掉的窗口拉回主界面（失败/停滞文案的唯一诚实呈现面；窗口若**重建**，同一次 `UPDATE_STATE_CHANGED` 推送会落在还没装监听的 renderer 上，靠 renderer 挂载时的 `UPDATE_STATE` pull 补齐）。回归契约（main.ts + 武装标志生命周期）+ `test/local-state/chamber-settings.test.ts`（含 `shouldUpdaterQuitTakeOver` 真值表）+ `test/desktop-shell/updater-restart-install.test.ts`（native 退出事件必须把停滞 watchdog **重锚**——不是清除：它是该路径单飞闸唯一释放者，清掉会「永远 restart in progress」，重锚则既不中途误报停滞、又保证腿走不完时仍有如实文案与就地重试）；真实 macOS 端到端仍是实机门禁（§9）。
  **原生退出桥与兜底（同一条缺陷的另一半）**：控制器订阅原生 autoUpdater 的 `before-quit-for-update`（在 `quitAndInstall()` 内部、关窗之前发出——43.4.0/darwin 实测），经 `onNativeUpdaterQuitting` 回调宿主：①**每次**原生退出都重新武装关窗豁免（覆盖「首次武装已被停滞 watchdog 撤回、原生退出迟到」的窗口）；②宿主在宽限期（5s）后若进程仍未进入退出序列（`before-quit` 未到）就自行 `app.quit()`，走正常 before-quit/will-quit 清理完成退出。**此刻自退安全**：该事件只在 Squirrel 完成 staging 后发出（MacUpdater 仅在 `squirrelDownloadedUpdate` 或原生 `update-downloaded` 之后才调原生 quitAndInstall），退出即安装。**「原生腿关窗后走不到 `before-quit`」仍是未复测的观察**：typing 只保证 `before-quit` 不在所有窗口关闭前发出；兜底两种情形都安全（`before-quit` 会到时 `quitRequested` 已置位，`shouldUpdaterQuitTakeOver` 返回 false），§9 实机门禁顺带记录。原生 autoUpdater 的解析严格门控在 Electron 运行时内（`process.versions.electron`）且仅在宿主提供回调时进行：`electron` 说明符在普通 node 下解析到 npm 包，dist 缺失时会触发 ~100MB 二进制下载（实测踩中），绝不允许出现在测试路径上。
  **退出腿与重启腿对 `app.exit(1)` 的语义不同**：超时强制退出只跳过退出腿的 onQuit 安装；重启腿 NSIS 安装器已 detached 先行、AppImage 已原位替换，安装照常完成；用户不点击则退出时安装仍开启。
- **macOS 签名前置（非 UX 分支）**：Squirrel.Mac（electron-updater mac 安装器）**要求有效 Developer ID 代码签名**。正式发布强制签名/公证/stapler/spctl，失败阻断公开；`updater.ts` 启动时仍以 `codesign -dv` 探测签名 authority（读 stderr、异步免阻塞启动），非正式 ad-hoc 包置 `installBlockedReason`，settings 响亮提示手动安装，**绝不假装自动安装可用**。dry-run ad-hoc 资产不上传/公开。
- **channel 实现细节**：打包版本只有精确 canonical `-beta.N` 后缀时自动判 beta，不依赖未烘焙环境变量；其他 prerelease 门禁直接拒绝；`DSH_CHAMBER_UPDATE_CHANNEL=beta` 仍供开发/显式 opt-in。stable 用打包态 `app-update.yml` 的 GitHub provider；beta 每次检查前按上条解析并显式 `setFeedURL` 到精确 tag Generic feed，且必须开启 `allowPrerelease`（否则会去最新正式 release 找 `beta.yml` 而 404）；`autoUpdater.channel` setter 会重置 `allowDowngrade=true`，赋值顺序须保证 `allowDowngrade=false` 最后生效；dev 形态需 `forceDevUpdateConfig`。
- **Linux 形态门（design 22）**：按**运行形态**门控——打包且从可写 `$APPIMAGE` 启动（AppImage 发行形态）才启用；dev/解包/deb 保持 inert 文案（`probeLinuxAppImage`）。feed 为 `latest-linux.yml` / `beta-linux.yml`。
- **排除项**：自托管静态 feed（仅百分比灰度需要，v1 不做，§4）。

### 3.2 呈现面：settings 的 chamber 全局「更新」部分（低调、无弹窗）

- **状态流**：主进程 `updater.ts` 状态机（idle → checking → up-to-date → available →
  downloading → downloaded / error；`up-to-date` = 已检查且无新版，区别于未检查的
  idle）→ 经 preload IPC（`dsh-chamber:update-state` invoke 查询 + `update-state-changed`
  push）→ settings 壳渲染。
- **挂载位置**：settings 壳（`packages/dsh-chamber-client-ui-settings-bridge`）
  的**「客户端」段内**（`__general` 固定入口 → `GeneralView` 底部嵌入 `UpdateSection`
  控制组）——原独立的 `__update` 固定入口已并入「客户端」（由「通用」
  改名，避免与官方 `general.nav` 同名，见 design 15）；固定入口结构（`__connections` / `__general`）与并入决策以**设计 15** 为权威。「更新」控制组 = `UpdateSection` 组件（`update-store.ts` 模块单例
  订阅，N-ctx 共享）。内容小、只读一个 IPC 状态 → 无需
  新插件包，直接扩展 settings 壳。
- **上游相位对比（2026-12 评估，不纳入）**：上游 Desktop 的相位集另有 `verifying`（进度 100% 到 `ready` 之间的核对窗）与 `ready`（= 本设计的 `downloaded`），失败面另有 `failedOperation`（check/download/install）与 `preparationFailure`。评估结论是**不纳入**：`downloaded` 已等价 `ready`；`verifying` 在 electron-updater 内没有独立行为面（进度 100% 直接落 `downloaded`）；chamber 的 `failureKind` 两分类加上「重启/安装失败保持 `downloaded` 相位 + 一次性 `restartFailureText`」已经保住了上游那条「准备/安装前被拒 = 可恢复」的性质（相位不回退、也不误报成下载失败），再引一套并行拼写只会让两 flavor 投影与锁定测试无谓翻新。
- **状态机纪律**：`up-to-date`（已检查且无新版）与 `idle`（未检查）区分；`downloaded` 是终态，周期复查不得回退；检查失败与下载失败分别呈现——检查失败清空 `latestVersion`（状态行「无法检查更新」，不提供误导性重试），下载失败保留可见失败态；重试重新武装检查；状态推送优先于查询快照；`getSnapshot` 纯净（无副作用）；下载在途闸防重复下载。
- **部分内容（低调状态行，不显眼）**：
  - 当前版本 vX（主进程投影 `currentVersion`，`dsh-chamber:info.version` 兜底）；
  - **「检查更新」按钮**：点击 → 主进程同一条静默检查
    路径（`dsh-chamber:update-check` → `updater.checkNow()`，`autoDownload=false`
    不变——检查永不下载）；在途检查/下载或「已下载」终态时按钮禁用（`update-gate.ts`
    相位门，与主进程 `runCheck()` 门一致；Linux 形态不自持时显式拒绝）；检查结果经状态行呈现；
  - 有新版时一行状态：「新版本 vY（stable/beta）」+ **「更新」按钮**（点击 →
    后台下载；状态行随之变为 下载中… → 已下载，退出时安装）；不点击 → 永不下载；
    **mac 未签名时不提供「更新」按钮**（mac 下载即喂 Squirrel，未签名必进 error 循环）——只给手动安装提示 + 下载页链接；
  - 已下载（安装可用）时：「已下载，退出时安装」+ **「重启并安装」按钮（仅 macOS/Windows——Linux 任何形态不提供，AppImage 单实例竞态）**：
    点击 → `dsh-chamber:update-restart` →
    `quitAndInstall`（退出/安装/重启，走正常清理路径）；安装被阻塞（mac 签名）时不提供该按钮——只给手动安装提示 + 下载页链接；重启在途渲染专用行（「正在重启并安装…」），重启失败渲染专用失败行 + 原位重试；
  - 无新版时：「已是最新版本」；检查失败时：「无法检查更新」（静默，绝不假成功）；
  - mac 签名未配置时：「已下载（…），请手动安装」+「前往下载页」链接（经主进程 `shell.openExternal`，仅允许本仓库 GitHub 页——窗口禁 popup/navigation）。
  - 失败文案脱敏：`UpdateState.error` 以 `[path]` 替换绝对路径，完整错误只留主进程日志。
- zh/en 文案走 `dsh-chamber.settings.bridge` 命名空间（`verify:i18n` 通过；beta 通道标注与安装受阻原因同样本地化）；样式用普通列表行（dsh design tokens），不加高亮（settings-panel 控制组/胶囊按钮词汇）。
- **IPC 面**：`dsh-chamber:update-state`（invoke 查询）、`update-state-changed`（push）、`update-check`、`update-download`、`update-restart`、`open-release`；preload 暴露 `state`/`download`/`restartAndInstall`/`openReleasePage`/`onChanged`，主进程在 trustedIpc 边界复核每道门。渲染侧（`update-store` / `update-gate`）相位门与主进程门逐字对齐——重启可用性 = `downloaded` ∧ 安装未被阻塞 ∧ 非 linux（platform 参数传纯门）；重启成功不回位模块闸（同主进程单飞语义），重启失败按失败 push 复原（不刷新即可原位重试）；preload/renderer 的 `UpdateSurface` / `UpdateState` 与 `updater.ts` 逐字锁步。

### 3.3 启动清理已安装版本的更新缓存

electron-updater 6.x **安装成功后从不删除**下载产物（`DownloadedUpdateHelper.clear()` 只在失败重下路径调用），缓存目录残留 update.zip + pending（实测单轮 ~308MB）。控制器启动即做**保守清理**：

- `resolveUpdaterCacheDir` 按 electron-updater 同款推导缓存目录：平台缓存根（darwin `~/Library/Caches` / win32 `%LOCALAPPDATA%` / linux `$XDG_CACHE_HOME` 或 `~/.cache`）+ 打包态 `app-update.yml` 烘焙的 `updaterCacheDirName`；dev 形态不解析；目录名拒绝分隔符与 `.`/`..` 逃逸；**解析结果必须是目标平台判定下的绝对路径**——相对 env 根（伪造/损坏的 `XDG_CACHE_HOME` / `LOCALAPPDATA`）直接不解析。
- 读 `pending/update-info.json` 的 `fileName` 解析规范版本（`cachedUpdateVersion`；数字粘连按贪婪分组解析——只在本仓库命名契约下安全：规范版本只有 `X.Y.Z` / `X.Y.Z-beta.N`，无第四段、无其他 prerelease 拼写；**命名一变必须重访解析器与比较器**），与运行版本比较（`compareChamberVersions`：`X.Y.Z` / `X.Y.Z-beta.N`，stable > 同基 beta）。
- **仅当缓存版本 ≤ 运行版本**才整目录删除；更新的未装版本、缺元数据、版本不可解析、形状不合（JSON null/数组/标量/无 fileName）一律保留——失败保守，绝不误删合法待装下载。fire-and-forget + 永不 throw；DI seam：`UpdateControllerDeps.staleCache`（测试注入；`{cacheDir:null}` 关闭）。
- **整目录删除（含 update.zip）为何安全**：feed **从不发布 blockmap**（release.yml 在 finalize 前删 mac `.zip.blockmap` 并断言输出无 `.blockmap`，win 侧 `nsis.differentialPackage=false`），electron-updater 永不运行差分路径、update.zip 永不作差分基线；整目录删除正确，每轮回收 ~300MB。
- **潜在耦合（LATENT COUPLING）**：若未来重新发布 blockmap，update.zip 将重成差分基线，`cleanupStaleUpdateCache` 的整目录删除调用点必须改为保留 update.zip——发布改动前必须重访。
- **有界残留（如实记录）**：元数据缺失/损坏时整目录保留——崩溃于文件落盘后、写 info 前或 info 被外部删除时，单次 ~300MB 孤儿残留直到下一下载周期覆盖；属保守取舍，无误删风险。

## 4. 滚动/灰度：通道模型（beta → stable）

- **stable（默认）**：读最新正式 release 的 `latest.yml` / `latest-mac.yml`。
- **beta**：canonical `X.Y.Z-beta.N` 应用按自身版本自动进入 beta；开发/显式 opt-in 仍可用 `DSH_CHAMBER_UPDATE_CHANNEL=beta`。消费侧只从最高规范 published beta 的精确 tag 读 `beta.yml` / `beta-mac.yml`；发现失败 fail closed，不尝试 `latest*`；settings 部分标注「beta 通道」。
- **发布侧**：beta = 版本精确匹配 canonical `X.Y.Z-beta.N`（如 `0.2.0-beta.1`）→ 独立
  `electron-builder.beta.yml` 显式产 `beta*.yml`；stable 用默认配置只产 `latest*.yml`；`alpha`、`rc` 与其他 prerelease 一律版本门禁拒绝。GitHub Release 的 prerelease 标志由已校验的 canonical beta 版本推导（非 workflow 输入——tag-push 时输入为空，按输入推导会把 beta feed 发到非 prerelease release，稳定客户端会把该 release 当最新并 404 在 latest.yml）；验证通过后发正式版本（`latest*.yml`）——「先内测、后提升」，契合既有 draft → finalize 手动节奏。
- **明确不做（v1）**：百分比灰度（按客户端分桶）——需自托管 feed 侧实现；用户规模达到再评估。

## 5. 更新数据流与 UX

```
启动（延迟 15s）→ 静默检查（autoDownload: false，仅发现请求、无包下载）
  ├─ 有新版 → settings「客户端」段更新组一行状态「新版本 vY」+ [更新] 按钮
  │     ├─ 用户点击 → 后台自动下载（进度经 IPC → 状态行 下载中…）
  │     └─ 不点击 → 永不下载（仅状态行）
  │  下载完成 → 「已下载，退出时安装」+ [重启并安装]（仅 macOS/Windows——
  │    Linux 保留退出腿，见 §3.1）
  │     ├─ 用户点击 [重启并安装] → quitAndInstall：退出（正常清理）→
  │     │   安装 → 自动重启到新版本（确定性受控流程）
  │     └─ 不点击 → 退出时安装（autoInstallOnAppQuit，平台决定行为）
  ├─ 无新版 → 「已是最新版本」
  └─ 失败 → 「无法检查更新」（静默写主进程日志，绝不假成功）
用户主动点击 [检查更新] → 同一条检查路径（update-check IPC，仍不下载）
每 6h 周期静默复查；settings「客户端」段的更新组 = 唯一可见面
```

- **失败语义**：检查/下载/校验/安装任何失败 → 静默或 settings 内响亮（安装失败绝不假装成功），**绝不阻塞启动、绝不静默降级**（`allowDowngrade=false`）。
- **无弹窗清单**：主进程 dialog、托盘气泡、系统通知、settings 外的任何提示一律不出现。

## 6. 发布流程与构建产物

- **三平台都需要 feed 产物**（electron-updater 消费）：
  - `packages/desktop/package.json`：`electron-updater` 依赖；mac target 为 `dmg` + `zip`（electron-updater mac 需要 zip；dmg 保留首装且不产 update-info：`writeUpdateInfo: false`）；默认 `publish` 块是 stable GitHub provider（owner=`panzeyu2013`，repo=`dsh-chamber`）。beta 构建显式用 `packages/desktop/electron-builder.beta.yml`（经只导出 build 对象的 `electron-builder.base.cjs` 继承同一 files/signing/runtime 配置并把 publish channel 固定为 beta，不改写产物名）。**不发布 blockmap 侧车（v0.1.2 起）**：`nsis.differentialPackage: false` **且** `nsis.useZip: false`——true/true 会产 `exe.blockmap` 侧车而 feed 从不引用；且 `differentialPackage: false + useZip: true` 会让 NSIS 从 7z(LZMA) 退化为 zip，exe 从 ~123MB 膨胀到 ~169MB（NsisTarget：`!isBuildDifferentialAware && useZip ? "zip" : "7z"`）。故统一不发 blockmap 且保持 7z 高压缩（win 配置关闭 + mac finalize 前删 asset）。
  - **发布必须走 `--publish`**：`--publish=never` **不生成** update-info yml（app-builder-lib PublishManager 仅在 `isPublish` 时执行 `createUpdateInfoTasks`）。
- **`release.yml` legs（mac / windows / linux + gateway）**：
  - CI/release 中 `actions/checkout`、`pnpm/action-setup`、`actions/setup-node` 一律钉死完整 40 位 commit SHA；`pnpm run test:release-workflow` 离线核对两份 workflow 的 pin 完整且逐 action 一致（validation job 先于依赖安装）；
  - build 走 `--publish=always`（`GH_TOKEN`）——electron-builder 把全部产物**包括 feed 文件**上传进 create-release 的 draft release；win leg = `*.exe` + `latest.yml` / `beta.yml`（**无 blockmap**）；mac leg = `*.dmg` + `*.zip` + `latest-mac.yml` / `beta-mac.yml`；linux leg = `*.AppImage` + `latest-linux.yml` / `beta-linux.yml`（发行形态门见 §3.1，design 22）；
  - workflow_dispatch 的 `version` 输入先校验为 canonical stable `X.Y.Z` 或 beta `X.Y.Z-beta.N`（其他 prerelease fail closed），且必须等于根与全部 chamber package 版本（数据驱动扫描），防 electron-builder 上传到幻影版本 draft。create-release 显式 `needs: validation`；任何删除/创建 GitHub Release 的写操作都在 release-local 验证通过之后；非 dry-run 在任何 Release 变更前先校验 macOS Developer ID 签名/公证凭据；顶层 `release-publish` concurrency 发布串行且 `cancel-in-progress:false`，避免不同 tag 并发改写共享 channel feed；checkout HEAD、tag peel 与 `${{ github.sha }}` 三者必须一致，draft 的 `target_commitish` 绑定同一 SHA；已公开 release 不可变并阻断重跑，只删除同 tag 陈旧 draft；draft 的 `prerelease` 由已过 stable/canonical-beta 门禁的版本推导，beta release `make_latest=false` 只携带 `beta.yml`/`beta-mac.yml`，stable `make_latest=true` 只携带 `latest.yml`/`latest-mac.yml`；`dry_run` 无条件 unset 全部签名/公证环境变量与 `GH_TOKEN`，回退 `--publish=never` 且跳过既有 Release 删除、draft 创建与 finalize 写操作，保证 ad-hoc + 零远程写 build+validate-only；
  - CI 验证步骤：非 dry-run 时做通道正、负断言——stable 只许 `latest.yml`/`latest-mac.yml`，beta 只许 `beta.yml`/`beta-mac.yml`；并断言**无** blockmap 产物，防两条 feed 互相覆盖；finalize 前经 GitHub API 删除 draft release 里的 `*.zip.blockmap`（electron-builder 硬编码生成、无开关；feed 不引用，删除后 mac 更新退化为全量 zip）。
- **beta 消费侧闭环**（细则同 §4）：仅 canonical `X.Y.Z-beta.N` 自动判 beta；每次检查用有界 Releases API 解析最高 canonical published beta 后切 exact-tag Generic feed，发现失败在调用 updater 前收敛，隔离 GitHubProvider 的 stable fallback。
- **macOS 签名前置**：正式发布缺凭据在 Release mutation 前阻断、签名/stapler/spctl 失败在 finalize 前阻断（Squirrel.Mac 依赖 Developer ID 签名 + 公证）；仅 dry-run 允许 ad-hoc（强制 unset 签名/公证环境与 `GH_TOKEN`，零 Release 写入/上传）。

## 7. 安全与已知让步

- **完整性**：`latest*.yml` 内 sha512 校验下载包——无签名也有传输/下载完整性保护。
- **发布身份**：正式 macOS release 必须提供 `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`，并通过 `codesign`/`spctl`/`stapler`；dry-run 无条件清空这些凭据与 `GH_TOKEN`，再由 afterPack 做结构合法的 ad-hoc 签名。Windows 首版仍未签名（SmartScreen 警告，明确让步，不伪称已有 Authenticode）；sha512 只提供下载完整性，不能替代发行者身份。
- **出网面**：仅主进程访问 GitHub API / feed（HTTPS）；控制面零出网不变。
- **隐私**：检查/下载不携带任何用户/SSH 材料；仅应用版本与平台信息。
- **用户确认闸**：`autoDownload: false`——无用户点击不产生下载流量。
- **打开链接白名单**：`dsh-chamber:open-release` 仅允许 `https://github.com/panzeyu2013/dsh-chamber/*`（`new URL` 解析后校验 origin + pathname 前缀，主进程执行），渲染层无法打开任意 URL。
- **失败语义**：超时/网络错误静默 + 日志；settings 显示「无法检查更新」而非假成功；安装失败响亮（与仓库 proxy honesty 原则同源）。

## 8. 版本管理与数据兼容

- chamber 版本分布于根 `dsh-chamber` + **17 个** `@dsh-chamber/*` 包（desktop/control-plane/renderer/cli/dsh-runtime/gateway + 4 个宿主种子包 client-graph/git-worktree/archive-cleanup/open-in + **7 个客户端插件包** sidebar/layout/settings-connections/settings-bridge/git/open-in/mobile），发版时**一致 bump**（semver 比较；`main.ts` 读 desktop package.json 的 version 并经 `dsh-chamber:info` 透传渲染层、注入更新控制器）。**release.yml 的 `Assert version matches package.json` 步骤复用 `release-preflight.mjs --versions-only` 数据驱动扫描器**：根 + 全部 17 个 `@dsh-chamber/*` 包必须等于目标版本，新增包自动纳入；三个 fork 副本（`@deepseek-ai/dsh-client-connection` / `dsh-client-web` / `dsh-api-gateway`）必须保持上游基线 **0.1.7-rc.2**（`release-preflight.mjs` 的 `FORK_VERSION`，随源码线 pin 移动）；发布 checklist §1/§1.5 与该硬门同口径。vendored dsh 源为 0.1.7-rc.2（单一来源 `harness.commit`）——插件版本只在 chamber 侧参与 workspace 解析，不与 dsh 源逐位对齐、也不参与比较/展示。
- 更新只替换应用本体；`userData`（`ssh-instances.json`、state、
  `ssh-passwords.json`（schema v2 endpoint binding）、`gateway-secrets.json`
  （schema v3 target binding 桌面凭据存储：
  safeStorage 加密 / 0600 明文回退，design 17 §12））天然保留。未来若改变
  注册表/状态格式 → 首启迁移（幂等、失败响亮不冒充成功）。
- 升级不要求升级远端 dsh；与旧版本 chamber 的远端实例握手兼容（`verifyUp`）。

## 9. 关联文档

- `01-overview.md` §3 文档地图（本文档编号 11）。
- `docs/progress/STATUS.md`：本文**尚未闭环的实机验证项**与**未排期开放项**的唯一记录处——含真实 Developer ID 凭据下的发布 CI 实跑（公证/stapling/spctl + 更新
  安装链路）、`--publish=always` → draft release 上传路径的一次真实 CI 运行
mac/win/linux 实机检查
  与「确认前不下载 → 下载 → 退出时安装 → 重启并安装」端到端、打包态实测一次
  「升级 → 重启 → 更新缓存被自动清空」、真实同步失败路径下的 `quitAndInstall`、
  以及 mac 原生 quit 语义断言清单（窗口**真正关闭**而非隐藏到托盘；剩余待实机确证 = **签名正式包**端到端：will-quit 清理日志先于新版本启动、无孤儿进程、退出码 0、新版本自动启动、staging 失败下的文案与窗口恢复）。仓库转私有、beta 通道开关形态（仅环境变量 vs 设置项）、百分比灰度评估（§4）同样登记在那里。
- 涉及面：`packages/desktop`（`main.ts`、`preload.cts`、`updater.ts`、
  `package.json`）、`packages/dsh-chamber-client-ui-settings-bridge`（settings 壳
  `__general` 视图内的 `UpdateSection` + `update-store` + `update-gate`）、
  `.github/workflows/release.yml`。
