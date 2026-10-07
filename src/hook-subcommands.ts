// Hook event names and the argv markers that name them in hook commands. Shared by
// src/install/install-helper.ts (which writes the markers into settings files) and
// src/hooks/collector-script.ts (the hook binary, which must stay free of heavy
// imports), so the installer and the collector read event names from one table.

/** Every Claude Code hook event the installer registers (and must be able to remove). */
export const HOOK_EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'StopFailure',
] as const;
export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

// The argument the installer writes after `preflight-collector` for each event.
// Claude Code's payload names its own event (hook_event_name), and the collector
// dispatches on that, so for installer-written hooks the marker identifies the
// command in settings files (install-helper.ts's NR_HOOK_RE recognizes exactly
// this vocabulary). Antigravity's payloads name no event, so for those the
// collector resolves the command's argument with hookEventFromArg().
export const HOOK_SUBCOMMANDS = {
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  PermissionRequest: 'permission-request',
  PermissionDenied: 'permission-denied',
  StopFailure: 'stop-failure',
} as const satisfies Record<HookEventType, string>;

/**
 * Resolves a hook command's argument to the event it names. Accepts the event
 * name (`PostToolUse`) or its HOOK_SUBCOMMANDS marker (`post-tool`), ignoring
 * case; returns undefined for anything else.
 */
export function hookEventFromArg(arg: string | undefined): HookEventType | undefined {
  if (arg === undefined) return undefined;
  const lower = arg.toLowerCase();
  return HOOK_EVENT_TYPES.find(
    (event) => event.toLowerCase() === lower || HOOK_SUBCOMMANDS[event] === lower,
  );
}
