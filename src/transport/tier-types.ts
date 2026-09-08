/**
 * Multi-tier telemetry routing — shared types, the event-type inventory, and
 * the sensitivity categorization that `validateTiers()` warns against.
 */

import { resolve } from 'node:path';

import { createLogger } from '../shared/index.js';

const logger = createLogger('tier-types');

/**
 * Every `eventType` string `NrIngestManager` can emit today (14 values).
 *
 * When a new event type is added to `nr-ingest.ts` (or to the
 * `auditRecordToNrEvent` / `securityAlertToNrEvent` serializers in
 * `src/security/`), add it here AND to `EVENT_TYPE_SENSITIVITY` below —
 * `EVENT_TYPE_SENSITIVITY`'s `Record<KnownEventType, ...>` type makes the
 * second half a compile error if you forget. An event type missing from this
 * list is not silently dropped: `TierRouter` still delivers it to every
 * wildcard (`['*']`) tier, but it cannot be named explicitly in a tier's
 * `eventTypes` array (`validateTiers()` rejects unknown names).
 */
export const KNOWN_EVENT_TYPES = [
  'AiToolCall',
  'AiMcpToolCall',
  'AiProxyRequest',
  'AiCodingTask',
  'AiWorkflowRun',
  'AiSubagentTurn',
  'AiObservabilityHealth',
  'AiAntiPattern',
  'AiRetryAlert',
  'AiTurnCost',
  'AiContextSnapshot',
  'AiBudgetWarning',
  'AiAuditEvent',
  'SecurityAlert',
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

/**
 * `safe-shared` — aggregated counts/durations/costs only; no raw file paths,
 * commands, or user-authored text.
 * `personal-only` — carries raw or lightly-redacted per-call detail (bash
 * commands, file paths, agent descriptions, audit-trail specifics).
 */
export type EventSensitivity = 'safe-shared' | 'personal-only';

export const EVENT_TYPE_SENSITIVITY: Readonly<Record<KnownEventType, EventSensitivity>> = {
  AiProxyRequest: 'safe-shared',
  AiCodingTask: 'safe-shared',
  AiSubagentTurn: 'safe-shared',
  AiRetryAlert: 'safe-shared',
  AiTurnCost: 'safe-shared',
  AiContextSnapshot: 'safe-shared',
  AiBudgetWarning: 'safe-shared',
  AiObservabilityHealth: 'safe-shared',
  AiToolCall: 'personal-only',
  AiMcpToolCall: 'personal-only',
  AiWorkflowRun: 'personal-only',
  AiAntiPattern: 'personal-only',
  AiAuditEvent: 'personal-only',
  SecurityAlert: 'personal-only',
};

export const SAFE_SHARED_EVENT_TYPES: readonly KnownEventType[] = KNOWN_EVENT_TYPES.filter(
  (eventType) => EVENT_TYPE_SENSITIVITY[eventType] === 'safe-shared',
);

export const PERSONAL_ONLY_EVENT_TYPES: readonly KnownEventType[] = KNOWN_EVENT_TYPES.filter(
  (eventType) => EVENT_TYPE_SENSITIVITY[eventType] === 'personal-only',
);

/**
 * Name of the implicit tier synthesized when no `tiers` array is configured.
 * Also the one tier name `validateTiers()` does NOT warn about when it carries
 * `personal-only` event types — it is by definition the operator's own account.
 */
export const DEFAULT_TIER_NAME = 'default';

/** `eventTypes: ['*']` routes every event type, known or not, to a tier. */
export const WILDCARD_EVENT_TYPE = '*';

/**
 * Where one tier delivers. `nr` is a New Relic account (its own
 * `HarvestScheduler`); `local` is a directory on disk (its own
 * `TierLocalWriter`, JSONL append).
 */
export type TierDestination =
  | { readonly type: 'nr'; readonly licenseKey: string; readonly accountId: string }
  | { readonly type: 'local'; readonly path: string };

/** A tier after `validateTiers()` has checked and normalized it. */
export interface ResolvedTier {
  readonly name: string;
  readonly destination: TierDestination;
  /** Either `['*']` or a de-duplicated list of `KNOWN_EVENT_TYPES` members. */
  readonly eventTypes: readonly string[];
}

// ---------------------------------------------------------------------------
// validateTiers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDestination(raw: unknown, tierName: string): TierDestination {
  if (!isRecord(raw)) {
    throw new Error(
      `Tier "${tierName}" is missing a destination object. ` +
        `Expected { "type": "nr", "licenseKey": "...", "accountId": "..." } or { "type": "local", "path": "..." }.`,
    );
  }

  if (raw.type === 'nr') {
    // Deliberately never interpolate the licenseKey value into the message —
    // config-load errors surface on stderr and in support pastes.
    if (typeof raw.licenseKey !== 'string' || raw.licenseKey.trim() === '') {
      throw new Error(`Tier "${tierName}" destination.type='nr' requires a non-empty licenseKey.`);
    }
    if (typeof raw.accountId !== 'string' || !/^\d{1,12}$/.test(raw.accountId)) {
      throw new Error(
        `Tier "${tierName}" destination.accountId must be 1–12 decimal digits (as a JSON string).`,
      );
    }
    return { type: 'nr', licenseKey: raw.licenseKey, accountId: raw.accountId };
  }

  if (raw.type === 'local') {
    if (typeof raw.path !== 'string' || raw.path.trim() === '') {
      throw new Error(`Tier "${tierName}" destination.type='local' requires a non-empty path.`);
    }
    // Normalize to an absolute path so a relative value doesn't silently
    // follow the process cwd (which differs between --stdio and --local).
    return { type: 'local', path: resolve(raw.path) };
  }

  throw new Error(
    `Tier "${tierName}" destination.type must be 'nr' or 'local'. Received: ${JSON.stringify(raw.type)}`,
  );
}

