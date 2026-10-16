# 上游 pin 升级管线：机械面自动化与自恢复（alpha.4 五轴复核的「下次 pin」项）

> 来源：alpha.3 → alpha.4 升级（提交 4db12700 / fe20f325）的五轴只读复核（最优性轴 M1/M2/L1/L2/L3/L4、S1）。
> 这些都不阻断 alpha.4 的合并；本文件只登记「下一次 pin 前值得做」的改进，**不弱化任何现有门禁**
> （C5/C10/C11/C1/C3 的权威性不变；自动写锚只打印 diff 供审）。

## 1. update-vendor 首跑必然失败 + 恢复指引与实际处置相反（M2）

- 现状：工具只切 submodule HEAD 与 `harness.commit`、不写 index gitlink，而差量建链用 index gitlink 对拍
  （`scripts/dev/ensure-harness-vendor.mjs` 的 pin/gitlink 断言，函数未导出故此处只引路径）⇒ 首跑必在 step 5 失败；
  正确处置（`docs/checklists/dsh-upgrade-checklist.md` §2 第 2 条）= `git add vendor/harness-checkout` 后幂等重跑。
- 证据：升级日志 `.tmp/a4/exec/p1-update-1.log`（step 5 报 `gitlink=2fbf4359b82f != pin=86a402200d95`）；
  `scripts/upstream/update-vendor.mjs` 的 catch 恢复指引却是「把 submodule 切回旧 pin」，与实际处置相反。
- 最小修复：step 5 调 ensure 时为该子进程传专用豁免（例如 `DSH_CHAMBER_VENDOR_SKIP_GITLINK=1`，只影响这次差量建链，
  常设 preinstall/CI 硬门不动），并把 catch 文案改成 checklist 的 `git add` + 重跑。

## 2. bundle:dsh 对 ZFS 抖动（ERR_PNPM_EAGAIN）无有界重试（L1）

- 现状：`pnpm --filter @dsh-chamber/desktop run bundle:dsh -- --force --refresh-lockfile` 在 ZFS 上可能以
  `[ERR_PNPM_EAGAIN] importPackage … copyfile` 失败；第二次运行（store 已热）2.2s 成功。
- 证据：`.tmp/a4/exec/p3-bundle.log`（失败）与 `.tmp/a4/exec/p3-bundle2.log`（成功）。
- 最小修复：`packages/desktop/scripts/bundle-dsh.mjs` 对含 `ERR_PNPM_EAGAIN` 的输出做**一次**有界重试
  （staging 目录可弃、安装幂等）。备选 `--config.package-import-method=hardlink` 未在本仓 ZFS 实测，不作为推荐。

## 3. 文档「当前基线」字面量与手写计数无门禁（L2/L3）

- 现状：C10 的活字面量扫描不走 `docs/`；`docs/checklists/upstream-touchpoints.md` §0 自述速查值为手写散文。
  每 pin 需人工复扫（本代已全部改对：`0.2.1-alpha.3` 全仓仅剩 `STATUS.md` 的历史「…起」叙述）。
- 可选修复：docs 改为引用 `harness.commit` 而不复述版本；或把 C4 计数放进生成视图；或在 checklist §7 加一条
  `grep` 复扫步骤。不建议把 docs 并入 C10（历史叙述会被误判为非法）。

## 4. 机械面单批管线（S1，第四选项）

- 组成：上文 1/2 + 「由 tag 推导六锚与 3 fork 字面量（打印 diff、可选 `--dry-run`，C10 仍是权威）」+
  链式 `registry-views --write` / `verify:i18n --write` + 收尾 `verify-upstream-touchpoints` 并列出仍需人工裁决的语义点
  （roster / C11 白名单 / 子座席 / docs 叙述）。
- 收益：每 pin 从「8 锚 + 3 fork + 文档字面量 + 2 次必失败调用」降到「3 处语义裁决 + 复核」。
- 边界：不自动提交、不自动改判据；自动写锚只打印 diff 供人工过目。

## 5. 流程性提示（L4，仅约定）

- 本机无 `swiftc` 时，第一次就跑 `DSH_CHAMBER_SWIFT_PARITY_SKIP=1`；本地回归用
  `node scripts/gates/run-checks.mjs tests --continue`——默认 **fail-fast**，单个环境性失败会掩盖其后的全部测试步
  （alpha.4 期实测：fail-fast 到 `test:control-plane` 时其后 20 步未跑；`--continue` 跑满 22 步后仅剩 root EACCES 一项）。
