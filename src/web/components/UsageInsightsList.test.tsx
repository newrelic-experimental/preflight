/**
 * @jest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageInsightsList } from './UsageInsightsList';

describe('UsageInsightsList', () => {
  it('renders each headline and its advice', () => {
    render(
      <UsageInsightsList
        insights={[
          { id: 'a', headline: 'High-context sessions are driving spend', advice: 'Trim context.' },
          { id: 'b', headline: 'Subagent delegation is a large cost driver', advice: 'Review it.' },
        ]}
      />,
    );
    expect(screen.getByText('High-context sessions are driving spend')).toBeInTheDocument();
    expect(screen.getByText('Trim context.')).toBeInTheDocument();
    expect(screen.getByText('Subagent delegation is a large cost driver')).toBeInTheDocument();
    expect(screen.getByText('Review it.')).toBeInTheDocument();
  });

  it('shows the default empty text when insights is empty', () => {
    render(<UsageInsightsList insights={[]} />);
    expect(screen.getByText('Nothing stands out in this window.')).toBeInTheDocument();
  });

  it('shows a custom empty text when given one', () => {
    render(<UsageInsightsList insights={[]} emptyText="No standouts here." />);
    expect(screen.getByText('No standouts here.')).toBeInTheDocument();
  });
});
