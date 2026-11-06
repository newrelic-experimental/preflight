import { randomUUID } from 'node:crypto';

import type { SkillStamp, ToolCallRecord } from '../storage/types.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from './task-detector.js';
import type { Resettable } from './tracker-contracts.js';

const NULL_SESSION_KEY = '__no_session__';
const MAIN_AGENT_KEY = '';
const DEFAULT_MAX_SESSIONS = 50;
const MAX_AGENTS_PER_SESSION = 100;

export interface SkillActivationMetrics {
  /** Every open run, main agent and subagents, across the sessions in view. */
  readonly openRuns: readonly SkillStamp[];
}

/**
 * Tracks the open skill run per session and per agent, so every tool call can
 * be stamped with the skill whose work it is. A run opens on a successful,
 * named `Skill` tool call or a `/<skill>` prompt and lasts until the next
 * prompt, an idle gap, or the next skill (last wins: there is no signal for a
 * nested skill returning, so the new run records the one it replaced as its
 * parent instead). The idle gap is the task detector's idle timeout, measured
 * on record timestamps, and ends the main agent's run only in a session that
 * has never sent a prompt event. A subagent keeps whatever run the main agent
 * had open when the subagent first appeared, since that skill is what spawned
 * it; later prompts, idle gaps, and skills on the main agent don't move it.
 */
export class SkillActivationTracker implements Resettable {
  /** Per session, per agent; `null` pins a subagent that appeared outside any run. */
  private readonly sessions = new Map<string, Map<string, SkillStamp | null>>();
  /**
   * Latest record timestamp per session, from any agent, so a subagent's work
   * isn't idle time. `null` marks a session that has sent a prompt: its
   * prompts close runs accurately, so it never closes on a gap.
   */
  private readonly lastActivity = new Map<string, number | null>();

  private runsFor(sessionId: string | null | undefined): Map<string, SkillStamp | null> {
    const key = sessionId ?? NULL_SESSION_KEY;
    let runs = this.sessions.get(key);
    if (runs) {
      this.sessions.delete(key);
    } else {
      if (this.sessions.size >= DEFAULT_MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) {
          this.sessions.delete(oldest);
          this.lastActivity.delete(oldest);
        }
      }
      runs = new Map();
    }
    this.sessions.set(key, runs);
    return runs;
  }

  recordToolCall(record: ToolCallRecord): SkillStamp | null {
    const runs = this.runsFor(record.sessionId);
    const sessionKey = record.sessionId ?? NULL_SESSION_KEY;
    const last = this.lastActivity.get(sessionKey);
    if (last !== null) {
      if (last !== undefined && record.timestamp - last > DEFAULT_IDLE_TIMEOUT_MS) {
        runs.set(MAIN_AGENT_KEY, null);
      }
      if (last === undefined || record.timestamp > last)
        this.lastActivity.set(sessionKey, record.timestamp);
    }
    const agentKey = record.agentId ?? MAIN_AGENT_KEY;
    if (agentKey !== MAIN_AGENT_KEY && !runs.has(agentKey)) {
      if (runs.size > MAX_AGENTS_PER_SESSION) {
        for (const key of runs.keys()) {
          if (key === MAIN_AGENT_KEY) continue;
          runs.delete(key);
          break;
        }
      }
      runs.set(agentKey, runs.get(MAIN_AGENT_KEY) ?? null);
    }
    const open = runs.get(agentKey) ?? null;
    // An interrupted or failed Skill call never loaded the skill, and the
    // orphan sweep can emit it after later prompts; neither should open a run.
    if (record.toolName === 'Skill' && record.skillName && record.success) {
      // Claude Code expands a slash-invoked skill itself; a Skill call naming
      // the same skill right after is the same invocation, not a second one.
      if (open?.source === 'slash' && open.name === record.skillName) return open;
      const stamp: SkillStamp = {
        name: record.skillName,
        source: 'tool',
        runId: randomUUID(),
        ...(open && { parentRunId: open.runId }),
      };
      runs.set(agentKey, stamp);
      return stamp;
    }
    return open;
  }

  /** Closes the main agent's run and returns the slash run it opens, if any. */
  recordPrompt(
    sessionId: string | null | undefined,
    slashCommand: string | null,
  ): SkillStamp | null {
    const stamp: SkillStamp | null = slashCommand
      ? { name: slashCommand, source: 'slash', runId: randomUUID() }
      : null;
    this.runsFor(sessionId).set(MAIN_AGENT_KEY, stamp);
    this.lastActivity.set(sessionId ?? NULL_SESSION_KEY, null);
    return stamp;
  }

  getMetrics(sessionId?: string): SkillActivationMetrics {
    const sessions =
      sessionId === undefined ? [...this.sessions.values()] : [this.sessions.get(sessionId)];
    // A subagent pinned to the main run holds the same stamp, so key by run id.
    const openRuns = new Map<string, SkillStamp>();
    for (const runs of sessions) {
      for (const stamp of runs?.values() ?? []) if (stamp) openRuns.set(stamp.runId, stamp);
    }
    return { openRuns: [...openRuns.values()] };
  }

  reset(_sessionId?: string): void {
    this.sessions.clear();
    this.lastActivity.clear();
  }
}
