# dsh 版本更新前 Checklist（0.1.2-alpha.2 升级沉淀）

> 面向维护者：把 chamber 依赖的上游 dsh（deepseek-harness）从当前基线升级到目标
> 版本（tag 形如 `dsh-v0.1.1-rc.2`）。核心约束（AGENTS.md）：**只改 chamber 侧，
> 不动 dsh 内容**（vendor/submodule 源码零修改）。命令前先
> `export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"`。

## 0. 目标与基线

- [ ] 确定目标版本与 commit：`git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git`
      或 submodule 内 `git -C vendor/harness-checkout fetch origin --tags` 后
      `git -C vendor/harness-checkout tag -l | sort -V`。
- [ ] 记录当前 `harness.commit`（旧 pin）与目标 commit。
- [ ] 检查工作区/stash：确认无未提交的迁移相关工作（发布 stash 等）。

## 1. 上游差异审计（只读）

- [ ] 规模与主题：`git log --oneline <旧>..<新> | wc -l`、`git diff --stat <旧> <新>`。
- [ ] 新包/删包：`git ls-tree -r --name-only <新> -- packages | grep package.json`
      对比（新增包如 `dsh-authorization` 会进 vendor 树）。
- [ ] chamber import 面 API 审计：上游有实质源码改动的包 vs chamber import 面
      （改名/重构/事件改名是否被 chamber 消费）。
- [ ] fork 副本上游改动面：`packages/client/connection`、`packages/client/web` 的
      rc 间 diff——判断"冲突需合并" vs "干净采纳"。

## 2. 双线 pin 一致性（源码线 + 运行时线）

> 2026-09 submodule 化后：**源码线**（构建期 vendor 树）由 git submodule
> 固定 commit，升级唯一入口是 `scripts/dev/update-vendor.mjs`；**运行时线**
> （打包进桌面的 `@deepseek-ai/dsh` npm 包）维持六个锚（bundle-dsh 兜底常量、
> desktop vendor 锁文件、release.yml env、install-gateway.sh、gateway
> `dshAnchorVersion`、release-preflight `FORK_VERSION`）。

- [ ] **源码线（submodule）**：`node scripts/dev/update-vendor.mjs <tag>` 原子升级
      （fetch+校验 tag → 切 submodule → 更新 `harness.commit` → 差量建链 →
      重生成锁文件 → frozen 验证）；输出确认 commit 与 tag 远程解析一致。
      禁止手工改 gitlink / `harness.commit`。
- [ ] 源码线验证：`node scripts/dev/ensure-harness-vendor.mjs --check` 通过
      （submodule HEAD == harness.commit，链接集合 == 锁文件 importer 集合）。
- [ ] **运行时线**：`bundle-dsh.mjs` `DEFAULT_DSH_VERSION` +
      `packages/desktop/vendor/dsh/package.json` `"@deepseek-ai/dsh"` → 目标版本
      （先确认 npm 已发布）。
- [ ] **CI 环境变量**：`.github/workflows/release.yml` 的 `env.DSH_CHAMBER_DSH_VERSION`
      同步（此 env 仅存在于 release.yml，CI 不打包；若将来把打包 job 加回
      ci.yml，必须连同 ci.yml 一起同步）。
- [ ] **安装脚本常量同步**：`scripts/install-gateway.sh` 内置
      `DSH_CHAMBER_DSH_VERSION`（当前 `0.1.5-alpha.2`）→ 目标版本（与 release.yml
      的 env 同步；脚本默认安装该版本，用户可交互覆盖）。
- [ ] 重建 vendor 树：`node scripts/dev/ensure-harness-vendor.mjs` → 链接数 = 目标
      版本包数（240 之类），无告警（submodule HEAD==pin）。

## 3. fork 副本 rebase（chamber 侧适配）

- [ ] `packages/dsh-client-connection`：上游改动与 basePath 补丁同文件时手工合并
      （如 `createWebConnectionRpc` 的 chamber 选项对象、`apply(ctx)` 的
      `ctx.chamberBasePath` 读取）；干净采纳项照抄（如 300MiB）；
      上游新增钩子（`__DSH_TRANSPORT__`）按 chamber 场景决定采纳/跳过。
- [ ] `packages/dsh-client-web`：boot 内核与上游 boot.ts 的差异（如 loadBundle 接线）。
- [ ] 其余 chamber 适配面：控制面代理限额（如 50/100 → 300 MiB 对齐上游）、
      spawn-dsh 注释的 pin 验证、desktop/渲染器注释基线。
