import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { frameText, readDocumentLocale } from './locales.ts'
import { installPageLanguageOwner } from './page-language.ts'
import { installSvgResourceScope } from '@dsh-chamber/dsh-chamber-client-core/svg-resource-scope'
import './styles.css'

// The static first-frame skeleton (index.html) carries the served markup's own default-language
// copy; this rewrites it from the frame's typed dictionary BEFORE React mounts, so the skeleton
// never labels itself with a language the frame would not use. A cold load is a no-op (no shell
// has rewritten <html lang> yet).
const bootHint = document.querySelector('[data-chamber-boot-hint]')
if (bootHint !== null) bootHint.textContent = frameText(readDocumentLocale(), 'boot.starting')

// `<html lang>` is document-global but every mounted shell writes it unconditionally, so the
// page-language owner takes it over BEFORE any shell boots; from then on only the on-screen
// source's settled language may change it (page-language.ts).
installPageLanguageOwner()

// SVG resource ids (`url(#id)`) resolve DOCUMENT-wide and upstream icon components hard-code
// theirs, so N shells in one document define the same id per mounted copy and a hidden/pending
// shell can drop painted icons. The scoper makes every <svg> self-contained BEFORE any boot.
// 锚定赋值形式是故意的：esbuild 不改点号属性名，压缩产物里因此留下
// globalThis.__chamberSvgScopeInstalled=<压缩后标识符>()，守卫可在压缩产物上证明入口调用了
// 安装；裸调用会被改名，使产物守卫恒红；负控：把右侧换成非调用（如 = null）标记即消失。
;(globalThis as unknown as { __chamberSvgScopeInstalled?: unknown }).__chamberSvgScopeInstalled =
  installSvgResourceScope()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
