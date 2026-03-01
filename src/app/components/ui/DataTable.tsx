import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableProps<T> {
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  emptyLabel?: string;
  containerClassName?: string;
  tableClassName?: string;
  headerClassName?: string;
  rowClassName?: string | ((row: T, index: number) => string);
  hoverableRows?: boolean;
}

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
}: DataTableProps<T>) {
  return (
    <div className={cn('overflow-x-auto border border-[#d5d0c9]', containerClassName)}>
      <table className={cn('w-full min-w-[720px]', tableClassName)}>
        <thead className={cn('bg-[#f5f5f5]', headerClassName)}>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={cn(
                  'px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin',
                  column.className,
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-6 py-10 text-center text-sm text-[#474747]" colSpan={columns.length}>
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'border-t border-[#d5d0c9]',
                  hoverableRows ? 'transition-colors hover:bg-[#f5f5f5]' : null,
                  typeof rowClassName === 'function' ? rowClassName(row, index) : rowClassName,
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn('px-6 py-4 text-sm text-black', column.className, column.cellClassName)}
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
