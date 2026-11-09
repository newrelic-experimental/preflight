---
name: self-review
description: Review your own Preflight branch the way a reviewer would, before opening a PR or marking a draft ready. States what the branch claims to fix, runs the repo checks the diff calls for, hunts for defects with the same lenses and proof rules as review-pr (subagents that never see this session's reasoning), fixes confirmed blocking findings with a regression test, and drafts a PR body whose test plan lists only what actually ran. Use when the user says "self-review", before `gh pr create`, before marking a draft ready for review, or after addressing review feedback. Not for someone else's PR (use review-pr).
argument-hint: '[PR number, if one is open]'
---

# Self-review a branch

You are the author's second pair of eyes. Every blocker a reviewer finds that the author could have found costs a round trip, so review the change the way `review-pr` reviews a teammate's, with the same lenses and the same proof rules, and leave the PR with the evidence a reviewer will ask for.

- **The bar** is `CONTRIBUTING.md` § Reviewing pull requests, the same one the reviewer uses.
- **You may change the author's checkout**, but only to fix confirmed blocking findings (step 5). Everything else you list for the author.
- **A person writes and posts every comment and reply.** You never post, reply, resolve a thread, or mark a PR ready for review. You open a PR only when the user asks, and always as a draft.
- **This session is anchored on its own reasoning**, since it likely wrote the change. The lens subagents get the diff and the claim, never that reasoning, so they read the change fresh.

Some steps use tools only the Claude desktop app has, such as the file pane (`mcp__ccd_view__show_pane`). Use them when they're available. Otherwise print the path.

`$TREE` and `$BASE` below are placeholders. Each Bash call starts a fresh shell, so a variable set in one call is empty in the next: write the literal path and sha into every command.

## 1. Scope the change

```bash
TREE=$(git rev-parse --show-toplevel)
git fetch origin main
BASE=$(git merge-base origin/main HEAD)
git status --short
git diff --stat "$BASE"
```

- **The diff under review** is `git diff "$BASE"`: the branch's commits plus uncommitted changes. Untracked files (`??` in `git status`) count too, but `git diff` leaves them out, so list their paths alongside the diff wherever this skill passes the diff on. A new file nobody added is also easy to leave out of the PR.
- **Write the claim:** what the branch fixes or adds, and how, in three sentences at most. Take it from the linked issue and the commits, then check it against the diff. It becomes the PR's Summary, and it's the claim [lenses.md](../review-pr/lenses.md) judges everything against. If it won't fit in three sentences, the branch probably does more than one thing.
- **One logical change.** Unrelated edits, such as a drive-by refactor or a second fix, belong on their own branch. Past roughly 400 changed lines of non-test code, propose a split to the user before going on.
- **Staleness.** `git log --oneline HEAD..origin/main` lists what `main` has that the branch doesn't. If that touches the same files, suggest merging `main` first (the user's call) and reviewing the result, since otherwise you're checking code that won't be what merges. Also check whether `main` already fixed the same thing.
- **An open PR.** If the branch already has one (`gh pr view --json number,body,reviews`, or the user gave its number), read its body and review threads first. If it has threads, step 8 applies too.

## 2. Design gate

Answer the two questions in [lenses.md](../review-pr/lenses.md) § 1 about your own change: should it exist in this form, and is it in the right place?

Then look for recurrence. `git log --oneline origin/main --grep "<the bug's key words>"` and `git log -L` on the changed function show whether this class of bug has been fixed before. If this is the second or third fix of the same class, the change is probably patching a symptom. Say so to the user, and ask whether a structural fix should come first or as a follow-up. For example, dozens of commits on `main` each fix one way cost or tokens got counted twice.

If the approach is wrong, stop and tell the user. Don't polish code that should be rewritten.

## 3. Run the repo's checks

Go through every item in `CONTRIBUTING.md` § Before opening a PR, and run each one whose condition the diff meets. That list is the authority. The usual triggers are:

- always: `npm run build`, `npm test`, `npm run lint`, `npm run format:check`, and the lockfile check (`npm install --package-lock-only` leaves `package-lock.json` unchanged unless you changed dependencies)
- `src/web` → `npm run test:web` and `npx tsc -p tsconfig.web.json`, plus `npm run test:e2e` for a dashboard UI change
- `scripts/`, `e2e/` or a root `*.config.ts` → `npx tsc -p tsconfig.tools.json`
- a script under `.claude/skills/` → `npm run lint:shell`
- an added, moved or renamed test file, or a change to `jest.config.ts`, `vitest.config.ts` or a `test:*` script → `npm run check:test-ownership`
- a test using local-time APIs → `npm run check:tz-tests`

