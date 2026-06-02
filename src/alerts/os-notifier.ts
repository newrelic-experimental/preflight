import { execFile as nodeExecFile } from 'node:child_process';

import { createLogger } from '../shared/index.js';

const logger = createLogger('os-notifier');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal logger surface — accepts the shared logger or an injected mock.
 */
interface NotifierLogger {
  warn(msg: string, meta?: object): void;
}

/**
 * Subset of `child_process.execFile` we need: pass `(file, args, callback)`.
 * Using a typed alias keeps the public surface small and lets tests inject a
 * jest mock without pulling in the full overloaded signature.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  callback: (
    err: NodeJS.ErrnoException | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

export interface OsNotifierOptions {
  readonly platform?: NodeJS.Platform;
  readonly exec?: ExecFileFn;
  readonly logger?: NotifierLogger;
}

export interface NotifyInput {
  readonly title: string;
  readonly body: string;
}

// Hard cap on visible notification fields. Native channels truncate too —
// keeping ours tighter avoids surprising clipping mid-word and bounds the
// surface we expose to platform shells.
const MAX_FIELD_LENGTH = 120;

// ---------------------------------------------------------------------------
// Sanitisation helpers
// ---------------------------------------------------------------------------

/**
 * Strip characters that are unsafe inside the platform-specific shell-string
 * branches we cannot avoid (osascript script body, PowerShell single-quoted
 * literals). Truncate before returning to keep payloads bounded.
 *
 * Removed:
 *   - control chars (0x00-0x1f, 0x7f)
 *   - double-quote        (osascript script terminator)
 *   - single-quote        (PowerShell literal terminator)
 *   - backslash           (escape sequences)
 *   - backtick            (PowerShell escape character)
 */
function sanitize(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f"'\\`]/g, '')
    .slice(0, MAX_FIELD_LENGTH);
}

// ---------------------------------------------------------------------------
// OsNotifier
// ---------------------------------------------------------------------------

/**
 * Fire OS-level notifications via the native channel for the current
 * platform. All errors are caught and surfaced through the injected logger;
 * `notify()` never rejects.
 */
export class OsNotifier {
  private readonly platform: NodeJS.Platform;
  private readonly exec: ExecFileFn;
  private readonly log: NotifierLogger;

  constructor(opts: OsNotifierOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.exec = opts.exec ?? (nodeExecFile as ExecFileFn);
    this.log = opts.logger ?? logger;
  }

  async notify(input: NotifyInput): Promise<void> {
    const title = sanitize(input.title);
    const body = sanitize(input.body);
    if (!title && !body) {
      this.log.warn('os-notifier: empty title and body after sanitisation', {
        platform: this.platform,
      });
      return;
    }

    try {
      switch (this.platform) {
        case 'darwin':
          await this.notifyDarwin(title, body);
          return;
        case 'linux':
          await this.notifyLinux(title, body);
          return;
        case 'win32':
          await this.notifyWin32(title, body);
          return;
        default:
          this.log.warn('os-notifier: unsupported platform', {
            platform: this.platform,
          });
          return;
      }
    } catch (err) {
      // Defensive: notifyXxx() already routes failures through the logger.
      // Reaching here means an unexpected synchronous throw in our own code.
      this.log.warn('os-notifier: unexpected error', {
        error: err instanceof Error ? err.message : String(err),
        platform: this.platform,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Platform branches
  // ---------------------------------------------------------------------------

  private notifyDarwin(title: string, body: string): Promise<void> {
    // osascript only takes a script string — we cannot avoid interpolation.
    // Sanitisation above strips `"` and `\` so the script body cannot break
    // out of the literal.
    const script = `display notification "${body}" with title "${title}"`;
    return this.run('osascript', ['-e', script]);
  }

  private notifyLinux(title: string, body: string): Promise<void> {
    // notify-send -- <title> <body>. The `--` guard stops a future title
    // starting with `-` from being parsed as a flag.
    return this.run('notify-send', ['--', title, body]);
  }

  private async notifyWin32(title: string, body: string): Promise<void> {
    // First try BurntToast (modern toast notifications). On failure, fall
    // back to a balloon tip via System.Windows.Forms.NotifyIcon. Both
    // commands receive sanitised single-quoted literals.
    const burntToast = `try { New-BurntToastNotification -Text '${title}','${body}' -ErrorAction Stop } catch { exit 1 }`;
    try {
      await this.run('powershell.exe', ['-NoProfile', '-Command', burntToast]);
      return;
    } catch (err) {
      this.log.warn('os-notifier: BurntToast unavailable, falling back to balloon tip', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const balloon = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$n = New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon = [System.Drawing.SystemIcons]::Information;",
      `$n.BalloonTipTitle = '${title}';`,
      `$n.BalloonTipText = '${body}';`,
      '$n.Visible = $true;',
      '$n.ShowBalloonTip(5000);',
      'Start-Sleep -Milliseconds 6000;',
      '$n.Dispose();',
    ].join(' ');

    try {
      await this.run('powershell.exe', ['-NoProfile', '-Command', balloon]);
    } catch (err) {
      this.log.warn('os-notifier: balloon-tip fallback also failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Process runner
  // ---------------------------------------------------------------------------

  private run(cmd: string, args: readonly string[]): Promise<void> {
    return new Promise((resolveFn, rejectFn) => {
      try {
        this.exec(cmd, args, (err: NodeJS.ErrnoException | null) => {
          if (err) {
            // ENOENT: missing binary (e.g. notify-send not installed).
            // We do NOT log here — the caller decides whether the failure
            // is interesting. notifyDarwin/notifyLinux propagate to the
            // try/catch in notify(); notifyWin32 uses the rejection to
            // pick its fallback.
            rejectFn(err);
            return;
          }
          resolveFn();
        });
      } catch (syncErr) {
        // execFile is documented to be async, but pathological mocks
        // (or genuine OS issues like a too-long argv) can throw
        // synchronously. Treat the same as an async error.
        rejectFn(
          syncErr instanceof Error ? syncErr : new Error(String(syncErr)),
        );
      }
    });
  }
}
