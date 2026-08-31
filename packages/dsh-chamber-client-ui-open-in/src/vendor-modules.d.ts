/** Loose vendor faces; the renderer resolves these packages to pinned source. */

declare module '@deepseek-ai/cordis' {
  /** Loose root-context face (the plugin consumes ctx through the cordis Context). */
  export interface Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
}