Start the long ones as background commands and keep going.

Record each command with its actual result. A check you didn't run is "not run", never "passes". These records become the PR's test plan (step 7). A failure is a blocking finding for step 5, unless it also fails on `$BASE`. In that case it's pre-existing: note it and move on.

## 4. Hunt and prove

Follow [lenses.md](../review-pr/lenses.md) with `TREE`, `REV` set to `HEAD` plus the working tree, `BASE`, the claim from step 1, and the diff `git diff "$BASE"` plus the paths of any untracked files. Give each lens subagent the diff and the claim, never this session's reasoning or plan, and tell it to judge the change as a reviewer would. There are two additions for your own change:

- **Claims** also covers what you're about to publish: the PR body draft, the changeset, and any doc you changed. A reviewer reads those first.
- **Tests** checks that every behaviour change has a test that fails on `$BASE`. You can run that check, so run it rather than infer it.

## 5. Fix what's blocking

For each candidate that [lenses.md](../review-pr/lenses.md) § 3 confirmed and § 4 scored blocking:

1. Write the regression test first, and show it failing: on the branch for a bug the branch introduced, or on `$BASE` for a bug the branch exists to fix.
2. Fix the code, and show the test passing.
3. Rerun the step 3 checks the fix touches.
4. Check the neighbouring cases the fix should cover too, the way [lenses.md](../review-pr/lenses.md) § 3 tests a suggested fix. A fix that covers the reported case and misses its neighbour is what reviewers most often find after a "fixed".

Leave fixes uncommitted unless the user asked you to commit, so they see each one in the diff. If a fix grows past the change's scope, stop and ask instead.

List the rest for the author rather than fixing it:

- non-blocking findings and nits, one line each, with the fix you'd suggest
- questions a reviewer would ask, answered in the PR body draft where you can
- anything outside the diff, as a follow-up issue draft

## 6. Evidence

- **User-visible change** (dashboard, `/api/*`, hook capture, MCP tool output, token cost): prove it with the `verify-preflight` skill against `$TREE`, and keep the evidence paths it prints. A UI change gets a screenshot in the PR body.
- **Changeset.** Check it against the Always section of [checklist.md](../review-pr/checklist.md): present if a shipped file changed, the right bump, and an entry written for someone who uses Preflight. Draft or fix it in the working tree. Never touch the version or `CHANGELOG.md`.

## 7. Report and PR body

Write `.claude/reviews/self-review-<branch>.md` in `$TREE`, with any `/` in the branch name replaced by `-` (`.claude/*` is gitignored). Open it with the file pane if there is one, otherwise print its path. It has:

1. **Verdict**, on the first line: "Ready for a human to read", or "Not ready:" followed by the blocking items left.
2. **Fixed**: each blocking finding you fixed, one line each, with the test that now covers it.
3. **For the author**: the non-blocking findings, nits, questions and follow-up issue drafts from step 5.
4. **Not checked**: what you skipped or couldn't assess, each with its reason.
5. **PR body draft**, in the shape `CLAUDE.md` § Pull Requests asks for:
   - **Summary**: the claim from step 1, as bullets.
   - **Test plan**: a checklist. Tick only what ran and passed, naming the command. Leave the rest unticked with the reason ("not run: needs a Copilot install").
   - **Known limitations** and deferrals, if any, so a reviewer doesn't rediscover them.

If the user asked you to open the PR, do it once they've seen the report, as a draft with that body (`gh pr create --draft`, per `CONTRIBUTING.md` § AI-authored pull requests). If a PR is already open, give the user the new body to paste, and edit it yourself only if they ask. Never mark a PR ready for review: a person does that once they've read, proofread and tested the change.

## 8. After review feedback

When a reviewer has left threads on the PR:

1. Fetch them: `gh api repos/newrelic-experimental/preflight/pulls/<N>/comments --paginate`, and the reviews.
2. Decide with the user which ones change the code. Handle each code change the way step 5 handles a fix, test first and neighbours too, before calling it fixed. The reviewer will check the neighbours.
3. Run steps 3–6 again on what changed since the review.
4. Draft a reply per thread for the user to post: what changed and how it was checked ("Fixed in abc123, and added a test for the empty-list case too"), or why the code stays as it is. Never post a reply yourself.