function validateEventTypes(
  raw: unknown,
  tierName: string,
  known: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Tier "${tierName}" requires a non-empty eventTypes array (use ["*"] to route every event type).`,
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`Tier "${tierName}" eventTypes entries must be non-empty strings.`);
    }
    if (entry !== WILDCARD_EVENT_TYPE && !known.has(entry)) {
      throw new Error(
        `Tier "${tierName}" lists unknown event type "${entry}". ` +
          `Known event types: ${[...known].join(', ')} (or "${WILDCARD_EVENT_TYPE}" for all).`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * Validate and normalize a raw `tiers` array from the config file.
 *
 * Throws (fail-fast at config load, matching the licenseKey/accountId/
 * homelabServerUrl convention in `loadMcpConfig()`) on: an empty array, a
 * non-object entry, a blank or duplicate name, an unknown destination type,
 * an `nr` destination missing `licenseKey`/`accountId`, a `local` destination
 * missing `path`, an empty or unknown-valued `eventTypes`, or an array with no
 * `nr`-type tier at all (the primary tier carries the aggregated Metric API
 * and NR Logs API streams, so at least one is required).
 *
 * WARNS but never blocks when a `personal-only` event type is routed to any
 * tier other than `DEFAULT_TIER_NAME` — routing sensitive data broadly stays a
 * deliberate, informed operator choice.
 */
export function validateTiers(
  tiers: readonly unknown[],
  knownEventTypes: readonly string[] = KNOWN_EVENT_TYPES,
): ResolvedTier[] {
  if (tiers.length === 0) {
    throw new Error(
      'tiers must contain at least one tier. Remove the "tiers" key entirely to use the ' +
        'implicit default tier built from licenseKey/accountId.',
    );
  }

  const known = new Set(knownEventTypes);
  const seenNames = new Set<string>();
  const resolved: ResolvedTier[] = [];

  // The primary tier is the FIRST nr-type tier in array order — it alone
  // carries the aggregated Metric API stream, NR Logs API audit entries,
  // OTLP export, and event-send-health counters, regardless of its own
  // eventTypes. Tracked as we walk `tiers` in order so the wildcard warning
  // below can exempt it (see the primary-tier warning after the loop).
  let primaryTierName: string | undefined;

  for (let i = 0; i < tiers.length; i++) {
    const raw = tiers[i];
    if (!isRecord(raw)) {
      throw new Error(`tiers[${i}] must be an object with name, destination, and eventTypes.`);
    }

    const name = raw.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`tiers[${i}].name must be a non-empty string.`);
    }
    if (seenNames.has(name)) {
      throw new Error(`Duplicate tier name "${name}". Tier names must be unique.`);
    }
    seenNames.add(name);

    const destination = validateDestination(raw.destination, name);
    const eventTypes = validateEventTypes(raw.eventTypes, name, known);

    const isPrimaryTier = destination.type === 'nr' && primaryTierName === undefined;
    if (isPrimaryTier) primaryTierName = name;

    if (name !== DEFAULT_TIER_NAME) {
      for (const eventType of eventTypes) {
        if (eventType === WILDCARD_EVENT_TYPE) {
          // A wildcard on the operator's own primary tier is expected —
          // being primary is itself flagged by the dedicated warning below,
          // regardless of eventTypes. Only warn here for a non-primary tier.
          if (!isPrimaryTier) {
            logger.warn(
              'Tier routes ALL event types — including personal-only ones — to a non-default destination',
              { tier: name, personalOnlyEventTypes: [...PERSONAL_ONLY_EVENT_TYPES] },
            );
          }
          continue;
        }
        if (EVENT_TYPE_SENSITIVITY[eventType as KnownEventType] === 'personal-only') {
          logger.warn('Tier routes a personal-only event type to a non-default destination', {
            tier: name,
            eventType,
            sensitivity: 'personal-only',
          });
        }
      }
    }

    resolved.push({ name, destination, eventTypes });
  }

  if (!resolved.some((tier) => tier.destination.type === 'nr')) {
    throw new Error(
      "At least one tier must have destination.type='nr' — the aggregated Metric API stream " +
        'and NR Logs API audit entries are delivered through the first nr-type tier (the primary tier).',
    );
  }

  if (primaryTierName !== undefined && primaryTierName !== DEFAULT_TIER_NAME) {
    logger.warn(
      'Primary tier is not named "default" — it carries the aggregated Metric API stream, ' +
        'NR Logs API audit entries (file_path/command/redacted detail), OTLP export, and ' +
        'event-send-health counters regardless of its own eventTypes',
      { tier: primaryTierName },
    );
  }

  return resolved;
}
