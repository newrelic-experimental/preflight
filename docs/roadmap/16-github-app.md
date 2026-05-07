# Implementation Plan: GitHub App Integration

**Roadmap item:** [16 — GitHub App Integration](../../ROADMAP.md#16-github-app-integration)
**Effort estimate:** ~1 day
**Prerequisites:** Item 5 (CI/CD Integration) must be done — this plan imports from `nr-ai-cicd`.

---

## Goal

A `nr-ai-github-app` package that starts a webhook server. When a pull request is opened or updated, the server fetches AI coding metrics from New Relic and posts the report as a PR comment. This is a drop-in replacement for the GitHub Actions step in `nr-ai-cicd` for environments where Actions are disabled.

The entire report-generation logic lives in `nr-ai-cicd` and is reused unchanged. This package only adds the GitHub App trigger layer on top.

---

## Background reading

Before starting, read these files:

- `packages/nr-ai-cicd/src/metrics-fetcher.ts` — `fetchCurrentMetrics`, `fetchBaselineMetrics`, `SessionMetrics`, `BaselineMetrics`
- `packages/nr-ai-cicd/src/report-formatter.ts` — `formatReport`
- `packages/nr-ai-cicd/src/report-cli.ts` — shows how the above are wired together; the GitHub App handler follows the same logic
- `packages/nr-ai-cicd/package.json` — the new package mirrors this structure

---

## Step 1 — Create the package scaffold

### 1a — Directory structure

Create all files listed in the file checklist at the bottom of this document. Do not create any others.

### 1b — `packages/nr-ai-github-app/package.json`

```json
{
  "name": "nr-ai-github-app",
  "version": "0.1.0",
  "type": "module",
  "description": "GitHub App that posts AI coding cost reports on pull requests",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "nr-ai-github-app": "dist/index.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "test": "jest --passWithNoTests"
  },
  "dependencies": {
    "@octokit/app": "^15.0.0",
    "nr-ai-cicd": "*"
  },
  "devDependencies": {
    "@octokit/webhooks-types": "^7.0.0",
    "typescript": "^5.7.0"
  }
}
```

Note: `@octokit/webhooks-types` is a dev dependency only — used for TypeScript types on the webhook payload, not at runtime.

### 1c — `packages/nr-ai-github-app/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "test"],
  "references": [{ "path": "../nr-ai-cicd" }]
}
```

### 1d — Register in root `tsconfig.json`

Add `{ "path": "packages/nr-ai-github-app" }` to the `references` array in the root `tsconfig.json`.

---

## Step 2 — Config loader (`src/config.ts`)

Create `packages/nr-ai-github-app/src/config.ts`. This module reads all required env vars at startup and fails fast with a clear message if any are missing.

```typescript
export interface AppConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly newRelicApiKey: string;
  readonly newRelicAccountId: number;
  readonly reportHours: number;
  readonly failBelow: number | null;
  readonly port: number;
}

export function loadConfig(): AppConfig {
  const required: Record<string, string | undefined> = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    NEW_RELIC_API_KEY: process.env.NEW_RELIC_API_KEY,
    NEW_RELIC_ACCOUNT_ID: process.env.NEW_RELIC_ACCOUNT_ID,
  };

  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      process.stderr.write(`Error: ${key} environment variable is required\n`);
      process.exit(1);
    }
  }

  const accountId = parseInt(process.env.NEW_RELIC_ACCOUNT_ID!, 10);
  if (isNaN(accountId)) {
    process.stderr.write('Error: NEW_RELIC_ACCOUNT_ID must be a number\n');
    process.exit(1);
  }

  const failBelowStr = process.env.NR_AI_REPORT_FAIL_BELOW;
  const failBelow = failBelowStr ? parseFloat(failBelowStr) : null;

  return {
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
    newRelicApiKey: process.env.NEW_RELIC_API_KEY!,
    newRelicAccountId: accountId,
    reportHours: parseInt(process.env.NR_AI_REPORT_HOURS ?? '24', 10),
    failBelow,
    port: parseInt(process.env.PORT ?? '3000', 10),
  };
}
```

Note on `privateKey`: GitHub App private keys are stored with literal `\n` when set as env vars in most hosting platforms. The `.replace(/\\n/g, '\n')` converts them to real newlines that the PEM parser expects.

---

## Step 3 — PR handler (`src/pr-handler.ts`)

Create `packages/nr-ai-github-app/src/pr-handler.ts`. This is the core business logic. It receives a pull request payload and an already-authenticated `octokit` instance, runs the NR metric fetch, and posts the comment.

```typescript
import type { Octokit } from '@octokit/app';
import type { PullRequestEvent } from '@octokit/webhooks-types';
import { fetchCurrentMetrics, fetchBaselineMetrics } from 'nr-ai-cicd';
import { formatReport } from 'nr-ai-cicd';
import type { AppConfig } from './config.js';

