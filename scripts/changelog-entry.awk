# Splits CHANGELOG.md around the entry for $VERSION. Run by release-pr.yml's pull-request job,
# which installs nothing, so it's awk rather than part of release-files.ts. Both read the
# environment, so no escapes in the values are expanded. The entry is the file's first `## `
# section, where `changeset version` puts it, and only when that heading is exactly
# `## <VERSION> - <YYYY-MM-DD>`. A matching section anywhere else stays part of the rest.
#
#   VERSION=1.64.0 PART=entry awk -f scripts/changelog-entry.awk CHANGELOG.md
#     The entry's body, without its heading or the blank lines before it. Nothing if the file
#     has no such entry.
#   VERSION=1.64.0 PART=rest awk -f scripts/changelog-entry.awk CHANGELOG.md
#     The file without that section, which is the CHANGELOG.md the release started from.
/^## / {
  headings++
  inside = headings == 1 && NF == 4 && $2 == ENVIRON["VERSION"] && $3 == "-" &&
    $4 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/
  if (inside) next
}
ENVIRON["PART"] == "rest" { if (!inside) print; next }
inside && !started && /^$/ { next }
inside { started = 1; print }
