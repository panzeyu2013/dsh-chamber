/** Register the vendor-stub resolver for the behavioural suites (--import). */
import { register } from 'node:module'

register(new URL('./vendor-stub-loader.mjs', import.meta.url))
