# todo · 账户 / 登录面（DeepSeek 账号 + 余额）

> 分类：C · 未实现功能想法（低优先，未排期）｜状态权威：STATUS「官方桌面账户家族不加载」条

> 优先级：**低优先，未排期**。触发条件 = 出现「要用官方 DeepSeek 账号的凭据/额度给 dsh 用」的真实需求
> （API key / 自定义 provider 路径不受影响；chamber 现状 = 与官方 **web** 形态一致，见
> `docs/progress/STATUS.md`「官方桌面账户家族不加载」条）。
> 本文件是未实现想法（`docs/progress/README.md` 规则 5）：方案已到可实现粒度，落地时契约写进 `docs/design/`
> 并从本表移除。

## 1. 目标与非目标

**目标**：在具备账户能力的来源的设置面板内提供完整回路：未登录 → 登录（浏览器 PKCE）→ 等待浏览器 →
已登录（资料 + 普通/赠金钱包 + 充值·用量外链）→ 退出。凭据只落在**该来源宿主**的凭据库
（`dsh-credentials-local`），渲染端只见 profile / 余额，不碰 token。

**非目标**（三条路都不做）：官方桌面首启浮层（`desktop-onboarding`）、`WelcomePage` 欢迎页、Electron
`account-backend.ts`、应用内平台视图（`platform-view.ts` WebContentsView）、`dshDesktop` 载体扩展、
把账号 token 带进渲染端。

## 2. 现状对照（已核，pin 0.2.0-rc.1）

- **宿主侧已在跑**：`dsh-base` bundle 带 `dsh-authorization` + `dsh-deepseek-account-platform`（浏览器 PKCE）；
  `dsh-web-app` bundle 带 `dsh-api-account-controller`（remote `account`）与客户端行
  `dsh-client-ui-settings-account`。本机 `profiles/web/cordis.yml` 的 `authorization` / `deepseek-account` /
  `account-controller` / `ui-settings-account` 行都在。
- **客户端面被有意跳过**：该行 apply 门是 `'dshDesktop' in globalThis`，而两 flavor 必须常驻该载体（S-52/S-54）
  ⇒ 家族激活后 `shell.overlay#desktop-onboarding` 会接管 `#root`。跳过 = 与官方 web 形态一致
  （`packages/renderer/src/chamber-covered.ts`、design 09 §3.5③、STATUS）。
- **控制面缺回调落点**：上游 `loginOrigin()` 只接受 `http://localhost|127.0.0.1|[::1]:<显式端口>` 的**裸 origin**
  （远程域与路径代理明确拒绝），回调固定 `<origin>/oauth/callback` 且注册在**宿主自己的** webServer 上；
  chamber 页 origin = 控制面 origin，今天该路径落 SPA 静态回退（`packages/control-plane/src/index.ts` 的
  `api`/`health` 之外一切进 static）。
- **无其他入口**：客户端集里只有该桌面专属家族会发起授权流（`authorization` 无其他客户端消费者）；CLI 无
  account/auth 子命令 ⇒ 今天 chamber 内没有任何受支持的方式完成登录。

## 3. 上游契约（方案依赖）

| 契约 | 事实 |
|---|---|
| 启动 | `remote.account.startSignIn(client, callbackOrigin, loginSource)`；`callbackOrigin` = 浏览器可达的 loopback HTTP origin（显式端口、pathname `/`） |
| 回调 | 宿主注册 `GET /oauth/callback`；`redirect_uri = <origin>/oauth/callback`；成功 302 → platform `/dsh/authorized`；失败 204（`loginSource!=='web'`）或一张 HTML（`'web'`） |
| 状态 | `getState()` → `{status:'signed-out'\|'credential-stored', attempt:{id,phase,authorizeUrl?,expiresAt?,errorCode?}\|null, links:{usageUrl,topUpUrl}}`（未登录也返回 links） |
| 明细 | `getProfile(client)` → `{status:'ready',value:{id,avatarUrl,name,contact}}\|{status:'failed'}\|null`；`getBalance(client)` → `{status:'ready',value:Wallet[],bonusWallets:Wallet[]}\|{status:'failed'}\|null` |
| 其它 | `watch(signal)`（stream）、`cancelSignIn(id)`、`signOut(client)`、`hasRunningAccountTasks()`、`getUnnotifiedBonuses` / `ackBonusNotified` |
| 客户端元数据 | `{version, locale, timezoneOffsetSeconds}` |
| 外链 | 无 `globalThis.dshPlatform` 时官方 UI 回落新标签外链；两 flavor 的 `setWindowOpenHandler` / `createWebViewWith` 都把外部 http(s) 交系统浏览器 |

## 4. 方案 A（推荐）：chamber 自建面

### A1 控制面：`/oauth/callback` + intent 注册表

- 新增 `packages/control-plane/src/account-callback.ts`：intent 注册表（按 instanceId 去重前置、上限 8、
  TTL 15 min ≥ 宿主默认 `attemptTimeoutMs` 10 min）。
- `dispatchRest` 新增 surface `oauth`：仅 `GET /oauth/callback` → 取候选 intent → `instanceProxy.resolveTargetFor(id)`
  → 把 `req.url` 重写为 `/api/i/<id>/oauth/callback?<query>` 交 `instanceProxy.handleHttp`（复用 TLS/SPKI、
  gateway 认证头、响应头白名单与 Location 收敛）。400/404 = 不是这台 → 试下一个；302/204/200 = 成功并消费
  intent；网络错/503 = 保留 intent 回 503。
- `api.ts` 新增 `POST /api/oauth/sign-in-intent {instanceId}`（`parseInstanceId` 校验；不可达即回错，客户端据此
  如实显示「本壳不支持」而不是静默等超时）。
