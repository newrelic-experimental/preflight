import { test, expect, type Page, type Request } from '@playwright/test';

import {
  FIXTURE_MODEL,
  FIXTURE_SESSION_ID,
  FIXTURE_SESSION_NAME,
} from './fixtures/session-fixture.js';
import { EMPTY_URL, SEEDED_URL } from './servers.js';

// One smoke test per dashboard route: it loads in a real browser against a real --local
// server, renders its heading, and logs no console error on the way. Kept cheap on
// purpose — no screenshots — so adding a view costs one row in VIEWS.

interface ViewCase {
  /** The Sidebar button label. */
  readonly nav: string;
  readonly path: string;
  readonly heading: string;
  /**
   * A request only this view makes on mount. settle() waits until it has been answered, so
   * a view whose queries never fire fails instead of passing on the App shell's own fetches
   * (/api/session/current, /api/anti-patterns, /api/health and /sse, on every route).
   */
  readonly query: RegExp;
}

const VIEWS: readonly ViewCase[] = [
  { nav: 'Today', path: '/', heading: 'Today', query: /^\/api\/sessions\/today\/aggregate$/ },
  { nav: 'Sessions', path: '/sessions', heading: 'Sessions', query: /^\/api\/sessions$/ },
  { nav: 'History', path: '/history', heading: 'History', query: /^\/api\/weekly$/ },
  { nav: 'Git', path: '/git', heading: 'Git Efficiency', query: /^\/api\/git-efficiency$/ },
  { nav: 'Audit', path: '/audit', heading: 'Audit', query: /^\/api\/audit$/ },
  { nav: 'Settings', path: '/settings', heading: 'Settings', query: /^\/api\/settings$/ },
  { nav: 'Alerts', path: '/alerts', heading: 'Alerts', query: /^\/api\/budget$/ },
];

/** The request Sessions and History both render their session lists from. */
const SESSIONS_LIST = /^\/api\/sessions$/;

/**
 * Error responses the dashboard requests and handles as a normal state, each with the
 * reason. Everything else at 4xx/5xx fails the test that saw it.
 */
const EXPECTED_ERROR_RESPONSES: readonly { readonly status: number; readonly path: RegExp }[] = [
  // Today's live tail selects the --local process's own synthetic session, which never has
  // replay data; the endpoint answers 404 no_replay_data and the view renders without it.
  { status: 404, path: /^\/api\/sessions\/local-\d+\/replay$/ },
];

interface ErrorLog {
  readonly errors: string[];
  /**
   * Resolves once the current document has answered a request matching each of `required`
   * and no request other than the SSE stream is in flight.
   */
  settle(required: readonly RegExp[]): Promise<void>;
}

/**
 * Collects console errors, uncaught exceptions, unexpected error responses and transport
 * failures from the moment it is called. Attach it before the first navigation, or errors
 * thrown during initial load are missed.
 */
function collectErrors(page: Page): ErrorLog {
  const errors: string[] = [];
  const inFlight = new Set<Request>();
  // Pathnames answered on the current document.
  const answered = new Set<string>();
  page.on('console', (msg) => {
    // Chromium logs every failed fetch as a console error with no URL in it. Responses and
    // transport failures are checked below instead, where the URL is known and a handled
    // 404 can be told apart.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('request', (req) => {
    if (req.resourceType() !== 'eventsource') inFlight.add(req);
  });
  // A committed navigation starts a new count. Reset here, not on the navigation request:
  // the old document keeps running until the new one commits, and fetches it starts in that
  // window are dropped with it without being reported as failed. Same-document navigations
  // (a sidebar click) reset too, which only makes a settle() before a reload more lenient.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    inFlight.clear();
    answered.clear();
  });
  page.on('requestfailed', (req) => {
    inFlight.delete(req);
    const reason = req.failure()?.errorText ?? 'unknown';
    // ERR_ABORTED is a cancellation — a reload, or React Query aborting an unmounted
    // view's queries — not a failure of the request itself.
    if (reason !== 'net::ERR_ABORTED') {
      errors.push(`request failed (${reason}): ${new URL(req.url()).pathname}`);
    }
  });
  page.on('response', (res) => {
    // Answered is settled. Not 'requestfinished': that waits for the body, and the client
    // never reads the body of an error response, so a handled 404 would stay in flight.
    inFlight.delete(res.request());
    const { pathname } = new URL(res.url());
    answered.add(pathname);
    if (res.status() < 400) return;
    const expected = EXPECTED_ERROR_RESPONSES.some(
      (e) => e.status === res.status() && e.path.test(pathname),
    );
    if (!expected) errors.push(`HTTP ${res.status()}: ${pathname}`);
  });
  return {
    errors,
    // Not waitForLoadState('networkidle'): the SSE stream never closes and Today's queries
    // poll, so the page is never idle for the 500ms that requires. `required` names requests
    // the view itself makes — the App shell answers a couple of /api/ fetches on every route,
    // so "some response arrived" proves nothing about the view. Two quiet samples in a row
    // (at least 100ms apart) narrow, but do not close, the gap between a query and the
    // dependent ones its response enables: a request that must be checked belongs in
    // `required`, not left to the quiet window.
    // Polls a description rather than a boolean, so a timeout says what it was waiting on.
    settle: (required) => {
      let quietSamples = 0;
      return expect
        .poll(
          () => {
            const missing = required.filter((re) => ![...answered].some((p) => re.test(p)));
            quietSamples = missing.length === 0 && inFlight.size === 0 ? quietSamples + 1 : 0;
            return quietSamples >= 2
              ? 'settled'
              : `not yet answered: ${missing.join(', ') || 'none'}; in flight: ${[...inFlight].map((r) => r.url()).join(', ') || 'none'}`;
          },
          { timeout: 10_000 },
        )
        .toBe('settled');
    },
  };
}

