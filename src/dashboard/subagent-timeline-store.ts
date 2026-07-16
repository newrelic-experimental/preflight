/**
 * SubagentTimelineStore — on-demand, bounded, mtime-cached reader that turns one
 * session's Claude Code subagent JSONL transcripts into per-agent timing/token/
 * cost spans for the dashboard's "agent fan-out" swimlane chart
 * (`GET /api/sessions/:sessionId/subagents`).
 *
 * Discovery mirrors `SubagentWatcher`:
 *   - ad-hoc:            `<projectsDir>/<slug>/<sessionId>/subagents/agent-*.jsonl`
 *   - workflow-spawned:  `<projectsDir>/<slug>/<sessionId>/subagents/workflows/wf_<id>/agent-*.jsonl`
 *
 * Each `agent-<id>.jsonl` file is parsed line-by-line; the assistant turns
 * (`type:'assistant'` with `message.model` + `message.usage`) supply the start/
 * end timestamps, the model, the turn count, and the summed token usage. Per-
 * agent USD is computed via the shared `calculateCost` pricing table; when the
 * model is unknown (pricing resolves to an all-zero breakdown) `usd` is `null`
 * — mirroring how `CostTracker` treats unknown models.
 *
 * Bounds (the watcher previously OOM'd on unbounded reads):
 *   - skip agent files larger than `MAX_AGENT_FILE_BYTES` (64 MiB),
 *   - cap the number of agents per session at `MAX_AGENTS_PER_SESSION` (500),
 *   - parse one line at a time without retaining the whole parsed set,
 *   - mtime-cache the computed `AgentSpan` per file so repeated dashboard polls
 *     don't re-parse unchanged transcripts.
 *
 * Privacy: this store NEVER reads `agent-<id>.meta.json` (which may
 * contain the agent prompt) and NEVER includes prompt / content / result text.
 * The only labels it emits are declarative — derived from the workflow rollup
 * (`wf_*.json` workflowProgress) or a synthetic `agent <id8>` fallback.
 *
 * Every filesystem access and `JSON.parse` is wrapped in try/catch; the store
 * never throws out of its public method.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { calculateCost, createLogger, type TokenUsage } from '../shared/index.js';
import type {
  RawTranscriptEntry,
  RawAssistantMessage,
  RawUsage,
} from '../hooks/transcript-types.js';
import { WorkflowStore } from './workflow-store.js';

const logger = createLogger('subagent-timeline-store');

const SESSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AGENT_ID_RE = /^a[a-f0-9]{16}$/;
const WORKFLOW_RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,128}$/;
const PROJECTS_DIR_NAME = '.claude/projects';

/** Skip agent files larger than this — a transcript this big is pathological. */
const MAX_AGENT_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB
/** Hard cap on distinct file paths retained per cache — bounds memory on a long-running dashboard server. */
const MAX_CACHE_ENTRIES = 4096;
/** Hard cap on agents returned per session. */
const MAX_AGENTS_PER_SESSION = 500;
/** Hard cap on individual tool calls returned for a single agent. */
const MAX_CALLS_PER_AGENT = 2000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One agent's swimlane span. Sorted by `startMs` ASC in the response.
 * Contains only declarative timing/token/cost data — no user content.
 */
export interface AgentSpan {
  /** Agent id from the filename `agent-<id>.jsonl` (e.g. `a45d96d201bf2f1ef`). */
  readonly agentId: string;
  /** `wf_<...>` when the file is under `subagents/workflows/wf_<id>/`, else null. */
  readonly workflowRunId: string | null;
  /** Declarative workflow name resolved from the run rollup, else null. */
  readonly workflowName: string | null;
  /** Declarative label — workflow agent label, or `agent <id8>` fallback. */
  readonly label: string;
  /** Model of the agent's turns (last non-empty observed). */
  readonly model: string;
  /** Epoch ms of the first assistant turn. */
  readonly startMs: number;
  /** Epoch ms of the last assistant turn. */
  readonly endMs: number;
  /** `endMs - startMs`. */
  readonly durationMs: number;
  /** Number of assistant turns observed. */
  readonly turnCount: number;
  /** Sum of input+output+cache_creation+cache_read tokens across turns. */
  readonly totalTokens: number;
  /** Cost via shared pricing; null when the model is unknown / unpriced. */
  readonly usd: number | null;
}

