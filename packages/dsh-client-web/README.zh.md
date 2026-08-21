# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

Web 外壳内核：`new AppWebEntry(container, options?).run()` 通过两阶段启动（rc.2 形态）挂载整个客户端。第一阶段（模块侧）：收编（或安装）共享客户端模块系统（`@deepseek-ai/dsh-client-modules`，经 `window.__ModuleLoader__` bootstrap facade 构建），以主机推送的配置项图（`window.__DSH_BOOT__`）为基础，并行预取 `immediately` 层级；执行组合包只会注册 factory。第二阶段（插件侧）：挂载仓库内置的 Cordis Loader，并通过其 `internal` 约定注入模块系统；为每一行图数据创建一个 loader 配置项（tree.import 会物化各模块）；等待完全停稳后审计激活状态，再经 `uiRenderer` 服务挂载真实 UI（rc.2 渲染器行——此处由内核收编）。加载页无框架（`boot-page.ts`）。组合完全由主机图决定：花名册和 immediately 层级都位于负责组合的应用中；外壳不作任何组合决策。

外壳自给自足（web2 硬性规则）：内核除两个 bootstrap 身份外不对任何插件包执行值导入——modules 包（`@deepseek-ai/dsh-client-modules`，模块系统不能经由自身抵达）与 ui-renderer 包（`@deepseek-ai/dsh-client-ui-renderer`，rc.8 把渲染器移出外壳；chamber 内核收编其 client half，挂载与后端版本无关）。其余全部作为 loader 行抵达。

`PLATFORM_MODULES`（src/platform.ts）是共享模块接口的唯一真源：种子表 key、tsdown 客户端 external 和 vite alias 集都是它的投影。

可选的覆盖参数 `options` 会为外部 `<script>` 执行无法到达页面上下文的环境转发模块系统的 `loadBundle` 传输覆盖（`BootSeams`），另含 chamber 补丁的每实例 `extraRows`（宿主图客户端插件行合并进 boot rows；bundle 由 chamber 外壳预加载，其激活失败降级而非让 boot 失败——版本容忍）。

浏览器标题投影已随应用移至 ui-renderer 行（rc.8）；chamber 桌面壳本就冻结原生标题栏。

## 模型体验

无。入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **有意采用一次性渲染**：UI 等待启动 settle；只要一个配置项失败，加载页面就会保留并逐项显示醒目的报告，不提供部分可用性（渐进式渲染将作为独立项目恢复）。
- **窄窗口外壳行为缺少组装后演练**：ui-layout 已实现让步链，但该包没有外壳级窄视口验收用例。
