# 11 · 桌面端自动更新与通道灰度（todo：设计定稿，实现未排期）

> **状态：todo**——设计定稿（2026-08 方案讨论收敛，四项决策已定），**实现未排期**
> （M1–M3 建议分期见 §9）。本文为设计契约草案；实现前需细化的开放项见 §9。
>
> 需求来源：升级目标是 **dsh-chamber 自身**（Electron 桌面应用），**不是**远端 dsh
> 实例。现状升级方式 = 手动下载新安装器重装，无任何自动更新/滚动更新能力；本设计
> 为其引入「应用内检测 → 提示 → 下载 → 安装」与**通道模型（beta → stable）**灰度。
>
> 决策记录（2026-08，用户拍板）：
> 1. feed 托管 = **GitHub Releases**（零新增服务器）；
> 2. 灰度策略 = **通道模型 beta → stable**（非百分比灰度）；
> 3. macOS = **降级为「检测 + 提示手动下载」**（不投入 Developer ID 签名，自动安装
>    存在硬阻塞）；
> 4. 更新 UX = **提示后下载 → 退出时安装**（连接管理器不打断活跃会话）。

## 1. 现状（为什么现在没有）

| 项 | 现状 | 证据 |
|---|---|---|
| 更新器依赖 | 无 `electron-updater`（devDeps 仅 electron / electron-builder） | `packages/desktop/package.json` |
| 主进程更新代码 | 无 `autoUpdater` / `checkForUpdates` 任何代码；全仓库无「检查更新」UI/IPC | `main.ts`、全仓库 grep |
| 更新产物 | 显式关闭：`dmg.writeUpdateInfo: false`、`nsis.differentialPackage: false` | desktop package.json `build` |
| 发布 feed | `--publish=never`，每平台只传安装器（mac dmg / win exe）——「no zip/blockmap sidecars」 | `.github/workflows/release.yml` |
| 签名 | macOS **ad-hoc**（afterPack 钩子；STATUS 记录「治本仍为 Developer ID + 公证，secrets 未配置」）；Windows 未签名 | `after-pack-adhoc-sign.mjs`、STATUS.md |
| 版本 | chamber 版本 `0.1.0` 分布于 5 包（根/desktop/control-plane/renderer/cli）；4 个 chamber 插件包 `0.1.0-rc.5` 跟随 vendored dsh | 各 package.json |

结论：从零引入的特性；macOS 自动安装存在**硬性签名前置**（Squirrel.Mac 拒绝未签名
更新），直接塑造了本设计的双平台分层形态（§3.2）。

## 2. 目标与边界

**目标**：dsh-chamber 桌面端支持「应用内检测新版本 → 提示 → 下载 → 安装」，并以
**通道模型（beta → stable）**实现滚动/灰度发布（内测先行、验证后提升）。

**边界（硬约束）**：

- 更新器只进 **`packages/desktop` 主进程**；控制面保持 loopback-only、零出网不变；
  渲染层（dsh 官方前端复用面）不参与、不消费更新逻辑。
- **不涉及远端 dsh**：chamber 升级自带新 dsh runtime（`extraResources` 的
  `vendor/dsh`），远端实例版本无关（`verifyUp` 握手已按 dsh 特征签名兼容新旧，
  见 desktop README / `ssh-provider.ts`）。
- 不引入认证面、不改控制面契约（05 权威契约不动）。

## 3. 选型与架构：双平台不对称（有意为之，代码内显式可见）

### 3.1 更新机制与 feed

- **机制**：`electron-updater`（electron-builder 26 官方配套，与 Electron 43 集成；
  支持 NSIS 差分、github provider、退出时安装）。
- **feed**：**GitHub Releases**（github provider）——现有 `release.yml` 已产 GitHub
  Release，零新增服务器；通道 = release 资产中的 `latest.yml`（stable）/
  `beta.yml`（beta）。
- 排除项：Squirrel 原生（无差分、维护弱）；自托管静态 feed（仅百分比灰度需要，
  v1 不做，见 §4）。

### 3.2 平台分支

| | Windows | macOS |
|---|---|---|
| 检查 | electron-updater（github provider） | 轻量检查器：GitHub API `releases/latest`（stable）/ 最新含 prerelease（beta） |
| 下载 | 后台下载（NSIS exe + blockmap 差分） | 弹窗 → 打开 GitHub Release 下载页，用户手动拖装 dmg |
| 安装 | 退出时安装（`autoInstallOnAppQuit`） | 不自动安装（手动） |
| feed 产物 | `latest.yml` / `beta.yml` + exe + blockmap | 不需要（无 feed 文件、mac 不加 zip target） |
| 签名要求 | 无（未签名可装；SmartScreen 警告，§7 记录让步） | 无自动安装 → 不触发 Squirrel.Mac 签名校验；现状 ad-hoc dmg 足够 |

**mac 降级理由**：mac 自动安装硬依赖 Developer ID 签名（Squirrel.Mac 拒绝未签名
更新）。不投入证书（$99/年 + 公证）就**不做自动安装**，避免「zip 下载了却装不上」
的假成功——与仓库 proxy honesty 原则同源。这是**有意的不对称**，在 `updater.ts`
内以平台分支显式实现（AGENTS.md「runtime 差异必须有意且代码可见」）。

## 4. 滚动/灰度：通道模型（beta → stable）

- **stable（默认）**：win 读最新正式 release 的 `latest.yml`；mac 读
  `releases/latest`（非 prerelease）。
