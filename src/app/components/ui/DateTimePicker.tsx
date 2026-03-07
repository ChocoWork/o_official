import type { InputHTMLAttributes } from 'react';
import { TextField } from './TextField';
import { ComponentSize } from './types';

export interface DateTimePickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  mode?: 'date' | 'time' | 'datetime-local';
  size?: ComponentSize;
}

export function DateTimePicker({ label, className, mode = 'datetime-local', size, ...props }: DateTimePickerProps) {
  const resolvedLabel =
    label ??
    (mode === 'date' ? 'DATE' : mode === 'time' ? 'TIME' : 'DATETIME');

  return <TextField label={resolvedLabel} type={mode} className={className} size={size} {...props} />;
}
