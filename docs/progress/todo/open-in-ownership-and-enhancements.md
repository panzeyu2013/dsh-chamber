# todo · open-in：超集分批与实机验收

> 状态：**fork & supersede 已落地**（2026-09-11 用户裁决 → design 20 定稿 → 本轮实施完成）。
> 契约与落地形态见 `docs/design/20-open-in-registry.md`（§4 契约、§6 host 包与八处接线、
> §8 文件清单、§9 验证门）。本表只保留**尚未做**的部分。

## 1. 实机验收（本仓无法自证，必须在真机跑）

契约与单测都不覆盖"宿主机上真的发生了什么"，以下每条都要在 macOS 实机上过一遍：

1. **本地等价目录**：header 按钮出现官方同款应用清单（Finder / Terminal / iTerm / Cursor / …），
   顺序与预期一致，下拉可用键盘操作（roving tabindex / Escape 回 trigger）；
2. **真实图标**：抽取的 PNG 与系统里该应用的实际图标一致（含 JetBrains 家族、非 ASCII 应用名），
   缓存命中后不再重复请求（Network 面板确认 `openInApp/icon` 每 id 只发一次）；
3. **实际拉起**：Finder / Terminal / iTerm / Cursor / VS Code 逐个点名拉起成功且落到工作区目录；
   `DSH_PERMISSION_MODE=workspace-write` 不拦（预期不受影响，需实测确认）；
4. **无应用环境**：干净容器 / headless Linux 下目录为空 ⇒ 按钮诚实隐藏（不是空下拉、不是报错）；
5. **远程来源**：ssh 目标只有 VS Code（新窗口/复用两态都与既有深链语义一致），
   且**不出现**本地目录项（`source-not-local` 抑制在真机上生效）；图标必须与本地来源的
   VS Code 逐像素相同（同一个页级机器目录，design 20 §4.2/§5），且本机**没有**装 VS Code 时
   该条目整体不渲染；
6. **插件管理页**：本地目标显示该行已注入；ssh/gateway/http 目标显示"本地形态专用"
   （绝不是"未注入"），且远端 `~/.dsh` 下**没有**该包的目录与 loader 行；
7. **N-ctx 混合渲染**：本地 + 远程 + gateway 三种 ctx 同页时，按钮的图标/菜单/记忆互不串台；
8. **打包态回归**：`dist/host-open-in-package` 随包发布且本地实例能 seed 成功（asar 内路径口径）；
9. **两代 runtime**：内置 0.1.2-rc.1 与 pin 0.1.5-rc.2 各起一次本地实例，
   确认 seed 行装载 + `openInApp/probe` 探针绿（**这是当前最大的未验证风险**，见 §2）。

## 2. 待验证（实施后仍有开放项）

- **`ctx.subprocess` 在旧 runtime 的 web profile 是否挂载**：本包 `static inject = ['subprocess']`，
  而 control-plane 把"产物在但加载失败"视为打包缺陷（刻意不跳过）⇒ 若旧 runtime 的 web profile
  没有该服务，该实例 boot 会失败。**先跑装载探针再接第二台 runtime**；
- 机器目录的 base64 体积/CSP 实测（2026-09-12 起图标由**页级机器目录**读一次、每 id 一次，
  见 design 20 §4.2：要量的是"一页一份目录 + N 个图标"，含远来源同页时的实际开销）；
- Windows 盘符/UNC 路径在 host 侧 `isAbsolute`/`isDirectory` 口径下的行为（design 23）；
- 第三方编辑器 URL scheme 语义（Cursor / Windsurf / JetBrains Gateway / Insiders）逐个人工验证
  —— S1 的前置条件；
- 上游升级时本 fork 的折入流程：`FORKS` 表的 `versionAnchor: 'chamber'` 豁免 + C1/C3
  在真实升级 commit 上的可执行性，以及 `patched` 原因是否足够指导重锚。

## 3. 超集分批（S1/S2 待排期；S3 收窄为「复制路径」；S4 不做）

每批独立 PR 粒度、每批带自己的测试、**不引入新运行时依赖**：

2026-09-11 复核结论（原 S1–S4 四批，重排优先级并收窄）：

