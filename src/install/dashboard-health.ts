import { loadMcpConfig } from '../config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Resolves the dashboard's configured host/port, or null if the config
 * can't be loaded (e.g. a cloud-mode config missing credentials). Callers
 * treat null as "skip verification" rather than a hard failure — health
 * verification is a best-effort enhancement, never a new way for a caller
 * to fail.
 */
export function getDashboardAddress(): { host: string; port: number } | null {
  try {
    const config = loadMcpConfig();
    return { host: config.dashboard.host, port: config.dashboard.port };
  } catch {
    return null;
  }
}

/**
 * Polls `GET /api/health` until it reports a healthy, current-version
 * response or `timeoutMs` elapses. Connection errors (server not listening
 * yet) and malformed responses are treated as "not yet" and retried, not as
 * failures. When `expectedVersion` is null, the version check is skipped —
 * any healthy response counts.
 */
export async function waitForHealthyDashboard(
  host: string,
  port: number,
  expectedVersion: string | null,
  timeoutMs = 5000,
  intervalMs = 300,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: unknown; version?: unknown };
        if (body.ok === true && (expectedVersion === null || body.version === expectedVersion)) {
          return true;
        }
      }
    } catch {
      // Not listening yet, or a malformed response — keep polling.
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
