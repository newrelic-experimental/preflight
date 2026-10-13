import { randomUUID } from 'node:crypto';

import type { SkillStamp, ToolCallRecord } from '../storage/types.js';
import type { Resettable } from './tracker-contracts.js';

const NULL_SESSION_KEY = '__no_session__';
const MAIN_AGENT_KEY = '';
const DEFAULT_MAX_SESSIONS = 50;

/**
 * Tracks the open skill run per session and per agent, so every tool call can
 * be stamped with the skill whose work it is. A run opens on a named `Skill`
 * tool call or a `/<skill>` prompt and lasts until the next prompt or the
 * next skill (last wins: there is no signal for a nested skill returning, so
 * the new run records the one it replaced as its parent instead). A subagent
 * with no run of its own inherits the main agent's, since the parent skill is
 * what spawned it.
 */
export class SkillActivationTracker implements Resettable {
  private readonly sessions = new Map<string, Map<string, SkillStamp>>();

  private runsFor(sessionId: string | null | undefined): Map<string, SkillStamp> {
    const key = sessionId ?? NULL_SESSION_KEY;
    let runs = this.sessions.get(key);
    if (runs) {
      this.sessions.delete(key);
    } else {
      if (this.sessions.size >= DEFAULT_MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      runs = new Map();
    }
    this.sessions.set(key, runs);
    return runs;
  }

  recordToolCall(record: ToolCallRecord): SkillStamp | null {
    const runs = this.runsFor(record.sessionId);
    const agentKey = record.agentId ?? MAIN_AGENT_KEY;
    const open = runs.get(agentKey) ?? runs.get(MAIN_AGENT_KEY);
    if (record.toolName === 'Skill' && record.skillName) {
      const stamp: SkillStamp = {
        name: record.skillName,
        source: 'tool',
        runId: randomUUID(),
        ...(open && { parentRunId: open.runId }),
      };
      runs.set(agentKey, stamp);
      return stamp;
    }
    return open ?? null;
  }

  recordPrompt(sessionId: string | null | undefined, slashCommand: string | null): void {
    const runs = this.runsFor(sessionId);
    runs.clear();
    if (slashCommand) {
      runs.set(MAIN_AGENT_KEY, { name: slashCommand, source: 'slash', runId: randomUUID() });
    }
  }

  reset(_sessionId?: string): void {
    this.sessions.clear();
  }
}