- **S1 远程 provider 家族**：主进程注册表加 Insiders / Cursor / Windsurf / JetBrains Gateway /
  `ssh://` 终端 —— 每个 provider 只"构造 URL 交 OS"，不启动进程；每个新增项需一次实机 scheme
  语义验证（本机目前只注册了 `Visual Studio Code → ['vscode']` 与 `iTerm → […,'ssh',…]`）；
- **S2 远程文件级打开**：远程来源允许文件路径（纯 URL 构造，不经 host 包）；本地仍**目录限定**；
- **S3 收窄为"复制路径"**（唯一保留的非启动出口）：在侧栏既有的复制模式上暴露工作区/会话路径
  —— 会话行数据已带 `cwd`（`sidebar/src/shared/instance-api.ts` 的 `SessionRow.cwd?`），
  侧栏既有的 `HoverCard` 已支持 `copyText`（今天只复制会话标题，
  `ServerSection.tsx:2046`；该行的 `HoverCard` 本体 `:2027`），因此**零新 IPC、零新依赖、
  纯渲染层**；
  "复制 `ssh user@host` / 复制 VS Code 深链"**不做**（形态见 §5 附录 A，若日后需要照此实施）；
- **S4 多入口：不做**（2026-09-11 裁决，理由登记在 STATUS）：header 按钮与目标会话同排相邻，
  侧栏入口边际价值有限；会话行的动作**已集中在一个 kebab 菜单里**（重命名/分叉/归档，
  `ServerSection.tsx:1952-1977`；2026-09-11 T2a 起归档也在此菜单内），故"新增侧栏入口"
  要么与该菜单重复、要么推翻它——**不要把"会话行刻意没有 kebab"当作理由**
  （2026-09-11 review-fix 更正：该行自 T2a 起就有 kebab，旧句引的
  `ServerSection.tsx:1188,1305` 也早已漂移；今天刻意无 kebab 的是 **worktree 派生的
  workspace 行**，`ServerSection.tsx:1288-1290`）；快捷键缺基建
  （vendor 无 keybinding 注册表，只有聊天输入框自己的 keymap），自建 document 级监听还要处理
  "哪个 entry 是活跃视图"与 chord 冲突。若日后要做，形态见 §5 附录 B。

四批的共同纪律不变：每批独立 PR 粒度、每批带自己的测试、不引入新运行时依赖。

## 4. 边界（不做，登记在 design 20 §7.3）

- 远端宿主侧打开（需要 ssh/http cookie 注入 + UI 明示，与"远程只用 vscode 部分"的契约冲突）；
- fork 官方 catalog 再扩**本地**应用集合之外的本地执行面（例如"在终端里打开"的本地实现）；
- 主进程自行枚举本机应用（重开 Batch 3 Phase 2 关闭的红线）。

## 5. 附录：S3 完整形态与 S4 形态（降级留档，未排期）

> 保留 2026-09-11 复核时做的代码调研结论，供日后需要时直接实施，不必重新摸底。
> 现状证据（复核时实测）：全仓 chamber 代码 `navigator.clipboard` / `writeText` **零调用者**
> （`main.ts:5699-5713` 只是放行了 `clipboard-sanitized-write` 权限）；`execCommand('copy')`
> 仅出现在 gateway 的独立安装页（`gateway/src/routes.ts:960`；行号随
> 2026-09-11 review-fix 的确认对话框改动下移，原 `:730`）；上游官方客户端只有一处槽位注册
> （`conversation.session.header.utilities`，id `open-in-app`，order -10），无剪贴板、无"无可用
> 应用"出口（`controller.ts:39`：读取失败 ⇒ 空列表 ⇒ 完全不渲染按钮）⇒ **S3/S4 都是新增能力，
> 不是"官方有而我们缺"**。

### 附录 A · S3 全量形态（若要做"复制 ssh 命令 / 复制深链"）

- 事实面：渲染层**拿不到** ssh 目标 —— `ChamberServerAggregate`（`sidebar/shared/aggregate-store.ts`）
  只有 `id/rawId/kind/transport/label`，无 host/user/port；per-entry ctx 只有
  instance id / transport / basePath / fingerprint。`ssh user@host` 与
  `vscode://vscode-remote/ssh-remote+<host><path>` 的构造都只在主进程
  （`deep-link.ts` 的 `buildVscodeRemoteUrl`）。