export async function handlePullRequest(
  payload: PullRequestEvent,
  octokit: Octokit,
  config: AppConfig,
): Promise<void> {
  const developer = payload.pull_request.user.login;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const sha = payload.pull_request.head.sha;

  process.stderr.write(
    `PR #${prNumber} by ${developer} on ${owner}/${repo} — fetching metrics\n`,
  );

  const [current, baseline] = await Promise.all([
    fetchCurrentMetrics(config.newRelicApiKey, config.newRelicAccountId, developer, config.reportHours),
    fetchBaselineMetrics(config.newRelicApiKey, config.newRelicAccountId, developer),
  ]);

  const report = formatReport(current, baseline, config.reportHours, developer);

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: report,
  });

  process.stderr.write(`Posted report on PR #${prNumber}\n`);

  if (config.failBelow !== null && current.efficiencyScore !== null) {
    const state = current.efficiencyScore >= config.failBelow ? 'success' : 'failure';
    const description =
      state === 'success'
        ? `Efficiency score ${current.efficiencyScore.toFixed(1)} ≥ ${config.failBelow}`
        : `Efficiency score ${current.efficiencyScore.toFixed(1)} < ${config.failBelow}`;

    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description,
      context: 'nr-ai-observatory / efficiency',
    });

    process.stderr.write(`Set commit status: ${state} (${description})\n`);
  }
}
```

Key points:
- `developer` is taken from `payload.pull_request.user.login` (the GitHub username). This matches the value logged by `report-cli.ts` when `GITHUB_ACTOR` env var is set, so the same NR data is queried.
- The optional `failBelow` gate sets a GitHub commit status check on the PR's head SHA so it blocks merge when configured.
- All errors propagate up to the webhook handler in `server.ts`, which logs them.

---

## Step 4 — Webhook server (`src/server.ts`)

Create `packages/nr-ai-github-app/src/server.ts`. This module creates the `@octokit/app` `App` instance, registers the pull request event handlers, and returns the Node.js HTTP server.

```typescript
import { createServer } from 'node:http';
import { App, createNodeMiddleware } from '@octokit/app';
import { handlePullRequest } from './pr-handler.js';
import type { AppConfig } from './config.js';

export function createWebhookServer(config: AppConfig): ReturnType<typeof createServer> {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhooks: {
      secret: config.webhookSecret,
    },
  });

  app.webhooks.on('pull_request.opened', async ({ payload, octokit }) => {
    await handlePullRequest(payload, octokit, config);
  });

  app.webhooks.on('pull_request.synchronize', async ({ payload, octokit }) => {
    await handlePullRequest(payload, octokit, config);
  });

  app.webhooks.onError((error) => {
    process.stderr.write(`Webhook error: ${error.message}\n`);
  });

  return createServer(createNodeMiddleware(app));
}
```

`createNodeMiddleware(app)` from `@octokit/app` handles:
- Routing `POST /api/github/webhooks` requests to the registered handlers
- Verifying the `X-Hub-Signature-256` header using `webhookSecret`
- Returning `200 OK` on success or `500` on error
- Returning `404` for all other routes

---

## Step 5 — Entry point (`src/index.ts`)

Create `packages/nr-ai-github-app/src/index.ts`. This is the CLI entry point and the module's public export.

```typescript
#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createWebhookServer } from './server.js';

const config = loadConfig();
const server = createWebhookServer(config);

