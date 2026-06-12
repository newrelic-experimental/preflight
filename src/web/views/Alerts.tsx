import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';

import { fetchBudget, fetchSettings, patchSettings, postDigestSend, qk } from '../api/client';
import type { SettingsPatch } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Button, Card, Eyebrow, Pill, SectionHeader } from '../components/ui';

interface BudgetPeriod {
  readonly budgetUsd: number | null;
  readonly spentUsd: number;
  readonly pctUsed: number | null;
  readonly exceeded: boolean;
}

interface BudgetAlert {
  readonly period: string;
  readonly thresholdPct: number;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly timestamp: number;
}

interface BudgetStatus {
  readonly session: BudgetPeriod;
  readonly daily: BudgetPeriod;
  readonly weekly: BudgetPeriod;
  readonly alerts: readonly BudgetAlert[];
}

interface PersonalThresholds {
  readonly dailyCostUsd: number;
  readonly sessionCostUsd: number;
  readonly efficiencyScoreMin: number;
  readonly stuckLoopCountMax: number;
  readonly antiPatternCountMax: number;
}

interface SettingsData {
  readonly digestWebhookUrl: string | null;
  readonly digestSchedule: string;
  readonly alerts: { readonly personal: PersonalThresholds };
}

function SpendBar({ pct, exceeded }: { pct: number | null; exceeded: boolean }) {
  const fill = pct ?? 0;
  const color = exceeded ? 'bg-accent-red' : fill >= 80 ? 'bg-accent-amber' : 'bg-accent-green';
  return (
    <div className="w-24 h-1.5 bg-surface-5 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${Math.min(fill, 100)}%` }}
      />
    </div>
  );
}

function PeriodRow({ label, p }: { label: string; p: BudgetPeriod }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-ink-muted w-20 shrink-0 capitalize">{label}</span>
      <SpendBar pct={p.pctUsed} exceeded={p.exceeded} />
      <span className="text-xs tabular-nums text-ink-base">
        ${p.spentUsd.toFixed(4)}
        {p.budgetUsd !== null ? ` / $${p.budgetUsd.toFixed(2)}` : ''}
        {p.pctUsed !== null ? ` (${p.pctUsed.toFixed(0)}%)` : ''}
      </span>
      {p.exceeded && (
        <Pill tone="danger" size="sm">
          exceeded
        </Pill>
      )}
    </div>
  );
}

