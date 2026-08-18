# 11 · 桌面端更新提示（settings 低调展示，无弹窗）与通道灰度（todo：设计定稿，实现未排期）

> **状态：todo**——设计定稿（2026-08 方案讨论收敛 + UX 三轮修订），**实现未排期**
> （M1–M3 建议分期见 §9）。本文为设计契约草案；实现前需细化的开放项见 §9。
>
> 需求来源：升级目标是 **dsh-chamber 自身**（Electron 桌面应用），**不是**远端 dsh
> 实例。现状升级方式 = 手动下载新安装器重装，无任何自动更新/滚动更新能力；本设计
> 为其引入「后台**静默**检查 → settings 低调提示 → **用户明确确认后**后台下载 →
> 退出时安装」，并以**通道模型（beta → stable）**实现滚动/灰度发布。
>
> 决策记录（2026-08，用户拍板）：
> 1. feed/检查源 = **GitHub Releases**（零新增服务器）；
> 2. 灰度策略 = **通道模型 beta → stable**（非百分比灰度）；
> 3. **双平台流程一致**（Windows 与 macOS 同一形态）：`electron-updater` 静默检查 →
>    settings 提示 → 用户确认 → 后台下载 → 退出时安装；**macOS 不手动安装**。
>    macOS 安装腿的硬前置 = Developer ID 签名（Squirrel.Mac 硬前提，ad-hoc 是否
>    放行需 M3 实测）——签名未配置时该腿被阻塞（前置/开放项，**非 UX 分支**）。
> 4. **UX（三轮修订）**：**不弹窗** + **低打扰（不显眼）**——更新信息只在 settings
>    的 chamber 全局「更新」部分低调展示；**后台下载以用户明确确认（点击「更新」）
>    为前提**，用户不确认则永不下载；退出时自动安装（双平台）。

## 1. 现状（为什么现在没有）

| 项 | 现状 | 证据 |
|---|---|---|
| 更新器依赖 | 无 `electron-updater`（devDeps 仅 electron / electron-builder） | `packages/desktop/package.json` |
| 主进程更新代码 | 无 `autoUpdater` / `checkForUpdates` 任何代码；全仓库无「检查更新」UI/IPC | `main.ts`、全仓库 grep |
| 更新产物 | 显式关闭：`dmg.writeUpdateInfo: false`、`nsis.differentialPackage: false` | desktop package.json `build` |
| 发布 feed | `--publish=never`，每平台只传安装器（mac dmg / win exe）——「no zip/blockmap sidecars」 | `.github/workflows/release.yml` |
| 签名 | macOS **ad-hoc**（afterPack 钩子；STATUS 记录「治本仍为 Developer ID + 公证，secrets 未配置」）；Windows 未签名 | `after-pack-adhoc-sign.mjs`、STATUS.md |
| 版本 | chamber 版本 `0.1.0` 分布于 5 包（根/desktop/control-plane/renderer/cli）；4 个 chamber 插件包 `0.1.0-rc.5` 跟随 vendored dsh | 各 package.json |

结论：从零引入的特性。UX = 「settings 低调提示 + **用户确认后**静默下载 + 退出时
安装」→ **双平台统一走 `electron-updater`**，需要 feed 产物（win：exe + blockmap +
`latest.yml`/`beta.yml`；mac：zip + `latest-mac.yml`）；**macOS 安装腿以 Developer ID
签名为硬前置**（未配置 → 阻塞，见 §3.1/§6）。

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
- **下载以用户确认为前提**：没有用户点击，检查后不产生任何下载/网络副作用。
- 检查器/下载器只进 **`packages/desktop` 主进程**；控制面保持 loopback-only、零出网
  不变；渲染层（dsh 官方前端复用面）不参与检查逻辑，只经 IPC 呈现状态。
- **不涉及远端 dsh**：chamber 升级自带新 dsh runtime（`extraResources` 的
  `vendor/dsh`），远端实例版本无关（`verifyUp` 握手已按 dsh 特征签名兼容新旧，
  见 desktop README / `ssh-provider.ts`）。
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
  **要求有效代码签名**——Developer ID 未配置时 mac 安装腿被阻塞（ad-hoc 是否放行
  需 M3 实测；若阻塞，则 mac 停留在「已下载」态并在 settings 响亮提示「安装不可用，
  请手动安装」——**绝不假装已安装**）。这是前置阻塞，不是手动安装的 UX。
- **排除项**：自托管静态 feed——仅百分比灰度需要，v1 不做（§4）。

### 3.2 呈现面：settings 的 chamber 全局「更新」部分（低调、无弹窗）

