/** Register the real-Cordis source loader for the base-path contract test. */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register(pathToFileURL(new URL('./test-cordis-src-loader.mjs', import.meta.url).pathname).href)