export interface SubagentTimelineWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export interface SubagentTimeline {
  readonly window: SubagentTimelineWindow;
  readonly agents: readonly AgentSpan[];
}

/**
 * One tool call performed by a single subagent, for the attributed
 * session-trace view (`GET /api/sessions/:sessionId/subagents/:agentId/calls`).
 *
 * Privacy: carries ONLY the tool name and timing/outcome — NEVER the
 * tool inputs (file paths, bash commands, search queries), the tool outputs,
 * the agent prompt, or any other content. Sorted by `timestamp` ASC.
 */
export interface AgentCall {
  /** The `tool_use` block's `name` (e.g. `Read`, `Bash`). No inputs. */
  readonly toolName: string;
  /** Epoch ms of the assistant turn that issued the tool call. */
  readonly timestamp: number;
  /**
   * `resultTimestamp - useTimestamp` in ms, or null when no matching
   * `tool_result` was found (e.g. transcript truncated mid-call).
   */
  readonly durationMs: number | null;
  /** `!is_error` of the paired `tool_result`; true when no result was found. */
  readonly success: boolean;
}

export interface SubagentTimelineStoreOptions {
  /** `~/.claude/projects` directory; defaults to homedir-relative. */
  readonly projectsDir?: string;
  /**
   * Optional injected workflow reader (tests). When omitted, a `WorkflowStore`
   * bound to the same `projectsDir` is constructed lazily.
   */
  readonly workflowStore?: WorkflowResolver;
}

/** Minimal slice of WorkflowStore needed to resolve declarative labels. */
interface WorkflowResolver {
  getRun: (runId: string) => WorkflowRunLike | null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A discovered agent transcript file plus its path-derived attribution. */
interface DiscoveredAgentFile {
  readonly path: string;
  readonly agentId: string;
  readonly workflowRunId: string | null;
}

/** Aggregate produced by parsing one agent transcript. */
interface ParsedAgentFile {
  readonly startMs: number;
  readonly endMs: number;
  readonly turnCount: number;
  readonly totalTokens: number;
  readonly usage: TokenUsage;
  readonly model: string;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  /** null when the file parsed to zero assistant turns (still cached to skip re-parse). */
  readonly parsed: ParsedAgentFile | null;
}

/** mtime-gated per-file cache for the computed per-agent tool-call list. */
interface CallsCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  /** Always an array (possibly empty) so repeated polls skip the re-parse. */
  readonly calls: readonly AgentCall[];
}

/** Shape of a `workflowProgress` agent entry we read for declarative labels. */
interface WorkflowAgentLike {
  readonly agent_id?: string;
  readonly label?: string;
}
interface WorkflowRunLike {
  readonly workflow_name?: string;
  readonly agents?: readonly WorkflowAgentLike[];
}

export class SubagentTimelineStore {
  private readonly projectsDir: string;
  private readonly injectedWorkflowStore: WorkflowResolver | undefined;
  private workflowStore: WorkflowResolver | null = null;
  /** mtime-gated per-file parse cache, keyed by absolute file path. */
  private readonly cache = new Map<string, CacheEntry>();
  /** mtime-gated per-file tool-call cache, keyed by absolute file path. */
  private readonly callsCache = new Map<string, CallsCacheEntry>();

  constructor(options: SubagentTimelineStoreOptions = {}) {
    this.projectsDir = options.projectsDir ?? join(homedir(), PROJECTS_DIR_NAME);
    this.injectedWorkflowStore = options.workflowStore;
  }

