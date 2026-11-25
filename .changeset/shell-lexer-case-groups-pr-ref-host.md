---
'@newrelic/preflight': patch
---

Preflight no longer counts a `gh pr merge` that never ran, and no longer clears the wrong "Ready for review" pull request. A quoted `&&` inside `"$( … )"` is no longer read as a chain operator when the substitution holds an array assignment such as `arr=(a b)`, a `case` pattern, or a `${x//(/}` expansion. A `-R`, `--repo` or `GH_REPO=` quoted into a merge's `--body` or `--subject` is no longer read as the repo it merged into, and an attached `-Racme/app` now is. A pull request on a GitHub Enterprise host is kept apart from one on github.com with the same owner, repo and number, so a merge on one no longer clears the other. Sessions saved before this release carry no host and are read as github.com.
