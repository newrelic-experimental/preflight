import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useVersionInfo } from './useVersionInfo';
import type { HealthResponse } from '../api/client';
import * as client from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useVersionInfo', () => {
  it('returns null values before the fetch resolves', () => {
    vi.spyOn(client, 'fetchHealth').mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useVersionInfo());
    expect(result.current.installed).toBeNull();
    expect(result.current.latest).toBeNull();
    expect(result.current.updateAvailable).toBe(false);
  });

  it('returns version info once fetch resolves', async () => {
    const payload: HealthResponse = {
      ok: true,
      uptime: 100,
      version: '1.0.4',
      latestVersion: '1.0.5',
      updateAvailable: true,
    };
    vi.spyOn(client, 'fetchHealth').mockResolvedValue(payload);
    const { result } = renderHook(() => useVersionInfo());
    await waitFor(() => expect(result.current.installed).toBe('1.0.4'));
    expect(result.current.latest).toBe('1.0.5');
    expect(result.current.updateAvailable).toBe(true);
  });

  it('keeps null values when fetch rejects', async () => {
    vi.spyOn(client, 'fetchHealth').mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useVersionInfo());
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.installed).toBeNull();
    expect(result.current.updateAvailable).toBe(false);
  });

  it('does not update state after unmount', async () => {
    let resolve!: (v: HealthResponse) => void;
    vi.spyOn(client, 'fetchHealth').mockReturnValue(
      new Promise<HealthResponse>((r) => {
        resolve = r;
      }),
    );
    const { result, unmount } = renderHook(() => useVersionInfo());
    unmount();
    resolve({
      ok: true,
      uptime: 0,
      version: '1.0.4',
      latestVersion: '1.0.5',
      updateAvailable: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.installed).toBeNull();
  });
});
