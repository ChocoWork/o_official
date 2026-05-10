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
  // warning tone used for intermediate or private statuses
  warning: 'border border-black bg-white text-black',
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
    xs: 'h-1 w-1',
    sm: 'h-1 w-1',
    md: 'h-2 w-2',
    lg: 'h-3 w-3',
    xl: 'h-3 w-3',
  };

  const countHeightMap: Record<ComponentSize, string> = {
    xs: 'h-4',
    sm: 'h-4',
    md: 'h-5',
    lg: 'h-6',
    xl: 'h-6',
  };
  const countFontMap: Record<ComponentSize, string> = {
    xs: 'text-xs',
    sm: 'text-xs',
    md: 'text-xs',
    lg: 'text-sm',
    xl: 'text-sm',
  };
  const countPaddingMap: Record<ComponentSize, string> = {
    xs: 'px-1',
    sm: 'px-1',
    md: 'px-1.5',
    lg: 'px-2',
    xl: 'px-2',
  };
  const countMinWidthMap: Record<ComponentSize, string> = {
    xs: 'min-w-4',
    sm: 'min-w-4',
    md: 'min-w-5',
    lg: 'min-w-6',
    xl: 'min-w-6',
  };

  const textPaddingMap: Record<ComponentSize, string> = {
    xs: 'px-2 py-[2px]',
    sm: 'px-2 py-[2px]',
    md: 'px-3 py-1',
    lg: 'px-4 py-2',
    xl: 'px-4 py-2',
  };
  const textSizeMap: Record<ComponentSize, string> = {
    xs: 'text-[10px]',
    sm: 'text-[10px]',
    md: 'text-xs',
    lg: 'text-sm',
    xl: 'text-sm',
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
