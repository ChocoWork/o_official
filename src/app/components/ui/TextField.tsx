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
      {label ? <span className="block text-xs tracking-wider text-black/80 font-brand">{label}</span> : null}
      <span className="relative block">
        {leadingIcon ? (
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-black/60">{leadingIcon}</span>
        ) : null}
        <input id={fieldId} className={cn(controlBaseClass, leadingIcon ? 'pl-12' : null, className)} {...props} />
      </span>
      {errorText ? <span className="text-xs text-red-600">{errorText}</span> : null}
      {!errorText && helperText ? <span className="text-xs text-[#474747]">{helperText}</span> : null}
    </label>
  );
}
