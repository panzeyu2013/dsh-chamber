# 发布前 Checklist

> 面向发布者：按序执行，任何 ❌ 都阻断发布。依据：`.github/workflows/release.yml`、
> `docs/DEVELOPMENT.md` §5、AGENTS.md 验证清单。命令前先
> `export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"`（node v24 / pnpm 11.21）。

## 发布流程总览

```
本地:  §0 内容确认 → §1.5 preflight（机械门禁）→ §2 changelog/i18n
       → §3 全量测试套件（精确发布提交）→ §4 构建 → §5 健康 → §7a commit+tag
CI:    §7b dry_run 先行（新路径必须验证过一次）→ §7c 正式 tag push → finalize
```

**核心原则**：机械项一律脚本化（preflight）；
测试套件绑定精确发布提交；**新增/修改的发布基础设施（workflow/脚本路径/action SHA）
必须先被 dry-run 验证**；push 前重跑 preflight。

## 0. 版本与内容确认

- [ ] 目标版本号只允许 canonical stable `X.Y.Z` 或 beta `X.Y.Z-beta.N`（如
      `0.2.0-beta.3`）；`alpha`、`rc` 与其他 prerelease 必须 fail closed；changelog
      无 `[Unreleased]` 待收尾条目。
- [ ] 发布内容（功能/迁移/修复）已全部合入发布分支且本地无未提交改动。
- [ ] 自上次发布以来**修改过任何 workflow / 脚本路径 / action SHA** → 先安排
      `workflow_dispatch` dry_run 全链验证（见 §7b），不要直接上正式 tag。

## 1. 版本断言（release.yml create-release 会硬校验）

- [ ] 根 `package.json` + 全部 `@dsh-chamber/*` 包（当前 15 个）version = 目标版本
      （数据驱动，见 §1.5；release.yml 复用同一 preflight 扫描器硬断言根 +
      全部非 fork chamber 包，新增包自动纳入）。
- [ ] fork 副本例外：`@deepseek-ai/dsh-client-connection` / `dsh-client-web` /
      `dsh-api-gateway` 版本 = 上游基线版本（如 `0.1.2-alpha.5`），**不随发布
      版本**；release.yml
      同样经 preflight 硬断言该基线。
- [ ] **安装脚本 dsh 版本常量**：`scripts/install-gateway.sh` 内置的
      `DSH_CHAMBER_DSH_VERSION`（当前 `0.1.2-alpha.5`）与
      `.github/workflows/release.yml` 的 `env.DSH_CHAMBER_DSH_VERSION` 一致
      ——dsh 运行时版本变更时必须同步改脚本常量（该常量为脚本默认安装
      版本，用户可交互覆盖）。

## 1.5 机械门禁：release:preflight

- [ ] `node scripts/dev/release-preflight.mjs <版本>` 全绿（版本统一性含 fork 副本与
      安装脚本 dsh 常量、changelog 中英对等、verify:i18n、**全部 workflow action SHA
      可解析上游**（`--offline` 跳过网络）、冲突标记、git 干净、frozen install、
      test:release-workflow；最后提示 §3 全量测试套件须在**精确发布提交**上跑）。
- [ ] 网络受限时 `--offline` 至少通过非网络检查；CI 的 test job 已内置
      `--actions-only` 门禁（tag/PR 每次运行都会校验 action SHA）。

## 2. changelog 与 i18n

- [ ] `CHANGELOG.md` 与 `docs/CHANGELOG.en-US.md` 均有 `## [<version>]` 节
      （release.yml 提取为发布正文，缺失即失败）；中英条目对等。
- [ ] 版本节结构完整（`### 新增/修复/变更` 或 `### Added/Fixed/Changed`），
      无重复版本标题。
- [ ] `node scripts/dev/verify-i18n.mjs` → 5 对全部 `consistent`（改过 README/
      DEVELOPMENT/CONTRIBUTING/CHANGELOG/THIRD_PARTY_NOTICES 任意文本后须
      `node scripts/dev/verify-i18n.mjs --write` 刷新）。

## 3. 测试与类型检查（AGENTS.md 清单）

- [ ] **全量测试套件在精确发布提交（`git rev-parse HEAD`）上运行**——上一提交的记录
      不算数。
- [ ] `pnpm run test:control-plane`（以根脚本为唯一清单，含生命周期、reaper、RPC/cordis 等门）。
- [ ] `pnpm run test:runtime` + `typecheck:runtime`。
- [ ] `pnpm run test:desktop`（transport/ssh/config/trust/plugin-sync/settings/notifications/
      deep-link/open-in/ipc-surface-mirror/runtime-lockstep/dsh-runtime-controller；失败必须
      定位，不能用重跑代替结论）。
- [ ] `pnpm run test:gateway` + `typecheck:gateway` + `build:gateway`。
- [ ] `pnpm run test:renderer-shell`、`test:git`、`test:host-git`、`test:sidebar`、`test:layout`、
      `test:settings-bridge`、`test:connections`、`test:client-web`、`test:connection`、
      `test:open-in`、`test:cli`
