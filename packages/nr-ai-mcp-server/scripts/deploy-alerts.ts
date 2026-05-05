#!/usr/bin/env npx tsx
/**
 * Deploy AI Coding Assistant alert conditions to a New Relic account.
 *
 * Usage:
 *   NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts [options]
 *
 * Options:
 *   --dry-run   Print the policy + conditions that would be created and exit.
 *   --teardown  Delete the alert policy and all its conditions.
 *
 * Requires a New Relic User API key (NRAK-...), not a license key.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlertConditionDefinition, AlertPolicyDefinition } from '../src/alerts/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

async function nerdgraph<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(NERDGRAPH_URL, {
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
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(`NerdGraph errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data as T;
}

const CREATE_POLICY_MUTATION = `
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

const CREATE_NRQL_CONDITION_MUTATION = `
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

const LIST_POLICIES_QUERY = `
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

const DELETE_POLICY_MUTATION = `
mutation DeletePolicy($accountId: Int!, $policyId: ID!) {
  alertsPolicyDelete(accountId: $accountId, id: $policyId) {
    id
  }
}`;

function loadDefinitions(): {
  policy: AlertPolicyDefinition;
  conditions: AlertConditionDefinition[];
} {
  const alertsDir = resolve(__dirname, '..', 'alerts');
  const conditionsDir = resolve(alertsDir, 'conditions');

  const policy: AlertPolicyDefinition = JSON.parse(
    readFileSync(resolve(alertsDir, 'policy.json'), 'utf-8'),
  );

  const conditionFiles = readdirSync(conditionsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const conditions: AlertConditionDefinition[] = conditionFiles.map((f) =>
    JSON.parse(readFileSync(resolve(conditionsDir, f), 'utf-8')),
  );

  return { policy, conditions };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const teardown = args.includes('--teardown');

  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!accountIdStr) {
    console.error('Error: NEW_RELIC_ACCOUNT_ID environment variable is required.');
    process.exit(1);
  }
  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId)) {
    console.error(`Error: NEW_RELIC_ACCOUNT_ID must be a number. Got: "${accountIdStr}"`);
    process.exit(1);
  }

  const { policy, conditions } = loadDefinitions();

  if (dryRun) {
    process.stdout.write('--- Dry run: would create policy ---\n');
    process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
    process.stdout.write(`--- Would create ${conditions.length} conditions ---\n`);
    for (const c of conditions) {
      process.stdout.write(`  [${c.enabled ? 'enabled' : 'disabled'}] ${c.name}\n`);
    }
    return;
  }

  const apiKey = process.env.NEW_RELIC_API_KEY;
  if (!apiKey) {
    console.error('Error: NEW_RELIC_API_KEY environment variable is required (User API key, not license key).');
    process.exit(1);
  }

  if (teardown) {
    const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
      accountId,
      name: policy.name,
    });
    const existing = listResult.actor.account.alerts.policiesSearch.policies;
    if (existing.length === 0) {
      process.stdout.write(`No policy named "${policy.name}" found. Nothing to delete.\n`);
      return;
    }
    for (const p of existing) {
      await nerdgraph(apiKey, DELETE_POLICY_MUTATION, { accountId, policyId: p.id });
      process.stdout.write(`Deleted policy "${p.name}" (id: ${p.id})\n`);
    }
    return;
  }

  // Idempotent: skip if policy already exists
  const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
    accountId,
    name: policy.name,
  });
  const existing = listResult.actor.account.alerts.policiesSearch.policies;

  if (existing.length > 0) {
    const policyId = existing[0].id;
    process.stdout.write(`Policy "${policy.name}" already exists (id: ${policyId}). Skipping creation.\n`);
    process.stdout.write('Tip: run with --teardown to delete it first, then re-deploy.\n');
    return;
  }

  // Create policy
  const createPolicyResult = await nerdgraph<CreatePolicyResult>(apiKey, CREATE_POLICY_MUTATION, {
    accountId,
    name: policy.name,
    incidentPreference: policy.incidentPreference,
  });
  const policyId = createPolicyResult.alertsPolicyCreate.id;
  process.stdout.write(`Created policy "${policy.name}" (id: ${policyId})\n`);

  // Create each condition
  for (const cond of conditions) {
    const conditionInput = {
      name: cond.name,
      description: cond.description,
      enabled: cond.enabled,
      nrql: { query: cond.nrqlQuery },
      signal: {
        aggregationMethod: cond.aggregationMethod,
        aggregationWindow: cond.aggregationWindow,
        ...(cond.aggregationDelay !== undefined
          ? { aggregationDelay: String(cond.aggregationDelay) }
          : {}),
        ...(cond.aggregationTimer !== undefined
          ? { aggregationTimer: String(cond.aggregationTimer) }
          : {}),
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

    const result = await nerdgraph<CreateConditionResult>(
      apiKey,
      CREATE_NRQL_CONDITION_MUTATION,
      { accountId, policyId, condition: conditionInput },
    );
    const created = result.alertsNrqlConditionStaticCreate;
    const status = created.enabled ? 'enabled' : 'disabled';
    process.stdout.write(`  Created condition "${created.name}" (${status})\n`);
  }

  process.stdout.write('\nDone. Tip: adjust threshold values in src/alerts/conditions/ to match your usage.\n');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
