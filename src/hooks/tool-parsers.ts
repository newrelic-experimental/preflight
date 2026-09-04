/**
 * Tool-specific field parsers for Claude Code hook events.
 *
 * Each parser extracts structured metadata from a tool's `tool_input` and
 * `tool_response` objects. The dispatcher routes to the appropriate parser
 * based on tool name. Unknown tools return an empty record.
 *
 * All parsers are defensive — null/undefined inputs return {}, and any
 * parsing error is caught and returns {}.
 */

import { classifyBash } from './bash-classifier.js';

type ToolFields = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countLines(text: string): number {
  if (text === '') return 0;
  return (text.match(/\n/g) || []).length + 1;
}

// ---------------------------------------------------------------------------
// Bash command classification heuristics
// ---------------------------------------------------------------------------

const TEST_COMMAND_RE =
  /\b(jest|vitest|mocha|pytest|go\s+test|npm\s+test|npm\s+run\s+test|npx\s+jest|npx\s+vitest|cargo\s+test|bun\s+test|bun\s+run\s+test|pnpm\s+test|pnpm\s+run\s+test|yarn\s+test)\b/i;

const BUILD_COMMAND_RE =
  /\b(tsc|npm\s+run\s+build|make\b|cargo\s+build|go\s+build|webpack|vite\s+build)\b/i;

const LINT_COMMAND_RE =
  /\b(eslint|prettier|pylint|golangci-lint|rubocop|clippy|biome\s+(check|lint))\b/i;

// ---------------------------------------------------------------------------
// Per-tool parsers
// ---------------------------------------------------------------------------

function parseRead(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.file_path === 'string') fields.filePath = input.file_path;
  if (typeof input.offset === 'number') fields.lineOffset = input.offset;
  if (typeof input.limit === 'number') fields.lineLimit = input.limit;
  return fields;
}

function parseWrite(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.file_path === 'string') fields.filePath = input.file_path;
  if (typeof input.contentLength === 'number') {
    fields.contentLength = input.contentLength;
    if (typeof input.lineCount === 'number') fields.lineCount = input.lineCount;
  } else if (typeof input.content === 'string') {
    fields.contentLength = input.content.length;
    fields.lineCount = countLines(input.content);
  }
  return fields;
}

function parseEdit(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.file_path === 'string') fields.filePath = input.file_path;
  if (typeof input.oldStringLength === 'number') {
    fields.oldStringLength = input.oldStringLength;
    if (typeof input.oldLineCount === 'number') fields.oldLineCount = input.oldLineCount;
  } else if (typeof input.old_string === 'string') {
    fields.oldStringLength = input.old_string.length;
    fields.oldLineCount = countLines(input.old_string);
  }
  if (typeof input.newStringLength === 'number') {
    fields.newStringLength = input.newStringLength;
    if (typeof input.newLineCount === 'number') fields.newLineCount = input.newLineCount;
    if (typeof input.isDelete === 'boolean') fields.isDelete = input.isDelete;
  } else if (typeof input.new_string === 'string') {
    fields.newStringLength = input.new_string.length;
    fields.newLineCount = input.new_string.length > 0 ? countLines(input.new_string) : 0;
    fields.isDelete = input.new_string.length === 0;
  }
  if (typeof input.replace_all === 'boolean') fields.replaceAll = input.replace_all;
  return fields;
}

function parseBash(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.command === 'string') {
    fields.command = input.command;
    fields.isTestCommand = TEST_COMMAND_RE.test(input.command);
    fields.isBuildCommand = BUILD_COMMAND_RE.test(input.command);
    fields.isLintCommand = LINT_COMMAND_RE.test(input.command);

    // Coarse classification for downstream telemetry: turns the polymorphic
    // command string into a fixed category (git / test-runner / build / ...)
    // so dashboards and trackers can bucket Bash by shape, not just by name.
    const classification = classifyBash(input.command);
    fields.bashCategory = classification.category;
    fields.bashLeading = classification.leading;
    fields.bashDestructive = classification.isDestructive;
    fields.bashNetwork = classification.isNetwork;
  }
  if (typeof input.description === 'string') fields.commandDescription = input.description;
  if (typeof input.timeout === 'number') fields.commandTimeout = input.timeout;
  if (typeof input.run_in_background === 'boolean')
    fields.runInBackground = input.run_in_background;
  return fields;
}

function parseGrep(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.pattern === 'string') fields.pattern = input.pattern;
  if (typeof input.path === 'string') fields.grepPath = input.path;
  if (typeof input.output_mode === 'string') fields.outputMode = input.output_mode;
  return fields;
}

function parseGlob(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.pattern === 'string') fields.pattern = input.pattern;
  if (typeof input.path === 'string') fields.globPath = input.path;
  return fields;
}

