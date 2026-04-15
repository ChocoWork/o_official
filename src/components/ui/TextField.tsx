import { cn } from '@/lib/utils';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { controlBaseClass } from './shared';
import { ComponentSize } from './types';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  helperText?: string;
  errorText?: string;
  leadingIcon?: ReactNode;
  /** デモ用の小中大サイズ */
  size?: ComponentSize;
}

export function TextField({ label, helperText, errorText, leadingIcon, className, id, size = 'md', ...props }: TextFieldProps) {
  const fieldId = id ?? props.name;
  const errorId = fieldId ? `${fieldId}-error` : undefined;
  const helperId = fieldId ? `${fieldId}-helper` : undefined;
  const heightClass = size === 'sm' ? 'h-8' : size === 'lg' ? 'h-12' : 'h-10';
  // single-select uses controlBaseClass which already includes `px-4`,
  // so keep the same horizontal gutter by default.  this ensures the
  // text start aligns perfectly between the two components.
  const widthPaddingClass = 'px-4';
  const paddingClass = leadingIcon
    ? // icon concerns override left padding only – keep same base px-4 on
      // the right side consistently
      size === 'sm'
      ? 'pl-10 '
      : 'pl-12 '
    : undefined;

  const describedBy = [
    errorText && errorId ? errorId : null,
    !errorText && helperText && helperId ? helperId : null,
  ]
    .filter(Boolean)
    .join(' ') || undefined;

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
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          className={cn(
            controlBaseClass,
            heightClass,
            widthPaddingClass,
            'disabled:border-black/10 disabled:bg-[#f5f5f5] disabled:text-black/40 disabled:opacity-100',
            errorText ? 'border-red-500 focus:border-red-500' : '',
            paddingClass,
            className,
          )}
          {...props}
        />
      </span>
      {errorText ? <span id={errorId} role="alert" className="text-xs text-red-600">{errorText}</span> : null}
      {!errorText && helperText ? <span id={helperId} className="text-xs text-[#474747]">{helperText}</span> : null}
    </label>
  );
}
