/**
 * Deploy AI Coding Assistant alert conditions to a New Relic account.
 *
 * Exposed as the `preflight deploy-alerts` subcommand so users who
 * installed via `npm install -g` can run it without cloning the repo. The
 * alert policy + conditions JSON ships in `dist/data/alerts/` after build.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

import type {
  AlertConditionDefinition,
  AlertPolicyDefinition,
  PersonalAlertThresholds,
} from '../alerts/types.js';
import { DEFAULT_PERSONAL_THRESHOLDS } from '../alerts/types.js';
import { normalizeDeveloperName } from '../config.js';
import { resolveDataDir } from './data-paths.js';

export const CREATE_POLICY_MUTATION = `
mutation CreateAlertPolicy($accountId: Int!, $name: String!, $incidentPreference: AlertsIncidentPreference!) {
  alertsPolicyCreate(accountId: $accountId, policy: {
    name: $name
    incidentPreference: $incidentPreference
  }) {
    id
    name
  }
}`;

interface CreatePolicyResult {
  alertsPolicyCreate: { id: string; name: string };
}

export const CREATE_NRQL_CONDITION_MUTATION = `
mutation CreateNrqlCondition($accountId: Int!, $policyId: ID!, $condition: AlertsNrqlConditionStaticInput!) {
  alertsNrqlConditionStaticCreate(accountId: $accountId, policyId: $policyId, condition: $condition) {
    id
    name
    enabled
  }
}`;

interface CreateConditionResult {
  alertsNrqlConditionStaticCreate: { id: string; name: string; enabled: boolean };
}

export const LIST_POLICIES_QUERY = `
query ListPolicies($accountId: Int!, $name: String!) {
  actor {
    account(id: $accountId) {
      alerts {
        policiesSearch(searchCriteria: { name: $name }) {
          policies {
            id
            name
          }
        }
      }
    }
  }
}`;

interface ListPoliciesResult {
  actor: {
    account: {
      alerts: {
        policiesSearch: {
          policies: Array<{ id: string; name: string }>;
        };
      };
    };
  };
}

export const DELETE_POLICY_MUTATION = `
mutation DeletePolicy($accountId: Int!, $policyId: ID!) {
  alertsPolicyDelete(accountId: $accountId, id: $policyId) {
    id
  }
}`;

export const LIST_CONDITIONS_QUERY = `
query ListConditions($accountId: Int!, $policyId: ID!) {
  actor {
    account(id: $accountId) {
      alerts {
        nrqlConditionsSearch(searchCriteria: { policyId: $policyId }) {
          nrqlConditions {
            id
            name
          }
        }
      }
    }
  }
}`;

interface ListConditionsResult {
  actor: {
    account: {
      alerts: {
        nrqlConditionsSearch: {
          nrqlConditions: Array<{ id: string; name: string }>;
        };
      };
    };
  };
}

export const UPDATE_NRQL_CONDITION_MUTATION = `
mutation UpdateNrqlCondition($accountId: Int!, $id: ID!, $condition: AlertsNrqlConditionUpdateStaticInput!) {
  alertsNrqlConditionStaticUpdate(accountId: $accountId, id: $id, condition: $condition) {
    id
    name
    enabled
  }
}`;

interface UpdateConditionResult {
  alertsNrqlConditionStaticUpdate: { id: string; name: string; enabled: boolean };
}

export const DELETE_CONDITION_MUTATION = `
mutation DeleteCondition($accountId: Int!, $id: ID!) {
  alertsConditionDelete(accountId: $accountId, id: $id) {
    id
  }
}`;

interface OutputStream {
  write: (chunk: string) => boolean | void;
}

export interface AlertsDeployOptions {
  readonly dryRun: boolean;
  readonly teardown: boolean;
  readonly update: boolean;
  readonly eu: boolean;
  readonly developer: string | null;
  /**
   * Override the alerts data dir. Used by tests so they can point at a fixture
   * directory instead of the bundled `dist/data/alerts/`.
   */
  readonly dataDir?: string;
  /** Override the URL passed to fetch — used by tests with a mock. */
  readonly nerdgraphUrlOverride?: string;
  /** Injected fetch — used by tests to capture/stub HTTP calls. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Override personal thresholds. Production reads from
   * `~/.newrelic-preflight/config.json`; tests inject directly.
   */
  readonly personalThresholdsOverride?: PersonalAlertThresholds;
  /** Stream for stdout writes — defaults to process.stdout. */
  readonly stdout?: OutputStream;
}

