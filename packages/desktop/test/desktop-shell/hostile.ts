/**
 * Hostile-value fixture shared by the desktop-shell suites: a thrown value
 * whose every introspection trap throws, so error formatting must never trust
 * it (design 19 §3.3 honest-failure surface).
 */

/** A thrown value whose get/getPrototypeOf traps throw on any inspection. */
export function hostileThrownValue(): unknown {
  return new Proxy({}, {
    getPrototypeOf() { throw new Error('getPrototypeOf trap') },
    get() { throw new Error('get trap') },
  })
}
