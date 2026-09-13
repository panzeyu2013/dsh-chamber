import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { frameText, readDocumentLocale } from './locales.ts'
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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
