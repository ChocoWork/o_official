import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface ListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
}

export function List<T>({ items, renderItem, className }: ListProps<T>) {
  return <ul className={cn('space-y-2', className)}>{items.map((item, index) => <li key={index}>{renderItem(item, index)}</li>)}</ul>;
}
