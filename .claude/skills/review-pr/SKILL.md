---
name: review-pr
description: Review a teammate's or contributor's Preflight pull request with the user. Gathers the PR's intent and history, checks out the branch in its own worktree, hunts for defects with parallel subagents, reproduces every finding against the branch before raising it, checks the repo's written rules, and drafts inline comments for the user to edit and post. It only drafts and never writes to GitHub. Afterwards it watches the PR in the background and tells the user when the author pushes, replies or re-requests review. Use when the user says "review PR 123", pastes a newrelic-experimental/preflight PR URL, or asks for a re-review after the author pushed fixes. Not for your own branch (use self-review) or for proving a change on Preflight's real surfaces (use verify-preflight).
argument-hint: '<PR number or URL> [re-review]'
---

# Review a pull request

You partner with the user, the human reviewer, to evaluate a change someone else submitted, the way a pragmatic principal engineer would.

- **The bar is the team's.** Read `CONTRIBUTING.md` § Reviewing pull requests before the first review in a session. In short: approve once the PR improves the code overall, even if it isn't perfect; look at the design before the lines; label anything that isn't blocking.
- **A person writes and posts every comment.** You draft. You never write to GitHub (step 6).
- **Precision beats recall.** [lenses.md](lenses.md) says how to find and prove each finding.

Repo: `newrelic-experimental/preflight`. Run `gh` with `-R newrelic-experimental/preflight`.

Some steps use tools only the Claude desktop app has: a file pane (`mcp__ccd_view__show_pane`), a wrap-up question with buttons, and a browser pane (`mcp__Claude_Browser__*`). Use them when they're available. Otherwise print the path or URL, and ask your question in plain text.

## 1. Read the PR before the diff

```bash
gh pr view <N> -R newrelic-experimental/preflight --json number,title,body,author,isCrossRepository,baseRefName,headRefName,headRefOid,isDraft,state,additions,deletions,changedFiles,closingIssuesReferences,statusCheckRollup,reviews,labels,assignees,url
gh pr view <N> -R newrelic-experimental/preflight --comments
```

- Stop and tell the user if the PR is closed, merged, bot-authored (`author.is_bot`, such as the release PR), or a draft they did not ask about.
- Determine the apparent intent or problem being solved.
  - Read every linked issue (`gh issue view`). Write the user a summary of what the PR claims to fix and how, in three sentences at most, before you look at code. This is the claim [lenses.md](lenses.md) judges everything against.
- Check that the PR shows its own evidence, such as a test plan that was run, a repro, a screenshot for UI changes. Missing evidence for a behaviour change becomes a question asking how it was verified.
- Note CI state. Do not report what CI already reports (lint, format, type errors, failing tests). If CI is red, say so in one line and move on. If a check didn't run (fork PRs get no secrets), run it locally in step 2.
- **Read the existing reviews in full**, human and bot (`gh api repos/newrelic-experimental/preflight/pulls/<N>/reviews` and `.../pulls/<N>/comments --paginate`). A reviewer's own runtime testing can catch what a diff-only read misses. Treat every claim in them as an unverified candidate for [lenses.md](lenses.md) § 3. Never raise a finding because someone else asserted it, and credit the reviewer by name when one holds.
- Size: past roughly 400 changed lines of non-test code, tell the user the review will be shallower per line and ask whether the PR should be split. Keep going unless they say stop.
- Set `WATCH=<this skill's base directory>/scripts/watch-pr`. A re-review first reads the head you reviewed last time with `"$WATCH" reviewed <N>`. Then every review, first or not, records its starting point with `"$WATCH" snapshot <N> <headRefOid>`, so step 7 reports only what happens after this point.
- **Re-review** (the user said so, they already have a review on this PR, or step 7 woke you): fetch their earlier threads with `gh api repos/newrelic-experimental/preflight/pulls/<N>/comments --paginate`, then review only what changed since their last review (after step 2's fetch, `git diff <last-reviewed-sha>.."$PR"`, using the sha from `watch-pr reviewed`, or the commit of their last review if there's no snapshot). If the review worktree from last time still exists, move it to the new head by removing it (`git worktree remove --force <WT path>`) and adding it again in step 2. Moving it in place would need git inside it. For each earlier thread, check that the reply's claim ("fixed in abc123") is true in the code. Replies are often right about the case raised and wrong about a neighbouring one.
  - Aim to keep new feedback to what the new commits changed or made newly reachable.

### Triage

