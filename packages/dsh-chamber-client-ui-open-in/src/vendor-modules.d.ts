/** Loose vendor faces; the renderer resolves these packages to pinned source. */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export type ClientContext = any
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
}
