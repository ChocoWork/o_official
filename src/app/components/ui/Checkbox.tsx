import { cn } from '@/lib/utils';
import type { InputHTMLAttributes, ReactNode } from 'react';

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
}

export function Checkbox({ label, className, id, ...props }: CheckboxProps) {
  const checkboxId = id ?? props.name;
  return (
    <label htmlFor={checkboxId} className={cn('flex items-center gap-3 text-sm text-black', props.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer group')}>
      <input id={checkboxId} type="checkbox" className={cn('h-5 w-5 accent-black', props.disabled ? 'cursor-not-allowed' : 'cursor-pointer', className)} {...props} />
      <span className={cn('transition-colors', !props.disabled ? 'group-hover:text-[#474747]' : null)}>{label}</span>
    </label>
  );
}
