import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSettings, patchSettings, qk } from '../api/client';
import type { SettingsPatch } from '../api/client';

interface SettingsData {
  readonly developer: string;
  readonly teamId: string | null;
  readonly accountId: string | null;
  readonly appName: string;
  readonly mode: string;
  readonly storagePath: string;
  readonly highSecurity: boolean;
  readonly licenseKey: string | null;
  readonly sessionBudgetUsd: number | null;
  readonly dailyBudgetUsd: number | null;
  readonly weeklyBudgetUsd: number | null;
  readonly retainSessionsDays: number | null;
}

function ReadOnlyField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-ink-muted w-36 shrink-0">{label}</span>
      <span className="text-xs font-mono text-ink-subtle bg-surface-3 px-2 py-0.5 rounded">
        {value ?? '—'}
      </span>
    </div>
  );
}

function NullableNumberInput({
  label,
  value,
  onChange,
  placeholder,
  min,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  min?: number;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <label className="text-xs text-ink-muted w-36 shrink-0">{label}</label>
      <input
        type="number"
        min={min}
        step="any"
        value={value ?? ''}
        placeholder={placeholder ?? 'unlimited'}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
        className="text-xs bg-surface-3 border border-border-subtle rounded px-2 py-1 w-32 focus:outline-none focus:border-accent-green text-ink-base placeholder:text-ink-muted"
      />
    </div>
  );
}

