import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardServer } from './dashboard-server.js';
import { LiveEventBus } from './live-event-bus.js';
import { LocalAlertEngine } from '../alerts/local-alert-engine.js';
import { AlertLog } from '../alerts/alert-log.js';

describe('DashboardServer', () => {
  let server: DashboardServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('starts on the configured port and 127.0.0.1', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
  });

  it('responds 404 to unknown paths', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('responds 200 to GET /api/health with JSON', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });

  it('includes the package version in /api/health', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    const body = await res.json();
    // Use a regex rather than pinning the exact string so this test
    // does not break on each version bump. Health metadata should
    // always be a semver-shaped string.
    expect(typeof body.version).toBe('string');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('stop() closes the server cleanly', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    await server.stop();
    await expect(fetch(`http://127.0.0.1:${addr.port}/api/health`)).rejects.toThrow();
  });
});

describe('DashboardServer Host validation', () => {
  let server: DashboardServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('rejects requests with a non-loopback Host header', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const status = await new Promise<number>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/api/health',
        method: 'GET',
        headers: { host: 'evil.example.com' },
      }, (res) => {
        resolve(res.statusCode ?? 500);
        res.on('data', () => {});
      });
      req.end();
    });
    expect(status).toBe(403);
  });

  it('accepts requests with Host=127.0.0.1:<port>', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it('accepts requests with Host=localhost:<port>', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://localhost:${addr.port}/api/health`);
    expect(res.status).toBe(200);
  });

  // I12: IPv6 Host header validation. The legacy parser used .split(':')[0],
  // which treats the leading '[' of [::1]:7777 as the host and rejected
  // every IPv6 form by accident. These tests pin the corrected behavior:
  // bracketed loopback is accepted, bracketed non-loopback is rejected,
  // and malformed brackets are rejected.
  function requestWithHost(port: number, hostHeader: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/health',
          method: 'GET',
          headers: { host: hostHeader },
        },
        (res) => {
          resolve(res.statusCode ?? 500);
          res.on('data', () => {});
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('accepts bracketed IPv6 loopback Host=[::1]:<port>', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    expect(await requestWithHost(addr.port, `[::1]:${addr.port}`)).toBe(200);
  });

  it('accepts bracketed long-form IPv6 loopback Host=[0:0:0:0:0:0:0:1]:<port>', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    expect(await requestWithHost(addr.port, `[0:0:0:0:0:0:0:1]:${addr.port}`)).toBe(200);
  });

  it('rejects bracketed non-loopback IPv6 Host=[fe80::1]:<port>', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    expect(await requestWithHost(addr.port, `[fe80::1]:${addr.port}`)).toBe(403);
  });

  it('rejects malformed bracketed Host with no closing bracket', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    expect(await requestWithHost(addr.port, '[::1')).toBe(403);
  });

  it('rejects bracketed Host whose label looks like a v4 loopback string', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    // A bracketed form is reserved for IPv6; "[127.0.0.1]" is not a valid
    // IPv6 loopback and must not be granted access on the v4 allow-list.
    expect(await requestWithHost(addr.port, '[127.0.0.1]:8080')).toBe(403);
  });
});

describe('DashboardServer SSE shutdown', () => {
  let server: DashboardServer;
  afterEach(async () => { await server?.stop(); });

  it('stop() resolves promptly even with an open SSE client', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();

    // Open SSE connection. The server-side response is long-lived; without
    // force-ending it, server.close() would hang past any reasonable timeout.
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/sse',
        method: 'GET',
      }, (res) => {
        res.on('data', () => {});
        if (res.statusCode === 200) resolve();
        else reject(new Error(`SSE returned ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });

    const start = Date.now();
    await server.stop();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('DashboardServer alert wiring', () => {
  let server: DashboardServer;
  let dir: string;
  afterEach(async () => {
    await server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the alert engine and log when provided', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dashboard-alert-'));
    const engine = new LocalAlertEngine();
    const log = new AlertLog({ path: join(dir, 'log.jsonl') });
    server = new DashboardServer({
      port: 0,
      host: '127.0.0.1',
      bus: new LiveEventBus(),
      alertEngine: engine,
      alertLog: log,
    });
    await server.start();
    expect(server.getAlertEngine()).toBe(engine);
    expect(server.getAlertLog()).toBe(log);
  });

  it('returns undefined when alert engine/log are not provided', async () => {
    server = new DashboardServer({
      port: 0,
      host: '127.0.0.1',
      bus: new LiveEventBus(),
    });
    await server.start();
    expect(server.getAlertEngine()).toBeUndefined();
    expect(server.getAlertLog()).toBeUndefined();
  });
});

describe('DashboardServer security headers', () => {
  let server: DashboardServer;
  afterEach(async () => { await server?.stop(); });

  it('sets a strict CSP on every response', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets Referrer-Policy: no-referrer', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
