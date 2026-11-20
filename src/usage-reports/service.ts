/**
 * The running server's view of usage reports: counts, the reporting timer,
 * and the MCP consent form. One instance per server process.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { createLogger } from '../core/index.js';
import { VERSION } from '../version.js';
import type { McpServerConfig } from '../config.js';
import {
  FIELD_LIST_VERSION,
  PENDING_FLUSH_INTERVAL_MS,
  privacyUrl,
  PROMPT_TEXT,
  REPORT_INTERVAL_MS,
  SHOW_COMMAND,
  type PromptSurface,
} from './constants.js';
import { UsageCounters } from './counters.js';
import { featureFlags, installInfo } from './install-info.js';
import { buildPreview, type UsageReportsPreview } from './preview.js';
import { runReportTick, type TickResult } from './reporter.js';
import {
  clientCantShowForms,
  describeReason,
  isDebug,
  resolveUsageReports,
  type UsageReportsResolution,
} from './resolve.js';
import { UsageReportSender } from './sender.js';
import {
  deleteLocalData,
  getOrCreateInstallId,
  mayPrompt,
  readConsent,
  recordAnswer,
  recordDismissed,
  usageReportsDir,
} from './state.js';

const logger = createLogger('usage-reports');

const RESOLUTION_TTL_MS = 60_000;
const FORM_TIMEOUT_MS = 10 * 60_000;
/**
 * An answer faster than this didn't come from a person reading the form. Some
 * clients declare form support but answer every form at once without showing
 * it (anthropics/claude-code#89858, #98256), and a hook or auto-approve could
 * accept it; those answer in milliseconds. It's kept short so a person who
 * already knows their answer isn't ignored, which means an Enter typed for the
 * prompt just after the form opens can still count as Accept.
 */
const MIN_HUMAN_ANSWER_MS = 300;

/**
 * The form has no fields: Claude Code folds a choice field behind an expand
 * arrow, so the form's own buttons are the answer. Accept is Yes, Decline is
 * No, and Esc is "Not now". Claude Code shows four message lines, cutting each
 * at the window's edge, and folds any more behind "(+N more lines)" with no way
 * to expand them, so it's four lines that fit in 80 columns. The field list
 * doesn't fit; the link and the show command lead to it.
 */
const FORM_MESSAGE = [
  PROMPT_TEXT,
  'Accept to share, Decline not to, Esc to decide later.',
  `Never your code or prompts. Exact payloads: ${SHOW_COMMAND}`,
  privacyUrl(VERSION, false),
].join('\n');

/**
 * When to open the form after the client connects. A client cancels a form it
 * isn't ready to show (Claude Code does before its UI is up), so an instant
 * cancel tries again at the next delay.
 */
const STARTUP_FORM_DELAYS_MS = [3_000, 5_000, 10_000];

export type FormOutcome = 'yes' | 'no' | 'dismissed' | 'unsupported' | 'not_shown' | 'not_asked';

export interface UsageReportsServiceOptions {
  readonly config: McpServerConfig;
  readonly adapterName: () => string | undefined;
  readonly hooksInstalled: () => boolean;
}

/**
 * Claude Code sets CLAUDE_CODE_ENTRYPOINT to `sdk-*` for `-p` and SDK runs,
 * where no person sees a form. Copilot autopilot isn't detectable yet.
 */
export function isNonInteractiveSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const entry = env.CLAUDE_CODE_ENTRYPOINT;
  return typeof entry === 'string' && entry.startsWith('sdk');
}

export class UsageReportsService {
  readonly dir: string;
  readonly sessionId = randomUUID();
  private readonly counters: UsageCounters;
  private readonly sender: UsageReportSender;
  private resolution: UsageReportsResolution;
  private resolvedAt = 0;
  private askedThisSession = false;
  private startupFormTimer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private reportTimer: NodeJS.Timeout | undefined;
  private ticking: Promise<TickResult | null> | null = null;

  constructor(private readonly opts: UsageReportsServiceOptions) {
    this.dir = usageReportsDir(opts.config.storagePath);
    this.counters = new UsageCounters(this.dir, this.sessionId, opts.config.dashboard.openOnStart);
    this.sender = new UsageReportSender({ dir: this.dir, debug: isDebug() });
    this.resolution = this.resolveNow();
  }

  private resolveNow(): UsageReportsResolution {
    this.resolvedAt = Date.now();
    return resolveUsageReports({
      highSecurity: this.opts.config.highSecurity,
      configValue: this.opts.config.usageReports,
      consent: readConsent(this.dir),
    });
  }

  /** Re-reads consent at most once a minute, since another process or the CLI may change it. */
  status(): UsageReportsResolution {
    if (Date.now() - this.resolvedAt > RESOLUTION_TTL_MS) this.refresh();
    return this.resolution;
  }

  describe(): string {
    return describeReason(this.status());
  }

  private refresh(): void {
    const before = this.resolution.enabled;
    this.resolution = this.resolveNow();
    if (before !== this.resolution.enabled) {
      // Nothing counted before consent is ever sent, and nothing is kept after it ends.
      this.counters.clear();
      if (this.resolution.enabled) {
        this.counters.touch();
        void this.tick();
      } else {
        deleteLocalData(this.dir);
      }
    }
  }

