// Shared by src/config.ts (McpServerConfig) and src/hooks/collector-script.ts (the hook
// binary) so the "highSecurity forcibly disables content recording" rule can't drift
// between them — each file previously reimplemented this check independently.
export function resolveRecordContent(highSecurity: boolean, explicitValue: boolean): boolean {
  return highSecurity ? false : explicitValue;
}
