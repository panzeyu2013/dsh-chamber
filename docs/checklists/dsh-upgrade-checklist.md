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
> （打包进桌面的 `@deepseek-ai/dsh` npm 包）维持原有四常量。

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
      `DSH_CHAMBER_DSH_VERSION`（当前 `0.1.2-alpha.5`）→ 目标版本（与 release.yml
      的 env 同步；脚本默认安装该版本，用户可交互覆盖）。
- [ ] 重建 vendor 树：`node scripts/dev/ensure-harness-vendor.mjs` → 链接数 = 目标
      版本包数（240 之类），无告警（submodule HEAD==pin）。

## 3. fork 副本 rebase（chamber 侧适配）

- [ ] `packages/dsh-client-connection`：上游改动与 basePath 补丁同文件时手工合并
      （如 `createWebConnectionRpc` 签名联合参数）；干净采纳项照抄（如 300MiB）；
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
