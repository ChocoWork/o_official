import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

export interface DataTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyLabel?: string;
}

export function DataTable<T>({ columns, rows, rowKey, emptyLabel = 'データがありません' }: DataTableProps<T>) {
  return (
    <div className="overflow-x-auto border border-[#d5d0c9]">
      <table className="w-full min-w-[720px]">
        <thead className="bg-[#f5f5f5]">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={cn('px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin', column.className)}>
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
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-[#d5d0c9]">
                {columns.map((column) => (
                  <td key={column.key} className={cn('px-6 py-4 text-sm text-black', column.className)}>
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
