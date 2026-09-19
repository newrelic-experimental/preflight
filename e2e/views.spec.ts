import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const SESSION_ID = 'e2e-dashboard-session';
const SESSION_NAME = 'E2E dashboard fixture';
const MODEL_NAME = 'e2e-test-model';

function getStoragePath(): string {
  return join(tmpdir(), 'nr-ai-e2e');
}

function clearSessions(storagePath: string): void {
  rmSync(join(storagePath, 'sessions'), { recursive: true, force: true });
}

function writeSessionFixture(storagePath: string): void {
  const now = Date.now();
  const sessionsDir = join(storagePath, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    join(sessionsDir, `${new Date(now).toISOString().slice(0, 10)}_${SESSION_ID}.json`),
    JSON.stringify({
      sessionId: SESSION_ID,
      sessionName: SESSION_NAME,
      sessionNameSource: 'user',
      sessionIntent: null,
      repoName: 'preflight',
      startTime: now - 60_000,
      endTime: now,
      durationMs: 60_000,
      toolCallCount: 3,
      developer: 'e2e',
      model: MODEL_NAME,
      toolBreakdown: { Read: 1, Edit: 1, Bash: 1 },
      skillBreakdown: {},
      filesRead: ['src/web/App.tsx'],
      filesModified: ['e2e/views.spec.ts'],
      linesAdded: 1,
      linesRemoved: 0,
      bashCommandCount: 1,
      testRunCount: 1,
      testPassCount: 1,
      buildRunCount: 1,
      buildPassCount: 1,
      estimatedCostUsd: 0.01,
      subagentCostUsd: 0,
      tokensInput: 100,
      tokensOutput: 50,
      tokensThinking: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      cacheSavingsUsd: 0,
      efficiencyScore: 0.8,
      antiPatterns: [],
      taskCount: 1,
      taskSuccessRate: 1,
      toolSuccessRate: 1,
      contextCompressions: 0,
      agentSpawns: 0,
      userMessages: 1,
      assistantMessages: 1,
      userCorrections: 0,
      outcome: 'completed',
      toolSelectionMetrics: null,
      modelBreakdown: {},
      costByWorkflowRunId: {},
      qualityProxy: {
        totalSignals: 0,
        diffApplyCleanCount: 0,
        diffFailCount: 0,
        testPassCount: 0,
        testFailCount: 0,
        backtrackCount: 0,
        selfCorrectionCount: 0,
        redundantReadCount: 0,
        repeatedFailureCount: 0,
        unusedOutputCount: 0,
      },
    }),
  );
}

function captureConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location().url;
      errors.push(location ? `${message.text()} (${location})` : message.text());
    }
  });
  return errors;
}

async function navigateWithSidebar(page: Page, label: string, path: string): Promise<string[]> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  // Today loads its own live-session data. Start monitoring immediately before
  // the target navigation so each smoke test reports errors from its own view.
  await page.waitForTimeout(300);
  const errors = captureConsoleErrors(page);
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page).toHaveURL(path);
  return errors;
}

function expectNoConsoleErrors(errors: string[]): void {
  expect(errors, `console.error messages: ${errors.join('\n')}`).toEqual([]);
}

test.describe('Dashboard view smoke tests', () => {
  test.beforeEach(() => {
    clearSessions(getStoragePath());
  });

  test.afterEach(() => {
    clearSessions(getStoragePath());
  });

  test('loads Sessions with empty and populated storage without a console error', async ({
    page,
  }) => {
    const errors = await navigateWithSidebar(page, 'Sessions', '/sessions');
    await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await expect(page.getByText('No sessions yet')).toBeVisible();

    writeSessionFixture(getStoragePath());
    await page.reload();
    await expect(page.getByText(SESSION_NAME)).toBeVisible();

    expectNoConsoleErrors(errors);
  });

  test('loads History with empty and populated storage without a console error', async ({
    page,
  }) => {
    const errors = await navigateWithSidebar(page, 'History', '/history');
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.getByText('No model data yet')).toBeVisible();

    writeSessionFixture(getStoragePath());
    await page.reload();
    await expect(page.getByRole('cell', { name: MODEL_NAME })).toBeVisible();

    expectNoConsoleErrors(errors);
  });

  test('loads Audit without a console error', async ({ page }) => {
    const errors = await navigateWithSidebar(page, 'Audit', '/audit');
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();

    expectNoConsoleErrors(errors);
  });

  test('loads Git Efficiency without a console error', async ({ page }) => {
    const errors = await navigateWithSidebar(page, 'Git', '/git');
    await expect(page.getByRole('heading', { name: 'Git Efficiency' })).toBeVisible();

    expectNoConsoleErrors(errors);
  });

  test('loads Settings without a console error', async ({ page }) => {
    const errors = await navigateWithSidebar(page, 'Settings', '/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    expectNoConsoleErrors(errors);
  });

  test('loads Alerts without a console error', async ({ page }) => {
    const errors = await navigateWithSidebar(page, 'Alerts', '/alerts');
    await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();

    expectNoConsoleErrors(errors);
  });
});
