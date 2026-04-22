/**
 * Security Audit Trail — classifies tool calls into audit events, detects
 * sensitive file access and destructive commands, and emits NR events for
 * alerting.
 */

import { createLogger } from '@nr-ai-observatory/shared';
import type { NrEventData } from '@nr-ai-observatory/shared';
import type { ToolCallRecord } from '../storage/types.js';
import type { ProxyToolCallRecord } from '../proxy/types.js';

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
  /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*|-[rR][a-zA-Z]*(?:\s+-[a-zA-Z]+)*\s+-[fF]|-[fF][a-zA-Z]*(?:\s+-[a-zA-Z]+)*\s+-[rR])/,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+push\s+-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bchmod\s+777\b/,
  // Pipe to shell — matches sh, bash, zsh, ksh, dash, and absolute paths (/bin/bash, /usr/bin/zsh, etc.)
  /\bcurl\b.*\|\s*(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:ba|z|k|da)?sh\b/i,
  /\bwget\b.*\|\s*(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:ba|z|k|da)?sh\b/i,
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

  if (filePath) return `${tool} ${filePath}`;
  if (command) return `${tool}: ${command}`;
  if (agentDescription) return `${tool}: ${agentDescription}`;
  if (pattern) return `${tool}: ${pattern}`;
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

  // Destructive commands (critical) — check first, highest priority
  if (command && matchesAny(command, destructivePatterns)) {
    return {
      severity: 'critical',
      alertType: 'destructive_command',
      description: `Destructive command detected: ${command}`,
    };
  }

  // Sensitive file access (high)
  if (filePath && matchesAny(filePath, sensitivePatterns)) {
    return {
      severity: 'high',
      alertType: 'sensitive_file',
      description: `Sensitive file accessed: ${filePath}`,
    };
  }

  // External network request (medium) — only for Bash commands
  if (command && matchesAny(command, networkPatterns)) {
    return {
      severity: 'medium',
      alertType: 'external_network',
      description: `External network request: ${command}`,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// NR Event helpers
// ---------------------------------------------------------------------------

export function auditRecordToNrEvent(record: AuditRecord): NrEventData {
  const event: NrEventData = {
    eventType: 'AiAuditEvent',
    timestamp: Math.floor(record.timestamp / 1000),
    action: record.action,
    tool: record.tool,
    detail: record.detail,
    developer: record.developer,
  };

  if (record.sessionId != null) event.session_id = record.sessionId;
  if (record.filePath != null) event.file_path = record.filePath;
  if (record.command != null) event.command = record.command;

  if (record.securityAlert) {
    event['audit.security_alert'] = true;
    event['audit.severity'] = record.securityAlert.severity;
    event['audit.alert_type'] = record.securityAlert.alertType;
  } else {
    event['audit.security_alert'] = false;
  }

  return event;
}

export function securityAlertToNrEvent(record: AuditRecord): NrEventData {
  const alert = record.securityAlert!;
  const event: NrEventData = {
    eventType: 'SecurityAlert',
    timestamp: Math.floor(record.timestamp / 1000),
    severity: alert.severity,
    alert_type: alert.alertType,
    description: alert.description,
    tool: record.tool,
    developer: record.developer,
  };

  if (record.sessionId != null) event.session_id = record.sessionId;
  if (record.filePath != null) event.file_path = record.filePath;
  if (record.command != null) event.command = record.command;

  return event;
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
}

export class AuditTrailManager {
  private readonly developer: string;
  private sessionId: string | null;
  private readonly sensitivePatterns: readonly RegExp[];
  private readonly destructivePatterns: readonly RegExp[];
  private readonly networkPatterns: readonly RegExp[];

  private entries: AuditRecord[] = [];
  private sensitiveAccessLog: AuditRecord[] = [];

  constructor(options: AuditTrailManagerOptions) {
    this.developer = options.developer;
    this.sessionId = options.sessionId;
    this.sensitivePatterns = options.sensitivePatterns ?? DEFAULT_SENSITIVE_FILE_PATTERNS;
    this.destructivePatterns = options.destructivePatterns ?? DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS;
    this.networkPatterns = options.networkPatterns ?? DEFAULT_NETWORK_COMMAND_PATTERNS;
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

    const auditRecord: AuditRecord = {
      timestamp: record.timestamp,
      sessionId: record.sessionId ?? this.sessionId,
      action,
      tool: record.toolName,
      detail,
      developer: this.developer,
      filePath: record.filePath as string | undefined,
      command: record.command as string | undefined,
      securityAlert: alert,
    };

    this.entries.push(auditRecord);
    if (alert) {
      this.sensitiveAccessLog.push(auditRecord);
      logger.warn('Security alert', {
        severity: alert.severity,
        alertType: alert.alertType,
        tool: record.toolName,
        detail,
      });
    }

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
      timestamp: record.timestamp,
      sessionId: record.sessionId ?? this.sessionId,
      action: 'McpToolCall',
      tool: record.toolName,
      detail,
      developer: this.developer,
      filePath,
      command,
      securityAlert: alert,
    };

    this.entries.push(auditRecord);
    if (alert) {
      this.sensitiveAccessLog.push(auditRecord);
      logger.warn('Security alert', {
        severity: alert.severity,
        alertType: alert.alertType,
        tool: record.toolName,
        detail,
      });
    }

    return auditRecord;
  }

  getAuditLog(): readonly AuditRecord[] {
    return this.entries;
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
}
