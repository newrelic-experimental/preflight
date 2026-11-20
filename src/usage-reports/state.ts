/**
 * Local usage-reports state: the consent record and the install ID.
 *
 * Imports only Node builtins, because the hook collector reads it on every
 * SessionStart and must stay cheap.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { FIELD_LIST_VERSION, MAX_UNANSWERED_PROMPTS, type PromptSurface } from './constants.js';

export type ConsentAnswer = 'yes' | 'no';
export type PromptOutcome = 'yes' | 'no' | 'dismissed';

export interface PromptLogEntry {
  readonly surface: PromptSurface;
  readonly at: string;
  readonly outcome: PromptOutcome;
}

export interface ConsentState {
  readonly answer: ConsentAnswer | null;
  readonly answeredAt: string | null;
  readonly answerSurface: PromptSurface | null;
  /** The field list the answer covered. Fields added later aren't sent. */
  readonly fieldListVersion: number | null;
  readonly unansweredPrompts: number;
  readonly promptLog: readonly PromptLogEntry[];
}

const EMPTY_STATE: ConsentState = {
  answer: null,
  answeredAt: null,
  answerSurface: null,
  fieldListVersion: null,
  unansweredPrompts: 0,
  promptLog: [],
};

const PROMPT_LOG_CAP = 20;

/** `<storage>/usage-reports`, where storage follows the same env override as the server. */
export function usageReportsDir(storagePath?: string): string {
  const base =
    storagePath ??
    process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ??
    join(homedir(), '.newrelic-preflight');
  return join(base, 'usage-reports');
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write via a temp file and rename, so readers never see a half-written file. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
  renameSync(tmp, path);
}

function consentPath(dir: string): string {
  return join(dir, 'consent.json');
}

function installIdPath(dir: string): string {
  return join(dir, 'install-id');
}

/** A copy of every event sent, for `preflight usage-reports show`. */
export function sentLogPath(dir: string): string {
  return join(dir, 'sent.log');
}

export function readConsent(dir: string): ConsentState {
  try {
    const raw = JSON.parse(readFileSync(consentPath(dir), 'utf-8')) as Partial<ConsentState>;
    return {
      ...EMPTY_STATE,
      ...raw,
      answer: raw.answer === 'yes' || raw.answer === 'no' ? raw.answer : null,
      promptLog: Array.isArray(raw.promptLog) ? raw.promptLog : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

function writeConsent(dir: string, state: ConsentState): void {
  ensureDir(dir);
  writeFileAtomic(consentPath(dir), JSON.stringify(state, null, 2) + '\n');
}

function appendLog(state: ConsentState, entry: PromptLogEntry): readonly PromptLogEntry[] {
  return [...state.promptLog, entry].slice(-PROMPT_LOG_CAP);
}

/**
 * Record a person's answer. "yes" creates the install ID; "no" is final and
 * deletes any ID and queued data.
 */
export function recordAnswer(dir: string, answer: ConsentAnswer, surface: PromptSurface): void {
  const current = readConsent(dir);
  const at = new Date().toISOString();
  writeConsent(dir, {
    ...current,
    answer,
    answeredAt: at,
    answerSurface: surface,
    fieldListVersion: answer === 'yes' ? FIELD_LIST_VERSION : null,
    promptLog: appendLog(current, { surface, at, outcome: answer }),
  });
  if (answer === 'yes') {
    getOrCreateInstallId(dir);
  } else {
    deleteLocalData(dir);
  }
}

/** A prompt was shown and closed or ignored without an answer. */
export function recordDismissed(dir: string, surface: PromptSurface): void {
  const current = readConsent(dir);
  writeConsent(dir, {
    ...current,
    unansweredPrompts: current.unansweredPrompts + 1,
    promptLog: appendLog(current, {
      surface,
      at: new Date().toISOString(),
      outcome: 'dismissed',
    }),
  });
}

/** Unasked, and under the unanswered-prompt limit. */
export function mayPrompt(state: ConsentState): boolean {
  return state.answer === null && state.unansweredPrompts < MAX_UNANSWERED_PROMPTS;
}

export function readInstallId(dir: string): string | null {
  try {
    const id = readFileSync(installIdPath(dir), 'utf-8').trim();
    return /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function getOrCreateInstallId(dir: string): string {
  const existing = readInstallId(dir);
  if (existing) return existing;
  ensureDir(dir);
  const id = randomUUID();
  writeFileAtomic(installIdPath(dir), id + '\n');
  return id;
}

export function resetInstallId(dir: string): string {
  rmSync(installIdPath(dir), { force: true });
  return getOrCreateInstallId(dir);
}

/**
 * Remove the install ID, everything queued or claimed, and the log of sent
 * events, which holds the ID. Keeps consent.json, the person's answer.
 */
export function deleteLocalData(dir: string): void {
  rmSync(installIdPath(dir), { force: true });
  rmSync(sentLogPath(dir), { force: true });
  rmSync(join(dir, 'pending'), { recursive: true, force: true });
  rmSync(join(dir, 'claims'), { recursive: true, force: true });
}

/** Turn usage reports off: a final "no" from the CLI. */
export function disable(dir: string): void {
  recordAnswer(dir, 'no', 'cli_disable');
}

export function hasConsentFile(dir: string): boolean {
  return existsSync(consentPath(dir));
}
