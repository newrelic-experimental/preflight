/**
 * Deploy AI Coding Assistant dashboards to a New Relic account.
 *
 * Exposed as the `preflight deploy-dashboards` subcommand so users who
 * installed via `npm install -g` can run it without cloning the repo. The
 * dashboard JSON definitions are bundled into `dist/data/dashboards/` at build
 * time (see `package.json:build:server`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { normalizeDeveloperName } from '../config.js';
import { resolveDataDir } from './data-paths.js';

export const CREATE_MUTATION = `
mutation DashboardCreate($accountId: Int!, $dashboard: DashboardInput!) {
  dashboardCreate(accountId: $accountId, dashboard: $dashboard) {
    entityResult {
      guid
      name
    }
    errors {
      description
      type
    }
  }
}`;

export const UPDATE_MUTATION = `
mutation DashboardUpdate($guid: EntityGuid!, $dashboard: DashboardInput!) {
  dashboardUpdate(guid: $guid, dashboard: $dashboard) {
    entityResult {
      guid
      name
    }
    errors {
      description
      type
    }
  }
}`;

export const DELETE_MUTATION = `
mutation DashboardDelete($guid: EntityGuid!) {
  dashboardDelete(guid: $guid) {
    status
    errors {
      description
      type
    }
  }
}`;

export const FIND_DASHBOARD_QUERY = `
query FindDashboard($query: String!) {
  actor {
    entitySearch(query: $query) {
      results {
        entities {
          guid
          name
        }
      }
    }
  }
}`;

interface DashboardVariable {
  name: string;
  type: string;
  nrqlQuery?: { accountIds: number[]; query: string };
  defaultValues?: Array<{ value: { string: string } }>;
  [key: string]: unknown;
}

interface DashboardJson {
  name: string;
  description?: string;
  permissions?: string;
  variables?: DashboardVariable[];
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

export interface DashboardDeployOptions {
  readonly all: boolean;
  readonly update: boolean;
  readonly teardown: boolean;
  readonly print: boolean;
  readonly eu: boolean;
  readonly developer: string | null;
  readonly file: string | null;
  /**
   * Override the dashboards data dir. Used by tests so they can point at a
   * fixture directory instead of the bundled `dist/data/dashboards/`.
   */
  readonly dataDir?: string;
  /** Override the URL passed to fetch — used by tests with a mock. */
  readonly nerdgraphUrlOverride?: string;
  /** Injected fetch — used by tests to capture/stub HTTP calls. */
  readonly fetchImpl?: typeof fetch;
  /** Stream for stdout writes — defaults to process.stdout. */
  readonly stdout?: { write: (chunk: string) => boolean | void };
}

export function injectAccountId(dashboard: DashboardJson, accountId: number): DashboardJson {
  const copy: DashboardJson = JSON.parse(JSON.stringify(dashboard));
  for (const page of copy.pages) {
    for (const widget of page.widgets) {
      for (const nrqlQuery of widget.rawConfiguration.nrqlQueries ?? []) {
        nrqlQuery.accountIds = [accountId];
      }
    }
  }
  for (const variable of copy.variables ?? []) {
    if (variable.nrqlQuery) {
      variable.nrqlQuery.accountIds = [accountId];
    }
  }
  return copy;
}

export function injectDeveloperDefault(dashboard: DashboardJson, developer: string): void {
  if (!dashboard.variables) return;
  for (const variable of dashboard.variables) {
    if (variable.name === 'developer') {
      variable.defaultValues = [{ value: { string: developer } }];
      return;
    }
  }
}

