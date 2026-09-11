# dsh 版本更新前 Checklist

> 面向维护者：把 chamber 依赖的上游 dsh（deepseek-harness）从当前 pin 升级到目标版本
> （tag 形如 `dsh-vX.Y.Z-<stage>.N`）。核心约束（AGENTS.md）：**只改 chamber 侧，不动 dsh
> 内容**（vendor/submodule 源码零修改）。命令前先
> `export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"`。
>
> 本文件只写**可复用流程**：某一次升级的迁移叙述（pin、rebase 面、验证结论）写
> `CHANGELOG.md` 的发布节；`docs/progress/STATUS.md` 只收**仍 open** 的遗留门禁与偏差
> （记录口径见 AGENTS.md「STATUS.md — what to record」）；上游触点登记表是同目录的
> [`upstream-touchpoints.md`](upstream-touchpoints.md)（§7 每 tag 维护循环与本清单互补）。

## 0. 目标与基线

- [ ] 确定目标版本与 commit：`git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git`
      或 submodule 内 `git -C vendor/harness-checkout fetch origin --tags` 后
       `git -C vendor/harness-checkout tag -l | sort -V`。
- [ ] 记录当前 `harness.commit`（旧 pin）与目标 commit。
- [ ] 检查工作区/stash：确认无未提交的迁移相关工作（发布 stash 等）。
- [ ] **先跑只读预检再动 pin**：`node scripts/dev/preflight-vendor-pin.mjs <tag> --offline`
       一次给出「fork pure/replay/dropped + 深引 vendor seam 文件 + 上游包集合增删 +
       新增 client 行 + 运行时 npm 状态」；`--fail-on-replay` 可当硬门（fork 面需人工重放时
       先评估规模，再决定升级窗口）。

## 1. 上游差异审计（只读）

> **顺序约束（rc.1 实测）**：本节必须在 §2 动 pin **之前**做。`update-vendor` 的第 1 步是
> `git fetch --depth 1 origin tag <tag>`，它会在新 commit 处写入 shallow 嫁接——此后
> `git log/rev-list <旧>..<新>` 只数得到 1 个 commit、`merge-base --is-ancestor` 为假
> （对象其实都在，被嫁接截断的只是遍历）。要事后恢复完整历史：
> `git -C vendor/harness-checkout fetch --unshallow origin`（只影响本地 git 状态，
> 与 gitlink/提交无关）。CI 物化 submodule 不受影响。

- [ ] 规模与主题：`git log --oneline <旧>..<新> | wc -l`、`git diff --stat <旧> <新>`。
- [ ] 新包/删包：`git ls-tree -r --name-only <新> -- packages | grep package.json`
       对比——新增包会进 vendor 树，删除包会在锁文件留下需要清理的 importer 记录。
- [ ] chamber import 面 API 审计：上游有实质源码改动的包 vs chamber import 面
       （改名/重构/事件改名是否被 chamber 消费）。
- [ ] fork 副本上游改动面：`packages/client/connection`、`packages/client/web`、
       `packages/client/api-gateway` 的版本间 diff——判断「冲突需合并」vs「干净采纳」。
- [ ] **首屏耦合审计**：上游新增/改名的官方 client 行若被复合首屏 inject，需同步
       host-graph 额外行的降级注释；**探针集合本身是派生的**（首屏 `register(id,
       plugin)` 记录的 `inject` 面并集，见 `upstream-touchpoints.md` §2/§3 与
       design 09 §3.2），无需再往清单里加名字，但新 provider 行若不在复合覆盖集内
       要确认探针能观测到它。

## 2. 双线 pin 一致性（源码线 + 运行时线）

> **源码线**（构建期 vendor 树）由 git submodule 固定 commit，升级唯一入口是
> `scripts/dev/update-vendor.mjs`；**运行时线**（打包进桌面的 `@deepseek-ai/dsh` npm 包）
> 维持六个锚（bundle-dsh 兜底常量、desktop vendor 锁文件、release.yml env、
> install-gateway.sh、gateway `dshAnchorVersion`、release-preflight `FORK_VERSION`）。

- [ ] **源码线（submodule）**：`node scripts/dev/update-vendor.mjs <tag>` 原子升级
      （fetch+校验 tag → 切 submodule → 更新 `harness.commit` → 差量建链 →
      重生成锁文件 → frozen 验证）；输出确认 commit 与 tag 远程解析一致。
      禁止手工改 gitlink / `harness.commit`。
