# 产物新鲜度守卫（G2–G8；未排期）

> 由 2026-12 复核的产物普查得来：`packages/gateway/dist` 曾长期带着旧一轮的受保护集合判定器
> （`src` 已修、`dist` 未重建，打包态才暴露），同一轮里 `packages/desktop/dist/control-plane` 也靠手工
> 重建才生效。本轮只给这两个产物加了"存在但缺当前标记 ⇒ 失败"的守卫，其余产物的陈旧仍无人发现。
> 本文只记**未实现**的守卫想法与优先级；已落地的守卫（control-plane / gateway 标记守卫 +
> G1 测试接线闭包门禁 `verify:test-wiring`，2026-12 起挂 `check:static`）与两条真实覆盖空洞见
> `docs/progress/STATUS.md`（design 21 §7 有指针）。**这是想法清单，不是承诺**；落地后按
> `docs/progress/README.md` 的纪律移出本表。

## 1. 产物清单（2026-12 普查）

| 产物 | 生成者 | 提交？ | 当前守卫 | 陈旧后果 |
|---|---|---|---|---|
| `packages/desktop/dist/web/**` | renderer `build`（vite `build.outDir = ../desktop/dist/web`，`packages/desktop/scripts/electron-shared.mjs` 记录三处路径契约） | 忽略 | 只有路径契约**文本**断言（`scripts/electron-shared.test.mjs`） | 打包发行上一版前端壳（IPC 名/槽位可能与 preload 漂移） |
| `packages/desktop/dist/preload.cjs` | `scripts/build-preload.mjs`（先 emit 到临时目录再只搬入该文件） | 忽略 | 无（`scripts/electron-dev.mjs` 缺文件才补建） | 打包发行旧 preload —— IPC/trust 边界与 src 漂移 |
| `packages/desktop/dist/control-plane/**` | `scripts/build-control-plane.mjs` | 忽略 | ✅ **标记守卫**（`scripts/control-plane-freshness.test.mjs`：存在但缺当前标记 ⇒ 失败 + 重建命令） | 打包 app 加载旧控制面（本轮实际发生过） |
| `packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**` | `scripts/build-host-graph-package.mjs`（从各 seed 包 `dist` cpSync） | 忽略 | 只有行序/outDir 断言（`scripts/build-host-graph-package.test.mjs`） | 打包 seed 旧宿主包 |
| `packages/gateway/dist/**`（含 `dist/pnpm/**`） | `packages/gateway/scripts/build.mjs` | 忽略 | ✅ **标记守卫** + 内嵌 pnpm 版本/pin 断言（`packages/gateway/test/packaging/build-smoke.test.ts`） | 打包 gateway 旧服务端（本轮实际发生过） |
| `packages/gateway/host-packages/dsh-chamber-client-ui-mobile/**` | `packages/gateway/scripts/build.mjs`（`HOST_PACKAGES` 拷贝） | 忽略 | 只有存在性/导出契约断言（缺文件才按需构建） | gateway seed 旧移动端（`lib/client.js` 旧 DOM 锚点） |
| seed 包 `dist/index.js` ×4 + `packages/dsh-runtime/dist/index.js` + mobile `dist/index.js`/`lib/**` | 各自 `scripts/build.mjs` | **提交** | ✅ C8 重建-比对（`scripts/upstream/verify-upstream-touchpoints.mjs`，硬失败） | 已由门禁挡住 |
| `packages/renderer/src/generated/**`、`packages/renderer/.cache/**` | gen-typert / 构建 | 忽略 | 构建期重新生成 | 构建失败或旧 remote 契约 |
| `packages/desktop/vendor/dsh/**`（运行时线） | `bundle:dsh` / `scripts/upstream/update-vendor.mjs` | lockfile 提交、树忽略 | C10/C11 + release preflight | 运行时线漂移（已有门） |