- **状态流**：主进程 `updater.ts` 状态机（idle → checking → available →
  downloading → downloaded / error）→ 经 preload 新增 IPC
  （`dsh-chamber:update-state` invoke 查询 + push 变更）→ settings 壳渲染。
- **挂载位置**：复用 settings 壳（`packages/dsh-chamber-client-ui-settings-bridge`）
  既有的「chamber 全局固定导航入口」模式——`SettingsShell.tsx` 中
  `CONNECTIONS_SECTION_ID = '__connections'`（divider 之下固定 entry + 嵌入组件，
  不随所选服务器变化）。「更新」部分 = 同一 divider 块下的**第二个 chamber 全局
  固定入口**（如 `__update`），内容为新增 `UpdateSection` 组件。内容小、只读一个
  IPC 状态 → 无需新插件包，直接扩展 settings 壳。
- **部分内容（低调状态行，不显眼）**：
  - 当前版本 vX（读 desktop package.json，`dsh-chamber:info` 已有）；
  - 有新版时一行状态：「新版本 vY（stable/beta）」+ **「更新」按钮**（点击 →
    后台下载；状态行随之变为 下载中… → 已下载，退出时安装）；不点击 → 永不下载；
  - 无新版时：「已是最新版本」；
  - 检查失败时：「无法检查更新」（静默，写环形日志，绝不假成功）；
  - mac 签名未配置时：「已下载（安装不可用，请手动安装）」（响亮不假装）。
- zh/en 文案走现有 locale 命名空间（`verify:i18n` 纪律）；样式用普通列表行
  （dsh design tokens），不加高亮。

## 4. 滚动/灰度：通道模型（beta → stable）

- **stable（默认）**：读最新正式 release 的 `latest.yml` / `latest-mac.yml`。
- **beta（opt-in）**：`DSH_CHAMBER_UPDATE_CHANNEL=beta` 环境变量（v1 形态；设置项
  后续可加，见 §9）→ 读 `beta.yml` / `beta-mac.yml`；settings 部分可标注当前通道。
- **发布侧**：beta = 标记 prerelease 的 GitHub Release（资产含 `beta.yml` 系列）；
  验证通过后发正式 release（资产含 `latest.yml` 系列）——「先内测、后提升」，与
  现有 draft → finalize 手动发布节奏契合。
- **明确不做（v1）**：百分比灰度（按客户端分桶）——需自托管 feed 侧实现；用户
  规模达到再评估（§9 开放项）。

## 5. 更新数据流与 UX

```
启动（延迟 N s）→ 静默检查（autoDownload: false，无网络副作用）
  ├─ 有新版 → settings「更新」部分一行状态「新版本 vY」+ [更新] 按钮
  │     ├─ 用户点击 → 后台自动下载（进度经 IPC → 状态行 下载中…）
  │     └─ 不点击 → 永不下载（仅状态行）
  │  下载完成 → 「已下载，退出时安装」→ quit 时自动安装（双平台一致）
  ├─ 无新版 → 「已是最新版本」
  └─ 失败 → 「无法检查更新」（静默写环形日志，绝不假成功）
每 6h 周期静默复查；settings「更新」部分 = 唯一可见面
```

- **失败语义**：检查/下载/校验/安装任何失败 → 静默或 settings 内响亮（安装失败
  绝不假装成功），**绝不阻塞启动、绝不静默降级**（`allowDowngrade=false`）。
- **无弹窗清单**：主进程 dialog、托盘气泡、系统通知、settings 外的任何提示一律
  不出现。

## 6. 发布流程与构建产物

- **双平台都需要 feed 产物**（electron-updater 消费）：
  - `packages/desktop/package.json`：加 `electron-updater` 依赖；
    `nsis.differentialPackage: true`（win 差分）；mac target 增加 `zip`
    （electron-updater mac 需要 zip，dmg 保留给首装）；新增 `publish` 块
    （github provider，owner/repo）；`writeUpdateInfo` 开启（生成
    `latest*.yml`）。
  - electron-builder 在配置 publish 后于打包阶段生成 `latest.yml` / `beta.yml` /
    `latest-mac.yml` 与 blockmap（`--publish=never` 只跳过上传，产物仍在输出
    目录——M3 实测确认）。
- **`release.yml` 双 leg 改造**：
  - win leg：上传 `*.exe` + `*.blockmap` + `latest.yml`（stable）/ `beta.yml`
    （beta）；
  - mac leg：上传 `*.dmg` + `*.zip` + `latest-mac.yml`（stable）/ `beta-mac.yml`
    （beta）；
  - workflow_dispatch 加 `channel` 输入；beta 走 softprops `prerelease: true`。
  - CI 验证步骤新增：`latest*.yml` 存在、blockmap 存在、yml 内版本与产物一致。
