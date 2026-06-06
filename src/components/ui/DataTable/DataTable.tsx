// File: src/components/ui/DataTable/DataTable.tsx
import './DataTable.css';
import { cn } from '@/lib/utils';
import type { ComponentSize } from '@/components/ui/types';
import type { DataTableProps } from '@/components/ui/DataTable/DataTable_type';

export type { TableColumn, DataTableProps } from '@/components/ui/DataTable/DataTable_type';

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyLabel = 'データがありません',
  containerClassName,
  tableClassName,
  headerClassName,
  rowClassName,
  hoverableRows = false,
  striped = false,
  size = 'md',
}: DataTableProps<T>) {
  const rootDataAttrs = {
    'data-ui-data-table': 'true',
    'data-ui-data-table-size': size,
    'data-ui-data-table-hoverable': hoverableRows ? 'true' : undefined,
    'data-ui-data-table-striped': striped ? 'true' : undefined,
  } as const;

  const isEmpty = rows.length === 0;

  return (
    <div className={cn('data-table', containerClassName)} {...rootDataAttrs}>
      <table className={cn('data-table__table', tableClassName)}>
        <thead className={cn('data-table__head', headerClassName)}>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn('data-table__th', column.className, column.headerClassName)}
                data-align={column.align ?? 'left'}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isEmpty ? (
            <tr className="data-table__row">
              <td className="data-table__empty-cell" colSpan={columns.length}>
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'data-table__row',
                  typeof rowClassName === 'function' ? rowClassName(row, index) : rowClassName,
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn('data-table__td', column.className, column.cellClassName)}
                    data-align={column.align ?? 'left'}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}