# 产物新鲜度守卫（G2–G8；未排期）

> 2026-12产物普查：`packages/gateway/dist` 长期带旧一轮受保护集合判定器（`src` 已修、`dist` 未重建，打包态才暴露）；
> `packages/desktop/dist/control-plane` 靠手工重建才生效。本轮仅这两者获"存在但缺当前标记 ⇒ 失败"守卫，其余陈旧无人发现。
> 本文只记未实现守卫与优先级；已落地守卫（control-plane/gateway标记守卫 + G1测试接线闭包门禁 `verify:test-wiring`，2026-12起挂 `check:static`）
> 与两条覆盖空洞见 `docs/progress/STATUS.md`（design 21 §7）。想法清单非承诺；落地后按 `docs/progress/README.md` 移出。

## 1. 产物清单（2026-12 普查）

|产物|生成者|提交？|当前守卫|陈旧后果|
|---|---|---|---|---|
|`packages/desktop/dist/web/**`|renderer `build`（vite `build.outDir = ../desktop/dist/web`，三处路径契约见 `packages/desktop/scripts/electron-shared.mjs`）|忽略|只有路径契约文本断言（`scripts/electron-shared.test.mjs`）|打包发行旧前端壳（IPC名/槽位可能漂移）|
|`packages/desktop/dist/preload.cjs`|`scripts/build-preload.mjs`（先emit临时目录、再只搬该文件）|忽略|无（`scripts/electron-dev.mjs` 缺文件才补建）|打包发行旧preload——IPC/trust边界与src漂移|
|`packages/desktop/dist/control-plane/**`|`scripts/build-control-plane.mjs`|忽略|✅ 标记守卫（`scripts/control-plane-freshness.test.mjs`：缺当前标记 ⇒ 失败 + 重建命令）|打包app加载旧控制面（本轮实际发生）|
|`packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`|`scripts/build-host-graph-package.mjs`（各seed包 `dist` cpSync）|忽略|只有行序/outDir断言（`scripts/release/packaging-manifest-lockstep.test.mjs`，原 build-host-graph-package 断言已并入）|打包seed旧宿主包|
|`packages/gateway/dist/**`（含 `dist/pnpm/**`）|`packages/gateway/scripts/build.mjs`|忽略|✅ 标记守卫 + 内嵌pnpm版本/pin断言（`packages/gateway/test/packaging/build-smoke.test.ts`）|打包gateway旧服务端（本轮实际发生）|
|`packages/gateway/host-packages/dsh-chamber-client-ui-mobile/**`|`packages/gateway/scripts/build.mjs`（`HOST_PACKAGES` 拷贝）|忽略|只有存在性/导出契约断言（缺文件才按需构建）|gateway seed旧移动端（`lib/client.js` 旧DOM锚点）|
|seed包 `dist/index.js` ×4 + `packages/dsh-runtime/dist/index.js` + mobile `dist/index.js`/`lib/**`|各自 `scripts/build.mjs`|提交|✅ C8重建-比对（`scripts/upstream/verify-upstream-touchpoints.mjs`，硬失败）|已由门禁挡住|
|`packages/renderer/src/generated/**`、`packages/renderer/.cache/**`|gen-typert/构建|忽略|构建期重新生成|构建失败或旧remote契约|
|`packages/desktop/vendor/dsh/**`（运行时线）|`bundle:dsh`/`scripts/upstream/update-vendor.mjs`|lockfile提交、树忽略|C10/C11 + release preflight|运行时线漂移（已有门）|

`dist/` 整族在 `.gitignore`：干净checkout的"缺失"是正常态（守卫按需构建）；要防的是本地/打包态的"存在但陈旧"——CI每次全新构建，看不到这一类。

> 表中 `scripts/*` 指 `packages/desktop/scripts/*`（Electron构建脚本；gateway侧 `packages/gateway/scripts/*`），非仓库根 `scripts/`。

## 2. 最小守卫建议（P0–P2）

### P0（成本低、直接堵本轮漏洞）

- G2产物新鲜度双边登记表：产物 ↔ 生成者 ↔ 守卫或豁免一张表，门禁断言每个产物都有守卫或显式豁免（§1全部）。成本低–中（表 + 纯函数）；收益：把"没有守卫"变成显式登记，杜绝静默。
- G4 preload重建比对：`scripts/build-preload.mjs` 先emit临时目录，追加"与 `dist/preload.cjs` 字节比较"（或复编后diff），挂desktop套件（`dist/preload.cjs` 是IPC/trust边界、当前零守卫）。成本低（tsc秒级）；收益：漂移本地即红，不等打包态暴露。
- G8豁免表：不需要守卫的产物（每次构建全新、或已由C8/门禁覆盖）显式记理由（§1全部）。成本低；收益：防止G2表被"全部豁免"掏空——豁免也要有人签。

### P1（补强，覆盖剩余产物）

- **G3 `.build-manifest.json` 输入摘要**：构建时写 `{inputsHash, toolVersion, outputs[]}`，测试比对；比标记串强——无文案产物（web/host-package/preload）也能判。适用全部忽略态产物。成本中（每构建脚本一处 + 比对函数）；收益：不依赖"改文案时手工搬标记串"。
- **G5 `before-pack` 打包前兜底**：既有 `scripts/before-pack.mjs` 断言 `dist/web`、`preload.cjs`、`host-*-package`、`control-plane` 存在且不早于其输入（mtime兜底；fresh checkout缺失另判）。适用打包闭包。成本低；收益：开发机没跑测试也不把陈旧产物打进包。
- **G6 host-*-package ↔ seed dist字节相等**：断言desktop四份拷贝 == 各seed包 `dist/index.js`（构建期cpSync，字节相等即可判）；适用 `dist/host-*-package/**`。成本低；收益：seed重建后忘 `build:host-packages` 立刻红。

### P2（纪律/长尾）

- G7 vendor allowBuilds锁步：断言根 `pnpm-workspace.yaml` 的 `allowBuilds` 与 `packages/dsh-runtime/src/allow-builds.mjs` 的 `ALLOW_BUILDS`/`DENY_BUILDS` 镜像关系（哪些chamber树显式false、哪些交运行时树）；适用 `vendor/harness-packages` 安装期脚本。成本低；收益：AGENTS已列为硬事实、当前只靠人工同步——新增原生依赖漏登或漏deny会静默漂移。

## 3. 开放问题

- 标记串（现状）vs输入摘要（G3）：标记串便宜可读，但每次改文案要同步移动；两者并存是否值得。
- 失败信息**必须**给重建命令（现有两条守卫已如此），否则操作者只看到红、不知下一步。
- CI腿的边界：CI每次全新构建，"陈旧"只在本地/打包态出现——要真覆盖得在打包作业跑G5，而非push腿追加构建。
- smoke无PASS腿（见STATUS单列条）：是否在release作业装一次真实dsh运行时跑冒烟；不在本清单范围内。