- **macOS 签名前置**：自动安装依赖 Developer ID 签名 + 公证（Squirrel.Mac 硬
  前提）——未配置时 mac 安装腿阻塞（§3.1；M3 实测 ad-hoc 是否放行，若阻塞则
  保持「已下载，请手动安装」的响亮提示，**不做**手动安装的 UX 分支）。

## 7. 安全与已知让步

- **完整性**：`latest*.yml` 内 sha512 校验下载包——无签名也有传输/下载完整性保护。
- **身份（主动让步）**：Windows 不配 `publisherName` → 不做 Authenticode 发布者
  校验；未签名安装器触发 SmartScreen 警告。接受并记录在案；取得证书后可启用校验。
- **出网面**：仅主进程访问 GitHub API / feed（HTTPS）；控制面零出网、loopback
  闭环不变。
- **隐私**：检查/下载不携带任何用户/SSH 材料；仅应用版本与平台信息。
- **用户确认闸**：`autoDownload: false`——无用户点击不产生下载流量（低打扰 +
  减少无谓网络副作用）。
- **失败语义**：超时/网络错误静默 + 日志；settings 显示「无法检查更新」而非假
  成功；安装失败响亮（与仓库 proxy honesty 原则同源）。

## 8. 版本管理与数据兼容

- chamber 版本 `0.1.0` 分布于 5 包（根/desktop/control-plane/renderer/cli），发版时
  **一致 bump**（semver 比较；`main.ts:58` 读 desktop package.json 的 version 并
  透传控制面）。4 个插件包 `0.1.0-rc.5` 跟随 vendored dsh，**不动**。
- 更新只替换应用本体；`userData`（`ssh-instances.json`、state、
  `ssh-passwords.json`）天然保留。未来若改变注册表/状态格式 → 首启迁移（幂等、
  失败响亮不冒充成功）。

## 9. 实现清单（未排期）与开放项

**实现清单**（建议分期）：

- **M1（主进程更新器 + IPC）**：新增 `packages/desktop/updater.ts`——`electron-updater`
  接入（github provider、`autoDownload: false`、`autoInstallOnAppQuit: true`）+ 状态机
  （idle → checking → available → downloading → downloaded / error）+ 失败静默日志 +
  preload 新增 `dsh-chamber:update-state`（invoke 查询 + push 变更，沿用
  `desktop_ssh_*` 模式）+ `main.ts` 启动接入（延迟 N s + 6h 周期）+ 「更新」点击 →
  `downloadUpdate()` 动作通道。
- **M2（settings「更新」部分）**：settings 壳新增 chamber 全局固定入口（`__update`，
  divider 块内，与 `__connections` 并列）+ 低调 `UpdateSection` 组件（当前版本 /
  新版本状态行 + [更新] 按钮 / 下载进度状态行 / 失败态 / mac 安装不可用态）+
  zh/en 文案（`verify:i18n`）。
- **M3（通道与发布）**：`DSH_CHAMBER_UPDATE_CHANNEL=beta` + desktop build 配置
  （`publish`、mac zip、`writeUpdateInfo`、`differentialPackage`）+ release.yml 双 leg
  产物/通道改造 + CI 验证 + 双平台手工验证（stable / beta / 无网 / 坏网络 /
  确认前不下载 / 下载 → 退出时安装）；**mac 签名前置实测**（ad-hoc 是否放行，
  决定 mac 安装腿形态）。

**开放项（实现前细化）**：

- GitHub repo 可见性：公开 repo 匿名可读；私有 repo 需 generic provider + 凭据
  （决定 feed 配置形态）。
- **macOS 签名决策**：是否投入 Developer ID（$99/年 + 公证）——决定 mac 安装腿
  是否可用（§3.1/§6）。
- 检查频率 / 启动延迟 / settings 文案（zh/en）。
- beta 通道开关形态：v1 仅环境变量 vs 设置项（设置项需 chamber 设置插件面）。
- 百分比灰度的引入评估（§4 升级路径）。

## 10. 关联文档

- `01-overview.md` §3 文档地图（本文档编号 11）；`docs/progress/STATUS.md`
  （本文档列入「未完成 / 待执行」）。
- 涉及面：`packages/desktop`（`main.ts`、`preload.cts`、`package.json`、新增
  `updater.ts`）、`packages/dsh-chamber-client-ui-settings-bridge`（settings 壳新增
  chamber 全局入口与 `UpdateSection`）、`.github/workflows/release.yml`（双 leg）。
