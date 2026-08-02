import type { InputHTMLAttributes } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  showClearButton?: boolean;
  onClear?: () => void;
  /** 指定時は右端に検索実行ボタンを表示し、Enterキーでも実行する。 */
  onSearch?: () => void;
  searchButtonAriaLabel?: string;
  size?: ComponentSize;
}
