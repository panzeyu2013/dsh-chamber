# scripts/ 目录约定

按使用者分两类，**新增脚本时请归入正确位置**：

## `scripts/` —— 用户 / 运维面脚本

- `install-gateway.sh` —— dsh-chamber Gateway 一键安装器（设计 17 服务器部署）：
  交互向导 + 非交互模式，install / update / status / logs / uninstall 子命令。

用户脚本以"从 GitHub 拉取即可运行、零仓库依赖"为原则（尽量只依赖 bash/curl/node），
文档入口见 `docs/deploy-gateway.md`。

## `scripts/dev/` —— 开发者 / 维护者 / 测试脚本

- `ensure-harness-vendor.mjs`、`ensure-electron.mjs` —— 安装链（preinstall/postinstall 引导；
  vendor 树由 submodule 单源引导：硬校验 pin + 幂等建链 + 锁文件集合断言，`--check` 只校验）
- `verify-i18n.mjs`、`typecheck-client-web.mjs`、`release-semver.mjs`、
  `release-workflow-policy.test.mjs`、`gen-third-party-notices.mjs`、
  `restore-lockfile-vendor-records.mjs`、`test-shell-loader.mjs`、`test-shell-register.mjs`
  —— 校验 / 发布 / 测试工具

这些脚本面向仓库开发与发布流程（package.json hooks、CI、release workflow 引用），
不在用户部署环境中执行。

## `scripts/update-vendor.mjs` —— 上游 dsh 源码 pin 升级（submodule 原子流程）

`node scripts/update-vendor.mjs <tag>`（tag 如 `dsh-v0.1.1-rc.2`）：fetch+校验 tag →
切 submodule → 更新 `harness.commit` → 差量建链 → 原子重生成锁文件 → frozen 验证。
