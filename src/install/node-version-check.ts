export const MIN_SUPPORTED_NODE_MAJOR = 22;

/**
 * Returns a diagnostic message when the running Node major version is below
 * MIN_SUPPORTED_NODE_MAJOR, or null when it's fine. Checked at the very start
 * of main() (src/index.ts) and reused as a `doctor` diagnostic check
 * (src/install/diagnostics.ts) so a stale/unintended Node binary (commonly an
 * nvm resolution issue) is reported consistently in both places.
 *
 * This only actually catches Node 20-21: on those versions the static import
 * graph still loads fine, so this check's own code gets a chance to run
 * before failing on the version floor. On Node 16-19 the process crashes
 * earlier, during ESM's evaluation of the whole static import graph — before
 * this check ever runs — with a less clear error, e.g.
 * `ReferenceError: structuredClone is not defined` (Node 16, from
 * src/shared/pricing.ts) or `ReferenceError: File is not defined` (Node 18,
 * from undici). Still valuable for the most common real-world case: a stale
 * nvm default resolving to a merely-slightly-old Node.
 */
export function checkNodeVersion(nodeVersion: string = process.version): string | null {
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major >= MIN_SUPPORTED_NODE_MAJOR) return null;
  return (
    `preflight requires Node.js v${MIN_SUPPORTED_NODE_MAJOR}+, but is running under ${nodeVersion}. ` +
    'This usually means your MCP client resolved a stale or unintended Node binary (e.g. via nvm). ' +
    'See docs/TROUBLESHOOTING.md, "MCP server won\'t start (wrong Node version)", for how to pin the ' +
    'exact Node path in ~/.mcp.json.'
  );
}
