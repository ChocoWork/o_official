import { cn } from '@/lib/utils';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { controlBaseClass } from './shared';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helperText?: string;
  errorText?: string;
  leadingIcon?: ReactNode;
}

export function TextField({ label, helperText, errorText, leadingIcon, className, id, ...props }: TextFieldProps) {
  const fieldId = id ?? props.name;

  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <span className="relative block">
        {leadingIcon ? (
          <span className="pointer-events-none absolute left-4 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-black/60">
            {leadingIcon}
          </span>
        ) : null}
        <input
          id={fieldId}
          className={cn(
            controlBaseClass,
            'disabled:border-black/10 disabled:bg-[#f5f5f5] disabled:text-black/40 disabled:opacity-100',
            leadingIcon ? 'pl-12' : null,
            className,
          )}
          {...props}
        />
      </span>
      {errorText ? <span className="text-xs text-red-600">{errorText}</span> : null}
      {!errorText && helperText ? <span className="text-xs text-[#474747]">{helperText}</span> : null}
    </label>
  );
}