async function nerdgraph<T>(
  apiKey: string,
  url: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API-Key': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`NerdGraph HTTP ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as {
    data?: T;
    errors?: Array<{
      message: string;
      path?: ReadonlyArray<string | number>;
      extensions?: Record<string, unknown>;
    }>;
  };
  if (json.errors?.length) {
    throw new Error(`NerdGraph errors: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data as T;
}

export function loadDefinitions(dataDir: string): {
  policy: AlertPolicyDefinition;
  conditions: AlertConditionDefinition[];
} {
  const conditionsDir = resolve(dataDir, 'conditions');

  const policy: AlertPolicyDefinition = JSON.parse(
    readFileSync(resolve(dataDir, 'policy.json'), 'utf-8'),
  );

  const conditionFiles = readdirSync(conditionsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const conditions: AlertConditionDefinition[] = conditionFiles.map((f) =>
    JSON.parse(readFileSync(resolve(conditionsDir, f), 'utf-8')),
  );

  return { policy, conditions };
}

export function loadPersonalDefinitions(
  dataDir: string,
  developer: string,
  thresholds: PersonalAlertThresholds,
): { policy: AlertPolicyDefinition; conditions: AlertConditionDefinition[] } {
  const conditionsDir = resolve(dataDir, 'conditions-personal');

  const policy: AlertPolicyDefinition = {
    name: `AI Coding — Personal — ${developer}`,
    incidentPreference: 'PER_CONDITION',
  };

  const conditionFiles = readdirSync(conditionsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const thresholdMap: Record<string, number> = {
    __dailyCostUsd__: thresholds.dailyCostUsd,
    __sessionCostUsd__: thresholds.sessionCostUsd,
    __efficiencyScoreMin__: thresholds.efficiencyScoreMin,
    __stuckLoopCountMax__: thresholds.stuckLoopCountMax,
    __antiPatternCountMax__: thresholds.antiPatternCountMax,
  };

  const conditions: AlertConditionDefinition[] = conditionFiles.map((f) => {
    let raw = readFileSync(resolve(conditionsDir, f), 'utf-8');

    raw = raw.replaceAll('{{developer}}', developer);
    for (const [placeholder, value] of Object.entries(thresholdMap)) {
      raw = raw.replace(`"${placeholder}"`, String(value));
    }

    return JSON.parse(raw) as AlertConditionDefinition;
  });

  return { policy, conditions };
}

export function loadPersonalThresholds(): PersonalAlertThresholds {
  const configPath = resolve(homedir(), '.newrelic-preflight', 'config.json');
  try {
    const file = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const alertsSection = file.alerts;
    if (typeof alertsSection !== 'object' || alertsSection === null)
      return DEFAULT_PERSONAL_THRESHOLDS;
    const personal = (alertsSection as Record<string, unknown>).personal;
    if (typeof personal !== 'object' || personal === null) return DEFAULT_PERSONAL_THRESHOLDS;
    const t = personal as Record<string, unknown>;
    return {
      dailyCostUsd:
        typeof t.dailyCostUsd === 'number'
          ? t.dailyCostUsd
          : DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
      sessionCostUsd:
        typeof t.sessionCostUsd === 'number'
          ? t.sessionCostUsd
          : DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
      efficiencyScoreMin:
        typeof t.efficiencyScoreMin === 'number'
          ? t.efficiencyScoreMin
          : DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
      stuckLoopCountMax:
        typeof t.stuckLoopCountMax === 'number'
          ? t.stuckLoopCountMax
          : DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
      antiPatternCountMax:
        typeof t.antiPatternCountMax === 'number'
          ? t.antiPatternCountMax
          : DEFAULT_PERSONAL_THRESHOLDS.antiPatternCountMax,
    };
  } catch {
    return DEFAULT_PERSONAL_THRESHOLDS;
  }
}

export function buildConditionInput(cond: AlertConditionDefinition): Record<string, unknown> {
  return {
    name: cond.name,
    description: cond.description,
    enabled: cond.enabled,
    nrql: { query: cond.nrqlQuery },
    signal: {
      aggregationMethod: cond.aggregationMethod,
      aggregationWindow: cond.aggregationWindow,
      ...(cond.aggregationDelay !== undefined ? { aggregationDelay: cond.aggregationDelay } : {}),
      ...(cond.aggregationTimer !== undefined ? { aggregationTimer: cond.aggregationTimer } : {}),
    },
    terms: [
      {
        threshold: cond.thresholdCritical.value,
        thresholdDuration: cond.thresholdCritical.duration,
        thresholdOccurrences: cond.thresholdCritical.occurrences,
        operator: cond.thresholdOperator,
        priority: 'CRITICAL',
      },
      ...(cond.thresholdWarning
        ? [
            {
              threshold: cond.thresholdWarning.value,
              thresholdDuration: cond.thresholdWarning.duration,
              thresholdOccurrences: cond.thresholdWarning.occurrences,
              operator: cond.thresholdOperator,
              priority: 'WARNING',
            },
          ]
        : []),
    ],
    violationTimeLimitSeconds: cond.violationTimeLimitSeconds,
  };
}

async function syncConditions(
  apiKey: string,
  url: string,
  accountId: number,
  policyId: string,
  localConditions: AlertConditionDefinition[],
  fetchImpl: typeof fetch,
  out: OutputStream,
): Promise<void> {
  const listResult = await nerdgraph<ListConditionsResult>(
    apiKey,
    url,
    LIST_CONDITIONS_QUERY,
    { accountId, policyId },
    fetchImpl,
  );
  const remoteConditions = listResult.actor.account.alerts.nrqlConditionsSearch.nrqlConditions;
  const remoteByName = new Map(remoteConditions.map((c) => [c.name, c]));
  const localNames = new Set(localConditions.map((c) => c.name));

  for (const cond of localConditions) {
    const existing = remoteByName.get(cond.name);
    if (existing) {
      out.write(`  Updating condition "${cond.name}" (id: ${existing.id})...\n`);
      const result = await nerdgraph<UpdateConditionResult>(
        apiKey,
        url,
        UPDATE_NRQL_CONDITION_MUTATION,
        { accountId, id: existing.id, condition: buildConditionInput(cond) },
        fetchImpl,
      );
      const updated = result.alertsNrqlConditionStaticUpdate;
      const status = updated.enabled ? 'enabled' : 'disabled';
      out.write(`    -> Updated (${status})\n`);
    } else {
      out.write(`  Creating condition "${cond.name}"...\n`);
      const result = await nerdgraph<CreateConditionResult>(
        apiKey,
        url,
        CREATE_NRQL_CONDITION_MUTATION,
        { accountId, policyId, condition: buildConditionInput(cond) },
        fetchImpl,
      );
      const created = result.alertsNrqlConditionStaticCreate;
      const status = created.enabled ? 'enabled' : 'disabled';
      out.write(`    -> Created (${status})\n`);
    }
  }

  for (const remote of remoteConditions) {
    if (!localNames.has(remote.name)) {
      await nerdgraph(
        apiKey,
        url,
        DELETE_CONDITION_MUTATION,
        { accountId, id: remote.id },
        fetchImpl,
      );
      out.write(`  Deleted obsolete condition "${remote.name}" (id: ${remote.id})\n`);
    }
  }
}

function pickNerdgraphUrl(opts: AlertsDeployOptions): string {
  if (opts.nerdgraphUrlOverride) return opts.nerdgraphUrlOverride;
  if (opts.eu) return 'https://api.eu.newrelic.com/graphql';
  return 'https://api.newrelic.com/graphql';
}

/**
 * Run the deploy-alerts command. Returns the exit code (0 = success,
 * non-zero = failure).
 */
export async function runDeployAlerts(opts: AlertsDeployOptions): Promise<number> {
  const out: OutputStream = opts.stdout ?? process.stdout;
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;

  if ([opts.dryRun, opts.teardown, opts.update].filter(Boolean).length > 1) {
    out.write('Error: --dry-run, --teardown, and --update are mutually exclusive.\n');
    return 1;
  }

  if (opts.eu) {
    out.write('Targeting EU API: https://api.eu.newrelic.com/graphql\n');
  }

  const developer: string | null = opts.developer ? normalizeDeveloperName(opts.developer) : null;

  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!accountIdStr) {
    out.write('Error: NEW_RELIC_ACCOUNT_ID environment variable is required.\n');
    return 1;
  }
  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId) || accountId <= 0 || String(accountId) !== accountIdStr.trim()) {
    out.write(`Error: NEW_RELIC_ACCOUNT_ID must be a positive integer. Got: "${accountIdStr}"\n`);
    return 1;
  }

  const dataDir = opts.dataDir ?? resolveDataDir('alerts');
  const url = pickNerdgraphUrl(opts);
  const personalThresholds = opts.personalThresholdsOverride ?? loadPersonalThresholds();

  if (opts.dryRun) {
    if (developer) {
      const { policy, conditions } = loadPersonalDefinitions(
        dataDir,
        developer,
        personalThresholds,
      );
      out.write(`--- Dry run: personal policy for ${developer} ---\n`);
      out.write(`${JSON.stringify(policy, null, 2)}\n`);
      out.write(`--- Would create ${conditions.length} personal conditions ---\n`);
      for (const c of conditions) {
        out.write(`  [${c.enabled ? 'enabled' : 'disabled'}] ${c.name}\n`);
      }
    } else {
      const { policy, conditions } = loadDefinitions(dataDir);
      out.write('--- Dry run: would create policy ---\n');
      out.write(`${JSON.stringify(policy, null, 2)}\n`);
      out.write(`--- Would create ${conditions.length} conditions ---\n`);
      for (const c of conditions) {
        out.write(`  [${c.enabled ? 'enabled' : 'disabled'}] ${c.name}\n`);
      }
    }
    return 0;
  }

  const apiKey = process.env.NEW_RELIC_API_KEY;
  if (!apiKey) {
    out.write(
      'Error: NEW_RELIC_API_KEY environment variable is required (User API key, not license key).\n',
    );
    return 1;
  }

  try {
    if (opts.teardown) {
      const policyName = developer
        ? `AI Coding — Personal — ${developer}`
        : loadDefinitions(dataDir).policy.name;

      const listResult = await nerdgraph<ListPoliciesResult>(
        apiKey,
        url,
        LIST_POLICIES_QUERY,
        { accountId, name: policyName },
        fetchImpl,
      );
      const existing = listResult.actor.account.alerts.policiesSearch.policies;
      if (existing.length === 0) {
        out.write(`No policy named "${policyName}" found. Nothing to delete.\n`);
        return 0;
      }
      for (const p of existing) {
        await nerdgraph(
          apiKey,
          url,
          DELETE_POLICY_MUTATION,
          { accountId, policyId: p.id },
          fetchImpl,
        );
        out.write(`Deleted policy "${p.name}" (id: ${p.id})\n`);
      }
      return 0;
    }

    if (opts.update) {
      const { policy, conditions } = developer
        ? loadPersonalDefinitions(dataDir, developer, personalThresholds)
        : loadDefinitions(dataDir);

      const listResult = await nerdgraph<ListPoliciesResult>(
        apiKey,
        url,
        LIST_POLICIES_QUERY,
        { accountId, name: policy.name },
        fetchImpl,
      );
      const existing = listResult.actor.account.alerts.policiesSearch.policies;
      if (existing.length === 0) {
        out.write(
          `Error: No policy named "${policy.name}" found. Use deploy (without --update) to create it.\n`,
        );
        return 1;
      }
      const policyId = existing[0].id;
      out.write(`Syncing conditions on policy "${policy.name}" (id: ${policyId})...\n`);
      await syncConditions(apiKey, url, accountId, policyId, conditions, fetchImpl, out);
      out.write(
        '\nDone. Tip: --update only syncs conditions. Policy name and incidentPreference changes still require --teardown then re-deploy.\n',
      );
      return 0;
    }

    if (developer) {
      const { policy, conditions } = loadPersonalDefinitions(
        dataDir,
        developer,
        personalThresholds,
      );

      const listResult = await nerdgraph<ListPoliciesResult>(
        apiKey,
        url,
        LIST_POLICIES_QUERY,
        { accountId, name: policy.name },
        fetchImpl,
      );
      if (listResult.actor.account.alerts.policiesSearch.policies.length > 0) {
        const existing = listResult.actor.account.alerts.policiesSearch.policies[0];
        out.write(
          `Personal policy for "${developer}" already exists (id: ${existing.id}). Use --teardown to reset.\n`,
        );
        return 0;
      }

      const createResult = await nerdgraph<CreatePolicyResult>(
        apiKey,
        url,
        CREATE_POLICY_MUTATION,
        { accountId, name: policy.name, incidentPreference: policy.incidentPreference },
        fetchImpl,
      );
      const policyId = createResult.alertsPolicyCreate.id;
      out.write(`Created personal policy "${policy.name}" (id: ${policyId})\n`);

      for (const cond of conditions) {
        const result = await nerdgraph<CreateConditionResult>(
          apiKey,
          url,
          CREATE_NRQL_CONDITION_MUTATION,
          { accountId, policyId, condition: buildConditionInput(cond) },
          fetchImpl,
        );
        const created = result.alertsNrqlConditionStaticCreate;
        out.write(
          `  Created condition "${created.name}" (${created.enabled ? 'enabled' : 'disabled'})\n`,
        );
      }
      return 0;
    }

    // Team policy deployment
    const { policy, conditions } = loadDefinitions(dataDir);

    const listResult = await nerdgraph<ListPoliciesResult>(
      apiKey,
      url,
      LIST_POLICIES_QUERY,
      { accountId, name: policy.name },
      fetchImpl,
    );
    const existing = listResult.actor.account.alerts.policiesSearch.policies;

    if (existing.length > 0) {
      const policyId = existing[0].id;
      out.write(`Policy "${policy.name}" already exists (id: ${policyId}). Skipping creation.\n`);
      out.write('Tip: run with --teardown to delete it first, then re-deploy.\n');
      return 0;
    }

    const createPolicyResult = await nerdgraph<CreatePolicyResult>(
      apiKey,
      url,
      CREATE_POLICY_MUTATION,
      { accountId, name: policy.name, incidentPreference: policy.incidentPreference },
      fetchImpl,
    );
    const policyId = createPolicyResult.alertsPolicyCreate.id;
    out.write(`Created policy "${policy.name}" (id: ${policyId})\n`);

    for (const cond of conditions) {
      const result = await nerdgraph<CreateConditionResult>(
        apiKey,
        url,
        CREATE_NRQL_CONDITION_MUTATION,
        { accountId, policyId, condition: buildConditionInput(cond) },
        fetchImpl,
      );
      const created = result.alertsNrqlConditionStaticCreate;
      const status = created.enabled ? 'enabled' : 'disabled';
      out.write(`  Created condition "${created.name}" (${status})\n`);
    }

    out.write('\nDone. Tip: adjust threshold values in alerts/conditions/ to match your usage.\n');
    return 0;
  } catch (err) {
    out.write(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
