/** Register the sidebar test loader without the deprecated CLI flag. */
import { register } from 'node:module'

register('./vendor-loader.mjs', import.meta.url)
