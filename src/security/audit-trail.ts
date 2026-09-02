/**
 * Security Audit Trail — classifies tool calls into audit events, detects
 * sensitive file access and destructive commands, and emits NR events for
 * alerting.
 */

import { createLogger } from '../shared/index.js';
import type { NrEventData } from '../shared/index.js';
import type { ToolCallRecord, AuditEntry } from '../storage/types.js';
import type { ProxyToolCallRecord } from '../proxy/types.js';
import type { LocalStore } from '../storage/local-store.js';
import { redactSensitive } from '../config.js';
import { isSyntheticSessionId } from '../hooks/session-resolver.js';

const logger = createLogger('audit-trail');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'FileRead'
  | 'FileWrite'
  | 'FileEdit'
  | 'BashCommand'
  | 'McpToolCall'
  | 'AgentSpawn'
  | 'Search'
  | 'Other';

export type AlertSeverity = 'critical' | 'high' | 'medium';

export interface SecurityAlert {
  readonly severity: AlertSeverity;
  readonly alertType: string;
  readonly description: string;
}

export interface AuditRecord {
  /** Stable per-call id, sourced from `ToolCallRecord.id`/`ProxyToolCallRecord.id` — lets
   * consumers (e.g. the Audit page's React key) distinguish two entries that otherwise
   * share the same timestamp/tool/detail. */
  readonly id: string;
  readonly timestamp: number;
  readonly sessionId: string | null;
  readonly action: AuditAction;
  readonly tool: string;
  readonly detail: string;
  readonly developer: string;
  readonly filePath?: string;
  readonly command?: string;
  readonly securityAlert?: SecurityAlert;
}

export interface AuditMetrics {
  readonly totalEntries: number;
  readonly securityAlerts: number;
  readonly alertsBySeverity: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Default detection patterns
// ---------------------------------------------------------------------------

export const DEFAULT_SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:^|\/)credentials/i,
  /(?:^|\/)secret/i,
  /\.pem$/i,
  /\.key$/i,
  /(?:^|\/)id_rsa(?:$|\.)/i,
  /(?:^|\/)id_ed25519(?:$|\.)/i,
  /(?:^|\/)\.ssh\//i,
  /(?:^|\/)password(?:s)?(?:\.[^/]*)?$/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.pypirc$/i,
  /(?:^|\/)token(?:s)?(?:\.[^/]*)?$/i,
];

export const DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  // rm with recursive + force flags in any combination or order:
  // combined (-rf, -fr, -rfv, -rvf, -Rf, etc.) or separate (-r -f, -f -r, -r -v -f, etc.)
  // rm with -r/-R (recursive), in any combination of flags or alone
  /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*|-[rR][a-zA-Z]*(?:\s+-[a-zA-Z]+)*\s+-[fF]|-[fF][a-zA-Z]*(?:\s+-[a-zA-Z]+)*\s+-[rR]|-[rR]\b|-[a-zA-Z]*[rR]\b)/,
  // GNU long-form: rm --recursive
  /\brm\b.*--recursive\b/,
  // git push --force / -f, but NOT --force-with-lease / --force-if-includes (the safe forms)
  /\bgit\s+push\s+--force(?!-(?:with-lease|if-includes))\b/i,
  /\bgit\s+push\s+-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bchmod\s+777\b/,
  // Pipe to shell — matches common shells and interpreters
  /\bcurl\b.*\|\s*(?:\/[^\s]*\/)?(?:ba|z|k|da|fi|tc|c)?sh\b/i,
  /\bwget\b.*\|\s*(?:\/[^\s]*\/)?(?:ba|z|k|da|fi|tc|c)?sh\b/i,
  /\bcurl\b.*\|\s*(?:\/[^\s]*\/)?(?:node|python3?|perl|ruby)\b/i,
  /\bwget\b.*\|\s*(?:\/[^\s]*\/)?(?:node|python3?|perl|ruby)\b/i,
];

export const DEFAULT_NETWORK_COMMAND_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b/,
  /\bssh\b/,
];

// ---------------------------------------------------------------------------
// Tool name → AuditAction mapping
// ---------------------------------------------------------------------------

const TOOL_ACTION_MAP: Record<string, AuditAction> = {
  Read: 'FileRead',
  Write: 'FileWrite',
  Edit: 'FileEdit',
  Bash: 'BashCommand',
  Agent: 'AgentSpawn',
  Grep: 'Search',
  Glob: 'Search',
};

