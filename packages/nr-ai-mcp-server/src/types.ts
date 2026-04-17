import type { LogLevel } from '@nr-ai-observatory/shared';
import type { SessionTracker } from './metrics/session-tracker.js';
import type { CostTracker } from './metrics/cost-tracker.js';
import type { TaskDetector } from './metrics/task-detector.js';
import type { AntiPatternDetector } from './metrics/anti-patterns.js';
import type { EfficiencyScorer } from './metrics/efficiency-score.js';
import type { FeedbackCollector } from './tools/workflow-tools.js';
import type { AuditTrailManager } from './security/index.js';
import type { SessionStore } from './storage/session-store.js';
import type { WeeklySummaryGenerator } from './storage/weekly-summary.js';
import type { TrendAnalyzer } from './metrics/trend-analyzer.js';
import type { CollaborationProfiler } from './metrics/collaboration-profile.js';
import type { ClaudeMdTracker } from './metrics/claudemd-tracker.js';
import type { CostPerOutcomeAnalyzer } from './metrics/cost-per-outcome.js';
import type { RecommendationEngine } from './metrics/recommendation-engine.js';

export interface CliOptions {
  readonly port: number;
  readonly config: string | null;
  readonly logLevel: LogLevel;
  readonly stdio: boolean;
}

export interface ServerOptions {
  readonly name: string;
  readonly version: string;
  readonly sessionTracker?: SessionTracker;
  readonly costTracker?: CostTracker;
  readonly taskDetector?: TaskDetector;
  readonly antiPatternDetector?: AntiPatternDetector;
  readonly efficiencyScorer?: EfficiencyScorer;
  readonly feedbackCollector?: FeedbackCollector;
  readonly auditTrailManager?: AuditTrailManager;
  readonly sessionStore?: SessionStore;
  readonly weeklySummaryGenerator?: WeeklySummaryGenerator;
  readonly trendAnalyzer?: TrendAnalyzer;
  readonly collaborationProfiler?: CollaborationProfiler;
  readonly claudeMdTracker?: ClaudeMdTracker;
  readonly costPerOutcomeAnalyzer?: CostPerOutcomeAnalyzer;
  readonly recommendationEngine?: RecommendationEngine;
}