- **beta（opt-in）**：`DSH_CHAMBER_UPDATE_CHANNEL=beta` 环境变量（v1 形态；设置项
  后续可加，见 §9）→ win 读 `beta.yml`；mac 读含 prerelease 的最新 release。
- **发布侧**：beta = 标记 prerelease 的 GitHub Release（资产含 `beta.yml`）；验证
  通过后发正式 release（资产含 `latest.yml`）——「先内测、后提升」，与现有
  draft → finalize 手动发布节奏契合。
- **明确不做（v1）**：百分比灰度（按客户端分桶）——electron-updater 无原生支持，
  需自托管 feed 侧实现；用户规模达到再评估（§9 开放项）。

## 5. 更新数据流与 UX

```
启动（延迟 N s）→ 静默检查 → 发现新版本 → 弹窗「当前 vX → 新 vY [下载] [稍后]」
  ├─ 确认 → win：后台下载（进度）→ 就绪提示「退出时安装」→ quit 自动安装
  └─ 确认 → mac：打开 GitHub Release 下载页（手动拖装）
每 6h 周期静默复查；托盘菜单提供「检查更新」手动入口
```

- **失败语义**：检查/下载/校验任何失败 → 静默（写入现有环形日志体系），
  **绝不阻塞启动、绝不伪装成功、绝不静默降级**（`allowDowngrade=false`）。
- **连接管理器场景**：不自动强杀——存在活跃会话时安装延迟到退出时。

## 6. 发布流程与构建产物（release.yml 改造）

- `packages/desktop/package.json`：加 `electron-updater` 依赖；
  `nsis.differentialPackage: true`；新增 `publish` 块（github provider，owner/repo）。
  `dmg.writeUpdateInfo: false` **保持**（mac 无 feed）；mac target 保持 dmg（不加 zip）。
- electron-builder 在配置 publish 后于打包阶段生成 `latest.yml` / `beta.yml` 与
  blockmap（`--publish=never` 只跳过上传，产物仍在输出目录——M3 实测确认）。
- `release.yml` win leg：上传 `*.exe` + `*.blockmap` + `latest.yml`（stable）/
  `beta.yml`（beta）；workflow_dispatch 加 `channel` 输入；beta 走 softprops
  `prerelease: true`。mac leg **零改动**。
- CI 验证步骤新增：`latest.yml` / `beta.yml` 存在、blockmap 存在、yml 内版本与
  产物一致。

## 7. 安全与已知让步（实现时必须显式记录）

- **完整性**：`latest.yml` 内 sha512 校验下载包——无签名也有传输/下载完整性保护。
- **身份（主动让步）**：Windows 不配 `publisherName` → 不做 Authenticode 发布者
  校验；未签名安装器触发 SmartScreen 警告。接受并记录在案；取得证书后可启用校验。
- **出网面**：仅主进程访问 GitHub API / feed（HTTPS）；控制面零出网、loopback
  闭环不变。
- **隐私**：更新检查不携带任何用户/SSH 材料；仅应用版本与平台信息。
- **供应链**：feed 固定为仓库官方 GitHub Release；下载目标由 electron-updater 按
  feed 校验，不允许注入任意 URL。

## 8. 版本管理与数据兼容

- chamber 版本 `0.1.0` 分布于 5 包（根/desktop/control-plane/renderer/cli），发版时
  **一致 bump**（electron-updater 按 semver 比较；`main.ts:58` 读 desktop
  package.json 的 version 并透传控制面）。4 个插件包 `0.1.0-rc.5` 跟随 vendored
  dsh，**不动**。
- 更新只替换应用本体；`userData`（`ssh-instances.json`、state、
  `ssh-passwords.json`）天然保留。未来若改变注册表/状态格式 → 首启迁移（幂等、
  失败响亮不冒充成功）。

## 9. 实现清单（未排期）与开放项

**实现清单**（建议分期）：

- **M1（win 全自动链路）**：`electron-updater` 接入 + 新增 `packages/desktop/
  updater.ts` 状态机（idle → checking → downloading → ready → installing）+
  弹窗/托盘/IPC + 失败静默日志 + `main.ts` 启动接入。
- **M2（mac 检查器）**：GitHub API 轻量检查（stable/beta）+ 弹窗打开下载页；
  与 M1 共用骨架与状态机。
- **M3（发布流程）**：desktop build 配置 + release.yml 产物/通道改造 + CI 验证
  步骤 + 双平台手工验证。

**开放项（实现前细化）**：

- GitHub repo 可见性：公开 repo 匿名可读 feed；私有 repo 需 generic provider +
  凭据（决定 `publish` 配置形态）。
- 检查频率/启动延迟、托盘菜单与弹窗文案（zh/en，走 `verify:i18n`）。
- beta 通道开关形态：v1 仅环境变量 vs 设置项（设置页入口需 chamber 设置插件面）。
- 未来取得 Developer ID 后：mac 升级为自动安装（加 zip target + `latest-mac.yml`
  + 公证 CI）——本设计的分层已为此留位。

## 10. 关联文档

- `01-overview.md` §3 文档地图（本文档编号 11）；`docs/progress/STATUS.md`
  （本文档列入「未完成 / 待执行」）。
- 涉及面：`packages/desktop`（`main.ts`、`package.json`、新增 `updater.ts`）、
  `.github/workflows/release.yml`。