`dist/` 整族在 `.gitignore`：干净 checkout 里"缺失"是正常态（守卫因此按需构建），
**本地/打包态的"存在但陈旧"才是要防的**——CI 每次全新构建，天然看不到这一类。

> 表中 `scripts/*` 指 `packages/desktop/scripts/*`（Electron 构建脚本；gateway 侧为
> `packages/gateway/scripts/*`），不是仓库根的 `scripts/`。

## 2. 最小守卫建议（P0–P2）

### P0（成本低、直接堵本轮漏洞）

- **G2 产物新鲜度双边登记表**：一张表（产物 ↔ 生成者 ↔ 守卫或豁免），门禁断言表里每个产物都有守卫或
  显式豁免。适用产物：§1 全部。成本：低–中（表 + 纯函数）。收益：把"没有守卫"变成显式登记，杜绝静默。
- **G4 preload 重建比对**：`scripts/build-preload.mjs` 本就先 emit 到临时目录，追加"与 `dist/preload.cjs`
  字节比较"（或复编后 diff），挂 desktop 套件。适用产物：`dist/preload.cjs`（IPC/trust 边界，当前零守卫）。
  成本：低（tsc 编译秒级）。收益：preload 漂移在本地即红，不再等打包态暴露。
- **G8 豁免表**：对确实不需要守卫的产物（每次构建全新、或已由 C8/门禁覆盖）显式记理由。
  适用产物：§1 全部。成本：低。收益：防止 G2 表被"全部豁免"掏空——豁免同样要有人签。

### P1（补强，覆盖剩余产物）

- **G3 `.build-manifest.json` 输入摘要**：构建时写 `{inputsHash, toolVersion, outputs[]}`，测试比对；
  比标记串更强——无运营文案的产物（web / host-package / preload）也能判。适用产物：全部忽略态产物。
  成本：中（每个构建脚本写一处 + 一个比对函数）。收益：不依赖"改文案时手工搬标记串"的纪律。
- **G5 `before-pack` 打包前兜底**：在既有 `scripts/before-pack.mjs` 里断言 `dist/web`、`preload.cjs`、
  `host-*-package`、`control-plane` **存在且不早于其输入**（mtime 兜底；fresh checkout 的缺失另判）。
  适用产物：打包闭包。成本：低。收益：开发机没跑测试也不会把陈旧产物打进包。
- **G6 host-*-package ↔ seed dist 字节相等**：断言 desktop 里的四份拷贝 == 各 seed 包 `dist/index.js`
  （拷贝是构建期 cpSync，字节相等即可判）。适用产物：`dist/host-*-package/**`。成本：低。
  收益：seed 重建后忘了 `build:host-packages` 立刻红。

### P2（纪律/长尾）

- **G7 vendor allowBuilds 锁步**：断言根 `pnpm-workspace.yaml` 的 `allowBuilds` 与
  `packages/dsh-runtime/src/allow-builds.mjs` 的 `ALLOW_BUILDS`/`DENY_BUILDS` 的镜像关系
  （哪些是 chamber 树显式 false、哪些交给运行时树）。适用产物：`vendor/harness-packages` 的安装期脚本。
  成本：低。收益：AGENTS 已把它列为硬事实、当前只靠人工同步——新增原生依赖漏登或漏 deny 会静默漂移。

## 3. 开放问题

- **标记串（现状）vs 输入摘要（G3）**：标记串便宜、可读，但要求每次改文案时同步移动；两者并存是否值得。
- **失败信息必须给重建命令**（现有两条守卫已如此），否则操作者只看到红、不知道下一步。
- **CI 腿的边界**：CI 每次全新构建，"陈旧"只在本地/打包态出现——要真覆盖得在打包作业里跑 G5，
  而不是在 push 腿追加更多构建。
- **smoke 无 PASS 腿**（见 STATUS 单列条）：是否在 release 作业里装一次真实 dsh 运行时跑冒烟；
  不在本清单范围内。
