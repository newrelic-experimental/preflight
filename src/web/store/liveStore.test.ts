import {
  useLiveStore,
  selectVisibleFiringAlerts,
  selectMaxSeverity,
  type AlertEvent,
} from './liveStore';

function fireAlert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'rule-a',
    state: 'firing',
    severity: 'warning',
    title: 'Rule A',
    description: 'desc',
    value: 1,
    threshold: 0.5,
    firedAt: 1000,
    ...overrides,
  };
}

describe('liveStore', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: false,
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
      activeSessionId: null,
    });
  });

  it('starts disconnected with empty arrays', () => {
    const s = useLiveStore.getState();
    expect(s.connected).toBe(false);
    expect(s.recentToolCalls).toEqual([]);
    expect(s.antiPatterns).toEqual([]);
    expect(s.cost).toBeNull();
  });

  it('setConnected toggles the flag', () => {
    useLiveStore.getState().setConnected(true);
    expect(useLiveStore.getState().connected).toBe(true);
  });

  it('pushToolCall appends and caps to last 20', () => {
    const push = useLiveStore.getState().pushToolCall;
    for (let i = 0; i < 25; i++) {
      push({ id: String(i), tool: 'Read', durationMs: 1, costUsd: 0, ts: i });
    }
    const s = useLiveStore.getState();
    expect(s.recentToolCalls.length).toBe(20);
    expect(s.recentToolCalls[0].id).toBe('5');
    expect(s.recentToolCalls[19].id).toBe('24');
  });

  it('setCost replaces the value', () => {
    useLiveStore.getState().setCost({
      sessionTotalUsd: 1.23,
      todayTotalUsd: 4.56,
      forecastEodUsd: null,
    });
    expect(useLiveStore.getState().cost?.sessionTotalUsd).toBe(1.23);
  });

  it('pushAntiPattern appends and caps to last 10', () => {
    const push = useLiveStore.getState().pushAntiPattern;
    for (let i = 0; i < 15; i++) {
      push({ type: 'thrashing', target: `f${i}.ts`, count: 1 });
    }
    const s = useLiveStore.getState();
    expect(s.antiPatterns.length).toBe(10);
    expect(s.antiPatterns[0].target).toBe('f5.ts');
  });
});

