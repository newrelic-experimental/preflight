import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/index.js';
import { VERSION } from '../version.js';
import { LiveEventBus } from './live-event-bus.js';
import { createStaticHandler } from './routes/static-handler.js';
import { createApiHandler, ApiHandlerDeps } from './routes/api-handler.js';
import { createSseHandler } from './routes/sse-handler.js';
import type { LocalAlertEngine } from '../alerts/local-alert-engine.js';
import type { AlertLog } from '../alerts/alert-log.js';

const logger = createLogger('dashboard-server');

function isNewerVersion(candidate: string, installed: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, '').replace(/-.*$/, '').split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [ca, cb, cc] = parse(candidate);
  const [ia, ib, ic] = parse(installed);
  if (ca !== ia) return ca > ia;
  if (cb !== ib) return cb > ib;
  return cc > ic;
}

async function defaultNpmFetcher(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@newrelic/preflight/latest', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const v = data['version'];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export interface DashboardServerOptions {
  readonly port: number;
  readonly host: string;
  readonly bus: LiveEventBus;
  readonly staticDir?: string;
  readonly api?: ApiHandlerDeps;
  // Wiring: passed in when the server is constructed in local/both
  // mode. Surfaced via the API + SPA. They live on the
  // server for now so other modules (e.g. budget threshold callback in
  // index.ts) can route events through the engine.
  readonly alertEngine?: LocalAlertEngine;
  readonly alertLog?: AlertLog;
  /** Override for testing — resolves to the latest version string or null. */
  readonly npmFetcher?: () => Promise<string | null>;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export class DashboardServer {
  private readonly opts: DashboardServerOptions;
  private server: HttpServer | undefined;
  private readonly startedAt = Date.now();
  private readonly routes = new Map<string, RouteHandler>();
  private readonly staticHandler:
    ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  private readonly apiHandler:
    ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  // SSE responses are long-lived and would block server.close() forever.
  // Track them so stop() can force-end each one before awaiting close.
  private readonly activeSseResponses = new Set<ServerResponse>();
  private latestVersion: string | null = null;
  private updateAvailable = false;

  constructor(opts: DashboardServerOptions) {
    this.opts = opts;
    this.staticHandler = opts.staticDir ? createStaticHandler(opts.staticDir) : undefined;
    // When staticDir is configured but the SPA bundle hasn't been
    // built (e.g. fresh checkout, skipped `npm run build:web`), every
    // route returns a silent 404 and the user sees a blank page with no
    // diagnostic. Surface a one-shot warning at boot so the cause is
    // obvious in the server log.
    if (opts.staticDir) {
      const indexPath = join(opts.staticDir, 'index.html');
      if (!existsSync(indexPath)) {
        logger.warn(
          `Dashboard static dir is missing index.html (${indexPath}). ` +
            "Run 'npm run build:web' to build the SPA bundle.",
        );
      }
    }
    // Merge alertLog from the top-level options into the api deps so the
    // /api/alerts/recent route can read from it. Top-level opts.alertLog
    // wins over any value already on opts.api.alertLog (it's the
    // canonical source — the api block predates the alertLog wiring).
    const apiDeps: ApiHandlerDeps | undefined = opts.api
      ? { ...opts.api, alertLog: opts.alertLog ?? opts.api.alertLog }
      : opts.alertLog
        ? { alertLog: opts.alertLog }
        : undefined;
    this.apiHandler = apiDeps ? createApiHandler(apiDeps) : undefined;
    this.routes.set('GET /api/health', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          uptime: Date.now() - this.startedAt,
          version: VERSION,
          latestVersion: this.latestVersion,
          updateAvailable: this.updateAvailable,
        }),
      );
    });
    const sseHandler = createSseHandler(opts.bus);
    this.routes.set('GET /sse', (req, res) => {
      this.activeSseResponses.add(res);
      res.on('close', () => this.activeSseResponses.delete(res));
      sseHandler(req, res);
    });
    const fetcher = opts.npmFetcher ?? defaultNpmFetcher;
    void fetcher().then((v) => {
      if (v !== null) {
        this.latestVersion = v;
        this.updateAvailable = isNewerVersion(v, VERSION);
      }
    });
  }

  /** Hook for tests + API route wiring. */
  getAlertEngine(): LocalAlertEngine | undefined {
    return this.opts.alertEngine;
  }

  /** Hook for tests + API route wiring. */
  getAlertLog(): AlertLog | undefined {
    return this.opts.alertLog;
  }

  async start(): Promise<AddressInfo> {
    if (this.server) {
      throw new Error('DashboardServer.start() called on an already-running server');
    }
    return await new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });
      // Reject the start() promise on any pre-listen error (e.g. EADDRINUSE).
      // Once listen() succeeds, swap in a permanent error logger so post-start
      // errors aren't silently swallowed by the resolved promise.
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        const addr = server.address() as AddressInfo;
        server.removeListener('error', reject);
        server.on('error', (err) => {
          logger.error('Dashboard server error after start', { error: String(err) });
        });
        logger.info('Dashboard server listening', { host: addr.address, port: addr.port });
        this.server = server;
        resolve(addr);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = undefined;
    // SSE streams never end on their own — without this, close() hangs forever.
    for (const res of this.activeSseResponses) {
      try {
        res.end();
      } catch {
        // ignore — connection may already be torn down
      }
    }
    this.activeSseResponses.clear();
    return await new Promise((resolve) => s.close(() => resolve()));
  }

  private setSecurityHeaders(res: ServerResponse): void {
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.setSecurityHeaders(res);
      if (!this.isHostAllowed(req.headers.host)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden: invalid Host header');
        return;
      }
      const url = req.url ?? '/';
      const pathname = url.split('?')[0] ?? '/';
      const key = `${req.method ?? 'GET'} ${pathname}`;
      const handler = this.routes.get(key);
      if (handler) {
        try {
          await handler(req, res);
        } catch (err) {
          logger.error('Route handler error', { route: key, error: String(err) });
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal' }));
          }
        }
        return;
      }
      if (
        (req.method === 'GET' || req.method === 'PATCH' || req.method === 'POST') &&
        pathname.startsWith('/api/') &&
        pathname !== '/api/health' &&
        this.apiHandler
      ) {
        try {
          await this.apiHandler(req, res);
        } catch (err) {
          logger.error('API handler error', { route: key, error: String(err) });
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal' }));
          }
        }
        return;
      }
      if (req.method === 'GET' && this.staticHandler) {
        try {
          await this.staticHandler(req, res);
        } catch (err) {
          logger.error('Static handler error', { error: String(err) });
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal' }));
          }
        }
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      logger.error('Unhandled error in dashboard handle()', { error: String(err) });
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  }

  private isHostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    if (hostHeader.startsWith('[')) {
      const closing = hostHeader.indexOf(']');
      if (closing === -1) return false;
      const ipv6 = hostHeader.slice(1, closing).toLowerCase();
      // After ']' must be either end-of-string or a numeric port suffix.
      const after = hostHeader.slice(closing + 1);
      if (after !== '' && !/^:\d+$/.test(after)) return false;
      return ipv6 === '::1' || ipv6 === '0:0:0:0:0:0:0:1';
    }
    const firstColon = hostHeader.indexOf(':');
    const hostOnly = (
      firstColon === -1 ? hostHeader : hostHeader.slice(0, firstColon)
    ).toLowerCase();
    // Reject non-numeric port suffixes — `Host: 127.0.0.1:abc.evil.com` would
    // otherwise pass with hostOnly='127.0.0.1'.
    if (firstColon !== -1) {
      const portStr = hostHeader.slice(firstColon + 1);
      if (portStr === '' || !/^\d+$/.test(portStr)) return false;
    }
    return hostOnly === '127.0.0.1' || hostOnly === 'localhost';
  }
}
