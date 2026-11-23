/** Register the vendor-runtime resolver for the dsh-client-connection node suites (--import). */
import { register } from 'node:module'

register(new URL('./vendor-runtime-loader.mjs', import.meta.url))
