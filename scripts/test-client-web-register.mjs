/** Register the real boot.ts test loader without the deprecated CLI flag. */
import { register } from 'node:module'

register('./test-client-web-loader.mjs', import.meta.url)