- [ ] 逐面验证：`pnpm run test:connection`、`test:client-web`、`typecheck:client-web`、
      控制面单测。

## 4. 锁文件（AGENTS.md 关键注意）

- [ ] 源码线升级时由 `scripts/dev/update-vendor.mjs` 原子重生成（非 frozen install →
      restore-lockfile-vendor-records.mjs 补回 → frozen 验证），**不要在锁文件
      重生成前手工跑 ensure 的默认模式**（断言会因锁文件滞后而失败，属预期）。
- [ ] pnpm 11 会裁剪 vendor importer 记录 → `node scripts/dev/restore-lockfile-vendor-records.mjs`
      补回；**新增 vendor 包**（如 dsh-authorization）若不在 HEAD 锁文件中需手工补齐
      importer 记录（参照既有 vendor 记录格式，零依赖成员为单行 `key: {}` 块）。
- [ ] `pnpm install --frozen-lockfile` 通过；`node scripts/dev/ensure-harness-vendor.mjs --check`
      通过；`git diff --exit-code -- pnpm-lock.yaml` 为空（漂移断言）。

## 5. 捆绑运行时

- [ ] `pnpm --filter @dsh-chamber/desktop run bundle:dsh -- --force --refresh-lockfile`
      （runtime 锁文件版本变化时必须 `--refresh-lockfile`，否则 frozen 报
      `ERR_PNPM_OUTDATED_LOCKFILE`）。
- [ ] 冒烟：`node packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version`
      = 目标版本。

## 6. 回归（迁移相关全量）

- [ ] 测试：控制面 9 套（含 ws-frames.ts）+ `test:desktop` + `test:gateway` + `test:cli` +
      `test:renderer-shell` + `test:git` +
      `test:host-git` + `test:sidebar` + `test:settings-bridge` + `test:connections` +
      `test:client-web` + `test:connection`。
- [ ] 类型检查全套（根 + 各插件 + host 包 + client-web）。
- [ ] `pnpm run build:renderer`、`pnpm run verify:i18n`、`pnpm run smoke`（未捆绑
      运行时的检出应打印 SKIP——冒烟门槛按 dsh CLI 入口存在性判定，仅有 lockfile
      的 `packages/desktop/vendor/dsh` 不算已安装，2026-08 CI 修复）。
- [ ] 残留扫描：`grep -rn "0\.1\.0-rc\.8\|141eb6f" packages/ scripts/ harness.commit`
      （非 vendor）仅剩历史叙述/迁移条目。

## 7. 文档与记录

- [ ] `docs/progress/STATUS.md` 新增目标版本基线对齐记录（含 pin、fork rebase 面、
      代理/适配面、验证结果）。
- [ ] `CHANGELOG.md` + `docs/CHANGELOG.en-US.md` 的下一发布节补迁移条目
      （如"dsh 基线升级 … + 代理限额变化"），刷新 i18n 记录。
- [ ] 基线文档引用（design 09/11、README、DEVELOPMENT）中的版本号更新（历史
      叙述保留）。

## 8. 遗留决策点（按需记录）

- [ ] 上游行为变化是否需要 chamber 适配（如限额翻倍与代理上限冲突、事件改名
      chamber 是否消费、新包是否要动作）。
- [ ] 后续升级（如 rc.2 → 更高）时复用本 checklist，并在 STATUS.md 记录增量。

## 9. 已执行：dsh-v0.1.5-alpha.2 升级（2026-09，源码线 + 运行时线均已收口）

> 状态：**已升级**——源码线 pin = `b2e3b2a01258`（dsh-v0.1.5-alpha.2，vendor 链接 284），
> 运行时线六锚 = 0.1.5-alpha.2（`bin.js --version` 冒烟通过）。本节保留为**执行记录**：
> 调研结论、已落地的重放/修复与剩余实机门禁；完成细节见 CHANGELOG [Unreleased] 与
> `docs/progress/STATUS.md` 的「2026-09 dsh 基线对齐记录（0.1.5-alpha.2）」。
> 目标锚点从 `dsh-v0.1.5-alpha.1` 更新为 **`dsh-v0.1.5-alpha.2`**（上游 master HEAD，
> npm `alpha` 已指向它）。
> **2026-09 补充（两轮）**：
> ① 全量差异对比（rc.1→alpha.2 + chamber 兼容评估，含前端显示差异、右栏栈服务注入硬点、
> 设计 24 的 v3 代际残留）见
> [`dsh-upgrade-diff-0.1.2-rc1-to-0.1.5.md`](dsh-upgrade-diff-0.1.2-rc1-to-0.1.5.md)；
> ② **逐文件/逐函数决策矩阵**（8 个域、848 行文件级决策 + 15 条冲突 + 7 个待裁决点）见
> [`dsh-upgrade-decision-matrix.md`](dsh-upgrade-decision-matrix.md)。
> 关键修正：alpha.2 又把中心列改为 keyed `main` 槽（`conversation` 槽消失）、官方 sidebar 新增
> `sidebar.panellist`；`ALLOW_BUILDS` 的 `fs-ext` **不能删**（回滚目标仍依赖）；设计 24 有
> **4** 个缺陷（含 `list()` 返回快照导致真机 preview/purge 全挂）。

