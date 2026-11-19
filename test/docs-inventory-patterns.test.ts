import { findDocMetricNames, findRecordedMetrics } from '../scripts/docs-inventory-patterns.js';

describe('findRecordedMetrics', () => {
  it('finds record and recordMetric calls with single, double and backtick quotes', () => {
    const text = [
      "record('ai.a.one', 1);",
      'recordMetric("ai.a.two", 2);',
      'record(`ai.a.three`, 3);',
    ].join('\n');
    expect(findRecordedMetrics(text)).toEqual(['ai.a.one', 'ai.a.two', 'ai.a.three']);
  });

  it('keeps a _rate suffix whole', () => {
    expect(findRecordedMetrics("record('ai.tool.success_rate', 1)")).toEqual([
      'ai.tool.success_rate',
    ]);
  });

  it('keeps the nr. prefix', () => {
    expect(findRecordedMetrics("record('nr.ai.dropped_events', 1)")).toEqual([
      'nr.ai.dropped_events',
    ]);
  });

  it('finds a call whose name sits on the next line', () => {
    expect(findRecordedMetrics("recordMetric(\n    'ai.a.multiline',\n    1,\n)")).toEqual([
      'ai.a.multiline',
    ]);
  });

  it('skips a template literal with an interpolation', () => {
    expect(findRecordedMetrics('record(`ai.a.${name}`, 1)')).toEqual([]);
  });

  it('skips a method that merely ends in record', () => {
    expect(findRecordedMetrics("tracker.record('ai.a.one', 1); prerecord('ai.a.two', 1)")).toEqual([
      'ai.a.one',
    ]);
  });
});

describe('findDocMetricNames', () => {
  it('does not let ai.tool.success_rate satisfy ai.tool.success', () => {
    const names = findDocMetricNames('| `ai.tool.success_rate` | gauge |');
    expect(names.has('ai.tool.success_rate')).toBe(true);
    expect(names.has('ai.tool.success')).toBe(false);
  });

  it('keeps nr.ai.dropped_events distinct from ai.dropped_events', () => {
    const names = findDocMetricNames('`nr.ai.dropped_events`');
    expect(names.has('nr.ai.dropped_events')).toBe(true);
    expect(names.has('ai.dropped_events')).toBe(false);
  });
});
