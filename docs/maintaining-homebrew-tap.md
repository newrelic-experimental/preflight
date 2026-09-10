# Maintaining the Homebrew Tap

The Homebrew tap for `@newrelic/preflight` lives at `newrelic-experimental/homebrew-preflight` on GitHub.com. This doc covers one-time tap setup and the per-release update process.

## One-time tap setup

These steps create the tap repo. Run them once when setting up the tap for the first time.

**Prerequisites:** `gh` CLI authenticated to `github.com` (not GHE). If `gh auth status` shows only GHE, run `GH_HOST=github.com gh auth login` first.

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
````

EOF

# 6. Commit and push

git add -A
git commit -m "preflight 1.1.0"
git push origin main

````

**Verify the tap works:**

```bash
brew tap newrelic-experimental/preflight && brew install preflight && preflight --version
```

Expected: Homebrew installs `preflight` and `preflight --version` prints `1.1.0`.

---

## Per-release update (every new version)

Run these steps each time a new version is published to npm.

**1. In the `preflight` repo, update the formula:**

```bash
# Replace X.Y.Z with the new version
scripts/update-homebrew.sh X.Y.Z
```

Review the change:

```bash
cat homebrew/Formula/preflight.rb
```

Confirm `url` and `sha256` match the new version.

**2. Commit in the `preflight` repo:**

```bash
git add homebrew/Formula/preflight.rb
git commit -m "Chore: update Homebrew formula for vX.Y.Z"
```

**3. Copy the updated formula to the tap repo:**

```bash
cp homebrew/Formula/preflight.rb /path/to/homebrew-preflight/Formula/preflight.rb
```

**4. Commit and push in the tap repo:**

```bash
cd /path/to/homebrew-preflight
git add Formula/preflight.rb
git commit -m "preflight X.Y.Z"
git push origin main
```

**5. Verify:**

```bash
brew update
brew upgrade preflight
preflight --version
```

Expected: `preflight --version` prints `X.Y.Z`.

---

## Troubleshooting

**`brew install` fails with sha256 mismatch**
The sha256 in the formula doesn't match the downloaded tarball. Re-run `scripts/update-homebrew.sh <version>` — it fetches and hashes the tarball fresh.

**`brew tap newrelic-experimental/preflight` returns 404**
The tap repo doesn't exist yet or is private. Check `GH_HOST=github.com gh repo view newrelic-experimental/homebrew-preflight`.

**`preflight --version` output doesn't match formula version**
The formula version in the `url` field and the version field in `package.json` must match. They should always match when `update-homebrew.sh` is used.
````
