# Preflight review checklist

The repo's rules live in its docs, not here. This file only says which section to read for which kind of change, so the review checks the current rule and can cite it. Read the sections whose trigger matches the diff and report only what the diff breaks, citing the file and section.

## Always

- `CONTRIBUTING.md` § Before opening a PR, for which checks the diff calls for
- `CONTRIBUTING.md` § Changesets and `CLAUDE.md` § Versioning and CHANGELOG, for whether a changeset is needed, its bump level and its wording (CI checks presence, not level or wording)
- `CLAUDE.md` § Shared Code, § Logger Pattern and § Linting
- Any doc comment, `docs/*.md` page or `CLAUDE.md` section that describes the changed behaviour still matches the code

## When the diff touches…

| Area                                            | Read                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| An event type or `nr-ingest.ts`                 | `CLAUDE.md` § Multi-Tier Telemetry Routing and § Team Attribution Fields                                                 |
| A tracker in `src/metrics/`                     | `CLAUDE.md` § Metric Tracker Pattern, § Cross-tracker reads require dispatch order                                       |
| An MCP tool                                     | `CLAUDE.md` § MCP Tool Registration                                                                                      |
| Config                                          | `CLAUDE.md` § Configuration, `SECURITY.md` § Input Validation                                                            |
| A platform adapter or `collector-script.ts`     | `CLAUDE.md` § Platform Adapter Pattern, `docs/ADAPTERS.md`                                                               |
| Storage, network, subprocesses, logs, redaction | `SECURITY.md` § Quick Reference for Code Review, item by item, then the section each item points to                      |
| Tests                                           | `CLAUDE.md` § Testing Conventions, `docs/TEST_PATTERNS.md`                                                               |
| Dashboard UI (`src/web`)                        | `CONTRIBUTING.md` § The three suites                                                                                     |
| Dependencies or `package-lock.json`             | `CONTRIBUTING.md` § Before opening a PR (the lockfile item) and § Changesets (bundled dashboard libraries get a `patch`) |
| A project skill in `.claude/skills/`            | `CONTRIBUTING.md` § The three suites (the project skills paragraph) and § Reviewing pull requests                        |

If a rule you'd apply isn't written in any of these, it isn't a repo rule yet. Raise it as a question, and suggest adding it to the right doc.
