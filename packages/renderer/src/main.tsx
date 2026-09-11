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
// language disagrees with (an English document gets English immediately).
const bootHint = document.querySelector('[data-chamber-boot-hint]')
if (bootHint !== null) bootHint.textContent = frameText(readDocumentLocale(), 'boot.starting')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
