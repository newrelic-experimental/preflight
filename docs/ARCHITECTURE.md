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

| Component              | File                           | Purpose                                                                                                                          |
| ---------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `collector-script.ts`  | `src/hooks/`                   | Spawned by Claude Code hooks; reads hook JSON from stdin, appends to buffer file. Must complete in < 5 ms.                       |
| `buffer-SESSION.jsonl` | `~/.newrelic-preflight/`       | Ring buffer of raw hook events. Written by collector, drained by `HookEventProcessor`.                                           |
| `HookEventProcessor`   | `src/hooks/event-processor.ts` | Polls buffer every 100 ms. Pairs `PreToolUse` and `PostToolUse` events into `ToolCallRecord` objects.                            |
| `PlatformRegistry`     | `src/platforms/`               | Detects the active AI coding platform and normalizes its tool names to Preflight's vocabulary. See [ADAPTERS.md](./ADAPTERS.md). |
| Metric trackers (~15)  | `src/metrics/`                 | Each tracker receives every `ToolCallRecord` and maintains a typed metrics snapshot.                                             |
| `NrIngestManager`      | `src/transport/nr-ingest.ts`   | Wraps `HarvestScheduler`; flushes events (5 s), metrics (60 s), and logs (5 s) to New Relic.                                     |
| MCP tools              | `src/tools/`                   | Registered via `registerTools()`; read tracker state and return it as MCP tool responses. Active in `--stdio` mode.              |
| Dashboard server       | `src/index.ts`                 | HTTP server on port 7777 serving the local web UI. Active in `--local` mode.                                                     |
| `ProxyManager`         | `src/proxy/proxy-manager.ts`   | HTTP proxy that forwards MCP traffic to upstream servers and intercepts it for telemetry. Active in proxy mode only.             |
| `OtlpReceiver`         | `src/proxy/`                   | Receives enriched OTLP payloads from `ProxyManager` and forwards to New Relic OTLP endpoint.                                     |

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

**Proxy mode is fully separate.** Proxy mode does not use the hook collection path at all. It is architecturally independent and mutually exclusive with stdio/local modes.
