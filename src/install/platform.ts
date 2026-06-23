/**
 * Platform detection utilities for install scripts.
 *
 * These functions detect the runtime environment (native Linux, WSL, macOS,
 * Windows) and resolve cross-environment paths needed to configure
 * Windows-hosted tools (like Claude Code for Windows) from within a WSL shell.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Returns true when the current process is running inside a WSL
 * (Windows Subsystem for Linux) environment.
 */
export function isWsl(): boolean {
  // WSL_DISTRO_NAME is always set in WSL (e.g. "Ubuntu", "Debian").
  if (process.env.WSL_DISTRO_NAME) return true;
  // Fallback: /proc/version contains "microsoft" on WSL 1 and 2.
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Converts a Windows-style path (e.g. `C:\Users\alice`) to its WSL mount
 * equivalent (e.g. `/mnt/c/Users/alice`).
 *
 * Returns null if the input doesn't match a Windows absolute path.
 */
function parseWindowsPath(winPath: string): string | null {
  // Matches "C:\Users\alice" or "C:/Users/alice": drive letter, colon, then
  // a mandatory path separator (backslash or forward slash), then the rest.
  // The separator is consumed so the rest never starts with a slash.
  const match = winPath.match(/^([A-Za-z]):[/\\](.+)/);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  // Normalise the rest: convert backslashes, strip any leading or trailing slashes.
  // A leading slash can appear when the drive separator in the input is doubled
  // (e.g. HOMEDRIVE='C:\' + HOMEPATH='\Users\alice' → 'C:\\Users\alice' → match[2]
  // starts with '\'), which would otherwise produce '/mnt/c//Users/alice' and break
  // the raw-string startsWith check in the writeJsonFile symlink guard.
  const rest = match[2].replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return `/mnt/${drive}/${rest}`;
}

/**
 * When running inside WSL, attempts to resolve the Windows user home directory
 * as a WSL-accessible path (e.g. `/mnt/c/Users/alice`).
 *
 * Returns null if not in WSL, Windows home cannot be determined, or the result
 * cannot be expressed as a valid `/mnt/<drive>/...` path.
 */
export function resolveWindowsHome(): string | null {
  // USERPROFILE is passed through from Windows by default in WSL
  // (e.g. C:\Users\alice).
  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) {
    const wslPath = parseWindowsPath(userProfile);
    if (wslPath) return wslPath;
  }

  // HOMEDRIVE + HOMEPATH is an older but reliable fallback (e.g. C: + \Users\alice).
  // Insert a separator when HOMEPATH lacks a leading backslash (non-standard but possible)
  // so C: + Users\alice becomes C:\Users\alice rather than the unparseable C:Users\alice.
  const homeDrive = process.env.HOMEDRIVE?.trim();
  const homePath = process.env.HOMEPATH?.trim();
  if (homeDrive && homePath) {
    const sep = homePath.startsWith('/') || homePath.startsWith('\\') ? '' : '\\';
    const wslPath = parseWindowsPath(homeDrive + sep + homePath);
    if (wslPath) return wslPath;
  }

  // Last resort: ask cmd.exe (requires WSL interop to be enabled).
  // Pass the full command as one string after /c so cmd.exe expands %USERPROFILE%
  // as part of its own command-line processing (splitting into tokens first would
  // deliver it as a literal argument to echo and suppress expansion).
  try {
    const raw = execFileSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 1000,
    }).trim();
    const wslPath = parseWindowsPath(raw);
    if (wslPath) return wslPath;
  } catch {
    // WSL interop disabled or cmd.exe not available — fall through.
  }

  return null;
}
