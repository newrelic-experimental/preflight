import { test, expect, type Page, type Request } from '@playwright/test';

import { FIXTURE_MODEL, FIXTURE_SESSION_NAME } from './fixtures/session-fixture.js';
import { SEEDED_URL } from './servers.js';

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
  /** Resolves once no request other than the SSE stream is in flight. */
  settle(): Promise<void>;
}

/**
 * Collects console errors, uncaught exceptions and unexpected error responses from the
 * moment it is called. Attach it before the first navigation, or errors thrown during
 * initial load are missed.
 */
function collectErrors(page: Page): ErrorLog {
  const errors: string[] = [];
  const inFlight = new Set<Request>();
  page.on('console', (msg) => {
    // Chromium logs every non-2xx fetch as a console error with no URL in it. Responses are
    // checked below instead, where the URL is known and a handled 404 can be told apart.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('request', (req) => {
    if (req.resourceType() !== 'eventsource') inFlight.add(req);
  });
  page.on('requestfailed', (req) => inFlight.delete(req));
  // A reload cancels the old document's fetches without always reporting them as failed.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) inFlight.clear();
  });
  page.on('response', (res) => {
    // Answered is settled. Not 'requestfinished': that waits for the body, and the client
    // never reads the body of an error response, so a handled 404 would stay in flight.
    inFlight.delete(res.request());
    if (res.status() < 400) return;
    const { pathname } = new URL(res.url());
    const expected = EXPECTED_ERROR_RESPONSES.some(
      (e) => e.status === res.status() && e.path.test(pathname),
    );
    if (!expected) errors.push(`HTTP ${res.status()}: ${pathname}`);
  });
  return {
    errors,
    // Not waitForLoadState('networkidle'): the SSE stream never closes and Today's queries
    // poll, so the page is never idle for the 500ms that requires.
    settle: () => expect.poll(() => inFlight.size, { timeout: 10_000 }).toBe(0),
  };
}

async function expectView(page: Page, view: ViewCase): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === view.path);
  await expect(page.getByRole('heading', { level: 1, name: view.heading })).toBeVisible();
  await expect(page.getByText('Not found')).toHaveCount(0);
}

// Each test reaches its view twice — from the sidebar, then by reloading on the view's own
// URL — so a broken route fails that view's test and no other.
test.describe('every view loads', () => {
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

test.describe('empty store', () => {
  test('Sessions shows its empty state', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.getByText('No sessions yet')).toBeVisible();
    await expect(page.getByText(FIXTURE_SESSION_NAME)).toHaveCount(0);
  });

  test('History shows its empty state', async ({ page }) => {
    await page.goto('/history');
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