export function Alerts(): JSX.Element {
  const queryClient = useQueryClient();

  const budgetQ = useQuery<BudgetStatus>({
    queryKey: qk.budget,
    queryFn: () => fetchBudget() as Promise<BudgetStatus>,
    refetchInterval: 10_000,
  });

  const settingsQ = useQuery<SettingsData>({
    queryKey: qk.settings,
    queryFn: () => fetchSettings() as Promise<SettingsData>,
  });

  const budget = budgetQ.data;
  const settings = settingsQ.data;

  // Personal threshold local state
  const [thresholds, setThresholds] = useState<Partial<PersonalThresholds>>({});
  const [thresholdSaved, setThresholdSaved] = useState(false);

  // Slack digest local state
  // undefined = untouched, null = user explicitly cleared, string = user typed a value
  const [webhookUrl, setWebhookUrl] = useState<string | null | undefined>(undefined);
  const [schedule, setSchedule] = useState<string | null>(null);
  const [digestStatus, setDigestStatus] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: (patch: SettingsPatch) => patchSettings(patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings }),
  });

  const sendMutation = useMutation({
    mutationFn: () => postDigestSend(),
    onSuccess: (result) => {
      const r = result as { content?: Array<{ text?: string }> };
      const text = r.content?.[0]?.text ?? '';
      try {
        const parsed = JSON.parse(text) as { ok?: boolean; error?: string };
        setDigestStatus(parsed.ok ? 'Digest sent.' : (parsed.error ?? 'Failed to send.'));
      } catch {
        setDigestStatus('Done.');
      }
      setTimeout(() => setDigestStatus(null), 4000);
    },
    onError: (err) => {
      setDigestStatus(`Error: ${String(err)}`);
    },
  });

  function saveThresholds() {
    if (Object.keys(thresholds).length === 0) return;
    saveMutation.mutate(
      { alerts: { personal: thresholds } },
      {
        onSuccess: () => {
          setThresholdSaved(true);
          setTimeout(() => setThresholdSaved(false), 3000);
        },
      },
    );
  }

  function saveWebhook() {
    const patch: SettingsPatch = {};
    // undefined = untouched (skip), null = cleared (remove), string = new URL (set)
    if (webhookUrl !== undefined) patch.digestWebhookUrl = webhookUrl;
    if (schedule !== null) patch.digestSchedule = schedule ?? settings?.digestSchedule;
    saveMutation.mutate(patch);
  }

  function thr(key: keyof PersonalThresholds): number {
    return thresholds[key] ?? settings?.alerts.personal[key] ?? 0;
  }

  function numInput(
    label: string,
    key: keyof PersonalThresholds,
    opts: { min?: number; max?: number; step?: number } = {},
  ) {
    return (
      <div className="flex items-center gap-3 py-1.5">
        <label className="text-xs text-ink-muted w-44 shrink-0">{label}</label>
        <input
          type="number"
          value={thr(key)}
          min={opts.min}
          max={opts.max}
          step={opts.step ?? 'any'}
          onChange={(e) => setThresholds((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
          className="text-xs bg-surface-3 border border-border-subtle rounded-md px-2 py-1 w-24 focus:outline-none focus:border-accent-green text-ink-base"
        />
      </div>
    );
  }

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-xl font-semibold gradient-text">Alerts</h1>
      </header>

      {/* Budget Status */}
      <Card padding="md" className="mb-4">
        <SectionHeader title="Budget Status" />
        {budgetQ.isLoading && <EmptyState icon="clock" variant="loading" title="Loading..." />}
        {budget && (
          <>
            <PeriodRow label="session" p={budget.session} />
            <PeriodRow label="daily" p={budget.daily} />
            <PeriodRow label="weekly" p={budget.weekly} />

            {budget.alerts.length > 0 && (
              <div className="mt-3 border-t border-border-subtle pt-3">
                <Eyebrow className="mb-2">Recent Warnings</Eyebrow>
                <div className="flex flex-col gap-1">
                  {budget.alerts
                    .slice(-5)
                    .reverse()
                    .map((a, i) => (
                      <div key={i} className="text-xs text-ink-subtle flex gap-2">
                        <span className="text-accent-amber tabular-nums">{a.thresholdPct}%</span>
                        <span className="capitalize">{a.period}</span>
                        <span className="text-ink-muted tabular-nums">
                          ${a.spentUsd.toFixed(4)} / ${a.budgetUsd.toFixed(2)}
                        </span>
                        <span className="text-ink-muted ml-auto tabular-nums">
                          {new Date(a.timestamp).toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {budget.alerts.length === 0 &&
              budget.session.budgetUsd === null &&
              budget.daily.budgetUsd === null &&
              budget.weekly.budgetUsd === null && (
                <p className="text-xs text-ink-muted mt-2">
                  No budget caps configured.{' '}
                  <Link
                    href="/settings"
                    className="text-accent-cyan hover:underline transition-colors duration-150"
                  >
                    Set limits in Settings
                  </Link>{' '}
                  to enable warnings.
                </p>
              )}
          </>
        )}
      </Card>

      {/* Alert Thresholds */}
      <Card padding="md" className="mb-4">
        <SectionHeader
          title="Alert Thresholds"
          subtitle="Thresholds for the local alert engine. Require a server restart to take effect."
        />

        {settingsQ.isLoading && <EmptyState icon="clock" variant="loading" title="Loading..." />}
        {settings && (
          <>
            {numInput('Daily cost ($)', 'dailyCostUsd', { min: 0, step: 0.1 })}
            {numInput('Session cost ($)', 'sessionCostUsd', { min: 0, step: 0.1 })}
            {numInput('Min efficiency score (0–1)', 'efficiencyScoreMin', {
              min: 0,
              max: 1,
              step: 0.05,
            })}
            {numInput('Max anti-patterns', 'antiPatternCountMax', { min: 0, step: 1 })}
            {numInput('Max stuck loops', 'stuckLoopCountMax', { min: 0, step: 1 })}

            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="primary"
                size="md"
                onClick={saveThresholds}
                disabled={saveMutation.isPending || Object.keys(thresholds).length === 0}
                loading={saveMutation.isPending}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save thresholds'}
              </Button>
              {thresholdSaved && (
                <span className="text-xs text-accent-amber">
                  Saved. Restart server for changes to take effect.
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      {/* Slack Digest */}
      <Card padding="md">
        <SectionHeader
          title="Slack Digest"
          subtitle="Weekly digest sent to a Slack incoming webhook. URL changes take effect immediately."
        />

        {settings && (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Pill tone={settings.digestWebhookUrl ? 'success' : 'neutral'} size="sm">
                {settings.digestWebhookUrl ? 'Configured' : 'Not configured'}
              </Pill>
            </div>

            <div className="flex items-center gap-3 py-1.5">
              <label className="text-xs text-ink-muted w-28 shrink-0">Webhook URL</label>
              <input
                type="url"
                value={
                  webhookUrl !== undefined ? (webhookUrl ?? '') : (settings.digestWebhookUrl ?? '')
                }
                placeholder="https://hooks.slack.com/..."
                onChange={(e) => setWebhookUrl(e.target.value === '' ? null : e.target.value)}
                className="text-xs bg-surface-3 border border-border-subtle rounded-md px-2 py-1 w-72 focus:outline-none focus:border-accent-green text-ink-base placeholder:text-ink-muted"
              />
            </div>

            <div className="flex items-center gap-3 py-1.5">
              <label className="text-xs text-ink-muted w-28 shrink-0">
                Schedule
                <span className="block text-[10px] text-ink-muted font-normal">
                  (cron, restart req.)
                </span>
              </label>
              <input
                type="text"
                value={schedule ?? settings.digestSchedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="text-xs bg-surface-3 border border-border-subtle rounded-md px-2 py-1 w-36 focus:outline-none focus:border-accent-green text-ink-base font-mono"
              />
              <span className="text-[10px] text-ink-muted">default: Mon 9am</span>
            </div>

            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <Button
                variant="primary"
                size="md"
                onClick={saveWebhook}
                disabled={saveMutation.isPending}
                loading={saveMutation.isPending}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </Button>

              {settings.digestWebhookUrl && (
                <Button
                  variant="danger"
                  size="md"
                  onClick={() => saveMutation.mutate({ digestWebhookUrl: null })}
                  disabled={saveMutation.isPending}
                >
                  Unsubscribe
                </Button>
              )}

              <Button
                variant="secondary"
                size="md"
                onClick={() => sendMutation.mutate()}
                disabled={sendMutation.isPending || !settings.digestWebhookUrl}
                loading={sendMutation.isPending}
              >
                {sendMutation.isPending ? 'Sending…' : 'Send test now'}
              </Button>

              {digestStatus && <span className="text-xs text-ink-subtle">{digestStatus}</span>}
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
