/**
 * Coarse Bash command classifier.
 *
 * Bash is polymorphic: every shell invocation arrives as a single opaque
 * `command` string, which makes downstream metrics blind to the difference
 * between `git status` and `rm -rf node_modules`. This classifier turns the
 * command into a small fixed set of categories so trackers, dashboards, and
 * the audit trail can reason at the right granularity without trying to
 * fully parse shell.
 *
 * Heuristic, not exact: pipelines, env-var prefixes, and `sudo` are stripped;
 * the leading argv0 of the first command segment is matched against a lookup
 * table. Anything we don't recognise falls into 'shell-other'.
 */

export type BashCategory =
  | 'git'
  | 'package-manager' // npm/yarn/pnpm/pip/cargo/go-mod/bundle/gem/poetry/uv
  | 'test-runner' // jest/pytest/vitest/mocha/cargo-test/go-test/rspec
  | 'build' // tsc/webpack/vite/cargo-build/make/gradle/mvn/go-build
  | 'container' // docker/podman/kubectl/helm/k9s/oc
  | 'network' // curl/wget/http/nc/ssh/scp/rsync/ftp/sftp
  | 'fs-op' // ls/cat/cp/mv/rm/mkdir/touch/find/chmod/chown/tar/zip
  | 'search' // grep/rg/ag/ack/sed/awk
  | 'custom-script' // ./foo, bash foo.sh, sh foo.sh, python foo.py, node foo.js
  | 'shell-other'; // fallback

export interface BashClassification {
  readonly category: BashCategory;
  /** The resolved leading argv0 (after sudo / env stripping). Empty for blank input. */
  readonly leading: string;
  /** True for rm -rf, dd, mkfs, drop database, redirect to /dev/sd*, force-push, etc. */
  readonly isDestructive: boolean;
  /** True when the leading command is a network client (curl/wget/ssh/...). */
  readonly isNetwork: boolean;
}

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const GIT_COMMANDS = new Set(['git', 'gh', 'gitk', 'tig']);

const PACKAGE_MANAGERS = new Set([
  'npm',
  'yarn',
  'pnpm',
  'bun',
  'pip',
  'pip3',
  'pipx',
  'poetry',
  'uv',
  'cargo',
  'gem',
  'bundle',
  'bundler',
  'composer',
  'brew',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'apk',
]);

const TEST_RUNNERS = new Set([
  'jest',
  'vitest',
  'mocha',
  'pytest',
  'rspec',
  'phpunit',
  'tap',
  'ava',
  'cypress',
  'playwright',
  'karma',
  'tox',
  'nose',
  'nose2',
  'unittest',
  'busted',
  'ginkgo',
]);

const BUILD_TOOLS = new Set([
  'tsc',
  'webpack',
  'vite',
  'rollup',
  'esbuild',
  'parcel',
  'turbo',
  'nx',
  'make',
  'gmake',
  'cmake',
  'ninja',
  'gradle',
  'gradlew',
  'mvn',
  'sbt',
  'ant',
  'rake',
  'meson',
  'bazel',
  'buck',
  'pants',
  'swc',
  'babel',
]);

const CONTAINER_TOOLS = new Set([
  'docker',
  'podman',
  'docker-compose',
  'podman-compose',
  'kubectl',
  'oc',
  'helm',
  'k9s',
  'kustomize',
  'kind',
  'minikube',
  'skaffold',
  'buildah',
  'crictl',
]);

const NETWORK_TOOLS = new Set([
  'curl',
  'wget',
  'http',
  'httpie',
  'xh',
  'nc',
  'ncat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'telnet',
  'mosh',
]);

const FS_OPS = new Set([
  'ls',
  'cat',
  'cp',
  'mv',
  'rm',
  'rmdir',
  'mkdir',
  'touch',
  'find',
  'chmod',
  'chown',
  'chgrp',
  'tar',
  'zip',
  'unzip',
  'gzip',
  'gunzip',
  'bzip2',
  'xz',
  'tree',
  'ln',
  'stat',
  'du',
  'df',
  'pwd',
  'realpath',
  'readlink',
  'basename',
  'dirname',
]);

const SEARCH_TOOLS = new Set(['grep', 'rg', 'ag', 'ack', 'sed', 'awk', 'fzf']);

