/**
 * `preflight usage-reports <status|enable|disable|show|reset-id>`.
 *
 * `enable` asks in a terminal, so an assistant running the command through
 * its shell tool (no TTY) can't turn usage reports on.
 */

import { loadMcpConfig, type McpServerConfig } from '../config.js';
import { areHooksInstalledAtAnyScope } from '../install/install-helper.js';
import { SHOW_COMMAND, USAGE_REPORTS_ENDPOINT } from './constants.js';
import { listPending } from './counters.js';
import { detectAdapterName, featureFlags, installInfo } from './install-info.js';
import { buildPreview } from './preview.js';
import { describeReason, resolveUsageReports, USAGE_REPORTS_ENV } from './resolve.js';
import { disable, readConsent, readInstallId, resetInstallId, usageReportsDir } from './state.js';
import { ANSWER_MESSAGES, askInTerminal } from './wizard.js';

const USAGE = `Usage: preflight usage-reports <command>

Commands:
  status     Show whether usage reports are on, and why
  enable     Choose whether to turn usage reports on (needs a terminal)
  disable    Turn usage reports off and delete the install ID, queued data and sent log
  show       Print what would be sent next, and what has been sent
  reset-id   Replace the install ID with a new random one
`;

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function loadConfig(): McpServerConfig | null {
  try {
    return loadMcpConfig(undefined, { resolveSecrets: false });
  } catch (err) {
    out(`Could not load config: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function resolveFor(config: McpServerConfig, dir: string) {
  return resolveUsageReports({
    highSecurity: config.highSecurity,
    configValue: config.usageReports,
    consent: readConsent(dir),
  });
}

function status(config: McpServerConfig, dir: string): number {
  const r = resolveFor(config, dir);
  const consent = readConsent(dir);
  out(`Usage reports: ${describeReason(r)}`);
  if (consent.answer) {
    out(`Answered:      ${consent.answer} on ${consent.answeredAt} (${consent.answerSurface})`);
  } else {
    out(`Prompts left:  ${Math.max(0, 3 - consent.unansweredPrompts)} of 3`);
  }
  out(`Install ID:    ${readInstallId(dir) ?? 'none'}`);
  out(`Queued days:   ${new Set(listPending(dir).map((p) => p.counts.usage_date)).size}`);
  out(`Endpoint:      ${USAGE_REPORTS_ENDPOINT}`);
  out(`What's sent:   ${SHOW_COMMAND}`);
  if (r.reason === 'unasked') {
    out('');
    out('To choose, run `preflight usage-reports enable` or `preflight usage-reports disable`.');
  }
  return 0;
}

async function enable(config: McpServerConfig, dir: string): Promise<number> {
  const r = resolveFor(config, dir);
  if (r.reason !== 'unasked' && r.reason !== 'answer') {
    out(`Usage reports are ${describeReason(r)}. Change that setting first.`);
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    out('`preflight usage-reports enable` needs a terminal to confirm. Run it yourself in one,');
    out(`or set ${USAGE_REPORTS_ENV}=true.`);
    return 1;
  }
  const answer = await askInTerminal('cli_enable', dir);
  out(ANSWER_MESSAGES[answer]);
  return answer === 'yes' ? 0 : 1;
}

function disableReports(config: McpServerConfig, dir: string): number {
  const r = resolveFor(config, dir);
  // An env var or config key that turns reports on outranks a recorded "no".
  if (r.enabled && r.reason !== 'answer') {
    out(`Usage reports are ${describeReason(r)}. Change that setting to turn them off.`);
    return 1;
  }
  disable(dir);
  out('Usage reports are off. The install ID, queued data and sent log are deleted.');
  return 0;
}

function show(config: McpServerConfig, dir: string): number {
  const preview = buildPreview(dir, {
    install: installInfo(config, detectAdapterName(), areHooksInstalledAtAnyScope()),
    features: featureFlags(config),
  });
  out(`Usage reports: ${describeReason(resolveFor(config, dir))}`);
  out('');
  out('Start report (sent once a day by the first Preflight process):');
  for (const e of preview.start) out('  ' + JSON.stringify(e));
  out('');
  out(preview.queued.length ? 'Queued daily summaries:' : 'Queued daily summaries: none');
  for (const day of preview.queued) {
    out(`  ${day.date}${day.today ? ' (today, still counting)' : ''}`);
    for (const e of day.events) out('    ' + JSON.stringify(e));
  }
  out('');
  if (preview.sentTotal === 0) {
    out('Sent: nothing yet');
    return 0;
  }
  out(`Sent (${preview.sentTotal} events, newest last):`);
  for (const entry of preview.sent) out('  ' + JSON.stringify(entry));
  return 0;
}

export async function runUsageReportsCli(args: readonly string[]): Promise<number> {
  // Keep the config loader's info logs out of the command's output.
  process.env.NEW_RELIC_AI_LOG_LEVEL ??= 'warn';
  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(USAGE);
    return command ? 0 : 1;
  }
  const config = loadConfig();
  if (!config) return 1;
  const dir = usageReportsDir(config.storagePath);
  switch (command) {
    case 'status':
      return status(config, dir);
    case 'enable':
      return enable(config, dir);
    case 'disable':
      return disableReports(config, dir);
    case 'show':
      return show(config, dir);
    case 'reset-id':
      if (!readInstallId(dir)) {
        out('No install ID to reset. One is created only when usage reports are on.');
        return 0;
      }
      out(`New install ID: ${resetInstallId(dir)}`);
      return 0;
    default:
      out(`Unknown command: ${command}\n`);
      out(USAGE);
      return 1;
  }
}
