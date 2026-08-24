/** Asset module declarations (vite inlines small assets as data URLs). */
declare module '*.png' {
  const url: string
  export default url
}
