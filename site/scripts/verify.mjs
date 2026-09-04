import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { BASE } from '../src/landing.ts';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE, 'dist');
const OUT = join(SITE, '.verify');
const ASTRO = join(SITE, 'node_modules', '.bin', 'astro');

const { INSTALL_COMMAND, AGENT_PROMPT, CLOUD_COMMAND } = await import('../src/landing.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? `: ${detail}` : ''}`);
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

async function waitFor(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`preview never answered at ${url}`);
}

function distPathFor(pathname) {
  const rel = pathname.slice(BASE.length).replace(/^\//, '');
  if (rel === '' || rel.endsWith('/')) return join(DIST, rel, 'index.html');
  return join(DIST, rel);
}

function anchorExists(file, id) {
  return readFileSync(file, 'utf8').includes(`id="${id}"`);
}

const build = spawnSync(ASTRO, ['build'], { cwd: SITE, stdio: 'inherit' });
check('astro build', build.status === 0, `exit ${build.status}`);
if (build.status !== 0) process.exit(1);

const port = await freePort();
const preview = spawn(ASTRO, ['preview', '--port', String(port), '--host', '127.0.0.1'], {
  cwd: SITE,
  stdio: 'ignore',
});
const origin = `http://127.0.0.1:${port}`;
const home = `${origin}${BASE}/`;

try {
  await waitFor(home);
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && failedRequests.push(`${r.url()} ${r.status()}`));

  await page.goto(home, { waitUntil: 'networkidle' });
  check(
    'landing loads with no console errors',
    consoleErrors.length === 0,
    consoleErrors.join('; '),
  );
  check(
    'landing loads with no failed requests',
    failedRequests.length === 0,
    failedRequests.join('; '),
  );

  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  const broken = [];
  for (const href of new Set(hrefs)) {
    if (/^(https?:|mailto:)/.test(href)) continue;
    const url = new URL(href, home);
    if (url.pathname === `${BASE}/` && url.hash) {
      const id = url.hash.slice(1);
      if (!(await page.$(`[id="${id}"]`))) broken.push(href);
      continue;
    }
    const file = distPathFor(url.pathname);
    if (!existsSync(file)) {
      broken.push(`${href} (missing ${file})`);
      continue;
    }
    if (url.hash && !anchorExists(file, url.hash.slice(1))) broken.push(`${href} (no anchor)`);
  }
  check(
    `all ${hrefs.length} same-origin links resolve in dist`,
    broken.length === 0,
    broken.join('; '),
  );

  if (existsSync(join(SITE, 'public', 'start.md'))) {
    const r = await fetch(`${origin}${BASE}/start.md`);
    check('start.md is served', r.status === 200, `status ${r.status}`);
  }

  const expected = {
    'install-command': INSTALL_COMMAND,
    'agent-prompt': AGENT_PROMPT,
    'install-command-cta': INSTALL_COMMAND,
    'cloud-command': CLOUD_COMMAND,
  };
  for (const button of await page.$$('button.copy')) {
    const target = await button.getAttribute('data-target');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await button.click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    const label = (await button.textContent()).trim();
    check(
      `copy button #${target} writes exact text`,
      clipboard === expected[target],
      JSON.stringify(clipboard),
    );
    check(`copy button #${target} reads Copied`, label === 'Copied', label);
  }

  const answers = new Set();
  const vias = new Set();
  const visibleCounts = new Set();
  const tabs = await page.$$('[role="tab"]');
  for (const tab of tabs) {
    await tab.click();
    const visible = [];
    for (const panel of await page.$$('[role="tabpanel"]')) {
      if (await panel.isVisible()) {
        visible.push(panel);
        answers.add(await panel.$eval('[data-answer]', (el) => el.textContent.trim()));
        vias.add(await panel.$eval('[data-via]', (el) => el.textContent.trim()));
      }
    }
    visibleCounts.add(visible.length);
  }
  check(
    `each of ${tabs.length} showcase tabs shows a distinct answer and via line`,
    answers.size === tabs.length && vias.size === tabs.length,
    `${answers.size} answers, ${vias.size} via lines`,
  );
  check(
    'exactly one showcase panel is visible at a time',
    visibleCounts.size === 1 && visibleCounts.has(1),
    [...visibleCounts].join(', '),
  );

  await page.evaluate(() => window.scrollTo(0, 0));

  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  const other = before === 'dark' ? 'light' : 'dark';
  await page.click(`[data-set-theme="${other}"]`);
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  const storedTheme = await page.evaluate(() => localStorage.getItem('starlight-theme'));
  check(`theme toggle flips data-theme ${before} to ${other}`, after === other, after);
  check('theme toggle persists to starlight-theme', storedTheme === other, String(storedTheme));
  await page.reload({ waitUntil: 'networkidle' });
  await page.screenshot({ path: join(OUT, `landing-1440-${other}.png`), fullPage: true });
  await page.click(`[data-set-theme="${before}"]`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.screenshot({ path: join(OUT, `landing-1440-${before}.png`), fullPage: true });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(home, { waitUntil: 'networkidle' });
  const widths = await mobile.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check(
    'no horizontal scroll at 390px',
    widths[0] <= widths[1],
    `scrollWidth ${widths[0]} > ${widths[1]}`,
  );
  await mobile.screenshot({ path: join(OUT, 'landing-390-dark.png'), fullPage: true });

  await page.goto(`${origin}${BASE}/whats-new/`, { waitUntil: 'networkidle' });
  check('whats-new page loads', (await page.title()).length > 0);
  await page.screenshot({ path: join(OUT, 'whats-new-1440.png'), fullPage: true });

  await browser.close();
} catch (err) {
  check('verify ran to completion', false, err.stack ?? String(err));
} finally {
  preview.kill();
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