function classifyTool(toolName: string): AuditAction {
  return TOOL_ACTION_MAP[toolName] ?? 'Other';
}

// ---------------------------------------------------------------------------
// Detail builder
// ---------------------------------------------------------------------------

function buildDetail(record: ToolCallRecord): string {
  const tool = record.toolName;
  const filePath = record.filePath as string | undefined;
  const command = record.command as string | undefined;
  const agentDescription = record.agentDescription as string | undefined;
  const pattern = record.pattern as string | undefined;

  // Redact at the source so every downstream egress (NR Events API,
  // NR Logs API, persisted on-disk audit log) sees only scrubbed strings.
  // Call-order-independent: this only reads record.filePath/command and
  // returns a new string — it never mutates `record` itself, so
  // detectSecurityAlert() (called separately against the same `record`)
  // still sees the original unredacted values no matter which runs first.
  if (filePath) return `${tool} ${redactSensitive(filePath)}`;
  if (command) return `${tool}: ${redactSensitive(command)}`;
  if (agentDescription) return `${tool}: ${redactSensitive(agentDescription)}`;
  if (pattern) return `${tool}: ${redactSensitive(pattern)}`;
  return tool;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function detectSecurityAlert(
  record: ToolCallRecord,
  sensitivePatterns: readonly RegExp[],
  destructivePatterns: readonly RegExp[],
  networkPatterns: readonly RegExp[],
): SecurityAlert | undefined {
  const command = record.command as string | undefined;
  const filePath = record.filePath as string | undefined;
  // Defense in depth: the classifier's verdict and the pattern lists are
  // OR-ed together. Either layer flagging is enough to alert. We deliberately
  // do NOT short-circuit on `bashDestructive === false` — the two layers can
  // diverge (the classifier and the audit pattern list maintain independent
  // regexes), so treating the classifier as authoritative would let a
  // narrower classifier silently suppress a hit the audit list would have
  // caught. Treat the classifier as additive, not authoritative, for
  // security-critical decisions.
  const classifierDestructive = record.bashDestructive === true;
  const classifierNetwork = record.bashNetwork === true;

  // Destructive commands (critical) — check first, highest priority
  if (command) {
    const isDestructive = classifierDestructive || matchesAny(command, destructivePatterns);
    if (isDestructive) {
      return {
        severity: 'critical',
        alertType: 'destructive_command',
        description: `Destructive command detected: ${redactSensitive(command)}`,
      };
    }
  }

  // Sensitive file access (high)
  if (filePath && matchesAny(filePath, sensitivePatterns)) {
    return {
      severity: 'high',
      alertType: 'sensitive_file',
      description: `Sensitive file accessed: ${redactSensitive(filePath)}`,
    };
  }

  // External network request (medium) — only for Bash commands
  if (command) {
    const isNetwork = classifierNetwork || matchesAny(command, networkPatterns);
    if (isNetwork) {
      return {
        severity: 'medium',
        alertType: 'external_network',
        description: `External network request: ${redactSensitive(command)}`,
      };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// NR Event helpers
// ---------------------------------------------------------------------------

export function auditRecordToNrEvent(
  record: AuditRecord,
  attrs?: { teamId?: string | null; projectId?: string | null; orgId?: string | null },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiAuditEvent',
    event_version: 1,
    timestamp: Math.floor(record.timestamp / 1000),
    action: record.action,
    tool: record.tool,
    detail: record.detail,
    developer: record.developer,
  };

  if (attrs?.teamId) event.team_id = attrs.teamId;
  if (attrs?.projectId) event.project_id = attrs.projectId;
  if (attrs?.orgId) event.org_id = attrs.orgId;

  if (record.sessionId != null) event.session_id = record.sessionId;
  if (record.filePath != null) event.file_path = redactSensitive(record.filePath);
  if (record.command != null) event.command = redactSensitive(record.command);

  if (record.securityAlert) {
    event['audit.security_alert'] = true;
    event['audit.severity'] = record.securityAlert.severity;
    event['audit.alert_type'] = record.securityAlert.alertType;
  } else {
    event['audit.security_alert'] = false;
  }

  return event;
}

export function securityAlertToNrEvent(
  record: AuditRecord,
  attrs?: { teamId?: string | null; projectId?: string | null; orgId?: string | null },
): NrEventData {
  const alert = record.securityAlert;
  if (!alert) throw new Error('securityAlertToNrEvent called with no securityAlert on record');
  const event: NrEventData = {
    eventType: 'SecurityAlert',
    event_version: 1,
    timestamp: Math.floor(record.timestamp / 1000),
    severity: alert.severity,
    alert_type: alert.alertType,
    description: alert.description,
    tool: record.tool,
    developer: record.developer,
  };

  if (attrs?.teamId) event.team_id = attrs.teamId;
  if (attrs?.projectId) event.project_id = attrs.projectId;
  if (attrs?.orgId) event.org_id = attrs.orgId;

  if (record.sessionId != null) event.session_id = record.sessionId;
  if (record.filePath != null) event.file_path = redactSensitive(record.filePath);
  if (record.command != null) event.command = redactSensitive(record.command);

  return event;
}

// ---------------------------------------------------------------------------
// Session ID resolution
// ---------------------------------------------------------------------------

/**
 * `record.sessionId` can itself already be synthetic
 * (`pending-<ts>` before stdio session-ID resolution, `local-<ts>` in
 * `--local` mode, `proxy-<ts>`/`proxy-conn-<uuid>` proxy fallbacks — see
 * `src/index.ts`), so `isSyntheticSessionId()` must run against whichever
 * value is actually used (the record's own id when present, otherwise the
 * manager's own fallback `managerSessionId`), not only against the
 * fallback. Matches the pattern already used by `SessionStore.
 * loadAllSessions()` and `LiveSessionRegistry.getLiveSessions()`.
 */
function resolveAuditSessionId(
  recordSessionId: string | null | undefined,
  managerSessionId: string | null,
): string | null {
  const raw = recordSessionId ?? managerSessionId;
  return isSyntheticSessionId(raw) ? null : raw;
}

// ---------------------------------------------------------------------------
// Disk read-back
// ---------------------------------------------------------------------------

function isAuditAction(value: string): value is AuditAction {
  return (
    value === 'FileRead' ||
    value === 'FileWrite' ||
    value === 'FileEdit' ||
    value === 'BashCommand' ||
    value === 'McpToolCall' ||
    value === 'AgentSpawn' ||
    value === 'Search' ||
    value === 'Other'
  );
}

function isAlertSeverity(value: unknown): value is AlertSeverity {
  return value === 'critical' || value === 'high' || value === 'medium';
}

/**
 * Converts one on-disk `AuditEntry` (persisted by `appendAuditLog()`, from
 * this process or another one) back into an `AuditRecord`. Returns `null`
 * for a line that's missing/mistyped a required field rather than throwing
 * or fabricating placeholder values — a malformed line is dropped, not
 * surfaced as a broken row in the Audit page.
 *
 * Defensively re-applies `isSyntheticSessionId()` to the persisted
 * `sessionId` too: files written before that filtering existed may still
 * contain an unfiltered synthetic id (`pending-*`/`local-*`/`proxy-*`).
 */
function auditEntryToRecord(entry: AuditEntry): AuditRecord | null {
  const { timestamp, action, tool, detail, developer } = entry;
  if (
    typeof timestamp !== 'number' ||
    typeof action !== 'string' ||
    typeof tool !== 'string' ||
    typeof detail !== 'string' ||
    typeof developer !== 'string' ||
    !isAuditAction(action)
  ) {
    return null;
  }

  const rawSessionId = entry.sessionId;
  const sessionId =
    typeof rawSessionId === 'string' && !isSyntheticSessionId(rawSessionId) ? rawSessionId : null;
  const filePath = typeof entry.filePath === 'string' ? entry.filePath : undefined;
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  // Disk entries written before this field was introduced have no `id`; fall
  // back to the same content fingerprint used for cross-process dedup below.
  // That fingerprint isn't guaranteed unique across two distinct legacy
  // entries that happen to share timestamp/tool/detail — an inherent limit
  // of identifying such entries by content alone.
  const id =
    typeof entry.id === 'string' && entry.id.length > 0
      ? entry.id
      : auditIdentityKey({ timestamp, sessionId, tool, detail });

  let securityAlert: SecurityAlert | undefined;
  const rawAlert = entry.securityAlert;
  if (rawAlert && typeof rawAlert === 'object') {
    const a = rawAlert as Record<string, unknown>;
    if (isAlertSeverity(a.severity) && typeof a.alertType === 'string') {
      securityAlert = {
        severity: a.severity,
        alertType: a.alertType,
        description: typeof a.description === 'string' ? a.description : a.alertType,
      };
    }
  }

  return {
    id,
    timestamp,
    sessionId,
    action,
    tool,
    detail,
    developer,
    filePath,
    command,
    securityAlert,
  };
}

/** Best-effort content fingerprint — AuditRecord has no unique id field, so
 * this is the identity dedup key used to avoid double-counting a record
 * that exists both in this process's own in-memory `entries` (not yet
 * evicted) AND in the disk file it was already persisted to. */
function auditIdentityKey(
  r: Pick<AuditRecord, 'timestamp' | 'sessionId' | 'tool' | 'detail'>,
): string {
  return `${r.timestamp}|${r.sessionId ?? ''}|${r.tool}|${r.detail}`;
}

// ---------------------------------------------------------------------------
// AuditTrailManager
// ---------------------------------------------------------------------------

export interface AuditTrailManagerOptions {
  developer: string;
  sessionId: string | null;
  sensitivePatterns?: RegExp[];
  destructivePatterns?: RegExp[];
  networkPatterns?: RegExp[];
  /** Optional local store for persisting each audit record to disk immediately. */
  localStore?: LocalStore;
}

export class AuditTrailManager {
  private readonly developer: string;
  private sessionId: string | null;
  private readonly sensitivePatterns: readonly RegExp[];
  private readonly destructivePatterns: readonly RegExp[];
  private readonly networkPatterns: readonly RegExp[];
  private readonly localStore: LocalStore | null;

  private entries: AuditRecord[] = [];
  private sensitiveAccessLog: AuditRecord[] = [];
  private static readonly MAX_ENTRIES = 10_000;
  /**
   * Default cap for `getAuditLog()` when the caller doesn't pass an
   * explicit `limit`. The largest known consumer is `Audit.tsx`, which
   * renders at most 200 rows and exports at most the same 200-row slice —
   * 1000 gives headroom for its per-classification client-side filter
   * (a rare classification like `external_network` may need to look past
   * more than 200 raw rows to find 200 matching ones) without ever falling
   * back to a full unbounded disk read.
   */
  private static readonly DEFAULT_LOG_LIMIT = 1000;

  constructor(options: AuditTrailManagerOptions) {
    this.developer = options.developer;
    this.sessionId = options.sessionId;
    this.sensitivePatterns = options.sensitivePatterns ?? DEFAULT_SENSITIVE_FILE_PATTERNS;
    this.destructivePatterns = options.destructivePatterns ?? DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS;
    this.networkPatterns = options.networkPatterns ?? DEFAULT_NETWORK_COMMAND_PATTERNS;
    this.localStore = options.localStore ?? null;
  }

  recordToolCall(record: ToolCallRecord): AuditRecord {
    const action = classifyTool(record.toolName);
    const detail = buildDetail(record);

    const alert = detectSecurityAlert(
      record,
      this.sensitivePatterns,
      this.destructivePatterns,
      this.networkPatterns,
    );

    const rawFilePath = record.filePath as string | undefined;
    const rawCommand = record.command as string | undefined;
    const auditRecord: AuditRecord = {
      id: record.id,
      timestamp: record.timestamp,
      sessionId: resolveAuditSessionId(record.sessionId, this.sessionId),
      action,
      tool: record.toolName,
      detail,
      developer: this.developer,
      // Store redacted strings on the AuditRecord so every downstream consumer
      // (NR Events, NR Logs, on-disk audit log) carries only scrubbed values.
      filePath: rawFilePath != null ? redactSensitive(rawFilePath) : undefined,
      command: rawCommand != null ? redactSensitive(rawCommand) : undefined,
      securityAlert: alert,
    };

    if (this.entries.length >= AuditTrailManager.MAX_ENTRIES) this.entries.shift();
    this.entries.push(auditRecord);
    if (alert) {
      if (this.sensitiveAccessLog.length >= AuditTrailManager.MAX_ENTRIES)
        this.sensitiveAccessLog.shift();
      this.sensitiveAccessLog.push(auditRecord);
      logger.warn('Security alert', {
        severity: alert.severity,
        alertType: alert.alertType,
        tool: record.toolName,
        detail,
      });
    }

    this.persistToDisk(auditRecord);
    return auditRecord;
  }

  recordProxyCall(record: ProxyToolCallRecord): AuditRecord {
    const detail = `McpToolCall: ${record.serverName}/${record.toolName}`;
    const filePath = record.filePath as string | undefined;
    const command = record.command as string | undefined;

    const alert = detectSecurityAlert(
      record,
      this.sensitivePatterns,
      this.destructivePatterns,
      this.networkPatterns,
    );

    const auditRecord: AuditRecord = {
      id: record.id,
      timestamp: record.timestamp,
      sessionId: resolveAuditSessionId(record.sessionId, this.sessionId),
      action: 'McpToolCall',
      tool: record.toolName,
      detail,
      developer: this.developer,
      // Same redaction policy as recordToolCall — see comment there.
      filePath: filePath != null ? redactSensitive(filePath) : undefined,
      command: command != null ? redactSensitive(command) : undefined,
      securityAlert: alert,
    };

    if (this.entries.length >= AuditTrailManager.MAX_ENTRIES) this.entries.shift();
    this.entries.push(auditRecord);
    if (alert) {
      if (this.sensitiveAccessLog.length >= AuditTrailManager.MAX_ENTRIES)
        this.sensitiveAccessLog.shift();
      this.sensitiveAccessLog.push(auditRecord);
      logger.warn('Security alert', {
        severity: alert.severity,
        alertType: alert.alertType,
        tool: record.toolName,
        detail,
      });
    }

    this.persistToDisk(auditRecord);
    return auditRecord;
  }

  /**
   * Merges this process's own in-memory `entries` (capped at
   * `MAX_ENTRIES`, evicted FIFO) with every process's persisted history from
   * `~/.newrelic-preflight/audit/*.jsonl` via `LocalStore.peekAllAuditLogs()`,
   * so disk is the durable source of truth and the in-memory array is just
   * this process's own cache. Without this, every OTHER concurrent (or
   * already-exited) process's flagged sensitive-file/destructive-command/
   * external-network events would be invisible through this API even
   * though they were faithfully written to disk.
   *
   * Bounded to `limit` (default `DEFAULT_LOG_LIMIT`): a long-lived `--local`
   * daemon accumulates hundreds of thousands of on-disk rows across many
   * `audit/*.jsonl` files, and reading/parsing all of them on every call
   * would be unbounded CPU and payload for a caller that only ever renders
   * or exports a couple hundred rows. `LocalStore.peekAllAuditLogs(limit)`
   * itself stops reading once it has collected `limit` rows (newest files
   * first), which is sufficient here: the merged set's size is always at
   * least `max(this.entries.length, diskRowsPulled)`, so pulling `limit`
   * disk rows guarantees at least `limit` total distinct rows are available
   * to sort and slice below, whenever that many actually exist.
   */
  getAuditLog(limit: number = AuditTrailManager.DEFAULT_LOG_LIMIT): readonly AuditRecord[] {
    const combined = [...this.entries];

    if (this.localStore) {
      const seen = new Set(combined.map(auditIdentityKey));
      for (const diskEntry of this.localStore.peekAllAuditLogs(limit)) {
        const record = auditEntryToRecord(diskEntry);
        if (!record) continue;
        const key = auditIdentityKey(record);
        if (seen.has(key)) continue;
        seen.add(key);
        combined.push(record);
      }
    }

    // `entries` is append-only in processing order, not timestamp order —
    // sort newest-first before slicing, so the cap (and the route's own
    // `Audit.tsx` 200-row render/export slice) keeps the most recent
    // entries, not whichever ones happen to sit at the front of the array.
    return combined.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  getSensitiveAccessLog(): readonly AuditRecord[] {
    return this.sensitiveAccessLog;
  }

  getMetrics(): AuditMetrics {
    const alertsBySeverity: Record<string, number> = {};
    let securityAlerts = 0;

    for (const entry of this.entries) {
      if (entry.securityAlert) {
        securityAlerts++;
        const sev = entry.securityAlert.severity;
        alertsBySeverity[sev] = (alertsBySeverity[sev] ?? 0) + 1;
      }
    }

    return {
      totalEntries: this.entries.length,
      securityAlerts,
      alertsBySeverity,
    };
  }

  reset(sessionId?: string | null): void {
    this.entries = [];
    this.sensitiveAccessLog = [];
    if (sessionId !== undefined) {
      this.sessionId = sessionId;
    }
  }

  private persistToDisk(record: AuditRecord): void {
    if (!this.localStore) return;
    this.localStore.appendAuditLog({
      id: record.id,
      timestamp: record.timestamp,
      sessionId: record.sessionId,
      action: record.action,
      tool: record.tool,
      detail: record.detail,
      developer: record.developer,
      filePath: record.filePath,
      command: record.command,
      securityAlert: record.securityAlert
        ? { severity: record.securityAlert.severity, alertType: record.securityAlert.alertType }
        : undefined,
    });
  }
}
