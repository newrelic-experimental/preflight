# Agent Instructions: NR Preflight

New Relic MCP server + metrics engine + HTTP proxy for observing AI coding assistants. Flat single-package repo; source in `src/`, vendored shared code in `src/shared/`.

**The canonical conventions document is [CLAUDE.md](./CLAUDE.md).** It is written for all coding agents, not just Claude - read it before making changes. It covers architecture/data flow, TypeScript conventions, the metric tracker families, the platform adapter pattern, configuration, storage, security invariants, and commit/PR conventions.

## Essential commands

```bash
npm run build              # tsc build + web bundle
npm test                   # Jest, maxWorkers: 1
npx jest -- src/metrics/cost-tracker.test.ts   # single test file
npm run lint               # target: 0 errors, 0 warnings
npm run format:check       # Prettier
```

## Hard guardrails (repeated here because violations are costly)

- **Never edit anything under `src/shared/`** - it is a vendored snapshot. Bugs there get an issue, not a patch.
- **Never write to stdout** in server-path code - stdout is reserved for MCP stdio transport. Use the scoped `createLogger()` pattern (writes JSON to stderr).
- **Lint is zero-tolerance**: no `eslint-disable` comments, no `as any` / `: any` (use `as unknown as T`, concrete types, or generics), unused required params prefixed `_`.
- All internal imports use `.js` extensions (ESM + NodeNext).
- Co-located tests (`foo.ts` -> `foo.test.ts`); factory helpers named `make*` with `Partial<T>` overrides. See [docs/TEST_PATTERNS.md](./docs/TEST_PATTERNS.md).
- Platform adapters: never invent a tool-name map or setup instructions - every entry must trace to the platform's own documentation or source, cited in a comment. See [docs/ADAPTERS.md](./docs/ADAPTERS.md).
- `highSecurity=true` forces `recordContent=false` and must never be bypassed. See [SECURITY.md](./SECURITY.md).

## Docs map

| Topic                          | Doc                                                  |
| ------------------------------ | ---------------------------------------------------- |
| Per-platform adapter reference | [docs/ADAPTERS.md](./docs/ADAPTERS.md)               |
| MCP tool catalog               | [docs/COMMANDS_TABLE.md](./docs/COMMANDS_TABLE.md)   |
| Config field reference / OTLP  | [docs/ADVANCED.md](./docs/ADVANCED.md)               |
| Architecture                   | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)       |
| Test conventions               | [docs/TEST_PATTERNS.md](./docs/TEST_PATTERNS.md)     |
| Troubleshooting                | [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) |

## Copilot / VS Code specifics

- Both VS Code Copilot Chat and the GitHub Copilot CLI/SDK runtime read lifecycle hooks from `.github/hooks/*.json` with a Claude-compatible `PreToolUse`/`PostToolUse` stdin contract (each host documents that same repo-relative location independently). This repo ships [.github/hooks/preflight.json](./.github/hooks/preflight.json), which dogfoods `preflight-collector` for contributors on either host who have Preflight installed (it silently no-ops otherwise).
- Note for adapter work: [docs/ADAPTERS.md](./docs/ADAPTERS.md) classifies Copilot as `full-hooks` via VS Code agent hooks (uniform PreToolUse/PostToolUse envelope, camelCase `tool_input` keys, VS Code tool names). The legacy HTTP-push path (user-supplied extension → localhost:9847) remains as a fallback. Any adapter change must follow the sourcing rule (cite Copilot's own docs or source).
