import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel } from './Panel';

describe('Panel', () => {
  it('renders the title and children', () => {
    render(
      <Panel title="Cache health">
        <div>body content</div>
      </Panel>,
    );
    expect(screen.getByText('Cache health')).toBeInTheDocument();
    expect(screen.getByText('body content')).toBeInTheDocument();
  });

  it('renders the subtitle after the title', () => {
    render(
      <Panel title="Spend" subtitle="Last 30 days">
        <div>body</div>
      </Panel>,
    );
    expect(screen.getByText('Last 30 days')).toBeInTheDocument();
  });

  it('renders the tooltip info button when tooltip is set', () => {
    render(
      <Panel title="Spend" tooltip="Explains the panel">
        <div>body</div>
      </Panel>,
    );
    expect(screen.getByRole('button', { name: 'What is this?' })).toBeInTheDocument();
  });

  it('renders the action slot', () => {
    render(
      <Panel title="Spend" action={<button type="button">Toggle</button>}>
        <div>body</div>
      </Panel>,
    );
    expect(screen.getByRole('button', { name: 'Toggle' })).toBeInTheDocument();
  });

  it('renders the footnote under the children', () => {
    render(
      <Panel title="Spend" footnote="Attribution rate: 82%">
        <div>body</div>
      </Panel>,
    );
    expect(screen.getByText('Attribution rate: 82%')).toBeInTheDocument();
  });

  it('omits the tooltip, subtitle, action, and footnote when not provided', () => {
    render(
      <Panel title="Spend">
        <div>body</div>
      </Panel>,
    );
    expect(screen.queryByRole('button', { name: 'What is this?' })).not.toBeInTheDocument();
  });
});
