/**
 * The running process's usage-reports service, for code that records counts
 * but isn't handed the service (the dashboard routes, transport, storage).
 * Dependency-free so importing it never creates a cycle.
 */

import type { PromptSurface } from './constants.js';
import type { UsageReportsPreview } from './preview.js';

export interface UsageReportsSink {
  recordPageLoad(): void;
  recordLiveConnection(): void;
  status(): { readonly enabled: boolean; readonly reason: string };
  describe(): string;
  canAsk(): boolean;
  answer(answer: 'yes' | 'no' | 'dismissed', surface: PromptSurface): void;
  preview(): UsageReportsPreview;
}

let active: UsageReportsSink | undefined;

export function setActiveUsageReports(sink: UsageReportsSink | undefined): void {
  active = sink;
}

export function getActiveUsageReports(): UsageReportsSink | undefined {
  return active;
}
