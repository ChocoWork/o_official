import type { InputHTMLAttributes } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  showClearButton?: boolean;
  onClear?: () => void;
  size?: ComponentSize;
}
