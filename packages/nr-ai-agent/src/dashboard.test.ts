import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dashboardPath = resolve(__dirname, '..', 'dashboards', 'ai-overview.json');
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

describe('AI Overview Dashboard', () => {
  // ---------------------------------------------------------------------------
  // 1. Valid dashboard structure
  // ---------------------------------------------------------------------------
  it('has valid NR dashboard structure', () => {
    expect(dashboard.name).toBe('AI Overview');
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

  // ---------------------------------------------------------------------------
  // 2. Every NRQL query has valid basic syntax
  // ---------------------------------------------------------------------------
  it('every NRQL query contains SELECT and FROM', () => {
    const queries = getAllQueries();
    expect(queries.length).toBeGreaterThan(0);

    for (const query of queries) {
      expect(query).toMatch(/SELECT/i);
      expect(query).toMatch(/FROM/i);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. All queries reference correct event types
  // ---------------------------------------------------------------------------
  it('all FROM clauses reference AiRequest or AiResponse', () => {
    const queries = getAllQueries();
    const validEventTypes = new Set(['AiRequest', 'AiResponse']);

    for (const query of queries) {
      const fromMatch = query.match(/FROM\s+(\w+)/i);
      expect(fromMatch).not.toBeNull();
      expect(validEventTypes.has(fromMatch![1])).toBe(true);
    }
  });
});
