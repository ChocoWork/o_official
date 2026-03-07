import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';

export interface StatusBadgeProps {
  children?: ReactNode;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
  variant?: 'text' | 'count' | 'dot';
  count?: number | string;
  className?: string;
  size?: ComponentSize;
}

const badgeToneClass: Record<NonNullable<StatusBadgeProps['tone']>, string> = {
  // default styles avoid border so badges appear flush with their background
  neutral: 'text-black',
  positive: 'bg-black text-white',
  // warning tone used for intermediate statuses
  warning: 'bg-[#f5f5f5] text-black',
  danger: 'bg-black text-white',
};

export function StatusBadge({
  children,
  tone = 'neutral',
  variant = 'text',
  count,
  className,
  size = 'md',
}: StatusBadgeProps) {
  const dotSizeMap: Record<ComponentSize, string> = {
    sm: 'h-1 w-1',
    md: 'h-2 w-2',
    lg: 'h-3 w-3',
  };

  const countHeightMap: Record<ComponentSize, string> = {
    sm: 'h-4',
    md: 'h-5',
    lg: 'h-6',
  };
  const countFontMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-xs',
    lg: 'text-sm',
  };
  const countPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-1',
    md: 'px-1.5',
    lg: 'px-2',
  };
  const countMinWidthMap: Record<ComponentSize, string> = {
    sm: 'min-w-4',
    md: 'min-w-5',
    lg: 'min-w-6',
  };

  const textPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-2 py-[2px]',
    md: 'px-3 py-1',
    lg: 'px-4 py-2',
  };
  const textSizeMap: Record<ComponentSize, string> = {
    sm: 'text-[10px]',
    md: 'text-xs',
    lg: 'text-sm',
  };

  if (variant === 'dot') {
    return <span className={cn('inline-flex rounded-full bg-black', dotSizeMap[size], className)}></span>;
  }

  if (variant === 'count') {
    const multiDigit = count !== undefined && String(count).length > 1;
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full bg-black text-white leading-none font-acumin',
          countFontMap[size],
          countHeightMap[size],
          countMinWidthMap[size],
          multiDigit ? countPaddingMap[size] : 'px-0',
          className,
        )}
      >
        {count}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center tracking-widest leading-none font-acumin',
        textPaddingMap[size],
        textSizeMap[size],
        badgeToneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
