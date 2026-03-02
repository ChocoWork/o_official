import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface StatusBadgeProps {
  children?: ReactNode;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
  variant?: 'text' | 'count' | 'dot';
  count?: number | string;
  className?: string;
}

const badgeToneClass: Record<NonNullable<StatusBadgeProps['tone']>, string> = {
  neutral: 'border border-black text-black',
  positive: 'bg-black text-white',
  warning: 'bg-[#f5f5f5] text-black border border-black/20',
  danger: 'bg-black text-white',
};

export function StatusBadge({
  children,
  tone = 'neutral',
  variant = 'text',
  count,
  className,
}: StatusBadgeProps) {
  if (variant === 'dot') {
    return <span className={cn('inline-flex h-2 w-2 rounded-full bg-black', className)}></span>;
  }

  if (variant === 'count') {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full bg-black text-white text-xs',
          count !== undefined && String(count).length > 1 ? 'min-w-[20px] h-5 px-1.5' : 'h-5 w-5',
          className,
        )}
        style={{ fontFamily: 'acumin-pro, sans-serif' }}
      >
        {count}
      </span>
    );
  }

  return <span className={cn('inline-flex px-3 py-1 text-xs tracking-widest font-acumin', badgeToneClass[tone], className)}>{children}</span>;
}
