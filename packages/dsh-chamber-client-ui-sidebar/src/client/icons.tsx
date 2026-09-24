/** chamber sidebar-local icons: the shared primitives set has no server/host glyph,
 *  so the source-level fold toggle gets a self-drawn monitor outline — folder =
 *  workspace, monitor = server, and the two must not share a glyph; drawn to match
 *  the Outline16 family (fill-based, 16px slot, currentColor). */

/** Loose face of the primitives IconProps (no vendor import); color rides currentColor. */
interface IconProps {
  size?: number | undefined
  className?: string | undefined
}

/**
 * ic_ds_monitor_outline_16 (chamber-drawn): a desktop monitor — rounded bezel ring
 * (evenodd hole), neck and base. The bezel spans x 1–15 = 14/16 of the viewBox like
 * the folder, so both read the same size in the 16px slot; the viewBox shift (-2) puts
 * the screen's visual center on the glyph center (the stand is optically light).
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