export function Settings(): JSX.Element {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<SettingsData>({
    queryKey: qk.settings,
    queryFn: () => fetchSettings() as Promise<SettingsData>,
  });

  const [developer, setDeveloper] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null | undefined>(undefined);
  const [sessionBudget, setSessionBudget] = useState<number | null | undefined>(undefined);
  const [dailyBudget, setDailyBudget] = useState<number | null | undefined>(undefined);
  const [weeklyBudget, setWeeklyBudget] = useState<number | null | undefined>(undefined);
  const [retainDays, setRetainDays] = useState<number | null | undefined>(undefined);

  const [saved, setSaved] = useState<'identity' | 'budgets' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (patch: SettingsPatch) => patchSettings(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.settings });
      setSaveError(null);
    },
    onError: (err) => {
      setSaveError(String(err));
    },
  });

  if (isLoading) return <div className="text-ink-muted text-xs">Loading…</div>;
  if (error || !data)
    return <div className="text-accent-red text-xs">Failed to load settings.</div>;

  const effectiveDeveloper = developer ?? data.developer;
  const effectiveTeamId = teamId !== undefined ? teamId : data.teamId;
  const effectiveSession = sessionBudget !== undefined ? sessionBudget : data.sessionBudgetUsd;
  const effectiveDaily = dailyBudget !== undefined ? dailyBudget : data.dailyBudgetUsd;
  const effectiveWeekly = weeklyBudget !== undefined ? weeklyBudget : data.weeklyBudgetUsd;
  const effectiveRetain = retainDays !== undefined ? retainDays : data.retainSessionsDays;

  function saveIdentity() {
    const patch: SettingsPatch = {};
    if (developer !== null) patch.developer = developer;
    if (teamId !== undefined) patch.teamId = teamId;
    mutation.mutate(patch, {
      onSuccess: () => {
        setSaved('identity');
        setTimeout(() => setSaved(null), 3000);
      },
    });
  }

  function saveBudgets() {
    const patch: SettingsPatch = {};
    if (sessionBudget !== undefined) patch.sessionBudgetUsd = sessionBudget;
    if (dailyBudget !== undefined) patch.dailyBudgetUsd = dailyBudget;
    if (weeklyBudget !== undefined) patch.weeklyBudgetUsd = weeklyBudget;
    if (retainDays !== undefined) patch.retainSessionsDays = retainDays;
    mutation.mutate(patch, {
      onSuccess: () => {
        setSaved('budgets');
        setTimeout(() => setSaved(null), 3000);
      },
    });
  }

  const restartBanner = (which: 'identity' | 'budgets') =>
    saved === which ? (
      <div className="mt-2 text-xs text-accent-amber">
        Saved. Restart the server for changes to take effect.
      </div>
    ) : null;

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-xl font-semibold gradient-text">Settings</h1>
        <p className="text-xs text-ink-muted mt-1">
          Changes are written to config.json on disk. Most require a server restart.
        </p>
      </header>

      {saveError && (
        <div className="mb-4 text-xs text-accent-red bg-accent-red/10 border border-accent-red/30 rounded-lg px-3 py-2">
          {saveError}
        </div>
      )}

      {/* Identity & Account */}
      <div className="glass-card p-4 mb-4">
        <h2 className="text-sm font-medium text-ink-base mb-3">Identity &amp; Account</h2>

        <div className="flex items-center gap-3 py-1.5">
          <label className="text-xs text-ink-muted w-36 shrink-0">Developer name</label>
          <input
            type="text"
            value={effectiveDeveloper}
            maxLength={128}
            onChange={(e) => setDeveloper(e.target.value)}
            className="text-xs bg-surface-3 border border-border-subtle rounded px-2 py-1 w-48 focus:outline-none focus:border-accent-green text-ink-base"
          />
        </div>

        <div className="flex items-center gap-3 py-1.5">
          <label className="text-xs text-ink-muted w-36 shrink-0">Team ID</label>
          <input
            type="text"
            value={effectiveTeamId ?? ''}
            placeholder="optional"
            onChange={(e) => setTeamId(e.target.value === '' ? null : e.target.value)}
            className="text-xs bg-surface-3 border border-border-subtle rounded px-2 py-1 w-48 focus:outline-none focus:border-accent-green text-ink-base placeholder:text-ink-muted"
          />
        </div>

        <ReadOnlyField label="Account ID" value={data.accountId} />
        <ReadOnlyField label="App name" value={data.appName} />
        <ReadOnlyField label="Mode" value={data.mode} />
        <ReadOnlyField label="Storage path" value={data.storagePath} />
        <ReadOnlyField label="High security" value={data.highSecurity ? 'enabled' : 'disabled'} />
        <ReadOnlyField label="License key" value={data.licenseKey} />

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={saveIdentity}
            disabled={mutation.isPending}
            className="text-xs px-3 py-1.5 bg-accent-green/10 border border-accent-green/40 text-accent-green rounded-lg hover:bg-accent-green/20 transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? 'Saving…' : 'Save identity'}
          </button>
        </div>
        {restartBanner('identity')}
      </div>

      {/* Cost & Retention */}
      <div className="glass-card p-4">
        <h2 className="text-sm font-medium text-ink-base mb-3">Cost &amp; Retention</h2>
        <p className="text-xs text-ink-muted mb-3">
          Budget caps trigger warnings at 50%, 80%, and 100%. Leave blank for no limit.
        </p>

        <NullableNumberInput
          label="Session budget (USD)"
          value={effectiveSession}
          onChange={setSessionBudget}
          min={0.01}
        />
        <NullableNumberInput
          label="Daily budget (USD)"
          value={effectiveDaily}
          onChange={setDailyBudget}
          min={0.01}
        />
        <NullableNumberInput
          label="Weekly budget (USD)"
          value={effectiveWeekly}
          onChange={setWeeklyBudget}
          min={0.01}
        />
        <NullableNumberInput
          label="Retain sessions (days)"
          value={effectiveRetain}
          onChange={setRetainDays}
          placeholder="forever"
          min={1}
        />

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={saveBudgets}
            disabled={mutation.isPending}
            className="text-xs px-3 py-1.5 bg-accent-green/10 border border-accent-green/40 text-accent-green rounded-lg hover:bg-accent-green/20 transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? 'Saving…' : 'Save budgets'}
          </button>
        </div>
        {restartBanner('budgets')}
      </div>
    </section>
  );
}
