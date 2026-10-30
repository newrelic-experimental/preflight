---
title: Architecture
description: How Preflight collects, processes, and ships telemetry as a sidecar to your AI coding session.
---

# Preflight Architecture

Preflight runs as a sidecar to your AI coding session. It collects hook events from the AI client, processes them into structured records, feeds metric trackers, and flushes telemetry to New Relic — all without interfering with the AI client itself.

---

## Data Flow (stdio and local modes)

```
 ┌──────────────────────────────────────────────────────────────────┐
 │                          Claude Code                              │
 │       Pre / Post / Failure hooks          MCP client (stdio)      │
 └───────────┬──────────────────────────────────────┬───────────────┘
             │ spawns process                        │
             │ hook JSON via stdin                   │ MCP stdio
             ▼                                       │
 ┌───────────────────────────┐                       │
 │      Collection Plane     │                       │
 │   (hook path — not MCP)   │                       │
 │                           │                       │
 │   collector-script.ts     │                       │
 │   < 5 ms · stdin → disk   │                       │
 │           │               │                       │
 │           ▼               │                       │
 │   buffer-SESSION.jsonl    │                       │
 └───────────┬───────────────┘                       │
             │ polled every 100 ms                   │
             ▼                                       │
 ┌───────────────────────────────────────────────────┼───────────────┐
 │                       Processing pipeline                 │               │
 │              (runs in --stdio AND --local)         │               │
 │                                                   │               │
 │   HookEventProcessor                              │               │
 │   pairs pre/post events → ToolCallRecord          │               │
 │               │                                   │               │
 │       ┌───────┴───────────┐                       │               │
 │       │                   │                       │               │
 │       ▼                   ▼                       │               │
 │   ~15 metric          NrIngestManager             │               │
 │   trackers            HarvestScheduler            │               │
 │   ───────────         ─────────────────           │               │
 │   Session             Events    every 5 s  ───────────────────► New Relic
 │   Cost                Metrics  every 60 s  ───────────────────► New Relic
 │   TaskDetector        Logs      every 5 s  ───────────────────► New Relic
 │   AntiPattern         OTLP (optional)      ───────────────────► New Relic
 │   Latency                                         │               │
 │   Retry                                           │               │
 │   Audit                                           │               │
 │   ContextWindow                                   │               │
 │       │                                           │               │
 └───────┼───────────────────────────────────────────┼───────────────┘
         │ getMetrics()                              │
         ├───────────────────────┐                  │
         │                       │                  │
 ┌───────┴───────────┐   ┌───────┴──────────┐       │
 │    --stdio mode   │   │   --local mode   │       │
 │                   │◄──┤                  │       │
 │   MCP tools       │   │   Dashboard      │       │
 │   nr_observe_*    │   │   HTTP :7777     │       │
 └───────────────────┘   └──────────────────┘       │
         ▲                                           │
         └───────────────────────────────────────────┘
                        MCP stdio
```

---

## Proxy Mode

Proxy mode is a **separate, mutually exclusive** code path. It does not use hooks or the collection plane above. Instead, Preflight sits between an MCP client and upstream MCP servers, intercepting traffic in flight.

```
 ┌─────────────────┐
 │  Any MCP client │
 └────────┬────────┘
          │ MCP (HTTP or stdio)
          ▼
 ┌──────────────────────────────────────────┐
 │              ProxyManager                │
 │   routes requests · intercepts responses │
 │           │               │              │
 │           ▼               ▼              │
 │   Upstream MCP        OtlpReceiver       │
 │   servers             enrich + forward   │──► New Relic (OTLP/HTTP)
 │                           │              │
 │                       debug log          │
 │                       (onToolCall /      │
 │                        onRequest)        │
 └──────────────────────────────────────────┘
```

---

## Component Reference

