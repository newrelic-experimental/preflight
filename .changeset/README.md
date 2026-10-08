# Changesets

Each file here describes one pending change to `@newrelic/preflight`: the semver bump it needs
and the CHANGELOG entry it gets. The release PR consumes them all at once, bumping the version
everywhere it's written and adding their entries to `CHANGELOG.md`, so no other PR edits the
version or the CHANGELOG.

```md
---
'@newrelic/preflight': patch
---

The CHANGELOG entry, written for someone who uses Preflight.
```

Create one with `npx changeset` (interactive) or
`npx changeset --patch @newrelic/preflight -m "..."`, or write the file by hand. See
[Changesets in CONTRIBUTING.md](../CONTRIBUTING.md#changesets) for when a PR needs one, how to
pick the bump, and how releases are cut.
