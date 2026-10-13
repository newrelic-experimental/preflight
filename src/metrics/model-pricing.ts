import type { ModelPricing } from '../shared/index.js';
import { createLogger, resolveModelPricing } from '../shared/index.js';

const logger = createLogger('model-pricing');

export type PricingResolution =
  | { readonly kind: 'priced'; readonly source: 'table'; readonly pricing: ModelPricing }
  | { readonly kind: 'priced'; readonly source: 'refreshed'; readonly pricing: ModelPricing }
  | {
      readonly kind: 'priced';
      readonly source: 'estimated';
      readonly pricing: ModelPricing;
      readonly estimatedFrom: string;
    }
  | { readonly kind: 'unpriced' };

const CLAUDE_ID_RE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/**
 * Removes one trailing `[...]` tag (e.g. `[1m]`). Linear scan instead of a
 * `/\[[^\]]*\]$/` regex, which backtracks quadratically on inputs with many `[`.
 */
export function stripTrailingTag(id: string): string {
  if (!id.endsWith(']')) return id;
  const prevClose = id.lastIndexOf(']', id.length - 2);
  const open = id.indexOf('[', prevClose + 1);
  return open === -1 ? id : id.slice(0, open);
}

export function stripTrailingTags(id: string): string {
  let current = id;
  for (let next = stripTrailingTag(current); next !== current; next = stripTrailingTag(current)) {
    current = next;
  }
  return current;
}
// Bedrock spells the same ids `[<region>.]anthropic.claude-...[-v1:0]`.
const BEDROCK_PREFIX_RE = /^(?:[a-z-]+\.)?anthropic\./;
const BEDROCK_VERSION_RE = /-v\d+(?::\d+)?$/;

interface ParsedClaudeId {
  readonly family: string;
  readonly major: number;
  readonly minor: number;
}

function parseClaudeId(id: string): ParsedClaudeId | null {
  const match = CLAUDE_ID_RE.exec(stripTrailingTags(id));
  if (!match) return null;
  return { family: match[1], major: Number(match[2]), minor: Number(match[3] ?? 0) };
}

const DATED_SUFFIX_RE = /-\d{8}$/;

/**
 * Picks the table id to price an unlisted point release from: the highest minor
 * of the same family and major, else the newest release of the family. Returns
 * null for non-Claude ids, unknown families, and ties between differently
 * priced ids, because a wrong price is worse than a visible $0.
 */
export function estimateFromFamily(
  model: string,
  candidateIds: readonly string[],
  priceOf: (id: string) => unknown = (id) => resolveModelPricing(id),
): string | null {
  // Only the target is reduced from its Bedrock spelling: the table's own
  // Bedrock twins are priced separately and must not pool with the bare ids.
  const target = parseClaudeId(
    model.replace(BEDROCK_PREFIX_RE, '').replace(BEDROCK_VERSION_RE, ''),
  );
  if (!target) return null;

  const siblings: { readonly id: string; readonly major: number; readonly minor: number }[] = [];
  for (const id of candidateIds) {
    const parsed = parseClaudeId(id);
    if (parsed && parsed.family === target.family) siblings.push({ id, ...parsed });
  }
  if (siblings.length === 0) return null;

  const sameMajor = siblings.filter((s) => s.major === target.major);
  const pool = sameMajor.length > 0 ? sameMajor : siblings;
  const best = pool.reduce((a, b) =>
    b.major > a.major || (b.major === a.major && b.minor > a.minor) ? b : a,
  );
  const group = pool.filter((s) => s.major === best.major && s.minor === best.minor);

  const byPrice = new Map<string, string>();
  for (const { id } of group) {
    const key = JSON.stringify(priceOf(id));
    const held = byPrice.get(key);
    if (held === undefined || (DATED_SUFFIX_RE.test(held) && !DATED_SUFFIX_RE.test(id))) {
      byPrice.set(key, id);
    }
  }
  if (byPrice.size > 1) {
    logger.warn('Ambiguous family pricing fallback; returning null', {
      model,
      candidates: group.map((s) => s.id),
    });
    return null;
  }
  return [...byPrice.values()][0];
}
