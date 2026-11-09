# Hunting and proving findings

Both review skills use this file: `review-pr` on a teammate's PR, and `self-review` on your own branch, so an author catches what a reviewer would. The calling skill supplies:

- `$TREE`, the checkout whose files you read and where you run npm and node. For `review-pr` that's the review worktree. For `self-review` it's the author's own checkout.
- `$REV`, the commit under review: `refs/remotes/pr/<N>` for `review-pr`, or `HEAD` plus the working tree for `self-review`.
- `$BASE`, the merge base with `origin/main`.
- The claim: what the change says it fixes and how, in three sentences at most. Everything below is judged against it.

Run git from the session's own checkout and name commits (`git diff "$BASE...$REV"`, `git blame "$REV" -- <file>`), never with `git -C` or a `cd` into another tree. Every worktree shares the repository's refs. In the desktop app, a session isolated in a worktree has a hook that refuses git aimed at any other tree, and any command whose path it would have to compute: spell paths out, and read files with the Read tool or a plain `grep` on a literal path. Pass all of this on to every subagent.

A review full of plausible but unverified findings costs the author more time than it saves, so precision beats recall: drop a finding you cannot back up.

## 1. Design first

Read the full diff yourself first, starting with the file that carries the change and then its tests. You need the whole picture to judge findings later. Before any line-level work, answer two questions: should this change exist in this form, and is it in the right place? A wrong approach is the one finding worth raising alone and early. If it is, stop and report it before the lenses run. Line findings on code that will be rewritten waste everyone's time.

## 2. Lenses

Launch these subagents in one message. Give each one the claim, the diff range, `$TREE`, and this instruction: _read-only in `$TREE`; return candidates as `file:line — claim — why it matters — how to confirm it` with a command that confirms it, and leave out anything on lines the change did not touch unless the change makes it newly reachable._ Also give each lens the specific suspicions from your own read of the diff (for example, "find every producer of `repoName` and what values it can take"). Pointed questions find more than a generic lens.