### 9.1 已完成（已提交，与版本无关）
- **`msgpackr-extract` 裁决**：0.1.5 线 store-index 依赖引入该原生加速器；pnpm 11
  `strictDepBuilds` 默认 true，未列出即硬失败。已按上游裁决显式否认：
  根 `pnpm-workspace.yaml` `allowBuilds` + `dsh-runtime` 的
  `DENY_BUILDS`/`renderAllowBuildsBlock()`（两个生成点单源：bundle-dsh 与运行期
  安装器），并有测试钉住。
- **升级流程两处卡点与处置**（实测）：
  1. `update-vendor` 首次运行必在 step 5 失败（`harness.commit` 已改、gitlink 未加）
     → `git add vendor/harness-checkout` 后重跑（tag fetch 幂等）。
  2. `restore-lockfile-vendor-records.mjs` 会**从 HEAD 复活已移除 vendor 成员的
     importer 记录**：0.1.5 把 landlock 系列移出 workspace（`native/landlock-run`
     目录消失，workspace 模式改为 `native/system*`），脚本把 4 条 landlock importer
     从 HEAD 补回 → frozen 验证报「锁文件有、链接缺(4)」。处置：手工删除这 4 个
     importer 块后再 frozen。**已修（2026-09）**：脚本按
     `vendor/harness-packages/@deepseek-ai/<name>` 链接存在性（含断链）跳过并打印
     清单，不再复活已移除成员；3 例单测钉住
     （`scripts/dev/restore-lockfile-vendor-records.test.mjs`）。
- **升级前 pin 预检（新增工具，只读）**：`node scripts/dev/preflight-vendor-pin.mjs
  <tag> [--offline] [--json] [--fail-on-replay]` —— 在动 pin **之前**回答「哪些 fork
  文件要人工重放、哪些 vendor 文件是 chamber 深引的 seam 风险、上游包集合增删、
  新增 client 行、运行时是否已发布 npm」。这是 0.1.5 踩坑（先升 pin 才发现 ui-layout
  三栏模型重写）的直接产物，**应作为本节流程第 0 步**。纯函数单测见
  `scripts/dev/preflight-vendor-pin.test.mjs`；两者由根脚本 `pnpm run test:upgrade-tools`
  + CI 步骤覆盖。

### 9.2 执行记录（原计划项 0–7，**现已全部落地**）

> 下列序列是升级前的计划；每项均已执行，逐文件判定见
> [`dsh-upgrade-migration-audit.md`](dsh-upgrade-migration-audit.md)，决策/动作见
> [`dsh-upgrade-decision-matrix.md`](dsh-upgrade-decision-matrix.md)。
0. **预检（先看清单再动 pin）**：`node scripts/dev/preflight-vendor-pin.mjs
   dsh-v0.1.5-alpha.1 --offline`（实测输出见 §9.3）。
