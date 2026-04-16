import type { LogLevel } from '@nr-ai-observatory/shared';
import type { SessionTracker } from './metrics/session-tracker.js';
import type { CostTracker } from './metrics/cost-tracker.js';
import type { TaskDetector } from './metrics/task-detector.js';
import type { AntiPatternDetector } from './metrics/anti-patterns.js';
import type { EfficiencyScorer } from './metrics/efficiency-score.js';
import type { FeedbackCollector } from './tools/workflow-tools.js';

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
}
