/**
 * The document-reload action, shared by the frame's two escape surfaces: the session-stall
 * banner and the fatal boot overlay.
 *
 * Why it is its own component: a boot failure can be DETERMINISTIC inside one document — a
 * client-plugin revision conflict keeps its first-load-wins claim for the page's lifetime,
 * so the overlay's retry re-runs the same verdict — and every surface whose copy names that
 * closure must offer the action. App.tsx (a God file under a line budget) owns the copy and
 * passes the label; this file owns only the chrome.
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'

export function ReloadPageButton({ label }: { label: string }): ReactNode {
  return (
    <Button variant="outline" onClick={() => { window.location.reload() }}>
      {label}
    </Button>
  )
}