const SCRIPT_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'ksh',
  'fish',
  'dash',
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'tsx',
  'ts-node',
]);

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// Destructive: rm with any recursive flag, force-pushes, hard resets, dd,
// mkfs, drop/truncate, chmod 777, redirects to raw block devices,
// pipe-to-shell remote execution.
//
// rm-recursive: any flag bundle that includes `r` or `R` (alone, or combined
// with v / i / f / etc.), or the long-form `--recursive`. We only flag rm
// when the recursive flag is present — plain `rm foo.txt` is not destructive.
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b)/,
  // git push --force / -f, but NOT --force-with-lease / --force-if-includes
  // (which are the recommended *safe* forms). Match the force token anywhere
  // in the invocation, not just immediately after `push`.
  /\bgit\s+push\b(?=.*\s(?:--force(?!-(?:with-lease|if-includes))\b|-f\b))/i,
  /\bgit\s+reset\s+--hard\b/i,
  // git clean only deletes with -f/--force (clean.requireForce defaults to true);
  // -n/--dry-run and bare `git clean` are safe and stay unflagged.
  /\bgit\s+clean\b(?=.*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b)/i,
  /\bfind\b.*\s-delete\b/i,
  /\bdd\s+if=/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bshred\b/i,
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bchmod\s+777\b/,
  />\s*\/dev\/sd[a-z]/,
  /\b(?:curl|wget)\b.*\|\s*(?:\/[^\s]*\/)?(?:ba|z|k|da|fi|tc|c)?sh\b/i,
  /\b(?:curl|wget)\b.*\|\s*(?:\/[^\s]*\/)?(?:node|python3?|perl|ruby)\b/i,
];

// Replace the contents of single- or double-quoted regions with spaces of
// the same length so destructive-pattern matching can't be fooled by quoted
// arguments — e.g. `git commit -m "rm -rf old code"` should NOT classify as
// destructive. Heuristic: backslash-escapes inside quotes are honoured;
// dollar-quoted, ANSI-quoted, and heredoc bodies are not handled.
function maskQuotedRegions(command: string): string {
  let out = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      out += ' ';
      i++;
      while (i < command.length && command[i] !== "'") {
        out += ' ';
        i++;
      }
      if (i < command.length) {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out += ' ';
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          out += '  ';
          i += 2;
          continue;
        }
        out += ' ';
        i++;
      }
      if (i < command.length) {
        out += ' ';
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Sudo short flags that take a value (-u nobody, -g wheel, etc.).
const SUDO_VALUE_SHORT_FLAG = /^-[ughpUtCr]$/;
// Sudo long flags that take a value when not given as --foo=bar.
const SUDO_VALUE_LONG_FLAGS = new Set([
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--role',
  '--type',
  '--other-user',
  '--close-from',
]);

const SEGMENT_SPLIT_RE = /\|\||&&|;|\|/;

const SCRIPT_EXT_RE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|tsx|rb|pl|php|lua)$/i;

// ---------------------------------------------------------------------------
// Token normalization
// ---------------------------------------------------------------------------

function tokenize(command: string): string[] {
  return command.split(/\s+/).filter((t) => t.length > 0);
}

function stripEnvTokens(tokens: string[]): void {
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) {
    tokens.shift();
  }
}

function stripSudoTokens(tokens: string[]): void {
  while (tokens.length > 0 && tokens[0] === 'sudo') {
    tokens.shift();
    // Consume sudo's own flags (which precede the wrapped command).
    while (tokens.length > 0) {
      const flag = tokens[0] ?? '';
      if (!flag.startsWith('-')) break;
      tokens.shift();
      const next = tokens[0];
      if (next === undefined || next.startsWith('-')) continue;
      if (SUDO_VALUE_SHORT_FLAG.test(flag) || SUDO_VALUE_LONG_FLAGS.has(flag)) {
        tokens.shift();
      }
    }
  }
}

function firstSegment(command: string): string {
  const idx = command.search(SEGMENT_SPLIT_RE);
  return idx >= 0 ? command.slice(0, idx).trim() : command;
}

// ---------------------------------------------------------------------------
// Sub-classifiers
// ---------------------------------------------------------------------------

/**
 * Package-manager invocations like `npm test`, `yarn run build`, `pnpm lint`
 * should classify as the verb (test-runner / build / etc.), not as
 * 'package-manager'. The package-manager category is for install/audit/etc.
 */
