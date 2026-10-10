# Splits CHANGELOG.md around the entry for $VERSION, its `## <version> - <date>` section. Run
# by release-pr.yml's pull-request job, which installs nothing, so it's awk rather than part of
# release-files.ts. Both read the environment, so no escapes in the values are expanded:
#
#   VERSION=1.64.0 PART=entry awk -f scripts/changelog-entry.awk CHANGELOG.md
#     The entry's body, without its heading or the blank lines before it.
#   VERSION=1.64.0 PART=rest awk -f scripts/changelog-entry.awk CHANGELOG.md
#     The file without that section, which is the CHANGELOG.md the release started from.
/^## / { inside = ($2 == ENVIRON["VERSION"]) }
inside && /^## / { next }
ENVIRON["PART"] == "rest" { if (!inside) print; next }
inside && !started && /^$/ { next }
inside { started = 1; print }
