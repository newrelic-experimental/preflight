import { describe, expect, it, jest } from '@jest/globals';

import type { SkillStamp } from '../storage/types.js';

import { createSkillRunEmitter, type SkillRunSink } from './skill-run-emitter.js';

const STAMP: SkillStamp = { name: 'code-review', source: 'slash', runId: 'run-1' };

function makeSink() {
  const ingestSkillRun = jest.fn<SkillRunSink['ingestSkillRun']>();
  return { sink: { ingestSkillRun } as SkillRunSink, ingestSkillRun };
}

describe('createSkillRunEmitter', () => {
  it('drops a foreign session run on a --stdio engine', () => {
    const { sink, ingestSkillRun } = makeSink();
    const emit = createSkillRunEmitter({
      stdio: true,
      getOwnSessionId: () => 'own',
      getSink: () => sink,
    });
    emit(STAMP, { sessionId: 'other', timestamp: 5 });
    expect(ingestSkillRun).not.toHaveBeenCalled();
  });

  it('emits the own session run and a run with no session on --stdio', () => {
    const { sink, ingestSkillRun } = makeSink();
    const emit = createSkillRunEmitter({
      stdio: true,
      getOwnSessionId: () => 'own',
      getSink: () => sink,
    });
    emit(STAMP, { sessionId: 'own', timestamp: 5 });
    emit(STAMP, { sessionId: null, timestamp: 6 });
    expect(ingestSkillRun.mock.calls).toEqual([
      [STAMP, { timestamp: 5, sessionId: 'own' }],
      [STAMP, { timestamp: 6, sessionId: null }],
    ]);
  });

  it('keeps every session in --local mode', () => {
    const { sink, ingestSkillRun } = makeSink();
    const emit = createSkillRunEmitter({
      stdio: false,
      getOwnSessionId: () => 'local-1',
      getSink: () => sink,
    });
    emit(STAMP, { sessionId: 'other', timestamp: 5 });
    expect(ingestSkillRun).toHaveBeenCalledTimes(1);
  });

  it('reads the own session id at call time, so an adopted id takes effect', () => {
    const { sink, ingestSkillRun } = makeSink();
    let own = 'pending-1';
    const emit = createSkillRunEmitter({
      stdio: true,
      getOwnSessionId: () => own,
      getSink: () => sink,
    });
    emit(STAMP, { sessionId: 'real', timestamp: 1 });
    own = 'real';
    emit(STAMP, { sessionId: 'real', timestamp: 2 });
    expect(ingestSkillRun.mock.calls).toEqual([[STAMP, { timestamp: 2, sessionId: 'real' }]]);
  });

  it('falls back to the current time when the run has no timestamp', () => {
    jest.useFakeTimers().setSystemTime(1234);
    const { sink, ingestSkillRun } = makeSink();
    const emit = createSkillRunEmitter({
      stdio: false,
      getOwnSessionId: () => 'x',
      getSink: () => sink,
    });
    emit(STAMP, { sessionId: 's', timestamp: undefined });
    jest.useRealTimers();
    expect(ingestSkillRun.mock.calls).toEqual([[STAMP, { timestamp: 1234, sessionId: 's' }]]);
  });

  it('forwards the platform of the run to the sink', () => {
    const { sink, ingestSkillRun } = makeSink();
    const emit = createSkillRunEmitter({
      stdio: false,
      getOwnSessionId: () => 'x',
      getSink: () => sink,
    });
    emit(STAMP, { sessionId: 's', timestamp: 1, platform: 'opencode' });
    expect(ingestSkillRun.mock.calls).toEqual([
      [STAMP, { timestamp: 1, sessionId: 's', platform: 'opencode' }],
    ]);
  });

  it('does nothing before the ingest manager exists', () => {
    const emit = createSkillRunEmitter({
      stdio: false,
      getOwnSessionId: () => 'x',
      getSink: () => undefined,
    });
    expect(() => emit(STAMP, { sessionId: 's', timestamp: 1 })).not.toThrow();
  });
});
