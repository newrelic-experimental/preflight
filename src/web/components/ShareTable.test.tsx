/**
 * @jest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareTable, type ShareTableColumn } from './ShareTable';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}

const ROWS: readonly Row[] = [
  { id: 'a', name: 'Alpha', value: 10 },
  { id: 'b', name: 'Beta', value: 30 },
  { id: 'c', name: 'Gamma', value: 20 },
];

const COLUMNS: ReadonlyArray<ShareTableColumn<Row>> = [
  { header: 'Name', align: 'left', cell: (row) => row.name },
  {
    header: 'Value',
    align: 'right',
    cell: (row) => row.value,
    sortValue: (row) => row.value,
  },
];

function bodyRowNames(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent ?? '');
}

describe('ShareTable', () => {
  it('says how many rows were dropped when totalCount exceeds the rows given', () => {
    render(
      <ShareTable
        title="Rows"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        totalCount={12}
      />,
    );
    expect(screen.getByText('top 3 of 12')).toBeInTheDocument();
  });

  it('says nothing about a cap when totalCount matches the rows or is absent', () => {
    const { rerender } = render(
      <ShareTable
        title="Rows"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        totalCount={3}
      />,
    );
    expect(screen.queryByText(/top \d+ of/)).not.toBeInTheDocument();
    rerender(<ShareTable title="Rows" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(screen.queryByText(/top \d+ of/)).not.toBeInTheDocument();
  });

  it('puts the cap note on its own line when the title is hidden', () => {
    render(
      <ShareTable
        title="Rows"
        hideTitle
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        totalCount={5}
      />,
    );
    expect(screen.queryByText('Rows')).not.toBeInTheDocument();
    expect(screen.getByText('top 3 of 5')).toBeInTheDocument();
  });

  it('renders rows in the given order by default', () => {
    render(<ShareTable title="Rows" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(bodyRowNames()).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Beta'),
      expect.stringContaining('Gamma'),
    ]);
  });

  it('sorts a clicked column descending, then ascending on a second click', async () => {
    const user = userEvent.setup();
    render(<ShareTable title="Rows" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);

    await user.click(screen.getByRole('button', { name: 'Value' }));
    expect(bodyRowNames()).toEqual([
      expect.stringContaining('Beta'),
      expect.stringContaining('Gamma'),
      expect.stringContaining('Alpha'),
    ]);
    expect(screen.getByRole('columnheader', { name: 'Value' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );

    await user.click(screen.getByRole('button', { name: 'Value' }));
    expect(bodyRowNames()).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Gamma'),
      expect.stringContaining('Beta'),
    ]);
    expect(screen.getByRole('columnheader', { name: 'Value' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('renders a non-sortable header as plain text with no button or aria-sort', () => {
    render(<ShareTable title="Rows" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(screen.queryByRole('button', { name: 'Name' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort');
  });
});
