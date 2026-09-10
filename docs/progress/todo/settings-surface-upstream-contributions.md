# todo · 设置面的上游声明式贡献通道（T3 提案）

> 状态：**上游提案，未排期**。记录于 2026-12。伴随落地面 = chamber 侧「图驱动的
> 每来源设置贡献集」（design 05 §5 / design 09 §5，2026-12 已落地）；本文只记录
> **需要上游 dsh 提供、chamber 无法自建**的那部分。

## 动机

chamber 桌面设置壳把「某来源自己的设置贡献」做成**图驱动**：读该实例的
`clientGraph/graph`，把非 covered 行的客户端插件装载进该来源的 settings child
context（design 05 §5 2026-12 修订）。这条路径有两个由上游形态决定的硬边界：

1. **贡献是代码，不是数据**：`dsh.client` 清单只有 `inject` / `platform`
   （vendor `dsh-client-modules` `manifest.ts`），没有 `contributes.*` 描述符。
   于是任何重宿主面（chamber 设置壳、未来的其他宿主）**必须实例化插件**才能知道
   它贡献了什么，无法事先判断、无法按需装载。
2. **没有设置面服务契约**：child context 只能提供 settings 面所需的最小服务集
   （`slots` / `locale` / `theme` / `settingsScope` / 六个 unary Remote 命名空间）。
   插件的 root `inject` 一旦包含会话族服务（`sessions` / `uiConversation` …），它
   就永远不激活——chamber 侧只能把它记为 `inactive` 并列出缺失服务
   （`settings-extensions.ts` `missingInjectNames`），用户看不到它的设置。
3. **泛型 Remote 客户端不可行**：客户端 Remote 贡献由**生成物**提供
   （`TypertRemoteContribution`），`TypertLocalRegistry/RemoteRegistry.list()` 是
   进程内注册表；协议类型与 api-gateway 客户端中**未见 descriptor 上线通道**
   （2026-12 调研，`dsh-typert-protocol/src/types.ts`、`packages/dsh-api-gateway/src/client/`）。
   因此 child context 的 `remote` 只能是手工面：插件调用其他命名空间会在**调用时**
   失败（被 entry boundary 与 `onEntryError` 捕获并报告，不会静默）。

## 提议（三条，按价值排序）

### P1 `dsh.client.contributes.settings` 声明式贡献描述符

在包清单里声明"我在哪些设置座位贡献什么"，例如：

```jsonc
"dsh": {
  "client": {
    "platform": "web",
    "contributes": {
      "settings": {
        "sections": [{ "id": "my-section", "order": 40, "label": "my-plugin.nav" }],
        "seats": ["settings.general.item"],
        // 声明运行设置面所需的最小服务集（见 P2）
        "requires": ["settingsScope", "locale"]
      }
    }
  }
}
```

价值：

- 重宿主面可以**先读清单再决定装载**（按需装载、按座位过滤、无需实例化即可展示
  "该插件有设置"的占位与来源标记）；
- `requires` 让宿主可以**事前**判断某个插件能否在当前能力面激活，而不是等 fiber
  停在 PENDING 再猜（chamber 现状即后者）；
- 为将来的 **schema 驱动渲染**（无 UI 代码的纯声明式设置）铺路。

### P2 设置面服务契约（最小可注入集合）

为"重宿主设置面"定义并文档化一个**稳定服务子集**（例如 `settingsScope` /
`settingsSchema` / `locale` / `theme` / `remote.settings` / `remote.credentials` /
`remote.llm` / `remote.pluginInventory`），并允许插件在清单里声明自己只依赖该子集
（"settings-surface-safe"）。价值：插件作者知道写什么能跨宿主工作；宿主知道哪些插件
可安全实例化。chamber 侧现在把这套契约写在 design 09 §5（作者契约），但**没有机器可
读的声明**。

### P3 Remote descriptor 上线通道（或"设置面 Remote 子集"协议）

若 typert 能在握手时下发 descriptor 目录（或提供一个只读 `typert/describe`），重宿主面
就能构造**泛型 Remote 客户端**，让第三方插件调用任意命名空间而不必依赖宿主内置的生成物
副本。价值：保真天花板从"手工面"抬到"全命名空间"。代价：协议面扩张 + 权限模型
（哪些命名空间允许被重宿主面调用）需要上游设计。

## 开放问题

- `contributes.settings` 与运行时 `slots.register` 的**一致性校验**：声明与实际注册
  不符时谁报错（建议宿主侧报诊断，不阻断）。
- 描述符的**版本兼容**：清单里的座位名/schema 与宿主 SlotMap 版本漂移时如何降级。
- 权限：重宿主面实例化第三方插件代码的信任边界（chamber 现状：design 09 §4 已声明
  远端实例的 client bundle 在本地渲染器执行；本提案不改变该边界，只是让它更可控）。
- P3 若落地，chamber 的 `remote` stub 应替换为泛型面，`CAPABILITY_REMOTE_EVENTS`
  这类能力降级报告随之收敛。
