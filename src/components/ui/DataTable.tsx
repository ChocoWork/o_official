import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import type { ComponentSize } from './types';

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
  size?: ComponentSize;
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
  size = 'md',
}: DataTableProps<T>) {
  // size maps
  const paddingMap: Record<ComponentSize, { px: string; py: string }> = {
    sm: { px: 'px-1', py: 'py-1' },
    md: { px: 'px-2', py: 'py-2' },
    lg: { px: 'px-3', py: 'py-3' },
  };
  const textMap: Record<ComponentSize, { header: string; cell: string; empty: string }> = {
    sm: { header: 'text-xs', cell: 'text-sm', empty: 'text-xs' },
    md: { header: 'text-xs', cell: 'text-sm', empty: 'text-sm' },
    lg: { header: 'text-sm', cell: 'text-base', empty: 'text-sm' },
  };

  const { px, py } = paddingMap[size];
  const { header: headerText, cell: cellText, empty: emptyText } = textMap[size];

  return (
    <div className={cn('overflow-auto border border-[#d5d0c9]', containerClassName)}>
      <table className={cn('w-full', tableClassName)}>
        <thead className={cn('bg-[#f5f5f5]', headerClassName)}>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={cn(
                  px,
                  py,
                  'text-left tracking-widest text-[#474747] font-acumin',
                  headerText,
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
              <td className={cn(px, py, 'text-center', emptyText, 'text-[#474747]')} colSpan={columns.length}>
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
                    className={cn(px, py, cellText, 'text-black', column.className, column.cellClassName)}
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
