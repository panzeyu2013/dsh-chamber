# @dsh-chamber/dsh-client-ui-mobile

Chamber 移动端适配插件（design 17 §18）：让官方 dsh Web 前端在手机浏览器（经
gateway 访问）真正可用——窄屏抽屉化布局、触控目标、安全区、PWA 分期。

> 唯一随 gateway 发行物打包 seed 的 chamber 客户端插件（§3 装配矩阵移动例外；
> 链路无桌面，不参与 `/chamber/plugins` 桌面同步）。

## 结构

- `src/index.ts` —— 宿主半空入口（seed gate 需要 `dist/index.js`）；
- `src/client/index.ts` —— 浏览器半：assets 注入（viewport/stylesheet）、
  frame 打标、layoutFacts 驱动的抽屉滚动锁、composer 行为、`shell.overlay`
  汉堡按钮；
- `src/client/styles.ts` —— 单文件样式（全部媒体查询作用域，桌面零影响）；
- `src/client/markup.ts` / `composer.ts` —— 纯逻辑（可单测）；
- `scripts/build.mjs` —— esbuild 两半构建（`dist/index.js` + `lib/client.js`）。

## 构建 / 测试

```sh
pnpm --filter @dsh-chamber/dsh-client-ui-mobile run build
pnpm run typecheck:mobile
pnpm run test:mobile
```

## 锚点基线

官方 dsh **v0.1.2-alpha.3**（harness.commit=dd6322d6）DOM 实测（CDP 审计，
2026-12）：`data-sidebar-collapsed` 折叠=存在/展开=移除；composer 为
Lexical `[data-composer-input]`（无 textarea）；设置对话框渲染在侧边栏 DOM 内（无 body portal），
抽屉打开态必须用 `transform: none`（identity transform 仍是 containing block）。
