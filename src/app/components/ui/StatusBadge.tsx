import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface StatusBadgeProps {
  children: ReactNode;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
  className?: string;
}

const badgeToneClass: Record<NonNullable<StatusBadgeProps['tone']>, string> = {
  neutral: 'border border-black text-black',
  positive: 'bg-black text-white',
  warning: 'bg-[#f5f5f5] text-black border border-black/20',
  danger: 'bg-black text-white',
};

export function StatusBadge({ children, tone = 'neutral', className }: StatusBadgeProps) {
  return <span className={cn('inline-flex px-3 py-1 text-xs tracking-widest font-acumin', badgeToneClass[tone], className)}>{children}</span>;
}
