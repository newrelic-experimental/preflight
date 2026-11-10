# Comment style

The comments go out under the user's name, so write them the way the user already reviews in this repo: plain prose, specific, and backed by something they ran. The author is a teammate who knows the code and the platforms it targets. Write for that reader.

This file is the team's default. If `~/.claude/preflight-review-pr/comment-style.md` exists, read it after this one: it holds the user's own voice, and it wins where the two disagree.

## Each comment

- **Lead with the claim**, then the evidence, then the ask.
- **One comment per reply the author will write.** Merge findings that share a theme and a fix into one comment ("could we add Kiro to the uninstall paths and cover `handleKiroInstall` in `cli.test.ts`?"). When it spans files, anchor it at line 1 of the main new file.
- **Match the evidence to how surprising the claim is.**
  - If a claim contradicts something the author wrote or believes (a changeset, a test, a doc comment, the PR body), back it with a reproduction and numbers against `main`: "I ran recordEstimatedTokens → saveSession → recordTokenUsage → saveSession → loadSession → seedFromPersisted. Estimate 0.105, real 0.0105, total on disk 0.105." Give the sequence in enough detail that the author can rerun it.
  - If the reason for an ask is something the author already relies on (they wrote the guard, the doc, the pattern), the ask alone is enough. Don't explain their own premise back to them.
  - Either way, prove the claim before raising it ([lenses.md](lenses.md) § 3). This rule decides what the comment shows, not what you check.
- **Propose the fix or the test**, not only the problem: "What if this tested `SessionStore` with a checkpoint before the real report?" A suggested test the author can paste is often the most useful line in a review.
- **For design questions, offer the precedent and let the author choose.** Write "In `PLUGIN.md` we have …, so we could follow that here", not "add one sentence near the top of this file". The precedent is something the author can copy, such as a current file or a PR that already did it ("#922 is a reference for what I had in mind"). It is not history offered as an argument.
- **Ask when the intent is unclear**, and say what you would expect: "Is that cost lost, or does `ParentTranscriptWatcher` replay those turns after?" A question is the right form for anything you could not reproduce.
- **Plain words over jargon**, even when the doc you cite uses the jargon: "SECURITY.md's rules", not "invariants".
- **Mark priority only when it is not blocking**, and only on statements. Blocking issues need no label. Prefix the rest so the author can triage: `Non-blocking:`, `Nit:`, `Optional:`. A question needs no label. Use "Non-blocking, but worth fixing before merge" only when that's meant. (Google's eng-practices convention. Conventional Comments' `suggestion (non-blocking):` works too; pick one per review.)
- **Talk about the code, not the author, in a collaborative voice:** "could we", "what if", "let's", "we have". Write "This discards the estimates when…", not "you forgot…". On a re-review, open with what's now fixed and how you checked it ("Thanks, I re-ran … and …"), then "However, …".
- **Reference code precisely**: backticked identifiers, and `path:line` for code outside the comment's anchor when the author needs it to act or verify. Leave out citations that only show your own working.
- **For text changes, give a diff.** For a PR body or doc wording, a ` ```diff ` block or a GitHub ` ```suggestion ` block on the line beats describing the edit.
- **Length.** Most comments are one to three sentences. Only a reproduction or a suggested diff makes one longer.
- No emoji, no "Great question!", no restating the code back to the author.

## Disclosure

The user decides whether to say a finding came from Claude. If they want to, a plain form works: "Claude claimed to find a bug with… I ran this sequence against the branch: …". Never claim a reproduction the user did not see run.

## Review body

- **Approving:** default to an empty body. At most one conversational line ("Nothing else to note, everything looks good!", "Mostly looking good, just have a request for …").
- **Blocking items present:** one line naming them, so the author knows what gates the merge.
- **Praise:** add it only when it is specific ("the `replacesEstimates` flag keeps the self-report path intact") and no other reviewer has already said it.
- **Outside the diff:** keep it out of the body. List those items in the user summary as follow-up issue candidates instead.
- **Re-review:** say which earlier threads are resolved and which are not.

## Before handing drafts to the user

Read each comment as the author would see it on GitHub, with no other context. Cut any sentence the author does not need. If a comment needs the review summary to make sense, it is missing its evidence.