- 卫生：只 GET、`cache-control: no-store`、query 永不进日志、无秘密。**不**广播给全部来源（会把 code+state
  泄露给无关实例，且控制面没有实例枚举 API）；**不**把宿主自身 loopback origin 暴露给渲染端（破
  design 05 §7.4「传输 URL 永不进 renderer」）。

### A2 客户端：新包 `@dsh-chamber/dsh-chamber-client-ui-settings-account`

- 形状照 `dsh-chamber-client-ui-settings-connections`（package.json / tsconfig / scripts/test.mjs / README + i18n）。
- `apply`：探针 `ctx.remote.account.getState()`（有界超时；失败 = 不挂载，只留 debug）→ 注册
  `settings.section`（id `account`、order -10、label 走来源自己的 locale face = design 05 §5 的 dsh-runtime 模式）。
- 状态：`watch` 流为唯一权威 + `getProfile`/`getBalance` 补明细；四态 UI（未登录 / 等待浏览器（打开链接 + 复制）/
  进行中 / 已登录（资料 + 钱包 + 外链 + 退出，退出前 `hasRunningAccountTasks()` 确认））。
- 门控：local / dsh-ssh / dsh-http（页 origin 为 loopback）全量；页 origin 非 loopback 只读并禁用登录；
  宿主无账户能力 / 离线不挂载或失败态。远端来源登录 = 凭据存**那台宿主**，UI 明示；建议 M1 只开 local。
- 无新运行时依赖（自写小数格式化）；不渲染远端头像（CSP `img-src 'self' data: blob:` 不含平台域，用首字母圆标）。

### A3 接线（同批）

`chamber-entry.ts` 的 C4 deferred 列表 + `CHAMBER_COVERED_IDS` + factory 锁步；设置壳/桥不动
（分节进该来源自己的 ledger）。

## 5. 方案 B（备选）：vendor 补丁恢复官方家族

把官方包 cover 进 composite + 一条构建期补丁摘掉/改门 `desktop-onboarding`，其余官方 UI 全量复用；A1 仍要做。
代价：先撤销 design 09 §3.5③ 与 STATUS 裁决、每次 pin 升级复审补丁、N-ctx 下 overlay/inert 语义自证、同批
退役/降级 `root-takeover-watch`。仅当「必须复刻官方 UX」再考虑。方案 C = 等上游把门改成宿主能力
（`docs/progress/todo/upstream/upstream-proposals.md` §9），不可控。

## 6. 里程碑与验收

| 里程碑 | 产物 | 验收 |
|---|---|---|
| M0 最大未知先验（半天–1 天） | 控制面 `/oauth/callback` 旁路 + 临时触发面 | **真实登录跑通一次**：平台是否接受 `http://127.0.0.1:<控制面端口>/oauth/callback` 作 redirect_uri；跑完清凭据。不成立则 A/B 都要重估 |
| M1 控制面 | intent 注册表 + `oauth` surface + `POST /api/oauth/sign-in-intent` + 单测 | `curl`：intent → 假 state 得 400；真流程 302；query 不进日志 |
| M2 客户端（local 源） | 新包 + 探针 + 分节 + 四态 + 动作 + i18n + 复合接线 + 测试 | Electron 实机：登录 → 余额 → 退出；取消/过期/重复；无账户宿主不挂载；整页不被接管 |
| M3 远端 + 座位 | ssh / gateway 源；`settings.models.sign-in` occupant（可选）；`shell.quota-notice`（需先给 layout fork 声明该座） | 远端与 gateway 各一次真登录；离线/降级矩阵 |
| M4 双 flavor + 文档 | Swift 实机；design / registry / STATUS 同批 | Swift 外链 → 回调 → 余额；门禁全绿 |

## 7. 门与记录（落地时）

- 根 `package.json` 的 `test:*` / `typecheck:*` + `scripts/gates/run-checks.mjs` 模式；包内单测/行为测试；
  控制面注册表/路由/脱敏单测。
- `scripts/upstream/registry.json` 新增契约条目（remote `account/*` 方法表 + `loginOrigin()`/`/oauth/callback`
  形状锚点）+ `registry-views --write` + `verify:registry` / `verify:anchors`。
- 设计文档（含 Rejected alternatives：广播回调 / 暴露宿主 origin / vendor 补丁恢复官方家族 / 完整 fork）、
  design 09 §3.5③、design 05 §5、01-overview 索引、`upstream-touchpoints.md` §4.5 注记、STATUS 回写。
- 若动 build 输入/`extraResources` → packaging checklist；发版走 release checklist。

## 8. 待裁决

1. 路线 A / B / C。
2. 登录入口范围（每来源设置分节 / 模型设置 sign-in 座 / 两者）。
3. `loginSource` 取 `'desktop'`（失败回调空白 204）还是 `'web'`（失败页提示关闭标签页）。
4. 是否在登录成功后调 `session.initializeDefaultModel()`（建议不调）。
5. 远端来源登录是否做（凭据留远端宿主），还是先只做 local。
6. 是否同批重开 `llm-deepseek-account`（不重开则登录只服务余额）。

## 9. 关联

- `docs/design/09-client-plugin-runtime-loading.md` §3.5 有意跳过名单③（门 / 退出条件）
- `docs/design/05-connection-manager.md` §5（分节注册形状）、§7.4（传输 URL 不进 renderer）
- `docs/progress/STATUS.md`「官方桌面账户家族不加载」条（现状与代价）
- `docs/progress/todo/upstream/upstream-proposals.md` §9（上游最小改法）
- `docs/checklists/upstream-touchpoints.md` §4.5（`apps/desktop/src` 账户文件 = not-applicable）
