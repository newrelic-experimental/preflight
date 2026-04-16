export {
  generateHookEntries,
  generateMcpServerEntry,
  generateNrConfig,
  mergeSettings,
  removeSettings,
  detectSettingsPath,
} from './install-helper.js';
export type { HookEntry, HookEntries, McpServerConfig, NrObserveConfig } from './install-helper.js';
export { runInstallCli, createInstallProgram } from './cli.js';
