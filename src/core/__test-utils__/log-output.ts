/**
 * Test-only helper for asserting on captured stderr output.
 *
 * Across the test suite, the structured logger writes to stderr (which
 * tests stub via `jest.spyOn(console, 'error').mockImplementation(...)`)
 * and assertions then need to materialize the captured frames into a
 * single concatenated string for `.toContain(...)` checks. The pattern
 * `stderrSpy.mock.calls.map(c => c[0]).join('')` was repeated in
 * `pricing.test.ts`, `config.test.ts`, `tokens.test.ts`, and
 * `harvest-scheduler.test.ts` — 25 sites total. This helper exists so
 * each site collapses to `getLogOutput(stderrSpy)`.
 *
 * Lives under `src/__test-utils__/` (Jest's conventional double-underscore
 * directory for test-only support code) so the build-time tsconfig
 * exclude can keep it out of `dist/` — see `tsconfig.json`'s `exclude`
 * list. The file is not a test file (no `.test.ts` suffix) so Jest's
 * `testMatch` will not try to run it.
 */

/**
 * Minimal shape needed off a `jest.spyOn(console, 'error')` result.
 * Spelled out as a structural interface rather than `jest.SpyInstance`
 * so the helper doesn't depend on the (frequently-renamed) Jest type
 * surface and stays narrow — `mock.calls[i][0]` is the only field we
 * read.
 */
interface StderrSpyShape {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}

/**
 * Concatenate every stderr frame captured by `stderrSpy` into a single
 * string suitable for `.toContain(...)` / `.toMatch(...)` assertions.
 *
 * Tests across this package only ever inspect the first argument of
 * each `console.error` call (the log line itself), which matches the
 * runtime behavior of the structured logger — it always emits the JSON
 * payload as the sole call argument.
 *
 * The default separator is `''` (concatenated). Pass `'\n'` (or any
 * other delimiter) when the assertion needs frame boundaries preserved
 * — e.g. `getLogOutput(spy, '\n').split('\n')` to inspect frames
 * individually. Both styles existed in the suite pre-helper and both
 * are kept supported.
 */
export function getLogOutput(stderrSpy: StderrSpyShape, separator: string = ''): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join(separator);
}
