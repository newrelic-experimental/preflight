import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnpricedSpendNotice } from './UnpricedSpendNotice';

describe('UnpricedSpendNotice', () => {
  it('renders nothing for undefined', () => {
    const { container } = render(<UnpricedSpendNotice unpricedByModel={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty record', () => {
    const { container } = render(<UnpricedSpendNotice unpricedByModel={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when every entry has zero calls', () => {
    const { container } = render(
      <UnpricedSpendNotice unpricedByModel={{ 'claude-foo': { calls: 0, tokens: 0 } }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the one unpriced model and warns spend is understated', () => {
    render(
      <UnpricedSpendNotice unpricedByModel={{ 'claude-opus-5-5': { calls: 14, tokens: 900 } }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '14 calls unpriced (claude-opus-5-5). Spend is understated.',
    );
  });

  it('uses the singular for one call', () => {
    render(
      <UnpricedSpendNotice unpricedByModel={{ 'claude-opus-5-5': { calls: 1, tokens: 10 } }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 call unpriced (claude-opus-5-5). Spend is understated.',
    );
  });

  it('lists at most three ids by calls desc and counts the rest', () => {
    render(
      <UnpricedSpendNotice
        unpricedByModel={{
          a: { calls: 1, tokens: 1 },
          b: { calls: 5, tokens: 1 },
          c: { calls: 3, tokens: 1 },
          d: { calls: 2, tokens: 1 },
          e: { calls: 4, tokens: 1 },
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '15 calls unpriced (b, e, c +2 more). Spend is understated.',
    );
  });

  const estimated = {
    'claude-opus-5-9': { calls: 3, tokens: 90, estimatedFrom: 'claude-opus-5' },
  };

  it('renders a muted estimate line, with no amber line, when only estimated calls exist', () => {
    render(<UnpricedSpendNotice unpricedByModel={{}} estimatedByModel={estimated} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(
      '3 calls priced from a sibling model (claude-opus-5-9 as claude-opus-5). Spend is an estimate.',
    );
    expect(status).not.toHaveTextContent('unpriced');
    expect(status.querySelector('.text-ink-muted')).not.toBeNull();
    expect(status.querySelector('[class*="accent-amber"]')).toBeNull();
  });

  it('renders the unpriced line first, then the estimate line', () => {
    render(
      <UnpricedSpendNotice
        unpricedByModel={{ 'claude-foo-9-9': { calls: 1, tokens: 1 } }}
        estimatedByModel={estimated}
      />,
    );
    const text = screen.getByRole('status').textContent ?? '';
    const unpricedAt = text.indexOf('unpriced');
    const estimateAt = text.indexOf('priced from a sibling model');
    expect(unpricedAt).toBeGreaterThanOrEqual(0);
    expect(estimateAt).toBeGreaterThan(unpricedAt);
  });

  it('lists at most three estimated models and counts the rest', () => {
    render(
      <UnpricedSpendNotice
        unpricedByModel={undefined}
        estimatedByModel={{
          a: { calls: 1, tokens: 1, estimatedFrom: 'x' },
          b: { calls: 5, tokens: 1, estimatedFrom: 'x' },
          c: { calls: 3, tokens: 1, estimatedFrom: 'x' },
          d: { calls: 2, tokens: 1, estimatedFrom: 'x' },
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '11 calls priced from a sibling model (b as x, c as x, d as x +1 more). Spend is an estimate.',
    );
  });
});
