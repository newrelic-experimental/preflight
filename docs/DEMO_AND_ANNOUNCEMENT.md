# NR AI Observatory — Slack Message & Demo Script

---

## Slack Message (Team Dev Channel)

> Hey team :wave:
>
> I've been building a side project and wanted to share it with you all — partly because I think it's cool, and partly because I'm curious if it could be useful beyond just me.
>
> **The short version:** I built an MCP server that observes AI coding assistants (like Claude Code) and ships the telemetry to New Relic. Think of it as "New Relic for your AI pair programmer."
>
> **Why I built it:** I wanted to get better at NRQL. So I figured — what better way to learn than to instrument something I use every day and then query the heck out of it? Turns out, once you start observing how an AI assistant works, you learn a lot about your own workflow too.
>
> **What it does:**
> - Tracks every tool call Claude Code makes (file reads, edits, bash commands, searches) and sends them as custom events to NR
> - Calculates cost per session, cost per task, and flags wasteful patterns (thrashing, re-reading files, blind edits)
> - Gives you an efficiency score, workflow traces, and recommendations — all queryable in NRQL
> - Includes a security audit trail for MCP proxy calls
> - Works across sessions — you can see trends over weeks, compare before/after CLAUDE.md changes, and get a collaboration profile
>
> **What it looks like:** I recorded a quick 2-min demo — [link]
>
> **What I'm curious about:**
> - Could this be useful as an onboarding tool? ("Here's what good AI-assisted development looks like at NR")
> - Could it be a customer-facing feature? ("Observe your AI coding tools with New Relic")
> - Is there a sales/demo angle? ("Look — we even use NR to observe our AI workflows")
> - Or is it just a fun side project? That's fine too :slightly_smiling_face:
>
> Would love your thoughts. Happy to walk anyone through it live if you're interested.
>
> — @cdehaan

---

## Demo Video Script (2-3 minutes)

### Opening (15 seconds)

**[Screen: Terminal with Claude Code open]**

"Hey, I'm Christopher de Haan. I've been building something called the NR AI Observatory — it's an MCP server that lets you observe AI coding assistants with New Relic. I built it to get better at NRQL, and I want to show you what it does."

---

### The Problem (20 seconds)

**[Screen: Claude Code running, tool calls flying by]**

"When you use an AI coding assistant like Claude Code, a lot is happening under the hood. It's reading files, running commands, making edits — dozens of tool calls per task. But you have no visibility into any of it. How much did that session cost? Was it efficient? Did it waste time re-reading files it already read? You're flying blind."

---

### The Solution (20 seconds)

**[Screen: Show `~/.nr-ai-observe/config.json` briefly, then the MCP server starting up in Claude Code]**

"The NR AI Observatory plugs into Claude Code as an MCP server. Once it's configured, it automatically captures every tool call — what tool was used, how long it took, whether it succeeded, the input and output sizes. All of that gets shipped to New Relic as custom events."

---

### Live Demo — Real-Time Stats (30 seconds)

**[Screen: Claude Code session, run a few commands, then call `nr_observe_get_session_stats`]**

"Let me show you. I'll ask Claude to do a few things... read some files, run a search. Now I'll ask it for session stats."

**[Show the session stats output: tool call counts, success rate, duration]**

"Six tool calls, 100% success rate, average duration 56 milliseconds. This is all tracked automatically — I didn't instrument anything manually."

---

### Live Demo — New Relic Dashboard (30 seconds)

**[Screen: Switch to browser, NR One, run NRQL query]**

"Now here's where it gets interesting. All of this data lands in New Relic. I can query it with NRQL."

**[Run: `FROM AiToolCall SELECT count(*) FACET tool SINCE 1 hour ago TIMESERIES`]**

"Tool calls by type over time. I can see exactly what Claude is doing and when."

**[Run: `FROM AiToolCall SELECT average(duration_ms) FACET tool SINCE 1 hour ago`]**

"Average duration per tool. Bash commands are slower — makes sense, they're running real processes. Reads are fast."

---

### Advanced Features (30 seconds)

**[Screen: Back in Claude Code]**

"There's more under the hood. The server detects anti-patterns — like when the AI re-reads the same file over and over, or makes edits without reading first. It calculates an efficiency score per task. It tracks cost based on token usage. And it works across sessions, so you can see trends over weeks."

**[Call `nr_observe_get_efficiency_score` or `nr_observe_get_recommendations`]**

"It even gives you recommendations. This is what I mean by 'New Relic for your AI tools.'"

---

### Why It Matters (15 seconds)

**[Screen: NRQL query results or a simple dashboard]**

"I started this to learn NRQL. But it turned into something bigger. If you think about onboarding — showing new engineers what effective AI-assisted development looks like. Or imagine this as a customer feature — 'observe your AI coding tools with New Relic.' The data's already there. We just had to collect it."

---

### Close (10 seconds)

**[Screen: GitHub repo or Slack channel]**

"That's the NR AI Observatory. It's open inside the org if you want to try it. I'd love feedback — especially on whether this is just a cool side project or something worth taking further. Thanks for watching."

---

## Production Notes

- **Total runtime target:** ~2:30
- **Screen recording tool:** QuickTime or OBS (record terminal + browser side by side)
- **Key NRQL queries to have ready:**
  - `FROM AiToolCall SELECT count(*) FACET tool SINCE 1 hour ago TIMESERIES`
  - `FROM AiToolCall SELECT average(duration_ms) FACET tool SINCE 1 hour ago`
  - `FROM AiToolCall SELECT count(*) FACET developer SINCE 1 day ago`
- **MCP tools to demo:**
  - `nr_observe_get_session_stats` (quick, always has data)
  - `nr_observe_get_efficiency_score` (impressive output)
  - `nr_observe_get_recommendations` (shows the "smart" side)
- **Before recording:** Run a few real tasks in Claude Code so there's meaningful data in NR. The demo is more compelling with real numbers, not a fresh session.
- **Tip:** Keep the terminal font large (16pt+). Non-technical viewers need to be able to read the output even on a small Slack video player.