function refinePackageManager(leading: string, tokens: readonly string[]): BashCategory {
  // tokens[0] is the package manager itself; look at the verb that follows.
  const rest = tokens.slice(1).filter((t) => !t.startsWith('-'));
  if (rest.length === 0) return 'package-manager';

  // `npm run X` / `yarn run X` / `pnpm run X` / `bun run X` — peel the 'run'.
  let verbIdx = 0;
  if (rest[0] === 'run' || rest[0] === 'run-script') {
    if (rest.length < 2) return 'package-manager';
    verbIdx = 1;
  }
  const verb = rest[verbIdx]?.toLowerCase();
  if (verb === undefined) return 'package-manager';

  if (verb === 'test' || verb === 'tests' || verb === 't') return 'test-runner';
  if (verb === 'build' || verb === 'compile') return 'build';
  if (verb === 'lint' || verb === 'typecheck' || verb === 'tsc') return 'build';
  if (leading === 'cargo' && verb === 'test') return 'test-runner';
  if (leading === 'cargo' && verb === 'build') return 'build';
  if (leading === 'go' && verb === 'test') return 'test-runner';
  if (leading === 'go' && verb === 'build') return 'build';

  return 'package-manager';
}

function classifyLeading(leading: string, tokens: readonly string[]): BashCategory {
  if (leading.length === 0) return 'shell-other';

  if (GIT_COMMANDS.has(leading)) return 'git';
  if (TEST_RUNNERS.has(leading)) return 'test-runner';
  if (BUILD_TOOLS.has(leading)) return 'build';
  if (CONTAINER_TOOLS.has(leading)) return 'container';
  if (NETWORK_TOOLS.has(leading)) return 'network';
  if (SEARCH_TOOLS.has(leading)) return 'search';
  if (FS_OPS.has(leading)) return 'fs-op';

  // Package managers may be wrapping a sub-command we recognise.
  if (PACKAGE_MANAGERS.has(leading)) return refinePackageManager(leading, tokens);

  // `go test`, `go build`, `cargo test`, `cargo build` — same handling.
  if ((leading === 'go' || leading === 'cargo') && tokens.length >= 2) {
    return refinePackageManager(leading, tokens);
  }

  // `npx jest`, `pnpx jest`, `bunx jest` — the runner is the second token.
  if (leading === 'npx' || leading === 'pnpx' || leading === 'bunx') {
    const next = tokens[1]?.toLowerCase();
    if (next !== undefined) {
      if (TEST_RUNNERS.has(next)) return 'test-runner';
      if (BUILD_TOOLS.has(next)) return 'build';
    }
    return 'package-manager';
  }

  // Script interpreters: `bash foo.sh`, `python foo.py`, `node script.js`.
  if (SCRIPT_INTERPRETERS.has(leading)) return 'custom-script';

  return 'shell-other';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function classifyBash(command: string): BashClassification {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { category: 'shell-other', leading: '', isDestructive: false, isNetwork: false };
  }

  // Destructive check runs against the full command with quoted regions
  // masked out (so `git commit -m "rm -rf old"` doesn't fire) but otherwise
  // unsplit (so pipe-to-shell patterns survive segment splitting and sudo
  // stripping).
  const masked = maskQuotedRegions(trimmed);
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(masked));

  const segment = firstSegment(trimmed);
  const tokens = tokenize(segment);

  // sudo can wrap env vars (`sudo FOO=bar cmd`) and env vars can prefix sudo
  // (`FOO=bar sudo cmd`), so we strip env → sudo → env to cover both shapes.
  stripEnvTokens(tokens);
  stripSudoTokens(tokens);
  stripEnvTokens(tokens);

  if (tokens.length === 0) {
    return { category: 'shell-other', leading: '', isDestructive, isNetwork: false };
  }

  const leadingRaw = tokens[0] ?? '';
  // An "explicit script path" is a relative-path invocation or anything with a
  // recognisable script extension — the user wrote it as a path on purpose,
  // so we preserve the full token as the leading.
  const explicitScriptPath =
    leadingRaw.startsWith('./') || leadingRaw.startsWith('../') || SCRIPT_EXT_RE.test(leadingRaw);
  const absolutePath = leadingRaw.startsWith('/');

  const leading = explicitScriptPath ? leadingRaw : (leadingRaw.split('/').pop() ?? leadingRaw);

  let category = classifyLeading(leading.toLowerCase(), tokens);

  // Path-shaped invocations that don't resolve to a known tool are
  // user-authored binaries / scripts.
  if (category === 'shell-other' && (explicitScriptPath || absolutePath)) {
    category = 'custom-script';
  }

  const isNetwork = category === 'network' || NETWORK_TOOLS.has(leading.toLowerCase());

  return { category, leading, isDestructive, isNetwork };
}
