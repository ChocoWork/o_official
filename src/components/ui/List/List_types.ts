import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

interface BaseListProps<T> {
  items: readonly T[];
  itemKey?: (item: T, index: number) => string;
  className?: string;
  size?: ComponentSize;
}

interface CustomListProps<T> extends BaseListProps<T> {
  renderItem: (item: T, index: number) => ReactNode;
  variant?: 'custom';
}

interface ShowcaseListProps<T> extends BaseListProps<T> {
  variant: 'showcase';
  getName: (item: T) => string;
  getCategory: (item: T) => string;
  getPrice: (item: T) => ReactNode;
  getImage?: (item: T) => string | null | undefined;
  getHref?: (item: T) => string;
}

export type ListProps<T> = CustomListProps<T> | ShowcaseListProps<T>;
