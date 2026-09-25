# 第三方声明（Third-Party Notices）

dsh-chamber 重新分发以下第三方包。每个包的完整许可证文本位于其自身的
`node_modules` 下的 `LICENSE` 文件中。经 `npm run gen:notices` 生成。

| 包 | 版本 | 许可证 |
|---|---|---|
| `@electron/asar` | 3.2.1 | MIT |
| `@shikijs/langs` | 4.4.3 | MIT |
| `@tanstack/react-virtual` | 3.14.9 | MIT |
| `@types/node` | 26.2.0 | MIT |
| `@types/react` | 19.2.18 | MIT |
| `@types/react-dom` | 19.2.4 | MIT |
| `@types/ws` | 8.18.1 | MIT |
| `@vitejs/plugin-react` | 4.3.0 | MIT |
| `anser` | 2.3.5 | MIT |
| `clsx` | 2.1.1 | MIT |
| `diff` | 9.0.0 | BSD-3-Clause |
| `electron` | 43.4.0 | MIT |
| `electron-builder` | 26.15.3 | MIT |
| `electron-updater` | 6.8.9 | MIT |
| `immer` | 10.1.1 | MIT |
| `katex` | 0.16.47 | MIT |
| `mdast-util-from-markdown` | 2.0.3 | MIT |
| `mdast-util-gfm` | 3.1.0 | MIT |
| `mdast-util-math` | 3.0.0 | MIT |
| `micromark-core-commonmark` | 2.0.3 | MIT |
| `micromark-extension-gfm` | 3.0.0 | MIT |
| `micromark-extension-math` | 3.1.0 | MIT |
| `micromark-factory-space` | 2.0.1 | MIT |
| `micromark-util-character` | 2.1.1 | MIT |
| `micromark-util-classify-character` | 2.0.1 | MIT |
| `micromark-util-sanitize-uri` | 2.0.1 | MIT |
| `micromark-util-symbol` | 2.0.1 | MIT |
| `micromark-util-types` | 2.0.2 | MIT |
| `node-pty` | 1.1.0 | MIT |
| `pnpm` | 11.21.0 | MIT |
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `shiki` | 4.4.3 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `use-sync-external-store` | 1.2.0 | MIT |
| `vite` | 6.4.3 | MIT |
| `zod` | 4.4.3 | MIT |
| `zustand` | 4.4.7 | MIT |

## macOS 原生壳（SwiftPM / 打包资产）

| 包 | 版本 | 许可证 |
|---|---|---|
| `Sparkle` | 2.10.0 | MIT |

原生 DMG 的 Finder 背景资产 `macos/resources/dmg-background.tiff` 取自
`electron-builder` 的 `dmg-builder/templates/background.tiff`（MIT，
electron-userland/electron-builder；双 rep 540×380@72dpi + 1080×760@144dpi），
目的是让原生 DMG 与 Electron 腿的拖拽引导完全同款（2026-09）。

## 随包载荷（primary runtime：CPython / python 发行版 / Node.js）

| 构件 | 版本 | 许可证 |
|---|---|---|
| `CPython`（python-build-standalone） | 3.12.14 | PSF-2.0 |
| `pip`（解释器基线，随 CPython 分发） | 随 CPython | MIT |
| `Node.js` | 24.18.1 | MIT |
| `et_xmlfile`（python 发行版） | 2.0.0 | 见随包 wheel 的 dist-info METADATA |
| `lxml`（python 发行版） | 6.1.3 | 见随包 wheel 的 dist-info METADATA |
| `numpy`（python 发行版） | 2.3.5 | 见随包 wheel 的 dist-info METADATA |
| `openpyxl`（python 发行版） | 3.1.5 | 见随包 wheel 的 dist-info METADATA |
| `pandas`（python 发行版） | 3.0.1 | 见随包 wheel 的 dist-info METADATA |
| `Pillow`（python 发行版） | 12.3.0 | 见随包 wheel 的 dist-info METADATA |
| `python-dateutil`（python 发行版） | 2.9.0.post0 | 见随包 wheel 的 dist-info METADATA |
| `python-docx`（python 发行版） | 1.2.0 | 见随包 wheel 的 dist-info METADATA |
| `python-pptx`（python 发行版） | 1.0.2 | 见随包 wheel 的 dist-info METADATA |
| `six`（python 发行版） | 1.17.0 | 见随包 wheel 的 dist-info METADATA |
| `typing_extensions`（python 发行版） | 4.16.0 | 见随包 wheel 的 dist-info METADATA |
| `tzdata`（python 发行版） | 2025.2 | 见随包 wheel 的 dist-info METADATA |
| `XlsxWriter`（python 发行版） | 3.2.9 | 见随包 wheel 的 dist-info METADATA |

CPython、Node.js 与每个 python 发行版的完整许可证文本随载荷分发（CPython 的 LICENSE 在载荷根、各发行版（含解释器基线的 pip）在自己的 `*.dist-info/METADATA`、Node.js 随 node 归档）。版本来自 `packages/desktop/primary-runtime-lock.json`（唯一来源）。
