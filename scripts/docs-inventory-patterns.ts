const RECORDED_METRIC_RE =
  /(?<![\w$])record(?:Metric)?\(\s*['"`]((?:nr\.)?ai(?:\.[a-z0-9_]+)+)['"`]/g;
// Whole metric names, so a recorded `ai.foo.bar` is not satisfied by a documented `ai.foo.bar_total`.
const DOC_METRIC_NAME_RE = /\b(?:nr\.)?ai(?:\.[a-z0-9_]+)+\b/g;

/** Metric names passed as a plain string literal to `record(...)` or `recordMetric(...)`. */
export function findRecordedMetrics(sourceText: string): string[] {
  return [...sourceText.matchAll(RECORDED_METRIC_RE)].map((m) => m[1]);
}

/** Whole metric names mentioned anywhere in a doc. */
export function findDocMetricNames(docText: string): Set<string> {
  return new Set(docText.match(DOC_METRIC_NAME_RE) ?? []);
}
