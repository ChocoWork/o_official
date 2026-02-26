import { cn } from '@/lib/utils';
import type { SelectHTMLAttributes } from 'react';
import { controlBaseClass, type SelectOption } from './shared';

export interface SingleSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: SelectOption[];
  placeholder?: string;
}

export function SingleSelect({ label, options, className, id, placeholder, ...props }: SingleSelectProps) {
  const selectId = id ?? props.name;
  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-wider text-black/80 font-brand">{label}</span> : null}
      <select id={selectId} className={cn(controlBaseClass, 'cursor-pointer pr-8', className)} {...props}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
