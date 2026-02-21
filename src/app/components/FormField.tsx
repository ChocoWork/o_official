import { ReactNode } from 'react';

interface FormFieldProps {
  label: string;
  children: ReactNode;
}

export default function FormField({ label, children }: FormFieldProps) {
  return (
    <div>
      <label className="block text-sm tracking-widest mb-2 font-acumin">
        {label}
      </label>
      {children}
    </div>
  );
}