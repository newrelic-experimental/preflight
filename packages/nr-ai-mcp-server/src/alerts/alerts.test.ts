import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AlertConditionDefinition, AlertPolicyDefinition } from './types.js';

const alertsDir = resolve(__dirname, '..', '..', 'alerts');
const conditionsDir = resolve(alertsDir, 'conditions');

const policy: AlertPolicyDefinition = JSON.parse(
  readFileSync(resolve(alertsDir, 'policy.json'), 'utf-8'),
);

const conditionFiles = readdirSync(conditionsDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const conditions: Array<{ file: string; condition: AlertConditionDefinition }> =
  conditionFiles.map((file) => ({
    file,
    condition: JSON.parse(readFileSync(resolve(conditionsDir, file), 'utf-8')) as AlertConditionDefinition,
  }));

const VALID_EVENT_TYPES = new Set([
  'AiToolCall',
  'Metric',
  'AiCodingTask',
  'AiAntiPattern',
  'AiAuditEvent',
]);

describe('Alert policy definition', () => {
  it('has a name', () => {
    expect(policy.name).toBeTruthy();
  });

  it('has a valid incidentPreference', () => {
    expect(['PER_POLICY', 'PER_CONDITION', 'PER_CONDITION_AND_TARGET']).toContain(
      policy.incidentPreference,
    );
  });
});

describe.each(conditions)('Condition: $file', ({ condition }) => {
  it('has required string fields', () => {
    expect(condition.name).toBeTruthy();
    expect(condition.nrqlQuery).toBeTruthy();
    expect(condition.aggregationMethod).toBeTruthy();
  });

  it('has a boolean enabled field', () => {
    expect(typeof condition.enabled).toBe('boolean');
  });

  it('nrqlQuery contains SELECT and FROM', () => {
    expect(condition.nrqlQuery).toMatch(/SELECT/i);
    expect(condition.nrqlQuery).toMatch(/FROM/i);
  });

  it('nrqlQuery references a known event type', () => {
    const match = condition.nrqlQuery.match(/FROM\s+(\w+)/i);
    expect(match).not.toBeNull();
    expect(VALID_EVENT_TYPES.has(match![1])).toBe(true);
  });

  it('has valid aggregationMethod', () => {
    expect(['EVENT_FLOW', 'EVENT_TIMER', 'CADENCE']).toContain(condition.aggregationMethod);
  });

  it('thresholdCritical.duration is a multiple of aggregationWindow', () => {
    expect(condition.thresholdCritical.duration % condition.aggregationWindow).toBe(0);
  });

  it('aggregationDelay only set for EVENT_FLOW or CADENCE', () => {
    if (condition.aggregationDelay !== undefined) {
      expect(['EVENT_FLOW', 'CADENCE']).toContain(condition.aggregationMethod);
    }
  });

  it('aggregationTimer only set for EVENT_TIMER', () => {
    if (condition.aggregationTimer !== undefined) {
      expect(condition.aggregationMethod).toBe('EVENT_TIMER');
    }
  });

  it('has a positive violationTimeLimitSeconds', () => {
    expect(condition.violationTimeLimitSeconds).toBeGreaterThan(0);
  });

  it('has a valid thresholdOperator', () => {
    expect([
      'ABOVE',
      'ABOVE_OR_EQUALS',
      'BELOW',
      'BELOW_OR_EQUALS',
      'EQUALS',
      'NOT_EQUALS',
    ]).toContain(condition.thresholdOperator);
  });

  it('thresholdCritical has valid occurrences', () => {
    expect(['ALL', 'AT_LEAST_ONCE']).toContain(condition.thresholdCritical.occurrences);
  });
});

describe('Condition set', () => {
  it('loads at least one condition', () => {
    expect(conditions.length).toBeGreaterThan(0);
  });

  it('no two conditions share the same name', () => {
    const names = conditions.map((c) => c.condition.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
