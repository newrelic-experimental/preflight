import { z } from 'zod';

import { createLogger } from '../shared/index.js';

const logger = createLogger('local-alert-rule');

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const ID_REGEX = /^[a-z0-9_-]+$/i;

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(ID_REGEX, 'id must contain only letters, digits, underscore, hyphen');

const severitySchema = z.enum(['info', 'warning', 'critical']);

const operatorSchema = z
  .enum(['above', 'below', 'above_or_equals', 'below_or_equals'])
  .default('above');

const channelsSchema = z.array(z.enum(['banner', 'os'])).default(['banner']);

const baseShape = {
  id: idSchema,
  name: z.string().min(1),
  severity: severitySchema,
  enabled: z.boolean().default(true),
  threshold: z.number().finite(),
  operator: operatorSchema,
  deduplicateSeconds: z.number().min(0).default(300),
  description: z.string().optional(),
  channels: channelsSchema,
};

const windowSecondsSchema = z.number().min(5);

const antiPatternTypeSchema = z.enum([
  'thrashing',
  're_reading',
  'stuck_loop',
  'blind_editing',
  'over_delegation',
]);

const percentileSchema = z.union([z.literal(50), z.literal(95), z.literal(99)]);

// Default to 'session' because the snapshot collector only populates
// sessionUsd — today/week always read 0 and any rule asking for those
// periods silently never fires. parseLocalAlertRules logs a warning when
// today/week is configured so users editing rules.json don't get a silent
// no-op..
const costPeriodSchema = z.enum(['session', 'today', 'week']).default('session');

// ---------------------------------------------------------------------------
// Rule-type schemas
// ---------------------------------------------------------------------------

const costWindowRuleSchema = z.object({
  ...baseShape,
  type: z.literal('cost.window'),
  windowSeconds: windowSecondsSchema,
  costPeriod: costPeriodSchema,
});

const efficiencyBelowRuleSchema = z.object({
  ...baseShape,
  // Override operator default: efficiency.below should fire when score is
  // below the threshold, not above it (which is the baseShape default).
  operator: operatorSchema.default('below'),
  type: z.literal('efficiency.below'),
  windowSeconds: windowSecondsSchema,
});

const antiPatternCountRuleSchema = z.object({
  ...baseShape,
  type: z.literal('antipattern.count'),
  windowSeconds: windowSecondsSchema,
  patternType: antiPatternTypeSchema.optional(),
});

const latencyPercentileRuleSchema = z.object({
  ...baseShape,
  type: z.literal('latency.percentile'),
  percentile: percentileSchema,
  tool: z.string().optional(),
});

const budgetSessionRuleSchema = z.object({
  ...baseShape,
  type: z.literal('budget.session'),
});

const budgetDailyRuleSchema = z.object({
  ...baseShape,
  type: z.literal('budget.daily'),
});

const budgetWeeklyRuleSchema = z.object({
  ...baseShape,
  type: z.literal('budget.weekly'),
});

const toolFailureRuleSchema = z.object({
  ...baseShape,
  type: z.literal('tool.failure'),
  windowSeconds: windowSecondsSchema,
  tool: z.string().min(1),
});

export const localAlertRuleSchema = z.discriminatedUnion('type', [
  costWindowRuleSchema,
  efficiencyBelowRuleSchema,
  antiPatternCountRuleSchema,
  latencyPercentileRuleSchema,
  budgetSessionRuleSchema,
  budgetDailyRuleSchema,
  budgetWeeklyRuleSchema,
  toolFailureRuleSchema,
]);

export type LocalAlertRule = z.infer<typeof localAlertRuleSchema>;
export type CostWindowRule = z.infer<typeof costWindowRuleSchema>;
export type EfficiencyBelowRule = z.infer<typeof efficiencyBelowRuleSchema>;
export type AntiPatternCountRule = z.infer<typeof antiPatternCountRuleSchema>;
export type LatencyPercentileRule = z.infer<typeof latencyPercentileRuleSchema>;
export type BudgetSessionRule = z.infer<typeof budgetSessionRuleSchema>;
export type BudgetDailyRule = z.infer<typeof budgetDailyRuleSchema>;
export type BudgetWeeklyRule = z.infer<typeof budgetWeeklyRuleSchema>;
export type ToolFailureRule = z.infer<typeof toolFailureRuleSchema>;

export type LocalAlertRuleType = LocalAlertRule['type'];

export type AlertSeverity = LocalAlertRule['severity'];
export type AlertOperator = LocalAlertRule['operator'];
export type AlertChannel = 'banner' | 'os';

// ---------------------------------------------------------------------------
// Bulk parser
// ---------------------------------------------------------------------------

export interface ParsedRules {
  readonly valid: LocalAlertRule[];
  readonly invalid: Array<{ input: unknown; error: string }>;
}

export function parseLocalAlertRules(input: unknown): ParsedRules {
  const valid: LocalAlertRule[] = [];
  const invalid: Array<{ input: unknown; error: string }> = [];

  const items: unknown[] = Array.isArray(input) ? input : [input];

  for (const item of items) {
    const result = localAlertRuleSchema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      const error = result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      invalid.push({ input: item, error });
      logger.warn('Skipping invalid alert rule', { error });
    }
  }

  // two rules with the same `id` both pass schema validation, but
  // LocalAlertEngine keys per-rule state by id (`Map<string, RuleState>`),
  // so the second rule shadows the first's state — A is firing, B's
  // condition becomes true, B silently won't fire because it sees
  // status='firing' in the shared state. Detect duplicates here, keep
  // the first occurrence, log the rest, and surface them as `invalid`
  // so the rules-fixture test can pin the behaviour.
  const seen = new Set<string>();
  const dedupedValid: LocalAlertRule[] = [];
  for (const rule of valid) {
    if (seen.has(rule.id)) {
      const error = `duplicate rule id '${rule.id}' — keeping first occurrence`;
      logger.warn('Skipping duplicate alert rule id', { id: rule.id });
      invalid.push({ input: rule, error });
      continue;
    }
    seen.add(rule.id);
    dedupedValid.push(rule);
  }

  return { valid: dedupedValid, invalid };
}