- [ ] **index 里的 gitlink 必须已指向目标 commit**（worktree / 新检出常见坑，rc.1 实测）：
      `update-vendor` 只切 submodule HEAD 与 `harness.commit`，**不写 index 的 gitlink**；
      而 `ensure-harness-vendor` 的 `verifyPin` 会用 index gitlink 与 pin 对拍，于是升级在
      第 5 步（差量建链）硬失败：`submodule gitlink=<旧> != harness.commit pin=<新>`。
      处置 = `git add vendor/harness-checkout`（把工具刚切到的**真实** HEAD 记进 index，
      不是手改 gitlink）后重跑同一条 `update-vendor`（幂等）；随后的提交本就要求
      gitlink 与 pin 同批。
- [ ] 源码线验证：`node scripts/dev/ensure-harness-vendor.mjs --check` 通过
      （submodule HEAD == harness.commit，链接集合 == 锁文件 importer 集合）。
- [ ] **运行时线**：`bundle-dsh.mjs` `DEFAULT_DSH_VERSION` +
      `packages/desktop/vendor/dsh/package.json` `"@deepseek-ai/dsh"` → 目标版本
      （先确认 npm 已发布；未发布则先只收口源码线，运行时线留到发布后单独提交）。
- [ ] **CI 环境变量**：`.github/workflows/release.yml` 的 `env.DSH_CHAMBER_DSH_VERSION`
      同步（此 env 仅存在于 release.yml，CI 不打包；若将来把打包 job 加回
      ci.yml，必须连同 ci.yml 一起同步）。
- [ ] **安装脚本常量同步**：`scripts/install-gateway.sh` 内置
      `DSH_CHAMBER_DSH_VERSION` → 目标版本（与 release.yml 的 env、gateway 包的
      `dshAnchorVersion` 三源一致；release-preflight 会硬断言，不要只改一处）。
- [ ] 重建 vendor 树：`node scripts/dev/ensure-harness-vendor.mjs` → 链接数 = 目标
      版本包数，无告警（submodule HEAD == pin）。

## 3. fork 副本 rebase（chamber 侧适配）

- [ ] `packages/dsh-client-connection`：上游改动与 basePath 补丁同文件时手工合并
      （chamber 选项对象、`ctx.chamberBasePath` 读取等）；干净采纳项照抄；
      上游新增钩子按 chamber 场景决定采纳/跳过。
- [ ] `packages/dsh-client-web`：boot 内核与上游 boot.ts 的差异（loadBundle 接线等）。
- [ ] `packages/dsh-api-gateway`：client 半的 base-path 补丁与上游改动面。
- [ ] 其余 chamber 适配面：控制面代理限额、spawn-dsh 的 pin 注释验证、
      desktop/渲染器注释基线等与上游对齐。
- [ ] 逐面验证：`pnpm run test:connection`、`test:client-web`、`typecheck:client-web`、
      控制面单测（`pnpm run test:control-plane`）。
- [ ] 自建物重放面（layout/sidebar fork、covered factory、vendor 补丁锚点）逐项裁决：
      采纳 / 保留偏差并登记，判定口径见 `upstream-touchpoints.md` §1–§3。

## 4. 锁文件（AGENTS.md 关键注意）

- [ ] 源码线升级时由 `scripts/dev/update-vendor.mjs` 原子重生成（非 frozen install →
      restore-lockfile-vendor-records.mjs 补回 → frozen 验证），**不要在锁文件
      重生成前手工跑 ensure 的默认模式**（断言会因锁文件滞后而失败，属预期）。
- [ ] pnpm 11 会裁剪 vendor importer 记录 → `node scripts/dev/restore-lockfile-vendor-records.mjs`
      补回；**新增 vendor 包**若不在 HEAD 锁文件中需手工补齐 importer 记录
      （参照既有 vendor 记录格式，零依赖成员为单行 `key: {}` 块）；**删除的 vendor 成员**
      不得被脚本从 HEAD 复活（守卫已按链接集合存在性跳过，见
      `scripts/dev/restore-lockfile-vendor-records.test.mjs`）。
