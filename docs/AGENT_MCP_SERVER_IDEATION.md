# New Relic MCP Observability Server — Ideation Document

> Designing an MCP server that provides deep observability into AI coding assistants like Claude Code and Gemini — from the inside.

---

## Table of Contents

1. [The Core Insight](#1-the-core-insight)
2. [What's Observable](#2-whats-observable)
3. [Architecture](#3-architecture)
4. [Metric Taxonomy](#4-metric-taxonomy)
5. [Novel Metrics Deep Dive](#5-novel-metrics-deep-dive)
6. [Implementation Detail](#6-implementation-detail)
7. [Dashboards & Alerts](#7-dashboards--alerts)
8. [Implementation Phases](#8-implementation-phases)
9. [Comparison: SDK Agent vs MCP Server](#9-comparison-sdk-agent-vs-mcp-server)
10. [Open Questions & Risks](#10-open-questions--risks)

---

## 1. The Core Insight

The [NEW_AGENT_IDEATION.md](./NEW_AGENT_IDEATION.md) describes an agent that instruments your code's _calls to_ AI models. But what about observing the AI assistant itself — the tool it uses, the decisions it makes, the work it does?

**You can't install an agent inside Claude Code or Gemini.** You don't control their internals. But you _can_ install an MCP server that Claude Code connects to — and MCP servers see everything that flows through them.

**The insight**: An MCP server doesn't just _serve_ tools — it can _observe_ the AI assistant's behavior. Every tool call, every resource read, every decision the assistant makes flows through the MCP protocol as structured JSON-RPC messages. An observability MCP server can:

1. **Proxy other MCP servers** — sit between the AI assistant and its tools, intercepting all traffic
2. **Use Claude Code hooks** — capture built-in tool calls (Read, Write, Edit, Bash, Grep, Glob) that don't flow through MCP
3. **Expose observability tools** — give the AI assistant (or user) real-time access to its own performance metrics
4. **Report to New Relic** — stream all captured data to New Relic for dashboarding, alerting, and analysis

This is a fundamentally different observability model than traditional APM. Instead of instrumenting application code, you're instrumenting the _AI's workflow_ — watching how it thinks, acts, and solves problems.

### Who Would Use This?

- **Engineering teams** deploying Claude Code, Cursor, Windsurf, or similar AI coding assistants at scale
- **Platform/DevEx teams** evaluating AI assistant effectiveness across their organization
- **Individual developers** wanting to understand and optimize their AI assistant usage
- **Security teams** auditing what AI assistants are reading, writing, and executing

---

## 2. What's Observable

### 2.1 MCP Protocol Messages (Directly Observable)

Every MCP interaction is a JSON-RPC 2.0 message. A proxy MCP server sees:

| Message Type              | What It Tells You                                                              |
| ------------------------- | ------------------------------------------------------------------------------ |
| `tools/list`              | Which tools are available, how often the assistant discovers them              |
| `tools/call` (request)    | Tool name, arguments (file paths, search queries, bash commands, NRQL queries) |
| `tools/call` (response)   | Tool output, success/failure, content size                                     |
| `resources/list`          | What data sources the assistant queries                                        |
| `resources/read`          | Which resources it accesses, how often                                         |
| `prompts/get`             | Which prompt templates are used                                                |
| `notifications/progress`  | Long-running operation progress                                                |
| `notifications/cancelled` | Abandoned operations                                                           |

### 2.2 Claude Code Hooks (Observable via Shell Hooks)

Claude Code supports **hooks** — shell commands that fire on tool call events. These capture built-in tool activity that doesn't flow through MCP:

| Hook Event    | Built-in Tools Captured                                          |
| ------------- | ---------------------------------------------------------------- |
| `PreToolUse`  | Fires before any tool executes — captures tool name + full input |
| `PostToolUse` | Fires after any tool executes — captures tool name + output      |

Built-in tools observable via hooks:

- **Read** — file path, line range, content returned
- **Write** — file path, content written
- **Edit** — file path, old_string, new_string, replace_all
- **Bash** — command executed, exit code, stdout/stderr
- **Grep** — pattern, path, matches found
- **Glob** — pattern, path, files matched
- **Agent** (sub-agent spawning) — description, prompt, subagent type
- **AskUserQuestion** — questions asked, user responses
- **TaskCreate/TaskUpdate** — task lifecycle events
- **NotebookEdit** — Jupyter cell modifications

### 2.3 Conversation Transcripts (Observable via File Parsing)

Claude Code saves full conversation transcripts as `.jsonl` files in `~/.claude/projects/`. These contain:

| Data                | What It Tells You                                      |
| ------------------- | ------------------------------------------------------ |
| User messages       | Task descriptions, questions, corrections              |
| Assistant responses | Full text output including reasoning                   |
| Tool call sequences | Complete ordered workflow                              |
| Token usage         | Input/output token counts per turn (from API metadata) |
| Timing              | Timestamps for each message and tool call              |
| Model info          | Which model was used (Opus, Sonnet, Haiku)             |

### 2.4 File System Changes (Observable via Git/FS Watching)

| Signal                 | What It Tells You                     |
| ---------------------- | ------------------------------------- |
| Git diffs              | Lines added/removed/modified per task |
| File creation/deletion | New files, removed files              |
| Test results           | Pass/fail after AI-generated changes  |
| Build results          | Compilation success/failure           |
| Lint results           | Code quality of AI output             |

### 2.5 What's NOT Observable (Limitations)

| Data                           | Why Not                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Internal model reasoning       | Thinking blocks may be visible in transcripts if extended thinking is enabled, but the model's internal weights/attention are opaque |
| Anthropic API costs directly   | Claude Code handles billing — but token counts ARE visible, so costs can be computed                                                 |
| Other users' sessions          | Each MCP server instance sees only its own session                                                                                   |
| Gemini web interface internals | No MCP support — this approach works for MCP-compatible assistants only                                                              |

---

## 3. Architecture

### Three-Layer Observability Stack

The MCP observability server uses three complementary data collection mechanisms:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Claude Code Session                             │
│                                                                         │
│   User Message: "Fix the failing auth test"                            │
│         │                                                               │
│         ▼                                                               │
│   ┌─────────────────┐                                                  │
│   │  Claude Model    │  (thinking, planning, generating)                │
│   └────────┬────────┘                                                  │
│            │                                                            │
│            ├──── Built-in Tool Calls ────────────────┐                 │
│            │     (Read, Write, Edit, Bash,            │                 │
│            │      Grep, Glob, Agent, etc.)            │                 │
│            │                                          ▼                 │
│            │                              ┌─────────────────────┐      │
│            │                              │  Hook Collector      │      │
│            │                              │  (PreToolUse /       │ [1]  │
│            │                              │   PostToolUse hooks) │      │
│            │                              └──────────┬──────────┘      │
│            │                                         │                  │
│            ├──── MCP Tool Calls ─────────────────────┼──┐              │
│            │     (NR MCP, Confluence,                 │  │              │
│            │      Bedrock, Google Search)             │  ▼              │
│            │                              ┌──────────────────────┐     │
│            │                              │  MCP Proxy Layer      │     │
│            │                              │  (intercepts all MCP  │ [2] │
│            │                              │   traffic to upstream  │     │
│            │                              │   servers)             │     │
│            │                              └──────────┬───────────┘     │
│            │                                         │                  │
│            │              ┌──────────────────────────┘                  │
│            │              │                                             │
│            │              ▼                                             │
│            │   ┌──────────────────────────────────┐                    │
│            │   │  NR AI Observability MCP Server   │                   │
│            │   │                                    │                   │
│            │   │  ┌────────────┐ ┌──────────────┐ │                   │
│            │   │  │ Event      │ │ Metric       │ │                   │
│            │   │  │ Aggregator │ │ Aggregator   │ │                   │
│            │   │  └────────────┘ └──────────────┘ │                   │
│            │   │  ┌────────────┐ ┌──────────────┐ │                   │
│            │   │  │ Workflow   │ │ Session      │ │                   │
│            │   │  │ Tracer     │ │ Tracker      │ │                   │
│            │   │  └────────────┘ └──────────────┘ │                   │
│            │   │  ┌────────────┐ ┌──────────────┐ │                   │
│            │   │  │ Cost       │ │ Quality      │ │                   │
│            │   │  │ Calculator │ │ Scorer       │ │                   │
│            │   │  └────────────┘ └──────────────┘ │                   │
│            │   │                                    │                   │
│            │   │  Tools exposed to Claude Code:     │                   │
│            │   │  - get_session_metrics             │ [3]              │
│            │   │  - get_cost_summary                │                   │
│            │   │  - get_workflow_trace               │                   │
│            │   │  - report_quality_feedback          │                   │
│            │   │                                    │                   │
│            │   └──────────────┬───────────────────┘                    │
│            │                  │                                         │
└────────────┼──────────────────┼─────────────────────────────────────────┘
             │                  │
             │                  │  (HTTPS, gzip, JSON)
             │                  ▼
             │         ┌──────────────────┐
             │         │  New Relic        │
             │         │  (Events API +    │
             │         │   Metrics API +   │
             │         │   Logs API)       │
             │         └──────────────────┘
             │
             ▼
    ┌──────────────────┐
    │  Upstream MCP     │
    │  Servers           │
    │  (NR, Confluence,  │
    │   Bedrock, etc.)   │
    └──────────────────┘
```

### Layer [1]: Hook Collector

A lightweight shell script installed as Claude Code hooks. Captures all built-in tool activity.

**Configuration** (in Claude Code `settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "command": "/usr/local/bin/nr-ai-observe pre-tool"
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "command": "/usr/local/bin/nr-ai-observe post-tool"
      }
    ]
  }
}
```

The hook script:

- Receives tool name and input via stdin (JSON)
- `pre-tool`: Records timestamp, tool name, input hash
- `post-tool`: Records timestamp, output size, success/failure, computes duration
- Writes events to a local buffer file (or sends directly to the MCP server via HTTP)

### Layer [2]: MCP Proxy

An MCP server that presents itself to Claude Code as a replacement for upstream servers. It forwards requests transparently while capturing timing, input/output, and errors.

**How it works:**

1. Configure Claude Code to connect to the proxy instead of the real MCP server
2. The proxy connects to the real server as a client
3. Every `tools/call` request is intercepted: timestamp recorded, forwarded to upstream, response timed and captured
4. The proxy adds zero-latency overhead except for the measurement bookkeeping

**Configuration** (replacing direct server connections):

```json
{
  "mcpServers": {
    "nr-mcp-server": {
      "type": "http",
      "url": "http://localhost:9847/proxy/nr-mcp-server"
    },
    "atlassian-confluence": {
      "type": "http",
      "url": "http://localhost:9847/proxy/atlassian-confluence"
    }
  }
}
```

The proxy server knows the real upstream URLs and forwards transparently.

### Layer [3]: Observability MCP Server

The core server that aggregates data from hooks and proxy, computes metrics, and exposes them in two ways:

**A. To Claude Code** (via MCP tools and resources):

The AI assistant can query its own metrics:

- `get_session_metrics` — "How many tool calls have I made? What's my cost so far?"
- `get_cost_summary` — "How much has this conversation cost?"
- `get_workflow_trace` — "Show me the trace of my last task"
- `report_quality_feedback` — Let the user report quality issues through the assistant

**B. To New Relic** (via HTTPS API):

Background harvest loop sends:

- Custom events per tool call
- Aggregated metrics per session
- Workflow traces as distributed traces
- Session summaries

### Data Flow Summary

```
Built-in tool call  →  Hook script  →  Local buffer  →  MCP Server  →  New Relic
MCP tool call       →  Proxy layer  →  MCP Server    →  New Relic
Conversation data   →  Transcript parser  →  MCP Server  →  New Relic
```

---

## 4. Metric Taxonomy

### 4.1 Tool Usage Metrics

| Metric                         | Description                                                        | Source             |
| ------------------------------ | ------------------------------------------------------------------ | ------------------ |
| `ai.tool.call_count`           | Total tool calls in session                                        | Hook + Proxy       |
| `ai.tool.call_count_by_tool`   | Calls per tool type (Read, Write, Bash, etc.)                      | Hook + Proxy       |
| `ai.tool.duration_ms`          | Time per tool call                                                 | Hook timing        |
| `ai.tool.success_rate`         | % of tool calls that succeeded                                     | Hook + Proxy       |
| `ai.tool.error_count`          | Failed tool calls                                                  | Hook + Proxy       |
| `ai.tool.error_types`          | Error classification (permission denied, not found, timeout, etc.) | Hook + Proxy       |
| `ai.tool.output_size_bytes`    | Response payload size                                              | Hook + Proxy       |
| `ai.tool.input_size_bytes`     | Request payload size                                               | Hook + Proxy       |
| `ai.tool.retry_count`          | Tool calls that were retried                                       | Sequence detection |
| `ai.tool.unique_files_read`    | Distinct files accessed via Read                                   | Hook               |
| `ai.tool.unique_files_written` | Distinct files modified via Write/Edit                             | Hook               |
| `ai.tool.bash_commands_run`    | Number of Bash tool invocations                                    | Hook               |
| `ai.tool.bash_exit_codes`      | Distribution of exit codes from Bash commands                      | Hook               |
| `ai.tool.search_queries`       | Number of Grep/Glob search operations                              | Hook               |

### 4.2 Workflow & Task Metrics

| Metric                            | Description                                       | Source                 |
| --------------------------------- | ------------------------------------------------- | ---------------------- |
| `ai.workflow.task_duration_ms`    | Time from user message to final response          | Transcript timing      |
| `ai.workflow.tool_calls_per_task` | Number of tool calls to complete a task           | Hook counting          |
| `ai.workflow.turns_per_task`      | Conversation turns per task                       | Transcript parsing     |
| `ai.workflow.files_touched`       | Unique files read or modified                     | Hook aggregation       |
| `ai.workflow.lines_changed`       | Net lines added/removed (from Edit/Write tools)   | Hook content analysis  |
| `ai.workflow.agent_spawns`        | Sub-agents created during task                    | Agent tool hook        |
| `ai.workflow.plan_created`        | Whether a plan was created (EnterPlanMode)        | Hook                   |
| `ai.workflow.plan_iterations`     | Number of plan revisions                          | Hook sequence analysis |
| `ai.workflow.user_interruptions`  | Times the user interrupted the assistant mid-work | Transcript parsing     |
| `ai.workflow.user_corrections`    | Times the user corrected the assistant's approach | Transcript heuristic   |
| `ai.workflow.ask_user_count`      | Times the assistant asked the user a question     | AskUserQuestion hook   |

### 4.3 Code Quality Metrics

| Metric                                 | Description                                   | Source                              |
| -------------------------------------- | --------------------------------------------- | ----------------------------------- |
| `ai.code.test_pass_rate_after_change`  | % of test runs that pass after AI edits       | Bash hook (test command detection)  |
| `ai.code.build_success_rate`           | % of builds that succeed after AI edits       | Bash hook (build command detection) |
| `ai.code.lint_violations_introduced`   | New lint errors in AI-modified code           | Bash hook (lint command detection)  |
| `ai.code.lines_added`                  | Lines of code added                           | Edit/Write hook analysis            |
| `ai.code.lines_removed`                | Lines of code removed                         | Edit hook analysis                  |
| `ai.code.files_created`                | New files created                             | Write hook                          |
| `ai.code.edit_precision`               | Ratio of targeted edits vs full file rewrites | Edit vs Write hook                  |
| `ai.code.compile_error_fix_iterations` | Attempts to fix a compilation error           | Bash hook sequence analysis         |

### 4.4 Cost & Token Metrics

| Metric                               | Description                         | Source                             |
| ------------------------------------ | ----------------------------------- | ---------------------------------- |
| `ai.cost.session_total_usd`          | Total estimated cost of the session | Token count × pricing              |
| `ai.cost.per_task_usd`               | Estimated cost per completed task   | Task boundary detection            |
| `ai.cost.tokens_input`               | Total input tokens consumed         | Transcript metadata                |
| `ai.cost.tokens_output`              | Total output tokens generated       | Transcript metadata                |
| `ai.cost.tokens_thinking`            | Extended thinking tokens consumed   | Transcript metadata (if available) |
| `ai.cost.tokens_cache_read`          | Tokens served from prompt cache     | Transcript metadata (if available) |
| `ai.cost.model_used`                 | Which model handled the session     | Transcript metadata                |
| `ai.cost.context_window_utilization` | % of context window used            | Token tracking                     |
| `ai.cost.cost_per_line_of_code`      | Estimated cost per line generated   | Cost / lines_added                 |
| `ai.cost.cost_per_file_modified`     | Average cost per file touched       | Cost / files_touched               |

### 4.5 MCP Server Metrics (Proxy Layer)

| Metric                      | Description                                 | Source            |
| --------------------------- | ------------------------------------------- | ----------------- |
| `ai.mcp.server_call_count`  | Calls to each upstream MCP server           | Proxy             |
| `ai.mcp.server_latency_ms`  | Response time per upstream server           | Proxy timing      |
| `ai.mcp.server_error_rate`  | Error rate per upstream server              | Proxy             |
| `ai.mcp.tool_popularity`    | Most-called MCP tools across servers        | Proxy aggregation |
| `ai.mcp.auth_failures`      | Authentication failures to upstream servers | Proxy             |
| `ai.mcp.payload_size_bytes` | Request/response sizes per server           | Proxy             |

### 4.6 Session & Developer Experience Metrics

| Metric                                | Description                                            | Source                   |
| ------------------------------------- | ------------------------------------------------------ | ------------------------ |
| `ai.session.duration_ms`              | Total session length                                   | Session lifecycle        |
| `ai.session.active_time_ms`           | Time Claude was actively working (vs waiting for user) | Timestamp analysis       |
| `ai.session.idle_time_ms`             | Time waiting for user input                            | Timestamp analysis       |
| `ai.session.user_messages`            | Number of user messages                                | Transcript               |
| `ai.session.assistant_messages`       | Number of assistant responses                          | Transcript               |
| `ai.session.context_compressions`     | Times context was compressed/summarized                | Transcript heuristic     |
| `ai.session.average_response_time_ms` | Mean time from user message to first assistant output  | Transcript timing        |
| `ai.session.permission_prompts`       | Times the user was asked for permission                | Hook (permission events) |
| `ai.session.permission_denials`       | Times the user denied a tool call                      | Hook                     |

---

## 5. Novel Metrics Deep Dive

### 5.1 AI Coding Efficiency Score

**The problem**: Organizations adopting AI coding assistants want to know: "Is Claude Code actually making our developers more productive, or are they spending more time babysitting it than they'd spend coding?"

**The solution**: A composite efficiency score based on observable signals.

```
Coding Efficiency Score = normalize(
    lines_changed / task_duration_ms       * 0.25   // raw output speed
  + test_pass_rate_after_change            * 0.25   // correctness
  + (1 - user_corrections / turns)         * 0.25   // autonomy
  + (1 - compile_error_fix_iterations / 3) * 0.25   // first-attempt quality
)
```

**What you can do with this:**

- Compare efficiency across different types of tasks (bug fixes vs features vs refactors)
- Track efficiency trends over time (are developers getting better at prompting?)
- Compare efficiency across models (Opus vs Sonnet for different task types)
- Identify tasks where AI assistance is net-negative (score < 0.3 = probably faster to code manually)
- Set team-level efficiency baselines and detect regressions

**Visualization**: A daily efficiency score line chart per developer, with overlaid markers for model changes, prompt template updates, or Claude Code version updates.

### 5.2 Tool Call Pattern Analysis

**The problem**: AI coding assistants have characteristic work patterns — Read → Edit → Test → Fix cycles. Understanding these patterns reveals inefficiencies.

**The solution**: Sequence mining on tool call streams to identify patterns, anti-patterns, and optimization opportunities.

**Common healthy patterns:**

```
[Read, Read, Read, Edit, Bash(test)]           // Read context → make change → verify
[Grep, Read, Edit, Edit, Bash(test)]           // Search → understand → fix → verify
[Agent(explore), Read, Read, Edit, Bash(test)] // Delegate research → implement
```

**Anti-patterns to detect:**

```
[Read, Edit, Bash(test:FAIL), Edit, Bash(test:FAIL), Edit, Bash(test:FAIL), ...]
  → "Thrashing" — repeatedly failing the same test. Alert after 3+ failures.

[Read(file_a), Read(file_b), Read(file_a), Read(file_c), Read(file_a), ...]
  → "Re-reading" — reading the same file repeatedly. Context may be getting compressed.

[Bash(cmd), Bash(cmd), Bash(cmd), ...]  (same command)
  → "Stuck loop" — running the same command expecting different results.

[Edit, Edit, Edit, Edit, ...]  (same file, no test between)
  → "Blind editing" — making multiple changes without verification.

[Agent, Agent, Agent, ...]
  → "Over-delegation" — spawning too many sub-agents instead of doing the work.
```

**Derived metrics:**

- `pattern_health_score` — % of tool sequences matching healthy patterns
- `thrash_rate` — % of tasks that enter a fail-fix-fail loop
- `read_efficiency` — unique files read vs total Read calls (lower = more re-reading)
- `verify_rate` — % of edits followed by a test/build command

### 5.3 Developer-AI Collaboration Profile

**The problem**: Different developers use AI assistants differently. Some provide detailed instructions and let the AI work autonomously. Others provide vague prompts and course-correct frequently. Understanding collaboration styles helps optimize team AI adoption.

**The solution**: Build a collaboration profile per developer based on session patterns.

**Profile dimensions:**

1. **Specificity** (how detailed are the developer's prompts?)
   - Measured by: average user message length, presence of file paths / line numbers, specificity of instructions
   - High specificity → fewer tool calls, higher first-attempt success

2. **Autonomy** (how much does the developer let the AI work independently?)
   - Measured by: tool calls between user messages, interruption rate, permission denial rate
   - High autonomy → longer uninterrupted work periods, more tool calls per turn

3. **Correction frequency** (how often does the developer redirect the AI?)
   - Measured by: messages containing negation ("no", "not that", "wrong"), re-prompts after incomplete work
   - Low correction → better prompt engineering or better task-AI fit

4. **Task complexity** (what kind of work does this developer give to AI?)
   - Measured by: tool call count per task, files touched per task, agent spawns per task
   - Higher complexity → more tool calls, more files, longer sessions

**Visualization**: Radar chart per developer showing the four dimensions. Team averages as a baseline. Identify "power users" whose patterns could be shared as best practices.

### 5.4 Context Window Pressure & Memory

**The problem**: Claude Code compresses conversation history as the context window fills up. Each compression potentially loses important context, which can cause the assistant to re-read files, forget decisions, or repeat work.

**The solution**: Track context window lifecycle as a first-class observable.

**Observable signals:**

- Context compressions (detectable via transcript structure changes or system messages)
- File re-reads after compression (the assistant reading files it already read earlier)
- Decision amnesia (the assistant asking questions it already resolved)
- Token accumulation rate (how fast is context filling up?)

**Metrics:**

- `context_pressure` — estimated % of context window used
- `compression_events` — count of context compressions in session
- `post_compression_reread_rate` — % of Read calls targeting already-read files after compression
- `effective_context_lifespan` — minutes of productive work before first compression

**Alerts:**

- "Context compressed 5 times in 30 minutes — task may be too large for single session"
- "Post-compression file re-read rate at 60% — consider breaking task into smaller pieces"

### 5.5 Cost-Per-Outcome Analysis

**The problem**: Raw token cost is meaningless without context. $5 for a critical bug fix is cheap; $5 for a typo fix is expensive.

**The solution**: Attribute costs to outcomes, not just API calls.

**Outcome categories** (auto-detected from tool patterns):

- **Bug fix**: Sequence includes test failure → code edit → test pass
- **Feature addition**: New files created, new functions written
- **Refactoring**: Files modified but no new functionality (detected by test suite remaining green)
- **Investigation/research**: Mostly Read/Grep/Glob with minimal edits
- **Configuration**: Editing config files, YAML, JSON, env files
- **Documentation**: Editing .md files, comments, docstrings
- **Failed attempt**: Session ended without successful test pass or user approval

**Derived metrics:**

- `cost_per_bug_fix` — average cost of AI-assisted bug fixes
- `cost_per_feature` — average cost of AI-assisted feature development
- `cost_per_failed_attempt` — money spent on tasks that didn't succeed
- `waste_ratio` — cost of failed attempts / total cost
- `roi_by_outcome` — estimated developer-hours saved × hourly rate - AI cost

### 5.6 Security Audit Trail

**The problem**: AI coding assistants read sensitive files, execute arbitrary commands, and modify code. Security teams need visibility into what the AI accessed and changed.

**The solution**: A comprehensive, tamper-evident audit trail of all AI actions.

**Tracked events:**

- Every file read (path, timestamp, who initiated the session)
- Every file write/edit (path, diff, timestamp)
- Every bash command executed (command, exit code, working directory)
- Every MCP server accessed (server, tool called, arguments)
- Every external network request (via Bash curl/wget detection)
- Every agent spawned (description, prompt, isolation mode)
- Sensitive file access alerts (`.env`, credentials, private keys, `.ssh/`)
- Destructive command detection (`rm -rf`, `git push --force`, `DROP TABLE`, etc.)

**Security-specific alerts:**

- "AI assistant read .env file containing API keys"
- "AI assistant executed `curl` to external URL during code generation"
- "AI assistant modified CI/CD pipeline configuration"
- "AI assistant accessed production database credentials file"

**Compliance features:**

- Immutable audit log (append-only, no deletion)
- Session recording with full tool call replay capability
- Configurable sensitive path patterns (regex-based)
- Integration with SIEM systems via New Relic log forwarding

### 5.7 Cross-Session Learning Metrics

**The problem**: Each Claude Code session starts fresh — there's no built-in way to track improvement or regression over time.

**The solution**: Track session-level metrics across sessions to identify trends.

**Longitudinal metrics:**

- Average efficiency score per week (are we getting better at AI-assisted coding?)
- Cost trend per developer per week (are costs stabilizing or growing?)
- Task success rate over time (are more tasks completing successfully?)
- Time-to-completion trend for similar tasks (is the AI getting faster on familiar codebases?)
- Model migration impact (what happened to metrics when we switched from Opus to Sonnet?)

**Session comparison:**

- "This week's average session cost $3.42 with 87% task success rate, vs last week's $4.11 and 79%"
- "Developer Alice's efficiency score improved 23% after she started providing file paths in prompts"
- "Bug fix tasks take 40% fewer tool calls than 4 weeks ago — CLAUDE.md improvements may be the cause"

### 5.8 Prompt Engineering Feedback Loop

**The problem**: Teams invest in CLAUDE.md files, system prompts, and conventions but have no way to measure their impact.

**The solution**: Track how changes to CLAUDE.md and project configuration affect AI performance.

**Observable:**

- Detect CLAUDE.md modifications (via file watch or git hook)
- Track metrics before and after CLAUDE.md changes
- A/B comparison: sessions with the old CLAUDE.md vs the new one

**Metrics:**

- `post_change_efficiency_delta` — efficiency score change after CLAUDE.md update
- `post_change_cost_delta` — cost change after CLAUDE.md update
- `post_change_correction_rate_delta` — correction rate change
- `context_tokens_for_claude_md` — how many tokens does CLAUDE.md consume?

**Alerts:**

- "CLAUDE.md update 3 days ago increased average task cost by 18% — review changes"
- "New CLAUDE.md reduced correction rate by 45% — effective improvement"

---

## 6. Implementation Detail

### 6.1 MCP Server Implementation (TypeScript)

The observability server itself is an MCP server, implemented in TypeScript using the MCP SDK.

**Tools exposed to Claude Code:**

```typescript
// Tools the AI assistant (or user via the assistant) can call:

tools/call "nr_observe_get_session_stats"
// Returns: { tool_calls: 47, duration_ms: 324000, estimated_cost_usd: 2.31,
//            files_read: 12, files_modified: 3, tests_run: 4, tests_passed: 3 }

tools/call "nr_observe_get_cost_breakdown"
// Returns: { total_usd: 2.31, by_model: { "claude-sonnet-4": 2.31 },
//            by_task: [{ task: "Fix auth test", cost: 1.87 }, ...] }

tools/call "nr_observe_get_workflow_trace"
// Returns: the full tool call trace for the current/last task as a tree

tools/call "nr_observe_get_efficiency_score"
// Returns: { score: 0.74, components: { speed: 0.82, correctness: 0.91,
//            autonomy: 0.65, first_attempt_quality: 0.58 } }

tools/call "nr_observe_report_feedback" { quality: "good", notes: "fixed it first try" }
// Records user quality feedback for the current task

tools/call "nr_observe_get_anti_patterns"
// Returns: [{ type: "thrashing", file: "auth.test.ts", iterations: 4,
//             suggestion: "Consider reading the test framework docs" }]
```

**Resources exposed:**

```typescript
resources/read "nr-observe://session/metrics"
// Current session metrics as JSON

resources/read "nr-observe://session/audit-log"
// Full audit trail of all tool calls

resources/read "nr-observe://session/cost"
// Cost breakdown for current session

resources/read "nr-observe://history/weekly-summary"
// Cross-session weekly summary (reads from local storage)
```

### 6.2 Hook Collector Script

A lightweight CLI tool installed alongside the MCP server:

```bash
#!/bin/bash
# /usr/local/bin/nr-ai-observe
# Receives hook data via stdin, forwards to MCP server

MODE=$1  # "pre-tool" or "post-tool"
HOOK_DATA=$(cat)

# Extract tool name and input from JSON
TOOL_NAME=$(echo "$HOOK_DATA" | jq -r '.tool_name // .toolName // "unknown"')
TIMESTAMP=$(date +%s%3N)

# Write to local buffer (picked up by MCP server)
echo "{\"mode\":\"$MODE\",\"tool\":\"$TOOL_NAME\",\"ts\":$TIMESTAMP,\"data\":$HOOK_DATA}" \
  >> ~/.nr-ai-observe/buffer.jsonl

# For post-tool, also compute duration if pre-tool timestamp exists
if [ "$MODE" = "post-tool" ]; then
  # Duration computation handled by MCP server when processing buffer
  :
fi
```

The MCP server polls the buffer file on a short interval (100ms), processes events, and clears the buffer.

### 6.3 MCP Proxy Implementation

The proxy server dynamically registers upstream servers and forwards all traffic:

```typescript
// Conceptual proxy architecture
class MCPProxy {
  private upstreams: Map<string, MCPClient>; // server-name → upstream client
  private observer: ObservabilityCollector;

  async handleToolCall(serverName: string, toolName: string, args: any) {
    const upstream = this.upstreams.get(serverName);
    const startTime = Date.now();

    try {
      const result = await upstream.callTool(toolName, args);

      this.observer.recordToolCall({
        server: serverName,
        tool: toolName,
        args: this.redactSensitive(args),
        duration_ms: Date.now() - startTime,
        success: true,
        output_size: JSON.stringify(result).length,
      });

      return result;
    } catch (error) {
      this.observer.recordToolCall({
        server: serverName,
        tool: toolName,
        duration_ms: Date.now() - startTime,
        success: false,
        error: error.message,
      });
      throw error;
    }
  }
}
```

### 6.4 New Relic Data Submission

The MCP server sends data to New Relic using three APIs:

**Events API** (per tool call, per task):

```json
POST https://insights-collector.newrelic.com/v1/accounts/{account_id}/events
Content-Type: application/json
Api-Key: {ingest_key}

[{
  "eventType": "AiToolCall",
  "tool": "Read",
  "duration_ms": 45,
  "success": true,
  "file_path": "src/auth.ts",
  "output_size_bytes": 2340,
  "session_id": "abc-123",
  "task_id": "task-456",
  "developer": "alice",
  "model": "claude-sonnet-4",
  "timestamp": 1712345678
}]
```

**Metrics API** (aggregated per harvest):

```json
POST https://metric-api.newrelic.com/metric/v1
Content-Type: application/json
Api-Key: {ingest_key}

[{
  "metrics": [{
    "name": "ai.session.tool_calls",
    "type": "count",
    "value": 47,
    "attributes": { "developer": "alice", "model": "claude-sonnet-4" }
  }, {
    "name": "ai.session.estimated_cost_usd",
    "type": "gauge",
    "value": 2.31,
    "attributes": { "developer": "alice", "model": "claude-sonnet-4" }
  }]
}]
```

**Logs API** (audit trail):

```json
POST https://log-api.newrelic.com/log/v1
Content-Type: application/json
Api-Key: {ingest_key}

[{
  "logs": [{
    "message": "Tool call: Bash command='npm test' exit_code=0",
    "attributes": {
      "session_id": "abc-123",
      "tool": "Bash",
      "developer": "alice"
    }
  }]
}]
```

### 6.5 Local Storage (Cross-Session Persistence)

For cross-session metrics and historical comparison:

```
~/.nr-ai-observe/
├── config.json              # License key, app name, preferences
├── buffer.jsonl             # Current hook event buffer (cleared after processing)
├── sessions/
│   ├── 2026-04-08_abc123.json  # Session summary
│   ├── 2026-04-08_def456.json
│   └── ...
├── weekly_summaries/
│   ├── 2026-W14.json
│   └── ...
├── pricing.json             # Model pricing table (updatable)
└── audit/
    ├── 2026-04-08.jsonl     # Daily audit log (append-only)
    └── ...
```

---

## 7. Dashboards & Alerts

### Pre-Built Dashboard: "AI Coding Assistant — Overview"

**Top row — Session in progress:**

- Active session duration
- Tool calls so far (with sparkline)
- Estimated cost so far
- Current task status
- Efficiency score (gauge)

**Row 2 — Tool Usage:**

- Tool call distribution (pie chart: Read 35%, Edit 20%, Bash 18%, Grep 15%, Write 7%, Other 5%)
- Tool call timeline (stacked bar chart over session duration)
- Tool success/failure rate (bar chart per tool type)
- Average tool latency by type

**Row 3 — Code Changes:**

- Files read vs modified (dual bar)
- Lines added/removed (delta chart)
- Test results timeline (green/red markers)
- Build results timeline

**Row 4 — Cost:**

- Cumulative session cost (line chart)
- Cost by task (horizontal bar)
- Token consumption rate (area chart)
- Model usage distribution

### Pre-Built Dashboard: "AI Coding Assistant — Team View"

**Top row — Team summary (last 7 days):**

- Total team AI spend
- Average efficiency score
- Total tasks completed
- Average cost per task
- Average task success rate

**Row 2 — Developer comparison:**

- Efficiency score by developer (bar chart, sorted)
- Cost per developer (bar chart)
- Tasks completed per developer
- Tool call patterns by developer (small multiples)

**Row 3 — Trends:**

- Weekly efficiency score trend (line per developer)
- Weekly cost trend
- Task success rate trend
- Anti-pattern frequency trend

**Row 4 — Optimization opportunities:**

- Top 10 most expensive tasks this week (with drill-down)
- Most common anti-patterns
- CLAUDE.md change impact (before/after)
- Model comparison (if multiple models used)

### Pre-Built Dashboard: "AI Coding Assistant — Security Audit"

- Complete tool call audit trail (filterable log view)
- Sensitive file access events (highlighted)
- Bash command history (with exit codes)
- External network access events
- Destructive operation attempts
- Permission denial log

### Alert Conditions

**Cost alerts:**

- "Session cost exceeded $10" (runaway session)
- "Daily team AI spend exceeded $500" (budget guard)
- "Developer X's cost increased >50% this week" (usage spike)

**Efficiency alerts:**

- "Efficiency score below 0.3 for >10 minutes" (AI may be struggling)
- "Thrashing detected: 5+ test failures on same file" (stuck loop)
- "Re-read rate exceeded 50% after context compression" (context loss)

**Security alerts:**

- "AI accessed file matching sensitive pattern: .env, credentials, private key"
- "AI executed destructive bash command"
- "AI accessed file outside project directory"

**Reliability alerts:**

- "MCP server X error rate exceeded 10%"
- "MCP server X latency exceeded 5 seconds"
- "Hook collector buffer growing (MCP server may be unresponsive)"

---

## 8. Implementation Phases

### Phase 1: Hook Collector + Basic MCP Server (2-3 weeks)

**Goal**: Capture all built-in tool calls and report to New Relic.

**Deliverables:**

- Hook collector script (`nr-ai-observe` CLI)
- Basic MCP server (TypeScript, stdio transport)
- Tool call event ingestion to New Relic Events API
- Session metrics: tool counts, durations, success rates
- One pre-built dashboard: "AI Coding Assistant — Overview"
- Installation instructions for Claude Code hooks + MCP server

### Phase 2: Cost Tracking + Workflow Analysis (2-3 weeks)

**Goal**: Add cost estimation and tool pattern analysis.

**Deliverables:**

- Token counting from conversation metadata (if accessible via hooks)
- Cost calculation with built-in pricing table
- Task boundary detection (heuristic: user message → tool sequence → user response)
- Anti-pattern detection (thrashing, re-reading, stuck loops)
- Efficiency score computation
- Cost and workflow tools exposed to Claude Code
- "AI Coding Assistant — Team View" dashboard

### Phase 3: MCP Proxy + Security Audit (3-4 weeks)

**Goal**: Intercept MCP server traffic and provide security visibility.

**Deliverables:**

- MCP proxy server with transparent forwarding
- Upstream server latency and error tracking
- Security audit trail (all file access, bash commands, external requests)
- Sensitive file access detection and alerting
- Audit log ingestion to New Relic Logs API
- "AI Coding Assistant — Security Audit" dashboard

### Phase 4: Cross-Session Intelligence (3-4 weeks)

**Goal**: Historical analysis and optimization recommendations.

**Deliverables:**

- Local session persistence and weekly summaries
- Cross-session trend analysis
- Developer collaboration profile
- CLAUDE.md change impact tracking
- Prompt engineering feedback loop
- Cost-per-outcome analysis
- Automated recommendations

### Phase 5: Multi-Platform Support (4-6 weeks)

**Goal**: Extend beyond Claude Code.

**Deliverables:**

- Cursor IDE integration (if hook/extension mechanism available)
- Windsurf integration
- GitHub Copilot integration (via VS Code extension telemetry)
- Generic MCP client support (any MCP-compatible assistant)
- Platform comparison dashboards

---

## 9. Comparison: SDK Agent vs MCP Server

These two approaches are **complementary, not competing**. They observe different things:

| Dimension                  | SDK Agent (NEW_AGENT_IDEATION)         | MCP Observability Server (this doc)          |
| -------------------------- | -------------------------------------- | -------------------------------------------- |
| **What it observes**       | Your app's calls TO AI models          | AI assistant's calls TO your tools           |
| **Perspective**            | Application-centric                    | Assistant-centric                            |
| **Who installs it**        | Application developer                  | AI assistant user / DevEx team               |
| **Where it runs**          | Inside your application                | Alongside the AI assistant (local)           |
| **Token/cost tracking**    | Direct from API response               | Inferred from conversation metadata          |
| **Thinking depth**         | Direct from API response               | May be available in transcripts              |
| **Tool call tracking**     | Only tool calls your app makes         | Every tool the assistant uses                |
| **Code quality metrics**   | N/A                                    | Test pass/fail, build success, lint          |
| **Workflow tracing**       | Agent workflow if using LangChain etc. | Full AI coding workflow (read → edit → test) |
| **Multi-model**            | Tracks whatever models your code calls | Tracks whatever model the assistant uses     |
| **Security audit**         | N/A                                    | Full audit trail of AI file/command access   |
| **Developer productivity** | N/A                                    | Efficiency scores, collaboration profiles    |

**The ideal setup**: Both. The SDK agent observes your production AI features (chatbots, content generation, code review). The MCP server observes your development AI tools (Claude Code, Cursor, Copilot). Together, they give complete AI observability across the entire software lifecycle.

```
Development Phase                              Production Phase
┌──────────────────────┐                       ┌──────────────────────┐
│  AI Coding Assistant  │                       │  Your Application    │
│  (Claude Code)        │                       │                      │
│       │               │                       │   anthropic.create() │
│       ▼               │                       │       │              │
│  MCP Observability    │───── Developer ──────▶│  SDK AI Agent        │
│  Server               │     writes code       │  (NEW_AGENT_IDEATION)│
│       │               │     with AI help      │       │              │
└───────┼───────────────┘                       └───────┼──────────────┘
        │                                               │
        ▼                                               ▼
   ┌─────────────────────────────────────────────────────────┐
   │                    New Relic Platform                     │
   │                                                          │
   │  "How my team uses AI"    "How my app uses AI"          │
   │  (dev productivity)        (production observability)     │
   └─────────────────────────────────────────────────────────┘
```

---

## 10. Open Questions & Risks

### Technical Risks

1. **Hook reliability**: Claude Code hooks are a user-facing feature but their stability guarantees are unclear. If Anthropic changes the hook contract, the collector breaks. Mitigation: graceful degradation — if hooks fail, proxy-only mode still works for MCP traffic.

   **Decision:** Agreed. Implement graceful degradation from day one. Hook-based observability enhances but never gates proxy-based observability.

2. **Token count accessibility**: It's unclear whether Claude Code exposes token counts in hook data or transcript files in a structured way. If not, cost tracking becomes estimation-only (based on message length × average tokens per character). Mitigation: the MCP server could also expose a tool that the AI calls to self-report its token usage — Claude can see its own usage.

   **Decision:** Agreed with the proposed solution. Expose a self-reporting tool as the primary mechanism; fall back to estimation when self-reporting is absent.

3. **Performance overhead**: Hook scripts execute for every tool call. If the script takes >50ms, it could noticeably slow down the assistant. Mitigation: fire-and-forget writes to a buffer file; async processing in the MCP server.

   **Decision:** Agreed. Fire-and-forget buffering is the right approach. Establish a <5ms budget for the hook script itself; all processing happens async in the MCP server.

4. **Transcript format stability**: Parsing `.jsonl` conversation files depends on an undocumented format. Mitigation: treat transcript parsing as a "nice to have" data source, not a critical one.

   **Decision:** Agreed. Transcript parsing is supplementary. Build it defensively with schema validation and graceful fallback when fields are missing or the format changes.

5. **Proxy complexity**: Acting as a transparent MCP proxy while preserving streaming, authentication, and error semantics is non-trivial. Some MCP servers use OAuth flows that may not forward cleanly. Mitigation: proxy is Phase 3, not Phase 1; start with hook-only observability.

   **Decision:** Agreed. Proxy is Phase 3. Hook-only observability ships first and provides the majority of value.

### Product Questions

6. **Privacy**: Recording all tool call inputs/outputs captures file contents, bash commands, and potentially sensitive code. Should the agent offer redaction patterns? Content hashing instead of raw content? Mitigation: configurable redaction, opt-in content recording (default off for file contents).

   **Decision:** Redaction patterns are required, not optional. Default posture is privacy-first: content recording off by default. Provide configurable regex-based redaction patterns for fields that are enabled. Content hashing is a valid alternative for audit trails that need to verify access without storing content.

7. **Multi-user**: In a team setting, should the MCP server aggregate data from all developers? Or should each developer have their own instance? Mitigation: individual instances with team-level aggregation in New Relic (via developer tag).

   **Decision:** Agreed. Individual instances per developer, with a `developer` tag for team-level aggregation in New Relic dashboards.

8. **Gemini compatibility**: This ideation focuses on Claude Code because it supports MCP. Google's Gemini Code Assist (in VS Code) may not support MCP servers. The hook approach won't work there. Mitigation: investigate VS Code extension APIs for Gemini-specific telemetry collection.

   **Decision:** Focus on Claude Code only for now. Gemini support can be evaluated later based on demand and MCP adoption.

9. **User consent**: Should the AI assistant be aware it's being observed? This is an ethical consideration — the MCP server's tools are visible to the assistant via `tools/list`. The assistant knows the observability tools exist. But should it be explicitly told? Mitigation: include an instructions field in the MCP server's initialize response: "This server monitors your tool usage for observability purposes."

   **Decision:** Agreed. Include an explicit disclosure in the MCP server's `initialize` response. Transparency is preferable to ambiguity.

10. **Value proposition clarity**: The target user for this product is the engineering manager or DevEx team that wants to understand and optimize AI assistant adoption. Individual developers may resist monitoring. The messaging needs to emphasize optimization and cost control, not surveillance.

    **Decision:** Agreed. Messaging should lead with developer benefit (personal productivity insights, cost visibility) and team benefit (optimization), not monitoring/compliance framing.

### Competitive Landscape

11. **Existing tools**: Cody Analytics (Sourcegraph), GitHub Copilot usage metrics, and Cursor's built-in analytics provide some developer AI metrics. The differentiation here is:
    - **Depth**: Tool-call-level granularity vs session-level summaries
    - **Integration**: Data flows into New Relic alongside APM, infra, and browser data
    - **Cross-platform**: Works with any MCP-compatible assistant, not vendor-locked
    - **Security audit**: None of the competitors offer file-access audit trails

    **Decision:** Noted. Cross-stack integration and tool-call-level depth are the primary differentiators. Security audit trail (file access, bash commands) is a meaningful secondary differentiator with no current competition.

---

_This document describes an observability system that watches AI coding assistants from the outside — via the tools they call, the files they access, and the commands they execute. Combined with the [SDK-level AI agent](./NEW_AGENT_IDEATION.md), it provides complete AI observability across both development and production._