- **Tracking issue.** Look for `Fixes #N`, `Closes #N` or `Resolves #N` in the title and body, and check that the issue exists and fits with `gh issue view`. With none, search first (`gh issue list --search "<keywords>" --state all`). If there's still none, draft one for the user: a title and a body written as if reported independently of the PR.
- **Labels and assignee.** If the PR or its issue has no label or no assignee, suggest them. Pick labels only from `gh label list -R newrelic-experimental/preflight`, never a new one: a fix is `bug`, a new capability `enhancement`, docs only `documentation`. The assignee is normally the PR's author.
- **External authors** (`gh api repos/newrelic-experimental/preflight/pulls/<N> --jq .author_association` is not `OWNER`, `MEMBER` or `COLLABORATOR`): before the code, check that the change is something the project takes (`CONTRIBUTING.md`, the README's scope) and isn't a duplicate (`gh pr list --state all --search "<keywords>"` for overlapping work merged or in flight). If it doesn't fit or is a duplicate, stop and tell the user why. A code review of a change that won't merge wastes the contributor's time.

All of this goes in the draft (step 5). The user applies whatever they agree with.

## 2. Check out the branch in its own worktree

Never review in the user's main checkout or switch its branch.

```bash
git fetch origin "pull/<N>/head:refs/remotes/pr/<N>" main
PR=refs/remotes/pr/<N>
BASE=$(git merge-base origin/main "$PR")
git diff --stat "$BASE...$PR"
git rev-parse --path-format=absolute --git-common-dir   # the repo's .git; its parent is the main checkout
git worktree add --detach <main checkout>/.claude/worktrees/review-pr-<N> "$PR"
```

`pull/<N>/head` works for fork PRs too. Call the new worktree `$WT`, but spell out its absolute path in the commands you run instead of computing it.

**Run git from this session's own checkout, and name the PR by `$PR`.** Every worktree shares the repository's refs, so these work from anywhere:

- `git diff "$BASE...$PR"`
- `git log -L … "$PR"`
- `git blame "$PR" -- <file>`
- `git show "$PR":<file>`

Use `$WT` only to read the PR's files and to run npm and node. Never run `git -C "$WT"`, or `cd` into `$WT` and then git. In the desktop app, a session isolated in its own worktree may run git only against that worktree. Its hook refuses those forms, as well as any command whose path it would have to compute or that it can't prove isn't git, including a script that only mentions git. Read `$WT`'s files with the Read tool or a plain `grep` on a literal path, and tell every subagent the same.

Then start `(cd <WT path> && npm ci && npm run build)` as a background command (it takes a minute or two) and read the diff while it runs. Run any check CI skipped there too, and report its actual result.

**Staleness.** `git log --oneline "$PR..origin/main"` lists what `main` has that the branch doesn't. If that's a lot, or touches the same files, say the branch needs a merge. Also check whether `main` already fixes the same bug some other way, which would make the PR a no-op. For a PR "stacked on" one that already merged, isolate its own commits by range instead of trusting the raw diff.

**Never use a bare `cd`**, into `$WT` or anywhere else (the skill directory, `/tmp`). In Claude Code a plain `cd` moves the session's working directory.

- Into `$WT`, worktree hooks then block every edit outside it, including the user's own worktree.
- Anywhere else, the session leaves its own checkout, and the app may refuse to move it back.

Use absolute paths and subshells like `(cd <WT path> && …)`.

Keep the worktree until the PR merges or closes (step 7), since a re-review needs it. Remove it then with `git worktree remove <WT path>`, run from this session's checkout.

## 3. Hunt and prove

Follow [lenses.md](lenses.md) with `TREE` set to `$WT`, `REV` set to `$PR`, `$BASE`, the claim from step 1, and the diff range `$BASE...$PR` (or the re-review range). It covers the design question, the lens subagents, proving each candidate, scoring, and what to hold back.

If the design question finds a wrong approach, stop there: draft that one comment and ask the user whether to continue.

## 4. Changeset and follow-ups

- **Changeset.** [checklist.md](checklist.md) points to the rules: a PR that changes a shipped file needs a `.changeset/*.md`, and no PR bumps the version or edits released `CHANGELOG.md` entries. CI checks that a changeset exists, not its bump level or wording, so check both. If one is missing, draft it in the review (don't commit it to the author's branch).
- **Follow-ups.** Note anything real that surfaces but doesn't belong in this PR, from two sources: the PR's own deferrals ("known limitation", "separate fix", "not addressing X here"), and out-of-scope problems you found. Only substantial items qualify, the kind that would be lost once the PR merges. Don't ask the author to fix them in this PR.

## 5. Draft the review

Write the drafts to `.claude/reviews/preflight-pr-<N>.md` (or `preflight-pr-<N>-rereview.md`) inside **this session's own checkout**, the repo or worktree the session runs in. `.claude/*` in `.gitignore` keeps them out of git. Don't write into `$WT` or another worktree: worktree hooks block it. Open the draft with the file pane if the session has one (`mcp__ccd_view__show_pane`, pane `file`), and link it with a path relative to the session's working directory. Use [comment-style.md](comment-style.md). The draft has:

1. **Summary for the user** (not for posting), under about 15 lines.
   - What the PR does, and your verdict (approve / comment / request changes) with one line of reasoning.
   - The bar for approval is that the PR improves the code overall, not that it is perfect.
   - The verdict follows the labels: if every drafted comment is `Non-blocking:`, a question, or a nit, recommend **Approve**. Recommend **Comment** only when an open question could turn out to be blocking, and name it.
2. **Postable set**: the inline comments you expect the user to post as written, ranked. Aim for three to five, merging findings that share a reply (see comment-style.md).
   - Write each as one block with `path`, `line` (a line on the diff's right side, or line 1 of the main file for a comment that spans files; add `start_line` for a range) and the comment body.
3. **Review body**: empty for an Approve unless one line adds something. Otherwise name the blocking items. See comment-style.md.
4. **Triage and changeset**: the tracking-issue draft, suggested labels and assignee, the external-author checks, the changeset verdict (or the drafted file), and the results of any check you ran locally (failures verbatim).
5. **Follow-up issue drafts**: for each, a title and a body written as if reported independently, ending with "Surfaced during review of #<N>".
6. **Held back and not checked**, at the end:
   - The held-back items from [lenses.md](lenses.md) § 4, one line each.
   - The findings you dropped while proving them, one line each, so the user can overrule you.
   - A **Not checked** list of what you deliberately left out or could not assess, each with its reason: files you only skimmed, paths you could not reproduce, areas needing knowledge you lack.

## 6. The user posts. You never write to GitHub

Every comment on a PR is written and posted by a person. Never post, submit, approve, request changes, reply to a thread, react, resolve a conversation, or edit anything on GitHub. That includes metadata: never create an issue, set a label or assignee, or edit the PR body. Never ask whether to do any of that, and never offer a button or question that would. Whatever the review finds, the hand-off is the draft file. Mark each inline comment's anchor (`path`, right-side `line`, or a range) so the user can place it. If a comment's line is outside the diff, say so in the draft: GitHub won't accept an inline comment there, so it belongs in the review body.

If the user mentions posting later and the head has moved since you reviewed, tell them which findings the new commits touch, so they can check those before posting.

## 7. Track the PR until it needs you again

Once the drafts are in the user's hands (step 5), start the watcher as a **background** Bash command (`run_in_background: true`) and tell the user in one line that you'll let them know when the author replies or pushes:

```bash
"$WATCH" wait <N>
```

It needs `bash`, `gh` and `jq`. It polls every 5 minutes (four `gh api` calls, no model tokens) and exits only when something is new since the snapshot: new commits (including a force-push), a comment or review from someone other than the user or a bot, a review re-request, or the PR closing or merging. It waits for 10 minutes of quiet before reporting, so a burst of pushes and replies is one alert. A re-request or a close or merge is reported at once. When it exits, this session wakes with its output.

When it wakes you:

- **Exit 0 (news).** Tell the user what changed in a few lines: commits by subject, replies to their threads (and whether each reply claims a fix), new comments from others, re-requests. Don't paste the raw output. Say whether a re-review looks due: the author pushed and replied, or re-requested. Ask the user whether to re-review now. Never start one unasked. Unless the PR merged or closed, re-arm the watcher in the same turn with another background `"$WATCH" wait <N>`. It picks up from what it just reported, and a re-review's new snapshot moves its baseline too.
- **Merged or closed.** Report it, don't re-arm, and offer to remove the review worktree.
- **Exit 4** (nothing new for 7 days), **exit 2** (repeated `gh` failures, usually auth or network). Say so in one line and offer to restart it.
- **Exit 5.** Another session is already watching this PR, so there's nothing to do.

Tracking lasts only as long as this session is running. Ending or archiving the session, or quitting the app, stops it. To pick it up again, run `"$WATCH" check <N>` once, which reports anything missed since the last snapshot, then re-arm `wait`.

**Attaching to a review that predates the watcher** (no snapshot, or the session started before step 7 existed): get the user's last review on the PR (`gh api repos/newrelic-experimental/preflight/pulls/<N>/reviews`, last entry by `gh api user --jq .login`). Then run `"$WATCH" snapshot <N> <its commit_id> <its submitted_at>` and `"$WATCH" check <N>`, which reports every commit and comment since that review. Finally re-arm `wait`. Skip PRs that have merged or closed. State lives in `~/.claude/review-pr-watch/` (mode 0600).

## 8. Retro: learn from what the user actually posted

Run this when the user asks for a retro, or offer it once their review shows up on the PR. It measures how far the draft was from what the user posted and turns that gap into skill edits. It never edits the skill unasked.

Each reviewer can keep a personal overlay in `~/.claude/review-pr/`:

- `comment-style.md` holds their own voice. It's read after the team's [comment-style.md](comment-style.md) and wins where the two disagree.
- `retro-log.md` lists edits they rejected, with their reasons.

1. **Fetch what was posted.**
   - `gh api repos/newrelic-experimental/preflight/pulls/<N>/reviews` and `.../pulls/<N>/comments --paginate`, filtered to `gh api user --jq .login`: state, body, path, line, `pull_request_review_id`.
   - Also check `.../issues/<N>/comments` for any top-level comment.
2. **Pair each posted comment with its draft** and classify it: verbatim, reworded, merged, split, anchor moved, added (no draft existed), or dropped (draft never posted). Do the same for the verdict and the review body.
3. **Explain each difference with a hypothesis tied to evidence**, not a guess at taste. Name what the change suggests:
   - what the author already knows (they wrote the code or doc it explains)
   - how surprising the claim was (evidence kept vs. cut)
   - scope (outside the diff, or a hypothetical case)
   - tone (labels, voice, prescriptive vs. suggestive, citations)
   - volume (how many drafted comments were posted, and how long each was)
   - verdict calibration
4. **Check the hypotheses against history.** Sample the user's last 5–10 reviews on others' PRs (`gh pr list -R newrelic-experimental/preflight --state all --search "reviewed-by:<login> -author:<login>"`), including their inline comments. Keep a pattern only if it recurs or the user confirms it. One review is a hint, not a rule.
5. **Separate skill gaps from execution misses.** If the skill already had the rule and the draft broke it, call that an execution miss, and propose a structural change that makes the rule hard to break rather than a duplicate rule.
6. **Decide where each edit belongs.**
   - Taste and tone that are this reviewer's own go to their overlay.
   - Practice the whole team should follow goes in this skill's files: tone in [comment-style.md](comment-style.md), process in this file or [lenses.md](lenses.md), and repo rules in the doc [checklist.md](checklist.md) points to (not in the checklist itself).
   - Prefer changing an existing rule to adding a new one.
7. **Propose edits as a real diff.**
   - Copy the files you'd change into `.claude/reviews/skill-proposal/` in this session's checkout and edit the copies. Overlay files go in a `personal/` subdirectory there.
   - Write `diff -u` against the originals to `.claude/reviews/preflight-pr-<N>-retro.diff`, with the reasoning in `preflight-pr-<N>-retro.md`, and open the reasoning file for the user.
   - Show the edits to the user as a word-level diff with highlighting, never as raw `[-…-]{+…+}` markers. From the root of this session's checkout, with `npm ci` done, start `npx tsx scripts/word-diff.ts serve <this skill's base directory> .claude/reviews/skill-proposal --labels .claude/reviews/skill-proposal/.labels.json --title "PR <N> retro: proposed skill edits"` as a background command. Read the port from its `word-diff: serving http://127.0.0.1:<port>/` line. Open that URL in the browser pane if there is one (`mcp__Claude_Browser__preview_start`); otherwise give the user the URL.
     - `.labels.json` tags each edit with the number the reasoning file uses: `[{"label": "Edit 2", "match": "<text unique to that edit>"}]`. Labels match on text, so they survive line shifts. A label is only the edit's number: put recommendations, evidence and caveats in the chat and the reasoning file, never on the page.
     - The page reloads itself whenever a proposal copy or the labels file changes. So as the user asks for revisions, edit the copies and the page follows; regenerate the `.diff` file too.
     - Stop the server once the user has approved or rejected every edit.
   - In the reasoning file, number each edit and tag it with its evidence: how many reviews show the pattern, and which ones. A rule backed by a single instance is marked as such, so the user can weigh it before approving.
   - If you can't tell whether a change in the posted review was deliberate (an anchor move, one dropped word), ask the user before turning it into a rule.
8. **Apply nothing until the user approves each edit**, then apply only the approved edits.
   - Overlay edits go straight into `~/.claude/review-pr/`.
   - Team edits change tracked files, so they reach everyone through a PR like any other change. Make them on a branch, and open the PR only if the user asks (as a draft, per `CONTRIBUTING.md` § AI-authored pull requests).
   - Append the rejected edits to `~/.claude/review-pr/retro-log.md`, one line each with the reason the user gave. Read that log before proposing anything in the next retro.
