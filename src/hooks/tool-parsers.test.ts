import { describe, it, expect } from '@jest/globals';
import { parseToolSpecificFields } from './tool-parsers.js';

describe('parseToolSpecificFields', () => {
  describe('Read parser', () => {
    it('extracts filePath, lineOffset, and lineLimit', () => {
      const input = { file_path: '/src/index.ts', offset: 10, limit: 50 };
      const fields = parseToolSpecificFields('Read', input, undefined);

      expect(fields.filePath).toBe('/src/index.ts');
      expect(fields.lineOffset).toBe(10);
      expect(fields.lineLimit).toBe(50);
    });

    it('extracts filePath alone when no offset/limit', () => {
      const input = { file_path: '/src/index.ts' };
      const fields = parseToolSpecificFields('Read', input, undefined);

      expect(fields.filePath).toBe('/src/index.ts');
      expect(fields.lineOffset).toBeUndefined();
      expect(fields.lineLimit).toBeUndefined();
    });
  });

  describe('Write parser', () => {
    it('extracts filePath and contentLength', () => {
      const input = { file_path: '/src/new-file.ts', content: 'hello world' };
      const fields = parseToolSpecificFields('Write', input, undefined);

      expect(fields.filePath).toBe('/src/new-file.ts');
      expect(fields.contentLength).toBe(11);
    });

    it('extracts lineCount from content', () => {
      const input = { file_path: '/src/new-file.ts', content: 'line1\nline2\nline3' };
      const fields = parseToolSpecificFields('Write', input, undefined);

      expect(fields.lineCount).toBe(3);
    });

    it('counts single line with no newlines', () => {
      const input = { file_path: '/f.ts', content: 'single line' };
      const fields = parseToolSpecificFields('Write', input, undefined);

      expect(fields.lineCount).toBe(1);
    });
  });

  describe('Edit parser', () => {
    it('extracts filePath, oldStringLength, newStringLength, replaceAll', () => {
      const input = {
        file_path: '/src/index.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
        replace_all: false,
      };
      const fields = parseToolSpecificFields('Edit', input, undefined);

      expect(fields.filePath).toBe('/src/index.ts');
      expect(fields.oldStringLength).toBe(12);
      expect(fields.newStringLength).toBe(12);
      expect(fields.replaceAll).toBe(false);
      expect(fields.isDelete).toBe(false);
    });

    it('detects isDelete when new_string is empty', () => {
      const input = {
        file_path: '/src/index.ts',
        old_string: 'const x = 1;',
        new_string: '',
      };
      const fields = parseToolSpecificFields('Edit', input, undefined);

      expect(fields.isDelete).toBe(true);
      expect(fields.newStringLength).toBe(0);
    });

    it('extracts oldLineCount and newLineCount', () => {
      const input = {
        file_path: '/src/index.ts',
        old_string: 'line1\nline2',
        new_string: 'line1\nline2\nline3\nline4',
      };
      const fields = parseToolSpecificFields('Edit', input, undefined);

      expect(fields.oldLineCount).toBe(2);
      expect(fields.newLineCount).toBe(4);
    });

    it('sets newLineCount to 0 for deletions (empty new_string)', () => {
      const input = {
        file_path: '/src/index.ts',
        old_string: 'line1\nline2\nline3',
        new_string: '',
      };
      const fields = parseToolSpecificFields('Edit', input, undefined);

      expect(fields.oldLineCount).toBe(3);
      expect(fields.newLineCount).toBe(0);
    });
  });

  describe('Bash parser', () => {
    it('extracts command and description', () => {
      const input = { command: 'ls -la', description: 'List files' };
      const fields = parseToolSpecificFields('Bash', input, undefined);

      expect(fields.command).toBe('ls -la');
      expect(fields.commandDescription).toBe('List files');
    });

    it('identifies test commands', () => {
      const testCommands = [
        'npm test',
        'npx jest --coverage',
        'jest src/',
        'pytest -v tests/',
        'go test ./...',
        'vitest run',
        'cargo test',
        'bun test',
      ];

      for (const cmd of testCommands) {
        const fields = parseToolSpecificFields('Bash', { command: cmd }, undefined);
        expect(fields.isTestCommand).toBe(true);
      }
    });

    it('identifies build commands', () => {
      const buildCommands = [
        'tsc',
        'tsc -b',
        'npm run build',
        'make',
        'cargo build',
        'go build ./...',
        'vite build',
      ];

      for (const cmd of buildCommands) {
        const fields = parseToolSpecificFields('Bash', { command: cmd }, undefined);
        expect(fields.isBuildCommand).toBe(true);
      }
    });

    it('identifies lint commands', () => {
      const lintCommands = [
        'eslint src/',
        'prettier --check .',
        'pylint mymodule',
        'golangci-lint run',
        'biome check src/',
      ];

      for (const cmd of lintCommands) {
        const fields = parseToolSpecificFields('Bash', { command: cmd }, undefined);
        expect(fields.isLintCommand).toBe(true);
      }
    });

    it('classifies non-matching commands as false for all heuristics', () => {
      const fields = parseToolSpecificFields('Bash', { command: 'git status' }, undefined);

      expect(fields.isTestCommand).toBe(false);
      expect(fields.isBuildCommand).toBe(false);
      expect(fields.isLintCommand).toBe(false);
    });

    it('extracts timeout and run_in_background', () => {
      const input = { command: 'npm start', timeout: 30000, run_in_background: true };
      const fields = parseToolSpecificFields('Bash', input, undefined);

      expect(fields.commandTimeout).toBe(30000);
      expect(fields.runInBackground).toBe(true);
    });

    it('attaches bashCategory / bashLeading / bashDestructive / bashNetwork from the classifier', () => {
      const fields = parseToolSpecificFields('Bash', { command: 'git status' }, undefined);
      expect(fields.bashCategory).toBe('git');
      expect(fields.bashLeading).toBe('git');
      expect(fields.bashDestructive).toBe(false);
      expect(fields.bashNetwork).toBe(false);
    });

    it('flags destructive bash commands via bashDestructive', () => {
      const fields = parseToolSpecificFields('Bash', { command: 'rm -rf /tmp/foo' }, undefined);
      expect(fields.bashCategory).toBe('fs-op');
      expect(fields.bashDestructive).toBe(true);
    });

    it('flags network bash commands via bashNetwork', () => {
      const fields = parseToolSpecificFields(
        'Bash',
        { command: 'curl https://example.com' },
        undefined,
      );
      expect(fields.bashCategory).toBe('network');
      expect(fields.bashNetwork).toBe(true);
    });

    it.each([
      ['cat foo.txt | grep bar', 'fs-op', 'cat'],
      ['sudo rm -rf /tmp/x', 'fs-op', 'rm'],
      ['NODE_ENV=test npm test', 'test-runner', 'npm'],
      ['docker compose up && docker compose logs', 'container', 'docker'],
      ['./scripts/deploy.sh', 'custom-script', './scripts/deploy.sh'],
    ])('parser routes %s → category=%s, leading=%s through the classifier', (cmd, cat, leading) => {
      const fields = parseToolSpecificFields('Bash', { command: cmd }, undefined);
      expect(fields.bashCategory).toBe(cat);
      expect(fields.bashLeading).toBe(leading);
    });

    it('parser does not flag git commit messages with quoted destructive substrings', () => {
      const fields = parseToolSpecificFields(
        'Bash',
        { command: 'git commit -m "rm -rf legacy"' },
        undefined,
      );
      expect(fields.bashCategory).toBe('git');
      expect(fields.bashDestructive).toBe(false);
    });
  });

  describe('PowerShell parser', () => {
    // PowerShell is a real, first-party Claude Code tool on native Windows —
    // auto-enabled without Git Bash, opt-in via CLAUDE_CODE_USE_POWERSHELL_TOOL
    // elsewhere (code.claude.com/docs/en/tools-reference, /setup, /env-vars).
    // It carries the same command/description/timeout/run_in_background input
    // shape as Bash, so it should get the same parsing.
    it('extracts command and description, same as Bash', () => {
      const input = { command: 'Get-Process', description: 'List processes' };
      const fields = parseToolSpecificFields('PowerShell', input, undefined);

      expect(fields.command).toBe('Get-Process');
      expect(fields.commandDescription).toBe('List processes');
    });

    it('extracts timeout and run_in_background', () => {
      const input = { command: 'npm start', timeout: 30000, run_in_background: true };
      const fields = parseToolSpecificFields('PowerShell', input, undefined);

      expect(fields.commandTimeout).toBe(30000);
      expect(fields.runInBackground).toBe(true);
    });

    it('attaches bashCategory / bashLeading from the same classifier as Bash', () => {
      const fields = parseToolSpecificFields('PowerShell', { command: 'git status' }, undefined);
      expect(fields.bashCategory).toBe('git');
      expect(fields.bashLeading).toBe('git');
    });
  });

  describe('Grep parser', () => {
    it('extracts pattern, grepPath, and outputMode', () => {
      const input = { pattern: 'TODO', path: '/src', output_mode: 'content' };
      const fields = parseToolSpecificFields('Grep', input, undefined);

      expect(fields.pattern).toBe('TODO');
      expect(fields.grepPath).toBe('/src');
      expect(fields.outputMode).toBe('content');
    });

    it('extracts pattern alone when no path', () => {
      const input = { pattern: 'import.*React' };
      const fields = parseToolSpecificFields('Grep', input, undefined);

      expect(fields.pattern).toBe('import.*React');
      expect(fields.grepPath).toBeUndefined();
    });
  });

  describe('Glob parser', () => {
    it('extracts pattern and globPath', () => {
      const input = { pattern: '**/*.ts', path: '/src' };
      const fields = parseToolSpecificFields('Glob', input, undefined);

      expect(fields.pattern).toBe('**/*.ts');
      expect(fields.globPath).toBe('/src');
    });
  });

  describe('Agent parser', () => {
    it('extracts agentDescription, subagentType, and promptLength', () => {
      const input = {
        description: 'Search for auth code',
        subagent_type: 'Explore',
        prompt: 'Find all authentication-related files in the codebase',
      };
      const fields = parseToolSpecificFields('Agent', input, undefined);

      expect(fields.agentDescription).toBe('Search for auth code');
      expect(fields.subagentType).toBe('Explore');
      expect(fields.promptLength).toBe(
        'Find all authentication-related files in the codebase'.length,
      );
    });

    it('extracts runInBackground flag', () => {
      const input = {
        description: 'Background task',
        prompt: 'Do work',
        run_in_background: true,
      };
      const fields = parseToolSpecificFields('Agent', input, undefined);

      expect(fields.runInBackground).toBe(true);
    });
  });

  describe('AskUserQuestion parser', () => {
    it('extracts questionCount', () => {
      const input = {
        questions: [
          { question: 'Which approach?', header: 'Approach', options: [], multiSelect: false },
          { question: 'Which lib?', header: 'Library', options: [], multiSelect: false },
        ],
      };
      const fields = parseToolSpecificFields('AskUserQuestion', input, undefined);

      expect(fields.questionCount).toBe(2);
    });
  });

  describe('TaskCreate parser', () => {
    it('extracts taskSubject', () => {
      const input = { subject: 'Fix auth bug', description: 'The login flow is broken' };
      const fields = parseToolSpecificFields('TaskCreate', input, undefined);

      expect(fields.taskSubject).toBe('Fix auth bug');
    });
  });

  describe('TaskUpdate parser', () => {
    it('extracts taskId, taskStatus, and taskSubject', () => {
      const input = { taskId: '42', status: 'completed', subject: 'Fix auth bug' };
      const fields = parseToolSpecificFields('TaskUpdate', input, undefined);

      expect(fields.taskId).toBe('42');
      expect(fields.taskStatus).toBe('completed');
      expect(fields.taskSubject).toBe('Fix auth bug');
    });
  });

  describe('Skill parser', () => {
    it('maps skill → skillName and argsLength → skillArgsLength', () => {
      const input = { skill: 'code-review', argsLength: 42 };
      const fields = parseToolSpecificFields('Skill', input, undefined);

      expect(fields.skillName).toBe('code-review');
      expect(fields.skillArgsLength).toBe(42);
    });

    it('computes argsLength from raw args string when argsLength is absent', () => {
      const input = { skill: 'pstack:how', args: 'How does this work?' };
      const fields = parseToolSpecificFields('Skill', input, undefined);

      expect(fields.skillName).toBe('pstack:how');
      expect(fields.skillArgsLength).toBe('How does this work?'.length);
    });

    it('does not include args text in output, only length', () => {
      const input = { skill: 'design', args: 'Create a button component' };
      const fields = parseToolSpecificFields('Skill', input, undefined);

      expect(fields.skillArgsLength).toBe('Create a button component'.length);
      expect(Object.values(fields).includes('Create a button component')).toBe(false);
    });

    it('returns empty when skill is not a string', () => {
      const input = { skill: 123, args: 'test' };
      const fields = parseToolSpecificFields('Skill', input, undefined);

      expect(fields.skillName).toBeUndefined();
    });

    it('handles lowercase "skill" tool name via capitalize fallback', () => {
      const input = { skill: 'foo', args: 'bar' };
      const fields = parseToolSpecificFields('skill', input, undefined);

      expect(fields.skillName).toBe('foo');
      expect(fields.skillArgsLength).toBe(3);
    });
  });

  describe('Bash output parser', () => {
    it('extracts exitCode from tool response', () => {
      const input = { command: 'npm test' };
      const output = { exitCode: 0, stdout: 'ok' };
      const fields = parseToolSpecificFields('Bash', input, output);

      expect(fields.exitCode).toBe(0);
      expect(fields.command).toBe('npm test');
    });

    it('extracts non-zero exitCode', () => {
      const fields = parseToolSpecificFields('Bash', { command: 'false' }, { exitCode: 1 });
      expect(fields.exitCode).toBe(1);
    });

    it('does not set exitCode when output lacks it', () => {
      const fields = parseToolSpecificFields('Bash', { command: 'ls' }, { stdout: 'files' });
      expect(fields.exitCode).toBeUndefined();
    });

    it('does not set exitCode when output is null', () => {
      const fields = parseToolSpecificFields('Bash', { command: 'ls' }, null);
      expect(fields.exitCode).toBeUndefined();
    });
  });

  describe('Edit output parser', () => {
    it('extracts editSuccess and editMatched', () => {
      const output = { editSuccess: true, editMatched: true };
      const fields = parseToolSpecificFields(
        'Edit',
        { file_path: '/f.ts', old_string: 'a', new_string: 'b' },
        output,
      );

      expect(fields.editSuccess).toBe(true);
      expect(fields.editMatched).toBe(true);
    });

    it('extracts editErrorReason on failure', () => {
      const output = { editSuccess: false, editError: 'old_string not found in file' };
      const fields = parseToolSpecificFields('Edit', { file_path: '/f.ts' }, output);

      expect(fields.editSuccess).toBe(false);
      expect(fields.editErrorReason).toBe('old_string not found in file');
    });

    it('returns empty fields when output has no recognized keys', () => {
      const fields = parseToolSpecificFields('Edit', { file_path: '/f.ts' }, { unrelated: 42 });
      expect(fields.editSuccess).toBeUndefined();
      expect(fields.editMatched).toBeUndefined();
      expect(fields.editErrorReason).toBeUndefined();
    });

    it('returns empty fields when output is null', () => {
      const fields = parseToolSpecificFields('Edit', { file_path: '/f.ts' }, null);
      expect(fields.editSuccess).toBeUndefined();
    });
  });

  describe('Grep output parser', () => {
    it('extracts grepMatchCount from matchCount', () => {
      const output = { grepMatchCount: 5 };
      const fields = parseToolSpecificFields('Grep', { pattern: 'TODO' }, output);

      expect(fields.grepMatchCount).toBe(5);
    });

    it('extracts grepResultLines', () => {
      const output = { grepResultLines: 12 };
      const fields = parseToolSpecificFields('Grep', { pattern: 'TODO' }, output);

      expect(fields.grepResultLines).toBe(12);
    });

    it('returns empty fields when output has no recognized keys', () => {
      const fields = parseToolSpecificFields('Grep', { pattern: 'x' }, { foo: 'bar' });
      expect(fields.grepMatchCount).toBeUndefined();
      expect(fields.grepResultLines).toBeUndefined();
    });

    it('returns empty fields when output is undefined', () => {
      const fields = parseToolSpecificFields('Grep', { pattern: 'x' }, undefined);
      expect(fields.grepMatchCount).toBeUndefined();
    });
  });

  describe('Agent output parser', () => {
    it('extracts agentCompleted', () => {
      const output = { agentCompleted: true, agentResultLength: 500 };
      const fields = parseToolSpecificFields('Agent', { prompt: 'Do work' }, output);

      expect(fields.agentCompleted).toBe(true);
      expect(fields.agentResultLength).toBe(500);
    });

    it('extracts agentInterrupted', () => {
      const output = { agentInterrupted: true };
      const fields = parseToolSpecificFields('Agent', { prompt: 'Do work' }, output);

      expect(fields.agentInterrupted).toBe(true);
    });

    it('returns empty fields when output has no recognized keys', () => {
      const fields = parseToolSpecificFields('Agent', { prompt: 'x' }, { foo: 'bar' });
      expect(fields.agentCompleted).toBeUndefined();
      expect(fields.agentInterrupted).toBeUndefined();
      expect(fields.agentResultLength).toBeUndefined();
    });

    it('returns empty fields when output is null', () => {
      const fields = parseToolSpecificFields('Agent', { prompt: 'x' }, null);
      expect(fields.agentCompleted).toBeUndefined();
    });
  });

  describe('unknown tools', () => {
    it('returns empty record for unknown tool name', () => {
      const fields = parseToolSpecificFields('SomeNewTool', { foo: 'bar' }, undefined);
      expect(fields).toEqual({});
    });
  });

  describe('edge cases', () => {
    it('handles null input gracefully', () => {
      const fields = parseToolSpecificFields('Read', null, null);
      expect(fields).toEqual({});
    });

    it('handles undefined input gracefully', () => {
      const fields = parseToolSpecificFields('Read', undefined, undefined);
      expect(fields).toEqual({});
    });

    it('handles empty object input', () => {
      const fields = parseToolSpecificFields('Read', {}, undefined);
      expect(fields).toEqual({});
    });
  });
});
