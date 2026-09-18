import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

export interface ShareTableColumn<Row> {
  readonly header: string;
  readonly align: 'left' | 'right';
  readonly cell: (row: Row) => ReactNode;
  readonly className?: string | ((row: Row) => string | undefined);
  readonly title?: (row: Row) => string | undefined;
  /** Present on a column makes its header a sort toggle; absent renders a plain header. */
  readonly sortValue?: (row: Row) => number | string;
}

export interface ShareTableSort {
  readonly column: number;
  readonly direction: 'asc' | 'desc';
}

export interface ShareTableProps<Row> {
  readonly title: string;
  readonly columns: ReadonlyArray<ShareTableColumn<Row>>;
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly className?: string;
  readonly defaultSort?: ShareTableSort;
  readonly hideTitle?: boolean;
  /** Distinct rows before the caller capped `rows`; when larger, the table says so. */
  readonly totalCount?: number;
}

interface SortIconProps {
  readonly direction: 'asc' | 'desc' | null;
}

function SortIcon({ direction }: SortIconProps): JSX.Element {
  if (direction === null) {
    return <ArrowUpDown className="w-3 h-3 opacity-30" aria-hidden="true" />;
  }
  return direction === 'asc' ? (
    <ArrowUp className="w-3 h-3 text-accent-amber" aria-hidden="true" />
  ) : (
    <ArrowDown className="w-3 h-3 text-accent-amber" aria-hidden="true" />
  );
}

function compareSortValues(a: number | string, b: number | string): number {
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a).localeCompare(String(b));
  }
  return a - b;
}

export function ShareTable<Row>({
  title,
  columns,
  rows,
  rowKey,
  className,
  defaultSort,
  hideTitle,
  totalCount,
}: ShareTableProps<Row>): JSX.Element {
  const capNote =
    totalCount !== undefined && totalCount > rows.length
      ? `top ${rows.length} of ${totalCount}`
      : null;
  const [sort, setSort] = useState<ShareTableSort | null>(defaultSort ?? null);

  function handleSort(columnIndex: number): void {
    setSort((current) =>
      current && current.column === columnIndex
        ? { column: columnIndex, direction: current.direction === 'desc' ? 'asc' : 'desc' }
        : { column: columnIndex, direction: 'desc' },
    );
  }

  const sortColumn = sort ? columns[sort.column] : undefined;
  const sortValue = sortColumn?.sortValue;
  const sortedRows =
    sort && sortValue
      ? [...rows].sort((a, b) => {
          const cmp = compareSortValues(sortValue(a), sortValue(b));
          return sort.direction === 'asc' ? cmp : -cmp;
        })
      : rows;

  return (
    <div className={className ? `text-xs ${className}` : 'text-xs'}>
      {!hideTitle && (
        <h4 className="text-ink-muted font-medium mb-2">
          {title}
          {capNote && <span className="text-ink-subtle font-normal ml-1">{capNote}</span>}
        </h4>
      )}
      {hideTitle && capNote && <p className="text-ink-subtle mb-1">{capNote}</p>}
      <div className="max-h-40 overflow-auto">
        <table className="w-full">
          <thead className="text-ink-muted sticky top-0 bg-bg-panel">
            <tr>
              {columns.map((col, columnIndex) => {
                const base = col.align === 'right' ? 'text-right pb-1' : 'text-left pb-1';
                if (!col.sortValue) {
                  return (
                    <th key={col.header} className={base}>
                      {col.header}
                    </th>
                  );
                }
                const activeDirection = sort?.column === columnIndex ? sort.direction : null;
                const ariaSort: 'ascending' | 'descending' | 'none' =
                  activeDirection === 'asc'
                    ? 'ascending'
                    : activeDirection === 'desc'
                      ? 'descending'
                      : 'none';
                return (
                  <th key={col.header} className={base} aria-sort={ariaSort}>
                    <button
                      type="button"
                      onClick={() => handleSort(columnIndex)}
                      className="inline-flex items-center gap-1 hover:text-ink-subtle"
                    >
                      {col.header}
                      <SortIcon direction={activeDirection} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-bg-line">
                {columns.map((col) => {
                  const base =
                    col.align === 'right' ? 'py-1 text-right tabular-nums' : 'py-1 text-ink-base';
                  const extra =
                    typeof col.className === 'function' ? col.className(row) : col.className;
                  return (
                    <td
                      key={col.header}
                      className={extra ? `${base} ${extra}` : base}
                      title={col.title?.(row)}
                    >
                      {col.cell(row)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
