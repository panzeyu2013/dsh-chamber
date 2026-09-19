# dsh 版本更新前 Checklist

> 面向维护者：把 chamber 依赖的上游 dsh 从当前 pin 升到目标 tag（形如 `dsh-vX.Y.Z-<stage>.N`）。
> 核心约束（AGENTS.md）：**只改 chamber 侧，不动 dsh 内容**（vendor/submodule 源码零修改）。命令前先
> `export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"`。
>
> 本文件只写可复用流程：某次升级的迁移叙述写 `CHANGELOG.md` 发布节，仍 open 的门禁写 `STATUS.md`；
> 触点结构与每 tag 维护循环见同目录 [`upstream-touchpoints.md`](upstream-touchpoints.md)（§7）。

## 0. 目标与基线（动 pin 之前的只读照面）

- [ ] 取目标 tag/commit：`git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git`，
      或 submodule 内 `git -C vendor/harness-checkout fetch origin --tags && git -C vendor/harness-checkout tag -l | sort -V`；
      记录当前 `harness.commit`（旧 pin）与目标 commit。
- [ ] 工作区与 stash 干净（无未提交的迁移相关工作）。
- [ ] **预检**（防「动 pin 才发现规模」）：`node scripts/upstream/preflight-vendor-pin.mjs <tag> --offline`
      ——fork pure/replay/dropped + 深引 vendor seam + 上游包集合增删 + 新增 client 行 + 运行时 npm 状态；
      `--fail-on-replay` 可当硬门。
- [ ] **门禁基线照面**（三条都必须绿，升级后 §6 要复绿）：`node scripts/upstream/verify-registry.mjs`、
      `node scripts/upstream/check-anchors.mjs --report`、
      `node scripts/upstream/verify-upstream-touchpoints.mjs --no-artifact-rebuild`。
      C11–C14（插件受保护集合）的绿是升级后仍须绿的硬条件——变红按 §7 改派生，**不得改判据放行**。

## 1. 上游差异审计（只读）

> **顺序约束**：本节必须在 §2 动 pin **之前**完成。`update-vendor` 先跑
> `git fetch --depth 1 origin tag <tag>`，会在新 commit 处写 shallow 嫁接——此后
> `git log/rev-list <旧>..<新>` 只数得到 1 个 commit。事后恢复完整历史：
> `git -C vendor/harness-checkout fetch --unshallow origin`（只动本地 git 状态）。

- [ ] 规模与主题：`git log --oneline <旧>..<新> | wc -l`、`git diff --stat <旧> <新>`。
- [ ] 包集合增删：`git ls-tree -r --name-only <新> -- packages | grep package.json` 对比——新增包进 vendor 树，
      删除包在锁文件留下待清 importer 记录。
- [ ] chamber import 面审计：上游有实质改动的包 × chamber 的 import/事件消费（改名/重构是否被消费）。
- [ ] fork 副本 diff：`packages/client/connection`、`packages/client/web`、`packages/client/api-gateway`
      → 判断「冲突需合并」vs「干净采纳」（→ §3）。
- [ ] 首屏耦合审计：上游新增/改名的官方 client 行若被复合首屏 inject → 同步 host-graph 降级注释；
      探针集合是派生的（不用加名字），但命名空间**不再导出** `inject` 的漂移由
      `packages/renderer/test/lifecycle/required-extra-rows.test.ts` 的逐 id 表兜底。

## 2. 双线 pin 一致性

> **源码线**（构建期 vendor 树）= submodule commit，唯一入口 `update-vendor.mjs`；
> **运行时线**（打包进桌面的 `@deepseek-ai/dsh`）= 六个锚（见下）。

- [ ] 源码线：`node scripts/upstream/update-vendor.mjs <tag>` 原子升级（fetch+校验 → 切 submodule →
      写 `harness.commit` → 差量建链 → 重生成锁文件 → frozen 验证）。禁止手工改 gitlink / `harness.commit`。
- [ ] **index gitlink 已指向目标 commit**：工具只切 submodule HEAD 与 pin、**不写 index gitlink**，而
      `ensure-harness-vendor` 用 index gitlink 对拍 → 差量建链会以 `gitlink=<旧> != pin=<新>` 硬失败。
      处置：`git add vendor/harness-checkout` 后重跑同一条命令（幂等；提交时 gitlink 与 pin 同批）。
- [ ] 源码线验证：`node scripts/dev/ensure-harness-vendor.mjs --check`（HEAD == `harness.commit`、
      链接集合 == 锁文件 importer 集合）。
- [ ] 运行时线：`bundle-dsh.mjs` 的 `DEFAULT_DSH_VERSION` 与 `packages/desktop/vendor/dsh/package.json` 的
      `@deepseek-ai/dsh` → 目标版本（先确认 npm 已发布；未发布则只收口源码线，运行时线留到发布后单独提交）。
- [ ] 六锚同步：`release.yml` 的 `env.DSH_CHAMBER_DSH_VERSION`、`scripts/install-gateway.sh` 的
      `DSH_CHAMBER_DSH_VERSION`、`packages/gateway/package.json` 的 `dshAnchorVersion` 三源一致（preflight 硬断言，
      不要只改一处）；其余三锚（`bundle-dsh.mjs` 兜底、desktop vendor 锁文件、`release-preflight` 的 `FORK_VERSION`）
      随升级与 §5 自动对齐。