1. **layout fork 重放（主体，规模门已触发）**：上游 0.1.5 把三栏模型改为
   sidebar/center/**rightbar** —— `columns.ts` 去 `DETAILS_*`（新增
   `RIGHTBAR_MIN`/`RIGHTBAR_MAX_RATIO`/`RIGHTBAR_DEFAULT_RATIO`，`CENTER_MIN` 640→400）、
   `stores.ts` 新 state（`viewportWidth`/`rightbar`(ratio)/`narrowExpanded`/presentation
   报告）、`index.ts` SlotMap `details`→`rightbar` + `RightbarOwnerProps`、
   `service.ts` 与 `AppFrame.tsx`/`.module.css` 重写（src 合计 +268/−206）。
   `packages/dsh-chamber-client-ui-layout` 必须在新模型上重放，同时保留两个 chamber
   增值：**sidebarWidth 共享持久化**（view-prefs + 150ms 尾去抖 + 外部采纳）与
   **单一 document theme 投影**；`test/layout-store.test.ts`（382 行）随模型重写。
   实测现状：仅 pin 一升，`typecheck:layout` 即因 `DETAILS_*` 消失而红。
2. **5 个新 client 行 roster 裁决**（预检补全：原列 4 个，漏了带 `dsh.client`
   的 api 包 `dsh-api-workspace-files`）：bundle patch 新增 `dsh-client-resources`、
   `ui-sidebar-right`、`ui-sidebar-files`、`ui-sidebar-textpreview`、
   `dsh-api-workspace-files`（`dsh.client.inject` = api-gateway +
   api-session-controller + client-resources）。
   `ui-sidebar-right` 注入 `layout` 并占用新 `rightbar` 槽；files/documentpreview 注入
   `sidebarRightTabs` + `remote.workspaceFiles`。**裁决结果**：五行全部**不 cover、
   继续走 host-graph 额外行**（首屏时序由 `assertRequiredExtraRowServices` 探针兜底）；
   `ui-sidebar-textpreview` 在 alpha.2 改名为 `ui-sidebar-documentpreview`。
3. **平台词 `dsh-client-ui-dockkit`**：库（无 `dsh.client`），被上述三行依赖 →
   必须采纳到 `client-web` 的 `platform.ts`/`seed.ts` + `package.json` 依赖
   （已试通：typecheck 绿）。
4. **connection / api-gateway 重放**：connection 纯文件照抄（READMEs、
   `src/index.ts` 宿主半 `webServer` 可选注入重构、`src/client/fixture.ts` +291）、
   `package.json` 版本 + 保留本仓 scripts；api-gateway 仅版本（client 半零改动）。
5. **运行时六锚 + 捆绑**：npm `@deepseek-ai/dsh@0.1.5-alpha.2` 已发布 → 可双线收口
   （bundle-dsh 兜底常量、`vendor/dsh` 锁文件 `--force --refresh-lockfile`、
   release.yml env、install-gateway.sh、gateway `dshAnchorVersion`、
   release-preflight `FORK_VERSION`）。
6. **锁文件**：vendor 成员 271 → **284**（净 +13 = +17/−4：新增含 `apps/desktop`、
   `apps/desktop-host`、`native/system*` 6 个、`ui-sidebar-documentpreview`、
   `fs/tool-present`、`util/chunked-list` 等；移除 landlock 系列 4 条），按 §4 纪律
   重生成 + 处理 landlock 复活记录（守卫已修，见 §9.1）。
7. 全量门禁（§6）+ 文档回写（§7）+ `verify:i18n` + 触点表 §2/§5 更新。

### 9.3 已证伪/确认的假设
- 上游 connection **客户端恢复模型在 alpha.2→0.1.5 零改动**（我们的连接加固无上游
  等价物可采纳，`start(sinks, config)` 接缝在 0.1.5 的宿主半重构后依然存在）。
- 包集合 rc.1→alpha.2 净 **+13**（+17/−4，实测 vendor 链接 271→**284**）；新增 client 行 **5**
  （`dsh-api-workspace-files`、`client-resources`、`ui-sidebar-{files,right,documentpreview}`；
  `ui-sidebar-textpreview` 在 alpha.2 改名 `documentpreview`）；平台词库 **1**
  （`ui-dockkit`，走 covered factory）；无新增 native 依赖（除 `msgpackr-extract`，
  已否认其构建脚本）。
- **预检实测**（`preflight-vendor-pin.mjs dsh-v0.1.5-alpha.1 --offline`，2026-09）：
  上游变更 2552 文件 → fork 面 pure 5 / 需人工重放 6（三个 `package.json` 版本行 +
  `client/web/src/platform.ts`·`seed.ts`·`tsconfig.json`）/ dropped 6；**seam 风险
  16 个文件，全部落在 `packages/client/ui-layout/*`**（`AppFrame.tsx`/`columns.ts`/
  `index.ts`/`service.ts`/`stores.ts`/`.module.css` + README 三件 + `package.json`）
  —— 与 §9.2 第 1 项互为印证：layout fork 是唯一实质阻塞点。包集合 +15 / −4
  （landlock 系列），新增 client 行 5（`dsh-api-workspace-files`、`client-resources`、
  `ui-sidebar-{files,right,textpreview}` —— 比 §9.2 第 2 项多一行，roster 裁决需一并
  覆盖），净 271 → **284**（实测；alpha.1 时为 282，alpha.2 再加 `fs/tool-present`、
  `util/chunked-list` 两个链接；`ui-sidebar-textpreview`→`documentpreview` 为改名不增链接）。
