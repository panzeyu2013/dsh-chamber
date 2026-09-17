# scripts/ 目录约定与分类

脚本按**使用者与运行时机**分目录（2026-12 整理）。新增脚本时先选类，再在根 `package.json`
（或 CI / release workflow）接线，并同步更新引用方。

## 目录

| 目录 | 面向 | 内容 | 入口 / 登记 |
|---|---|---|---|
| `scripts/`（根） | 用户 / 运维 | `install-gateway.sh`——Gateway 一键安装器（`install` / `update` / `restart` / `status` / `logs` / `uninstall`，交互向导 + 非交互模式）。以「从 GitHub 拉取即可运行、零仓库依赖」为原则（只依赖 bash/curl/node）。 | 部署文档 `docs/deploy/deploy-gateway.md` |
| `dev/` | 开发者 | 安装链引导 `ensure-harness-vendor.mjs`（preinstall）/ `ensure-electron.mjs`（postinstall）；客户端 typecheck 垫片 `typecheck-{client-web,connection,api-gateway}.mjs`；测试 loader/register 桩 `test-{client-web,connection,shell}-{loader,register}.mjs` + `test-support/`；实机 E2E harness `e2e-gateway-harness.ts`。 | 面向仓库开发的本地工具链，不在用户部署环境执行 |
| `gates/` | 每次 push 的门（本地 = CI 同源） | 单入口 runner `run-checks.mjs`；测试接线门 `verify-test-wiring.mjs`；文档门 `verify-i18n.mjs` / `verify-md-links.mjs`；设计 token 门 `verify-style-tokens.mjs`；CI 变更判类 `classify-ci-changes.mjs`；workflow 门 `verify-workflow-{action-pins,yaml-scalars}.mjs`。 | `pnpm run check:static` / `check:tests`；新增门须同时进 `run-checks.mjs` 的 `STATIC_CHECKS` 与根 `package.json` |
| `release/` | 发布链 | 发布预检 `release-preflight.mjs` + `release-semver.mjs`；发布产物校验 `release-artifacts.mjs`；release 工作流策略 `release-workflow-policy.test.mjs`；发布 CI 证明 `verify-release-ci-proof.mjs`；第三方声明生成 `gen-third-party-notices.mjs`；打包清单锁步 `packaging-manifest-lockstep.test.mjs`。 | `pnpm run release:preflight` / `test:release-workflow`；流程见 `docs/checklists/release-checklist.md` |
| `upstream/` | 上游 pin 与触点 | pin 升级 `update-vendor.mjs`；升级前预检 `preflight-vendor-pin.mjs`；锁文件 vendor 记录恢复 `restore-lockfile-vendor-records.mjs` + `lockfile-store-path-mappings.test.mjs`；上游触点门 C1–C15 `verify-upstream-touchpoints{,-args,-hover}.mjs`；插件受保护集合门 `plugin-protection-gate.mjs`；移动端锚点门 `mobile-anchors.mjs` / `verify-mobile-anchors{,-args}.mjs`；已提交产物门（C8）`artifact-gate.mjs`。 | 登记表 `docs/checklists/upstream-touchpoints.md`；升级流程 `docs/checklists/dsh-upgrade-checklist.md` |
| `perf/` | 性能实测 | `boot/switch/eval-measure.mjs`、`measure-ui.mjs`、`disk-walk-baseline.mjs`、`cdp-lib.mjs` + `data/`（结果入库）。 | 方法与环境纪律见同目录 `README.md`（只做同环境 A/B） |
| `gui-acceptance/` | GUI 验收 | `probe.mjs`（只读探测）、`walkthrough.mjs`、`mobile-walkthrough.mjs`、`checks.mjs` / `mobile-checks.mjs`（纯判据层）、`launch.mjs`、`cdp.mjs`、`run.mjs`。 | `pnpm run acceptance:gui`；流程见 `docs/checklists/gui-acceptance-checklist.md` |

## 分类规则

1. **按运行时机选目录**：开发期工具 → `dev/`；每次 push 的仓库门 → `gates/`；发布链 → `release/`；上游 pin 与触点 → `upstream/`；实测/验收工具箱 → `perf/`、`gui-acceptance/`；面向用户的部署脚本留在根。
2. **门禁脚本三纪律**：判定纯函数化（可与执行层分开单测）、失败响亮（绝不静默通过）、退出码固定（`0` 通过 / `1` 红 / `2` 用法错误）。
3. **测试接线**：每个 `*.test.mjs` 必须被某个 `package.json` 测试脚本引用（`pnpm run verify:test-wiring`），单测与实现同目录。
4. **引用一律写仓库根相对路径**（`scripts/<类>/<文件>`）；移动脚本时同步更新引用方——根 `package.json`、`.github/workflows/*.yml`、`docs/**`、其他脚本的相对 `import`、以及 `harness.commit` 这类文件头注释。
5. **依赖纪律**：这些脚本不新增运行时依赖（node 内置 + 仓库已有依赖）；测量/验收入口遵循各自目录 README 的只读与脱敏纪律。
