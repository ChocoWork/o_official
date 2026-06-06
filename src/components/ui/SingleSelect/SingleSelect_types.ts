// File: src/components/ui/SingleSelect/SingleSelect_types.ts
import type { SelectHTMLAttributes } from 'react';
import type { ComponentSize, SelectOption } from '@/components/ui/types';

export type UISingleSelectVariant = 'native' | 'dropdown';

export interface SingleSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  options: SelectOption[];
  placeholder?: string;
  variant?: UISingleSelectVariant;
  onValueChange?: (value: string) => void;
  /** demo-friendly size: xs/sm/md/lg/xl default md */
  size?: ComponentSize;
}