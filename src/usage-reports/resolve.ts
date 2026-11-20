/**
 * Whether usage reports are on, and why. Checked in a fixed order; the first
 * rule that applies wins. With none of them, the install is unasked and
 * sends nothing.
 */

import type { ConsentState } from './state.js';

export type UsageReportsReason =
  'high_security' | 'do_not_track' | 'env' | 'ci' | 'config' | 'answer' | 'unasked';

export interface UsageReportsResolution {
  readonly enabled: boolean;
  readonly reason: UsageReportsReason;
}

export interface ResolveInputs {
  readonly highSecurity: boolean;
  /** `usageReports` from config.json, if it's a boolean. */
  readonly configValue: boolean | undefined;
  readonly consent: ConsentState;
  readonly env?: NodeJS.ProcessEnv;
}

export const USAGE_REPORTS_ENV = 'NEW_RELIC_AI_USAGE_REPORTS';
export const USAGE_REPORTS_DEBUG_ENV = 'NEW_RELIC_AI_USAGE_REPORTS_DEBUG';

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  const v = value.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

// CI vendors that don't set `CI` (or set it inconsistently).
const CI_VENDOR_VARS = [
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'TF_BUILD',
  'BITBUCKET_BUILD_NUMBER',
  'CODEBUILD_BUILD_ID',
  'DRONE',
] as const;

export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (truthy(env.CI)) return true;
  return CI_VENDOR_VARS.some((name) => env[name] !== undefined && env[name] !== '');
}

export function resolveUsageReports(inputs: ResolveInputs): UsageReportsResolution {
  const env = inputs.env ?? process.env;
  if (inputs.highSecurity) return { enabled: false, reason: 'high_security' };
  if (truthy(env.DO_NOT_TRACK)) return { enabled: false, reason: 'do_not_track' };
  const fromEnv = parseBoolEnv(env[USAGE_REPORTS_ENV]);
  if (fromEnv !== undefined) return { enabled: fromEnv, reason: 'env' };
  if (isCi(env)) return { enabled: false, reason: 'ci' };
  if (inputs.configValue !== undefined) return { enabled: inputs.configValue, reason: 'config' };
  if (inputs.consent.answer !== null) {
    return { enabled: inputs.consent.answer === 'yes', reason: 'answer' };
  }
  return { enabled: false, reason: 'unasked' };
}

export function isDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env[USAGE_REPORTS_DEBUG_ENV]);
}

export function describeReason(r: UsageReportsResolution): string {
  switch (r.reason) {
    case 'high_security':
      return 'off: highSecurity is on';
    case 'do_not_track':
      return 'off: DO_NOT_TRACK is set';
    case 'env':
      return `${r.enabled ? 'on' : 'off'}: set by ${USAGE_REPORTS_ENV}`;
    case 'ci':
      return `off: running in CI (set ${USAGE_REPORTS_ENV}=true to override)`;
    case 'config':
      return `${r.enabled ? 'on' : 'off'}: set by usageReports in config.json`;
    case 'answer':
      return r.enabled ? 'on: you said yes' : 'off: you said no';
    case 'unasked':
      return 'not set: nothing is sent until you choose';
  }
}

/**
 * The Claude desktop app sets CLAUDE_CODE_ENTRYPOINT to `claude-desktop*`. It
 * declares form support but cancels every form unseen (anthropics/claude-code#89858).
 */
export function clientCantShowForms(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_ENTRYPOINT?.startsWith('claude-desktop') === true;
}
