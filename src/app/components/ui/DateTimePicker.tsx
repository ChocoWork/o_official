import type { InputHTMLAttributes } from 'react';
import { TextField } from './TextField';

export interface DateTimePickerProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  mode?: 'date' | 'time' | 'datetime-local';
}

export function DateTimePicker({ label, className, mode = 'datetime-local', ...props }: DateTimePickerProps) {
  return <TextField label={label} type={mode} className={className} {...props} />;
}
