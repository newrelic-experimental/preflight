/**
 * Multi-tier telemetry routing — shared types, the event-type inventory, and
 * the sensitivity categorization that `validateTiers()` warns against.
 *
 * See docs/superpowers/specs/2026-09-06-multi-tier-telemetry-design.md.
 */

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
