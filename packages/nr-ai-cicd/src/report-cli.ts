#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fetchCurrentMetrics, fetchBaselineMetrics } from './metrics-fetcher.js';
import { formatReport } from './report-formatter.js';

function inferDeveloper(): string {
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  if (process.env.GITHUB_ACTOR) return process.env.GITHUB_ACTOR;
  try {
    return execSync('git config user.name', { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv: string[]): {
  developer: string;
  sinceHours: number;
  failBelow: number | null;
  outputPath: string | null;
} {
  const args = argv.slice(2);
  let developer = inferDeveloper();
  let sinceHours = 24;
  let failBelow: number | null = null;
  let outputPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--developer' && args[i + 1]) {
      developer = args[++i];
    } else if (args[i] === '--since-hours' && args[i + 1]) {
      sinceHours = parseInt(args[++i], 10);
    } else if (args[i] === '--fail-below' && args[i + 1]) {
      failBelow = parseFloat(args[++i]);
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    }
  }

  return { developer, sinceHours, failBelow, outputPath };
}

async function main(): Promise<void> {
  const apiKey = process.env.NEW_RELIC_API_KEY;
  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;

  if (!apiKey) {
    process.stderr.write('Error: NEW_RELIC_API_KEY is required\n');
    process.exit(1);
  }
  if (!accountIdStr) {
    process.stderr.write('Error: NEW_RELIC_ACCOUNT_ID is required\n');
    process.exit(1);
  }

  const accountId = parseInt(accountIdStr, 10);
  const { developer, sinceHours, failBelow, outputPath } = parseArgs(process.argv);

  process.stderr.write(`Fetching metrics for developer "${developer}" (last ${sinceHours}h)...\n`);

  const [current, baseline] = await Promise.all([
    fetchCurrentMetrics(apiKey, accountId, developer, sinceHours),
    fetchBaselineMetrics(apiKey, accountId, developer),
  ]);

  const report = formatReport(current, baseline, sinceHours, developer);

  if (outputPath) {
    writeFileSync(outputPath, report, 'utf-8');
    process.stderr.write(`Report written to ${outputPath}\n`);
  } else {
    process.stdout.write(report + '\n');
  }

  if (failBelow !== null && current.efficiencyScore !== null) {
    if (current.efficiencyScore < failBelow) {
      process.stderr.write(
        `Quality gate failed: efficiency score ${current.efficiencyScore.toFixed(1)} < ${failBelow}\n`,
      );
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
