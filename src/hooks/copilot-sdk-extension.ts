// Builds to copilot-sdk-extension/extension.mjs with `npm run build:copilot-extension`.

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
    // stdout is the extension's JSON-RPC channel, so report on stderr.
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
  process.stderr.write(`preflight extension: joinSession() failed: ${err}\n`);
}
