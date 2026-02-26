import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface TagLabelProps {
  children: ReactNode;
  className?: string;
}

export function TagLabel({ children, className }: TagLabelProps) {
  return <span className={cn('inline-flex border border-black px-3 py-1 text-xs tracking-widest text-black', className)}>{children}</span>;
}
