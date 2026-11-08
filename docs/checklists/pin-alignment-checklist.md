# pin 对齐 Checklist（发布前）

> 本文件是**程序**，不是记录：不写版本号、commit、锁值或基线快照。当前值只在单源里读——源码线
> `harness.commit`、运行时线 `packages/desktop/vendor/dsh/pnpm-lock.yaml`、Swift 本地能力载荷
> `packages/desktop/primary-runtime-lock.json`、pnpm 与产品版本在各 `package.json`。
> 换 pin 的过程不在这里：升级序见同目录 [`dsh-upgrade-checklist.md`](dsh-upgrade-checklist.md)（§2 双线 pin、§5 载荷），发布主流程见 [`release-checklist.md`](release-checklist.md)。本清单只做发布前的漂移核验。

## 0. 目的与允许的例外

- 目的：证明出货内容依赖的 pin 全部指向同一组上游坐标，且没有第二来源在漂。
- 允许的例外（写清即不算漂移）：① `targets` 只保留 mac-arm64 是本仓设计收窄（见 `packages/desktop/primary-runtime-lock.json` 的 `provenance.targets`；载荷边界见 design 18 §4.2、design 25 §3.2）；② Electron 冻结面按 [`../progress/electron-frozen.md`](../progress/electron-frozen.md) 的复活清单处理，不在发布门内；③ 本仓产品版本与上游版本不同轴（根与各 `@dsh-chamber/*` 包同批 bump 由 [`release-checklist.md`](release-checklist.md) §1 管）；④ 三个 fork 副本携带上游版本、种子包随 chamber 发版（design 20 §10）。
- 判据是可复现的相等（校验器退出码 + 逐项输出），不是人工目检。

## 1. 前置：单源就位（只读）

- [ ] vendor 子模块指向 `harness.commit`：`node scripts/dev/ensure-harness-vendor.mjs --check`（HEAD == pin、链接集合 == 锁文件 importer 集合）。
- [ ] 锁文件与 pin 同批：`pnpm install --frozen-lockfile` 通过（pin 已动而锁未重生成时此步失败，属预期门）。
- [ ] 校验器可运行：`node scripts/release/verify-pin-alignment.mjs`（只读文件、不联网；输出对齐表）。

## 2. 机器门：验证器（阻断项）

- [ ] `node scripts/release/verify-pin-alignment.mjs` 退出 0（已接入 `release:preflight` 完整腿与 `release.yml` 的 `validation-metadata` job：vendor 在场时该检查阻断发布）。它逐项比对（值都在脚本里从单源读取，本清单不抄）：
  - `harness.commit` ↔ `primary-runtime-lock.json` 的 `provenance.upstreamCommit`；
  - primary-runtime 全字段（`nodeVersion`/`nodeSha256`、`pythonVersion`/`pythonRelease`/`pythonTarget`/`pythonSha256`、`pythonPackages`、`wheels`）↔ `vendor/harness-checkout/scripts/primary-runtime/lock.json`；
  - pnpm 单源（根 `package.json` 的 `packageManager`）↔ 根锁 importer、desktop/gateway `dependencies.pnpm`、`bundle-dsh.mjs` 的 `BUNDLE_PNPM_VERSION`、`ci.yml`/`release.yml` 的 `pnpm/action-setup` `version:`；
  - dsh 运行时版本（`vendor/dsh/pnpm-lock.yaml` 的 `@deepseek-ai/dsh` 解析值）↔ 上游 pin 树同名包版本与各 dsh 版本锚；
  - LibreOffice kit 运行时钟（`@deepseek-ai/libreoffice-kit*` 的解析值）↔ 上游 pin 根锁。
- [ ] 锁步用例：`node --test packages/desktop/scripts/prepare-python-payload.test.mjs` 绿（payload 锁与上游 pin 锁逐项相等、`targets` 只允许 mac-arm64）。
- [ ] 退出 1 / 报差异 = **阻断**：归位单源（改锁走升级流程，改脚本走对应 owner），不允许改文档或注释绕过。

## 3. 内部镜像与生成投影

- [ ] pnpm 镜像门：`node scripts/gates/verify-workflow-action-pins.mjs` 绿（一个声明单源，全部 action/包/脚本镜像逐项相等）。
- [ ] dsh 版本锚（六处）的一致性与升级收口归 [`dsh-upgrade-checklist.md`](dsh-upgrade-checklist.md) §2；本清单只确认自上次升级以来没有手改任一锚（`node scripts/release/release-preflight.mjs <版本> --versions-only` 会硬断言）。
- [ ] 生成投影按锁重生成：`pnpm run gen:notices` 后 `git diff --exit-code -- THIRD_PARTY_NOTICES.md docs/THIRD_PARTY_NOTICES.en-US.md` 为空（或改动已在发布提交内）；双语与 i18n 记录按 [`release-checklist.md`](release-checklist.md) §3 收口。
- [ ] vendor 符号链接树与锁 importer 集合一致（§1 的 `--check` 已覆盖；重建后重跑）。

## 4. 文档面：版本字面值只留单源

- [ ] `docs/checklists/`、`docs/design/`、`docs/progress/`、根 `AGENTS.md` 与包 README 里没有当前 pin 的版本字面值。示例：先从单源读出变量再扫（不要把值抄进命令或清单）：

```bash
PIN=$(grep -v '^#' harness.commit | head -1)
DSH=$(grep -oE '@deepseek-ai/dsh@[0-9][0-9A-Za-z.-]*' packages/desktop/vendor/dsh/pnpm-lock.yaml | head -1 | sed 's/.*@//')
NODE=$(node -p "require('./packages/desktop/primary-runtime-lock.json').nodeVersion")
PNPM=$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')")
grep -rnE --include='*.md' "(${PIN:0:12}|${DSH}|${NODE}|${PNPM})" docs/ AGENTS.md packages/*/README.md \
  | grep -vE 'CHANGELOG|THIRD_PARTY_NOTICES'
```

- [ ] 命中逐条判断：`CHANGELOG.md` / `docs/CHANGELOG.en-US.md`、生成投影（`THIRD_PARTY_NOTICES*`）、`docs/progress/STATUS.md` 的 open 记录、以及 design 里明确标注「历史证据（不随本仓 pin 移动）」的不可变上游坐标属允许；其余「当前值」改成指向单源。
- [ ] `node scripts/gates/verify-md-links.mjs` 退出 0（相对链接与锚点）。
- [ ] `pnpm run verify:i18n` 全 `consistent`（改过双语对时先 `pnpm run verify:i18n -- --write` 重录）。

## 5. 失败处置

- 任何漂移 = 阻断发布，不允许带漂移发布。
- 允许的例外（§0）在当次发布适用时，书面登记在发布 PR 描述与 `CHANGELOG.md` 发布节；未登记的例外按阻断处理（本清单不保存某次记录）。
- 修复只做单源归位：锁 / payload 走 [`dsh-upgrade-checklist.md`](dsh-upgrade-checklist.md)，脚本 / 工作流由对应 owner 改；不降判据、不改文档叙述让门变绿。
