/**
 * Fail-loud fixture stand-in for the dsh-client-connection node unit tests
 * (see scripts/dev/test-connection-loader.mjs). `src/client/fixture.ts`
 * imports the built vendor graph, which a source checkout does not have; the
 * chamber tests that load the apply seam never take the `?fixture` page mode,
 * so any call here is a test bug and throws instead of silently succeeding.
 */
export function createFixtureConnectionRpc() {
  throw new Error(
    'dsh-client-connection fixture is stubbed in node unit tests (it imports the built vendor graph); '
    + 'fixture-backed paths run through vite-resolved builds',
  )
}
