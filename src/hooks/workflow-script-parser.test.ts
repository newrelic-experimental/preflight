import { describe, expect, it, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflowScript, parseWorkflowScriptSource } from './workflow-script-parser.js';

describe('parseWorkflowScriptSource', () => {
  it('extracts a simple meta block with phases', () => {
    const src = `
      export const meta = {
        name: 'sample',
        description: 'short',
        phases: [
          { title: 'Investigate', detail: 'go' },
          { title: 'Synthesize', detail: 'merge' },
        ],
      }
      phase('Investigate')
      const a = await agent('do thing')
      const b = await agent('do another')
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('ok');
    expect(result.topology?.workflowName).toBe('sample');
    expect(result.topology?.declaredPhases).toBe(2);
    expect(result.topology?.declaredAgents).toBe(2);
    expect(result.topology?.declaredPhaseCalls).toBe(1);
  });

  it('returns parser_skip on spread in meta', () => {
    const src = `export const meta = { ...other, name: 'x' };`;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('parser_skip');
    expect(result.topology).toBeNull();
  });

  it('returns parser_skip on template literal in meta', () => {
    const src = 'export const meta = { name: `x${suffix}`, phases: [] };';
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('parser_skip');
  });

  it('returns parser_skip on computed key in meta', () => {
    const src = `export const meta = { ['name']: 'x', phases: [] };`;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('parser_skip');
  });

  it('classifies parallel literal-array width as integer', () => {
    const src = `
      export const meta = { name: 'p', phases: [{title:'a',detail:''}] };
      const r = await parallel([
        () => agent('a'),
        () => agent('b'),
        () => agent('c'),
      ])
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('ok');
    expect(result.topology?.declaredParallelWidths).toEqual([3]);
  });

  it('classifies parallel(arr.map(...)) as dynamic', () => {
    const src = `
      export const meta = { name: 'p', phases: [{title:'a',detail:''}] };
      const r = await parallel(angles.map((a) => () => agent(a.label)))
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('ok');
    expect(result.topology?.declaredParallelWidths).toEqual(['dynamic']);
  });

  it('counts multiple parallel call sites', () => {
    const src = `
      export const meta = { name: 'p', phases: [{title:'a',detail:''}] };
      await parallel([() => agent('x'), () => agent('y')])
      await parallel([() => agent('a'), () => agent('b'), () => agent('c'), () => agent('d')])
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.topology?.declaredParallelWidths).toEqual([2, 4]);
  });

  it('tolerates trailing commas in meta', () => {
    const src = `
      export const meta = {
        name: 'p',
        phases: [{title:'a', detail:'b'},],
      };
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('ok');
    expect(result.topology?.declaredPhases).toBe(1);
  });

  it('returns parser_skip when no meta block is present', () => {
    const src = `const x = 1;`;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('parser_skip');
    expect(result.reason).toBe('no_meta');
  });

  it('does not count agent() inside string literals', () => {
    const src = `
      export const meta = { name: 'p', phases: [{title:'a',detail:''}] };
      const note = "agent(should not count)"
      await agent('real')
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.topology?.declaredAgents).toBe(1);
  });

  it('classifies parallel(Array.from({length: 5}, ...)) as dynamic', () => {
    const src = `
      export const meta = { name: 'p', phases: [{title:'a',detail:''}] };
      const r = await parallel(Array.from({ length: 5 }, (_, i) => () => agent('item-' + i)))
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('ok');
    expect(result.topology?.declaredParallelWidths).toEqual(['dynamic']);
  });

  it('does not count nested parallel inside pipeline() at top level as a separate site', () => {
    // The pipeline() call wraps parallel() — the parser still finds it (regex-only, no AST)
    // but only top-level literal-array widths are counted as integers; a nested parallel
    // whose args start with a non-'[' char yields 'dynamic'.
    const src = `
      export const meta = { name: 'nested', phases: [{title:'a',detail:''}] };
      await pipeline(
        phase('collect', () => agent('gather')),
        parallel([() => agent('x'), () => agent('y')]),
      )
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('ok');
    // The parallel inside pipeline is still discovered; its width is 2 (literal array).
    // What must NOT happen is that it is counted as a separate top-level parallel site
    // in addition to any other parallel sites — only the one site found inside pipeline is present.
    expect(result.topology?.declaredParallelWidths).toEqual([2]);
  });

  it('matches the deep-research multi-phase fixture pattern', () => {
    const src = `
      export const meta = {
        name: 'deep-research',
        description: 'Fan-out web research workflow',
        phases: [
          { title: 'Seed queries', detail: 'Generate search queries from the research topic' },
          { title: 'Fetch sources', detail: 'Retrieve and parse each URL in parallel' },
          { title: 'Verify claims', detail: 'Adversarially cross-check extracted claims' },
          { title: 'Synthesize', detail: 'Merge verified findings into a cited report' },
        ],
      };

      phase('Seed queries')
      const queries = await agent('Generate 8 diverse search queries for the topic')

      phase('Fetch sources')
      const pages = await parallel(queries.map((q) => () => agent('Fetch and parse: ' + q)))

      phase('Verify claims')
      const verified = await parallel([
        () => agent('Check claim set A'),
        () => agent('Check claim set B'),
        () => agent('Check claim set C'),
      ])

      phase('Synthesize')
      const report = await agent('Merge all verified findings into a final report')
    `;
    const result = parseWorkflowScriptSource(src);
    expect(result.status).toBe('ok');
    expect(result.topology?.workflowName).toBe('deep-research');
    expect(result.topology?.declaredPhases).toBe(4);
    expect(result.topology?.declaredPhaseCalls).toBe(4);
    // queries.map(...) → dynamic; [A, B, C] → 3
    expect(result.topology?.declaredParallelWidths).toEqual(['dynamic', 3]);
    // agent calls: 'Generate', 'Fetch…'×dynamic(skipped in count—still regex), 'Check A', 'Check B', 'Check C', 'Merge'
    // The parser counts all agent() call sites regardless of nesting:
    // 1 (Seed) + 1 (Fetch inside map lambda) + 3 (Verify) + 1 (Synthesize) = 6
    expect(result.topology?.declaredAgents).toBe(6);
  });
});

describe('parseWorkflowScript', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('returns parser_skip with reason file_not_found for a missing path', () => {
    const result = parseWorkflowScript('/does/not/exist.js');
    expect(result).toEqual({ status: 'parser_skip', reason: 'file_not_found', topology: null });
  });

  it('reads a real file and returns the same topology parseWorkflowScriptSource would produce', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-script-parser-test-'));
    const src = `
      export const meta = {
        name: 'sample',
        phases: [{ title: 'Investigate', detail: 'go' }],
      }
      phase('Investigate')
      const a = await agent('do thing')
    `;
    const path = join(tmpDir, 'workflow.js');
    writeFileSync(path, src);

    const fileResult = parseWorkflowScript(path);
    const sourceResult = parseWorkflowScriptSource(src);

    expect(fileResult.status).toBe('ok');
    expect(fileResult).toEqual(sourceResult);
  });
});