function parseAgent(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.description === 'string') fields.agentDescription = input.description;
  if (typeof input.subagent_type === 'string') fields.subagentType = input.subagent_type;
  if (typeof input.promptLength === 'number') {
    fields.promptLength = input.promptLength;
  } else if (typeof input.prompt === 'string') {
    fields.promptLength = input.prompt.length;
  }
  if (typeof input.run_in_background === 'boolean')
    fields.runInBackground = input.run_in_background;
  if (typeof input.name === 'string') fields.agentName = input.name;
  if (typeof input.team_name === 'string') fields.agentTeamName = input.team_name;
  if (typeof input.isolation === 'string') fields.agentIsolation = input.isolation;
  if (typeof input.model === 'string') fields.agentModel = input.model;
  return fields;
}

function parseAskUserQuestion(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (Array.isArray(input.questions)) fields.questionCount = input.questions.length;
  return fields;
}

function parseTaskCreate(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.subject === 'string') fields.taskSubject = input.subject;
  return fields;
}

function parseTaskUpdate(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.taskId === 'string') fields.taskId = input.taskId;
  if (typeof input.status === 'string') fields.taskStatus = input.status;
  if (typeof input.subject === 'string') fields.taskSubject = input.subject;
  return fields;
}

function parseSkill(input: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof input.skill === 'string') fields.skillName = input.skill;
  if (typeof input.argsLength === 'number') {
    fields.skillArgsLength = input.argsLength;
  } else if (typeof input.args === 'string') {
    fields.skillArgsLength = input.args.length;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const INPUT_PARSERS: Record<string, (input: Record<string, unknown>) => ToolFields> = {
  Read: parseRead,
  Write: parseWrite,
  Edit: parseEdit,
  Bash: parseBash,
  // PowerShell is a real, first-party Claude Code tool on native Windows,
  // auto-enabled without Git Bash — same command/description/timeout/
  // run_in_background input shape as Bash (code.claude.com/docs/en/tools-reference).
  PowerShell: parseBash,
  Grep: parseGrep,
  Glob: parseGlob,
  Agent: parseAgent,
  AskUserQuestion: parseAskUserQuestion,
  TaskCreate: parseTaskCreate,
  TaskUpdate: parseTaskUpdate,
  Skill: parseSkill,
};

function parseEditOutput(output: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof output.editSuccess === 'boolean') fields.editSuccess = output.editSuccess;
  if (typeof output.editMatched === 'boolean') fields.editMatched = output.editMatched;
  if (typeof output.editError === 'string') fields.editErrorReason = output.editError;
  return fields;
}

function parseGrepOutput(output: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof output.grepMatchCount === 'number') fields.grepMatchCount = output.grepMatchCount;
  if (typeof output.grepResultLines === 'number') fields.grepResultLines = output.grepResultLines;
  return fields;
}

function parseAgentOutput(output: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  if (typeof output.agentCompleted === 'boolean') fields.agentCompleted = output.agentCompleted;
  if (typeof output.agentInterrupted === 'boolean')
    fields.agentInterrupted = output.agentInterrupted;
  if (typeof output.agentResultLength === 'number')
    fields.agentResultLength = output.agentResultLength;
  return fields;
}

const OUTPUT_PARSERS: Record<string, (output: Record<string, unknown>) => ToolFields> = {
  Bash: (output) => {
    const fields: ToolFields = {};
    if (typeof output.exitCode === 'number') {
      fields.exitCode = output.exitCode;
    } else if (typeof output.exitCode === 'string') {
      const parsed = Number(output.exitCode);
      if (!Number.isNaN(parsed)) fields.exitCode = parsed;
    }
    return fields;
  },
  Edit: parseEditOutput,
  Grep: parseGrepOutput,
  Agent: parseAgentOutput,
};

/**
 * Extract tool-specific structured fields from a tool's input and output.
 * Returns a flat record of fields to spread into the ToolCallRecord.
 * Unknown tools or parsing errors return {}.
 */
export function parseToolSpecificFields(
  toolName: string,
  input: unknown,
  output: unknown,
): ToolFields {
  try {
    const fields: ToolFields = {};

    // Normalize tool name: try exact match first, then capitalize first letter
    // to handle variants like "read" → "Read" from non-Claude-Code platforms.
    const normalizedName =
      INPUT_PARSERS[toolName] !== undefined
        ? toolName
        : toolName.charAt(0).toUpperCase() + toolName.slice(1);

    // Parse input fields
    const inputParser = INPUT_PARSERS[normalizedName];
    if (inputParser && input !== null && input !== undefined && typeof input === 'object') {
      Object.assign(fields, inputParser(input as Record<string, unknown>));
    }

    // Parse output fields
    const outputParser = OUTPUT_PARSERS[normalizedName];
    if (outputParser && output !== null && output !== undefined && typeof output === 'object') {
      Object.assign(fields, outputParser(output as Record<string, unknown>));
    }

    return fields;
  } catch {
    return {};
  }
}
