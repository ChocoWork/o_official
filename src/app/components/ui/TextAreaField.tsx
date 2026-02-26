import { cn } from '@/lib/utils';
import type { TextareaHTMLAttributes } from 'react';
import { controlBaseClass } from './shared';

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export function TextAreaField({ label, className, id, ...props }: TextAreaFieldProps) {
  const fieldId = id ?? props.name;
  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-wider text-[#474747] font-brand">{label}</span> : null}
      <textarea id={fieldId} className={cn(controlBaseClass, 'resize-none', className)} {...props} />
    </label>
  );
}
