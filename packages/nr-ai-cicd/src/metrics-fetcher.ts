import { runNrql } from './nrql-client.js';

export interface SessionMetrics {
  totalCostUsd: number;
  efficiencyScore: number | null;
  sessionCount: number;
  topAntiPatterns: Array<{ type: string; count: number }>;
  modelBreakdown: Array<{ model: string; costUsd: number }>;
}

export interface BaselineMetrics {
  avgDailyCostUsd: number;
  avgEfficiencyScore: number | null;
}

export async function fetchCurrentMetrics(
  apiKey: string,
  accountId: number,
  developer: string,
  sinceHours: number,
): Promise<SessionMetrics> {
  const costRows = await runNrql(
    apiKey,
    accountId,
    `SELECT sum(numeric(cost.totalUsd)) AS totalCost FROM Metric WHERE metricName = 'ai.cost.session' AND developer = '${developer}' SINCE ${sinceHours} hours ago`,
  );
  const totalCostUsd = Number(costRows[0]?.totalCost ?? 0);

  const effRows = await runNrql(
    apiKey,
    accountId,
    `SELECT average(numeric(efficiency.score)) AS avgScore FROM Metric WHERE metricName = 'ai.efficiency.score' AND developer = '${developer}' SINCE ${sinceHours} hours ago`,
  );
  const efficiencyScore = effRows[0]?.avgScore != null ? Number(effRows[0].avgScore) : null;

  const sessionRows = await runNrql(
    apiKey,
    accountId,
    `SELECT uniqueCount(sessionId) AS sessions FROM AiToolCall WHERE developer = '${developer}' SINCE ${sinceHours} hours ago`,
  );
  const sessionCount = Number(sessionRows[0]?.sessions ?? 0);

  const patternRows = await runNrql(
    apiKey,
    accountId,
    `SELECT count(*) AS cnt, patternType FROM AiAntiPattern WHERE developer = '${developer}' SINCE ${sinceHours} hours ago FACET patternType LIMIT 5`,
  );
  const topAntiPatterns = patternRows.map((r) => ({
    type: String(r.patternType ?? 'unknown'),
    count: Number(r.cnt ?? 0),
  }));

  const modelRows = await runNrql(
    apiKey,
    accountId,
    `SELECT sum(numeric(cost.totalUsd)) AS cost, model FROM Metric WHERE metricName = 'ai.cost.session' AND developer = '${developer}' SINCE ${sinceHours} hours ago FACET model LIMIT 10`,
  );
  const modelBreakdown = modelRows.map((r) => ({
    model: String(r.model ?? 'unknown'),
    costUsd: Number(r.cost ?? 0),
  }));

  return { totalCostUsd, efficiencyScore, sessionCount, topAntiPatterns, modelBreakdown };
}

export async function fetchBaselineMetrics(
  apiKey: string,
  accountId: number,
  developer: string,
): Promise<BaselineMetrics> {
  const costRows = await runNrql(
    apiKey,
    accountId,
    `SELECT sum(numeric(cost.totalUsd)) / 7 AS avgDailyCost FROM Metric WHERE metricName = 'ai.cost.session' AND developer = '${developer}' SINCE 7 days ago`,
  );
  const avgDailyCostUsd = Number(costRows[0]?.avgDailyCost ?? 0);

  const effRows = await runNrql(
    apiKey,
    accountId,
    `SELECT average(numeric(efficiency.score)) AS avgScore FROM Metric WHERE metricName = 'ai.efficiency.score' AND developer = '${developer}' SINCE 7 days ago`,
  );
  const avgEfficiencyScore = effRows[0]?.avgScore != null ? Number(effRows[0].avgScore) : null;

  return { avgDailyCostUsd, avgEfficiencyScore };
}
