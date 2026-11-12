# office-skills（Office 技能资产目录）

本目录是上游 `@deepseek-ai/dsh-skill-office` 的 **4 个技能资产**（现行 pin 的资产面）在构建机上的落点，
与 `resources/primary-runtime` 平级；**只提交本说明文件**，资产由显式构建腿生成、不随仓库提交。

## 文件清单（整树缺一不可）

```
office/SKILL.md
office-docx/SKILL.md
office-pptx/SKILL.md
office-xlsx/SKILL.md
```

清单单源 = `packages/desktop/scripts/prepare-office-assets.mjs` 的 `OFFICE_SKILL_FILES`；上游改资产面时同批改清单、`startup-plugin-rows.ts` 的 `OFFICE_SKILL_NAMES` 门控与测试。

## 源（按顺序解析，第一个存在的目录胜出）

1. `vendor/harness-packages/@deepseek-ai/dsh-skill-office/assets`（pin 子模块的只读链接树）；
2. `vendor/harness-checkout/packages/skill/skill-office/assets`（源码/worktree 布局）。

## 命令

```sh
# 演练（不写盘）：
node packages/desktop/scripts/prepare-office-assets.mjs --dry-run
# 真实落位（逐文件 temp+rename 覆盖；保留本 README；清非期望顶层残留；写完自检）：
node packages/desktop/scripts/prepare-office-assets.mjs
# 完整性判定（清单文件全部在场；源可用时逐文件 sha256；打包后对 bundle 内路径复核同一命令）：
node packages/desktop/scripts/prepare-office-assets.mjs --verify packages/desktop/resources/office-skills
```

`--source <dir>` / `--out <dir>` 可显式指定源与落点（测试/排练用）；`--source` 缺失时
默认候选全缺会响亮失败并提示初始化 vendor 子模块。`--verify` 的源不可用（干净 checkout
未初始化 vendor）时降级为「清单文件在场」并打印提示。

## 消费方

- Swift 装配：`build:sidecar` 把本目录拷到 `<sidecar>/office-skills`（与
  `primary-runtime/` 平级），随 `build:swift-app` 进
  `Contents/Resources/sidecar/office-skills`；
- 控制面本地 spawn 的 `chamber-office-skills` 启动行以 `assetRoot` 指向同一目录
  （design 09/25；Swift 本地 flavor only）。
