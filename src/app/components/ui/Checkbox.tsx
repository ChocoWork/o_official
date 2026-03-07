import { cn } from '@/lib/utils';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { ComponentSize } from './types';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: ReactNode;
  size?: ComponentSize;
}

export function Checkbox({ label, className, id, size = 'md', ...props }: CheckboxProps) {
  // checkbox square dimensions – identical to RadioButtonGroup's map
  // md corresponds to previous hardcoded value; sm/lg step down/up
  const dimensionMap: Record<ComponentSize, string> = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5', // same as radio button
    lg: 'h-6 w-6',
  };
  const dimension = dimensionMap[size];
  const checkboxId = id ?? props.name;
  // label text size uses same scale as RadioButtonGroup
  const labelTextSizeMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };
  const labelTextSize = labelTextSizeMap[size];

  return (
    <label htmlFor={checkboxId} className={cn('flex items-center gap-3', labelTextSize, 'text-black', props.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer group')}>
      <input id={checkboxId} type="checkbox" className={cn(`${dimension} accent-black`, props.disabled ? 'cursor-not-allowed' : 'cursor-pointer', className)} {...props} />
      <span className={cn('transition-colors', !props.disabled ? 'group-hover:text-[#474747]' : null)}>{label}</span>
    </label>
  );
}
