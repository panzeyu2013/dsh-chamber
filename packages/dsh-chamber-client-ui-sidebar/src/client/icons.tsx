/**
 * chamber sidebar-local icon components (2026-10, user feedback): the shared
 * primitives icon set has no server/host glyph, so the source-level fold
 * toggle gets a self-drawn desktop-monitor outline here instead of the
 * workspace folder glyph (folder = workspace, monitor = server — the two
 * must not share a glyph, see docs/design/06-sidebar-enhancements.md §2.4).
 * Drawn to match the primitives' Outline16 family: fill-based, 16px slot,
 * currentColor.
 */

/** Same shape as the primitives IconProps (loose face — no vendor import). */
interface IconProps {
  /** Square edge in px; defaults to the glyph's own drawn size. */
  size?: number | undefined
  /** Extra class for layout placement; color rides currentColor. */
  className?: string | undefined
}

/**
 * ic_ds_monitor_outline_16 (chamber-drawn): a desktop monitor — rounded
 * screen bezel ring (evenodd hole), neck and base. Drawn to match the
 * folder/branch 16px glyphs' footprint (bezel spans x 1–15 = 14/16 of the
 * viewBox, same as the folder path, so the two read the same size in the
 * shared 16px slot; sizing fix 2026-10 user feedback). The viewBox is
 * shifted 2px up (-2) so the screen's visual center lands on the glyph
 * center (the stand is optically light — without the shift the monitor
 * reads high next to the folder; centering fix 2026-10 user feedback).
 */
export const IconMonitorOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 -2 16 16" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M1 3.05A1.3 1.3 0 0 1 2.3 1.75H13.7A1.3 1.3 0 0 1 15 3.05V9.2A1.3 1.3 0 0 1 13.7 10.5H2.3A1.3 1.3 0 0 1 1 9.2ZM2.6 3.95A0.9 0.9 0 0 1 3.5 3.05H12.5A0.9 0.9 0 0 1 13.4 3.95V8.1A0.9 0.9 0 0 1 12.5 9H3.5A0.9 0.9 0 0 1 2.6 8.1ZM7.2 10.5H8.8V12.1H7.2ZM4.6 12.1H11.4V13.45H4.6Z"
      fill="currentColor"
    />
  </svg>
)