- [ ] 类型检查全套：`typecheck` + `typecheck:sidebar/layout/connections/settings-bridge/git/open-in/client-web/connection/host-graph/host-git`
- [ ] **旧版本号残留扫描**：`grep -rn "<上一发布版本>" packages/*/test* packages/*/*.test.ts packages/*/scripts/*.test.mjs`
      为空（测试硬编码旧 shellVersion 会在 bump 后误触发 F4 壳升级路径；`after-pack-adhoc-sign.test.mjs`
      的版本钉曾因未纳入扫描在 0.2.0 失配）。

## 4. 构建

- [ ] `pnpm install --frozen-lockfile` 通过（锁文件含 vendor importer 记录）。
- [ ] `pnpm run build:renderer`、`pnpm run build:host-packages`、`pnpm run build:desktop` 通过。
- [ ] **打包链校验在 tag 触发的 release.yml 构建腿执行**（afterPack 断言：vendor
      dsh 平台、pnpm 模块、asar 内 dsh-runtime；跨平台路径形态见
      packaging-closure-checklist §3）。改动打包链/构建脚本后，先用 §7b 的
      `workflow_dispatch` dry_run 跑完整构建腿验证，再上正式 tag。
- [ ] **打包完整性自检**（`docs/checklists/packaging-closure-checklist.md` §1–§2）：
      main.ts 传递 import 闭包 ⊆ `build.files`；构建链产物齐全
      （dist/control-plane、dist/preload.cjs、dist/host-*-package、vendor/dsh）。
- [ ] **本地不做打包/签名/公证**：安装包/更新源由 release.yml 的
      build-macos / build-windows 在 CI 生成，发布者本机无需 hdiutil/密钥。
- [ ] `pnpm run smoke` 通过（dsh 已封装时真跑；未安装时 SKIP 属正常）。

## 5. 工作区健康

- [ ] `git status --short` 无未跟踪文件（无 UPGRADE-*.md / .DS_Store / 临时文件）；`git stash list` 空。
- [ ] 无冲突标记（用 `node scripts/dev/release-preflight.mjs --offline` 的锚定行首扫描；
      裸 `grep '<<<<<<<' packages/ docs/ scripts/` 会自匹配本清单文件的字面示例行）。
- [ ] 旧 dsh pin 残留扫描：`grep -rn "141eb6f\|0\.1\.0-rc\.8" packages/ scripts/ harness.commit`
      （非 vendor/node_modules）仅剩历史文档/迁移条目。

## 6. 签名/公证（全部由 CI 处理）

- [ ] 本地不配置任何签名密钥；macOS Developer ID 签名/公证由 release.yml 发布腿
      处理。正式发布缺少五项凭据时在创建/变更 draft 前 fail-closed；构建后的 Developer
      ID、stapler 与 spctl 任一校验失败时阻断公开 finalize（draft 已创建并不等于已公开）。
      dry-run 即使仓库配置了正式 secrets，也必须强制 unset 全部签名/公证环境变量与
      `GH_TOKEN`；它不创建/变更 Release、不上传资产，并只产 ad-hoc 签名验证包。Windows 首版
      仍未签名，SmartScreen 提示是 design 11 §7 的明确让步，不把 sha512 误称为签名。

## 7. 提交、tag 与 CI

- [ ] `git add -A && git commit -m "release(v<版本>): ..."`（amend 已推送提交时
      `git commit --amend --no-edit` + `git push --force-with-lease`）。
- [ ] `git tag -a v<版本> -m "..."`（同 tag 重推前先删旧：`git tag -d v<版本> && git push origin :v<版本>`）。
- [ ] **push 前最后再跑一次 `release:preflight`**（含 git 干净检查）。
- [ ] **dry-run 先行**：`git push origin <分支>`（提交在分支上即可），
      然后 GitHub Actions 手动运行 `release.yml`（`workflow_dispatch`）：
      `version=<版本>`（不带 `v`，且仅 `X.Y.Z` / `X.Y.Z-beta.N`）、`dry_run=true` ——
      验证 create-release 断言 + validation +
      构建腿全链成功（强制清空签名/公证环境与 `GH_TOKEN`，只做 ad-hoc；**不**建正式
      Release、不上传资产、无注册表变更）。
      任何一步失败：修复 → 重新本地验证 → 再 dry-run，直到全绿。
- [ ] 正式发布：`git push origin <分支> && git push origin v<版本>` → 触发 Release workflow。
- [ ] 监控 `actions/runs`：create-release（版本断言/changelog/建 draft）→
      validation → build-macos → build-windows → build-gateway →
      finalize-release（draft 转公开）。**确认 validation job 的 "Set up job" 通过**
      （action SHA 解析失败会在这一步暴露）。

## 8. 发布后

- [ ] GitHub Release 正文 = changelog `[<version>]` 节（自动提取）。
- [ ] **CI 产物**齐全（本地不打包）：mac `.dmg`/`.zip`，win `.exe`，Gateway
      `.tgz` + 同名 `.tgz.sha256`；无 `.blockmap`，Gateway 不经 npm 发布。
- [ ] 更新源严格按通道存在：stable 只有 `latest.yml`/`latest-mac.yml`，beta 只有
      `beta.yml`/`beta-mac.yml`；beta Release 为 prerelease 且不占 GitHub latest。
