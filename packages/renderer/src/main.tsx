import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { frameText, readDocumentLocale } from './locales.ts'
import { installPageLanguageOwner } from './page-language.ts'
import { installSvgResourceScope } from './svg-resource-scope.ts'
import './styles.css'

// T16 (2026-09-11 upstream-alignment): the static first-frame skeleton in
// index.html carries the served markup's OWN default-language copy (the file
// declares <html lang="zh-CN">, the same served-markup default the frame's
// locale fallback pins), and this is where the frame's typed dictionary takes
// over — before React mounts, so the skeleton never keeps copy the document
// language disagrees with.
// 2026-09-11 review-fix (finding 4e): on a COLD load the two cannot actually
// disagree yet — `<html lang>` is still the served markup's zh-CN (index.html:2)
// and no shell has booted to rewrite it, so this rewrite is a no-op on that path
// (the hint already carries the zh copy). It earns its keep the moment the
// document language is NOT the served default by the time this module runs: a
// control-plane markup that declares another language, or a dev/HMR
// re-evaluation after a booted shell projected its locale. Both branches read
// the same dictionary, so neither path can label the skeleton with a language
// the frame itself would not use.
const bootHint = document.querySelector('[data-chamber-boot-hint]')
if (bootHint !== null) bootHint.textContent = frameText(readDocumentLocale(), 'boot.starting')

// design 06 §4.6「页面语言归属」: `<html lang>` is a DOCUMENT-global fact, and every mounted
// instance shell writes it unconditionally (the vendor locale service, at
// activation and on each dictionary registration, with no teardown). N shells
// share this one document, so the last writer — including a prewarmed shell's
// browser-derived provisional — used to own the frame chrome's language. The
// page-language owner takes that attribute over BEFORE any shell boots: the
// served markup's own language is the cold-start value, and from here on only
// the on-screen source's SETTLED language may change it (page-language.ts).
installPageLanguageOwner()

// design 05 §4.2「文档级 SVG 资源 id 归属」: upstream icon components hard-code their
// Figma resource ids, and `url(#id)` is resolved DOCUMENT-wide — N shells in one
// document therefore define the same id once per mounted copy. On the real shell
// (macOS WKWebView) a freshly created icon whose clipper/mask resolves into a
// not-laid-out subtree (an instance-hidden / instance-pending shell) is then
// dropped at paint time and stays blank until the element is rebuilt; renaming the
// duplicated ids was measured to immunise it. The scoper makes every <svg>
// self-contained BEFORE any shell boots.
installSvgResourceScope()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
