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
      expect(fields.promptLength).toBe('Find all authentication-related files in the codebase'.length);
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
