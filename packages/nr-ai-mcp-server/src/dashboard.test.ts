import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dashboardPath = resolve(__dirname, '..', 'dashboards', 'ai-coding-assistant-overview.json');
const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));

interface Widget {
  title: string;
  layout: { column: number; row: number; width: number; height: number };
  visualization: { id: string };
  rawConfiguration: {
    nrqlQueries: Array<{ accountIds: number[]; query: string }>;
  };
}

interface Page {
  name: string;
  widgets: Widget[];
}

function getAllQueries(): string[] {
  const queries: string[] = [];
  for (const page of dashboard.pages as Page[]) {
    for (const widget of page.widgets) {
      for (const nrql of widget.rawConfiguration.nrqlQueries) {
        queries.push(nrql.query);
      }
    }
  }
  return queries;
}

describe('AI Coding Assistant Dashboard', () => {
  it('has valid NR dashboard structure', () => {
    expect(dashboard.name).toBe('AI Coding Assistant — Overview');
    expect(Array.isArray(dashboard.pages)).toBe(true);
    expect(dashboard.pages.length).toBeGreaterThan(0);

    for (const page of dashboard.pages as Page[]) {
      expect(page.name).toBeTruthy();
      expect(Array.isArray(page.widgets)).toBe(true);
      expect(page.widgets.length).toBeGreaterThan(0);

      for (const widget of page.widgets) {
        expect(widget.title).toBeTruthy();
        expect(widget.layout).toBeDefined();
        expect(widget.layout.column).toBeGreaterThanOrEqual(1);
        expect(widget.layout.row).toBeGreaterThanOrEqual(1);
        expect(widget.layout.width).toBeGreaterThan(0);
        expect(widget.layout.height).toBeGreaterThan(0);
        expect(widget.visualization.id).toBeTruthy();
        expect(Array.isArray(widget.rawConfiguration.nrqlQueries)).toBe(true);
        expect(widget.rawConfiguration.nrqlQueries.length).toBeGreaterThan(0);
      }
    }
  });

  it('every NRQL query contains SELECT and FROM', () => {
    const queries = getAllQueries();
    expect(queries.length).toBeGreaterThan(0);

    for (const query of queries) {
      expect(query).toMatch(/SELECT/i);
      expect(query).toMatch(/FROM/i);
    }
  });

  it('all FROM clauses reference AiToolCall or Metric', () => {
    const queries = getAllQueries();
    const validEventTypes = new Set(['AiToolCall', 'Metric']);

    for (const query of queries) {
      const fromMatch = query.match(/FROM\s+(\w+)/i);
      expect(fromMatch).not.toBeNull();
      expect(validEventTypes.has(fromMatch![1])).toBe(true);
    }
  });

  it('all accountIds arrays are empty (deploy script injects them)', () => {
    for (const page of dashboard.pages as Page[]) {
      for (const widget of page.widgets) {
        for (const nrql of widget.rawConfiguration.nrqlQueries) {
          expect(nrql.accountIds).toEqual([]);
        }
      }
    }
  });

  it('deploy script contains dashboardCreate mutation', () => {
    const scriptPath = resolve(__dirname, '..', 'scripts', 'deploy-dashboard.ts');
    const scriptSource = readFileSync(scriptPath, 'utf-8');

    expect(scriptSource).toContain('dashboardCreate');
    expect(scriptSource).toContain('DashboardInput');
    expect(scriptSource).toContain('entityResult');
    expect(scriptSource).toContain('ai-coding-assistant-overview.json');
  });
});