async function nerdgraphRequest<T>(
  apiKey: string,
  url: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  const json = (await response.json()) as {
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

/** Escape a string for use in a Lucene query value (single-quoted). */
export function escapeLuceneValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findDashboardGuid(
  apiKey: string,
  url: string,
  accountId: number,
  name: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const result = await nerdgraphRequest<{
    actor?: { entitySearch?: { results?: { entities?: Array<{ guid: string; name: string }> } } };
  }>(
    apiKey,
    url,
    FIND_DASHBOARD_QUERY,
    {
      query: `type = 'DASHBOARD' AND name = '${escapeLuceneValue(name)}' AND accountId = ${accountId}`,
    },
    fetchImpl,
  );
  const entities = result.actor?.entitySearch?.results?.entities ?? [];
  return entities[0]?.guid ?? null;
}

function loadDashboard(dataDir: string, dashboardFile: string, accountId: number): DashboardJson {
  const dashboardPath = resolve(dataDir, dashboardFile);
  const prefix = dataDir.endsWith(sep) ? dataDir : dataDir + sep;
  if (!dashboardPath.startsWith(prefix) && dashboardPath !== dataDir) {
    throw new Error(`Dashboard file path escapes data directory: ${dashboardPath}`);
  }
  const raw = readFileSync(dashboardPath, 'utf-8');
  return injectAccountId(JSON.parse(raw) as DashboardJson, accountId);
}

interface OutputStream {
  write: (chunk: string) => boolean | void;
}

function printEntity(out: OutputStream, entity: { guid: string; name: string }): void {
  out.write(`  ✓ ${entity.name}\n`);
  out.write(`    GUID: ${entity.guid}\n`);
  out.write(`    URL:  https://one.newrelic.com/dashboards/detail/${entity.guid}\n`);
}

async function deployDashboard(
  apiKey: string,
  url: string,
  accountId: number,
  dataDir: string,
  dashboardFile: string,
  developerOverride: string | null,
  fetchImpl: typeof fetch,
  out: OutputStream,
): Promise<void> {
  const dashboard = loadDashboard(dataDir, dashboardFile, accountId);
  if (developerOverride) {
    const normalised = normalizeDeveloperName(developerOverride);
    injectDeveloperDefault(dashboard, normalised);
    out.write(`  Developer default set to: ${normalised}\n`);
  }
  out.write(`Deploying dashboard "${dashboard.name}" to account ${accountId}...\n`);

  const result = await nerdgraphRequest<{
    dashboardCreate?: {
      entityResult?: { guid: string; name: string } | null;
      errors?: Array<{ description: string; type: string }>;
    };
  }>(apiKey, url, CREATE_MUTATION, { accountId, dashboard }, fetchImpl);

  const createResult = result.dashboardCreate;
  if (createResult?.errors?.length) {
    throw new Error(`Dashboard creation errors: ${JSON.stringify(createResult.errors, null, 2)}`);
  }

  const entity = createResult?.entityResult;
  if (!entity) {
    throw new Error(
      `Unexpected response — no entity result returned: ${JSON.stringify(result, null, 2)}`,
    );
  }
  printEntity(out, entity);
}

async function updateDashboard(
  apiKey: string,
  url: string,
  accountId: number,
  dataDir: string,
  dashboardFile: string,
  developerOverride: string | null,
  fetchImpl: typeof fetch,
  out: OutputStream,
): Promise<void> {
  const dashboard = loadDashboard(dataDir, dashboardFile, accountId);
  if (developerOverride) {
    const normalised = normalizeDeveloperName(developerOverride);
    injectDeveloperDefault(dashboard, normalised);
    out.write(`  Developer default set to: ${normalised}\n`);
  }
  out.write(`Looking up "${dashboard.name}" in account ${accountId}...\n`);

  const guid = await findDashboardGuid(apiKey, url, accountId, dashboard.name, fetchImpl);
  if (!guid) {
    throw new Error(
      `No existing dashboard found with name "${dashboard.name}". Use deploy (without --update) to create it.`,
    );
  }
  out.write(`  Found GUID: ${guid}\n`);
  out.write(`  Updating...\n`);

  const result = await nerdgraphRequest<{
    dashboardUpdate?: {
      entityResult?: { guid: string; name: string } | null;
      errors?: Array<{ description: string; type: string }>;
    };
  }>(apiKey, url, UPDATE_MUTATION, { guid, dashboard }, fetchImpl);

  const updateResult = result.dashboardUpdate;
  if (updateResult?.errors?.length) {
    throw new Error(`Dashboard update errors: ${JSON.stringify(updateResult.errors, null, 2)}`);
  }

  const entity = updateResult?.entityResult;
  if (!entity) {
    throw new Error(
      `Unexpected response — no entity result returned: ${JSON.stringify(result, null, 2)}`,
    );
  }
  printEntity(out, entity);
}

async function teardownDashboard(
  apiKey: string,
  url: string,
  accountId: number,
  dataDir: string,
  dashboardFile: string,
  fetchImpl: typeof fetch,
  out: OutputStream,
): Promise<void> {
  const dashboardPath = resolve(dataDir, dashboardFile);
  const prefix = dataDir.endsWith(sep) ? dataDir : dataDir + sep;
  if (!dashboardPath.startsWith(prefix) && dashboardPath !== dataDir) {
    throw new Error(`Dashboard file path escapes data directory: ${dashboardPath}`);
  }
  const raw = readFileSync(dashboardPath, 'utf-8');
  const dashboard = JSON.parse(raw) as DashboardJson;

  out.write(`Looking up "${dashboard.name}" in account ${accountId}...\n`);
  const guid = await findDashboardGuid(apiKey, url, accountId, dashboard.name, fetchImpl);
  if (!guid) {
    out.write(`  No dashboard named "${dashboard.name}" found. Skipping.\n`);
    return;
  }
  out.write(`  Found GUID: ${guid}\n`);
  out.write(`  Deleting...\n`);

  const result = await nerdgraphRequest<{
    dashboardDelete?: {
      status?: string;
      errors?: Array<{ description: string; type: string }>;
    };
  }>(apiKey, url, DELETE_MUTATION, { guid }, fetchImpl);

  const deleteResult = result.dashboardDelete;
  if (deleteResult?.errors?.length) {
    throw new Error(`Dashboard deletion errors: ${JSON.stringify(deleteResult.errors, null, 2)}`);
  }

  out.write(`  ✓ Deleted "${dashboard.name}" (${deleteResult?.status ?? 'OK'})\n`);
}

function pickNerdgraphUrl(opts: DashboardDeployOptions): string {
  if (opts.nerdgraphUrlOverride) return opts.nerdgraphUrlOverride;
  if (opts.eu) return 'https://api.eu.newrelic.com/graphql';
  return 'https://api.newrelic.com/graphql';
}

/**
 * Run the deploy-dashboards command. Returns the exit code (0 = success,
 * non-zero = failure). Side effects: writes progress to stdout, makes HTTP
 * requests to NR's NerdGraph API.
 *
 * Reads `NEW_RELIC_API_KEY` and `NEW_RELIC_ACCOUNT_ID` from the environment
 * (mandatory for non-print modes; print mode only requires accountId).
 */
export async function runDeployDashboards(opts: DashboardDeployOptions): Promise<number> {
  const out: OutputStream = opts.stdout ?? process.stdout;
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;

  if (opts.teardown && (opts.print || opts.update)) {
    out.write('Error: --teardown is mutually exclusive with --print and --update.\n');
    return 1;
  }
  if (opts.print && opts.update) {
    out.write('Error: --print is mutually exclusive with --update.\n');
    return 1;
  }

  if (opts.eu) {
    out.write('Targeting EU API: https://api.eu.newrelic.com/graphql\n');
  }

  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!accountIdStr) {
    out.write('Error: NEW_RELIC_ACCOUNT_ID environment variable is required\n');
    return 1;
  }
  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId) || accountId <= 0 || String(accountId) !== accountIdStr.trim()) {
    out.write(`Error: NEW_RELIC_ACCOUNT_ID must be a positive integer, got: ${accountIdStr}\n`);
    return 1;
  }

  const dataDir = opts.dataDir ?? resolveDataDir('dashboards');
  const url = pickNerdgraphUrl(opts);

  const filesToProcess = opts.all
    ? readdirSync(dataDir)
        .filter((f: string) => f.endsWith('.json'))
        .sort()
    : [opts.file ?? 'ai-coding-assistant-overview.json'];

  if (opts.print) {
    for (const file of filesToProcess) {
      const raw = readFileSync(resolve(dataDir, file), 'utf-8');
      const dashboard = injectAccountId(JSON.parse(raw) as DashboardJson, accountId);
      if (opts.developer) {
        injectDeveloperDefault(dashboard, normalizeDeveloperName(opts.developer));
      }
      if (filesToProcess.length > 1) {
        out.write(`\n// ─── ${file} ───\n`);
      }
      out.write(`${JSON.stringify(dashboard, null, 2)}\n`);
    }
    return 0;
  }

  const apiKey = process.env.NEW_RELIC_API_KEY;
  if (!apiKey) {
    out.write(
      'Error: NEW_RELIC_API_KEY environment variable is required (User API key, not license key)\n',
    );
    out.write('       To print JSON for UI import instead, use --print (no API key needed)\n');
    return 1;
  }

  try {
    for (const file of filesToProcess) {
      if (opts.teardown) {
        await teardownDashboard(apiKey, url, accountId, dataDir, file, fetchImpl, out);
      } else if (opts.update) {
        await updateDashboard(
          apiKey,
          url,
          accountId,
          dataDir,
          file,
          opts.developer,
          fetchImpl,
          out,
        );
      } else {
        await deployDashboard(
          apiKey,
          url,
          accountId,
          dataDir,
          file,
          opts.developer,
          fetchImpl,
          out,
        );
      }
    }
  } catch (err) {
    out.write(`\nFailed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  out.write('\nDone.\n');
  return 0;
}
