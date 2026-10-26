/**
 * Env keys that enable dynamic-linker or interpreter injection into a child
 * process. Stripped before Preflight spawns anything it was configured to
 * run (proxy stdio upstreams, secret helper commands).
 */
export const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'PERL5LIB',
  'LD_AUDIT',
  'GCONV_PATH',
  'BASH_ENV',
  'ENV',
  'ELECTRON_RUN_AS_NODE',
]);

export function stripDangerousEnv(env: Readonly<Record<string, string | undefined>>): {
  readonly env: Record<string, string>;
  readonly stripped: readonly string[];
} {
  const kept: Record<string, string> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (DANGEROUS_ENV_KEYS.has(key)) stripped.push(key);
    else kept[key] = value;
  }
  return { env: kept, stripped };
}
