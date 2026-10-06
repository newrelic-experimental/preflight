import { sep } from 'node:path';

export const HOMEBREW_UPGRADE_COMMAND = 'brew upgrade preflight';

/**
 * Whether `packageRoot` (the realpath'd package directory, as `findRepoRoot()`
 * returns it) is a Homebrew keg. The formula installs with `std_npm_args`,
 * which puts the package at
 * `<cellar>/preflight/<version>/libexec/lib/node_modules/@newrelic/preflight`
 * — `<cellar>` is `/opt/homebrew/Cellar`, `/usr/local/Cellar`, or
 * `/home/linuxbrew/.linuxbrew/Cellar`, so only the segments after it are
 * matched.
 */
export function isHomebrewInstall(packageRoot: string): boolean {
  const parts = packageRoot.split(sep);
  const cellar = parts.lastIndexOf('Cellar');
  return cellar !== -1 && parts[cellar + 1] === 'preflight' && parts[cellar + 3] === 'libexec';
}
