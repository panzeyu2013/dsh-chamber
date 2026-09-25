# Third-Party Notices

dsh-chamber redistributes the following third-party packages. The full license
text of each package lives in its own `LICENSE` file under `node_modules`.
Generated with `npm run gen:notices`.

| Package | Version | License |
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

## macOS native shell (SwiftPM / packaging assets)

| Package | Version | License |
|---|---|---|
| `Sparkle` | 2.10.0 | MIT |

The native DMG's Finder background asset `macos/resources/dmg-background.tiff` is
taken from `electron-builder`'s `dmg-builder/templates/background.tiff` (MIT,
electron-userland/electron-builder; dual representation 540×380@72dpi +
1080×760@144dpi) so the native DMG ships the same drag-to-install cue as the
Electron leg (2026-09).

## Bundled payload (primary runtime: CPython / python distributions / Node.js)

| Component | Version | License |
|---|---|---|
| `CPython` (python-build-standalone) | 3.12.14 | PSF-2.0 |
| `Node.js` | 24.18.1 | MIT |
| `et_xmlfile` (python distribution) | 2.0.0 | see the wheel dist-info METADATA |
| `lxml` (python distribution) | 6.1.3 | see the wheel dist-info METADATA |
| `numpy` (python distribution) | 2.3.5 | see the wheel dist-info METADATA |
| `openpyxl` (python distribution) | 3.1.5 | see the wheel dist-info METADATA |
| `pandas` (python distribution) | 3.0.1 | see the wheel dist-info METADATA |
| `Pillow` (python distribution) | 12.3.0 | see the wheel dist-info METADATA |
| `python-dateutil` (python distribution) | 2.9.0.post0 | see the wheel dist-info METADATA |
| `python-docx` (python distribution) | 1.2.0 | see the wheel dist-info METADATA |
| `python-pptx` (python distribution) | 1.0.2 | see the wheel dist-info METADATA |
| `six` (python distribution) | 1.17.0 | see the wheel dist-info METADATA |
| `typing_extensions` (python distribution) | 4.16.0 | see the wheel dist-info METADATA |
| `tzdata` (python distribution) | 2025.2 | see the wheel dist-info METADATA |
| `XlsxWriter` (python distribution) | 3.2.9 | see the wheel dist-info METADATA |

The full license text of CPython, Node.js and of every python distribution ships inside the payload (CPython LICENSE at the payload root, each distribution in its own `*.dist-info/METADATA`, Node.js with the node archive). Versions come from `packages/desktop/primary-runtime-lock.json` (single source).
