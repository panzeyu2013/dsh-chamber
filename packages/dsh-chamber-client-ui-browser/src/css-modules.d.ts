/** CSS-module seam for the launcher stylesheet (Vite/tsdown emit typed classes as strings). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
