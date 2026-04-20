import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Load all dashboard JSON files from the dashboards/ directory
// ---------------------------------------------------------------------------

const dashboardsDir = resolve(__dirname, '..', 'dashboards');
const dashboardFiles = readdirSync(dashboardsDir).filter(f => f.endsWith('.json'));

interface Widget {
  title: string;
  layout: { column: number; row: number; width: number; height: number };
  visualization: { id: string };
  rawConfiguration: {
    nrqlQueries: Array<{ accountIds: number[]; query: string }>;
    [key: string]: unknown;
  };
}

interface Page {
  name: string;
  widgets: Widget[];
}

interface Dashboard {
  name: string;
  description?: string;
  permissions?: string;
  pages: Page[];
}

const dashboards: Array<{ file: string; dashboard: Dashboard }> = dashboardFiles.map(file => ({
  file,
  dashboard: JSON.parse(readFileSync(resolve(dashboardsDir, file), 'utf-8')),
}));

function getAllQueries(dashboard: Dashboard): string[] {
  const queries: string[] = [];
  for (const page of dashboard.pages) {
    for (const widget of page.widgets) {
      for (const nrql of widget.rawConfiguration.nrqlQueries) {
        queries.push(nrql.query);
      }
    }
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Structural validation — runs for every dashboard
// ---------------------------------------------------------------------------

describe.each(dashboards)('Dashboard: $file', ({ file, dashboard }) => {
  it('has valid NR dashboard structure', () => {
    expect(dashboard.name).toBeTruthy();
    expect(Array.isArray(dashboard.pages)).toBe(true);
    expect(dashboard.pages.length).toBeGreaterThan(0);

    for (const page of dashboard.pages) {
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
    const queries = getAllQueries(dashboard);
    expect(queries.length).toBeGreaterThan(0);

    for (const query of queries) {
      expect(query).toMatch(/SELECT/i);
      expect(query).toMatch(/FROM/i);
    }
  });

  it('all FROM clauses reference known event types', () => {
    const queries = getAllQueries(dashboard);
    const validEventTypes = new Set(['AiToolCall', 'Metric', 'AiCodingTask', 'AiAntiPattern', 'AiAuditEvent', 'SecurityAlert', 'AiMcpToolCall']);

    for (const query of queries) {
      const fromMatch = query.match(/FROM\s+(\w+)/i);
      expect(fromMatch).not.toBeNull();
      expect(validEventTypes).toContain(fromMatch![1]);
    }
  });

  it('all widget titles are non-empty strings', () => {
    for (const page of dashboard.pages) {
      for (const widget of page.widgets) {
        expect(typeof widget.title).toBe('string');
        expect(widget.title.length).toBeGreaterThan(0);
      }
    }
  });

  it('all accountIds arrays are empty (deploy script injects them)', () => {
    for (const page of dashboard.pages) {
      for (const widget of page.widgets) {
        for (const nrql of widget.rawConfiguration.nrqlQueries) {
          expect(nrql.accountIds).toEqual([]);
        }
      }
    }
  });

  it('widget columns stay within the 12-column grid', () => {
    for (const page of dashboard.pages) {
      for (const widget of page.widgets) {
        const rightEdge = widget.layout.column + widget.layout.width - 1;
        expect(rightEdge).toBeLessThanOrEqual(12);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Specific dashboard expectations
// ---------------------------------------------------------------------------

describe('Overview dashboard', () => {
  const overview = dashboards.find(d => d.file === 'ai-coding-assistant-overview.json');

  it('exists', () => {
    expect(overview).toBeDefined();
  });

  it('has the correct name', () => {
    expect(overview!.dashboard.name).toBe('AI Coding Assistant — Overview');
  });
});

describe('Team View dashboard', () => {
  const teamView = dashboards.find(d => d.file === 'ai-coding-assistant-team-view.json');

  it('exists', () => {
    expect(teamView).toBeDefined();
  });

  it('has the correct name', () => {
    expect(teamView!.dashboard.name).toBe('AI Coding Assistant — Team View');
  });

  it('has 4 rows of widgets (14 total)', () => {
    expect(teamView!.dashboard.pages[0].widgets).toHaveLength(14);
  });

  it('includes FACET developer queries for team comparison', () => {
    const queries = getAllQueries(teamView!.dashboard);
    const developerFacetQueries = queries.filter(q => q.includes('FACET developer'));
    expect(developerFacetQueries.length).toBeGreaterThanOrEqual(3);
  });

  it('includes TIMESERIES queries for trend analysis', () => {
    const queries = getAllQueries(teamView!.dashboard);
    const timeseriesQueries = queries.filter(q => q.includes('TIMESERIES'));
    expect(timeseriesQueries.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Security Audit dashboard', () => {
  const security = dashboards.find(d => d.file === 'ai-coding-assistant-security.json');

  it('exists', () => {
    expect(security).toBeDefined();
  });

  it('has the correct name', () => {
    expect(security!.dashboard.name).toBe('AI Coding Assistant — Security Audit');
  });

  it('has 4 rows of widgets (10 total)', () => {
    expect(security!.dashboard.pages[0].widgets).toHaveLength(10);
  });

  it('includes audit.security_alert filter queries', () => {
    const queries = getAllQueries(security!.dashboard);
    const alertQueries = queries.filter(q => q.includes('audit.security_alert'));
    expect(alertQueries.length).toBeGreaterThanOrEqual(2);
  });

  it('includes audit.severity filter queries', () => {
    const queries = getAllQueries(security!.dashboard);
    const severityQueries = queries.filter(q => q.includes('audit.severity'));
    expect(severityQueries.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Platform Comparison dashboard', () => {
  const platformComparison = dashboards.find(d => d.file === 'ai-coding-assistant-platform-comparison.json');

  it('exists', () => {
    expect(platformComparison).toBeDefined();
  });

  it('has the correct name', () => {
    expect(platformComparison!.dashboard.name).toBe('AI Coding Assistant — Platform Comparison');
  });

  it('has 5 rows of widgets (15 total)', () => {
    expect(platformComparison!.dashboard.pages[0].widgets).toHaveLength(15);
  });

  it('all non-billboard NRQL queries include FACET platform for cross-platform comparison', () => {
    const widgets = platformComparison!.dashboard.pages[0].widgets.filter(
      w => w.visualization.id !== 'viz.billboard' && w.visualization.id !== 'viz.markdown'
    );
    for (const widget of widgets) {
      for (const nrql of widget.rawConfiguration.nrqlQueries) {
        expect(nrql.query).toMatch(/FACET.*platform/i);
      }
    }
  });

  it('includes TIMESERIES queries for trend analysis', () => {
    const queries = getAllQueries(platformComparison!.dashboard);
    const timeseriesQueries = queries.filter(q => q.includes('TIMESERIES'));
    expect(timeseriesQueries.length).toBeGreaterThanOrEqual(2);
  });

  it('includes a markdown widget for platform feature coverage', () => {
    const markdownWidgets = platformComparison!.dashboard.pages[0].widgets.filter(
      w => w.visualization.id === 'viz.markdown'
    );
    expect(markdownWidgets.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Deploy script validation
// ---------------------------------------------------------------------------

describe('Deploy script', () => {
  const scriptPath = resolve(__dirname, '..', 'scripts', 'deploy-dashboard.ts');
  const scriptSource = readFileSync(scriptPath, 'utf-8');

  it('contains dashboardCreate mutation', () => {
    expect(scriptSource).toContain('dashboardCreate');
    expect(scriptSource).toContain('DashboardInput');
    expect(scriptSource).toContain('entityResult');
  });

  it('supports CLI argument for dashboard selection', () => {
    expect(scriptSource).toContain('process.argv[2]');
    expect(scriptSource).toContain('ai-coding-assistant-overview.json');
  });
});