1. **Correctness.** Logic errors, unhandled edge cases (empty, zero, NaN, missing fields, first or last item), ordering and concurrency between trackers and watchers, error paths that fail silently, and resource leaks. It must find and count each changed function's callers, and report the count as the blast radius. A bug usually lives where a changed function meets code that did not change. In this repo, one path often has several sources feeding it (transcript watcher, self-report, Copilot watchers, persisted checkpoints). It must check every source, not only the one the change is about.
2. **Repo rules.** Check the diff against every applicable section that [checklist.md](checklist.md) points to. Report only what the diff breaks, citing the file and section.
3. **Tests.** Does each new test go through the real path (`saveSession` → `loadSession` → seed, a real `HookEventProcessor` drain), or does it hand-build the state the bug lives in? Would the test fail on `main`? Which behaviour change in the diff has no test at all? To check "fails on `main`", it copies the test into a scratch worktree at `$BASE` (`git worktree add --detach <scratch path> "$BASE"` from the session's checkout, removed afterwards with `git worktree remove`), never into anyone's working tree, and never uses `git stash` (the stash stack is shared across worktrees).
4. **History.** `git log -L` and `git blame` on the changed regions, and especially on _removed_ lines: deleting a line that a `Fix #…` commit added is a red flag. Also check earlier PRs that touched the same files (`gh pr list --search "<path>" --state merged`) with their review comments. Look for an invariant an earlier fix established that this change undoes, or a reviewer concern from before that applies again.
5. **Claims.** Do the PR body, the changeset text, doc comments and docs (`docs/*.md`, `CLAUDE.md`) describe what the code now does? A doc comment that names one caller when three code paths reach it is a finding. So is a PR body that cites the wrong root cause.

Scale the number of subagents to the change. Each agent costs roughly 300k tokens.

- Under about 100 lines of non-test change, pair the lenses into three agents: Correctness; Repo rules + Tests; History + Claims.
- Over that, run all five, one lens each. A narrower brief per agent means fewer findings crowded out.
- For a delta of a few lines (a typical re-review) or a docs-only change, skip the subagents and work through the lenses yourself. Even so, check how the changed code meets callers it didn't change: a one-line regex fix can reopen a leak in every path that calls it.

Skip a lens that cannot apply. A docs-only change needs only Claims. Tell every subagent not to report readability, naming, logging tweaks, micro-performance or style unless a rule `checklist.md` points to covers it. Those are the findings authors most often reject.

Check that the lenses left `$TREE` alone. A subagent that edited it has contaminated every later reproduction. Before they start, `touch` a marker file under `/tmp`. When they return, list what changed since, with the paths spelled out:

```bash
(cd <TREE path> && find . -path ./node_modules -prune -o -path ./dist -prune -o -path ./.git -prune -o -type f -newer <marker> -print)
```

The list must be empty. This avoids `git status`, which the desktop hook refuses in a tree other than the session's own. Then merge duplicates (same location, same root cause). A finding that several lenses reached independently is more likely real, but still not proven.

## 3. Prove each candidate

This is the step that makes the review worth reading. LLM reviewers over-flag and overrate severity, so assume each candidate is wrong until shown otherwise.

- **One-command claims: reproduce them yourself.** If a candidate is a direct input → output fact ("`redactSensitive('acme/risk-assessment-pipeline-v2')` returns `acme/ri[REDACTED]`"), run it against the built `dist/` on the branch and against `$BASE`, then move on. The reproduction is the check.
- **Multi-step claims: check them independently first.** A claim that chains consequences ("this mismatch makes replay skip, so the dashboard loses commits") is where finders overreach. For each one, launch one subagent in parallel. Give it the candidate, `$TREE` and the diff range, but not the finder's reasoning. It restates the claim as a concrete trigger and outcome ("when X happens, Y is wrong because Z"), traces the path through the code, then argues the case that it is _not_ a bug. It returns `confirmed`, `refuted` (with the reason) or `unclear`. Many candidates fall apart at the restatement.
- **Reproduce the confirmed ones.** Write the smallest test or script that shows the wrong behaviour on the branch, run it, and run it on `$BASE` as well. Report numbers: "5 estimated turns then 1 self-report leaves $0.021; main gives $0.126". Standalone Jest probes against the built code suit suspected aggregation and double-counting bugs. Keep scratch tests out of the change (a scratch file you delete, or under `/tmp`).
- **User-visible surfaces** (dashboard, `/api/*`, hook capture, MCP tool output, token cost): use the `verify-preflight` skill against `$TREE` rather than reasoning about what the UI would show.
- **Test any fix you suggest the way you tested the bug.** A suggested fix is a claim too. Run it against a matrix of inputs: the case that was raised, the contexts the code really sees (for redaction, JSON-escaped, ANSI-coloured and percent-encoded text), and real formats close to the edge. Before trusting a pass, check that every case's marker actually appears in the input. A check that can't fail proves nothing, in your harness as much as in the author's tests.
- **Can't reproduce it?** Downgrade it to a question that states what you would expect. Never present an unreproduced bug as a bug.
- **Drop it** if it is pre-existing and not made worse, intended by the change, already caught by CI, or a style preference no repo rule backs.

## 4. Score and hold back

Score what is left:

- **Blocking:** wrong results, data loss, a security rule broken, a repo rule broken.
- **Non-blocking:** real but low impact, or a missing test.
- **Nit:** optional polish. At most three, and only if the user asks for them or the review is otherwise clean.

**Hold back** these, rather than raising them:

- nits, unless the user asked for them or the review is otherwise clean
- edge cases that need both a hypothetical user action and a fine point of third-party docs. Both conditions must hold. A routine lifecycle step whose effect the author already relies on still gets raised. For example, after `npm uninstall` a leftover hook blocks every tool call, which is exactly the failure the author's own guard exists for.
- findings that only say a doc comment overclaims, where nothing a user sees changes
- anything outside the diff. If it's real and substantial, the kind of thing that would be lost once the change merges, draft it as a follow-up issue instead.

List each held-back item in one line with its reason, so the user can promote it.