describe('liveStore alert slice', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: false,
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
      activeSessionId: null,
    });
  });

  it('starts with no firing or dismissed alerts', () => {
    const s = useLiveStore.getState();
    expect(s.firingAlerts.size).toBe(0);
    expect(s.dismissedAlerts.size).toBe(0);
  });

  it('addOrUpdateAlert (firing) adds the alert to firingAlerts by id', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a' }));
    expect(useLiveStore.getState().firingAlerts.size).toBe(1);
    expect(useLiveStore.getState().firingAlerts.get('a')?.title).toBe('Rule A');
  });

  it('addOrUpdateAlert (firing) replaces an existing alert with the same id', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a', value: 1 }));
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a', value: 5, firedAt: 2000 }));
    const s = useLiveStore.getState();
    expect(s.firingAlerts.size).toBe(1);
    expect(s.firingAlerts.get('a')?.value).toBe(5);
    expect(s.firingAlerts.get('a')?.firedAt).toBe(2000);
  });

  it('addOrUpdateAlert (cleared) removes the alert from firingAlerts', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a' }));
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a', state: 'cleared' }));
    expect(useLiveStore.getState().firingAlerts.size).toBe(0);
  });

  it('addOrUpdateAlert (cleared) is a no-op for unknown ids', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'never-fired', state: 'cleared' }));
    expect(useLiveStore.getState().firingAlerts.size).toBe(0);
  });

  it('clearAlert removes the alert from firingAlerts', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a' }));
    useLiveStore.getState().clearAlert('a');
    expect(useLiveStore.getState().firingAlerts.size).toBe(0);
  });

  it('clearAlert is a no-op when the id is not firing', () => {
    const before = useLiveStore.getState();
    useLiveStore.getState().clearAlert('does-not-exist');
    const after = useLiveStore.getState();
    expect(after.firingAlerts).toBe(before.firingAlerts);
  });

  it('dismissAlert keeps the alert firing but hides it from selectors', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a' }));
    useLiveStore.getState().dismissAlert('a');
    const s = useLiveStore.getState();
    expect(s.firingAlerts.size).toBe(1);
    expect(s.dismissedAlerts.has('a')).toBe(true);
    expect(selectVisibleFiringAlerts(s)).toEqual([]);
  });

  it('dismissAlert is idempotent', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a' }));
    useLiveStore.getState().dismissAlert('a');
    const dismissedRef = useLiveStore.getState().dismissedAlerts;
    useLiveStore.getState().dismissAlert('a');
    expect(useLiveStore.getState().dismissedAlerts).toBe(dismissedRef);
  });

  it('clearing a previously-dismissed alert removes it from dismissedAlerts', () => {
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a' }));
    useLiveStore.getState().dismissAlert('a');
    useLiveStore.getState().addOrUpdateAlert(fireAlert({ id: 'a', state: 'cleared' }));
    const s = useLiveStore.getState();
    expect(s.dismissedAlerts.has('a')).toBe(false);
    expect(s.firingAlerts.size).toBe(0);
  });

  it('selectVisibleFiringAlerts filters out dismissed ids', () => {
    const { addOrUpdateAlert, dismissAlert } = useLiveStore.getState();
    addOrUpdateAlert(fireAlert({ id: 'a', firedAt: 1000 }));
    addOrUpdateAlert(fireAlert({ id: 'b', firedAt: 2000 }));
    dismissAlert('a');
    const visible = selectVisibleFiringAlerts(useLiveStore.getState());
    expect(visible.map((v) => v.id)).toEqual(['b']);
  });

  it('selectVisibleFiringAlerts orders critical > warning > info, then by firedAt asc', () => {
    const add = useLiveStore.getState().addOrUpdateAlert;
    add(fireAlert({ id: 'info-late', severity: 'info', firedAt: 5000 }));
    add(fireAlert({ id: 'critical-old', severity: 'critical', firedAt: 1000 }));
    add(fireAlert({ id: 'warn-mid', severity: 'warning', firedAt: 3000 }));
    add(fireAlert({ id: 'critical-new', severity: 'critical', firedAt: 4000 }));
    const ids = selectVisibleFiringAlerts(useLiveStore.getState()).map((v) => v.id);
    expect(ids).toEqual(['critical-old', 'critical-new', 'warn-mid', 'info-late']);
  });

  it('selectMaxSeverity returns the highest severity present', () => {
    const add = useLiveStore.getState().addOrUpdateAlert;
    add(fireAlert({ id: 'a', severity: 'info' }));
    add(fireAlert({ id: 'b', severity: 'warning' }));
    expect(selectMaxSeverity(useLiveStore.getState())).toBe('warning');
    add(fireAlert({ id: 'c', severity: 'critical' }));
    expect(selectMaxSeverity(useLiveStore.getState())).toBe('critical');
  });

  it('selectMaxSeverity returns null when all alerts are dismissed', () => {
    const { addOrUpdateAlert, dismissAlert } = useLiveStore.getState();
    addOrUpdateAlert(fireAlert({ id: 'a', severity: 'critical' }));
    dismissAlert('a');
    expect(selectMaxSeverity(useLiveStore.getState())).toBeNull();
  });

  it('selectMaxSeverity returns null when no alerts are firing', () => {
    expect(selectMaxSeverity(useLiveStore.getState())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// activeSessionId + setActiveSession
// ---------------------------------------------------------------------------

describe('liveStore — setActiveSession', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: false,
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
      activeSessionId: null,
    });
  });

  it('starts with null activeSessionId', () => {
    expect(useLiveStore.getState().activeSessionId).toBeNull();
  });

  it('setActiveSession sets the active id', () => {
    useLiveStore.getState().setActiveSession('sess-A');
    expect(useLiveStore.getState().activeSessionId).toBe('sess-A');
  });

  it('clears tool calls and anti-patterns from non-matching sessions on switch', () => {
    const { pushToolCall, pushAntiPattern, setActiveSession } = useLiveStore.getState();
    pushToolCall({ id: 'a', sessionId: 'sess-A', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    pushToolCall({ id: 'b', sessionId: 'sess-B', tool: 'Read', durationMs: 1, costUsd: 0, ts: 2 });
    pushAntiPattern({ sessionId: 'sess-A', type: 'thrashing', target: 'a.ts', count: 1 });
    pushAntiPattern({ sessionId: 'sess-B', type: 'rereading', target: 'b.ts', count: 2 });

    setActiveSession('sess-A');
    const s = useLiveStore.getState();
    expect(s.recentToolCalls.map((t) => t.id)).toEqual(['a']);
    expect(s.antiPatterns.map((a) => a.target)).toEqual(['a.ts']);
  });

  it('clears cost from a non-matching session on switch', () => {
    const { setCost, setActiveSession } = useLiveStore.getState();
    setCost({
      sessionId: 'sess-other',
      sessionTotalUsd: 1.0,
      todayTotalUsd: 1.0,
      forecastEodUsd: null,
    });
    setActiveSession('sess-mine');
    expect(useLiveStore.getState().cost).toBeNull();
  });

  it('keeps cost when its sessionId matches the new active id', () => {
    const { setCost, setActiveSession } = useLiveStore.getState();
    setCost({
      sessionId: 'sess-A',
      sessionTotalUsd: 5.0,
      todayTotalUsd: 5.0,
      forecastEodUsd: null,
    });
    setActiveSession('sess-A');
    expect(useLiveStore.getState().cost?.sessionTotalUsd).toBe(5.0);
  });

  it('is a no-op when activeSessionId is unchanged', () => {
    const { pushToolCall, setActiveSession } = useLiveStore.getState();
    pushToolCall({ id: 'a', sessionId: 'sess-A', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    setActiveSession('sess-A');
    const beforeRef = useLiveStore.getState().recentToolCalls;
    setActiveSession('sess-A');
    // Reference should not change — the early-return path skips the set().
    expect(useLiveStore.getState().recentToolCalls).toBe(beforeRef);
  });

  it('drops sessionId-less events when switching to a real session', () => {
    const { pushToolCall, setActiveSession } = useLiveStore.getState();
    // Legacy fixture without sessionId.
    pushToolCall({ id: 'legacy', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    setActiveSession('sess-A');
    expect(useLiveStore.getState().recentToolCalls).toEqual([]);
  });
});
