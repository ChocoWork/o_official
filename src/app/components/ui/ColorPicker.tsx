import { cn } from '@/lib/utils';
import type { InputHTMLAttributes } from 'react';

export interface ColorPickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export function ColorPicker({ label, className, ...props }: ColorPickerProps) {
  return (
    <label className="inline-flex items-center gap-3">
      {label ? <span className="text-xs tracking-wider text-[#474747] font-brand">{label}</span> : null}
      <input type="color" className={cn('h-10 w-16 cursor-pointer border border-black/20', className)} {...props} />
    </label>
  );
}
