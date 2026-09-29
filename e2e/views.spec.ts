import { test, expect, type Page, type Request } from '@playwright/test';

import { FIXTURE_MODEL, FIXTURE_SESSION_NAME } from './fixtures/session-fixture.js';
import { EMPTY_URL, SEEDED_URL } from './servers.js';

// One smoke test per dashboard route: it loads in a real browser against a real --local
// server, renders its heading, and logs no console error on the way. Kept cheap on
// purpose — no screenshots — so adding a view costs one row in VIEWS.

interface ViewCase {
  /** The Sidebar button label. */
  readonly nav: string;
  readonly path: string;
  readonly heading: string;
}

const VIEWS: readonly ViewCase[] = [
  { nav: 'Today', path: '/', heading: 'Today' },
  { nav: 'Sessions', path: '/sessions', heading: 'Sessions' },
  { nav: 'History', path: '/history', heading: 'History' },
  { nav: 'Git', path: '/git', heading: 'Git Efficiency' },
  { nav: 'Audit', path: '/audit', heading: 'Audit' },
  { nav: 'Settings', path: '/settings', heading: 'Settings' },
  { nav: 'Alerts', path: '/alerts', heading: 'Alerts' },
];

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
   * Resolves once the current document has had at least one /api/ response and no request
   * other than the SSE stream is in flight.
   */
  settle(): Promise<void>;
}

/**
 * Collects console errors, uncaught exceptions, unexpected error responses and transport
 * failures from the moment it is called. Attach it before the first navigation, or errors
 * thrown during initial load are missed.
 */
function collectErrors(page: Page): ErrorLog {
  const errors: string[] = [];
  const inFlight = new Set<Request>();
  let apiResponses = 0;
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
    apiResponses = 0;
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
    if (pathname.startsWith('/api/')) apiResponses++;
    if (res.status() < 400) return;
    const expected = EXPECTED_ERROR_RESPONSES.some(
      (e) => e.status === res.status() && e.path.test(pathname),
    );
    if (!expected) errors.push(`HTTP ${res.status()}: ${pathname}`);
  });
  return {
    errors,
    // Not waitForLoadState('networkidle'): the SSE stream never closes and Today's queries
    // poll, so the page is never idle for the 500ms that requires. The response count keeps
    // an empty set from passing before the view has issued its queries at all, and two quiet
    // samples in a row (polls are at least 100ms apart) keep the gap between a query and the
    // dependent ones its response enables — Today's session-scoped wave — from passing too.
    // Polls a description rather than a boolean, so a timeout says what it was waiting on.
    settle: () => {
      let quietSamples = 0;
      return expect
        .poll(
          () => {
            quietSamples = apiResponses > 0 && inFlight.size === 0 ? quietSamples + 1 : 0;
            return quietSamples >= 2
              ? 'settled'
              : `${apiResponses} /api/ responses; in flight: ${[...inFlight].map((r) => r.url()).join(', ')}`;
          },
          { timeout: 10_000 },
        )
        .toBe('settled');
    },
  };
}

async function expectView(page: Page, view: ViewCase): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === view.path);
  await expect(page.getByRole('heading', { level: 1, name: view.heading })).toBeVisible();
  // Exact, so a view's own 'Session not found' state is not mistaken for the router's.
  await expect(page.getByText('Not found', { exact: true })).toHaveCount(0);
}

test('VIEWS lists every sidebar entry, in order', async ({ page }) => {
  // The router and the sidebar are edited together when a view is added; this is what makes
  // leaving VIEWS behind fail instead of silently skipping the new view's smoke test.
  await page.goto('/');
  await expect(page.getByRole('navigation').getByRole('button')).toHaveText(
    VIEWS.map((v) => v.nav),
  );
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
        await log.settle();
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
    await log.settle();
    expect(log.errors).toEqual([]);
  });

  test('History shows its empty state', async ({ page }) => {
    const log = collectErrors(page);
    await page.goto('/history');
    await expect(page.getByText('No model data yet')).toBeVisible();
    await expect(page.getByText('0 sessions', { exact: true })).toBeVisible();
    await log.settle();
    expect(log.errors).toEqual([]);
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
    await log.settle();
    expect(log.errors).toEqual([]);
  });

  test('History counts it and breaks it out by model', async ({ page }) => {
    const log = collectErrors(page);
    await page.goto('/history');
    await expect(page.getByText('1 sessions', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: FIXTURE_MODEL })).toBeVisible();
    await expect(page.getByText('No model data yet')).toHaveCount(0);
    await log.settle();
    expect(log.errors).toEqual([]);
  });
});
