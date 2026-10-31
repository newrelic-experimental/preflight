import { closeSync, constants, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SelfReportHookEvent } from '../storage/types.js';
import { isSyntheticSessionId } from './synthetic-session-id.js';

export const REPORT_TOKENS_TOOL_NAME = 'nr_observe_report_tokens';

const MAX_TOKENS = 10_000_000;
const REPORT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const MODEL_RE = /^[a-zA-Z0-9._:-]{1,256}$/;
export const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const PREFIXED_TOOL_RE = new RegExp(`(?:^|[_:./-])${REPORT_TOKENS_TOOL_NAME}$`);
const REQUIRED_COUNTS = ['input_tokens', 'output_tokens'] as const;
const OPTIONAL_COUNTS = ['thinking_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const;
type CountField = (typeof REQUIRED_COUNTS)[number] | (typeof OPTIONAL_COUNTS)[number];

interface SelfReport {
  readonly reportId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

type ParsedSelfReport =
  | { readonly ok: true; readonly report: SelfReport }
  | { readonly ok: false; readonly reason: string };

export function clampToken(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(0, Math.floor(v)), MAX_TOKENS);
}

function isReportTokensTool(name: unknown): boolean {
  return typeof name === 'string' && PREFIXED_TOOL_RE.test(name);
}

function isConversationId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    SESSION_ID_RE.test(id) &&
    id !== 'unknown' &&
    !isSyntheticSessionId(id)
  );
}

function decodeObject(raw: unknown): Record<string, unknown> | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseSelfReport(args: unknown): ParsedSelfReport {
  const fail = (reason: string): ParsedSelfReport => ({ ok: false, reason });
  const a = decodeObject(args);
  if (!a) return fail('arguments are not a JSON object');
  if (typeof a.report_id !== 'string' || !REPORT_ID_RE.test(a.report_id)) {
    return fail('report_id must be 8 to 128 characters of [A-Za-z0-9_-], new for every call');
  }
  if (typeof a.model !== 'string' || !MODEL_RE.test(a.model)) {
    return fail('model must be 1 to 256 characters of [a-zA-Z0-9._:-]');
  }
  const counts = {} as Record<CountField, number>;
  const readCounts = (fields: readonly CountField[], fallback?: number): CountField | undefined => {
    for (const field of fields) {
      const n: unknown = a[field] ?? fallback;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return field;
      counts[field] = clampToken(n);
    }
    return undefined;
  };
  const bad = readCounts(REQUIRED_COUNTS) ?? readCounts(OPTIONAL_COUNTS, 0);
  if (bad) return fail(`${bad} must be a non-negative number`);
  return {
    ok: true,
    report: {
      reportId: a.report_id,
      model: a.model,
      inputTokens: counts.input_tokens,
      outputTokens: counts.output_tokens,
      thinkingTokens: counts.thinking_tokens,
      cacheReadTokens: counts.cache_read_tokens,
      cacheCreationTokens: counts.cache_creation_tokens,
    },
  };
}

function selfReportLine(
  report: SelfReport,
  conversationId: string,
  timestamp: number,
  platform: string | undefined,
): SelfReportHookEvent {
  return {
    mode: 'self_report',
    tool: REPORT_TOKENS_TOOL_NAME,
    timestamp,
    sessionId: conversationId,
    ...report,
    ...(platform !== undefined && { platform }),
  };
}

function hookAcknowledged(result: unknown, reportId: string): boolean {
  const value = decodeObject(result);
  if (!value || value.isError === true) return false;
  const replies = Array.isArray(value.content)
    ? value.content.map((block: unknown) =>
        decodeObject((block as { text?: unknown } | null)?.text),
      )
    : [value];
  return replies.some(
    (reply) =>
      reply?.accepted === true && reply.recorded_by === 'hook' && reply.report_id === reportId,
  );
}

export function hookSelfReportLine(
  toolName: unknown,
  args: unknown,
  result: unknown,
  conversationId: unknown,
  timestamp: number,
  platform: string | undefined,
): SelfReportHookEvent | undefined {
  if (!isReportTokensTool(toolName) || !isConversationId(conversationId)) return undefined;
  const parsed = parseSelfReport(args);
  if (!parsed.ok || !hookAcknowledged(result, parsed.report.reportId)) return undefined;
  return selfReportLine(parsed.report, conversationId, timestamp, platform);
}

function claimPath(storageDir: string, line: SelfReportHookEvent): string {
  return resolve(storageDir, 'self-reports', line.sessionId, line.reportId);
}

export function claimReport(storageDir: string, line: SelfReportHookEvent): boolean {
  const path = claimPath(storageDir, line);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    return true;
  } catch {
    return false;
  }
}

export function releaseReport(storageDir: string, line: SelfReportHookEvent): void {
  try {
    unlinkSync(claimPath(storageDir, line));
  } catch {
    return;
  }
}
