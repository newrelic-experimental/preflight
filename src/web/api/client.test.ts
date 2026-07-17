import {
  fetchSessionCurrent,
  fetchAuditLog,
  fetchHealth,
  fetchRecentAlerts,
  fetchGitEfficiency,
  fetchWorkflowDetail,
  fetchSessionReplay,
  patchSettings,
  postDigestSend,
  qk,
  NotFoundError,
} from './client';

describe('api/client', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetchSessionCurrent calls /api/session/current and returns JSON', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch;
    const result = await fetchSessionCurrent();
    expect(result).toEqual({ id: 'x' });
  });

  it('throws when response status is not 2xx', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('boom', { status: 503 }))) as typeof globalThis.fetch;
    await expect(fetchSessionCurrent()).rejects.toThrow(/503/);
  });

  it('fetchAuditLog hits /api/audit', async () => {
    let calledWith = '';
    globalThis.fetch = ((u: string) => {
      calledWith = u;
      return Promise.resolve(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    await fetchAuditLog();
    expect(calledWith).toBe('/api/audit');
  });

  it('patchSettings throws HTTP status error when server returns non-JSON error body', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      )) as typeof globalThis.fetch;
    // Should throw an error with the HTTP status, not a SyntaxError from r.json()
    await expect(patchSettings({ developer: 'test' })).rejects.toThrow(/502/);
  });

  it('postDigestSend throws HTTP status error when server returns non-JSON error body', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('<html>Service Unavailable</html>', {
          status: 503,
          statusText: 'Service Unavailable',
        }),
      )) as typeof globalThis.fetch;
    await expect(postDigestSend()).rejects.toThrow(/503/);
  });

  it('qk produces stable React Query keys', () => {
    expect(qk.sessionCurrent).toEqual(['session', 'current']);
    expect(qk.audit).toEqual(['audit']);
    expect(qk.sessionDetail('abc')).toEqual(['session', 'abc']);
  });

  it('qk.sessionsList differs by limit so the React Query cache does not collide', () => {
    expect(qk.sessionsList(50)).toEqual(['sessions', 'list', 50]);
    expect(qk.sessionsList(200)).toEqual(['sessions', 'list', 200]);
    expect(qk.sessionsList(50)).not.toEqual(qk.sessionsList(200));
  });

  it('fetchHealth hits /api/health and returns typed response', async () => {
    const payload = {
      ok: true,
      uptime: 500,
      version: '1.0.4',
      latestVersion: '1.0.5',
      updateAvailable: true,
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch;
    const result = await fetchHealth();
    expect(result).toEqual(payload);
  });

  it('fetchRecentAlerts rejects with a NotFoundError on 404 (cloud mode: no alert engine)', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('Not Found', { status: 404 }))) as typeof globalThis.fetch;
    await expect(fetchRecentAlerts()).rejects.toBeInstanceOf(NotFoundError);
    await expect(fetchRecentAlerts()).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('fetchGitEfficiency hits /api/git-efficiency and returns the full nested response', async () => {
    let calledWith = '';
    const payload = {
      totalGitCommands: 12,
      mergeConflicts: 1,
      rebaseConflicts: 0,
      abortedOperations: 0,
      forcePushes: 0,
      resetHards: 0,
      discardedChanges: 0,
      pullCount: 3,
      pushCount: 2,
      commitCount: 5,
      branchOperations: 1,
      conflictResolutionRate: 1,
      avgConflictResolutionMs: 12000,
      staleBranchPulls: 0,
      gitCommandTimeline: [{ timestamp: 1, type: 'commit', success: true, durationMs: 100 }],
      conflictHistory: [
        { timestamp: 1, resolution: 'resolved', resolutionTimeMs: 12000, command: 'git merge' },
      ],
      suggestions: [{ severity: 'info', category: 'sync', message: 'msg', evidence: 'evidence' }],
      bestPractices: [{ id: 'sync', label: 'Sync often', status: 'pass', detail: 'ok' }],
      preventionScore: 90,
      efficiencyScore: 85,
      riskIndicators: {
        syncedBeforeEditing: true,
        timeSinceLastSyncMs: 1000,
        commitsSinceLastSync: 1,
        pushRejections: 0,
        forceAfterReject: 0,
        hotFiles: [],
        usesWorktrees: false,
        usesForceWithLease: false,
        avgCommitsBetweenSyncs: 1,
        commitsAheadOfMain: 0,
        commitsBehindMain: 0,
        sessionDurationMs: 60000,
        quickConflictResolutions: 0,
      },
      velocityMetrics: {
        avgTimeBetweenCommitsMs: 60000,
        commitBurstCount: 0,
        longestGapMs: 120000,
        worktreeCount: 0,
        buildBeforePush: true,
        testBeforePush: true,
      },
      conflictResolutionStrategy: {
        oursCount: 0,
        theirsCount: 0,
        manualMergeCount: 1,
        cherryPickCount: 0,
        totalResolutions: 1,
      },
      prMetrics: {
        created: 1,
        merged: 1,
        checksViewed: 2,
        prsUpdated: 1,
        prActivity: [{ timestamp: 1, action: 'create', prNumber: '42' }],
        avgTimeToCreateMs: 300000,
      },
      repoContext: {
        repoName: 'nr-ai-observatory',
        branch: 'main',
        remoteName: 'origin',
        defaultBranch: 'main',
      },
    };
    globalThis.fetch = ((u: string) => {
      calledWith = u;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchGitEfficiency();
    expect(calledWith).toBe('/api/git-efficiency');
    expect(result).toEqual(payload);
  });

  it('fetchWorkflowDetail hits /api/workflows/:runId and returns the run+agents+topology shape', async () => {
    let calledWith = '';
    const payload = {
      run: {
        runId: 'run-1',
        parentSessionId: 'sess-1',
        taskId: 'task-1',
        workflowName: 'my-workflow',
        status: 'completed',
        defaultModel: 'claude-sonnet-5',
        startedAt: 1000,
        durationMs: 5000,
        agentCount: 2,
        totalTokens: 1000,
        totalUsd: 0.5,
      },
      agents: [
        {
          agentId: 'agent-1',
          label: 'researcher',
          phaseIndex: 0,
          phaseTitle: 'research',
          model: 'claude-sonnet-5',
          state: 'completed',
          attempt: 1,
          durationMs: 2000,
          tokens: 500,
          toolCalls: 3,
          startedAt: 1000,
        },
      ],
      topology: {
        workflowName: 'my-workflow',
        declaredPhases: 1,
        declaredPhaseCalls: 1,
        declaredAgents: 2,
        declaredParallelWidths: [2],
      },
    };
    globalThis.fetch = ((u: string) => {
      calledWith = u;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchWorkflowDetail('run-1');
    expect(calledWith).toBe('/api/workflows/run-1');
    expect(result).toEqual(payload);
  });

  it('fetchSessionReplay hits /api/sessions/:id/replay and returns the timeline+segments shape', async () => {
    let calledWith = '';
    const payload = {
      sessionId: 'sess-1',
      timeline: [
        { timestamp: 1, toolName: 'Read', durationMs: 10, success: true, filePath: 'a.ts' },
      ],
      segments: [
        {
          type: 'thrashing',
          startIndex: 0,
          endIndex: 2,
          iterations: 3,
          target: 'a.ts',
          severity: 'warning',
        },
      ],
      worstSegment: {
        type: 'thrashing',
        startIndex: 0,
        endIndex: 2,
        iterations: 3,
        target: 'a.ts',
        severity: 'warning',
      },
    };
    globalThis.fetch = ((u: string) => {
      calledWith = u;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchSessionReplay('sess-1');
    expect(calledWith).toBe('/api/sessions/sess-1/replay');
    expect(result).toEqual(payload);
  });
});