- [ ] **已有 vendor 成员的依赖集变化**（不是新增/删除包）同样会动 importer 记录：脚本是
      **只增不减**（键已存在即跳过），所以一旦 pnpm 裁掉了该段，它会从 HEAD 复活**旧**记录，
      而旧记录不含新依赖边 ⇒ frozen 验证以「specifiers don't match」失败。判据就是
      `update-vendor` 第 6 步的 frozen 安装；失败时按上面同一条手工补齐口径，把新依赖按
      字母序补进该成员记录（`'@deepseek-ai/<dep>': { specifier: workspace:^, version:
      link:../<dep> }`）。**rc.1 实测**：`dsh-llm-deepseek` 新增
      `@deepseek-ai/dsh-attachment-local`，本次 pnpm 未裁剪该段（restore 报「0 条」），
      记录被就地更新、frozen 通过——风险是条件性的，但每一步都以 frozen 结果为准。
- [ ] `pnpm install --frozen-lockfile` 通过；`node scripts/dev/ensure-harness-vendor.mjs --check`
      通过；`git diff --exit-code -- pnpm-lock.yaml` 为空（漂移断言）。

## 5. 捆绑运行时

- [ ] `pnpm --filter @dsh-chamber/desktop run bundle:dsh -- --force --refresh-lockfile`
      （runtime 锁文件版本变化时必须 `--refresh-lockfile`，否则 frozen 报
      `ERR_PNPM_OUTDATED_LOCKFILE`）。
- [ ] 冒烟：`node packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version`
      = 目标版本。
- [ ] 构建脚本白名单复核：上游新增原生依赖时显式裁决 `allowBuilds` / `DENY_BUILDS`
      （单源生成点 + 测试钉住），不允许沉默的 ignored builds。

## 6. 回归（升级相关全量）

- [ ] 测试：以根 `package.json` 脚本为唯一清单，至少覆盖
      `test:control-plane`、`test:runtime`、`test:desktop`、`test:gateway`、`test:cli`、
      `test:renderer-shell`、`test:git` + `test:host-git` + `test:host-archive-cleanup`、
      `test:sidebar` + `test:layout` + `test:settings-bridge` + `test:connections` +
      `test:client-web` + `test:connection` + `test:open-in` + `test:mobile`。
- [ ] 类型检查全套（根 + 各插件 + host 包 + client-web/connection/api-gateway + runtime）。
- [ ] `pnpm run build:renderer`、`pnpm run verify:i18n`、`pnpm run smoke`（未捆绑
      运行时的检出应打印 SKIP——冒烟门槛按 dsh CLI 入口存在性判定，仅有 lockfile
      的 `packages/desktop/vendor/dsh` 不算已安装）。
- [ ] 触点与锚门禁：`node scripts/dev/verify-upstream-touchpoints.mjs` 全绿
      （C1/C3–C10；`--no-artifact-rebuild` 可跳过产物重建）。
- [ ] 残留扫描：`grep -rn "<上一版 pin 的版本字面量>\|<上一版 commit 短哈希>" packages/ scripts/ harness.commit`
      （非 vendor/node_modules/产物）仅剩注释里的历史叙述——生产源码/脚本/配置里的
      「活」版本字面量必须登记在 C10 白名单。

## 7. 文档与记录

- [ ] 本次升级的迁移叙述（pin、fork rebase 面、代理/适配面、验证结论）写进
      `CHANGELOG.md` + `docs/CHANGELOG.en-US.md` 的发布节；**未落地的实机门禁与遗留偏差**
      才登记进 `docs/progress/STATUS.md` 的未完成项（只写仍 open 的项，不留"已完成"台账）。
- [ ] `CHANGELOG.md` + `docs/CHANGELOG.en-US.md` 的发布节补迁移条目
      （如「dsh 基线升级 … + 代理限额变化」），并 `node scripts/dev/verify-i18n.mjs --write`
      刷新 i18n 记录。
- [ ] 触点表刷新：`docs/checklists/upstream-touchpoints.md` §0 基线速查 + 受影响登记行
      （与 `scripts/dev/verify-upstream-touchpoints.mjs` 内的登记表两侧同步）。
- [ ] 引用基线版本的文档（design 09/11、README、DEVELOPMENT、本目录 checklist）中的
      版本号更新（历史叙述保留）。

## 8. 遗留决策点（按需记录）

- [ ] 上游行为变化是否需要 chamber 适配（限额变化与代理上限冲突、事件改名 chamber
      是否消费、新包是否要动作、上游新增 wire 是否改变既有例外边界）。
- [ ] 未落地的实机门禁（gateway/远程/打包版目检等）登记进 `docs/progress/STATUS.md`
      的未完成项，并在下次升级时复用本 checklist 复验。
