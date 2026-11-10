/** Composition of one navigation provider and its placeholder presentation. */
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'
import type { BrowserFrame } from './BrowserFrame.ts'
import type { BrowserTabState } from './BrowserPersistence.ts'
import type { NativeGuestCarrier } from './BrowserBridge.ts'

/** Provider construction inputs; persistence does not enter the live navigation interface. */
export interface BrowserPageOptions {
  /** The tab occurrence this page belongs to (lease identity, design 28 §3). */
  readonly tabId: string
  /** The bridge plus the boot-bound lease identity. */
  readonly carrier: NativeGuestCarrier
  readonly initial: BrowserTabState | undefined
  readonly persist: (state: BrowserTabState) => void
  readonly openRequested: (url: string) => void
}

/** The owning controller disposes frame; UI mounts only presentation. */
export interface BrowserPage {
  readonly frame: BrowserFrame
  readonly presentation: BrowserPresentation
}

/** Construct an idle provider without attaching the guest; saved navigation waits for an explicit command. */
export type BrowserPageFactory = (options: BrowserPageOptions) => BrowserPage
