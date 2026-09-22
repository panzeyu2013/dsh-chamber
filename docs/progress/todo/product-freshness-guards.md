# 产物新鲜度守卫（剩余 G2/G3/G5/G7/G8；未排期）

> 六类产物由「陈旧/缺失 ⇒ 红」的比对门覆盖：`desktop/dist/control-plane/**`（标记守卫）、`gateway/dist/**`（标记守卫）、
> seed `dist/index.js` ×4、`gateway/host-packages/dsh-chamber-client-ui-mobile/**`、`desktop/dist/preload.cjs`、
> `renderer/src/generated/**`（`scripts/gates/verify-artifact-freshness.mjs`
> 的 tests/full，经 `ci.yml:179` 进 CI；`scripts/gates/verify-electron-artifacts.mjs` 的 macOS 腿/CI 另执行编译产物冒烟。
> G1=`verify:test-wiring`、G4/G6 同属该门）。本文只留仍无守卫的产物与最小守卫建议；开放状态与失效判据见
> `docs/progress/STATUS.md`「产物新鲜度守卫」条，design 21 §7 登记。想法清单非承诺；落地后按
> `docs/progress/README.md` 移出。

## 1. 仍无守卫的产物

|产物|生成者|提交？|当前守卫|陈旧后果|
|---|---|---|---|---|
|`packages/desktop/dist/web/**`|renderer `build`（vite `build.outDir = ../desktop/dist/web`，三处路径契约见 `packages/desktop/scripts/electron-shared.mjs`）|忽略|只有路径契约文本断言（`scripts/electron-shared.test.mjs`）与 CI 的 scoper 标记断言|打包发行旧前端壳（IPC名/槽位可能漂移）|
|`packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`|`scripts/build-host-graph-package.mjs`（各seed包 `dist` cpSync）|忽略|只有行序/outDir断言（`scripts/release/packaging-manifest-lockstep.test.mjs`）|打包seed旧宿主包|
|vendor `allowBuilds` 锁步（根 `pnpm-workspace.yaml` ↔ `packages/dsh-runtime/src/allow-builds.mjs`）|人工同步|提交|无|新增原生依赖漏登或漏deny会静默漂移|

`dist/` 整族在 `.gitignore`：干净checkout的"缺失"是正常态——首批 host/dsh-runtime/mobile 产物须先由 `pnpm run build:artifacts` 自举，其余按需构建；要防的是本地/打包态的"存在但陈旧"——CI每次全新构建，看不到这一类。

> 表中 `scripts/*` 指 `packages/desktop/scripts/*`（Electron构建脚本；gateway侧 `packages/gateway/scripts/*`），非仓库根 `scripts/`。

## 2. 最小守卫建议

### P0（成本低、把"没有守卫"变成显式登记）

- **G2产物新鲜度登记表**：产物 ↔ 生成者 ↔ 守卫或豁免一张表，门禁断言每个产物都有守卫或显式豁免（§1全部）。成本低–中（表 + 纯函数）；收益：杜绝静默。
- **G8豁免表**：不需要守卫的产物（每次构建全新、或由C8/门禁覆盖）显式记理由（§1全部）。成本低；收益：防止G2表被"全部豁免"掏空——豁免也要有人签。

### P1（补强，覆盖剩余产物）

- **G3 `.build-manifest.json` 输入摘要**：构建时写 `{inputsHash, toolVersion, outputs[]}`，测试比对；比标记串强——无文案产物（web/host-package）也能判。适用全部忽略态产物。成本中（每构建脚本一处 + 比对函数）；收益：不依赖"改文案时手工搬标记串"。
- **G5 `before-pack` 打包前兜底**：既有 `scripts/before-pack.mjs` 断言 `dist/web`、`preload.cjs`、`host-*-package`、`control-plane` 存在且不早于其输入（mtime兜底；fresh checkout缺失另判）。适用打包闭包。成本低；收益：开发机没跑测试也不把陈旧产物打进包。

### P2（纪律/长尾）

- **G7 vendor allowBuilds锁步**：断言根 `pnpm-workspace.yaml` 的 `allowBuilds` 与 `packages/dsh-runtime/src/allow-builds.mjs` 的 `ALLOW_BUILDS`/`DENY_BUILDS` 镜像关系。成本低；收益：AGENTS把它列为硬事实、当前只靠人工同步——新增原生依赖漏登或漏deny会静默漂移。

## 3. 开放问题

- 标记串（现状）vs输入摘要（G3）：标记串便宜可读，但每次改文案要同步移动；两者并存是否值得。
- 失败信息**必须**给重建命令（现有比对门即如此），否则操作者只看到红、不知下一步。
- CI腿的边界：CI每次全新构建，"陈旧"只在本地/打包态出现——要真覆盖得在打包作业跑G5，而非push腿追加构建。
- smoke无PASS腿（见STATUS单列条）：是否在release作业装一次真实dsh运行时跑冒烟；不在本清单范围内。
