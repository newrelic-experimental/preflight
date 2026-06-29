import { useState, useEffect } from 'react';
import { fetchHealth } from '../api/client.js';

export interface VersionInfo {
  readonly installed: string | null;
  readonly latest: string | null;
  readonly updateAvailable: boolean;
}

const INITIAL: VersionInfo = { installed: null, latest: null, updateAvailable: false };

export function useVersionInfo(): VersionInfo {
  const [info, setInfo] = useState<VersionInfo>(INITIAL);

  useEffect(() => {
    let mounted = true;
    fetchHealth()
      .then((h) => {
        if (mounted) {
          setInfo({
            installed: h.version,
            latest: h.latestVersion,
            updateAvailable: h.updateAvailable,
          });
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  return info;
}
