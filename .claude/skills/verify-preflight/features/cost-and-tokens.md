# Cost and tokens

Preflight reads each assistant turn's token usage from the Claude Code transcript and prices it per model with the bundled pricing table. The user sees session cost, cost by model, token totals, and cache hit rate on the dashboard and through the cost MCP tool.

## Sub-features

- `cost-turn` turns one transcript turn into cost under its exact model id.
- `cost-cache` counts cache-read tokens and a cache hit rate.
- `cost-estimate` gives tool calls with no transcript turn an estimated cost at the default model.
- `cost-aggregate` rolls today's spend into the Today aggregate.

## How to get to it (user POV)

- Use Claude Code normally. Its transcript under `~/.claude/projects/<project>/<sid>.jsonl` is read automatically.
- Read `spend today` on the Today page, or call `nr_observe_get_cost_breakdown`.

## Driving it with pf-verify

Preconditions:

- `$PF up` has run and `$PF doctor` passes.
- `SID=$($PF sid)` holds a fresh UUID.

- **One hook.** Run `$PF hook $SID Bash '{"command":"npm run build"}'` so the session exists.
- **One turn.** Run `$PF turn $SID claude-sonnet-4-5-20250929 1200 300 5000`. It prints the transcript path under the run's `HOME`.
- **Transcript consumed.** After 5s, `ls -a "$($PF where | sed -n 's/^run=//p')/store" | grep parent-transcript-pos-$SID` finds the watcher's cursor file.
- **Priced by model.** Run `$PF api /api/cost`. `costByModel` contains `"claude-sonnet-4-5-20250929":0.0096`. That is 1200 input at $3/M, 300 output at $15/M, and 5000 cache-read at $0.30/M. `totalCacheReadTokens` includes 5000.
- **Aggregate.** After one more persist, `$PF api /api/sessions/today/aggregate` reports a `totalCostUsd` of at least `0.01`.
- **Proof.** Save the `/api/cost` body and the transcript line (`tail -1` of the printed path) to the evidence dir.

## Gotchas

- `turn` refuses non-UUID ids, because the transcript watchers skip them. A hand-written transcript under a non-UUID filename is silently ignored.
- Without a `turn`, `costByModel` still shows a small `claude-sonnet-4-6` entry. That is the tool-I/O estimate, not a transcript read. Do not mistake it for the feature working.
- The expected dollar figure depends on `pricing-overlay/pricing.json` and `src/shared` pricing. If a pricing change is under test, recompute the expectation from that table instead of reusing `0.0096`.
- Each `turn` mints a new message id, so repeated turns add up. Rerunning the same line does not dedupe.
