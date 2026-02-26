import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface FormFieldProps {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export default function FormField({ label, children, htmlFor, className }: FormFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={htmlFor} className="block text-sm tracking-widest font-acumin">
        {label}
      </label>
      {children}
    </div>
  );
}