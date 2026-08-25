# 发布前 Checklist（v0.1.5 起沉淀）

> 面向发布者：按序执行，任何 ❌ 都阻断发布。依据：`.github/workflows/release.yml`、
> `docs/DEVELOPMENT.md` §5、AGENTS.md 验证清单。命令前先
> `export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"`（node v22 / pnpm 11.21）。

## 0. 版本与内容确认

- [ ] 目标版本号（如 `0.1.6`）已确定；changelog 无 `[Unreleased]` 待收尾条目。
- [ ] 发布内容（功能/迁移/修复）已全部合入 `main` 且本地无未提交改动。

## 1. 版本断言（release.yml create-release 会硬校验）

- [ ] 根 `package.json` + 全部 12 个 `@dsh-chamber/*` 包 version = 目标版本
      （`grep -m1 '"version"' package.json packages/*/package.json`；
      release.yml 硬断言其中 7 个发版包，本步覆盖全部）。
- [ ] fork 副本例外：`@deepseek-ai/dsh-client-connection` / `dsh-client-web`
      版本 = 上游基线版本（如 `0.1.1-rc.2`），**不随发布版本**。

## 2. changelog 与 i18n

- [ ] `CHANGELOG.md` 与 `docs/CHANGELOG.en-US.md` 均有 `## [<version>]` 节
      （release.yml 提取为发布正文，缺失即失败）；中英条目对等。
- [ ] 版本节结构完整（`### 新增/修复/变更` 或 `### Added/Fixed/Changed`），
      无重复版本标题。
- [ ] `node scripts/verify-i18n.mjs` → 5 对全部 `consistent`（改过 README/
      DEVELOPMENT/CONTRIBUTING/CHANGELOG/THIRD_PARTY_NOTICES 任意文本后须
      `node scripts/verify-i18n.mjs --write` 刷新）。

## 3. 测试与类型检查（AGENTS.md 清单）

- [ ] 控制面 9 套：`node packages/control-plane/test/{protocol,storage,m1-dsh-client,host-logs,manager-api,instance-proxy,ws-frames,static-serving,host-graph-seed}.ts`
- [ ] `pnpm run test:desktop`（transport/ssh/config/trust/plugin-sync/settings/notifications/deep-link/open-in；已知偶发事件循环 flake，失败重跑即可）
- [ ] `pnpm run test:renderer-shell`、`test:git`、`test:host-git`、`test:sidebar`、
      `test:settings-bridge`、`test:connections`、`test:client-web`、`test:connection`
- [ ] 类型检查全套：`typecheck` + `typecheck:sidebar/layout/connections/settings-bridge/git/open-in/client-web/host-graph/host-git/gateway`

## 4. 构建

- [ ] `pnpm install --frozen-lockfile` 通过（锁文件含 vendor importer 记录）。
- [ ] `pnpm run build:renderer`、`pnpm run build:host-packages`、`pnpm run build:desktop` 通过。
- [ ] **打包完整性自检**（`docs/checklists/packaging-closure-checklist.md` §1–§2）：
      main.ts 传递 import 闭包 ⊆ `build.files`；构建链产物齐全
      （dist/control-plane、dist/preload.cjs、dist/host-*-package、vendor/dsh）。
- [ ] **本地不做打包/签名/公证**（2026-08 决策）：安装包/更新源由 release.yml 的
      build-macos / build-windows 在 CI 生成，发布者本机无需 hdiutil/密钥。
- [ ] `pnpm run smoke` 通过（dsh 已封装时真跑；未安装时 SKIP 属正常）。

## 5. 工作区健康

- [ ] `git status --short` 无未跟踪文件（无 UPGRADE-*.md / .DS_Store / 临时文件）；`git stash list` 空。
- [ ] 无冲突标记（`grep -rn '<<<<<<<\|>>>>>>>' packages/ docs/ scripts/` 为空）。
- [ ] 旧 dsh pin 残留扫描：`grep -rn "141eb6f\|0\.1\.0-rc\.8" packages/ scripts/ harness.commit`
      （非 vendor/node_modules）仅剩历史文档/迁移条目。

## 6. 签名/公证（2026-08 起全部由 CI 处理）

- [ ] 本地不配置任何签名密钥；macOS 签名/公证、Windows 签名由 release.yml 的
      afterPack/发布腿处理（缺凭据或验签失败时 fail-closed 不发布，见 design 11 §7）。

## 7. 提交、tag 与 CI

- [ ] `git add -A && git commit -m "release(v<版本>): ..."`（amend 已推送提交时
      `git commit --amend --no-edit` + `git push --force-with-lease`）。
- [ ] `git tag -a v<版本> -m "..."`（同 tag 重推前先删旧：`git tag -d v<版本> && git push origin :v<版本>`）。
- [ ] `git push origin main && git push origin v<版本>` → 触发 Release workflow。
- [ ] 监控 `actions/runs`：create-release（版本断言/changelog/建 draft）→
      build-macos → build-windows → finalize-release（draft 转公开）。

## 8. 发布后

- [ ] GitHub Release 正文 = changelog `[<version>]` 节（自动提取）。
- [ ] **CI 产物**齐全（本地不打包）：Actions 运行页 mac `.dmg`/`.zip`/`latest-mac.yml`、
      win `.exe`/`latest.yml`；无 `.blockmap`。
- [ ] 更新源存在（electron-updater feed）；如发布 beta，`beta.yml`/`beta-mac.yml` 对应。
