#!/usr/bin/env npx tsx
/**
 * Deploy the AI Overview dashboard to a New Relic account.
 *
 * Usage:
 *   NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts
 *
 * Requires a New Relic User API key (not a license key).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

const CREATE_MUTATION = `
mutation DashboardCreate($accountId: Int!, $dashboard: DashboardInput!) {
  dashboardCreate(accountId: $accountId, dashboard: $dashboard) {
    entityResult {
      guid
      name
      permalink
    }
    errors {
      description
      type
    }
  }
}`;

interface DashboardJson {
  name: string;
  description?: string;
  permissions?: string;
  pages: Array<{
    name: string;
    description?: string;
    widgets: Array<{
      title: string;
      layout: { column: number; row: number; width: number; height: number };
      visualization: { id: string };
      rawConfiguration: {
        nrqlQueries: Array<{ accountIds: number[]; query: string }>;
        [key: string]: unknown;
      };
    }>;
  }>;
}

async function main(): Promise<void> {
  const apiKey = process.env.NEW_RELIC_API_KEY;
  if (!apiKey) {
    console.error('Error: NEW_RELIC_API_KEY environment variable is required (User API key, not license key)');
    process.exit(1);
  }

  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!accountIdStr) {
    console.error('Error: NEW_RELIC_ACCOUNT_ID environment variable is required');
    process.exit(1);
  }

  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId)) {
    console.error(`Error: NEW_RELIC_ACCOUNT_ID must be a number, got: ${accountIdStr}`);
    process.exit(1);
  }

  const dashboardPath = resolve(__dirname, '..', 'dashboards', 'ai-overview.json');
  const raw = readFileSync(dashboardPath, 'utf-8');
  const dashboard: DashboardJson = JSON.parse(raw);

  // Inject accountId into each widget's nrqlQueries
  for (const page of dashboard.pages) {
    for (const widget of page.widgets) {
      for (const nrqlQuery of widget.rawConfiguration.nrqlQueries) {
        nrqlQuery.accountIds = [accountId];
      }
    }
  }

  console.log(`Deploying dashboard "${dashboard.name}" to account ${accountId}...`);

  const response = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API-Key': apiKey,
    },
    body: JSON.stringify({
      query: CREATE_MUTATION,
      variables: { accountId, dashboard },
    }),
  });

  if (!response.ok) {
    console.error(`HTTP error: ${response.status} ${response.statusText}`);
    const body = await response.text();
    console.error(body);
    process.exit(1);
  }

  const result = await response.json() as {
    data?: {
      dashboardCreate?: {
        entityResult?: { guid: string; name: string; permalink: string } | null;
        errors?: Array<{ description: string; type: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (result.errors?.length) {
    console.error('GraphQL errors:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  const createResult = result.data?.dashboardCreate;
  if (createResult?.errors?.length) {
    console.error('Dashboard creation errors:', JSON.stringify(createResult.errors, null, 2));
    process.exit(1);
  }

  const entity = createResult?.entityResult;
  if (entity) {
    console.log(`Dashboard created successfully!`);
    console.log(`  Name: ${entity.name}`);
    console.log(`  GUID: ${entity.guid}`);
    console.log(`  URL:  ${entity.permalink}`);
  } else {
    console.error('Unexpected response — no entity result returned');
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Failed to deploy dashboard:', err);
  process.exit(1);
});
