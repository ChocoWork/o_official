import { cn } from '@/lib/utils';
import type { TextareaHTMLAttributes } from 'react';
import { controlBaseClass } from './shared';

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export function TextAreaField({ label, className, id, rows = 4, ...props }: TextAreaFieldProps) {
  const fieldId = id ?? props.name;
  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <textarea id={fieldId} rows={rows} className={cn(controlBaseClass, 'resize-none', className)} {...props} />
    </label>
  );
}
