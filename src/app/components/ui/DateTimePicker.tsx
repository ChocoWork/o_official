import type { InputHTMLAttributes } from 'react';
import { TextField } from './TextField';

export interface DateTimePickerProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  mode?: 'date' | 'time' | 'datetime-local';
}

export function DateTimePicker({ label, className, mode = 'datetime-local', ...props }: DateTimePickerProps) {
  const resolvedLabel =
    label ??
    (mode === 'date' ? 'DATE' : mode === 'time' ? 'TIME' : 'DATETIME');

  return <TextField label={resolvedLabel} type={mode} className={className} {...props} />;
}