  start(): void {
    if (this.status().enabled) this.counters.touch();
    this.flushTimer = setInterval(() => this.flush(), PENDING_FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    this.reportTimer = setInterval(() => void this.tick(), REPORT_INTERVAL_MS);
    this.reportTimer.unref?.();
    // The first pass waits briefly so the adapter and hook detection settle.
    const first = setTimeout(() => void this.tick(), 30_000);
    first.unref?.();
    logger.info('Usage reports', { status: this.describe() });
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    if (this.startupFormTimer) clearTimeout(this.startupFormTimer);
    this.flush();
  }

  private flush(): void {
    if (!this.status().enabled) return;
    try {
      this.counters.flush();
    } catch (err) {
      logger.debug('Could not write pending usage counts', { error: String(err) });
    }
  }

  async tick(): Promise<TickResult | null> {
    if (this.ticking) return this.ticking;
    if (!this.status().enabled) return null;
    this.ticking = (async () => {
      try {
        this.flush();
        const consent = readConsent(this.dir);
        return await runReportTick(this.dir, this.sender, this.reportInputs(), {
          installId: getOrCreateInstallId(this.dir),
          sessionId: this.sessionId,
          fieldListVersion: consent.fieldListVersion ?? FIELD_LIST_VERSION,
        });
      } catch (err) {
        logger.debug('Usage report pass failed', { error: String(err) });
        return null;
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  recordToolCall(toolName: string): void {
    if (this.status().enabled) this.counters.recordToolCall(toolName);
  }

  recordPageLoad(): void {
    if (this.status().enabled) this.counters.recordPageLoad();
  }

  recordLiveConnection(): void {
    if (this.status().enabled) this.counters.recordLiveConnection();
  }

  /** Answer from a surface inside this process (the dashboard banner). */
  answer(answer: 'yes' | 'no' | 'dismissed', surface: PromptSurface): void {
    if (answer === 'dismissed') recordDismissed(this.dir, surface);
    else recordAnswer(this.dir, answer, surface);
    this.refresh();
  }

  /** What `preflight usage-reports show` prints, for the dashboard. */
  preview(): UsageReportsPreview {
    this.flush();
    return buildPreview(this.dir, this.reportInputs());
  }

  private reportInputs() {
    return {
      install: installInfo(this.opts.config, this.opts.adapterName(), this.opts.hooksInstalled()),
      features: featureFlags(this.opts.config),
    };
  }

  /** Unasked, under the prompt limit, and no other rule decides it. */
  canAsk(): boolean {
    return this.status().reason === 'unasked' && mayPrompt(readConsent(this.dir));
  }

  /**
   * The consent form at session start, opened by the server itself once the
   * client has connected, so the assistant plays no part in it.
   */
  askWhenClientIsReady(server: Server, delays: readonly number[] = STARTUP_FORM_DELAYS_MS): void {
    const attempt = (i: number): void => {
      const delay = delays[i];
      if (delay === undefined) return;
      this.startupFormTimer = setTimeout(() => {
        if (this.askedThisSession) return;
        // Not initialized yet: try at the next delay.
        if (!server.getClientCapabilities()) return attempt(i + 1);
        void this.askWithForm(server, 'session_start_form').then((outcome) => {
          if (outcome !== 'not_shown') return;
          this.askedThisSession = false;
          attempt(i + 1);
        });
      }, delay);
      this.startupFormTimer.unref();
    };
    attempt(0);
  }

  /**
   * The consent form at the first Preflight tool call. At most once per
   * session; never awaited by the tool call it rides on.
   */
  maybeAskAtToolCall(server: Server): void {
    if (this.askedThisSession || !this.canAsk() || isNonInteractiveSession()) return;
    if (!server.getClientCapabilities()?.elicitation || clientCantShowForms()) return;
    this.askedThisSession = true;
    void this.askWithForm(server, 'tool_call_form').then((outcome) => {
      // Not shown (the client wasn't ready): a later call or the startup form may ask.
      if (outcome === 'not_shown') this.askedThisSession = false;
    });
  }

  /**
   * Opens the form and records the person's answer. The caller never sees or
   * sets it. A form the client answered too fast to have shown isn't recorded,
   * so it doesn't use up one of the person's prompts.
   */
  async askWithForm(server: Server, surface: PromptSurface): Promise<FormOutcome> {
    if (!this.canAsk() || isNonInteractiveSession()) return 'not_asked';
    if (!server.getClientCapabilities()?.elicitation || clientCantShowForms()) {
      return 'unsupported';
    }
    this.askedThisSession = true;
    const sentAt = Date.now();
    let outcome: 'yes' | 'no' | 'dismissed';
    try {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message: FORM_MESSAGE,
          requestedSchema: { type: 'object', properties: {} },
        },
        { timeout: FORM_TIMEOUT_MS },
      );
      if (Date.now() - sentAt < MIN_HUMAN_ANSWER_MS) {
        logger.info('The client answered the usage reports form without showing it', {
          action: result.action,
        });
        return 'not_shown';
      }
      outcome =
        result.action === 'accept' ? 'yes' : result.action === 'decline' ? 'no' : 'dismissed';
    } catch (err) {
      logger.debug('Usage reports form failed or timed out', { error: String(err) });
      outcome = 'dismissed';
    }
    this.answer(outcome, surface);
    return outcome;
  }
}
