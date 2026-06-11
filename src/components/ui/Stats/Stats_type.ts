import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface StatItem {
  label: string;
  value: string;
  icon?: ReactNode;
}

export interface StatsProps {
  items: readonly StatItem[];
  className?: string;
  cardClassName?: string;
  valueClassName?: string;
  labelClassName?: string;
  /** コンポーネントサイズ。デフォルト md。data-ui-size 経由で --ui-font-size に連動。 */
  size?: ComponentSize;
}
