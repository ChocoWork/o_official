import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className }: CardProps) {
  return <article className={cn('border border-[#d5d0c9] bg-white p-6', className)}>{children}</article>;
}
