// Source of copilot-sdk-extension/extension.mjs. Copilot SDK extensions load as one plain
// JavaScript file with no build step, so `npm run build:copilot-extension` bundles this file
// and the output is committed. Install by copying that file to
// ~/.copilot/extensions/preflight/extension.mjs and running the host with --experimental.
// See docs/ADAPTERS.md, "GitHub Copilot SDK".
//
// Captures only assistant.usage, the one source of per-call token counts. Tool calls come from
// the PreToolUse/PostToolUse hooks, and capturing them here too would double-count.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { joinSession } from '@github/copilot-sdk/extension';

import { appendToHookBuffer } from '../storage/hook-buffer.js';
import {
  mapAssistantUsageEvent,
  resolveBufferPath,
  resolveStoragePath,
  type TokenBufferLine,
} from './copilot-sdk-usage-mapper.js';

function appendTokenLine(bufferPath: string, line: TokenBufferLine): void {
  try {
    mkdirSync(dirname(bufferPath), { recursive: true, mode: 0o700 });
    appendToHookBuffer(bufferPath, JSON.stringify(line) + '\n');
  } catch (err) {
    // stdout is the extension's JSON-RPC channel, so report on stderr, which the CLI captures
    // into ~/.copilot/logs/extensions/. A write failure must not crash the host session.
    process.stderr.write(`preflight extension: failed to write token line: ${err}\n`);
  }
}

try {
  const session = await joinSession({ tools: [] });
  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : null;

  if (sessionId) {
    const storagePath = resolveStoragePath();
    session.on('assistant.usage', (event) => {
      const line = mapAssistantUsageEvent(event.data, sessionId, Date.now());
      if (!line) return;
      const bufferPath = resolveBufferPath(storagePath, sessionId);
      if (!bufferPath) return;
      appendTokenLine(bufferPath, line);
    });
  } else {
    process.stderr.write('preflight extension: joinSession() returned no sessionId\n');
  }
} catch (err) {
  // A failed joinSession() (e.g. an incompatible CLI version) must not stop the CLI session.
  process.stderr.write(`preflight extension: joinSession() failed: ${err}\n`);
}