server.listen(config.port, () => {
  process.stderr.write(
    `nr-ai-github-app listening on port ${config.port}\n` +
    `Webhook endpoint: POST /api/github/webhooks\n`,
  );
});
```

This file has no re-exports — the package is a runnable binary, not a library.

---

## Step 6 — GitHub App setup instructions (`README.md`)

Create `packages/nr-ai-github-app/README.md` with the following content. This is the only markdown file to create; it documents the one-time GitHub App registration steps that cannot be automated.

```markdown
# nr-ai-github-app

Posts AI coding cost and efficiency reports on pull requests. Runs as a webhook server — no GitHub Actions required.

## Setup

### 1. Register the GitHub App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (or the enterprise equivalent).

Required settings:
- **Webhook URL**: `https://your-server.example.com/api/github/webhooks`
- **Webhook secret**: generate a random string and save it as `GITHUB_WEBHOOK_SECRET`
- **Repository permissions**:
  - Issues: Read & write (for posting PR comments)
  - Commit statuses: Read & write (optional — only needed for quality gate)
  - Pull requests: Read-only (for receiving PR events)
- **Subscribe to events**: Pull request

After creating the app, note the **App ID** and generate a **Private key** (downloads as a `.pem` file).

### 2. Install the app on your repository

From the GitHub App page, click **Install App** and select the repositories you want to monitor.

### 3. Configure environment variables

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-secret
NEW_RELIC_API_KEY=your-nr-api-key
NEW_RELIC_ACCOUNT_ID=your-account-id
NR_AI_REPORT_HOURS=24          # optional, default 24
NR_AI_REPORT_FAIL_BELOW=40     # optional quality gate — sets commit status
PORT=3000                      # optional, default 3000
```

When setting `GITHUB_APP_PRIVATE_KEY` in hosting platforms, replace real newlines with `\n`.

### 4. Start the server

```
npx nr-ai-github-app
```

Or build and run directly:

```
npm run build
node dist/index.js
```
```

---

## Step 7 — Wire into the monorepo build

After creating all source files, register the new package in the root `tsconfig.json` (Step 1d above). Then verify the build succeeds:

```bash
npx tsc -b packages/nr-ai-cicd && npx tsc -b packages/nr-ai-github-app
```

This must produce no TypeScript errors before the task is considered complete.

---

## Acceptance criteria

- [ ] `packages/nr-ai-github-app/` exists with all files in the file checklist below
- [ ] `npm run build` passes (no TypeScript errors for the new package)
- [ ] `npm test` passes (`--passWithNoTests` so no tests required)
- [ ] `npm run lint` passes (0 errors, 0 warnings)
- [ ] `loadConfig()` calls `process.exit(1)` when any required env var is missing
- [ ] `privateKey` correctly converts `\\n` literals to real newlines
- [ ] `handlePullRequest` calls `fetchCurrentMetrics`, `fetchBaselineMetrics`, and `formatReport` from `nr-ai-cicd` — not reimplemented
- [ ] `handlePullRequest` posts exactly one PR comment via `octokit.rest.issues.createComment`
- [ ] When `failBelow` is set and `efficiencyScore` is non-null, `handlePullRequest` calls `octokit.rest.repos.createCommitStatus` with `state: 'success'` or `state: 'failure'`
- [ ] When `failBelow` is null or `efficiencyScore` is null, no commit status is set
- [ ] `createWebhookServer` registers handlers for both `pull_request.opened` and `pull_request.synchronize`
- [ ] Root `tsconfig.json` references the new package
- [ ] `packages/nr-ai-github-app/README.md` exists and documents the GitHub App registration steps

---

## File checklist

Files to **create**:

```
packages/nr-ai-github-app/package.json
packages/nr-ai-github-app/tsconfig.json
packages/nr-ai-github-app/src/config.ts
packages/nr-ai-github-app/src/pr-handler.ts
packages/nr-ai-github-app/src/server.ts
packages/nr-ai-github-app/src/index.ts
packages/nr-ai-github-app/README.md
```

Files to **modify**:

```
tsconfig.json   — add { "path": "packages/nr-ai-github-app" } to references array
```