- 因此正确形态是**在既有 open-in IPC 面上加一个只返回文本的方法**，而不是把 host/user/port
  抛给渲染层再拼 URL（那会造出第二份 URI 逻辑，违反"绝不手写平行副本"纪律）：
  `link({appId, instanceId, path, sourceFingerprint}) → {ok:true, kind:'url'|'ssh'|'path', text}`
  通道命名沿用 `ipc-events.ts` 的 `OPEN_IN_APPS` / `OPEN_IN` 族。
- 实现必须**原样复用** `runOpenInLaunch`（`desktop/open-in.ts:194+`）的前 5 步
  （appId 白名单 → instanceId 校验 → 路径校验（local Windows 感知 / remote POSIX）→
  remoteCapable 门 → 可用性复核），第 6 步从 `provider.open` 换成返回文本；并加一条测试断言
  "link 路径从不调用 provider.open"（零执行面）。`kind:'url'` 是否带 `newWindow` 参数需产品裁决
  （倾向不带）。
- 客户端：视图模型需要新增**第三类结局**（可复制的出口），门控按 reason 精细区分 ——
  有具体路径 + 该来源无法启动（`transport-not-ssh` / `unknown-source`）才出复制项，
  "本地实例坏了"仍必须隐藏；出口落在既有官方 `ui-primitives` `Menu`（2026-09-11
  upstream-alignment 后的现状：open-in 菜单 = `open/autoFocus/dense/selection="fill"/align="end"`
  + `items: MenuItem{id,label,icon}[]`，主按钮与 chevron 按钮组成 anchor；chamber 自有的
  `AccessibleAppMenu` 三件套已删除，只留 N-ctx 归属守卫
  `src/client/instance-view-guard.ts`）——复制项就是该 `items` 数组的一员，走同一个
  `onSelect` 分发与同一套可访问性语义，文案进本包自己的 typed 字典；剪贴板被拒时把文本
  显示成可选中输入框（不静默失败）。
- 验收：纯函数（reason→出口映射、门控不被放宽）；管线（link 与 launch 同一组拒绝分支）；
  IPC 面锁步（`ipc-surface-mirror`）；实机两条（粘贴结果、无应用来源下按钮位置）。

### 附录 B · S4 全量形态（若日后要做多入口）

- 现状：launch 面被关在 per-entry 的 `apply(ctx)` 内（经 `injected()` 交给 header 组件），
  插件外部无句柄；侧栏是**页级**插件，已有页级桥 `chamberBridge`
  （`sidebar/shared/aggregate-store.ts`，生产者是各 entry ctx）。
- 架构核心 = **per-entry 面注册表**：`publishOpenInFace(sourceId, face)` /
  `getOpenInFace(sourceId)`，在 `apply(ctx)` 发布、`ctx.effect` 卸载时撤销；面里带该 entry 的
  `sourceFingerprint`（精确启动证明永远绑定 entry，绝不读页面级"最新名册"）。
  落点二选一：**(a)** 侧栏既有 `sidebar/shared` 入口（本仓已有跨包导入先例，且带
  `assertSingletonModule` 单例纪律，倾向选它）；**(b)** open-in 包自己的页级入口
  （归属清晰，但新增"侧栏依赖功能插件"的包依赖方向）。
- 入口优先级：**① 工作区头 kebab**（`ServerSection.tsx:1613-1628` 的 workspace 行菜单 + `:1585`
  的 `+`「新建会话」已给出菜单与动作词汇，改动最小、不碰 parity）→ ② 会话行行菜单/右键
  （能力最有价值，但**会话行已有 kebab 菜单**——重命名/分叉/归档，2026-09-11 T2a 起归档
  也在此菜单内，`ServerSection.tsx:1952-1977`；故这里不是"新建菜单"，而是"复用该菜单或
  给它加手势"，加不加待产品裁决）→ ③ 快捷键（只对**活跃** entry 生效；不要每个 entry ctx
  各注册一个监听）。
- 无论哪条入口都必须复用同一组门（合并视图模型 ≥1 可用项；该行属于有具体路径的工作区），
  并走同一个客户端适配器 → `runOpenInLaunch` → provider，**不允许**侧栏另建直接 IPC 短路；
  报告语义与 header 一致。
- 验收：注册表发布/撤销/按 id 取用；门控（无路径、无可用项时菜单不出现）；
  一条"第二入口与 header 走同一适配器实例"的断言（防平行实现）；
  实机（菜单位置与拖拽手势不冲突、chord 不与输入框冲突、N-ctx 下只在活跃来源生效）。
