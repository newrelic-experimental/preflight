/** True when `candidate` (e.g. an npm registry "latest" version) is a newer semver than `installed`. */
export function isNewerVersion(candidate: string, installed: string): boolean {
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

interface NpmRegistryLatestResponse {
  readonly version?: unknown;
}

/** Fetches @newrelic/preflight's "latest" version from the npm registry, or null if unreachable/malformed. */
export async function fetchLatestNpmVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@newrelic/preflight/latest', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NpmRegistryLatestResponse;
    const v = data.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
