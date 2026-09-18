# Maintaining the Homebrew Tap

The Homebrew tap for `@newrelic/preflight` lives at `newrelic-experimental/homebrew-preflight` on GitHub.com. This doc covers one-time tap setup and the per-release update process.

## One-time tap setup

These steps create the tap repo. Run them once when setting up the tap for the first time.

````bash
# 1. Create the tap repo on github.com
GH_HOST=github.com gh repo create newrelic-experimental/homebrew-preflight \
  --public \
  --description "Homebrew tap for @newrelic/preflight — AI coding observability"

# 2. Clone it
git clone https://github.com/newrelic-experimental/homebrew-preflight.git
cd homebrew-preflight

# 3. Create the Formula directory
mkdir -p Formula

# 4. Copy the current formula from this repo (adjust path as needed)
cp /path/to/preflight/homebrew/Formula/preflight.rb Formula/

# 5. Create a minimal README
cat > README.md << 'EOF'
# homebrew-preflight

Homebrew tap for [@newrelic/preflight](https://github.com/newrelic-experimental/preflight) — AI coding observability for Claude Code and other AI coding tools.

## Install

```bash
brew tap newrelic-experimental/preflight
brew install preflight
```

EOF

# 6. Commit and push (replace X.Y.Z with the version in homebrew/Formula/preflight.rb)

git add -A
git commit -m "preflight X.Y.Z"
git push origin main
````

**Verify the tap works:**

```bash
brew tap newrelic-experimental/preflight && brew install preflight && preflight --version
```

Expected: Homebrew installs `preflight` and `preflight --version` prints the version you copied into the formula.

---

## Per-release update (every new version)

The "Update Homebrew tap" step in `.github/workflows/release.yml` does most of this automatically on every run of the manual Release workflow: it runs `scripts/update-homebrew.sh` against the just-published npm version, then opens a PR against `homebrew-preflight` with the regenerated formula using the `HOMEBREW_TAP_TOKEN` repo secret and arms auto-merge. That PAT needs to be scoped to only the `homebrew-preflight` repo with **both** `Contents: Read and write` (to push the branch) and `Pull requests: Read and write` (to open the PR and enable auto-merge) — `Contents` alone is not enough. `homebrew-preflight`'s own org-wide ruleset requires one approving review before a PR can merge into `main`, so a maintainer still needs to approve that PR once per release — everything else is automatic.

**Verify after a release:**

```bash
brew update
brew upgrade preflight
preflight --version
```

Expected: `preflight --version` prints the new version.

**To update manually** (e.g. the tap drifted, or you're doing the update outside the Release workflow):

```bash
# Replace X.Y.Z with the new version
scripts/update-homebrew.sh X.Y.Z

# Review
cat homebrew/Formula/preflight.rb

# Copy to the tap repo and push
cp homebrew/Formula/preflight.rb /path/to/homebrew-preflight/Formula/preflight.rb
cd /path/to/homebrew-preflight
git add Formula/preflight.rb
git commit -m "preflight X.Y.Z"
git push origin main
```

---

## Troubleshooting

**`brew install` fails with sha256 mismatch**
The sha256 in the formula doesn't match the downloaded tarball. Re-run `scripts/update-homebrew.sh <version>` — it fetches and hashes the tarball fresh.

**`brew tap newrelic-experimental/preflight` returns 404**
The tap repo doesn't exist yet or is private. Check `GH_HOST=github.com gh repo view newrelic-experimental/homebrew-preflight`.

**`preflight --version` output doesn't match formula version**
The formula version in the `url` field and the version field in `package.json` must match. They should always match when `update-homebrew.sh` is used.
