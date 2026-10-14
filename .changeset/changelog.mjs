// CHANGELOG line formatter for `changeset version`, referenced from config.json. It renders
// each changeset as one bullet holding its summary exactly as written, which is how the
// entries before Changesets read. The stock formatter (@changesets/cli/changelog) would
// prefix every bullet with the short hash of the commit that added the changeset.

/** @type {import('@changesets/types').ChangelogFunctions} */
const changelogFunctions = {
  getReleaseLine: async (changeset) => {
    const [firstLine, ...rest] = changeset.summary
      .trim()
      .split('\n')
      .map((line) => line.trimEnd());
    // Continuation lines are indented so a multi-paragraph summary stays inside its bullet.
    return [`- ${firstLine}`, ...rest.map((line) => (line ? `  ${line}` : ''))].join('\n');
  },
  // Preflight is one package, so no release is ever caused by an internal dependency bump.
  getDependencyReleaseLine: async () => '',
};

export default changelogFunctions;