- [ ] 重建 vendor 树：`node scripts/dev/ensure-harness-vendor.mjs` → 链接数 = 目标版本包数、无告警。

## 3. fork 副本 rebase 与 chamber 适配

- [ ] 三个 fork 副本：basePath 补丁与上游改动同文件时手工合并（chamber 选项对象、`ctx.chamberBasePath`、
      boot 接线）；干净采纳项照抄；上游新增钩子按 chamber 场景裁决采纳/跳过。
- [ ] 其余适配面：控制面代理限额、`spawn-dsh` 的 pin 注释、desktop/renderer 注释基线等与上游对齐。
- [ ] 上游行为变化逐项裁决：限额与代理上限冲突、事件改名是否被消费、新包是否要动作、新 wire 是否改变例外边界。
- [ ] 逐面验证：`test:connection`、`test:client-web`、`typecheck:client-web`、`test:control-plane`。
- [ ] 自建物重放（layout/sidebar fork、covered factory、vendor 补丁锚点）逐项裁决：采纳或保留偏差并登记
      （口径见 `upstream-touchpoints.md` §1–§3）。

## 4. 锁文件

- [ ] 源码线锁文件由 `update-vendor.mjs` 原子重生成（非 frozen → `restore-lockfile-vendor-records.mjs` 补回 →
      frozen 验证）；**重生成前不要单独跑 `ensure` 默认模式**（断言滞后属预期）。
- [ ] pnpm 11 会裁剪 vendor importer 记录 → `node scripts/upstream/restore-lockfile-vendor-records.mjs` 补回；
      新增 vendor 包需手工补 importer 记录（零依赖成员为单行 `key: {}`）；已删除成员不得被复活
      （守卫见其 `.test.mjs`）。
- [ ] **已有成员的依赖集变化**：脚本只增不减，pnpm 裁掉该段时会复活**旧**记录（缺新依赖边）⇒ frozen 报
      `specifiers don't match`。判据 = `update-vendor` 第 6 步的 frozen 安装；失败时按字母序手工补该成员的新依赖边。
- [ ] 收口：`pnpm install --frozen-lockfile` 通过、`ensure-harness-vendor.mjs --check` 通过、
      `git diff --exit-code -- pnpm-lock.yaml` 为空。

## 5. 捆绑运行时

- [ ] `pnpm --filter @dsh-chamber/desktop run bundle:dsh -- --force --refresh-lockfile`
      （runtime 锁文件版本变化时必须 `--refresh-lockfile`，否则 `ERR_PNPM_OUTDATED_LOCKFILE`）。
- [ ] 冒烟：`node packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version` = 目标版本。
- [ ] `allowBuilds` / `DENY_BUILDS` 复核：上游新增原生依赖时显式裁决（单源生成点 + 测试钉住），不留沉默的 ignored builds。

## 6. 回归

- [ ] 全量：`pnpm run check:full`（= `run-checks.mjs full`：static + typecheck + 全部包测试 + macOS/Swift 腿 +
      打包前冒烟）。
- [ ] full 之外的升级项：`build:renderer`、`verify:i18n`、`smoke`（未捆绑运行时的检出打印 SKIP 属正常；
      只有 lockfile 的 `packages/desktop/vendor/dsh` 不算已安装）。
- [ ] 门禁复绿（§0 的三条）：`verify-upstream-touchpoints.mjs`（C1/C3–C15；`--no-artifact-rebuild` 可跳产物重建）、
      `verify-registry.mjs`（改了 `registry.json` 必须 `registry-views.mjs --write`，生成块禁手改）、
      `check-anchors.mjs`（预算只降不升；迁移后 `--update-budget` 调低）。
      C11–C14 变红时先判上游漂移还是派生写错，再改派生（B₀ 快照 / F 来源 / S 注册表 / wire 镜像）。
- [ ] 残留扫描：`grep -rn "<上一版 pin 的版本字面量>|<上一版 commit 短哈希>" packages/ scripts/ harness.commit`
      仅剩注释里的历史叙述；生产源码/脚本/配置里的「活」版本字面量必须登记在 C10 白名单。

## 7. 文档与记录

- [ ] 迁移叙述（pin、fork rebase 面、适配面、验证结论）写 `CHANGELOG.md` + `docs/CHANGELOG.en-US.md` 发布节，
      随后 `node scripts/gates/verify-i18n.mjs --write` 刷新 i18n 记录。
- [ ] 触点结构变更走 registry：`registry.json` → `registry-views.mjs --write` → `verify-registry.mjs` 绿。
- [ ] 引用基线版本的文档（design 09/11、README、DEVELOPMENT、本目录）更新版本号，历史叙述保留。
- [ ] **未落地的实机门禁与遗留偏差**登记进 `docs/progress/STATUS.md`（只写仍 open 的项，不留已完成台账）；
      下次升级复用本清单复验。**版本值不写进 checklist**。