async function expectView(page: Page, view: ViewCase): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === view.path);
  await expect(
    page.getByRole('heading', { level: 1, name: view.heading, exact: true }),
  ).toBeVisible();
  // Exact, so a view's own 'Session not found' state is not mistaken for the router's.
  await expect(page.getByText('Not found', { exact: true })).toHaveCount(0);
}

test('VIEWS lists every sidebar entry, in order', async ({ page }) => {
  // The router and the sidebar are edited together when a view is added; this is what makes
  // leaving VIEWS behind fail instead of silently skipping the new view's smoke test.
  await page.goto('/');
  // Counted on buttons, so an entry built without a label span still counts; labels read
  // from the span, not the whole button, which also holds Today's alert-count badge.
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('button')).toHaveCount(VIEWS.length);
  await expect(nav.locator('button > span:first-of-type')).toHaveText(VIEWS.map((v) => v.nav));
});

// Each test reaches its view twice — from the sidebar, then by reloading on the view's own
// URL — so a broken route fails that view's tests and no others. Every view runs against both
// stores, so the views that read persisted sessions are loaded with one as well as without.
for (const store of [
  { name: 'empty', url: EMPTY_URL },
  { name: 'seeded', url: SEEDED_URL },
]) {
  test.describe(`every view loads (${store.name} store)`, () => {
    test.use({ baseURL: store.url });

    for (const view of VIEWS) {
      test(`${view.nav} (${view.path})`, async ({ page }) => {
        const log = collectErrors(page);
        await page.goto('/');
        await page.getByRole('navigation').getByRole('button', { name: view.nav }).click();
        await expectView(page, view);
        await page.reload();
        await expectView(page, view);
        // Let the view's queries settle, so an error from a failed fetch is caught here too.
        await log.settle([view.query]);
        expect(log.errors).toEqual([]);
      });
    }
  });
}

test.describe('empty store', () => {
  // Both empty states also render while loading and on a failed fetch, so each test checks
  // for errors too; otherwise a 500 from /api/sessions would satisfy it.
  test('Sessions shows its empty state', async ({ page }) => {
    const log = collectErrors(page);
    await page.goto('/sessions');
    await expect(page.getByText('No sessions yet')).toBeVisible();
    await expect(page.getByText(FIXTURE_SESSION_NAME)).toHaveCount(0);
    await log.settle([SESSIONS_LIST]);
    expect(log.errors).toEqual([]);
  });

  test('History shows its empty state', async ({ page }) => {
    const log = collectErrors(page);
    await page.goto('/history');
    // Settle first: History renders both strings from `sessions.data ?? []` at first paint,
    // before /api/sessions answers, so asserting them earlier would pass on any store.
    await log.settle([SESSIONS_LIST]);
    expect(log.errors).toEqual([]);
    await expect(page.getByText('No model data yet')).toBeVisible();
    await expect(page.getByText('0 sessions', { exact: true })).toBeVisible();
  });
});

test.describe('store with one session', () => {
  test.use({ baseURL: SEEDED_URL });

  test('Sessions lists it', async ({ page }) => {
    const log = collectErrors(page);
    await page.goto('/sessions');
    await expect(
      page.getByRole('button', { name: new RegExp(FIXTURE_SESSION_NAME) }),
    ).toBeVisible();
    await expect(page.getByText('No sessions yet')).toHaveCount(0);
    // The first row is selected once the list answers, which issues its detail request.
    await log.settle([SESSIONS_LIST, new RegExp(`^/api/sessions/${FIXTURE_SESSION_ID}$`)]);
    expect(log.errors).toEqual([]);
  });

  test('History counts it and breaks it out by model', async ({ page }) => {
    const log = collectErrors(page);
    await page.goto('/history');
    await expect(page.getByText('1 sessions', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: FIXTURE_MODEL })).toBeVisible();
    await expect(page.getByText('No model data yet')).toHaveCount(0);
    await log.settle([SESSIONS_LIST]);
    expect(log.errors).toEqual([]);
  });
});