  /**
   * Set on a Map-based cache, evicting the oldest entry (insertion order)
   * once `maxSize` is exceeded — bounds memory on a long-running dashboard
   * server with many distinct agent file paths seen over time.
   */
  private static boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
    map.set(key, value);
    if (map.size > maxSize) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  /**
   * Return per-agent swimlane spans for a single session. Always returns a
   * value — `{ window: { startMs: 0, endMs: 0 }, agents: [] }` when the
   * session has no subagent transcripts (or anything goes wrong).
   */
  getSubagentsForSession(sessionId: string): SubagentTimeline {
    const empty: SubagentTimeline = { window: { startMs: 0, endMs: 0 }, agents: [] };
    if (!SESSION_ID_RE.test(sessionId)) return empty;

    let files: DiscoveredAgentFile[];
    try {
      files = this.discoverAgentFiles(sessionId);
    } catch (err) {
      this.recordError('discover', err);
      return empty;
    }
    if (files.length === 0) return empty;

    // Per-run workflow-name + per-agent label cache so each wf_*.json is read
    // at most once per request even when a run spawned many agents.
    const workflowNameByRun = new Map<string, string | null>();
    const labelByRunAgent = new Map<string, string>();

    const agents: AgentSpan[] = [];
    for (const file of files) {
      if (agents.length >= MAX_AGENTS_PER_SESSION) break;

      const parsed = this.parseAgentFile(file.path);
      if (parsed === null) continue;

      let workflowName: string | null = null;
      let label: string | null = null;
      if (file.workflowRunId !== null) {
        const resolved = this.resolveWorkflow(
          file.workflowRunId,
          file.agentId,
          workflowNameByRun,
          labelByRunAgent,
        );
        workflowName = resolved.workflowName;
        label = resolved.label;
      }
      if (label === null || label.length === 0) {
        label = `agent ${file.agentId.slice(0, 8)}`;
      }

      const usd = computeUsd(parsed.usage, parsed.model);

      agents.push({
        agentId: file.agentId,
        workflowRunId: file.workflowRunId,
        workflowName,
        label,
        model: parsed.model,
        startMs: parsed.startMs,
        endMs: parsed.endMs,
        durationMs: Math.max(0, parsed.endMs - parsed.startMs),
        turnCount: parsed.turnCount,
        totalTokens: parsed.totalTokens,
        usd,
      });
    }

    if (agents.length === 0) return empty;

    agents.sort((a, b) => a.startMs - b.startMs);

    let windowStart = Infinity;
    let windowEnd = -Infinity;
    for (const a of agents) {
      if (a.startMs < windowStart) windowStart = a.startMs;
      if (a.endMs > windowEnd) windowEnd = a.endMs;
    }

    return {
      window: {
        startMs: Number.isFinite(windowStart) ? windowStart : 0,
        endMs: Number.isFinite(windowEnd) ? windowEnd : 0,
      },
      agents,
    };
  }

