import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStaticHandler } from './static-handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';

function makeReqRes(url: string): {
  req: IncomingMessage;
  res: ServerResponse;
  chunks: Buffer[];
  status: () => number;
  headers: () => Record<string, string>;
} {
  const chunks: Buffer[] = [];
  let status = 0;
  const headers: Record<string, string> = {};
  const req = { url, method: 'GET' } as IncomingMessage;
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      if (h) Object.assign(headers, h);
    },
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: (chunk?: Buffer | string) => {
      if (chunk) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { req, res, chunks, status: () => status, headers: () => headers };
}

describe('static-handler', () => {
  it('serves index.html for GET /', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>Hi</h1>');
    const handler = createStaticHandler(dir);
    const { req, res, chunks, status, headers } = makeReqRes('/');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/text\/html/);
    expect(Buffer.concat(chunks).toString()).toContain('<h1>Hi</h1>');
  });

  it('serves assets/ files with correct content-type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'main.js'), 'console.log(1)');
    const handler = createStaticHandler(dir);
    const { req, res, chunks, status, headers } = makeReqRes('/assets/main.js');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/javascript/);
    expect(Buffer.concat(chunks).toString()).toBe('console.log(1)');
  });

  it('returns 404 for missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/missing.js');
    await handler(req, res);
    expect(status()).toBe(404);
  });

  it('serves /assets/ files with immutable, max-age=31536000 cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'main-abc123.js'), 'console.log(1)');
    const handler = createStaticHandler(dir);
    const { req, res, status, headers } = makeReqRes('/assets/main-abc123.js');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves index.html on / with no-cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status, headers } = makeReqRes('/');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['cache-control']).toBe('no-cache');
  });

  it('serves SPA-fallback index.html with no-cache for unknown extensionless routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status, headers } = makeReqRes('/sessions');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['cache-control']).toBe('no-cache');
  });

  it('serves non-asset top-level files with a short max-age', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(join(dir, 'favicon.ico'), '');
    const handler = createStaticHandler(dir);
    const { req, res, status, headers } = makeReqRes('/favicon.ico');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['cache-control']).toBe('public, max-age=300');
  });

  it('returns 404 for an existing directory request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    mkdirSync(join(dir, 'assets'));
    const handler = createStaticHandler(dir);
    const { req, res, status, chunks } = makeReqRes('/assets/');
    await handler(req, res);
    expect(status()).toBe(404);
    // Must not fall through to SPA index.html (which would render as 200).
    expect(Buffer.concat(chunks).toString()).not.toContain('<!doctype html>');
  });

  it('returns 403 for files with extensions not in the MIME allow-list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(join(dir, 'config.yaml'), 'secret: value');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/config.yaml');
    await handler(req, res);
    expect(status()).toBe(403);
  });

  it('rejects path traversal (../)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/../../etc/passwd');
    await handler(req, res);
    expect(status()).toBe(403);
  });

  it('rejects null bytes in the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/index.html\0.txt');
    await handler(req, res);
    expect(status()).toBe(403);
  });

  // Regression guard: vite.config.ts must use base:'/' so the built
  // index.html references assets via absolute paths. With base:'./', a
  // direct refresh on /sessions resolves relative './assets/x.js' against
  // /sessions/ and returns 404. This test reads vite.config.ts source
  // directly so a revert is caught even if no build artifact is present.
  it('vite.config.ts has base:"/" (revert guard)', () => {
    const viteConfigPath = resolve(__dirname, '..', '..', '..', 'vite.config.ts');
    const src = readFileSync(viteConfigPath, 'utf-8');
    // Strip line comments first so the regex doesn't match commentary like
    // "with base:'./'" in the explanatory comment above the actual setting.
    // Comments use `//` only in this file (no block comments around `base`).
    const codeOnly = src
      .split('\n')
      .map((line) => line.replace(/\s*\/\/.*$/, ''))
      .join('\n');
    // Match the actual assignment: optional whitespace, base: '/' or "/" with
    // optional trailing comma. Anchored to a line so 'base: "/foo/"' (which
    // a future contributor might add for a sub-path deployment) also passes
    // — but 'base: "./"' (the bug) is rejected.
    expect(codeOnly).toMatch(/^\s*base:\s*['"]\/['"],?\s*$/m);
    expect(codeOnly).not.toMatch(/^\s*base:\s*['"]\.\//m);
  });

  // Regression guard: when the SPA fallback serves index.html for an
  // extensionless route like /sessions, the served HTML must reference
  // assets via absolute paths (/assets/...) so the browser doesn't
  // resolve them against /sessions/ and produce 404s. This guards
  // against vite.config.ts regressing to base:'./' which produces
  // relative paths in the built HTML.
  it('serves index.html with absolute asset paths on SPA fallback for non-root routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head>' +
        '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
        '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">' +
        '</head><body><div id="root"></div></body></html>',
    );
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
    const handler = createStaticHandler(dir);
    const { req, res, chunks, status } = makeReqRes('/sessions/abc-123');
    await handler(req, res);
    expect(status()).toBe(200);
    const html = Buffer.concat(chunks).toString();
    // Asset references must be absolute, not relative.
    expect(html).toContain('src="/assets/');
    expect(html).toContain('href="/assets/');
    expect(html).not.toMatch(/src="\.\/assets\//);
    expect(html).not.toMatch(/href="\.\/assets\//);
  });
});
