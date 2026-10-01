// Shared by playwright.config.ts, which starts the servers, and the specs, which point at
// them. Only ports live here: the config derives its temp storage paths from process.pid,
// and each worker re-evaluates the config under its own pid, so anything path-shaped is
// only meaningful in the process that launched the servers.

/** A `--local` dashboard over an empty store. The default `baseURL`. */
export const EMPTY_PORT = 7790;

/** A `--local` dashboard over a store seeded by `e2e/fixtures/seed-store.ts`. */
export const SEEDED_PORT = 7791;

export const EMPTY_URL = `http://127.0.0.1:${EMPTY_PORT}`;
export const SEEDED_URL = `http://127.0.0.1:${SEEDED_PORT}`;
