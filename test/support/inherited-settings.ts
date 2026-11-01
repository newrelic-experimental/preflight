/**
 * The runner's inherited Preflight, New Relic, OTel and Claude Code variables. Shared by the
 * Jest global setup and playwright.config.ts so the two isolations cannot drift apart.
 */
export const INHERITED_SETTINGS = /^(NEW_RELIC_|NR_AI_|OTEL_|CLAUDE|MCP_CLIENT)/;
