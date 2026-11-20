/**
 * The start report's install details and feature flags, reduced to closed
 * values before they reach an event.
 */

import { realpathSync } from 'node:fs';
import { arch, platform } from 'node:os';

import type { McpServerConfig } from '../config.js';
import { createDefaultRegistry } from '../platforms/platform-registry.js';
import { VERSION } from '../version.js';
import { FEATURES, type FeatureName, type InstallChannel } from './constants.js';
import { toIdentifier } from './events.js';
import type { InstallInfo } from './reporter.js';

/**
 * Best effort from the path of the running entry point. Claude Code plugin
 * installs are told apart by CLAUDE_PLUGIN_ROOT. Smithery installs look like
 * npm or source installs, so they report `npm` or `other`.
 */
export function detectInstallChannel(
  entryPoint: string | undefined = process.argv[1],
): InstallChannel {
  if (!entryPoint) return 'other';
  let path = entryPoint;
  try {
    path = realpathSync(entryPoint);
  } catch {
    // keep the unresolved path
  }
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude_plugin';
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(path)) return 'homebrew';
  if (/[/\\]node_modules[/\\]/.test(path)) return 'npm';
  if (/[/\\]dist[/\\]index\.js$/.test(path)) return 'git';
  return 'other';
}

export function featureFlags(config: McpServerConfig): Record<FeatureName, boolean> {
  const flags: Record<FeatureName, boolean> = {
    otlp_export: config.otlp.endpoint !== null,
    otlp_receiver: config.otlp.receiverEnabled,
    proxy: config.proxyUpstreams.length > 0,
    budget:
      config.sessionBudgetUsd !== null ||
      config.dailyBudgetUsd !== null ||
      config.weeklyBudgetUsd !== null,
    digest: config.digestWebhookUrl !== null,
    alerts: config.alerts.enabled,
    // An implicit single tier is synthesized from the flat keys; only an
    // explicit tiers array counts as using the feature.
    tiers: config.tiers.length > 1 || config.tiers.some((t) => t.name !== 'default'),
    companion_mode: config.companionMode,
  };
  for (const f of FEATURES) flags[f] = flags[f] === true;
  return flags;
}

export function installInfo(
  config: McpServerConfig,
  adapter: string | undefined,
  hooksInstalled: boolean,
): InstallInfo {
  return {
    version: VERSION,
    os: toIdentifier(platform()),
    arch: toIdentifier(arch()),
    node_major: Number(process.versions.node.split('.')[0]),
    adapter: toIdentifier(adapter, 'unknown'),
    install_channel: detectInstallChannel(),
    mode: config.mode,
    hooks_installed: hooksInstalled,
  };
}

/** The first adapter whose detection matches this process's environment. */
export function detectAdapterName(): string | undefined {
  try {
    return createDefaultRegistry().detect()?.platformName;
  } catch {
    return undefined;
  }
}
