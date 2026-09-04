# @dsh-chamber/dsh-client-ui-mobile

Chamber 移动端适配插件（design 17 §18）：让官方 dsh Web 前端在手机浏览器（经
gateway 访问）真正可用——窄屏抽屉化布局、触控目标、安全区、PWA 分期。

> 唯一随 gateway 发行物打包 seed 的 chamber 客户端插件（§3 装配矩阵移动例外；
> 链路无桌面，不参与 `/chamber/plugins` 桌面同步）。

## 结构

- `src/index.ts` —— 宿主半空入口（seed gate 需要 `dist/index.js`）；
- `src/client/index.ts` —— 浏览器半：assets 注入（viewport/stylesheet）、
  frame + 会话头打标、layoutFacts 驱动的抽屉滚动锁、composer 行为、
  抽屉点击自愈、`shell.overlay` 汉堡按钮；
- `src/client/styles.ts` —— 单文件样式（全部媒体查询作用域，桌面零影响）；
- `src/client/markup.ts` / `composer.ts` / `layout-facts.ts` /
  `drawer-taps.ts` —— 纯逻辑（可单测）；
- `scripts/build.mjs` —— esbuild 两半构建（`dist/index.js` + `lib/client.js`）。

## 会话头部适配（触屏档）

会话头（`conversation.session.header` 出口——官方标题/面包屑行）是桌面宽度
的 chrome，与移动面在三个轴向上冲突，全部以结构化选择器覆盖（不猜哈希类名）：

- **汉堡重叠**：浮动汉堡（左上 44px）压在头部内容上——头部预留左侧 gutter
  （`padding-left`）；
- **面包屑被裁**：官方 crumbs 行 nowrap + overflow hidden，长标题链与
  谱系 chip（「N 个子代理」目录触发器）会被静默截断——改为换行而非裁切
  （单段省略号保留）；
- **「Session 日志」导出胶囊**（官方 `session-log-export`，header
  utilities）：≥111px 的药丸在手机上吃满整行标题，而移动端基本不会导出——
  手机档收成 44px 圆形图标目标。胶囊无稳定属性，markup.ts 在会话头挂载时
  按官方双语文案 + 下载图标结构打标
  （`data-mobile-dismiss="session-log-export"`；幂等、剪枝搜索——聊天滚动体
  永不被遍历）。

## 抽屉点击与键盘（触屏档）

- **点击自愈**（`drawer-taps.ts`）：iOS Safari 会抑制抽屉内点击的合成
  click（hover 展开令命中行位移），单击会话行此前无反应——稳定点击后若真实
  click 在 120ms 宽限内未到达，自愈从 pointerup 目标重发一个非受信 click；
  React 委托的行处理器照常执行，单击即可切换。自愈后 150ms 内同坐标到达的
  受信 click 视为迟到的真实 click 被抑制（不双重激活）；起点按 pointerId
  分别跟踪（多点触控安全、响应 pointercancel）。平移/滚动意图（超出 slop
  的位移）、表单控件（含任意非 false 态 contenteditable）、抽屉之外一律
  不触发；桌面路径不受影响（仅 touch/pen + 触屏档门禁）。
- **抽屉导航不再拉起键盘**：官方 composer 会在会话切换后把焦点还给输入框，
  在 iOS 上等于切换后立刻弹键盘——IME 阶梯 layer-1 的 gesture 判定现在只在
  手势起始于**导航区**（抽屉会话行、会话头面包屑）时丢弃程序化回焦；点输入
  框、发送键、鼠标/硬键盘聚焦以及 portal 型选择器流程（工作区/代理预设菜单）
  仍保留键盘与输入意图。

## 设置页适配（手机档）

官方设置壳（`ui-settings-general` 的 `sidebar.settings` 座——gateway/移动
链上的唯一设置面；chamber settings-bridge 与官方 settings document 均仅桌面）
是 800px 的 flex-row 弹窗：固定 188px 竖排 nav + 内容列。手机档规则以结构
锚点（slot/role）重排：

- **纵向堆叠全屏 sheet**：panel 改 `flex-direction: column`；nav rail 变
  顶部横条——标题 + **可横向滚动的分区 chips**（44px 触控目标，顶部安全区）；
- **chrome 固定、选项区滚动**：内容列 header（actions + Close）不再随内容
  滚走——只有分区 options 区滚动（底部安全区补边）；
- **分区内网格降级**：Models 的 provider 行（两输入 + 两图标一行的 4 列
  grid）降为 2×2；Plugins inventory 两列卡片网格降为单列。官方内部格子无
  稳定属性，这两条使用文档化的哈希不敏感 `[class*="_<local>_"]`
  例外（生产命名为 `_<local>_<hash>_<idx>`；命名翻转时 fail-soft——保持
  官方网格）；
- **其他 `aria-modal` 弹层**（引导步骤、选择器）限宽 `100vw - 24px`
  （设置 sheet 本身已占满全屏）；
- **iOS 聚焦缩放**：弹窗内可编辑字段套用 composer 同款 16px 底线
  （`max(16px, var(--dsh-content-font-size, 16px))`）。

平板（触屏档 >768px）保留桌面弹窗几何——只有手机档用堆叠 sheet。

## 构建 / 测试

```sh
pnpm --filter @dsh-chamber/dsh-client-ui-mobile run build
pnpm run typecheck:mobile
pnpm run test:mobile
```

## 锚点基线

官方 dsh **v0.1.2-alpha.4** DOM 实测（CDP 审计；ui-layout AppFrame 与 alpha.3
pin 逐字节一致，alpha.4 锚点审计，harness pin 4e84901e）：`data-sidebar-collapsed`
折叠=存在/展开=移除；composer 为
Lexical `[data-composer-input]`（无 textarea）；设置对话框渲染在侧边栏 DOM 内（无 body portal），
抽屉打开态必须用 `transform: none`（identity transform 仍是 containing block）。
details 列壳自首帧常驻、其 `[data-slot=details]` 出口按会话门控——出口挂载时打标
重触发（markup.ts `isStructuralTarget`）。
