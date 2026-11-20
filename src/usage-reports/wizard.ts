/** The usage-reports question in a terminal: `preflight setup` and `preflight usage-reports enable`. */

import { isCancel, note } from '@clack/prompts';

import { consentSelect } from './consent-prompt.js';
import { VERSION } from '../version.js';
import {
  NEVER_SENT,
  privacyUrl,
  PROMPT_TEXT,
  REPORT_SUMMARY,
  SHOW_COMMAND,
  type PromptSurface,
} from './constants.js';
import { describeReason, resolveUsageReports } from './resolve.js';
import { mayPrompt, readConsent, recordAnswer, recordDismissed, usageReportsDir } from './state.js';

export type TerminalAnswer = 'yes' | 'no' | 'dismissed';

/** What the terminal shows above the question: the report's contents and where to check them. */
export function terminalSummary(version = VERSION): string {
  return [
    'Once a day, Preflight would send the Preflight team at New Relic:',
    ...REPORT_SUMMARY.map((line) => `  • ${line}`),
    NEVER_SENT,
    '',
    `Full list: ${privacyUrl(version)}`,
    `Exact payloads: ${SHOW_COMMAND}`,
  ].join('\n');
}

/**
 * Focus starts on Yes but nothing is chosen, so every answer takes a choice
 * (Space, or y/n) and then Enter. Ctrl-C means "Not now". The caller checks
 * for a terminal first.
 */
export async function askInTerminal(
  surface: PromptSurface,
  dir = usageReportsDir(),
): Promise<TerminalAnswer> {
  note(terminalSummary(), 'Usage statistics');
  const choice = await consentSelect<TerminalAnswer>({
    message: PROMPT_TEXT,
    options: [
      { value: 'yes', label: 'Yes', key: 'y' },
      { value: 'no', label: 'No', key: 'n' },
      { value: 'dismissed', label: 'Not now', hint: 'ask me later' },
    ],
  });
  const answer =
    isCancel(choice) || choice === undefined ? 'dismissed' : (choice as TerminalAnswer);
  if (answer === 'dismissed') recordDismissed(dir, surface);
  else recordAnswer(dir, answer, surface);
  return answer;
}

export const ANSWER_MESSAGES: Record<TerminalAnswer, string> = {
  yes: `Usage reports are on. \`${SHOW_COMMAND}\` prints what's sent, and \`preflight usage-reports disable\` turns them off.`,
  no: "Usage reports are off. Preflight won't ask again.",
  dismissed: 'Not set. `preflight usage-reports enable` turns them on later.',
};

export interface WizardUsageReportsOptions {
  readonly highSecurity: boolean;
  readonly configValue: boolean | undefined;
  readonly print: (msg?: string) => void;
}

/** Runs after the wizard closes its readline interface, so the two never share stdin. */
export async function askUsageReportsInWizard(opts: WizardUsageReportsOptions): Promise<void> {
  const consent = readConsent(usageReportsDir());
  const r = resolveUsageReports({
    highSecurity: opts.highSecurity,
    configValue: opts.configValue,
    consent,
  });
  if (r.reason !== 'unasked') {
    opts.print(`\nUsage reports: ${describeReason(r)}.`);
    return;
  }
  if (!mayPrompt(consent) || !process.stdin.isTTY || !process.stdout.isTTY) return;
  opts.print('');
  opts.print(ANSWER_MESSAGES[await askInTerminal('setup_wizard')]);
}
