# Sessions view

The Sessions page lists recent sessions with their tool counts and cost. A user can filter by time range, run source, and status, and select a session to see its detail and any workflow runs under it.

## Sub-features

- `sessions-list` shows each session by its short id with its call count and cost.
- `sessions-range` filters by `Today`, `7 days`, `30 days`, and `All`.
- `sessions-filter` narrows the list through the `Run source filter` and `Status filter` groups.
- `sessions-select` shows the chosen session's detail, including `Usage by model` and its tools.

## How to get to it (user POV)

- Choose `Sessions` in the dashboard sidebar.
- Open `/sessions` directly.

## Driving it with pf-verify

Preconditions:

- `$PF up` has run and `$PF doctor` passes.
- One session has three hooks and one `turn` (the `SKILL.md` Drive block), and 5s have passed.

- **List.** Run `$PF shot /sessions sessions-list --expect "Sessions" --expect "${SID:0:8}"`. Both print `ok`.
- **Select.** Run `$PF shot /sessions sessions-select --click "${SID:0:8}" --expect "Usage by model" --expect "claude-sonnet-4-5-20250929"`. The detail pane shows the turn as 1.2k input, 300 output, 5.0k cache read, and $0.010, with Read, Bash, and Edit at 1 call each.
- **Range filter.** Run `$PF shot /sessions sessions-range --click "30 days" --expect "${SID:0:8}"`. The session stays listed.
- **Cross-check.** Run `$PF api /api/sessions`. The row for `<sid>` has `toolCallCount` 3.
- **Proof.** Keep the three PNG and text pairs plus the `/api/sessions` body.

## Gotchas

- Rows and the detail header use the first 8 characters of the session id. The cwd-derived `sessionName` appears only in the API.
- The first row is selected on load, so `sessions-select` also passes without `--click` when only one session exists. Seed two sessions to prove the click itself.
- The list page caps at 50 sessions server-side. A long-lived run dir can push a new session off the first page.
- `Status filter` values track workflow runs (`Running`, `Completed`, `Failed`, `Cancelled`), not plain sessions. A session with no workflow runs can disappear under a status filter.
- `--click` matches the first element containing the text. The short id appears in both the row and the detail header, so assert on detail content, not the id.
