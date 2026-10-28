---
'@newrelic/preflight': patch
---

**GitLab tokens are now redacted, and a token in a saved repository name no longer reaches the dashboard.** GitLab personal access tokens (`glpat-...`) are caught by the redaction patterns in logs, tool output and event fields. A `project_id` set through `NEW_RELIC_AI_PROJECT_ID` or the config file is redacted like `repo_url`. Session summaries saved by older versions can hold a repository name that starts with the remote's credentials (`<token>@github.com/widgets`). Preflight now drops that prefix whenever it loads a summary, so the dashboard and every metric derived from it show `github.com/widgets`. The saved file is not rewritten, so a token already on disk stays there until that session is saved again or you edit or delete its `repoName` field.
