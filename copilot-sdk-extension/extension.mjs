// src/hooks/copilot-sdk-extension.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

// src/storage/hook-buffer.ts
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
var DRAIN_SEAL = "\0preflight-drain-seal\n";
var MAX_WRITES = 5;
var MAX_OPENS = 100;
var TORN_LINE_END = "\n";
function readRange(fd, start, end) {
  const buf = Buffer.alloc(Math.max(0, end - start));
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}
function readToEnd(fd, scratch) {
  let total = 0;
  for (let n; (n = readSync(fd, scratch, 0, scratch.length, null)) > 0; ) total += n;
  return total;
}
function offsetAfterWrite(fd) {
  const scratch = Buffer.alloc(64 * 1024);
  let after = readToEnd(fd, scratch);
  for (; ; ) {
    const size = fstatSync(fd).size;
    const more = readToEnd(fd, scratch);
    if (more === 0) return size - after;
    after += more;
  }
}
function isAt(path, file) {
  const now = statSync(path, { bigint: true, throwIfNoEntry: false });
  return now !== void 0 && now.ino === file.ino && now.dev === file.dev;
}
var LineWrittenError = class extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
};
function landedBeforeSeal(fd, sealFloor) {
  return !readRange(fd, sealFloor, offsetAfterWrite(fd)).includes(DRAIN_SEAL);
}
function appendOnce(path, data) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, 384);
  let landed = false;
  try {
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!isAt(path, opened)) return "moved";
      const sealFloor = Number(opened.size);
      const written = writeSync(fd, data);
      try {
        if (written < data.length) {
          writeSync(fd, TORN_LINE_END);
          return "redo";
        }
        landed = isAt(path, opened) || landedBeforeSeal(fd, sealFloor);
      } catch (err) {
        landed = written >= data.length - 1 && landedBeforeSeal(fd, sealFloor);
        throw err;
      }
      return landed ? "kept" : "redo";
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    throw landed ? new LineWrittenError(err) : err;
  }
}
function appendToHookBuffer(path, text) {
  if (text.includes("\0")) {
    throw new Error(`Hook buffer text contains NUL, which marks a drain seal: ${path}`);
  }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new Error(`Hook buffer text must be exactly one newline-terminated line: ${path}`);
  }
  const data = Buffer.from("\n" + text);
  let writes = 0;
  for (let opens = 0; opens < MAX_OPENS; opens++) {
    const landing = appendOnce(path, data);
    if (landing === "kept") return;
    if (landing === "redo" && ++writes === MAX_WRITES) break;
  }
  throw new Error(`Hook buffer write raced a drain on all attempts and was not kept: ${path}`);
}

// src/hooks/copilot-sdk-usage-mapper.ts
import { homedir } from "node:os";
import { resolve } from "node:path";
var SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function mapAssistantUsageEvent(data, sessionId, timestampMs) {
  if (typeof data !== "object" || data === null) return null;
  const d = data;
  const model = typeof d.model === "string" && d.model.length > 0 ? d.model : null;
  if (!model) return null;
  const apiCallId = typeof d.apiCallId === "string" && d.apiCallId.length > 0 ? d.apiCallId : null;
  if (!apiCallId) return null;
  const inputTokensRaw = num(d.inputTokens);
  const cacheReadTokens = num(d.cacheReadTokens);
  const cacheCreationTokens = num(d.cacheWriteTokens);
  return {
    mode: "token",
    tool: "copilot-sdk-usage",
    timestamp: timestampMs,
    sessionId,
    messageId: apiCallId,
    model,
    // SDK's inputTokens is inclusive of both cache-read and cache-write —
    // subtract both so the uncached remainder isn't double-billed at the
    // base input rate (see header comment).
    inputTokens: Math.max(0, inputTokensRaw - cacheReadTokens - cacheCreationTokens),
    outputTokens: num(d.outputTokens),
    cacheReadTokens,
    cacheCreationTokens
  };
}
function resolveStoragePath() {
  return process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? resolve(homedir(), ".newrelic-preflight");
}
function resolveBufferPath(storagePath, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return resolve(storagePath, `buffer-${sessionId}.jsonl`);
}

// src/hooks/copilot-sdk-extension.ts
function appendTokenLine(bufferPath, line) {
  try {
    mkdirSync(dirname(bufferPath), { recursive: true, mode: 448 });
    appendToHookBuffer(bufferPath, JSON.stringify(line) + "\n");
  } catch (err) {
    process.stderr.write(`preflight extension: failed to write token line: ${err}
`);
  }
}
try {
  const session = await joinSession({ tools: [] });
  const sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
  if (sessionId) {
    const storagePath = resolveStoragePath();
    session.on("assistant.usage", (event) => {
      const line = mapAssistantUsageEvent(event.data, sessionId, Date.now());
      if (!line) return;
      const bufferPath = resolveBufferPath(storagePath, sessionId);
      if (!bufferPath) return;
      appendTokenLine(bufferPath, line);
    });
  } else {
    process.stderr.write("preflight extension: joinSession() returned no sessionId\n");
  }
} catch (err) {
  process.stderr.write(`preflight extension: joinSession() failed: ${err}
`);
}
