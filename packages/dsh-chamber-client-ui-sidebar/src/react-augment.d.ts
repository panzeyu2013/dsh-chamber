/**
 * React module augmentation (05 §2): the active source/session left inset
 * rides a per-element CSS custom property. A script-form `declare module
 * 'react'` would shadow the real module, so this file is module-form (the
 * trailing `export {}`) — an augmentation merges instead. @types/react 19
 * intentionally dropped the CSS custom-property index signature.
 */
declare module 'react' {
  interface CSSProperties {
    /** Per-element source accent (05 §2 — active source/session left inset). */
    '--dsh-source-accent'?: string | number
  }
}

export {}
