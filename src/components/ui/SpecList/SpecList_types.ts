import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface SpecListRow {
  /** 左列のラベル（MATERIAL / CARE / MADE IN など） */
  label: string;
  /** 右列の値。複数行のテキストも受け取れるよう ReactNode */
  value: ReactNode;
}

export interface SpecListProps {
  rows: readonly SpecListRow[];
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  /** コンポーネントサイズ。デフォルト md。data-ui-size 経由で --ui-font-size に連動。 */
  size?: ComponentSize;
  'data-testid'?: string;
}
