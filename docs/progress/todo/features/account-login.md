# todo · 账户 / 登录面（DeepSeek 账号 + 余额）

> 分类：C · 未实现功能想法（低优先，未排期）｜状态权威：STATUS「桌面 flavor 账户登录不可闭环」条

> 优先级：**低优先，未排期**。触发条件 = 出现「要用官方 DeepSeek 账号的凭据/额度给 dsh 用」的真实需求
> （API key / 自定义 provider 路径不受影响）。
> 本文件是未实现想法（`docs/progress/README.md` 规则 5）：方案已到可实现粒度，落地时契约写进 `docs/design/`
> 并从本表移除。

## 1. 目标与非目标

**目标**：在具备账户能力的来源的设置面板内提供完整回路：未登录 → 登录（浏览器 PKCE）→ 等待浏览器 →
已登录（资料 + 普通/赠金钱包 + 充值·用量外链）→ 退出。凭据只落在**该来源宿主**的凭据库
（`dsh-credentials-local`），渲染端只见 profile / 余额，不碰 token。

**非目标**（三条路都不做）：官方桌面首启浮层（`desktop-onboarding`）、`WelcomePage` 欢迎页、Electron
`account-backend.ts`、应用内平台视图（`platform-view.ts` WebContentsView）、`dshDesktop` 载体扩展、
把账号 token 带进渲染端。

## 2. 现状（alpha.3 复核）

- **UI 已接入**：官方 `@deepseek-ai/dsh-client-ui-settings-account` 行由复合壳 DEFERRED 集群加载
  （covered+deferred）。构建期 vendor 补丁把桌面 `shell.overlay#desktop-onboarding` 及其
  `desktopOnboardingVisible` 初值门控为 `globalThis.__dshChamberAccountOverlay === true`（默认关闭），
  设置分节与 `settings.models.sign-in` / `shell.quota-notice` / `settings.launcher` 座位随之注册。
- **桌面 flavor 登录仍不可闭环**（STATUS 已登记，静态链实证）：`desktop=true` 下客户端不打开授权页；
  回调 origin = 控制面 origin，而 `/oauth/callback` 只注册在实例 host、控制面对未知路径走 SPA 回退
  （仅反代 `/api/i/<id>/*`）；`settings.launcher` 座在被设置壳阴影后无渲染点。**待做** = 控制面根路径
  `/oauth/callback` → 活动实例反代 + 可达 origin（多实例归属需裁决）。web/gateway flavor 不受此限。
- **凭据配置**当前仍走 models API-key 路径（不受影响）。

## 9. 关联

- `docs/design/09-client-plugin-runtime-loading.md` §3.5③（补丁门控与 Rejected alternatives）
- `docs/design/05-connection-manager.md` §5（分节注册形状）、§7.4（传输 URL 不进 renderer）
- `docs/progress/STATUS.md`「桌面 flavor 账户登录不可闭环」条（现状、代价与退出条件）
- `docs/progress/todo/upstream/upstream-proposals.md` §9（上游最小改法）