  /**
   * Return ONE subagent's individual tool calls, for the attributed
   * session-trace view. Always returns a value — `{ calls: [] }` for a bad
   * session/agent id, a missing transcript, an oversized file, or any error.
   *
   * Privacy: only `toolName` + timing/outcome is emitted; tool inputs,
   * outputs, prompts and `agent-*.meta.json` are never read or included.
   */
  getAgentCalls(sessionId: string, agentId: string): { calls: readonly AgentCall[] } {
    const empty: { calls: readonly AgentCall[] } = { calls: [] };
    // Strict validation up front — reject anything that isn't a real session
    // UUID / agent id so a crafted id can never escape the projects tree.
    if (!SESSION_ID_RE.test(sessionId)) return empty;
    if (!AGENT_ID_RE.test(agentId)) return empty;

    let files: DiscoveredAgentFile[];
    try {
      files = this.discoverAgentFiles(sessionId);
    } catch (err) {
      this.recordError('discover calls', err);
      return empty;
    }

    const file = files.find((f) => f.agentId === agentId);
    if (file === undefined) return empty;

    const calls = this.parseAgentCalls(file.path);
    return { calls };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private discoverAgentFiles(sessionId: string): DiscoveredAgentFile[] {
    const out: DiscoveredAgentFile[] = [];
    if (!existsSync(this.projectsDir)) return out;

    let projectEntries: string[];
    try {
      projectEntries = readdirSync(this.projectsDir);
    } catch (err) {
      this.recordError('readdir projects', err);
      return out;
    }

    for (const project of projectEntries) {
      const subDir = join(this.projectsDir, project, sessionId, 'subagents');
      if (!existsSync(subDir)) continue;

      // Ad-hoc: subagents/agent-*.jsonl
      this.collectAgentFiles(subDir, null, out);

      // Workflow-spawned: subagents/workflows/wf_*/agent-*.jsonl
      const wfDir = join(subDir, 'workflows');
      if (!existsSync(wfDir)) continue;
      let wfEntries: string[];
      try {
        wfEntries = readdirSync(wfDir);
      } catch {
        continue;
      }
      for (const wfName of wfEntries) {
        if (!WORKFLOW_RUN_ID_RE.test(wfName)) continue;
        const wfRunDir = join(wfDir, wfName);
        try {
          if (!statSync(wfRunDir).isDirectory()) continue;
        } catch {
          continue;
        }
        this.collectAgentFiles(wfRunDir, wfName, out);
      }
    }
    return out;
  }

  /** Push every well-named `agent-<id>.jsonl` in `dir` onto `out`. */
  private collectAgentFiles(
    dir: string,
    workflowRunId: string | null,
    out: DiscoveredAgentFile[],
  ): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      if (!AGENT_ID_RE.test(agentId)) continue;
      out.push({ path: join(dir, name), agentId, workflowRunId });
    }
  }

  // -------------------------------------------------------------------------
  // Parsing (mtime-cached, bounded)
  // -------------------------------------------------------------------------

  private parseAgentFile(path: string): ParsedAgentFile | null {
    let st;
    try {
      st = statSync(path);
    } catch {
      return null;
    }

    const cached = this.cache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.parsed;
    }

    if (st.size > MAX_AGENT_FILE_BYTES) {
      logger.warn('Subagent transcript exceeds size cap — skipped', {
        path,
        sizeBytes: st.size,
        maxBytes: MAX_AGENT_FILE_BYTES,
      });
      // Cache the skip so we don't re-stat-and-reject on every poll until the
      // file changes again.
      SubagentTimelineStore.boundedSet(
        this.cache,
        path,
        { mtimeMs: st.mtimeMs, size: st.size, parsed: null },
        MAX_CACHE_ENTRIES,
      );
      return null;
    }

    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      this.recordError('read agent file', err);
      return null;
    }

    const parsed = this.parseTranscript(raw);
    SubagentTimelineStore.boundedSet(
      this.cache,
      path,
      { mtimeMs: st.mtimeMs, size: st.size, parsed },
      MAX_CACHE_ENTRIES,
    );
    return parsed;
  }

  /**
   * Parse a JSONL transcript line-by-line, accumulating only scalar totals —
   * never retaining the parsed objects. Returns null when no assistant turns
   * with usage are found.
   */
  private parseTranscript(raw: string): ParsedAgentFile | null {
    let startMs = Infinity;
    let endMs = -Infinity;
    let turnCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let lastModel = '';

    // Dedup streaming-duplicate lines: Claude Code logs one JSONL line per
    // streaming snapshot of a single assistant turn, all sharing one
    // `message.id` with byte-identical per-prompt usage. Summing every line
    // multiplies cache_read/cache_creation by the snapshot count (the dominant
    // token category, ~90%+ of the total), inflating both `totalTokens` and the
    // derived USD ~2x. We count each `message.id` once, keeping the FIRST
    // occurrence — identical to the cost path's `${agentId}|${messageId}` dedup
    // in event-processor.ts — so this trace reconciles with the headline cost.
    const seenMessageIds = new Set<string>();

    let lineStart = 0;
    const len = raw.length;
    while (lineStart <= len) {
      let nl = raw.indexOf('\n', lineStart);
      if (nl === -1) nl = len;
      const line = raw.slice(lineStart, nl);
      lineStart = nl + 1;
      if (line.length === 0) {
        if (nl === len) break;
        continue;
      }

      const turn = parseAssistantTurn(line);
      if (turn === null) {
        if (nl === len) break;
        continue;
      }
      if (seenMessageIds.has(turn.messageId)) {
        if (nl === len) break;
        continue;
      }
      seenMessageIds.add(turn.messageId);

      turnCount += 1;
      if (turn.timestampMs < startMs) startMs = turn.timestampMs;
      if (turn.timestampMs > endMs) endMs = turn.timestampMs;
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      cacheReadTokens += turn.cacheReadTokens;
      cacheCreationTokens += turn.cacheCreationTokens;
      if (turn.model.length > 0) lastModel = turn.model;

      if (nl === len) break;
    }

    if (turnCount === 0 || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return null;
    }

    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
    };

    return { startMs, endMs, turnCount, totalTokens, usage, model: lastModel };
  }

  // -------------------------------------------------------------------------
  // Per-agent tool-call parsing (mtime-cached, bounded, privacy-preserving)
  // -------------------------------------------------------------------------

  /**
   * Parse one agent transcript into its tool-call list, mtime-cached and size-
   * capped exactly like `parseAgentFile`. Always returns an array (possibly
   * empty); never throws.
   */
  private parseAgentCalls(path: string): readonly AgentCall[] {
    let st;
    try {
      st = statSync(path);
    } catch {
      return [];
    }

    const cached = this.callsCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.calls;
    }

    if (st.size > MAX_AGENT_FILE_BYTES) {
      logger.warn('Subagent transcript exceeds size cap — calls skipped', {
        path,
        sizeBytes: st.size,
        maxBytes: MAX_AGENT_FILE_BYTES,
      });
      SubagentTimelineStore.boundedSet(
        this.callsCache,
        path,
        { mtimeMs: st.mtimeMs, size: st.size, calls: [] },
        MAX_CACHE_ENTRIES,
      );
      return [];
    }

    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      this.recordError('read agent calls', err);
      return [];
    }

    const calls = parseToolCalls(raw);
    SubagentTimelineStore.boundedSet(
      this.callsCache,
      path,
      { mtimeMs: st.mtimeMs, size: st.size, calls },
      MAX_CACHE_ENTRIES,
    );
    return calls;
  }

  // -------------------------------------------------------------------------
  // Workflow label resolution (declarative data only)
  // -------------------------------------------------------------------------

  private resolveWorkflow(
    workflowRunId: string,
    agentId: string,
    workflowNameByRun: Map<string, string | null>,
    labelByRunAgent: Map<string, string>,
  ): { workflowName: string | null; label: string | null } {
    const labelKey = `${workflowRunId} ${agentId}`;
    if (workflowNameByRun.has(workflowRunId)) {
      return {
        workflowName: workflowNameByRun.get(workflowRunId) ?? null,
        label: labelByRunAgent.get(labelKey) ?? null,
      };
    }

    let workflowName: string | null = null;
    try {
      const store = this.getWorkflowStore();
      const run = store.getRun(workflowRunId);
      if (run) {
        workflowName =
          typeof run.workflow_name === 'string' && run.workflow_name.length > 0
            ? run.workflow_name
            : null;
        if (Array.isArray(run.agents)) {
          for (const a of run.agents) {
            if (typeof a.agent_id !== 'string') continue;
            const lbl = typeof a.label === 'string' && a.label.length > 0 ? a.label : '';
            if (lbl) labelByRunAgent.set(`${workflowRunId} ${a.agent_id}`, lbl);
          }
        }
      }
    } catch (err) {
      this.recordError('resolve workflow', err);
    }

    workflowNameByRun.set(workflowRunId, workflowName);
    return { workflowName, label: labelByRunAgent.get(labelKey) ?? null };
  }

  private getWorkflowStore(): WorkflowResolver {
    if (this.injectedWorkflowStore) return this.injectedWorkflowStore;
    if (this.workflowStore === null) {
      this.workflowStore = new WorkflowStore({ projectsDir: this.projectsDir });
    }
    return this.workflowStore;
  }

  private recordError(stage: string, err: unknown): void {
    logger.warn('SubagentTimelineStore error', {
      stage,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

interface AssistantTurn {
  /** `message.id` — used to dedup streaming-duplicate lines of one logical turn. */
  readonly messageId: string;
  readonly timestampMs: number;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/**
 * Parse one JSONL line into an assistant turn, or null when the line is
 * malformed or not an assistant turn with usage. Never throws.
 */
function parseAssistantTurn(line: string): AssistantTurn | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as RawTranscriptEntry;
  if (obj.type !== 'assistant') return null;

  const message = obj.message;
  if (!message || typeof message !== 'object') return null;
  const m = message as RawAssistantMessage;

  const model = typeof m.model === 'string' ? m.model : '';
  // `<synthetic>` turns carry no real usage and no priceable model.
  if (model === '<synthetic>') return null;

  // Claude Code logs one JSONL line per streaming snapshot of a single
  // assistant turn, all sharing one `message.id` with byte-identical per-prompt
  // usage (cache_read/cache_creation/input). We require the id so duplicate
  // snapshots can be deduped in parseTranscript — mirroring the cost path's
  // `${agentId}|${messageId}` dedup in event-processor.ts. Lines without an id
  // are skipped, exactly as the CostTracker feed (SubagentWatcher) skips them.
  const messageId = typeof m.id === 'string' ? m.id : '';
  if (messageId.length === 0) return null;

  const usage = m.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as RawUsage;

  const tsRaw = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const timestampMs = tsRaw ? Date.parse(tsRaw) : NaN;
  if (!Number.isFinite(timestampMs)) return null;

  return {
    messageId,
    timestampMs,
    model,
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Compute per-agent USD via the shared pricing table. `calculateCost` returns
 * an all-zero breakdown for unknown models (it never returns null), so we treat
 * a `totalUsd` of 0 with no real spend as "unknown / unpriced" → null, matching
 * how CostTracker reports unknown models. A genuinely zero-token agent (no
 * billable usage) also yields null, which is the honest answer.
 */
function computeUsd(usage: TokenUsage, model: string): number | null {
  if (model.length === 0) return null;
  const breakdown = calculateCost(model, usage);
  if (breakdown.totalUsd > 0) return breakdown.totalUsd;
  return null;
}

// ---------------------------------------------------------------------------
// Tool-call extraction (tool NAME only — never inputs/outputs/content)
// ---------------------------------------------------------------------------

/** An open `tool_use` awaiting its `tool_result` in a later turn. */
interface PendingToolUse {
  readonly toolName: string;
  readonly timestamp: number;
}

/**
 * A single content block inside an assistant or user turn's `message.content`
 * array. Only the two variants this file reads are modeled; every other
 * Claude Code content-block type (text, thinking, image, ...) falls through
 * the `type` checks in `readToolUse`/`readToolResult` unchanged.
 */
type RawContentBlock =
  | { readonly type: 'tool_use'; readonly name?: string; readonly id?: string }
  | { readonly type: 'tool_result'; readonly tool_use_id?: string; readonly is_error?: boolean }
  | {
      readonly type?: string;
      readonly name?: string;
      readonly id?: string;
      readonly tool_use_id?: string;
      readonly is_error?: boolean;
    };

/**
 * Walk a transcript line-by-line and build the ordered list of tool calls.
 *
 * For each assistant turn, every `tool_use` content block is opened with its
 * issuing turn's timestamp; the matching `tool_result` block (in a LATER user
 * turn, keyed by `tool_use_id`) supplies `success` (`!is_error`) and
 * `durationMs` (result-turn timestamp − use-turn timestamp). A tool_use with no
 * matching result keeps `durationMs: null` and `success: true`.
 *
 * Privacy: only `block.name` is read from a tool_use, and only
 * `tool_use_id` + `is_error` from a tool_result. Tool `input`, result content,
 * text blocks and prompts are never touched. Never throws.
 */
function parseToolCalls(raw: string): readonly AgentCall[] {
  const calls: AgentCall[] = [];
  // Map tool_use_id → index into `calls`, so a later tool_result can patch the
  // existing entry in place (preserving the issue-time ordering).
  const indexByUseId = new Map<string, number>();
  let capped = false;

  let lineStart = 0;
  const len = raw.length;
  while (lineStart <= len) {
    let nl = raw.indexOf('\n', lineStart);
    if (nl === -1) nl = len;
    const line = raw.slice(lineStart, nl);
    lineStart = nl + 1;
    if (line.length === 0) {
      if (nl === len) break;
      continue;
    }

    const turn = parseTurnBlocks(line);
    if (turn !== null) {
      if (turn.role === 'assistant') {
        for (const block of turn.blocks) {
          const use = readToolUse(block);
          if (use === null) continue;
          // Skip a tool_use already recorded under this id — streaming-duplicate
          // snapshots of one assistant turn repeat the same tool_use block, and
          // counting each repeat inflates the per-agent call list.
          if (use.id.length > 0 && indexByUseId.has(use.id)) continue;
          if (calls.length >= MAX_CALLS_PER_AGENT) {
            capped = true;
            break;
          }
          const pending: PendingToolUse = { toolName: use.name, timestamp: turn.timestamp };
          const idx = calls.length;
          calls.push({
            toolName: pending.toolName,
            timestamp: pending.timestamp,
            durationMs: null,
            success: true,
          });
          if (use.id.length > 0) indexByUseId.set(use.id, idx);
        }
      } else {
        // user turn — look for tool_result blocks pairing back to a tool_use.
        for (const block of turn.blocks) {
          const result = readToolResult(block);
          if (result === null) continue;
          const idx = indexByUseId.get(result.toolUseId);
          if (idx === undefined) continue;
          const existing = calls[idx];
          if (existing === undefined) continue;
          const durationMs =
            turn.timestamp >= existing.timestamp ? turn.timestamp - existing.timestamp : null;
          calls[idx] = {
            toolName: existing.toolName,
            timestamp: existing.timestamp,
            durationMs,
            success: !result.isError,
          };
        }
      }
    }

    if (capped || nl === len) break;
  }

  calls.sort((a, b) => a.timestamp - b.timestamp);
  return calls;
}

interface TurnBlocks {
  readonly role: 'assistant' | 'user';
  readonly timestamp: number;
  readonly blocks: readonly unknown[];
}

/**
 * Parse one JSONL line into a role + timestamp + content-block array, or null
 * when the line is malformed, not an assistant/user turn, has no parseable
 * timestamp, or carries no array content. Never throws.
 */
function parseTurnBlocks(line: string): TurnBlocks | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as RawTranscriptEntry;
  const role = obj.type;
  if (role !== 'assistant' && role !== 'user') return null;

  const tsRaw = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const timestamp = tsRaw ? Date.parse(tsRaw) : NaN;
  if (!Number.isFinite(timestamp)) return null;

  const message = obj.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as RawAssistantMessage).content;
  if (!Array.isArray(content)) return null;

  return { role, timestamp, blocks: content };
}

/**
 * Read a `tool_use` block, returning only its name + id (never the
 * `input`). Returns null for any non-tool_use block or missing name.
 */
function readToolUse(block: unknown): { name: string; id: string } | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as RawContentBlock;
  if (b.type !== 'tool_use') return null;
  const name = typeof b.name === 'string' ? b.name : '';
  if (name.length === 0) return null;
  const id = typeof b.id === 'string' ? b.id : '';
  return { name, id };
}

/**
 * Read a `tool_result` block, returning only its `tool_use_id` + error flag
 * (never the result content). Returns null for any non-tool_result
 * block or missing id.
 */
function readToolResult(block: unknown): { toolUseId: string; isError: boolean } | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as RawContentBlock;
  if (b.type !== 'tool_result') return null;
  const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
  if (toolUseId.length === 0) return null;
  return { toolUseId, isError: b.is_error === true };
}