| Component              | File                           | Purpose                                                                                                                                                                        |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collector-script.ts`  | `src/hooks/`                   | Spawned by Claude Code hooks; reads hook JSON from stdin, appends to buffer file. Must complete in < 5 ms.                                                                     |
| `buffer-SESSION.jsonl` | `~/.newrelic-preflight/`       | Ring buffer of raw hook events. Written by collector, drained by `HookEventProcessor`.                                                                                         |
| `HookEventProcessor`   | `src/hooks/event-processor.ts` | Polls buffer every 100 ms. Pairs `PreToolUse` and `PostToolUse` events into `ToolCallRecord` objects.                                                                          |
| `PlatformRegistry`     | `src/platforms/`               | Detects the active AI coding platform and normalizes its tool names to Preflight's vocabulary. See [ADAPTERS.md](https://newrelic-experimental.github.io/preflight/adapters/). |
| Metric trackers (~15)  | `src/metrics/`                 | Each tracker receives every `ToolCallRecord` and maintains a typed metrics snapshot.                                                                                           |
| `NrIngestManager`      | `src/transport/nr-ingest.ts`   | Wraps `HarvestScheduler`; flushes events (5 s), metrics (60 s), and logs (5 s) to New Relic.                                                                                   |
| MCP tools              | `src/tools/`                   | Registered via `registerTools()`; read tracker state and return it as MCP tool responses. Active in `--stdio` mode.                                                            |
| Dashboard server       | `src/index.ts`                 | HTTP server on port 7777 serving the local web UI. Active in `--local` mode.                                                                                                   |
| `ProxyManager`         | `src/proxy/proxy-manager.ts`   | HTTP proxy that forwards MCP traffic to upstream servers and intercepts it for telemetry. Active in proxy mode only.                                                           |
| `OtlpReceiver`         | `src/proxy/`                   | Receives enriched OTLP payloads from `ProxyManager` and forwards to New Relic OTLP endpoint.                                                                                   |

---

## Modes

| Flag      | What runs                                                                               |
| --------- | --------------------------------------------------------------------------------------- |
| `--stdio` | Collection plane + Processing pipeline + MCP tools. Claude Code connects via MCP stdio. |
| `--local` | Collection plane + Processing pipeline + Dashboard HTTP server. No MCP connection.      |
| proxy     | ProxyManager + OtlpReceiver only. No hooks, no collection plane.                        |

---

## Key Design Decisions

**Hooks are not MCP.** The collection path (hooks → collector → buffer) runs entirely outside the MCP transport. Hook processes are spawned synchronously by Claude Code and must exit in under 5 ms — they cannot block on network or inter-process calls. The MCP server reads from the buffer asynchronously on its own poll interval.

**Processing pipeline is mode-agnostic.** `HookEventProcessor`, the metric trackers, and `NrIngestManager` run identically regardless of whether Preflight is in `--stdio` or `--local` mode. Only the consumer layer (MCP tools vs. dashboard) differs between modes.

**Each assistant turn is billed once.** `ParentTranscriptWatcher`, `SubagentWatcher` and `CopilotUsageWatcher` record each message id (a Copilot `responseId`) in a billed-turn ledger before they write the turn to the buffer. The ledger is one append-only file per UTC day under `~/.newrelic-preflight/billed-turns/`, shared by every Preflight process on the machine, and the first session to claim a message id owns its cost. So a restart that re-reads a transcript or debug log, whether it moved to a new project directory or its cursor file was torn by a crash, does not bill its turns again, and neither does a session started with `claude --resume <id> --fork-session`, whose transcript copies its parent's turns. Each Preflight process claims under its own random id, so two processes tailing the same session also bill each turn once. The guarantee has four known limits:

- Session totals are saved every 30 seconds (`NR_AI_SESSION_PERSIST_INTERVAL_MS`). If Preflight is killed before the next save, the cost of the turns since the last save is lost, up to one interval. A restart does not recover it, because the ledger already holds those turns.
- The ledger is pruned with session files after `retainSessionsDays` (default 90). A turn first seen more than that many days after it happened is not billed. With `retainSessionsDays: null` the ledger is never pruned. A turn with no timestamp is recorded in `undated.jsonl`, which is never pruned.
- A turn whose buffer write fails (a full disk, a permissions error) is retried on the next poll, but only while the process lives: a crash before the retry loses it.
- The ledger starts empty on upgrade. A fork of a session billed by an earlier version can still bill the parent's turns a second time, once.

**Proxy mode is fully separate.** Proxy mode does not use the hook collection path at all. It is architecturally independent and mutually exclusive with stdio/local modes.
