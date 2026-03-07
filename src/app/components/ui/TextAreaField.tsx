import { cn } from '@/lib/utils';
import type { TextareaHTMLAttributes } from 'react';
import { controlBaseClass } from './shared';
import { ComponentSize } from './types';

export interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  label?: string;
  /** sm/md/lg を受け取り、行数を調整 */
  size?: ComponentSize;
}

export function TextAreaField({ label, className, id, rows, size = 'md', ...props }: TextAreaFieldProps) {
  const fieldId = id ?? props.name;
  const computedRows =
    rows ??
    (size === 'sm' ? 2 : size === 'lg' ? 6 : 4);

  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <textarea id={fieldId} rows={computedRows} className={cn(controlBaseClass, 'resize-none', className)} {...props} />
    </label>
  );
}
