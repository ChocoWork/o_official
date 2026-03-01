import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface ListProps<T> {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  itemKey?: (item: T, index: number) => string;
  className?: string;
}

export function List<T>({ items, renderItem, itemKey, className }: ListProps<T>) {
  return (
    <ul className={cn('space-y-2', className)}>
      {items.map((item, index) => (
        <li key={itemKey ? itemKey(item, index) : index}>{renderItem(item, index)}</li>
      ))}
    </ul>
  );
}
